// @layer core — request validation against a route's declared schema, for both hosts.
//
// A route's RouteSchema drives three things: the OpenAPI spec, the docs, and request
// validation. Only the live preview has ever done the third one. The exported app went
// straight from match() to the handler, so a request that 400d in the preview reached the
// handler in production and typically 500d — an app documented as validating that didn't.
//
// Two halves, split by the marker below:
//
//   ABOVE — deriveRouteSchemas: RouteSchema's shorthand expanded into the three JSON
//   Schemas ajv compiles. Kernel-only, because only the kernel has a RouteSchema; the
//   preview compiles them at rebuild and the export compiles them at export time. One
//   function, so the two hosts cannot derive different schemas from the same route.
//
//   BELOW — validateRequest: the request-time half, host-agnostic and copied VERBATIM
//   into the app export by scripts/generate-export-validation.ts. Edit here and run
//   `deno task validation:generate`; never edit the generated copy.
//   core/export-validation_test.ts fails if the two drift.
//
// The split is where it is because the export never sees a RouteSchema — validators are
// compiled to source at export time (core/export-validators.ts) and the shipped app only
// ever runs the functions. So derivation stays in the kernel and only the running half
// travels.

import type { RouteSchema } from "./types.ts";

/** The ajv options BOTH hosts compile with. One object, because two literal option
 * objects that have to agree is exactly how the preview and the export drift — and an
 * option mismatch would not show up as a crash, it would show up as a different 400 body
 * for the same request.
 *
 * `validateFormats: false` makes `format` an ANNOTATION: declared, emitted into the
 * OpenAPI spec, not asserted. That is JSON Schema's own default, and it is what this
 * kernel has always done to path and query params, which drop `format` during derivation.
 * Body schemas used to be the exception and not in a good way — ajv 8 ships no formats and
 * its strict mode rejects an unknown one outright, so a single `format: "email"` on one
 * property failed the WHOLE body schema to compile and the route served with no body
 * validation at all. Required fields, types, lengths: all of it gone, for a keyword that
 * was never enforced anywhere else.
 *
 * Asserting formats is a separate decision with its own cost (ajv-formats in the kernel
 * AND vendored into the generated validators, plus it starts rejecting requests that
 * already-deployed apps accept). Until someone asks for it, `format` documents.
 * Everything else about a schema is still checked, and a schema that is genuinely
 * malformed — a bogus `type`, an unknown keyword, an invalid `pattern` — still fails to
 * compile and is still reported. */
export const AJV_OPTIONS = {
  allErrors: true,
  coerceTypes: true,
  validateFormats: false,
} as const;

/** The three JSON Schemas a route validates against. An absent one is not validated. */
export interface RouteJsonSchemas {
  params?: Record<string, unknown>;
  query?: Record<string, unknown>;
  body?: Record<string, unknown>;
}

// The params/query shorthand (RouteSchemaParam) is NOT JSON Schema — it is a flat
// per-key `{type, description?, enum?, default?, format?}` map. Only `type` and `enum`
// survive into the compiled schema. `format` is dropped here and ignored in a body
// (AJV_OPTIONS above): it documents, it does not assert. Dropping it here rather than
// passing it through is now belt-and-braces rather than load-bearing, and it stays
// because the shorthand is not JSON Schema and `format` is the only key that would need
// translating if that ever changed.
//
// additionalProperties is deliberately NOT set. Unknown query keys pass, which is the
// right default (`?utm_source=x` must not 400), and an undeclared path param cannot
// exist — the matcher only ever produces the ones in the pattern.
function objectSchema(
  entries: Record<string, { type: string; enum?: unknown[] }>,
  required: string[],
): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(entries)) {
    properties[k] = { type: v.type, ...(v.enum ? { enum: v.enum } : {}) };
  }
  return {
    type: "object",
    properties,
    ...(required.length ? { required } : {}),
  };
}

/** Derive what ajv compiles from a route's declared schema.
 *
 * `body` is already full JSON Schema and passes through untouched. `params` and `query`
 * are the shorthand above, wrapped into an object schema — every declared path param is
 * required (the route cannot match without it), while a query key is required only if it
 * says so. An empty map yields nothing, so a route declaring `query: {}` is not
 * validated rather than validated against a schema that accepts everything.
 *
 * Returns the schemas, NOT validators: what compiles them differs per host, and nothing
 * here may depend on which. */
export function deriveRouteSchemas(
  schema: RouteSchema | undefined,
): RouteJsonSchemas {
  if (!schema) return {};
  const out: RouteJsonSchemas = {};
  if (schema.body) out.body = schema.body as unknown as Record<string, unknown>;
  if (schema.query && Object.keys(schema.query).length > 0) {
    const required = Object.entries(schema.query)
      .filter(([, v]) => v.required)
      .map(([k]) => k);
    out.query = objectSchema(schema.query, required);
  }
  if (schema.params && Object.keys(schema.params).length > 0) {
    out.params = objectSchema(schema.params, Object.keys(schema.params));
  }
  return out;
}

// --- The shared request-time validation ---

/** One ajv error, narrowed to the two fields the 400 body reports.
 *
 * Structural on purpose: the preview holds ajv's own ValidateFunction and the export
 * holds a function ajv generated as source, with no ajv in the tree to type it against.
 * Both satisfy this. */
export interface ValidationErrorObject {
  instancePath?: string;
  message?: string;
}

export interface SchemaValidator {
  (data: unknown): boolean;
  errors?: ValidationErrorObject[] | null;
}

export interface RouteValidators {
  params?: SchemaValidator;
  query?: SchemaValidator;
  body?: SchemaValidator;
}

/** Validate a request, or answer the 400 it earns.
 *
 * Returns null when the request is acceptable, so a caller reads as
 * `const bad = await validateRequest(...); if (bad) return bad;`.
 *
 * `readJson` is a callback rather than the Request itself because the two hosts own the
 * body stream differently — the preview has already cloned for the handler and captured
 * a truncated copy for its request log, the export has only cloned. Handing the stream
 * decision to the caller is what lets this function be identical on both sides.
 *
 * Order is params, then query, then body, and it is load-bearing: params and query errors
 * ACCUMULATE into one 400, while a body that is not JSON at all short-circuits with a
 * different envelope and discards whatever params/query errors were already collected.
 * That is what the Hono shell did and what every existing test pins. */
export async function validateRequest(
  validators: RouteValidators,
  params: Readonly<Record<string, string>>,
  url: URL,
  readJson: () => Promise<unknown>,
): Promise<Response | null> {
  const validationErrors: Array<
    { in: string; path: string; message?: string }
  > = [];

  const collect = (validator: SchemaValidator, where: string): void => {
    for (const e of validator.errors ?? []) {
      validationErrors.push({
        in: where,
        path: e.instancePath || "/",
        message: e.message,
      });
    }
  };

  // A COPY. ajv runs with coerceTypes, which mutates its input in place, so validating
  // `params` directly would hand the handler a coerced value — a number where
  // HandlerContext.params promises a string. The Hono shell got away with passing the
  // object straight in because `c.req.param()` minted a fresh one per call and the
  // handler's copy was a different object.
  if (validators.params && !validators.params({ ...params })) {
    collect(validators.params, "path");
  }

  if (validators.query) {
    // FIRST value wins for a repeated key, which is what `c.req.query()` returned.
    // Object.fromEntries(searchParams) keeps the LAST, so `?a=1&a=2` would have been
    // validated as "2" where it used to be validated as "1".
    const raw: Record<string, string> = {};
    for (const [key, value] of url.searchParams) {
      if (!(key in raw)) raw[key] = value;
    }
    if (!validators.query(raw)) collect(validators.query, "query");
  }

  if (validators.body) {
    try {
      const body = await readJson();
      if (!validators.body(body)) collect(validators.body, "body");
    } catch {
      return Response.json({ error: "Invalid JSON body" }, { status: 400 });
    }
  }

  if (validationErrors.length > 0) {
    return Response.json({
      error: "Validation failed",
      details: validationErrors,
    }, { status: 400 });
  }

  return null;
}
