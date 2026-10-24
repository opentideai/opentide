import { assertEquals } from "@std/assert";
import { getEnvPath, loadEnv, saveEnv } from "./env.ts";
import { mkdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

const TMP_DIR = join(Deno.cwd(), ".test_env_tmp");

function withTmpDir(fn: (dir: string) => void): void {
  mkdirSync(TMP_DIR, { recursive: true });
  try {
    fn(TMP_DIR);
  } finally {
    rmSync(TMP_DIR, { recursive: true, force: true });
  }
}

Deno.test("env roundtrip: simple values", () => {
  withTmpDir((dir) => {
    const vars = { API_KEY: "abc123", PORT: "3000" };
    saveEnv(dir, vars);
    const loaded = loadEnv(dir);
    assertEquals(loaded, vars);
  });
});

Deno.test("saveEnv writes the .env file owner-only (0o600)", () => {
  withTmpDir((dir) => {
    saveEnv(dir, { API_KEY: "secret" });
    const mode = statSync(getEnvPath(dir)).mode & 0o777;
    assertEquals(mode, 0o600);
  });
});

Deno.test("env roundtrip: values with quotes are unescaped correctly", () => {
  withTmpDir((dir) => {
    const vars = { MSG: 'hello "world"' };
    saveEnv(dir, vars);
    const loaded = loadEnv(dir);
    assertEquals(loaded.MSG, 'hello "world"');
  });
});

Deno.test("env roundtrip: values with backslashes are unescaped correctly", () => {
  withTmpDir((dir) => {
    const vars = { PATH: "C:\\Users\\test" };
    saveEnv(dir, vars);
    const loaded = loadEnv(dir);
    assertEquals(loaded.PATH, "C:\\Users\\test");
  });
});

Deno.test("env roundtrip: values with newlines", () => {
  withTmpDir((dir) => {
    const vars = { MULTI: "line1\nline2\nline3" };
    saveEnv(dir, vars);
    const loaded = loadEnv(dir);
    assertEquals(loaded.MULTI, "line1\nline2\nline3");
  });
});

Deno.test("env roundtrip: values with spaces", () => {
  withTmpDir((dir) => {
    const vars = { GREETING: "hello world" };
    saveEnv(dir, vars);
    const loaded = loadEnv(dir);
    assertEquals(loaded.GREETING, "hello world");
  });
});

Deno.test("loadEnv returns empty for missing file", () => {
  withTmpDir((dir) => {
    const loaded = loadEnv(dir);
    assertEquals(loaded, {});
  });
});
