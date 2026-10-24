import {
  assert,
  assertEquals,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import _Ajv from "ajv";
const Ajv = _Ajv as unknown as typeof _Ajv.default;
import { rmSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  devendor,
  generateValidatorsRuntimeSource,
  UnvendoredHelperError,
  VALIDATORS_PATH,
} from "./export-validators.ts";
import {
  generateValidationRuntimeSource,
  VALIDATION_PATH,
} from "./export-validation.ts";
import {
  deriveRouteSchemas,
  type RouteValidators,
} from "./route-validation.ts";
import type { RouteEntry, RouteSchema, RouteSchemaBody } from "./types.ts";
import { testStoreComposition } from "../verification/test-stores.ts";
import { Database } from "./db.ts";
import { exportProject } from "./export.ts";
import { Kernel } from "./registries.ts";

/* The differential gate on the export's validators.

   The claim this file has to earn is narrow and total: a validator ajv compiled to SOURCE
   at export time answers exactly what the same schema compiled at RUNTIME answers — the
   same boolean, the same `errors` array down to ajv's own message strings, and the same
   coercion written back into the input object. If that holds, the exported app can
   reproduce the preview's 400 body character for character, and
   core/preview-export-parity_test.ts can compare bodies rather than settling for statuses.

   It is deliberately a UNIT differential, not an HTTP one. Booting two hosts per schema
   would buy a handful of cases; comparing the functions directly buys thousands, and the
   HTTP wiring is covered once, in the parity gate. */

// --- Loading generated validators ------------------------------------------------

/** Compile routes to source, write the emitted module next to a real validation.ts, and
 * import it. The validation.ts copy is not decoration: the generated module type-imports
 * from it, and shipping them together is how the export ships them. */
async function loadValidators(
  routes: readonly RouteEntry[],
): Promise<Record<string, RouteValidators>> {
  const generated = generateValidatorsRuntimeSource(routes);
  assert(generated.source, "nothing was generated for these routes");
  const dir = Deno.makeTempDirSync({ prefix: "export-validators-" });
  try {
    Deno.writeTextFileSync(
      join(dir, VALIDATION_PATH),
      generateValidationRuntimeSource(),
    );
    const path = join(dir, VALIDATORS_PATH);
    Deno.writeTextFileSync(path, generated.source);
    const mod = await import(pathToFileURL(path).href) as {
      VALIDATORS: Record<string, RouteValidators>;
    };
    return mod.VALIDATORS;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function route(method: string, path: string, schema?: RouteSchema): RouteEntry {
  return {
    method,
    path,
    handlerName: `h_${method}_${path}`.replace(/\W+/g, "_"),
    registeredAt: "2026-01-01T00:00:00.000Z",
    ...(schema ? { schema } : {}),
  };
}

// --- The table -------------------------------------------------------------------

Deno.test("generated validators are keyed by method and path, not by handler", async () => {
  // Two routes, ONE handler, different schemas. Keying by handler name would validate one
  // route against the other's schema — silently, and only for apps that reuse a handler.
  const shared = "sharedHandler";
  const routes: RouteEntry[] = [
    {
      ...route("GET", "/a", {
        query: { n: { type: "integer", required: true } },
      }),
      handlerName: shared,
    },
    {
      ...route("GET", "/b", {
        query: { s: { type: "string", required: true } },
      }),
      handlerName: shared,
    },
  ];
  const validators = await loadValidators(routes);
  assertEquals(Object.keys(validators).sort(), ["GET /a", "GET /b"]);
  assert(validators["GET /a"]!.query!({ n: "1" }));
  assertEquals(validators["GET /a"]!.query!({ s: "x" }), false);
});

Deno.test("a route with no schema gets no validators at all", () => {
  const generated = generateValidatorsRuntimeSource([
    route("GET", "/plain"),
    route("POST", "/also-plain", {}),
  ]);
  assertEquals(generated.source, null);
  assertEquals(generated.routes, []);
  assertEquals(generated.skipped, []);
});

Deno.test("the emitted validators module imports nothing at runtime", () => {
  const generated = generateValidatorsRuntimeSource([
    route("GET", "/x/:id", { params: { id: { type: "integer" } } }),
    route("POST", "/y", {
      body: {
        type: "object",
        properties: { s: { type: "string", minLength: 2 } },
      },
    }),
  ]);
  assert(generated.source);
  // The ONLY import permitted is the type-only one, which is erased before it runs.
  const imports = generated.source.match(/^\s*import\s.*$/gm) ?? [];
  assertEquals(imports.length, 1);
  assertStringIncludes(imports[0]!, "import type { RouteValidators }");
  // And no `require` survived the devendor pass.
  assertEquals(generated.source.includes("require("), false);
  // minLength reached for ucs2length, so the helper must be inlined.
  assertStringIncludes(generated.source, "function __ucs2length(");
});

Deno.test("a helper is inlined only when a keyword reaches for it", () => {
  const plain = generateValidatorsRuntimeSource([
    route("GET", "/x/:id", { params: { id: { type: "integer" } } }),
  ]);
  assertEquals(plain.source!.includes("__ucs2length"), false);
  assertEquals(plain.source!.includes("__equal"), false);

  const unique = generateValidatorsRuntimeSource([
    route("POST", "/u", {
      body: {
        type: "object",
        properties: { t: { type: "array", uniqueItems: true } },
      },
    }),
  ]);
  assertStringIncludes(unique.source!, "function __equal(");
  assertEquals(unique.source!.includes("__ucs2length"), false);
});

Deno.test("devendor rewrites the helpers it knows", () => {
  const out = devendor(
    'const a = require("ajv/dist/runtime/ucs2length").default;\n' +
      'const b = require("ajv/dist/runtime/equal").default;',
  );
  assertEquals(out.includes("require("), false);
  assertStringIncludes(out, "const a = __ucs2length;");
  assertStringIncludes(out, "const b = __equal;");
  assertStringIncludes(out, "function __ucs2length(");
  assertStringIncludes(out, "function __equal(");
  // Sorted, so the prelude does not depend on which keyword ajv emitted first.
  assert(
    out.indexOf("function __equal(") < out.indexOf("function __ucs2length("),
  );
});

Deno.test("an unvendored helper fails the export instead of shipping", () => {
  // The branch that never fires on today's ajv and has to keep working on tomorrow's. A
  // `require` this module does not recognise must stop the build — passing it through
  // type-checks fine here and explodes on the user's first request.
  const err = assertThrows(
    () => devendor('const c = require("ajv/dist/runtime/timestamp").default;'),
    UnvendoredHelperError,
  );
  assertStringIncludes(err.message, "ajv/dist/runtime/timestamp");
  assertStringIncludes(err.message, "core/export-validators.ts");
});

// --- Determinism -----------------------------------------------------------------

Deno.test("the same routes generate the same bytes, in any registration order", () => {
  const routes = [
    route("GET", "/items/:id", { params: { id: { type: "integer" } } }),
    route("POST", "/items", {
      body: {
        type: "object",
        properties: { t: { type: "string" } },
        required: ["t"],
      },
    }),
    route("GET", "/items", { query: { limit: { type: "integer" } } }),
  ];
  const forward = generateValidatorsRuntimeSource(routes).source;
  const backward =
    generateValidatorsRuntimeSource([...routes].reverse()).source;
  // ajv numbers its generated functions off instance state, so identical bytes here mean
  // the sort inside the generator is doing its job. Without it a reproducible build would
  // depend on the order the agent happened to register routes in.
  assertEquals(forward, backward);
  assertEquals(forward, generateValidatorsRuntimeSource(routes).source);
});

// --- A schema ajv refuses --------------------------------------------------------

Deno.test("an uncompilable schema is skipped, reported, and does not sink the export", () => {
  // A bogus `type` — the realistic version of this, an agent typo. NOT `format`: that is
  // ignored now rather than fatal (AJV_OPTIONS), which is the whole point of the two
  // tests below.
  const generated = generateValidatorsRuntimeSource([
    route("POST", "/bad", {
      body: {
        type: "object",
        properties: { when: { type: "strng" } },
      },
    }),
    route("GET", "/good/:id", { params: { id: { type: "integer" } } }),
  ]);
  assertEquals(generated.skipped.length, 1);
  assertEquals(generated.skipped[0]!.route, "POST /bad");
  assertEquals(generated.skipped[0]!.slot, "body");
  assertStringIncludes(generated.skipped[0]!.reason, "must be equal to one of");
  // The good route still shipped.
  assertEquals(generated.routes, ["GET /good/:id"]);
  assert(generated.source);
});

// --- The differential ------------------------------------------------------------

/** A fixed seed, so a failure replays. Same generator shape as
 * core/export-router_test.ts's fuzz. */
function makeRandom(seed: number): () => number {
  let state = seed;
  return () => {
    state = (Math.imul(state, 1103515245) + 12345) & 0x7fffffff;
    return state / 0x7fffffff;
  };
}

const SCALAR_TYPES = ["string", "number", "integer", "boolean"];

function pick<T>(rand: () => number, xs: readonly T[]): T {
  return xs[Math.floor(rand() * xs.length)]!;
}

/** A random body JSON Schema, drawn from the keywords a RouteSchema body can carry. */
function randomBodySchema(
  rand: () => number,
  depth = 0,
): RouteSchemaBody {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  const count = 1 + Math.floor(rand() * 4);
  for (let i = 0; i < count; i++) {
    const name = `p${i}`;
    const kind = rand();
    if (kind < 0.42) {
      const type = pick(rand, SCALAR_TYPES);
      const prop: Record<string, unknown> = { type };
      if (type === "string" && rand() < 0.4) {
        prop.minLength = 1 + Math.floor(rand() * 3);
      }
      if (type === "string" && rand() < 0.3) {
        prop.maxLength = 4 + Math.floor(rand() * 4);
      }
      if (type === "string" && rand() < 0.2) prop.pattern = "^[a-z]+$";
      if ((type === "number" || type === "integer") && rand() < 0.4) {
        prop.minimum = 0;
        prop.maximum = 100;
      }
      properties[name] = prop;
    } else if (kind < 0.58) {
      properties[name] = { type: "string", enum: ["a", "b", "c"] };
    } else if (kind < 0.72) {
      const arr: Record<string, unknown> = {
        type: "array",
        items: { type: pick(rand, SCALAR_TYPES) },
      };
      if (rand() < 0.5) arr.uniqueItems = true;
      properties[name] = arr;
    } else if (kind < 0.82) {
      properties[name] = { type: [pick(rand, SCALAR_TYPES), "null"] };
    } else if (kind < 0.9) {
      properties[name] = { oneOf: [{ type: "string" }, { type: "number" }] };
    } else if (depth < 2) {
      properties[name] = randomBodySchema(rand, depth + 1) as unknown;
    } else {
      properties[name] = { type: "string" };
    }
    if (rand() < 0.4) required.push(name);
  }
  const schema: RouteSchemaBody = { type: "object", properties };
  if (required.length) schema.required = required;
  if (depth === 0 && rand() < 0.25) schema.additionalProperties = false;
  return schema;
}

/** A payload drawn to land on both sides of the line: sometimes conforming, often not,
 * and often stringly typed so coerceTypes has something to do. */
function randomPayload(rand: () => number, depth = 0): unknown {
  const kind = rand();
  if (kind < 0.06) return null;
  if (kind < 0.1) return "not an object";
  if (kind < 0.14) return [1, 2, 3];
  if (kind < 0.18) return 42;
  const out: Record<string, unknown> = {};
  const count = Math.floor(rand() * 5);
  for (let i = 0; i < count; i++) {
    const name = `p${Math.floor(rand() * 5)}`;
    const v = rand();
    if (v < 0.16) out[name] = String(Math.floor(rand() * 200));
    else if (v < 0.3) out[name] = Math.floor(rand() * 200);
    else if (v < 0.4) {
      out[name] = pick(rand, ["a", "b", "z", "", "AB", "😀😀", "abc"]);
    } else if (v < 0.5) {
      out[name] = pick(rand, [true, false, "true", "false", 0, 1]);
    } else if (v < 0.6) out[name] = null;
    else if (v < 0.72) {
      out[name] = [pick(rand, ["1", 1, "a"]), pick(rand, ["1", 1, "a"])];
    } else if (v < 0.8) out[name] = [{ k: 1 }, { k: 1 }];
    else if (v < 0.88) out[name] = 1.5;
    else if (depth < 2) out[name] = randomPayload(rand, depth + 1);
    else out[name] = "x";
  }
  return out;
}

Deno.test("generated validators answer exactly what runtime ajv answers", async () => {
  const rand = makeRandom(20260929);
  const ROUTE_COUNT = 60;
  const PAYLOADS_PER_ROUTE = 40;

  // One export's worth of routes, so the generated module is a realistic one — many
  // validators sharing one instance's numbering and one vendored prelude.
  const routes: RouteEntry[] = [];
  const schemas: Array<{ key: string; schema: RouteSchema }> = [];
  for (let i = 0; i < ROUTE_COUNT; i++) {
    const schema: RouteSchema = {
      body: randomBodySchema(rand),
      params: {
        id: {
          type: pick(rand, SCALAR_TYPES),
          ...(rand() < 0.3 ? { enum: ["1", "2"] } : {}),
        },
      },
      query: {
        limit: { type: pick(rand, SCALAR_TYPES), required: rand() < 0.5 },
        cursor: { type: "string" },
      },
    };
    const r = route("POST", `/fuzz/${i}/:id`, schema);
    routes.push(r);
    schemas.push({ key: `${r.method} ${r.path}`, schema });
  }

  const generated = await loadValidators(routes);

  // The same schemas, compiled the way the preview compiles them.
  const ajv = new Ajv({ allErrors: true, coerceTypes: true });
  const runtime = new Map<string, RouteValidators>();
  for (const { key, schema } of schemas) {
    const derived = deriveRouteSchemas(schema);
    const rv: RouteValidators = {};
    if (derived.params) rv.params = ajv.compile(derived.params);
    if (derived.query) rv.query = ajv.compile(derived.query);
    if (derived.body) rv.body = ajv.compile(derived.body);
    runtime.set(key, rv);
  }

  let compared = 0;
  for (const { key } of schemas) {
    const gen = generated[key];
    const run = runtime.get(key);
    assert(gen && run, `missing validators for ${key}`);
    for (const slot of ["params", "query", "body"] as const) {
      const g = gen[slot];
      const r = run[slot];
      assertEquals(
        Boolean(g),
        Boolean(r),
        `${key} ${slot}: one host compiled a validator and the other did not`,
      );
      if (!g || !r) continue;
      for (let i = 0; i < PAYLOADS_PER_ROUTE; i++) {
        const payload = randomPayload(rand);
        const forGen = structuredClone(payload);
        const forRun = structuredClone(payload);
        const okGen = g(forGen);
        const okRun = r(forRun);
        const where = `${key} ${slot} payload ${JSON.stringify(payload)}`;
        assertEquals(okGen, okRun, `verdict differs: ${where}`);
        assertEquals(
          JSON.stringify(g.errors ?? null),
          JSON.stringify(r.errors ?? null),
          `errors differ: ${where}`,
        );
        // coerceTypes rewrites the input. If the two disagree here the handler sees
        // different data in production than in the preview, which is worse than a
        // different status code because nothing reports it.
        assertEquals(
          JSON.stringify(forGen),
          JSON.stringify(forRun),
          `coercion differs: ${where}`,
        );
        compared++;
      }
    }
  }

  // Guard against a generator that quietly stops generating.
  assert(compared > 5000, `only ${compared} comparisons ran`);
});

// --- What the export says about a schema it could not compile --------------------

Deno.test({
  name: "an export names the routes shipping without validation, in its README",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const db = await Database.create({ driver: "pglite" });
    try {
      const kernel = new Kernel(db, { composition: testStoreComposition() });
      kernel.handlers.register(
        "ok",
        `function ok(req: Request): Response { return Response.json({}); }`,
        () => new Response(),
      );
      kernel.routes.register("GET", "/fine/:id", "ok", {
        params: { id: { type: "integer" } },
      });
      // A misspelled `type`: ajv rejects the schema outright, so the route ships
      // unvalidated and has to be named for it.
      kernel.routes.register("POST", "/broken", "ok", {
        body: {
          type: "object",
          properties: { when: { type: "strng" } },
        },
      });

      const result = await exportProject(kernel, { projectName: "Skip App" });
      assertEquals(result.skippedSchemas.length, 1);
      assertEquals(result.skippedSchemas[0]!.route, "POST /broken");

      const readme = result.files.find((f) => f.path === "README.md");
      assert(readme?.content);
      assertStringIncludes(
        readme.content,
        "Routes shipping without validation",
      );
      assertStringIncludes(readme.content, "| POST /broken | body |");

      // The working route still ships a validator.
      const validators = result.files.find((f) => f.path === "validators.ts");
      assert(validators?.content);
      assertStringIncludes(validators.content, '"GET /fine/:id"');
      assertEquals(validators.content.includes('"POST /broken"'), false);
    } finally {
      await db.close();
    }
  },
});

Deno.test({
  name: "an export with nothing skipped says nothing about it",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    // The section is conditional so an export with nothing wrong stays byte-identical to
    // what it produced before any of this existed.
    const db = await Database.create({ driver: "pglite" });
    try {
      const kernel = new Kernel(db, { composition: testStoreComposition() });
      kernel.handlers.register(
        "ok",
        `function ok(req: Request): Response { return Response.json({}); }`,
        () => new Response(),
      );
      kernel.routes.register("GET", "/fine/:id", "ok", {
        params: { id: { type: "integer" } },
      });
      const result = await exportProject(kernel, { projectName: "Clean App" });
      assertEquals(result.skippedSchemas, []);
      const readme = result.files.find((f) => f.path === "README.md");
      assertEquals(
        readme!.content!.includes("Routes shipping without validation"),
        false,
      );
    } finally {
      await db.close();
    }
  },
});

// --- format documents, it does not assert ----------------------------------------

Deno.test("a format keyword no longer costs a body ALL of its validation", async () => {
  // The bug this closes. ajv 8 ships no formats and its strict mode rejects an unknown
  // one outright, so before AJV_OPTIONS a single `format` on one property failed the
  // whole schema to compile and the route served with NO body validation — required
  // fields, types, lengths, all of it gone. For a keyword that was never enforced on
  // path or query params anyway.
  const routes = [
    route("POST", "/f", {
      body: {
        type: "object",
        properties: {
          email: { type: "string", format: "email" },
          n: { type: "integer" },
        },
        required: ["n"],
      },
    }),
  ];
  const generated = generateValidatorsRuntimeSource(routes);
  assertEquals(generated.skipped, []);

  const validators = await loadValidators(routes);
  const body = validators["POST /f"]?.body;
  assert(body, "the body schema compiled to nothing");

  // Everything EXCEPT the format is still checked.
  assertEquals(body({ n: 1, email: "a@b.c" }), true);
  assertEquals(body({ email: "a@b.c" }), false, "required is still enforced");
  assertEquals(body({ n: "x" }), false, "type is still enforced");
  // And the format itself is an annotation: a string that is not an email passes.
  assertEquals(body({ n: 1, email: "not an email" }), true);
});

Deno.test("an unknown format is ignored, not merely tolerated", () => {
  // `format: "wat"` is not a real format in any build. It must still compile — the
  // alternative is an agent's typo costing a route its entire body validation.
  const generated = generateValidatorsRuntimeSource([
    route("POST", "/f", {
      body: {
        type: "object",
        properties: { x: { type: "string", format: "wat" } },
      },
    }),
  ]);
  assertEquals(generated.skipped, []);
  assert(generated.source);
});
