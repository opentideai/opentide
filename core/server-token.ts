// @layer core — the per-server token that gates the MCP HTTP endpoint.
//
// The loopback bind and the Host/Origin check keep browsers and the LAN out. They
// don't keep out another local user, or a local process that isn't one of ours.
// The token does: whoever holds the project lock writes it to
// `.opentide/kernel.token` (mode 0o600), and a client proves it can read the
// project's state dir by sending it back as `Authorization: Bearer <token>`.
//
// It is a gate, not an identity. Every holder of the token is the same principal.
import { projectStateDir } from "./project-layout.ts";
import { join } from "node:path";
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { SERVER_TOKEN_BYTES, SERVER_TOKEN_ENV } from "./config.ts";
import { errorMessage } from "./util.ts";
import type { Result } from "./types.ts";

export const SERVER_TOKEN_FILE = "kernel.token";
const SERVER_TOKEN_MODE = 0o600;
const BEARER_PREFIX = "Bearer ";

export function serverTokenPath(projectDir: string): string {
  return join(projectStateDir(projectDir), SERVER_TOKEN_FILE);
}

// The pinned token when SERVER_TOKEN_ENV is set, otherwise 32 fresh random bytes.
export function resolveServerToken(): string {
  const pinned = Deno.env.get(SERVER_TOKEN_ENV)?.trim();
  if (pinned) return pinned;
  const bytes = crypto.getRandomValues(new Uint8Array(SERVER_TOKEN_BYTES));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function writeServerToken(
  projectDir: string,
  token: string,
): Result<void> {
  const path = serverTokenPath(projectDir);
  try {
    mkdirSync(projectStateDir(projectDir), { recursive: true });
    writeFileSync(path, token, { mode: SERVER_TOKEN_MODE });
    // `mode` only applies when the file is created. A leftover from a crash keeps
    // whatever mode it had, so set it again.
    chmodSync(path, SERVER_TOKEN_MODE);
    return { ok: true, data: undefined };
  } catch (err) {
    return {
      ok: false,
      error: {
        code: "SERVER_TOKEN_UNWRITABLE",
        message: `Could not write ${path}: ${errorMessage(err)}`,
      },
    };
  }
}

export function readServerToken(projectDir: string): string | null {
  try {
    return readFileSync(serverTokenPath(projectDir), "utf-8").trim() || null;
  } catch {
    return null;
  }
}

export function removeServerToken(projectDir: string): void {
  rmSync(serverTokenPath(projectDir), { force: true });
}

// Constant-time over the token bytes. A length mismatch returns early, which
// leaks the length, and the length is public (SERVER_TOKEN_BYTES).
export function bearerMatches(
  authorization: string | null,
  token: string,
): boolean {
  if (!authorization?.startsWith(BEARER_PREFIX)) return false;
  const encoder = new TextEncoder();
  const given = encoder.encode(authorization.slice(BEARER_PREFIX.length));
  const expected = encoder.encode(token);
  if (given.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < given.length; i++) diff |= given[i]! ^ expected[i]!;
  return diff === 0;
}
