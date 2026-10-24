// @layer core - project-scoped safe text file authoring.
//
// This is the narrow filesystem authoring surface for agent-created project notes,
// plans, and small text artifacts. It is intentionally project-root confined,
// extension allowlisted, and two-step: preview is read-only; apply requires the
// preview fingerprint so concurrent edits are not clobbered.

import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import {
  dirname,
  extname,
  isAbsolute,
  normalize,
  relative,
  resolve,
  sep,
} from "node:path";
import { resolveProjectFilePath } from "./control-helpers.ts";
import {
  MAX_FILE_CONTENT_BYTES,
  PROJECT_FILE_IGNORED_DIRS,
  PROJECT_FILE_IGNORED_FILES,
} from "./config.ts";
import {
  fingerprintContent,
  type SourceEditAction,
  type SourceFileSnapshot,
} from "./codebase/source-edit.ts";
import type { Result } from "./types.ts";

export interface ProjectTextFileRequest {
  path: string;
  content?: string;
  delete?: boolean;
  baseFingerprint?: string | null;
}

export interface StagedProjectTextFile {
  key: string;
  action: SourceEditAction;
  before: SourceFileSnapshot | null;
  after: SourceFileSnapshot | null;
  baseFingerprint: string | null;
}

export interface ProjectTextFileCommit {
  key: string;
  action: SourceEditAction;
  before: SourceFileSnapshot | null;
  after: SourceFileSnapshot | null;
}

const ALLOWED_EXTENSIONS = new Set([
  ".md",
  ".txt",
  ".json",
  ".jsonc",
  ".yaml",
  ".yml",
  ".csv",
  ".tsv",
  ".html",
  ".css",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".ts",
  ".tsx",
]);

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

function byteLength(content: string): number {
  return new TextEncoder().encode(content).length;
}

function looksBinary(raw: Uint8Array): boolean {
  const scan = Math.min(raw.length, 8000);
  for (let i = 0; i < scan; i++) {
    if (raw[i] === 0) return true;
  }
  return false;
}

interface ResolvedProjectTextPath {
  fullPath: string;
  key: string;
}

function resolveProjectTextPath(
  root: string,
  rawPath: string,
): Result<ResolvedProjectTextPath> {
  let decodedPath: string;
  try {
    decodedPath = decodeURIComponent(rawPath);
  } catch {
    return fail(
      "INVALID_PATH",
      `Path "${rawPath}" is outside the project root or malformed.`,
      "Use a project-root-relative path with no '..' or absolute segments.",
    );
  }
  if (
    decodedPath.trim() === "" || isAbsolute(decodedPath) ||
    decodedPath.split(/[\\/]+/).includes("..")
  ) {
    return fail(
      "INVALID_PATH",
      `Path "${rawPath}" must be project-root-relative.`,
      "Use a project-root-relative path with no '..' or absolute segments.",
    );
  }

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
  const fileName = segments.at(-1) ?? "";
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
  if (!ALLOWED_EXTENSIONS.has(extname(fileName).toLowerCase())) {
    return fail(
      "UNSUPPORTED_FILE_TYPE",
      `File "${key}" is not an allowed project text file type.`,
      "Use one of: .md, .txt, .json, .yaml, .yml, .csv, .tsv, .html, .css, .js, .ts.",
    );
  }
  if (symlinkEscapes(normalizedRoot, resolved.fullPath)) {
    return fail(
      "INVALID_PATH",
      `Path "${key}" resolves outside the project root via a symlink.`,
    );
  }
  return { ok: true, data: { fullPath: resolved.fullPath, key } };
}

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
      "File appears to be binary and cannot be edited as text.",
    );
  }

  const content = new TextDecoder().decode(raw);
  return {
    ok: true,
    data: { content, fingerprint: fingerprintContent(content) },
  };
}

function materializeAfter(
  current: string | null,
  req: ProjectTextFileRequest,
): Result<string | null> {
  const modes = [req.content !== undefined, req.delete === true].filter(Boolean)
    .length;
  if (modes === 0) {
    return fail(
      "EMPTY_EDIT",
      "An edit must set exactly one of `content` or `delete`.",
    );
  }
  if (modes > 1) {
    return fail(
      "AMBIGUOUS_EDIT",
      "An edit must set exactly one of `content` or `delete` - not both.",
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
  if (req.content?.includes("\0")) {
    return fail("BINARY_FILE", "Text file content cannot contain NUL bytes.");
  }
  return { ok: true, data: req.content ?? "" };
}

function stageInternal(
  root: string,
  req: ProjectTextFileRequest,
): Result<StagedProjectTextFile & { fullPath: string }> {
  const resolved = resolveProjectTextPath(root, req.path);
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

export function stageProjectTextFile(
  root: string,
  req: ProjectTextFileRequest,
): Result<StagedProjectTextFile> {
  const staged = stageInternal(root, req);
  if (!staged.ok) return staged;
  const { fullPath: _fullPath, ...view } = staged.data;
  return { ok: true, data: view };
}

export function commitProjectTextFile(
  root: string,
  req: ProjectTextFileRequest,
): Result<ProjectTextFileCommit> {
  if (!("baseFingerprint" in req)) {
    return fail(
      "BASE_FINGERPRINT_REQUIRED",
      "`baseFingerprint` from preview_project_file is required to apply a project file edit.",
      "Call preview_project_file first, then echo its baseFingerprint in apply_project_file.",
    );
  }

  const staged = stageInternal(root, req);
  if (!staged.ok) return staged;
  const s = staged.data;

  if (req.baseFingerprint !== s.baseFingerprint) {
    return fail(
      "PATCH_CONFLICT",
      "The file changed on disk since it was previewed.",
      "Preview the current file again, then apply the updated fingerprint.",
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
