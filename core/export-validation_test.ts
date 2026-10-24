import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  generateValidationRuntimeSource,
  VALIDATION_PATH,
} from "./export-validation.ts";
import {
  inRepoValidationSource,
  VALIDATION_MARKER,
} from "../scripts/generate-export-validation.ts";
import type { RouteValidators, SchemaValidator } from "./route-validation.ts";

/* Two gates on the emitted validation.ts, for the same reason core/export-router_test.ts
   has two: textual identity says the copy is the original, and says NOTHING about whether
   the template escaping survived. So the second half writes the emitted text to disk,
   imports it, and drives validateRequest for real.

   What it does NOT do is compare the two hosts end to end — that is
   core/preview-export-parity_test.ts, which boots both. This file's job is narrower: the
   copy is the original, and the copy runs. */

// --- The copy is the original ----------------------------------------------------

Deno.test("the emitted validation is core/route-validation.ts's, verbatim", () => {
  const inRepo = inRepoValidationSource(
    Deno.readTextFileSync(new URL("./route-validation.ts", import.meta.url)),
  );
  // Exact containment, not a spot check: drift becomes impossible rather than merely
  // detectable, which is what lets the parity gate stand on the shared module and not
  // only on the copy.
  assert(inRepo.length > 0, "core/route-validation.ts's shared half is empty");
  assert(
    generateValidationRuntimeSource().includes(inRepo),
    "core/export-validation.ts is stale — run `deno task validation:generate`",
  );
  // The marker the generator slices on has to still be there, or the slice above
  // silently returns something else and this test passes vacuously.
  assertStringIncludes(
    Deno.readTextFileSync(new URL("./route-validation.ts", import.meta.url)),
    VALIDATION_MARKER,
  );
});

Deno.test("the emitted validation carries nothing the export cannot resolve", () => {
  const emitted = generateValidationRuntimeSource();
  // A standalone source tree has no kernel and no node_modules beyond its own pins. An
  // import of ANY kind here means the emitted app does not compile.
  assertEquals(
    emitted.match(/^\s*import\s/m),
    null,
    "the emitted validation imports something",
  );
  // deriveRouteSchemas must NOT have travelled: it takes a RouteSchema, which is a kernel
  // type the export has no copy of.
  assertEquals(emitted.includes("deriveRouteSchemas"), false);
  assertEquals(emitted.includes("RouteSchema"), false);
});

// --- The copy runs ---------------------------------------------------------------

interface ValidationModule {
  validateRequest(
    validators: RouteValidators,
    params: Readonly<Record<string, string>>,
    url: URL,
    readJson: () => Promise<unknown>,
  ): Promise<Response | null>;
}

const validation: ValidationModule = await (async () => {
  const dir = Deno.makeTempDirSync({ prefix: "export-validation-" });
  const path = join(dir, VALIDATION_PATH);
  Deno.writeTextFileSync(path, generateValidationRuntimeSource());
  const mod = await import(pathToFileURL(path).href) as ValidationModule;
  // The module is in memory now; the file on disk has done its job.
  rmSync(dir, { recursive: true, force: true });
  return mod;
})();

/** A stand-in for a generated ajv validator: the same shape, hand-written, so this half
 * of the file tests the emitted validateRequest and not the codegen. */
function stub(
  ok: boolean,
  errors: Array<{ instancePath?: string; message?: string }> = [],
): SchemaValidator {
  const fn = (() => ok) as SchemaValidator;
  fn.errors = ok ? null : errors;
  return fn;
}

Deno.test("the emitted validateRequest passes an acceptable request", async () => {
  assertEquals(
    await validation.validateRequest(
      { params: stub(true), query: stub(true) },
      { id: "1" },
      new URL("http://x/items/1"),
      () => Promise.reject(new Error("must not read")),
    ),
    null,
  );
});

Deno.test("the emitted validateRequest builds the 400 the preview builds", async () => {
  const bad = await validation.validateRequest(
    {
      params: stub(false, [{
        instancePath: "/id",
        message: "must be integer",
      }]),
      query: stub(false, [{ message: "must have required property 'limit'" }]),
    },
    { id: "abc" },
    new URL("http://x/items/abc"),
    () => Promise.reject(new Error("must not read")),
  );
  assert(bad);
  assertEquals(bad.status, 400);
  assertEquals(await bad.json(), {
    error: "Validation failed",
    details: [
      { in: "path", path: "/id", message: "must be integer" },
      {
        in: "query",
        path: "/",
        message: "must have required property 'limit'",
      },
    ],
  });
});

Deno.test("the emitted validateRequest answers the malformed-body envelope", async () => {
  const bad = await validation.validateRequest(
    { params: stub(false, [{ message: "must be integer" }]), body: stub(true) },
    { id: "abc" },
    new URL("http://x/items/abc"),
    () => Promise.reject(new SyntaxError("Unexpected end of JSON input")),
  );
  assert(bad);
  assertEquals(bad.status, 400);
  // The path error collected above is deliberately discarded — same as the preview.
  assertEquals(await bad.json(), { error: "Invalid JSON body" });
});

Deno.test("the emitted validateRequest keeps the first repeated query value", async () => {
  let seen: Record<string, unknown> | undefined;
  const spy = ((data: unknown) => {
    seen = data as Record<string, unknown>;
    return true;
  }) as SchemaValidator;
  await validation.validateRequest(
    { query: spy },
    {},
    new URL("http://x/?a=first&a=second&b=1"),
    () => Promise.reject(new Error("must not read")),
  );
  assertEquals(seen, { a: "first", b: "1" });
});

Deno.test("the emitted validateRequest does not coerce the caller's params", async () => {
  // The generated validators run with coerceTypes, exactly as the preview's do, so the
  // copy has to take the same copy. A template-escaping accident that dropped the spread
  // would show up here and nowhere else.
  const coercer = ((data: unknown) => {
    (data as Record<string, unknown>).id = 42;
    return true;
  }) as SchemaValidator;
  const params = { id: "42" };
  await validation.validateRequest(
    { params: coercer },
    params,
    new URL("http://x/"),
    () => Promise.reject(new Error("must not read")),
  );
  assertEquals(params, { id: "42" });
});
