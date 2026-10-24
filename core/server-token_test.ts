import { assert, assertEquals, assertFalse } from "@std/assert";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SERVER_TOKEN_BYTES, SERVER_TOKEN_ENV } from "./config.ts";
import {
  bearerMatches,
  readServerToken,
  removeServerToken,
  resolveServerToken,
  serverTokenPath,
  writeServerToken,
} from "./server-token.ts";

Deno.test("bearerMatches: exact token only", () => {
  assert(bearerMatches("Bearer abc123", "abc123"));
  assertFalse(bearerMatches("Bearer abc124", "abc123"));
  assertFalse(bearerMatches("Bearer abc1234", "abc123"));
  assertFalse(bearerMatches("abc123", "abc123"));
  assertFalse(bearerMatches("Basic abc123", "abc123"));
  assertFalse(bearerMatches(null, "abc123"));
});

Deno.test("resolveServerToken: fresh hex unless the env var pins it", () => {
  const previous = Deno.env.get(SERVER_TOKEN_ENV);
  try {
    Deno.env.delete(SERVER_TOKEN_ENV);
    const minted = resolveServerToken();
    assertEquals(minted.length, SERVER_TOKEN_BYTES * 2);
    assert(/^[0-9a-f]+$/.test(minted));
    assert(minted !== resolveServerToken());

    Deno.env.set(SERVER_TOKEN_ENV, "pinned-token");
    assertEquals(resolveServerToken(), "pinned-token");
  } finally {
    if (previous === undefined) Deno.env.delete(SERVER_TOKEN_ENV);
    else Deno.env.set(SERVER_TOKEN_ENV, previous);
  }
});

Deno.test("writeServerToken: 0600, readable back, removable", () => {
  const dir = mkdtempSync(join(tmpdir(), "genie-token-"));
  try {
    assert(writeServerToken(dir, "t0k3n").ok);
    assertEquals(statSync(serverTokenPath(dir)).mode & 0o777, 0o600);
    assertEquals(readServerToken(dir), "t0k3n");
    removeServerToken(dir);
    assertEquals(readServerToken(dir), null);
    removeServerToken(dir); // already gone is fine
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
