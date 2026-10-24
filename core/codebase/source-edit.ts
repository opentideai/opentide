// @layer core — source-backed file editing (project-import Slice 5).
//
// A source-backed project (docs/project-import-strategy.md) runs on its native
// runtime; its code lives in on-disk files, not kernel registry entities. This
// module is the confined, whole-file mechanism that edits those files through the
// same changeset/changelog rails registry entities use:
//
//   preview  → stageSourceEdit()   : dry-run; resolve a range/anchored/full edit
//                                     to a full afterSnapshot + a base fingerprint,
//                                     without touching disk.
//   apply    → commitSourceEdit()  : re-read disk, reject PATCH_CONFLICT if it moved
//                                     since preview, capture the pre-image, write.
//   undo     → writeSourceSnapshot(): restore a stored whole-file snapshot (or delete)
//                                     — the primitive applySnapshot() drives on undo/redo.
//
// The stored/applied op is ALWAYS a whole-file snapshot (see the strategy doc:
// "File-patch representation"). Authoring may be anchored/range for token economy,
// but it is materialized to full content here before staging — one apply path, one
// undo path, one preview renderer. No unified-diff/patch format is invented.
//
// Everything here is pure over (root, request) — no Kernel, no changelog. The
// kernel-side orchestration (recording the ChangeRecord + re-indexing) lives with
// its callers (control-server apply endpoint; dispatch applySnapshot for undo).

import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, normalize, relative, resolve, sep } from "node:path";
import { resolveProjectFilePath } from "../control-helpers.ts";
import {
  MAX_FILE_CONTENT_BYTES,
  PROJECT_FILE_IGNORED_DIRS,
  PROJECT_FILE_IGNORED_FILES,
} from "../config.ts";
import type { Result } from "../types.ts";

// A whole-file snapshot: the project-root-relative POSIX path and its full UTF-8
// content. This is the shape stored in a source-backed ChangeRecord's before/after.
export interface SourceFileSnapshot {
  path: string;
  content: string;
}

export type SourceEditAction = "create" | "update" | "delete";

// An edit request. Exactly one authoring mode must be set: full `content`, an
// `anchor` (find a unique region, replace it), or `delete`. `baseFingerprint` is
// the fingerprint returned by a prior preview; when present at apply time it is
// enforced (PATCH_CONFLICT if disk moved). Absent ⇒ no conflict check (single-shot).
export interface SourceEditRequest {
  path: string;
  content?: string;
  anchor?: { find: string; replace: string };
  delete?: boolean;
  baseFingerprint?: string | null;
}

// The result of a dry-run stage: the full before/after snapshots the IDE renders
// as a diff, plus the base fingerprint (hash of current on-disk content, or null
// for a create) the client echoes back on apply for conflict detection.
export interface StagedSourceEdit {
  key: string;
  action: SourceEditAction;
  before: SourceFileSnapshot | null;
  after: SourceFileSnapshot | null;
  baseFingerprint: string | null;
}

// The result of a committed edit: the pre-image captured at apply time (before)
// and the written content (after). The caller records these as a ChangeRecord's
// before/after so undo restores exact prior bytes.
export interface SourceEditCommit {
  key: string;
  action: SourceEditAction;
  before: SourceFileSnapshot | null;
  after: SourceFileSnapshot | null;
}

function fail<T>(
  code: string,
  message: string,
  suggestion?: string,
): Result<T> {
  return {
    ok: false,
    error: { code, message, ...(suggestion ? { suggestion } : {}) },
  };
}

// Deterministic content fingerprint. Hashing the decoded text (not raw bytes) is
// symmetric with how we write (writeFileSync(..., "utf8")): read→decode→hash and
// re-read→decode→hash agree for the text files this module accepts (binaries are
// refused up front), so a fingerprint match means "unchanged since preview".
export function fingerprintContent(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

function byteLength(content: string): number {
  return new TextEncoder().encode(content).length;
}

// A NUL byte in the first block is a strong binary signal — we refuse to read or
// round-trip such a file as text rather than corrupt it on write-back.
function looksBinary(raw: Uint8Array): boolean {
  const scan = Math.min(raw.length, 8000);
  for (let i = 0; i < scan; i++) {
    if (raw[i] === 0) return true;
  }
  return false;
}

interface ResolvedEditPath {
  fullPath: string;
  key: string;
}

// Resolves + confines an edit target to the project root: lexical `..`/absolute
// containment (resolveProjectFilePath), an ignored-dir/-file refusal, and a
// symlink-escape check (a symlinked directory in the path that points outside the
// root). Returns the canonical POSIX key (relative to root) that the graph and the
// changelog use.
function resolveEditPath(
  root: string,
  rawPath: string,
): Result<ResolvedEditPath> {
  const resolved = resolveProjectFilePath(root, rawPath);
  if (!resolved) {
    return fail(
      "INVALID_PATH",
      `Path "${rawPath}" is outside the project root or malformed.`,
      "Use a project-root-relative path with no '..' or absolute segments.",
    );
  }
  const normalizedRoot = normalize(resolve(root));
  const key = relative(normalizedRoot, resolved.fullPath).split(sep).join("/");
  if (key === "" || key.startsWith("..")) {
    return fail(
      "INVALID_PATH",
      `Path "${rawPath}" does not name a file in the project.`,
    );
  }
  const segments = key.split("/");
  const fileName = segments[segments.length - 1] ?? "";
  if (PROJECT_FILE_IGNORED_FILES.includes(fileName)) {
    return fail(
      "IGNORED_PATH",
      `File "${key}" is protected and cannot be edited.`,
    );
  }
  for (const seg of segments.slice(0, -1)) {
    if (PROJECT_FILE_IGNORED_DIRS.includes(seg)) {
      return fail(
        "IGNORED_PATH",
        `Path "${key}" passes through the ignored directory "${seg}".`,
      );
    }
  }
  if (symlinkEscapes(normalizedRoot, resolved.fullPath)) {
    return fail(
      "INVALID_PATH",
      `Path "${key}" resolves outside the project root via a symlink.`,
    );
  }
  return { ok: true, data: { fullPath: resolved.fullPath, key } };
}

// True if the deepest existing ancestor of `fullPath` real-resolves outside the
// project root — i.e. a symlinked directory on the path escapes containment. For a
// yet-to-be-created file we can only check existing ancestors, which is exactly
// where a malicious symlink would have to live.
function symlinkEscapes(normalizedRoot: string, fullPath: string): boolean {
  let realRoot: string;
  try {
    realRoot = realpathSync(normalizedRoot);
  } catch {
    return true;
  }
  let probe = fullPath;
  while (!existsSync(probe)) {
    const parent = dirname(probe);
    if (parent === probe) return true;
    probe = parent;
  }
  let realProbe: string;
  try {
    realProbe = realpathSync(probe);
  } catch {
    return true;
  }
  return realProbe !== realRoot && !realProbe.startsWith(realRoot + sep);
}

function readCurrentContent(
  fullPath: string,
): Result<{ content: string | null; fingerprint: string | null }> {
  if (!existsSync(fullPath)) {
    return { ok: true, data: { content: null, fingerprint: null } };
  }
  let stat: ReturnType<typeof statSync>;
  try {
    stat = statSync(fullPath);
  } catch {
    return fail("FILE_NOT_FOUND", `Cannot stat file at "${fullPath}".`);
  }
  if (stat.isDirectory()) {
    return fail(
      "INVALID_PATH",
      `Path "${fullPath}" is a directory, not a file.`,
    );
  }
  if (stat.size > MAX_FILE_CONTENT_BYTES) {
    return fail(
      "FILE_TOO_LARGE",
      `File exceeds the ${MAX_FILE_CONTENT_BYTES}-byte edit limit (${stat.size} bytes).`,
    );
  }
  let raw: Uint8Array;
  try {
    raw = readFileSync(fullPath);
  } catch {
    return fail("FILE_NOT_FOUND", `Cannot read file at "${fullPath}".`);
  }
  if (looksBinary(raw)) {
    return fail(
      "BINARY_FILE",
      `File appears to be binary and cannot be edited as text.`,
    );
  }
  const content = new TextDecoder().decode(raw);
  return {
    ok: true,
    data: { content, fingerprint: fingerprintContent(content) },
  };
}

// Resolves the requested edit to a full afterSnapshot (or null for delete) against
// the current on-disk content. Anchored edits re-resolve against `current` here —
// never a stale offset — and fail if the anchor is missing or ambiguous.
function materializeAfter(
  current: string | null,
  req: SourceEditRequest,
): Result<string | null> {
  const modes = [
    req.content !== undefined,
    req.anchor !== undefined,
    req.delete === true,
  ].filter(Boolean).length;
  if (modes === 0) {
    return fail(
      "EMPTY_EDIT",
      "An edit must set exactly one of `content`, `anchor`, or `delete`.",
    );
  }
  if (modes > 1) {
    return fail(
      "AMBIGUOUS_EDIT",
      "An edit must set exactly one of `content`, `anchor`, or `delete` — not several.",
    );
  }
  if (req.delete === true) {
    if (current === null) {
      return fail(
        "FILE_NOT_FOUND",
        "Cannot delete a file that does not exist.",
      );
    }
    return { ok: true, data: null };
  }
  if (req.content !== undefined) {
    return { ok: true, data: req.content };
  }
  const anchor = req.anchor!;
  if (current === null) {
    return fail(
      "FILE_NOT_FOUND",
      "Cannot apply an anchored edit to a file that does not exist — send full `content` to create it.",
    );
  }
  if (anchor.find === "") {
    return fail(
      "ANCHOR_NOT_FOUND",
      "`anchor.find` must be a non-empty region.",
    );
  }
  const first = current.indexOf(anchor.find);
  if (first < 0) {
    return fail(
      "ANCHOR_NOT_FOUND",
      "`anchor.find` is not present in the current file — re-read the file and retry.",
    );
  }
  if (current.lastIndexOf(anchor.find) !== first) {
    return fail(
      "ANCHOR_AMBIGUOUS",
      "`anchor.find` matches more than one region — provide a more specific anchor or full `content`.",
    );
  }
  const after = current.slice(0, first) + anchor.replace +
    current.slice(first + anchor.find.length);
  return { ok: true, data: after };
}

function stageInternal(
  root: string,
  req: SourceEditRequest,
): Result<StagedSourceEdit & { fullPath: string }> {
  const resolved = resolveEditPath(root, req.path);
  if (!resolved.ok) return resolved;
  const { fullPath, key } = resolved.data;

  const current = readCurrentContent(fullPath);
  if (!current.ok) return current;

  const before: SourceFileSnapshot | null = current.data.content === null
    ? null
    : { path: key, content: current.data.content };

  const materialized = materializeAfter(current.data.content, req);
  if (!materialized.ok) return materialized;
  const afterContent = materialized.data;

  if (
    afterContent !== null && byteLength(afterContent) > MAX_FILE_CONTENT_BYTES
  ) {
    return fail(
      "FILE_TOO_LARGE",
      `The edited content exceeds the ${MAX_FILE_CONTENT_BYTES}-byte limit.`,
    );
  }

  const after: SourceFileSnapshot | null = afterContent === null
    ? null
    : { path: key, content: afterContent };
  const action: SourceEditAction = before === null
    ? "create"
    : after === null
    ? "delete"
    : "update";

  return {
    ok: true,
    data: {
      key,
      action,
      before,
      after,
      baseFingerprint: current.data.fingerprint,
      fullPath,
    },
  };
}

// Dry-run: resolve the edit to full before/after snapshots + a base fingerprint,
// without writing. The IDE renders before/after as a diff; the client echoes
// baseFingerprint back on apply so a concurrent external write is caught.
export function stageSourceEdit(
  root: string,
  req: SourceEditRequest,
): Result<StagedSourceEdit> {
  const staged = stageInternal(root, req);
  if (!staged.ok) return staged;
  const { fullPath: _fullPath, ...view } = staged.data;
  return { ok: true, data: view };
}

// Commit: re-stage against fresh disk, enforce the caller's expected fingerprint
// (PATCH_CONFLICT if the file moved since preview), then write. The returned
// before/after are captured at THIS moment, so recording them makes undo restore
// exact prior bytes.
export function commitSourceEdit(
  root: string,
  req: SourceEditRequest,
): Result<SourceEditCommit> {
  const staged = stageInternal(root, req);
  if (!staged.ok) return staged;
  const s = staged.data;

  if (
    req.baseFingerprint !== undefined &&
    req.baseFingerprint !== s.baseFingerprint
  ) {
    return fail(
      "PATCH_CONFLICT",
      "The file changed on disk since it was previewed (external edit or dev-server write).",
      "Re-read the file, rebuild the edit against current content, and retry.",
    );
  }

  const written = writeSnapshotToDisk(s.fullPath, s.after);
  if (!written.ok) return written;

  return {
    ok: true,
    data: { key: s.key, action: s.action, before: s.before, after: s.after },
  };
}

function writeSnapshotToDisk(
  fullPath: string,
  snapshot: SourceFileSnapshot | null,
): Result<void> {
  try {
    if (snapshot === null) {
      if (existsSync(fullPath)) rmSync(fullPath, { force: true });
      return { ok: true, data: undefined };
    }
    mkdirSync(dirname(fullPath), { recursive: true });
    writeFileSync(fullPath, snapshot.content, { encoding: "utf8" });
    return { ok: true, data: undefined };
  } catch (err) {
    return fail(
      "WRITE_FAILED",
      `Failed to write "${fullPath}": ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}

// Whether undo/redo could restore a snapshot at `key` (writeSourceSnapshot would
// accept the path). Writers that can reach protected paths record those changes
// as not undoable rather than leave a record undo can't apply.
export function canRestoreSourceSnapshot(root: string, key: string): boolean {
  return resolveEditPath(root, key).ok;
}

// Restore a stored whole-file snapshot (write content, or delete when null),
// re-confining `key` to the root. This is the primitive undo/redo drives: on undo,
// `snapshot` is the record's beforeSnapshot; on redo, its afterSnapshot.
export function writeSourceSnapshot(
  root: string,
  key: string,
  snapshot: SourceFileSnapshot | null,
): Result<void> {
  const resolved = resolveEditPath(root, key);
  if (!resolved.ok) return resolved;
  return writeSnapshotToDisk(resolved.data.fullPath, snapshot);
}

// Narrows an unknown changelog snapshot to a SourceFileSnapshot (or null for a
// create/delete boundary). Used by applySnapshot, whose snapshot arg is `unknown`.
export function asSourceFileSnapshot(
  snapshot: unknown,
): SourceFileSnapshot | null {
  if (snapshot === null || snapshot === undefined) return null;
  if (typeof snapshot !== "object") return null;
  const obj = snapshot as Record<string, unknown>;
  if (typeof obj.path === "string" && typeof obj.content === "string") {
    return { path: obj.path, content: obj.content };
  }
  return null;
}
