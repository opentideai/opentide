import {
  adoptLegacyProjectLayout,
  hasProjectManifest,
  PROJECT_MANIFEST_FILE,
  projectManifestPath,
  projectStateDir,
} from "./project-layout.ts";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { APP_PORT_AUTO, getTideDir, PROJECT_GITIGNORE } from "./config.ts";
import { readJsonQuarantine, writeJsonAtomic } from "./atomic-json.ts";
import type { Result } from "./types.ts";
import { SecretsStore } from "./secrets.ts";

// The manifest's `previewPort` sentinel. "auto" means "no fixed pin — the
// effective app-preview port is chosen by the --app-port flag, else an
// OS-assigned free port". A fixed pin is represented as the port number itself;
// 0/auto is ALWAYS the sentinel, never the number 0.
export const PREVIEW_PORT_AUTO = "auto";

// A fixed preview port must be a bindable TCP port. 0 is deliberately excluded —
// it is expressed via PREVIEW_PORT_AUTO, not as the number 0.
const MIN_FIXED_PORT = 1;
const MAX_FIXED_PORT = 65535;

export type PreviewPort = typeof PREVIEW_PORT_AUTO | number;

// How a project's code is modeled. `registry-native` is the original Genie
// model: entities (handlers/functions/…) built into the live kernel. `source-backed`
// (project import) adopts an existing TS/JS project that runs on its native
// runtime with a semantic overlay. Absent ⇒ registry-native — existing projects
// must not break. See readProjectMode / writeProjectMode.
export const PROJECT_MODE_REGISTRY_NATIVE = "registry-native";
export const PROJECT_MODE_SOURCE_BACKED = "source-backed";
export const DEFAULT_PROJECT_MODE = PROJECT_MODE_REGISTRY_NATIVE;

export type ProjectMode =
  | typeof PROJECT_MODE_REGISTRY_NATIVE
  | typeof PROJECT_MODE_SOURCE_BACKED;

// Persisted "how to run this imported project" metadata (project import, Slice 3).
// Only meaningful for a `source-backed` project — it is the resolved dev command +
// optional fixed child port that DevServerManager spawns/proxies. Absent ⇒ the
// dev server auto-detects (dev command from the codebase graph; OS-free child
// port). See readProjectRunConfig / writeProjectRunConfig and the precedence note
// on resolvePreviewPort below (this pins the CHILD port; previewPort pins the
// proxy-facing port the IDE iframe hits).
export interface SourceBackedRunConfig {
  // The resolved dev command string (e.g. "npm run dev"), spawned in `cwd`.
  command: string;
  // Working directory for the child. Absent ⇒ the project root.
  cwd?: string;
  // Fixed child-server port. Absent ⇒ an OS-assigned free port is chosen and the
  // bound port is detected from the child's banner. A fixed port is passed to the
  // child via the PORT env var so detection is deterministic.
  port?: number;
}

export interface ProjectMeta {
  name: string;
  createdAt: string;
  // Absent ⇒ treated as PREVIEW_PORT_AUTO (don't force-write it into existing
  // manifests). See readProjectPreviewPort / writeProjectPreviewPort.
  previewPort?: PreviewPort;
  // Absent ⇒ treated as DEFAULT_PROJECT_MODE (registry-native). See
  // readProjectMode / writeProjectMode.
  mode?: ProjectMode;
  // Absent ⇒ auto-detect at run time. See readProjectRunConfig / writeProjectRunConfig.
  sourceRun?: SourceBackedRunConfig;
  // Present only on a task fork (core/tasks/fork.ts). A fork never enters the
  // project registry.
  fork?: ProjectForkMeta;
}

export interface ProjectForkMeta {
  parentPath: string;
  taskId: string;
  title: string;
  createdAt: string;
}

export interface ProjectEntry {
  path: string;
  name: string;
  createdAt: string;
  lastOpenedAt: string;
}

export interface Registry {
  version: 1;
  projects: ProjectEntry[];
}

function tideDir(): string {
  return getTideDir();
}

function registryPath(): string {
  return join(tideDir(), "registry.json");
}

const PROJECT_FILE = PROJECT_MANIFEST_FILE;
const REGISTRY_CACHE_FILE = "registry-cache.json";
const ASSETS_DIR = "assets";
const TASKS_FILE = "tasks.json";
export function tideProjectGitignore(): string {
  return PROJECT_GITIGNORE;
}

function markdownTitle(name: string): string {
  return name.replace(/\s+/g, " ").trim() || "OpenTide App";
}

function generateStarterReadme(name: string): string {
  const title = markdownTitle(name);
  return `# ${title}

This is an OpenTide project.

## Project Files

- \`opentide.json\` stores the project manifest.
- \`.opentide/\` stores local OpenTide state, history, caches, and backups.
- \`assets/\` stores project assets.
- \`data/\` stores local app and test database rows.

## Source Control

This project is initialized as a git repository. Local secrets, data rows, caches, and backups are ignored by default.

## Docs

Use OpenTide to generate updated \`README.md\` and \`AGENT.md\` files after routes, handlers, schemas, configs, and environment variables are defined.
`;
}

function generateStarterAgentMd(name: string): string {
  const title = markdownTitle(name);
  return `# ${title}

## Project Context

This is an OpenTide project. Treat \`opentide.json\` as the project manifest and \`.opentide/\` as OpenTide-managed local state.

## Working Guidelines

- Keep local secrets in \`.env\`; do not commit them.
- Treat \`data/\` as local runtime data unless the user asks to export seed data.
- Keep generated caches and backups under \`.opentide/caches/\` and \`.opentide/backups/\` out of source control.
- Regenerate this file with OpenTide after the project has routes, handlers, schemas, configs, or custom instructions.
`;
}

function writeFileIfMissing(path: string, content: string): void {
  if (!existsSync(path)) {
    writeFileSync(path, content);
  }
}

function initializeGitRepository(projectDir: string): void {
  if (existsSync(join(projectDir, ".git"))) return;

  const result = spawnSync("git", ["init"], {
    cwd: projectDir,
    stdio: "ignore",
  });

  if (result.error || result.status !== 0) {
    return;
  }
}

function projectHash(projectDir: string): string {
  return createHash("sha256").update(resolve(projectDir)).digest("hex").slice(
    0,
    12,
  );
}

export function getProjectPaths(projectDir: string) {
  const localDir = projectStateDir(projectDir);
  const stateDir = join(localDir, "state");
  const historyDir = join(localDir, "history");
  const artifactsDir = join(historyDir, "artifacts");
  const branchesDir = join(localDir, "branches");
  const cachesDir = join(localDir, "caches");
  const branchSnapshotsDir = join(projectDir, "branch-snapshots");
  return {
    root: projectDir,
    meta: join(projectDir, PROJECT_FILE),
    manifest: join(projectDir, PROJECT_FILE),
    localDir,
    genieDir: projectDir,
    dataDir: join(projectDir, "data"),
    stateDir,
    schemaDir: join(stateDir, "schemas"),
    historyDir,
    artifactsDir,
    screenshotArtifactsDir: join(artifactsDir, "screenshots"),
    assetBlobsDir: join(historyDir, "asset-blobs"),
    branchesDir,
    registryCache: join(projectDir, REGISTRY_CACHE_FILE),
    cacheDir: cachesDir,
    logsCache: join(cachesDir, "logs.json"),
    localState: join(cachesDir, "local-state.json"),
    registryCacheV2: join(cachesDir, REGISTRY_CACHE_FILE),
    assets: join(projectDir, ASSETS_DIR),
    branchSnapshots: branchSnapshotsDir,
    branchSnapshotsDir,
    branchSnapshotsV2: join(branchesDir, "snapshots"),
    backups: join(tideDir(), "backups", projectHash(projectDir)),
    // This project's task records, and where its forks live. Forks sit outside
    // the project so its git never sees them.
    tasksFile: join(localDir, TASKS_FILE),
    taskForksDir: join(tideDir(), "tasks", projectHash(projectDir)),
    // In a fork: main's state at fork time, the merge base.
    forkBaseDir: join(localDir, "fork-base"),
    // Changeset start snapshots, one `<changesetId>.json` each.
    snapshotsDir: join(localDir, "snapshots"),
  };
}

function ensureTideDir(): void {
  const dir = tideDir();
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

// A corrupt or half-written registry (crash mid-write, manual edit) must never
// brick every project operation. Fall back to an empty registry, preserving the
// bad file as `.corrupt` for post-mortem rather than silently discarding it.
// Path-parameterized (exported) so it can be tested without touching the real
// ~/.config/opentide/registry.json. Thin wrapper over the shared atomic-json read
// (unchecked cast, matching its historical behavior — no shape validation).
export function readRegistryFile(path: string): Registry {
  return readJsonQuarantine<Registry>(
    path,
    () => ({ version: 1, projects: [] }),
  );
}

// Atomic write: a crash or a concurrent multi-kernel writer must not leave a
// truncated/interleaved registry (which readRegistryFile would then quarantine).
// Delegates to the shared tmp-file + rename primitive.
export function writeRegistryFileAtomic(
  path: string,
  registry: Registry,
): void {
  writeJsonAtomic(path, registry);
}

function isValidFixedPort(value: unknown): value is number {
  return typeof value === "number" &&
    Number.isInteger(value) &&
    value >= MIN_FIXED_PORT &&
    value <= MAX_FIXED_PORT;
}

// Atomic manifest write: same tmp + rename guarantee as the registry write, via
// the shared atomic-json primitive.
function writeManifestAtomic(
  path: string,
  manifest: Record<string, unknown>,
): void {
  writeJsonAtomic(path, manifest);
}

function readRequiredManifest(projectDir: string): Record<string, unknown> {
  const manifestPath = getProjectPaths(projectDir).manifest;
  if (!existsSync(manifestPath)) {
    throw new Error(`No OpenTide project found at ${projectDir}`);
  }

  try {
    const parsed = JSON.parse(readFileSync(manifestPath, "utf-8"));
    if (
      typeof parsed !== "object" || parsed === null || Array.isArray(parsed)
    ) {
      throw new Error("manifest is not a JSON object");
    }
    return parsed as Record<string, unknown>;
  } catch (err) {
    throw new Error(
      `Corrupt project manifest (${PROJECT_FILE}) at ${projectDir}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}

// Read the project's preview-port preference from the manifest. Absent, missing
// manifest, corrupt JSON, or an out-of-range/ill-typed value all coerce to
// PREVIEW_PORT_AUTO — this never throws (a bad value is a preference we ignore,
// not an error that should brick project load).
export function readProjectPreviewPort(projectDir: string): PreviewPort {
  const manifestPath = getProjectPaths(projectDir).manifest;
  if (!existsSync(manifestPath)) return PREVIEW_PORT_AUTO;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(manifestPath, "utf-8"));
  } catch {
    return PREVIEW_PORT_AUTO;
  }
  if (typeof raw !== "object" || raw === null) return PREVIEW_PORT_AUTO;
  const value = (raw as Record<string, unknown>).previewPort;
  return isValidFixedPort(value) ? value : PREVIEW_PORT_AUTO;
}

// Persist the project's preview-port preference. Read-modify-write that
// round-trips every other manifest key (name/createdAt/unknown/future keys are
// preserved) and writes atomically. A fixed port must be an integer in
// [1, 65535]; anything else is rejected with a semantic Result error and the
// manifest is left untouched. Pass PREVIEW_PORT_AUTO to store "auto".
export function writeProjectPreviewPort(
  projectDir: string,
  value: PreviewPort,
): Result<void> {
  if (value !== PREVIEW_PORT_AUTO && !isValidFixedPort(value)) {
    return {
      ok: false,
      error: {
        code: "INVALID_PREVIEW_PORT",
        message:
          `Preview port must be "${PREVIEW_PORT_AUTO}" or an integer in [${MIN_FIXED_PORT}, ${MAX_FIXED_PORT}], got ${
            JSON.stringify(value)
          }`,
        suggestion:
          `Use "${PREVIEW_PORT_AUTO}" for an OS-assigned free port, or a fixed port between ${MIN_FIXED_PORT} and ${MAX_FIXED_PORT}.`,
      },
    };
  }

  const manifestPath = getProjectPaths(projectDir).manifest;
  if (!existsSync(manifestPath)) {
    return {
      ok: false,
      error: {
        code: "PROJECT_NOT_FOUND",
        message: `No OpenTide project manifest (${PROJECT_FILE}) at ${projectDir}`,
      },
    };
  }

  let manifest: Record<string, unknown>;
  try {
    const parsed = JSON.parse(readFileSync(manifestPath, "utf-8"));
    if (
      typeof parsed !== "object" || parsed === null || Array.isArray(parsed)
    ) {
      throw new Error("manifest is not a JSON object");
    }
    manifest = parsed as Record<string, unknown>;
  } catch (err) {
    return {
      ok: false,
      error: {
        code: "CORRUPT_MANIFEST",
        message:
          `Corrupt project manifest (${PROJECT_FILE}) at ${projectDir}: ${
            err instanceof Error ? err.message : String(err)
          }`,
      },
    };
  }

  manifest.previewPort = value;
  writeManifestAtomic(manifestPath, manifest);
  return { ok: true, data: undefined };
}

// Resolve the effective app-preview port from the persisted preference and the
// --app-port flag, encoding locked decision #1 precedence: a fixed project
// setting wins even over an explicit flag; otherwise the flag; otherwise auto
// (APP_PORT_AUTO = 0, an OS-assigned free port). Pure and unit-testable; the
// collision fallback lives in the app server, not here.
//
// Source-backed port coexistence (Slice 3): `previewPort` always pins the
// PROXY-FACING port — the app-preview listener the IDE iframe hits — for both
// project modes. A source-backed project ALSO runs a child dev server on a
// SEPARATE port (SourceBackedRunConfig.port, else an OS-free port), which the
// preview listener proxies to via appServer.setProxy. The two never share a port:
// previewPort governs the outer listener here; the child's port is resolved
// independently in DevServerManager. So the IDE keeps hitting the same preview URL
// whether the app is registry-native or a proxied source-backed dev server.
export function resolvePreviewPort(
  manifestValue: PreviewPort,
  flagPort: number | undefined,
): number {
  if (manifestValue !== PREVIEW_PORT_AUTO) return manifestValue;
  return flagPort ?? APP_PORT_AUTO;
}

function isValidProjectMode(value: unknown): value is ProjectMode {
  return value === PROJECT_MODE_REGISTRY_NATIVE ||
    value === PROJECT_MODE_SOURCE_BACKED;
}

// Read the project's mode from the manifest. Absent, missing manifest, corrupt
// JSON, or an unrecognized value all coerce to DEFAULT_PROJECT_MODE — this never
// throws (a bad value is a preference we ignore, not a load-breaking error), and
// it keeps existing manifests without a `mode` key working as registry-native.
export function readProjectMode(projectDir: string): ProjectMode {
  const manifestPath = getProjectPaths(projectDir).manifest;
  if (!existsSync(manifestPath)) return DEFAULT_PROJECT_MODE;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(manifestPath, "utf-8"));
  } catch {
    return DEFAULT_PROJECT_MODE;
  }
  if (typeof raw !== "object" || raw === null) return DEFAULT_PROJECT_MODE;
  const value = (raw as Record<string, unknown>).mode;
  return isValidProjectMode(value) ? value : DEFAULT_PROJECT_MODE;
}

// Persist the project's mode. Read-modify-write that round-trips every other
// manifest key (name/createdAt/previewPort/unknown keys are preserved) and writes
// atomically. Rejects an unrecognized mode with a semantic Result error, leaving
// the manifest untouched.
export function writeProjectMode(
  projectDir: string,
  value: ProjectMode,
): Result<void> {
  if (!isValidProjectMode(value)) {
    return {
      ok: false,
      error: {
        code: "INVALID_PROJECT_MODE",
        message:
          `Project mode must be "${PROJECT_MODE_REGISTRY_NATIVE}" or "${PROJECT_MODE_SOURCE_BACKED}", got ${
            JSON.stringify(value)
          }`,
        suggestion:
          `Use "${PROJECT_MODE_REGISTRY_NATIVE}" for a native OpenTide project or "${PROJECT_MODE_SOURCE_BACKED}" for an imported project.`,
      },
    };
  }

  const manifestPath = getProjectPaths(projectDir).manifest;
  if (!existsSync(manifestPath)) {
    return {
      ok: false,
      error: {
        code: "PROJECT_NOT_FOUND",
        message: `No OpenTide project manifest (${PROJECT_FILE}) at ${projectDir}`,
      },
    };
  }

  let manifest: Record<string, unknown>;
  try {
    const parsed = JSON.parse(readFileSync(manifestPath, "utf-8"));
    if (
      typeof parsed !== "object" || parsed === null || Array.isArray(parsed)
    ) {
      throw new Error("manifest is not a JSON object");
    }
    manifest = parsed as Record<string, unknown>;
  } catch (err) {
    return {
      ok: false,
      error: {
        code: "CORRUPT_MANIFEST",
        message:
          `Corrupt project manifest (${PROJECT_FILE}) at ${projectDir}: ${
            err instanceof Error ? err.message : String(err)
          }`,
      },
    };
  }

  manifest.mode = value;
  writeManifestAtomic(manifestPath, manifest);
  return { ok: true, data: undefined };
}

function isValidRunConfig(value: unknown): value is SourceBackedRunConfig {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  if (typeof v.command !== "string" || v.command.trim() === "") return false;
  if (v.cwd !== undefined && typeof v.cwd !== "string") return false;
  if (v.port !== undefined && !isValidFixedPort(v.port)) return false;
  return true;
}

// Read the persisted source-backed run config from the manifest. Absent, missing
// manifest, corrupt JSON, or an ill-typed value all coerce to null (auto-detect) —
// this never throws, matching readProjectMode / readProjectPreviewPort.
export function readProjectRunConfig(
  projectDir: string,
): SourceBackedRunConfig | null {
  const manifestPath = getProjectPaths(projectDir).manifest;
  if (!existsSync(manifestPath)) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(manifestPath, "utf-8"));
  } catch {
    return null;
  }
  if (typeof raw !== "object" || raw === null) return null;
  const value = (raw as Record<string, unknown>).sourceRun;
  if (!isValidRunConfig(value)) return null;
  return {
    command: value.command,
    ...(value.cwd !== undefined ? { cwd: value.cwd } : {}),
    ...(value.port !== undefined ? { port: value.port } : {}),
  };
}

// Persist the source-backed run config. Read-modify-write that round-trips every
// other manifest key (name/createdAt/previewPort/mode/unknown keys preserved) and
// writes atomically. Rejects an invalid config (empty command, bad port) with a
// semantic Result error, leaving the manifest untouched.
export function writeProjectRunConfig(
  projectDir: string,
  value: SourceBackedRunConfig,
): Result<void> {
  if (!isValidRunConfig(value)) {
    return {
      ok: false,
      error: {
        code: "INVALID_RUN_CONFIG",
        message: `Invalid source-backed run config: ${JSON.stringify(value)}`,
        suggestion:
          `Provide a non-empty command; an optional cwd string; and an optional port integer in [${MIN_FIXED_PORT}, ${MAX_FIXED_PORT}].`,
      },
    };
  }

  const manifestPath = getProjectPaths(projectDir).manifest;
  if (!existsSync(manifestPath)) {
    return {
      ok: false,
      error: {
        code: "PROJECT_NOT_FOUND",
        message: `No OpenTide project manifest (${PROJECT_FILE}) at ${projectDir}`,
      },
    };
  }

  let manifest: Record<string, unknown>;
  try {
    const parsed = JSON.parse(readFileSync(manifestPath, "utf-8"));
    if (
      typeof parsed !== "object" || parsed === null || Array.isArray(parsed)
    ) {
      throw new Error("manifest is not a JSON object");
    }
    manifest = parsed as Record<string, unknown>;
  } catch (err) {
    return {
      ok: false,
      error: {
        code: "CORRUPT_MANIFEST",
        message:
          `Corrupt project manifest (${PROJECT_FILE}) at ${projectDir}: ${
            err instanceof Error ? err.message : String(err)
          }`,
      },
    };
  }

  manifest.sourceRun = {
    command: value.command,
    ...(value.cwd !== undefined ? { cwd: value.cwd } : {}),
    ...(value.port !== undefined ? { port: value.port } : {}),
  };
  writeManifestAtomic(manifestPath, manifest);
  return { ok: true, data: undefined };
}

function readRegistry(): Registry {
  ensureTideDir();
  return readRegistryFile(registryPath());
}

function writeRegistry(registry: Registry): void {
  ensureTideDir();
  writeRegistryFileAtomic(registryPath(), registry);
}

// Longest slug we will derive from a project name (F-01: names were uncapped).
const SLUG_MAX_LEN = 60;

// Fold a display name to a filesystem-safe slug. NFKD-decompose so accented
// Latin survives (Ünïcödé → unicode) instead of being dropped, lowercase, and
// collapse anything left to hyphens, capped in length. May return "" for a
// name with no ASCII-representable characters (e.g. pure CJK) — callers that
// touch the filesystem MUST guard that via fallbackSlug (F-02).
function slugify(name: string): string {
  const base = name
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  return base.slice(0, SLUG_MAX_LEN).replace(/-+$/, "");
}

// Deterministic non-empty slug for names that slugify to "" (F-02): a fully
// non-ASCII name would otherwise resolve to the parent directory itself. Hash
// the original name so two distinct such names don't collide.
function fallbackSlug(name: string): string {
  const hash = createHash("sha256").update(name).digest("hex").slice(0, 8);
  return `project-${hash}`;
}

// A filesystem-safe, always-non-empty slug for a project name. The single
// source of truth for turning a freeform name into a path segment — used both
// for the scaffold directory and for derived filenames (e.g. the export
// tarball, F-10), so a name like "../x" can never escape a target directory.
export function projectSlug(name: string): string {
  return slugify(name) || fallbackSlug(name);
}

export function createProject(dirPath: string, name: string): ProjectEntry {
  const slug = projectSlug(name);
  const absPath = resolve(dirPath, slug);

  if (hasProjectManifest(absPath)) {
    throw new Error(`An OpenTide project already exists at ${absPath}`);
  }

  mkdirSync(absPath, { recursive: true });
  mkdirSync(join(absPath, ASSETS_DIR), { recursive: true });
  mkdirSync(projectStateDir(absPath), { recursive: true });

  const now = new Date().toISOString();
  const meta: ProjectMeta = {
    name,
    createdAt: now,
    mode: DEFAULT_PROJECT_MODE,
  };
  writeFileSync(join(absPath, PROJECT_FILE), JSON.stringify(meta, null, 2));
  writeFileIfMissing(join(absPath, ".gitignore"), PROJECT_GITIGNORE);
  writeFileIfMissing(join(absPath, "README.md"), generateStarterReadme(name));
  writeFileIfMissing(join(absPath, "AGENT.md"), generateStarterAgentMd(name));
  initializeGitRepository(absPath);

  const entry: ProjectEntry = {
    path: absPath,
    name,
    createdAt: now,
    lastOpenedAt: now,
  };

  const registry = readRegistry();
  registry.projects = registry.projects.filter((p) => p.path !== absPath);
  registry.projects.unshift(entry);
  writeRegistry(registry);

  return entry;
}

// Adopt an EXISTING code directory as a source-backed project (project import).
// Unlike createProject, this points Genie at `dirPath` itself (no name-slug subdir)
// and adds the `.opentide/` manifest in place with mode source-backed — the on-ramp
// for "adopt-to-run". The user's own files (README, .gitignore, git repo) are left
// untouched; only Genie scaffolding that's missing is added. Re-importing a dir that
// is already a Genie project just flips it to source-backed (preserving other keys).
export function importProject(dirPath: string, name?: string): ProjectEntry {
  const absPath = resolve(dirPath);
  if (!existsSync(absPath) || !statSync(absPath).isDirectory()) {
    throw new Error(`Not a directory: ${absPath}`);
  }

  const projectName = name?.trim() || basename(absPath);
  const now = new Date().toISOString();
  const manifestPath = projectManifestPath(absPath);

  mkdirSync(join(absPath, ASSETS_DIR), { recursive: true });
  mkdirSync(projectStateDir(absPath), { recursive: true });

  if (existsSync(manifestPath)) {
    // Already a Genie project — adopt it as source-backed, preserving other keys.
    const flipped = writeProjectMode(absPath, PROJECT_MODE_SOURCE_BACKED);
    if (!flipped.ok) throw new Error(flipped.error.message);
  } else {
    const meta: ProjectMeta = {
      name: projectName,
      createdAt: now,
      mode: PROJECT_MODE_SOURCE_BACKED,
    };
    writeFileSync(manifestPath, JSON.stringify(meta, null, 2));
    // Only add a .gitignore if the imported project doesn't already have one.
    writeFileIfMissing(join(absPath, ".gitignore"), PROJECT_GITIGNORE);
  }
  // Don't touch an existing git repo — only init one if the project isn't versioned.
  if (!existsSync(join(absPath, ".git"))) initializeGitRepository(absPath);

  const entry: ProjectEntry = {
    path: absPath,
    name: projectName,
    createdAt: now,
    lastOpenedAt: now,
  };

  const registry = readRegistry();
  registry.projects = registry.projects.filter((p) => p.path !== absPath);
  registry.projects.unshift(entry);
  writeRegistry(registry);

  return entry;
}

function projectNameFromManifest(
  manifest: Record<string, unknown>,
  projectDir: string,
): string {
  const name = manifest.name;
  return typeof name === "string" && name.trim() !== ""
    ? name.trim()
    : basename(projectDir);
}

function registryEntryForPath(registry: Registry, projectPath: string) {
  return registry.projects.find((p) => p.path === projectPath);
}

function moveExternalProjectResources(oldPath: string, newPath: string): void {
  SecretsStore.moveProjectSecrets(oldPath, newPath);

  const oldBackups = getProjectPaths(oldPath).backups;
  if (!existsSync(oldBackups)) return;

  const newBackups = getProjectPaths(newPath).backups;
  if (existsSync(newBackups)) {
    throw new Error(
      `Backup directory already exists for project path: ${newPath}`,
    );
  }
  mkdirSync(dirname(newBackups), { recursive: true });
  renameSync(oldBackups, newBackups);
}

function rollbackExternalProjectResources(
  oldPath: string,
  newPath: string,
): void {
  if (
    SecretsStore.hasProjectSecrets(newPath) &&
    !SecretsStore.hasProjectSecrets(oldPath)
  ) {
    SecretsStore.moveProjectSecrets(newPath, oldPath);
  }

  const oldBackups = getProjectPaths(oldPath).backups;
  const newBackups = getProjectPaths(newPath).backups;
  if (existsSync(newBackups) && !existsSync(oldBackups)) {
    mkdirSync(dirname(oldBackups), { recursive: true });
    renameSync(newBackups, oldBackups);
  }
}

function assertCanMoveExternalProjectResources(
  oldPath: string,
  newPath: string,
): void {
  if (
    SecretsStore.hasProjectSecrets(oldPath) &&
    SecretsStore.hasProjectSecrets(newPath)
  ) {
    throw new Error(`Secrets already exist for project path: ${newPath}`);
  }

  const oldBackups = getProjectPaths(oldPath).backups;
  const newBackups = getProjectPaths(newPath).backups;
  if (existsSync(oldBackups) && existsSync(newBackups)) {
    throw new Error(
      `Backup directory already exists for project path: ${newPath}`,
    );
  }
}

function validateProjectFolderName(folderName: string): string {
  const trimmed = folderName.trim();
  if (trimmed === "") {
    throw new Error("Project folder name must not be empty");
  }
  if (trimmed === "." || trimmed === "..") {
    throw new Error(`Invalid project folder name: ${folderName}`);
  }
  if (
    trimmed.includes("/") || trimmed.includes("\\") || trimmed.includes("\0")
  ) {
    throw new Error(
      `Project folder name must be a single folder segment: ${folderName}`,
    );
  }
  return trimmed;
}

export function duplicateProject(dirPath: string): ProjectEntry {
  const absPath = resolve(dirPath);
  if (!existsSync(absPath) || !statSync(absPath).isDirectory()) {
    throw new Error(`Not a directory: ${absPath}`);
  }

  const sourceManifest = readRequiredManifest(absPath);
  const sourceName = projectNameFromManifest(sourceManifest, absPath);
  const parentDir = dirname(absPath);

  let copyName = "";
  let destPath = "";
  let foundDestination = false;
  for (let copyNumber = 1; copyNumber < Number.MAX_SAFE_INTEGER; copyNumber++) {
    copyName = `${sourceName} Copy ${copyNumber}`;
    destPath = resolve(parentDir, projectSlug(copyName));
    if (!existsSync(destPath)) {
      foundDestination = true;
      break;
    }
  }
  if (!foundDestination) {
    throw new Error(
      `Could not generate a destination for duplicate project: ${absPath}`,
    );
  }

  cpSync(absPath, destPath, {
    recursive: true,
    errorOnExist: true,
    force: false,
  });

  try {
    const now = new Date().toISOString();
    const copiedManifest = readRequiredManifest(destPath);
    copiedManifest.name = copyName;
    copiedManifest.createdAt = now;
    writeManifestAtomic(getProjectPaths(destPath).manifest, copiedManifest);

    const entry: ProjectEntry = {
      path: destPath,
      name: copyName,
      createdAt: now,
      lastOpenedAt: now,
    };

    const registry = readRegistry();
    registry.projects = registry.projects.filter((p) => p.path !== destPath);
    registry.projects.unshift(entry);
    writeRegistry(registry);

    return entry;
  } catch (err) {
    try {
      rmSync(destPath, { recursive: true, force: true });
    } catch {
      // Preserve the original duplicate failure; cleanup is best-effort.
    }
    throw err;
  }
}

export function renameProject(
  dirPath: string,
  options: { name: string; folderName: string },
): ProjectEntry {
  const absPath = resolve(dirPath);
  if (!existsSync(absPath) || !statSync(absPath).isDirectory()) {
    throw new Error(`Not a directory: ${absPath}`);
  }

  const manifest = readRequiredManifest(absPath);
  const name = options.name.trim();
  if (name === "") {
    throw new Error("Project name must not be empty");
  }

  const folderName = validateProjectFolderName(options.folderName);
  const parentDir = dirname(absPath);
  const newPath = resolve(parentDir, folderName);
  const pathChanged = newPath !== absPath;
  if (dirname(newPath) !== parentDir) {
    throw new Error(`Project folder must stay within ${parentDir}`);
  }
  if (pathChanged && existsSync(newPath)) {
    throw new Error(`Destination already exists: ${newPath}`);
  }
  if (pathChanged) {
    assertCanMoveExternalProjectResources(absPath, newPath);
  }

  const registry = readRegistry();
  const existingEntry = registryEntryForPath(registry, absPath);
  const now = new Date().toISOString();
  const createdAt = typeof manifest.createdAt === "string"
    ? manifest.createdAt
    : existingEntry?.createdAt ?? now;
  const lastOpenedAt = existingEntry?.lastOpenedAt ?? now;
  const originalManifestText = readFileSync(
    getProjectPaths(absPath).manifest,
    "utf-8",
  );
  const updatedManifest = { ...manifest, name };

  const entry: ProjectEntry = {
    path: newPath,
    name,
    createdAt,
    lastOpenedAt,
  };

  const oldIndex = registry.projects.findIndex((p) => p.path === absPath);
  const nextProjects = registry.projects.filter((p) =>
    p.path !== absPath && p.path !== newPath
  );
  if (oldIndex >= 0) {
    nextProjects.splice(Math.min(oldIndex, nextProjects.length), 0, entry);
  } else {
    nextProjects.unshift(entry);
  }
  registry.projects = nextProjects;

  if (pathChanged) {
    renameSync(absPath, newPath);
  }

  try {
    writeManifestAtomic(getProjectPaths(newPath).manifest, updatedManifest);
    if (pathChanged) {
      moveExternalProjectResources(absPath, newPath);
    }
    writeRegistry(registry);
  } catch (err) {
    if (pathChanged) {
      try {
        rollbackExternalProjectResources(absPath, newPath);
      } catch {
        // Keep surfacing the original operation failure; rollback is best-effort.
      }
      try {
        if (existsSync(newPath) && !existsSync(absPath)) {
          renameSync(newPath, absPath);
        }
      } catch {
        // Keep surfacing the original operation failure; rollback is best-effort.
      }
    }
    try {
      if (existsSync(getProjectPaths(absPath).manifest)) {
        writeFileSync(getProjectPaths(absPath).manifest, originalManifestText);
      }
    } catch {
      // Keep surfacing the original operation failure; rollback is best-effort.
    }
    throw err;
  }

  return entry;
}

// Turns a freshly copied project into a fork: it gets no pinned preview port
// (it would collide with main's) and names its parent.
export function markProjectAsFork(
  forkDir: string,
  fork: ProjectForkMeta,
): void {
  const { previewPort: _pinned, ...manifest } = readRequiredManifest(forkDir);
  writeManifestAtomic(getProjectPaths(forkDir).manifest, {
    ...manifest,
    fork,
  });
}

// The fork's parent and task, or null for a project that isn't a fork.
export function readProjectFork(projectDir: string): ProjectForkMeta | null {
  try {
    const fork = readRequiredManifest(projectDir).fork;
    return typeof fork === "object" && fork !== null
      ? fork as ProjectForkMeta
      : null;
  } catch {
    return null;
  }
}

export function openProject(dirPath: string): ProjectEntry {
  const absPath = resolve(dirPath);
  adoptLegacyProjectLayout(absPath);
  const metaPath = projectManifestPath(absPath);

  if (!existsSync(metaPath)) {
    throw new Error(`No OpenTide project found at ${absPath}`);
  }

  let meta: ProjectMeta;
  try {
    meta = JSON.parse(readFileSync(metaPath, "utf-8")) as ProjectMeta;
  } catch {
    throw new Error(
      `Corrupt project manifest (${PROJECT_FILE}) at ${absPath}`,
    );
  }
  const now = new Date().toISOString();

  const entry: ProjectEntry = {
    path: absPath,
    name: meta.name,
    createdAt: meta.createdAt,
    lastOpenedAt: now,
  };
  if (meta.fork) return entry;

  const registry = readRegistry();
  registry.projects = registry.projects.filter((p) => p.path !== absPath);
  registry.projects.unshift(entry);
  writeRegistry(registry);

  return entry;
}

export function listProjects(): ProjectEntry[] {
  const registry = readRegistry();
  return registry.projects.filter((p) => hasProjectManifest(p.path));
}

export function removeProject(dirPath: string, deleteFiles = false): boolean {
  const absPath = resolve(dirPath);
  const registry = readRegistry();
  const before = registry.projects.length;
  registry.projects = registry.projects.filter((p) => p.path !== absPath);
  if (registry.projects.length < before) {
    writeRegistry(registry);
    if (deleteFiles && existsSync(absPath)) {
      rmSync(absPath, { recursive: true, force: true });
    }
    return true;
  }
  return false;
}

export function isProject(dirPath: string): boolean {
  return hasProjectManifest(resolve(dirPath));
}
