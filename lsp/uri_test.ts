import { assert, assertEquals } from "@std/assert";
import { entityUri, parseGenieUri } from "./uri.ts";
import { entityPath, parseEntityPath } from "../core/language-service.ts";

// The URI scheme is the linchpin (docs/lsp-support-plan.md §3): it must round-trip
// with itself AND stay in lockstep with the language service's virtual-FS layout,
// since the two are built from the same pluralize/singularize helpers.

Deno.test("entityUri builds the documented opentide:// shape", () => {
  assertEquals(
    entityUri({
      runtimeId: "typescript",
      entityType: "handler",
      entityName: "getUsers",
    }),
    "opentide://typescript/handlers/getUsers.ts",
  );
});

Deno.test("parseGenieUri round-trips singular entity types", () => {
  for (const entityType of ["handler", "function", "test"]) {
    const uri = entityUri({
      runtimeId: "typescript",
      entityType,
      entityName: "doThing",
    });
    const parsed = parseGenieUri(uri);
    assert(parsed.ok, `expected ${uri} to parse`);
    assertEquals(parsed.data, {
      runtimeId: "typescript",
      entityType,
      entityName: "doThing",
    });
  }
});

Deno.test("URI path segment matches the service virtual-FS path", () => {
  // The opentide:// path (minus scheme+runtimeId) must equal entityPath()'s tail, so
  // the URI and the service can never disagree on where an entity lives.
  const ref = {
    runtimeId: "typescript",
    entityType: "handler",
    entityName: "getUsers",
  };
  const uri = entityUri(ref);
  const virtualPath = entityPath(ref.entityType, ref.entityName);
  assert(uri.endsWith(virtualPath.replace("/_genie", "")));
  // And the service's own parser agrees on the type/name split.
  assertEquals(parseEntityPath(virtualPath), {
    entityType: ref.entityType,
    entityName: ref.entityName,
  });
});

Deno.test("entity names containing dots round-trip", () => {
  const uri = entityUri({
    runtimeId: "typescript",
    entityType: "function",
    entityName: "user.profile.load",
  });
  const parsed = parseGenieUri(uri);
  assert(parsed.ok);
  assertEquals(parsed.data.entityName, "user.profile.load");
});

Deno.test("non-genie URIs are rejected with a Result error", () => {
  for (const bad of [
    "file:///tmp/x.ts",
    "opentide://typescript/handlers/getUsers.js",
    "opentide://onlyhost",
    "not a uri",
  ]) {
    const parsed = parseGenieUri(bad);
    assert(!parsed.ok, `expected ${bad} to be rejected`);
    assertEquals(parsed.error.code, "INVALID_ENTITY_URI");
  }
});

Deno.test("a non-default runtimeId survives the round-trip", () => {
  const uri = entityUri({
    runtimeId: "python",
    entityType: "handler",
    entityName: "getUsers",
  });
  assertEquals(uri, "opentide://python/handlers/getUsers.ts");
  const parsed = parseGenieUri(uri);
  assert(parsed.ok);
  assertEquals(parsed.data.runtimeId, "python");
});
