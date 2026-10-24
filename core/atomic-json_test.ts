import { assertEquals, assertThrows } from "@std/assert";
import {
  existsSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { readJsonQuarantine, writeJsonAtomic } from "./atomic-json.ts";

async function withTempDir(fn: (dir: string) => void): Promise<void> {
  const dir = await Deno.makeTempDir({
    dir: "/private/tmp",
    prefix: "atomic-json-",
  });
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

Deno.test("writeJsonAtomic round-trips and leaves no temp file", async () => {
  await withTempDir((dir) => {
    const path = join(dir, "data.json");
    const value = { version: 1, items: ["a", "b"], nested: { n: 3 } };
    writeJsonAtomic(path, value);

    assertEquals(existsSync(`${path}.tmp`), false);
    assertEquals(JSON.parse(readFileSync(path, "utf-8")), value);
    // Pretty-printed (2-space) and human-inspectable.
    assertEquals(readFileSync(path, "utf-8"), JSON.stringify(value, null, 2));
  });
});

Deno.test("readJsonQuarantine: missing file returns the fallback (no quarantine)", async () => {
  await withTempDir((dir) => {
    const path = join(dir, "nope.json");
    const result = readJsonQuarantine(path, () => ({ empty: true }));
    assertEquals(result, { empty: true });
    assertEquals(existsSync(`${path}.corrupt`), false);
  });
});

Deno.test("readJsonQuarantine: valid file is parsed verbatim without validate", async () => {
  await withTempDir((dir) => {
    const path = join(dir, "data.json");
    writeJsonAtomic(path, { hello: "world" });
    assertEquals(
      readJsonQuarantine(path, () => ({ hello: "" })),
      { hello: "world" },
    );
  });
});

Deno.test("readJsonQuarantine: corrupt JSON degrades to fallback and quarantines", async () => {
  await withTempDir((dir) => {
    const path = join(dir, "data.json");
    writeFileSync(path, "{ this is not valid json");
    const result = readJsonQuarantine(path, () => ({ empty: true }));
    assertEquals(result, { empty: true });
    assertEquals(existsSync(`${path}.corrupt`), true);
    assertEquals(existsSync(path), false);
  });
});

Deno.test("readJsonQuarantine: a validate that rejects the shape also quarantines", async () => {
  await withTempDir((dir) => {
    const path = join(dir, "data.json");
    // Parseable JSON but the wrong shape — validate returns null → quarantine.
    writeJsonAtomic(path, { unexpected: true });
    const result = readJsonQuarantine(
      path,
      () => ({ ok: false }),
      (raw): { ok: boolean } | null =>
        typeof raw === "object" && raw !== null && "ok" in raw
          ? (raw as { ok: boolean })
          : null,
    );
    assertEquals(result, { ok: false });
    assertEquals(existsSync(`${path}.corrupt`), true);
  });
});

Deno.test("readJsonQuarantine: validate that accepts narrows and returns it", async () => {
  await withTempDir((dir) => {
    const path = join(dir, "data.json");
    writeJsonAtomic(path, { ok: true });
    const result = readJsonQuarantine(
      path,
      () => ({ ok: false }),
      (raw): { ok: boolean } | null =>
        typeof raw === "object" && raw !== null && "ok" in raw
          ? (raw as { ok: boolean })
          : null,
    );
    assertEquals(result, { ok: true });
    assertEquals(existsSync(`${path}.corrupt`), false);
  });
});

// Guard: the write must not leave detritus on a clean success (mirrors the
// registry/manifest atomicity tests that now delegate to this primitive).
Deno.test("writeJsonAtomic leaves nothing but the target in the directory", async () => {
  await withTempDir((dir) => {
    const path = join(dir, "only.json");
    writeJsonAtomic(path, { a: 1 });
    assertEquals(readdirSync(dir), ["only.json"]);
  });
});

// JSON.stringify throws on a BigInt — the write must surface that, not swallow it
// or leave a half-written target. (No tmp is created because stringify throws
// before any file write.)
Deno.test("writeJsonAtomic surfaces a non-serializable value as a throw", async () => {
  await withTempDir((dir) => {
    const path = join(dir, "bad.json");
    assertThrows(() => writeJsonAtomic(path, { big: 1n }));
    assertEquals(existsSync(path), false);
    assertEquals(existsSync(`${path}.tmp`), false);
  });
});
