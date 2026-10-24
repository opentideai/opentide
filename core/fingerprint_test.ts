import { assert, assertEquals, assertNotEquals } from "@std/assert";
import { rmSync } from "node:fs";
import { Database } from "./db.ts";
import { Kernel } from "./registries.ts";
import {
  fingerprintProject,
  fingerprintScope,
  hashSource,
  resolveScopeSource,
} from "./fingerprint.ts";

async function withKernel(
  fn: (kernel: Kernel) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir({
    dir: "/private/tmp",
    prefix: "tideide-fingerprint-",
  });
  const db = await Database.create({ driver: "pglite" });
  const kernel = new Kernel(db);
  kernel.projectDir = dir;
  try {
    await fn(kernel);
  } finally {
    await db.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

Deno.test("hashSource: deterministic, stable across trailing whitespace", () => {
  assertEquals(hashSource("const x = 1;"), hashSource("const x = 1;"));
  // Trailing whitespace / CRLF are normalized away.
  assertEquals(hashSource("const x = 1;\n"), hashSource("const x = 1;   \r\n"));
});

Deno.test("hashSource: distinct content hashes differently, comments included", () => {
  assertNotEquals(hashSource("const x = 1;"), hashSource("const x = 2;"));
  // A comment is a meaningful change — it must alter the fingerprint.
  assertNotEquals(hashSource("x;"), hashSource("// note\nx;"));
});

Deno.test("fingerprintScope: resolves scopes and returns null when unresolved", async () => {
  await withKernel(async (kernel) => {
    kernel.handlers.register("h1", "const a = 1;", () => new Response());
    assertEquals(resolveScopeSource(kernel, "handler:h1"), "const a = 1;");
    assert(fingerprintScope(kernel, "handler:h1"));
    assertEquals(fingerprintScope(kernel, "handler:missing"), null);
    assertEquals(fingerprintScope(kernel, "function:missing"), null);
  });
});

Deno.test("fingerprintScope: changes when the entity source changes", async () => {
  await withKernel(async (kernel) => {
    kernel.handlers.register("h1", "const a = 1;", () => new Response());
    const before = fingerprintScope(kernel, "handler:h1");
    kernel.handlers.register("h1", "const a = 2;", () => new Response());
    assertNotEquals(before, fingerprintScope(kernel, "handler:h1"));
  });
});

Deno.test("fingerprintProject: independent of registration order, sensitive to edits", async () => {
  let orderA = "";
  let orderB = "";
  await withKernel(async (kernel) => {
    kernel.handlers.register("h1", "const a = 1;", () => new Response());
    kernel.handlers.register("h2", "const b = 2;", () => new Response());
    orderA = fingerprintProject(kernel);
  });
  await withKernel(async (kernel) => {
    kernel.handlers.register("h2", "const b = 2;", () => new Response());
    kernel.handlers.register("h1", "const a = 1;", () => new Response());
    orderB = fingerprintProject(kernel);
    // Same set of entities regardless of order → same project fingerprint.
    assertEquals(orderA, orderB);
    // Editing any entity shifts the project fingerprint.
    kernel.handlers.register("h1", "const a = 99;", () => new Response());
    assertNotEquals(orderB, fingerprintProject(kernel));
  });
});
