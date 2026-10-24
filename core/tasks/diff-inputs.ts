// @layer core — reading the three sides of a task diff off disk: the fork's
// frozen base (`.opentide/fork-base/`), the fork now, and main now. State and
// schema come from a project's state dir; files are hashed, documents listed.
// The base keeps only hashes, written when the fork is cut.
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
} from "node:fs";
import { join } from "node:path";
import { writeJsonAtomic } from "../atomic-json.ts";
import { readProjectFiles } from "../changeset-snapshots.ts";
import { DOCUMENT_STORAGE_DIRNAME } from "../config.ts";
import { loadProjectStateData } from "../persistence.ts";
import { getProjectPaths } from "../project-manager.ts";
import type { MigrationEntry, Result, SchemaEntry } from "../types.ts";
import type { DiffFile, DiffSide, SchemaState } from "./state-diff.ts";

const SCHEMAS_DIRNAME = "schemas";
const MIGRATIONS_DIRNAME = "migrations";
const FORK_BASE_STATE_DIRNAME = "state";
const FORK_BASE_PROJECT_FILE = "project.json";

interface ForkBaseProject {
  version: 1;
  files: Record<string, { sha256: string }>;
  documents: string[];
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function readJsonDir<T>(dir: string): T[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) => JSON.parse(readFileSync(join(dir, name), "utf-8")) as T);
}

export function readSchemaState(stateDir: string): SchemaState {
  const dir = join(stateDir, SCHEMAS_DIRNAME);
  const tables = Object.fromEntries(
    readJsonDir<SchemaEntry>(dir).map((t) => [t.tableName, t]),
  );
  const migrations: Record<string, MigrationEntry[]> = {};
  for (
    const list of readJsonDir<MigrationEntry[]>(join(dir, MIGRATIONS_DIRNAME))
  ) {
    const table = list[0]?.tableName;
    if (table) migrations[table] = list;
  }
  return { tables, migrations };
}

// Every project file a changeset snapshot would hold, by hash, with the text
// where there is one. Binary and oversized files get a hash and no text.
export function readDiffFiles(projectDir: string): Record<string, DiffFile> {
  const { files, skipped } = readProjectFiles(projectDir);
  const out: Record<string, DiffFile> = {};
  for (const path of [...files.keys(), ...skipped].sort()) {
    out[path] = {
      sha256: sha256(readFileSync(join(projectDir, path))),
      text: files.get(path) ?? null,
    };
  }
  return out;
}

// Project document blobs, as paths relative to the project's documents dir.
export function listDocumentBlobs(projectDir: string): string[] {
  const root = join(
    getProjectPaths(projectDir).artifactsDir,
    DOCUMENT_STORAGE_DIRNAME,
  );
  const out: string[] = [];
  const walk = (rel: string) => {
    for (const name of readdirSync(join(root, rel)).sort()) {
      const child = rel ? `${rel}/${name}` : name;
      if (statSync(join(root, child)).isDirectory()) walk(child);
      else out.push(child);
    }
  };
  if (existsSync(root)) walk("");
  return out;
}

function forkBaseStateDir(forkDir: string): string {
  return join(getProjectPaths(forkDir).forkBaseDir, FORK_BASE_STATE_DIRNAME);
}

// Freezes the fork's files and documents next to its frozen state, so the diff
// can tell what the fork changed. Called once, when the fork is cut.
export function freezeForkBaseProject(forkDir: string): void {
  const files = Object.fromEntries(
    Object.entries(readDiffFiles(forkDir)).map((
      [path, f],
    ) => [path, { sha256: f.sha256 }]),
  );
  const dir = getProjectPaths(forkDir).forkBaseDir;
  mkdirSync(dir, { recursive: true });
  writeJsonAtomic(
    join(dir, FORK_BASE_PROJECT_FILE),
    {
      version: 1,
      files,
      documents: listDocumentBlobs(forkDir),
    } satisfies ForkBaseProject,
  );
}

function readForkBaseProject(forkDir: string): ForkBaseProject | null {
  const path = join(
    getProjectPaths(forkDir).forkBaseDir,
    FORK_BASE_PROJECT_FILE,
  );
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf-8")) as ForkBaseProject;
}

function readState(stateDir: string): Result<DiffSide["state"]> {
  const { data, errors } = loadProjectStateData(stateDir);
  if (!data || errors.length > 0) {
    return {
      ok: false,
      error: {
        code: "TASK_STATE_UNREADABLE",
        message: data ? errors.join(" ") : `No state at ${stateDir}.`,
      },
    };
  }
  return { ok: true, data };
}

export function readBaseSide(forkDir: string): Result<DiffSide> {
  const stateDir = forkBaseStateDir(forkDir);
  const state = readState(stateDir);
  if (!state.ok) return state;
  const project = readForkBaseProject(forkDir);
  return {
    ok: true,
    data: {
      state: state.data,
      schema: readSchemaState(stateDir),
      files: project
        ? Object.fromEntries(
          Object.entries(project.files).map((
            [path, f],
          ) => [path, { sha256: f.sha256, text: null }]),
        )
        : null,
      documents: project?.documents ?? [],
    },
  };
}

// A project as it stands on disk. The caller flushes its state first.
export function readLiveSide(projectDir: string): Result<DiffSide> {
  const stateDir = getProjectPaths(projectDir).stateDir;
  const state = readState(stateDir);
  if (!state.ok) return state;
  return {
    ok: true,
    data: {
      state: state.data,
      schema: readSchemaState(stateDir),
      files: readDiffFiles(projectDir),
      documents: listDocumentBlobs(projectDir),
    },
  };
}
