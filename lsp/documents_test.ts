import { assert, assertEquals } from "@std/assert";
import { DocumentStore } from "./documents.ts";

const URI = "opentide://typescript/handlers/getUsers.ts";

Deno.test("open parses the URI into entity coordinates", () => {
  const store = new DocumentStore();
  const result = store.open(URI, 1, "export default (c) => c.json({})");
  assert(result.ok);
  assertEquals(result.data.ref, {
    runtimeId: "typescript",
    entityType: "handler",
    entityName: "getUsers",
  });
  assertEquals(result.data.version, 1);
});

Deno.test("open rejects a non-genie URI", () => {
  const store = new DocumentStore();
  const result = store.open("file:///x.ts", 1, "");
  assert(!result.ok);
  assert(!store.has("file:///x.ts"));
});

Deno.test("change replaces the buffer and bumps the version", () => {
  const store = new DocumentStore();
  store.open(URI, 1, "v1");
  const changed = store.change(URI, 2, "v2");
  assert(changed.ok);
  assertEquals(changed.data.content, "v2");
  assertEquals(changed.data.version, 2);
  assertEquals(store.get(URI)?.content, "v2");
});

Deno.test("change on an unopened URI is a Result error, not a silent open", () => {
  const store = new DocumentStore();
  const changed = store.change(URI, 1, "v1");
  assert(!changed.ok);
  assertEquals(changed.error.code, "DOCUMENT_NOT_OPEN");
  assert(!store.has(URI));
});

Deno.test("close drops the buffer", () => {
  const store = new DocumentStore();
  store.open(URI, 1, "v1");
  store.close(URI);
  assertEquals(store.get(URI), undefined);
  assertEquals(store.list().length, 0);
});
