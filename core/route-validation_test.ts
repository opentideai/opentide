import { assert, assertEquals } from "@std/assert";
import _Ajv from "ajv";
const Ajv = _Ajv as unknown as typeof _Ajv.default;
import {
  deriveRouteSchemas,
  type RouteValidators,
  type SchemaValidator,
  validateRequest,
} from "./route-validation.ts";
import type { RouteSchema } from "./types.ts";

const ajv = new Ajv({ allErrors: true, coerceTypes: true });

function compile(schema: Record<string, unknown>): SchemaValidator {
  return ajv.compile(schema);
}

function validatorsFor(schema: RouteSchema): RouteValidators {
  const derived = deriveRouteSchemas(schema);
  const rv: RouteValidators = {};
  if (derived.params) rv.params = compile(derived.params);
  if (derived.query) rv.query = compile(derived.query);
  if (derived.body) rv.body = compile(derived.body);
  return rv;
}

Deno.test("deriveRouteSchemas: a body schema passes through untouched", () => {
  const body = {
    type: "object" as const,
    properties: { title: { type: "string" } },
    required: ["title"],
    additionalProperties: false,
  };
  assertEquals(deriveRouteSchemas({ body }).body, body);
});

Deno.test("deriveRouteSchemas: every path param is required, always", () => {
  // The route cannot match without them, so there is no such thing as an optional one.
  assertEquals(
    deriveRouteSchemas({ params: { id: { type: "number" } } }).params,
    {
      type: "object",
      properties: { id: { type: "number" } },
      required: ["id"],
    },
  );
});

Deno.test("deriveRouteSchemas: a query key is required only if it says so", () => {
  const derived = deriveRouteSchemas({
    query: {
      limit: { type: "integer", required: true },
      cursor: { type: "string" },
      order: { type: "string", required: false },
    },
  });
  assertEquals(derived.query, {
    type: "object",
    properties: {
      limit: { type: "integer" },
      cursor: { type: "string" },
      order: { type: "string" },
    },
    required: ["limit"],
  });
});

Deno.test("deriveRouteSchemas: enum survives, format and description do not", () => {
  // `format` is dropped deliberately: ajv 8 throws on an unknown format under its
  // default strict mode and this build ships no formats. It documents, it does not
  // enforce. If that changes, this test is the one to change with it.
  assertEquals(
    deriveRouteSchemas({
      params: {
        kind: {
          type: "string",
          enum: ["a", "b"],
          description: "ignored",
          format: "uuid",
        },
      },
    }).params,
    {
      type: "object",
      properties: { kind: { type: "string", enum: ["a", "b"] } },
      required: ["kind"],
    },
  );
});

Deno.test("deriveRouteSchemas: nothing to validate yields nothing", () => {
  assertEquals(deriveRouteSchemas(undefined), {});
  assertEquals(deriveRouteSchemas({}), {});
  // An empty map is not "validate against a schema that accepts anything" — it is no
  // validator at all, so the route never pays for one.
  assertEquals(deriveRouteSchemas({ params: {}, query: {} }), {});
});

Deno.test("validateRequest: an acceptable request answers null", async () => {
  const rv = validatorsFor({
    params: { id: { type: "integer" } },
    query: { limit: { type: "integer", required: true } },
    body: {
      type: "object",
      properties: { t: { type: "string" } },
      required: ["t"],
    },
  });
  const bad = await validateRequest(
    rv,
    { id: "7" },
    new URL("http://x/items/7?limit=5"),
    () => Promise.resolve({ t: "hi" }),
  );
  assertEquals(bad, null);
});

Deno.test("validateRequest: the params object is never coerced in place", async () => {
  // ajv runs with coerceTypes, which rewrites its input. Handing `params` straight in
  // would give the handler a number where HandlerContext.params promises a string.
  const rv = validatorsFor({ params: { id: { type: "number" } } });
  const params = { id: "42" };
  assertEquals(
    await validateRequest(rv, params, new URL("http://x/"), unreadable),
    null,
  );
  assertEquals(params, { id: "42" });
  assertEquals(typeof params.id, "string");
});

Deno.test("validateRequest: path and query errors accumulate into one 400", async () => {
  const rv = validatorsFor({
    params: { id: { type: "integer" } },
    query: { limit: { type: "integer", required: true } },
  });
  const bad = await validateRequest(
    rv,
    { id: "abc" },
    new URL("http://x/items/abc"),
    unreadable,
  );
  assert(bad);
  assertEquals(bad.status, 400);
  const body = await bad.json();
  assertEquals(body.error, "Validation failed");
  assertEquals(body.details.map((d: { in: string }) => d.in), [
    "path",
    "query",
  ]);
});

Deno.test("validateRequest: a repeated query key validates on its FIRST value", async () => {
  // Object.fromEntries(searchParams) keeps the last; `c.req.query()` kept the first.
  const rv = validatorsFor({
    query: { limit: { type: "integer", required: true } },
  });
  assertEquals(
    await validateRequest(
      rv,
      {},
      new URL("http://x/?limit=5&limit=nope"),
      unreadable,
    ),
    null,
  );
  const bad = await validateRequest(
    rv,
    {},
    new URL("http://x/?limit=nope&limit=5"),
    unreadable,
  );
  assertEquals(bad?.status, 400);
});

Deno.test("validateRequest: a body that is not JSON discards the other errors", async () => {
  // Load-bearing ordering, and nothing pinned it before this test: a malformed body
  // short-circuits with its OWN envelope and throws away the path/query errors already
  // collected. Reorder the three checks and this is what breaks.
  const rv = validatorsFor({
    params: { id: { type: "integer" } },
    body: { type: "object", properties: { t: { type: "string" } } },
  });
  const bad = await validateRequest(
    rv,
    { id: "abc" },
    new URL("http://x/items/abc"),
    () => Promise.reject(new SyntaxError("Unexpected token")),
  );
  assert(bad);
  assertEquals(bad.status, 400);
  assertEquals(await bad.json(), { error: "Invalid JSON body" });
});

Deno.test("validateRequest: the body is read only when a body schema exists", async () => {
  let reads = 0;
  const rv = validatorsFor({ params: { id: { type: "string" } } });
  await validateRequest(rv, { id: "x" }, new URL("http://x/"), () => {
    reads++;
    return Promise.resolve({});
  });
  assertEquals(reads, 0);
});

/** A reader that fails the test if it is ever called. */
function unreadable(): Promise<unknown> {
  throw new Error("the body must not be read for this route");
}
