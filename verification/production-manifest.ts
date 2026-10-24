// @layer verification — production-output gates (Milestone 2). Two pure,
// side-effect-free gate functions that re-verify a production export against its
// own manifest and against the determinism guarantee. They return the repo's
// standard Result<T> and NEVER throw, so a later Phase 4 orchestrator/ledger can
// call them and record the typed payload. No file writes, no ledger writes.
//
// The manifest hashes and export determinism are INDEPENDENTLY re-verifiable
// here: this module recomputes every file hash and the sourceFingerprint from
// scratch. It shares exactly one thing with the generator — the fingerprint
// formula (computeSourceFingerprint in core/export.ts) — so the generator and
// the verifier can never drift on how the fingerprint is derived.
import {
  computeSourceFingerprint,
  type ExportFile,
  type ExportManifest,
  exportProject,
  type ExportProjectOptions,
  fileBytes,
  MANIFEST_PATH,
  type ManifestFileEntry,
  sha256Hex,
} from "../core/export.ts";
import type { Kernel } from "../core/registries.ts";
import type { Result } from "../core/types.ts";

// Semantic error codes (no magic strings). Each names one distinct way an export
// can fail re-verification.
export const MANIFEST_MISSING = "MANIFEST_MISSING";
export const MANIFEST_INVALID = "MANIFEST_INVALID";
export const MANIFEST_HASH_MISMATCH = "MANIFEST_HASH_MISMATCH";
export const MANIFEST_FILE_SET_MISMATCH = "MANIFEST_FILE_SET_MISMATCH";
export const MANIFEST_FINGERPRINT_MISMATCH = "MANIFEST_FINGERPRINT_MISMATCH";
export const EXPORT_NONDETERMINISTIC = "EXPORT_NONDETERMINISTIC";

// Typed success payload — small on purpose, so an orchestrator/ledger can record
// what was verified.
export interface ManifestVerification {
  verifiedFileCount: number;
  sourceFingerprint: string;
}

function fail<T>(
  code: string,
  message: string,
  suggestion?: string,
): Result<T> {
  return { ok: false, error: { code, message, suggestion } };
}

// Recomputed truth for one emitted file: its actual content hash and byte length.
interface RecomputedFile {
  sha256: string;
  bytes: number;
}

// Hash + measure every emitted file except the manifest itself (which is never
// listed or fingerprinted). Keyed by path for O(1) cross-checks.
async function recomputeFiles(
  files: ExportFile[],
): Promise<Map<string, RecomputedFile>> {
  const recomputed = new Map<string, RecomputedFile>();
  for (const file of files) {
    if (file.path === MANIFEST_PATH) continue;
    const bytes = fileBytes(file);
    recomputed.set(file.path, {
      sha256: await sha256Hex(bytes),
      bytes: bytes.byteLength,
    });
  }
  return recomputed;
}

// Parse manifest.json out of an emitted export, validating its structure. Returns
// a MANIFEST_MISSING / MANIFEST_INVALID failure rather than throwing.
function parseManifest(
  files: ExportFile[],
): Result<ExportManifest> {
  const entry = files.find((f) => f.path === MANIFEST_PATH);
  if (!entry) {
    return fail(
      MANIFEST_MISSING,
      `Export contains no ${MANIFEST_PATH}.`,
      "Re-export with { includeManifest: true }.",
    );
  }

  const text = new TextDecoder().decode(fileBytes(entry));
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    return fail(
      MANIFEST_INVALID,
      `${MANIFEST_PATH} is not valid JSON: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  const invalid = manifestStructureError(parsed);
  if (invalid) return fail(MANIFEST_INVALID, invalid);
  return { ok: true, data: parsed as ExportManifest };
}

// A shallow structural check: the fields the gate relies on must be present and
// well-typed. Returns an error message, or null when the shape is acceptable.
function manifestStructureError(parsed: unknown): string | null {
  if (typeof parsed !== "object" || parsed === null) {
    return `${MANIFEST_PATH} must be a JSON object.`;
  }
  const m = parsed as Record<string, unknown>;
  if (typeof m.sourceFingerprint !== "string") {
    return `${MANIFEST_PATH} is missing a string sourceFingerprint.`;
  }
  if (!Array.isArray(m.files)) {
    return `${MANIFEST_PATH} is missing a files[] array.`;
  }
  for (const [i, raw] of (m.files as unknown[]).entries()) {
    if (typeof raw !== "object" || raw === null) {
      return `${MANIFEST_PATH} files[${i}] is not an object.`;
    }
    const f = raw as Record<string, unknown>;
    if (
      typeof f.path !== "string" || typeof f.sha256 !== "string" ||
      typeof f.bytes !== "number"
    ) {
      return `${MANIFEST_PATH} files[${i}] must have { path: string, sha256: string, bytes: number }.`;
    }
  }
  return null;
}

// Confirm the manifest's files[] path set equals the emitted set minus
// manifest.json — catching a listed-but-absent file, an emitted-but-unlisted
// file, and a manifest that lists itself.
function verifyFileSet(
  manifestFiles: ManifestFileEntry[],
  recomputed: Map<string, RecomputedFile>,
): Result<void> {
  const listed = new Set<string>();
  for (const entry of manifestFiles) {
    if (entry.path === MANIFEST_PATH) {
      return fail(
        MANIFEST_FILE_SET_MISMATCH,
        `${MANIFEST_PATH} lists itself; the manifest must never list or fingerprint itself.`,
      );
    }
    if (!recomputed.has(entry.path)) {
      return fail(
        MANIFEST_FILE_SET_MISMATCH,
        `${MANIFEST_PATH} lists "${entry.path}", which is not present in the export.`,
      );
    }
    listed.add(entry.path);
  }
  for (const path of recomputed.keys()) {
    if (!listed.has(path)) {
      return fail(
        MANIFEST_FILE_SET_MISMATCH,
        `Emitted file "${path}" is not listed in ${MANIFEST_PATH}.`,
      );
    }
  }
  return { ok: true, data: undefined };
}

// Confirm every manifest entry's hash and byte count match the real emitted
// bytes. Reports the FIRST mismatch with path + expected/actual. Assumes the
// file set has already been verified (so every entry has a recomputed match).
function verifyHashes(
  manifestFiles: ManifestFileEntry[],
  recomputed: Map<string, RecomputedFile>,
): Result<void> {
  for (const entry of manifestFiles) {
    const actual = recomputed.get(entry.path)!;
    if (entry.bytes !== actual.bytes) {
      return fail(
        MANIFEST_HASH_MISMATCH,
        `Byte count mismatch for "${entry.path}": manifest says ${entry.bytes}, actual is ${actual.bytes}.`,
      );
    }
    if (entry.sha256 !== actual.sha256) {
      return fail(
        MANIFEST_HASH_MISMATCH,
        `Hash mismatch for "${entry.path}": manifest says ${entry.sha256}, actual is ${actual.sha256}.`,
      );
    }
  }
  return { ok: true, data: undefined };
}

/**
 * Gate: an already-produced export (with a manifest) re-verifies against its own
 * manifest.json. Recomputes every file hash/byte-length, confirms the listed
 * file set equals the emitted set (manifest self-excluded), and re-derives the
 * sourceFingerprint from scratch — confirming the export has not been tampered
 * with since it was generated. Never throws.
 */
export async function verifyManifest(
  files: ExportFile[],
): Promise<Result<ManifestVerification>> {
  const parsed = parseManifest(files);
  if (!parsed.ok) return parsed;
  const manifest = parsed.data;

  const recomputed = await recomputeFiles(files);

  // File set first: once it holds, every manifest entry has a recomputed match,
  // so the hash pass can assume presence.
  const fileSet = verifyFileSet(manifest.files, recomputed);
  if (!fileSet.ok) return fileSet;

  const hashes = verifyHashes(manifest.files, recomputed);
  if (!hashes.ok) return hashes;

  // Re-derive the fingerprint from the ACTUAL emitted bytes, using the generator's
  // shared formula, and confirm it matches the stored value.
  const recomputedFingerprint = await computeSourceFingerprint(
    [...recomputed.entries()].map(([path, f]) => ({ path, sha256: f.sha256 })),
  );
  if (recomputedFingerprint !== manifest.sourceFingerprint) {
    return fail(
      MANIFEST_FINGERPRINT_MISMATCH,
      `sourceFingerprint mismatch: manifest says ${manifest.sourceFingerprint}, recomputed is ${recomputedFingerprint}.`,
    );
  }

  return {
    ok: true,
    data: {
      verifiedFileCount: manifest.files.length,
      sourceFingerprint: manifest.sourceFingerprint,
    },
  };
}

/**
 * Gate: exporting the same kernel twice (with a manifest) is byte-reproducible.
 * Operationalizes Phase 1's determinism property as a reusable gate. Confirms an
 * identical file set + per-file content hash, identical tarball bytes, and an
 * identical manifest sourceFingerprint across the two exports. Never throws.
 */
export async function verifyExportDeterminism(
  kernel: Kernel,
  opts?: ExportProjectOptions,
): Promise<Result<{ sourceFingerprint: string }>> {
  const exportOpts: ExportProjectOptions = { ...opts, includeManifest: true };

  const first = await exportProject(kernel, exportOpts);
  const second = await exportProject(kernel, exportOpts);

  const filesA = await filesContentFingerprint(first.files);
  const filesB = await filesContentFingerprint(second.files);
  if (filesA !== filesB) {
    return fail(
      EXPORT_NONDETERMINISTIC,
      "Re-exporting the same kernel produced a different file set or file contents.",
    );
  }

  const tarA = await sha256Hex(first.tarball);
  const tarB = await sha256Hex(second.tarball);
  if (tarA !== tarB) {
    return fail(
      EXPORT_NONDETERMINISTIC,
      `Re-exporting the same kernel produced different tarball bytes (${tarA} vs ${tarB}).`,
    );
  }

  const fpA = manifestFingerprint(first.files);
  const fpB = manifestFingerprint(second.files);
  if (fpA === null || fpB === null) {
    return fail(
      EXPORT_NONDETERMINISTIC,
      `Export omitted ${MANIFEST_PATH}; cannot compare sourceFingerprints.`,
    );
  }
  if (fpA !== fpB) {
    return fail(
      EXPORT_NONDETERMINISTIC,
      `Re-exporting the same kernel produced different sourceFingerprints (${fpA} vs ${fpB}).`,
    );
  }

  return { ok: true, data: { sourceFingerprint: fpA } };
}

// A path-sorted [path, content-hash] fingerprint over EVERY emitted file
// (manifest included) — the byte-reproducibility check for determinism.
async function filesContentFingerprint(files: ExportFile[]): Promise<string> {
  const pairs: Array<[string, string]> = [];
  for (const file of files) {
    pairs.push([file.path, await sha256Hex(fileBytes(file))]);
  }
  pairs.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return JSON.stringify(pairs);
}

// Read the stored sourceFingerprint straight off an emitted manifest, or null if
// the manifest is absent/unparseable.
function manifestFingerprint(files: ExportFile[]): string | null {
  const entry = files.find((f) => f.path === MANIFEST_PATH);
  if (!entry) return null;
  try {
    const parsed = JSON.parse(new TextDecoder().decode(fileBytes(entry)));
    const fp = (parsed as { sourceFingerprint?: unknown }).sourceFingerprint;
    return typeof fp === "string" ? fp : null;
  } catch {
    return null;
  }
}
