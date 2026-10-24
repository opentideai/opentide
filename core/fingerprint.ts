// Source fingerprinting for verification freshness.
//
// An attestation records the fingerprint of the exact source it asserts. When
// the current fingerprint drifts from the one an attestation was minted
// against, that attestation is "stale" and no longer counts toward a hard
// verification gate. Fingerprints are deterministic and dependency-free so the
// same code always hashes to the same value across runs and storage backends.

import type { Kernel } from "./registries.ts";
import type { Changeset } from "./types.ts";

// Well-known fingerprint scope for project-wide attestations (typecheck,
// coverage, tests, audits) — as opposed to per-entity scopes like "handler:x".
export const PROJECT_SCOPE = "project";

// Fingerprint scope for production-build attestations (Slice 5.4). Deliberately
// has NO freshness resolver: a production sourceFingerprint is a manifest-tree
// hash unrelated to fingerprintProject(), so fresh/stale isn't cheaply or
// meaningfully computable — these rows are point-in-time build history, not a
// live snapshot. Kept out of PROJECT_ATTESTATION_KINDS and currentFingerprints.
export const PRODUCTION_SCOPE = "production";

// A production build carries no changeset context. When no in_progress changeset
// is active, its attestations attach to this synthetic sentinel in the ledger.
// It is never a real changeset row — the ledger's changeset_id is plain text with
// no foreign key, so a sentinel id inserts cleanly.
export const PRODUCTION_CHANGESET_ID = "production-build";
export const PRODUCTION_CHANGESET_TITLE = "Production build";

// Normalizes source so cosmetic-only differences (line endings, trailing
// whitespace) don't register as drift, while every meaningful edit — including
// comment changes — does.
function normalizeSource(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/[ \t]+\n/g, "\n").trimEnd();
}

// FNV-1a (32-bit) prefixed with the normalized length. Sync, deterministic, and
// collision-resistant enough for change detection (the threat model is
// accidental drift, not adversarial collision — attestations are kernel-minted).
export function hashSource(text: string): string {
  const normalized = normalizeSource(text);
  let hash = 0x811c9dc5;
  for (let i = 0; i < normalized.length; i++) {
    hash ^= normalized.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return `${normalized.length.toString(16)}-${
    (hash >>> 0).toString(16).padStart(8, "0")
  }`;
}

// Resolves a formal spec's `scope` ("handler:name", "function:name", or a bare
// entity name) to the target entity's current source.
export function resolveScopeSource(
  kernel: Kernel,
  scope: string,
): string | null {
  const idx = scope.indexOf(":");
  const prefix = idx === -1 ? "" : scope.slice(0, idx).trim();
  const name = (idx === -1 ? scope : scope.slice(idx + 1)).trim();
  if (prefix === "handler") return kernel.handlers.get(name)?.source ?? null;
  if (prefix === "function") {
    return kernel.functions.getEntry(name)?.source ?? null;
  }
  return kernel.handlers.get(name)?.source ??
    kernel.functions.getEntry(name)?.source ?? null;
}

// Fingerprint of a single entity's source. Null when the scope can't resolve.
export function fingerprintScope(kernel: Kernel, scope: string): string | null {
  const source = resolveScopeSource(kernel, scope);
  return source === null ? null : hashSource(source);
}

// Canonicalize a JSON value so its serialization is independent of object-key
// insertion order — a cosmetic reordering of keys must not move a fingerprint.
// Recursively sorts object keys; arrays keep their order (order is significant in
// JSON, e.g. a schema's `required`). The one canonicalizer shared by the surface
// fingerprints (mcp-projection.ts, lsp/surface.ts) so their key/sort semantics
// can't drift between them.
export function canonicalizeJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalizeJson);
  if (value && typeof value === "object") {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[key] = canonicalizeJson((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return value;
}

// Order-independent hash of a set of labeled parts: stable-sort so ordering
// never affects the value, then hash the parts joined by a NUL record separator
// (`\n\0\n`) that can't occur in normal source, so distinct part-sets can't
// collide by concatenation. The one place the "stable set fingerprint" contract
// lives — reused by fingerprintProject and the MCP surface fingerprint
// (mcp-projection.ts) so the separator/sort semantics can't drift between them.
export function hashParts(parts: string[]): string {
  return hashSource([...parts].sort().join("\n\0\n"));
}

// Fingerprint of the whole verifiable surface: every handler, function, and
// test source, stable-sorted so ordering never affects the hash. Used for
// project-scoped attestations (typecheck/coverage/test/audit).
export function fingerprintProject(kernel: Kernel): string {
  const parts: string[] = [];
  for (const h of kernel.handlers.list()) {
    parts.push(`handler:${h.name}\n${h.source}`);
  }
  for (const f of kernel.functions.list()) {
    parts.push(`function:${f.name}\n${f.source}`);
  }
  for (const t of kernel.tests.list()) {
    parts.push(`test:${t.name}\n${t.source}`);
  }
  return hashParts(parts);
}

// The current fingerprint for every scope a changeset's attestations can be
// checked against: the project snapshot plus each formal spec's target entity.
// Passed into checkChangesetReadiness so freshness is evaluated against live
// code rather than the source as it was when an attestation was minted.
export function currentFingerprints(
  kernel: Kernel,
  changeset: Changeset,
): Record<string, string> {
  const map: Record<string, string> = {
    [PROJECT_SCOPE]: fingerprintProject(kernel),
  };
  for (const spec of changeset.plan.formalSpecs ?? []) {
    const fp = fingerprintScope(kernel, spec.scope);
    if (fp) map[spec.scope] = fp;
  }
  return map;
}
