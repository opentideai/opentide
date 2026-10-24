import { assertEquals } from "@std/assert";
import { EnvVarStore } from "../env-vars.ts";

function createStore(envOverrides?: Record<string, string>): EnvVarStore {
  const envMap = { get: (name: string) => envOverrides?.[name] };
  return new EnvVarStore(envMap);
}

Deno.test("define creates a new env var", () => {
  const store = createStore();
  const entry = store.define("API_KEY", "secret", "API key for service");
  assertEquals(entry.key, "API_KEY");
  assertEquals(entry.value, "secret");
  assertEquals(entry.description, "API key for service");
});

Deno.test("define updates existing env var", () => {
  const store = createStore();
  store.define("API_KEY", "v1", "first");
  const updated = store.define("API_KEY", "v2", "second");
  assertEquals(updated.value, "v2");
  assertEquals(updated.description, "second");
});

Deno.test("define preserves existing value when not provided", () => {
  const store = createStore();
  store.define("API_KEY", "keep-me", "original desc");
  const updated = store.define("API_KEY", undefined, "new desc");
  assertEquals(updated.value, "keep-me");
  assertEquals(updated.description, "new desc");
});

Deno.test("define preserves existing description when not provided", () => {
  const store = createStore();
  store.define("API_KEY", "val", "keep-me");
  const updated = store.define("API_KEY", "new-val");
  assertEquals(updated.value, "new-val");
  assertEquals(updated.description, "keep-me");
});

Deno.test("get returns undefined for missing key", () => {
  const store = createStore();
  assertEquals(store.get("NOPE"), undefined);
});

Deno.test("get returns existing entry", () => {
  const store = createStore();
  store.define("KEY", "val");
  const entry = store.get("KEY");
  assertEquals(entry?.key, "KEY");
  assertEquals(entry?.value, "val");
});

Deno.test("list returns all entries ordered by key", () => {
  const store = createStore();
  store.define("ZEBRA", "z");
  store.define("ALPHA", "a");
  store.define("MIDDLE", "m");
  const list = store.list();
  assertEquals(list.length, 3);
  assertEquals(list[0]!.key, "ALPHA");
  assertEquals(list[1]!.key, "MIDDLE");
  assertEquals(list[2]!.key, "ZEBRA");
});

Deno.test("remove deletes an entry", () => {
  const store = createStore();
  store.define("KEY", "val");
  assertEquals(store.remove("KEY"), true);
  assertEquals(store.get("KEY"), undefined);
});

Deno.test("remove returns false for missing key", () => {
  const store = createStore();
  assertEquals(store.remove("NOPE"), false);
});

Deno.test("setValue updates the value", () => {
  const store = createStore();
  store.define("KEY", "old");
  assertEquals(store.setValue("KEY", "new"), true);
  assertEquals(store.get("KEY")?.value, "new");
});

Deno.test("clearValue sets value to undefined", () => {
  const store = createStore();
  store.define("KEY", "has-value");
  assertEquals(store.clearValue("KEY"), true);
  assertEquals(store.get("KEY")?.value, undefined);
});

Deno.test("resolve returns stored value", () => {
  const store = createStore();
  store.define("KEY", "from-store");
  assertEquals(store.resolve("KEY"), "from-store");
});

Deno.test("resolve falls back to envMap", () => {
  const store = createStore({ FROM_ENV: "env-value" });
  store.define("FROM_ENV");
  assertEquals(store.resolve("FROM_ENV"), "env-value");
});

Deno.test("resolveAll combines stored and env values", () => {
  const store = createStore({ ENV_ONLY: "from-env" });
  store.define("DB_VAL", "from-store");
  store.define("ENV_ONLY");
  const all = store.resolveAll();
  assertEquals(all["DB_VAL"], "from-store");
  assertEquals(all["ENV_ONLY"], "from-env");
});

Deno.test("status returns correct states", () => {
  const store = createStore({ ENV_KEY: "yes" });
  assertEquals(store.status("MISSING"), "unset");

  store.define("SET_KEY", "value");
  assertEquals(store.status("SET_KEY"), "set");

  store.define("ENV_KEY");
  assertEquals(store.status("ENV_KEY"), "env");
});

Deno.test("serialize and restore round-trips", () => {
  const store = createStore();
  store.define("A", "val-a", "desc-a");
  store.define("B", "val-b");

  const serialized = store.serialize();
  assertEquals(serialized.length, 2);

  const store2 = createStore();
  store2.restore(serialized);
  assertEquals(store2.list().length, 2);
  assertEquals(store2.get("A")?.value, "val-a");
  assertEquals(store2.get("A")?.description, "desc-a");
  assertEquals(store2.get("B")?.value, "val-b");
});
