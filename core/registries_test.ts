import { assertEquals, assertThrows } from "@std/assert";
import { AssetMap, ConfigMap, isSafePathSegment } from "./registries.ts";
import { KernelLog } from "./registries.ts";

Deno.test("isSafePathSegment rejects traversal and separators (F-08)", () => {
  // Safe single-segment names.
  for (const ok of ["logo.png", "styles.css", "a.b.c", "file_1-2"]) {
    assertEquals(isSafePathSegment(ok), true, ok);
  }
  // Unsafe: separators, traversal tokens, empty, NUL.
  for (
    const bad of [
      "",
      ".",
      "..",
      "../x",
      "a/b",
      "a\\b",
      "/etc/passwd",
      "x\0y",
    ]
  ) {
    assertEquals(isSafePathSegment(bad), false, JSON.stringify(bad));
  }
});
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { TEST_TMP_DIR } from "./test-home_test.ts";

Deno.test("AssetMap serialize/restore roundtrip for small assets", () => {
  const assets = new AssetMap();
  const content = new TextEncoder().encode("hello world");
  assets.register("test.txt", content, "text/plain");

  const serialized = assets.serialize();
  assertEquals(serialized.length, 1);
  assertEquals(serialized[0]!.name, "test.txt");

  const restored = new AssetMap();
  restored.restore(serialized);
  const entry = restored.get("test.txt");
  assertEquals(entry?.mimeType, "text/plain");
  assertEquals(new TextDecoder().decode(entry!.content), "hello world");
});

Deno.test("AssetMap serialize handles large binary assets (>64KB)", () => {
  const assets = new AssetMap();
  const size = 200_000;
  const content = new Uint8Array(size);
  for (let i = 0; i < size; i++) content[i] = i % 256;
  assets.register("large.bin", content, "application/octet-stream");

  const serialized = assets.serialize();
  assertEquals(serialized.length, 1);
  assertEquals(typeof serialized[0]!.contentBase64, "string");

  const restored = new AssetMap();
  restored.restore(serialized);
  const entry = restored.get("large.bin");
  assertEquals(entry!.content.length, size);
  assertEquals(entry!.content[0], 0);
  assertEquals(entry!.content[255], 255);
  assertEquals(entry!.content[256], 0);
});

Deno.test("AssetMap serialize handles 1MB binary asset", () => {
  const assets = new AssetMap();
  const size = 1_000_000;
  const content = new Uint8Array(size);
  content.fill(42);
  assets.register("mega.bin", content, "application/octet-stream");

  const serialized = assets.serialize();
  const restored = new AssetMap();
  restored.restore(serialized);
  const entry = restored.get("mega.bin");
  assertEquals(entry!.content.length, size);
  assertEquals(entry!.content[0], 42);
  assertEquals(entry!.content[size - 1], 42);
});

Deno.test("ConfigMap restore preserves entry values and metadata", () => {
  const configs = new ConfigMap();
  configs.set("PAGE_SIZE", 25, "Default page size", "api");

  const restored = new ConfigMap();
  restored.restore(configs.serialize());

  assertEquals(restored.get("PAGE_SIZE"), 25);
  assertEquals(
    restored.getEntry("PAGE_SIZE")?.description,
    "Default page size",
  );
  assertEquals(restored.getEntry("PAGE_SIZE")?.module, "api");
});

Deno.test("ConfigMap rejects non-JSON-serializable values", () => {
  const configs = new ConfigMap();
  assertThrows(
    () => configs.set("BAD", { nested: undefined }),
    Error,
    "JSON-serializable",
  );
  assertThrows(
    () => configs.set("BAD", Number.NaN),
    Error,
    "finite number",
  );

  const circular: Record<string, unknown> = {};
  circular.self = circular;
  assertThrows(
    () => configs.set("BAD", circular),
    Error,
    "circular references",
  );
});

Deno.test("KernelLog persists entries and clear state", async () => {
  const dir = await Deno.makeTempDir({
    dir: TEST_TMP_DIR,
    prefix: "genie-kernel-log-",
  });
  const filePath = join(dir, "logs.json");

  try {
    const log = new KernelLog(3);
    log.loadFromFile(filePath);
    log.log("info", "system", "first");
    log.log("error", "handler", "second", { route: "GET /items" });
    // log() persistence is debounced; force an immediate flush before reload.
    log.save();

    const reloaded = new KernelLog(3);
    reloaded.loadFromFile(filePath);
    assertEquals(
      reloaded.recent(10).map((entry) => entry.message),
      ["first", "second"],
    );
    assertEquals(reloaded.query({ level: "error" })[0]?.route, "GET /items");

    reloaded.clear();
    const persisted = JSON.parse(readFileSync(filePath, "utf-8")) as {
      entries: unknown[];
    };
    assertEquals(persisted.entries, []);

    const afterClear = new KernelLog(3);
    afterClear.loadFromFile(filePath);
    assertEquals(afterClear.recent(10), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

Deno.test("KernelLog debounces log() writes and flushes on save()", async () => {
  const dir = await Deno.makeTempDir({
    dir: TEST_TMP_DIR,
    prefix: "genie-kernel-log-debounce-",
  });
  const filePath = join(dir, "logs.json");

  try {
    const log = new KernelLog(10);
    log.loadFromFile(filePath);
    log.log("info", "system", "deferred");
    // log() is debounced — nothing is written to disk synchronously.
    assertEquals(existsSync(filePath), false);

    // save() forces an immediate flush (and cancels the pending timer).
    log.save();
    const reloaded = new KernelLog(10);
    reloaded.loadFromFile(filePath);
    assertEquals(reloaded.recent(10).map((e) => e.message), ["deferred"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
