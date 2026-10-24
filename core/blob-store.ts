// @layer core — content-addressed blob files: the name IS the sha256, sharded
// <hash[0:2]>/<hash>. Shared by the document store and asset changelog records.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export function blobHash(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function relativeBlobPath(hash: string): string {
  return join(hash.slice(0, 2), hash);
}

// Identical bytes always land on the same path, so an existing file is skipped.
// Returns the path relative to `root`.
export function writeBlobIfMissing(
  root: string,
  hash: string,
  bytes: Uint8Array,
  mode?: number,
): string {
  const rel = relativeBlobPath(hash);
  const abs = join(root, rel);
  if (!existsSync(abs)) {
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, bytes, mode === undefined ? undefined : { mode });
  }
  return rel;
}

export function readBlob(root: string, hash: string): Uint8Array | null {
  const abs = join(root, relativeBlobPath(hash));
  return existsSync(abs) ? new Uint8Array(readFileSync(abs)) : null;
}
