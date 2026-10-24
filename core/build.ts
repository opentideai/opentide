import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve, sep } from "node:path";
import {
  APP_RUNTIME_PERMISSIONS,
  binaryRuntimeIncludePaths,
  type ExportFile,
  exportProject,
  type ExportProjectOptions,
} from "./export.ts";
import type { Kernel } from "./registries.ts";
import { createTimestampedShortId } from "./ids.ts";
import {
  docsToMarkdownFiles,
  docsToStaticSiteFiles,
  generateAppDocs,
} from "./app-docs.ts";
import {
  type AppPackageEmission,
  assertRuntimeDependencyPins,
  NODE_RUNTIME_HONO_VERSION,
  NODE_RUNTIME_NODE_SERVER_VERSION,
  NODE_RUNTIME_PGLITE_VERSION,
  planAppPackageEmission,
} from "./runtime-dependencies.ts";
import {
  denoToolchainFailure,
  resolveDenoToolchain,
} from "./deno-toolchain.ts";
import * as esbuild from "esbuild";

// --- Version Management ---

interface VersionFile {
  version: string;
}

const VERSION_FILE = "version.json";
const DEFAULT_VERSION = "0.1.0";

// How long `deno check` on an exported app may run before it is abandoned.
// Generous — a cold check resolves and type-checks the whole module graph — but
// bounded, matching BINARY_COMPILE_TIMEOUT_MS in verification/production-build.ts.
// An unbounded wait here used to hang the HTTP request behind it indefinitely.
const EXPORT_TYPE_CHECK_TIMEOUT_MS = 180_000;

export function getVersion(projectDir: string): string {
  const path = join(projectDir, VERSION_FILE);
  if (!existsSync(path)) return DEFAULT_VERSION;
  try {
    const data: VersionFile = JSON.parse(readFileSync(path, "utf-8"));
    return data.version;
  } catch {
    return DEFAULT_VERSION;
  }
}

export function setVersion(projectDir: string, version: string): string {
  const path = join(projectDir, VERSION_FILE);
  writeFileSync(
    path,
    JSON.stringify({ version } satisfies VersionFile, null, 2) + "\n",
  );
  return version;
}

export function bumpVersion(
  projectDir: string,
  bump: "patch" | "minor" | "major",
): string {
  const current = getVersion(projectDir);
  const parts = current.split(".").map(Number);
  if (parts.length !== 3 || parts.some(isNaN)) {
    return setVersion(projectDir, DEFAULT_VERSION);
  }
  const [major, minor, patch] = parts as [number, number, number];
  let next: string;
  if (bump === "major") next = `${major + 1}.0.0`;
  else if (bump === "minor") next = `${major}.${minor + 1}.0`;
  else next = `${major}.${minor}.${patch + 1}`;
  return setVersion(projectDir, next);
}

// --- Build Results ---

export interface BuildResult {
  path: string;
  fileCount: number;
  version: string;
}

export interface ExportTypeCheckResult {
  ok: boolean;
  output: string;
  fileCount: number;
  issues: ExportTypeCheckIssue[];
}

export interface ExportTypeCheckIssue {
  severity: "error" | "warning" | "info" | "hint";
  code: string;
  message: string;
  file: string;
  line: number;
  column: number;
  snippet?: string;
}

const DOCS_MANIFEST = "docs/.genie-docs-manifest.json";

export interface BuildOptions extends
  Pick<
    ExportProjectOptions,
    | "includeEnvFile"
    | "includeSeedData"
    | "includeMigrations"
    | "includeReferenceSeeds"
    | "includeReadme"
    | "includeAgent"
    | "includeGitignore"
    | "includeDocsMarkdown"
    | "includeDocsSite"
    | "includeManifest"
  > {
  // Internal build-layer knobs: when true, source the committed lockfile from the
  // project and thread its bytes into the export. Request parsers do not accept raw
  // lock bytes from clients.
  includeDenoLock?: boolean;
  includePackageLock?: boolean;
}

// Conservative include-defaults for a headless build/export: ship the
// source-control-friendly supporting files, but keep resolved .env values and
// captured local database rows off.
// Mirrors the IDE's build/export form
// (control-server buildOptionsFromBody). Colocated with BuildOptions so headless
// callers (the `opentide build`/`export` CLI) share one source rather than
// re-declaring the default set.
export const DEFAULT_BUILD_OPTIONS: BuildOptions = {
  includeEnvFile: false,
  includeSeedData: false,
  includeMigrations: true,
  includeReferenceSeeds: true,
  includeReadme: true,
  includeAgent: true,
  includeGitignore: true,
  includeDocsMarkdown: true,
  includeDocsSite: true,
  includeManifest: false,
  includeDenoLock: false,
  includePackageLock: false,
};

export const BINARY_COMPILE_TARGETS = [
  {
    id: "x86_64-unknown-linux-gnu",
    label: "Linux x64",
    description: "Intel and AMD 64-bit Linux servers",
  },
  {
    id: "aarch64-unknown-linux-gnu",
    label: "Linux ARM64",
    description: "ARM64 Linux servers and devices",
  },
  {
    id: "x86_64-pc-windows-msvc",
    label: "Windows x64",
    description: "64-bit Windows executable",
    extension: ".exe",
  },
  {
    id: "x86_64-apple-darwin",
    label: "macOS Intel",
    description: "Intel-based Macs",
  },
  {
    id: "aarch64-apple-darwin",
    label: "macOS Apple Silicon",
    description: "M-series Macs",
  },
] as const;

export type BinaryCompileTarget = typeof BINARY_COMPILE_TARGETS[number]["id"];

export function isBinaryCompileTarget(
  value: unknown,
): value is BinaryCompileTarget {
  return typeof value === "string" &&
    BINARY_COMPILE_TARGETS.some((target) => target.id === value);
}

export function defaultBinaryCompileTarget(): BinaryCompileTarget {
  const { os, arch } = Deno.build;
  if (os === "darwin" && arch === "aarch64") return "aarch64-apple-darwin";
  if (os === "darwin" && arch === "x86_64") return "x86_64-apple-darwin";
  if (os === "windows") return "x86_64-pc-windows-msvc";
  if (arch === "aarch64") return "aarch64-unknown-linux-gnu";
  return "x86_64-unknown-linux-gnu";
}

const DENO_LOCK_PATH = "deno.lock";

type BuildExportOptions =
  & BuildOptions
  & Pick<ExportProjectOptions, "denoLock" | "packageLock">;

function readOptionalTextFile(path: string): string | undefined {
  return existsSync(path) ? readFileSync(path, "utf-8") : undefined;
}

function exportOptionsForBuild(
  projectDir: string | null,
  opts?: BuildExportOptions,
  base: Pick<ExportProjectOptions, "projectName" | "projectVersion"> = {},
): ExportProjectOptions {
  const exportOpts: ExportProjectOptions = { ...opts, ...base };
  if (
    projectDir !== null && opts?.includeDenoLock === true &&
    exportOpts.denoLock === undefined
  ) {
    exportOpts.denoLock = readOptionalTextFile(
      join(projectDir, DENO_LOCK_PATH),
    );
  }
  if (
    projectDir !== null && opts?.includePackageLock === true &&
    exportOpts.packageLock === undefined
  ) {
    exportOpts.packageLock = readOptionalTextFile(
      join(projectDir, PACKAGE_LOCK_PATH),
    );
  }
  return exportOpts;
}

// --- Target 1: Deno Project to dist/ ---

export async function buildDenoProject(
  kernel: Kernel,
  projectDir: string,
  version: string,
  opts?: BuildOptions,
): Promise<BuildResult> {
  const { files } = await exportProject(
    kernel,
    exportOptionsForBuild(projectDir, opts, { projectVersion: version }),
  );
  const outDir = join(projectDir, "dist", `v${version}`);
  writeExportFiles(outDir, files);
  return { path: outDir, fileCount: files.length, version };
}

// --- Target 2: Docker ---

export async function buildDocker(
  kernel: Kernel,
  projectDir: string,
  version: string,
  includeCompose: boolean,
  opts?: BuildOptions,
): Promise<BuildResult> {
  const { files } = await exportProject(
    kernel,
    exportOptionsForBuild(projectDir, opts, { projectVersion: version }),
  );
  const outDir = join(projectDir, "dist", `v${version}`);
  const dockerFiles = buildDockerFiles(files, version, includeCompose);

  writeExportFiles(outDir, dockerFiles);
  return { path: outDir, fileCount: dockerFiles.length, version };
}

export async function buildDockerZip(
  kernel: Kernel,
  projectName: string,
  version: string,
  includeCompose: boolean,
  opts?: BuildOptions,
  projectDir: string | null = null,
): Promise<Uint8Array> {
  const { files } = await exportProject(
    kernel,
    exportOptionsForBuild(projectDir, opts, {
      projectName,
      projectVersion: version,
    }),
  );
  const dockerFiles = buildDockerFiles(files, version, includeCompose);
  const prefix = `${projectName}-v${version}-docker/`;
  return createZip(dockerFiles, prefix);
}

function buildDockerFiles(
  files: ExportFile[],
  version: string,
  includeCompose: boolean,
): ExportFile[] {
  const dockerFiles: ExportFile[] = [
    ...files,
    { path: "Dockerfile", content: generateDockerfile() },
    { path: ".dockerignore", content: generateDockerIgnore() },
  ];
  if (includeCompose) {
    dockerFiles.push({
      path: "docker-compose.yml",
      content: generateDockerCompose(version),
    });
  }
  return dockerFiles;
}

function generateDockerfile(): string {
  return `FROM denoland/deno:latest

WORKDIR /app
ENV HOST=0.0.0.0

COPY deno.json .
COPY deps.ts .
RUN deno cache deps.ts

COPY . .

EXPOSE 3001

CMD ["deno", "task", "start"]
`;
}

function generateDockerIgnore(): string {
  return `data/
*.log
.git
.env.local
`;
}

function generateDockerCompose(version: string): string {
  return `services:
  app:
    build: .
    image: genie-app:${version}
    ports:
      - "3001:3001"
    volumes:
      - app-data:/app/data
    restart: unless-stopped

volumes:
  app-data:
`;
}

// --- Target 3: Zip Archive ---

export async function buildZip(
  kernel: Kernel,
  projectName: string,
  version: string,
  opts?: BuildOptions,
  projectDir: string | null = null,
): Promise<Uint8Array> {
  const { files } = await exportProject(
    kernel,
    exportOptionsForBuild(projectDir, opts, {
      projectName,
      projectVersion: version,
    }),
  );
  const prefix = `${projectName}-v${version}/`;
  return createZip(files, prefix);
}

// --- Target 4: Node.js ---

// buildNodeFiles' options: the build include-toggles plus the committed lock bytes
// the Node artifact carries — packageLock is what Slice 6.3 reads back (out of the
// exported `files`) to pin user deps, and denoLock rides through as a passed-through
// file like it does today. Both are optional; a generated app supplies neither.
export type BuildNodeOptions =
  & BuildOptions
  & Pick<ExportProjectOptions, "denoLock" | "packageLock">;

// Export the project and transpile every .ts to .js (rewriting .ts import
// specifiers and swapping deno.json → package.json). Shared by the directory
// and zip Node builders, which differ only in the output sink. Exported so the
// production Node-smoke gate (verification/production-build.ts) can materialize
// the Node artifact into its own tmp dir rather than the fixed dist/ path that
// buildNodeProject writes — same producer, no behavior change.
export async function buildNodeFiles(
  kernel: Kernel,
  projectName: string,
  version: string,
  opts?: BuildNodeOptions,
  projectDir: string | null = null,
): Promise<ExportFile[]> {
  const { files } = await exportProject(
    kernel,
    exportOptionsForBuild(projectDir, opts, {
      projectName,
      projectVersion: version,
    }),
  );
  const nodeFiles: ExportFile[] = [];

  // Derive each user package's exact pin from the committed package-lock.json when
  // one rode along in the export (Slice 6.3). Reading it from `files` — not the
  // filesystem — keeps buildNodeFiles a pure function of (specifiers + lock bytes):
  // identical inputs → byte-identical package.json. Absent lock → empty map → every
  // extraDep falls to its reshaped specifier value.
  const lockContent = files.find((f) => f.path === PACKAGE_LOCK_PATH)?.content;
  const lockVersions = parseNodeLockVersions(lockContent);

  const packageImports: Record<string, string> = {};
  const sortedPackages = [...(kernel.runtime.listPackages?.(kernel) ?? [])]
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  // Same emission plan the Deno export computed (core/export.ts), recomputed from the
  // same sorted names so the alias a package is imported under in the shared deps.ts
  // is the key package.json declares it under. A name that collides with one of the
  // shell's own deps gets an alias; everything else is untouched.
  const packageEmissions = planAppPackageEmission(
    sortedPackages.map((p) => p.name),
  );
  const specifierByName = new Map(
    sortedPackages.map((p) => [p.name, p.specifier]),
  );
  for (const emission of packageEmissions) {
    packageImports[emission.moduleSpecifier] = resolveNodeDependencyValue(
      emission,
      specifierByName.get(emission.name)!,
      lockVersions,
    );
  }

  for (const file of files) {
    if (file.path === "deno.json") {
      nodeFiles.push({
        path: "package.json",
        content: generatePackageJson(projectName, version, packageImports),
      });
      continue;
    }
    if (file.binary || !file.content) {
      nodeFiles.push(file);
      continue;
    }
    if (file.path.endsWith(".ts")) {
      let source = file.content;
      if (file.path === "main.ts") source = rewriteMainForNode(source);
      const result = await esbuild.transform(source, {
        loader: "ts",
        format: "esm",
      });
      const jsPath = file.path.replace(/\.ts$/, ".js");
      const jsContent = result.code.replace(
        /from\s+["']([^"']*?)\.ts["']/g,
        'from "$1.js"',
      );
      nodeFiles.push({ path: jsPath, content: jsContent });
    } else {
      nodeFiles.push(file);
    }
  }

  return nodeFiles;
}

export async function buildNodeProject(
  kernel: Kernel,
  projectDir: string,
  projectName: string,
  version: string,
  opts?: BuildOptions,
): Promise<BuildResult> {
  const nodeFiles = await buildNodeFiles(
    kernel,
    projectName,
    version,
    opts,
    projectDir,
  );
  const outDir = join(projectDir, "dist", `v${version}-node`);
  writeExportFiles(outDir, nodeFiles);
  return { path: outDir, fileCount: nodeFiles.length, version };
}

export async function buildNodeZip(
  kernel: Kernel,
  projectDir: string,
  projectName: string,
  version: string,
  opts?: BuildOptions,
): Promise<Uint8Array> {
  const nodeFiles = await buildNodeFiles(
    kernel,
    projectName,
    version,
    opts,
    projectDir,
  );
  const prefix = `${projectName}-v${version}-node/`;
  return createZip(nodeFiles, prefix);
}

// --- Target 5: Documentation ---

export async function buildDocsMarkdown(
  kernel: Kernel,
  projectDir: string,
  projectName: string,
  version: string,
): Promise<BuildResult> {
  const docs = await generateAppDocs(kernel);
  const files = docsToMarkdownFiles(docs);
  cleanupPreviousDocsMarkdown(projectDir);
  const manifest: ExportFile = {
    path: DOCS_MANIFEST,
    content: JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        projectName,
        version,
        files: files.map((file) => file.path),
      },
      null,
      2,
    ) + "\n",
  };
  writeExportFiles(projectDir, [...files, manifest]);
  return {
    path: join(projectDir, "docs"),
    fileCount: files.length + 1,
    version,
  };
}

export async function buildDocsSite(
  kernel: Kernel,
  projectDir: string,
  projectName: string,
  version: string,
): Promise<BuildResult> {
  const docs = await generateAppDocs(kernel);
  const files = docsToStaticSiteFiles(docs, projectName);
  const outDir = join(projectDir, "dist", `v${version}`, "docs");
  rmSync(outDir, { recursive: true, force: true });
  writeExportFiles(outDir, files);
  return { path: outDir, fileCount: files.length, version };
}

function cleanupPreviousDocsMarkdown(projectDir: string): void {
  const manifestPath = join(projectDir, DOCS_MANIFEST);
  if (!existsSync(manifestPath)) return;
  try {
    const manifest = JSON.parse(readFileSync(manifestPath, "utf-8")) as {
      files?: unknown;
    };
    if (!Array.isArray(manifest.files)) return;
    for (const file of manifest.files) {
      if (typeof file !== "string") continue;
      if (!file.startsWith("docs/") || file.includes("..")) continue;
      rmSync(join(projectDir, file), { force: true });
    }
  } catch {
    // Ignore invalid manifests; new files will still be generated.
  }
}

// The generated package.json's top-level framework deps, pinned to EXACT
// published versions (no caret ranges) so a frozen install resolves the same tree
// every time. These pins cover ONLY the three top-level deps the Node artifact
// imports directly; their transitive dependencies still float, because without a
// committed package-lock.json (integrity-hashed, registry-resolved — not something
// we can produce purely at export time) nothing pins the deeper tree. That is
// precisely why the frozen-install integrity check is gate-side ephemeral (the
// Node smoke gate generates a lock in its own tmp dir, then `npm ci`s off it —
// verification/production-build.ts) rather than a shipped lockfile artifact.
// Pinned to concrete versions consistent with the previous floors: latest 4.x
// hono, latest 1.x @hono/node-server, and the 0.4.5 pglite floor exactly.
const NODE_DEP_HONO = NODE_RUNTIME_HONO_VERSION;
const NODE_DEP_NODE_SERVER = NODE_RUNTIME_NODE_SERVER_VERSION;
const NODE_DEP_PGLITE = NODE_RUNTIME_PGLITE_VERSION;

// The committed Node lock's fixed path in the export, shared by buildNodeFiles
// (which reads its bytes to derive user-dep pins) and the ExportFile that carries
// it. Kept in sync with verification/production-node-lock.ts's PACKAGE_LOCKFILE_PATH.
const PACKAGE_LOCK_PATH = "package-lock.json";

// The fallback dependency value for a user package whose specifier carries no
// version AND whose exact version cannot be derived from a committed lock — "any
// version". A valid package.json dependency spec (semver `validRange("*") === "*"`);
// the last rung of the precedence ladder, reached only by a bare `npm:name` with no
// committed lock. Never a network-resolved version — the build stays offline.
const UNPINNED_VERSION_FALLBACK = "*";

// Reshape a runtime package specifier — as minted by core/packages.ts `install()`:
// `npm:<name>` or `npm:<name>@<spec>` — into a package.json dependency VALUE: the
// bare version part, never the redundant `name@spec` the Node import map must not
// carry (a value like "marked@1" is an npm-alias-shaped string, wrong for a version
// field). Peels the specifier using the package's own `name` (the reliable map key):
// strip the `npm:` scheme, then the name, then the single `@` separator. Scoped
// names (`npm:@scope/pkg@2`) work because `name` already includes the scope, so what
// remains after it is just `@<spec>` — the leading scope `@` is never mistaken for
// the version separator. Returns undefined for a bare `npm:name` (no version), so
// the caller applies the precedence ladder.
//
// Findings (npm 11 / node 24, confirmed empirically before this code was written):
//   npm:marked@1        (name marked)      → "1"       (major range)
//   npm:exact@1.2.3     (name exact)       → "1.2.3"   (exact)
//   npm:tag@latest      (name tag)         → "latest"  (dist-tag)
//   npm:@scope/pkg@2    (name @scope/pkg)  → "2"       (scoped major range)
//   npm:bare            (name bare)        → undefined (no version)
// Every non-undefined result is a valid package.json dependency spec: "1"/"2"/
// "1.2.3"/"*" are valid semver ranges and "latest" is a valid dist-tag (fork #3).
export function reshapeSpecifierVersion(
  specifier: string,
  name: string,
): string | undefined {
  const withoutScheme = specifier.startsWith("npm:")
    ? specifier.slice("npm:".length)
    : specifier;
  // Defensive: install() always mints `npm:<name>[@<spec>]`, so this holds; an
  // unexpected shape yields undefined and the caller falls back rather than pinning
  // a garbage value.
  if (!withoutScheme.startsWith(name)) return undefined;
  const rest = withoutScheme.slice(name.length);
  if (!rest.startsWith("@")) return undefined;
  const version = rest.slice(1);
  return version.length > 0 ? version : undefined;
}

// Parse a committed package-lock.json's bytes into a name → exact-resolved-version
// map. PURE and NEVER-THROWS: a malformed, absent, or empty lock yields an EMPTY
// map (the generator then degrades to "don't pin from the lock", never an error).
// Reads lockfileVersion 2+/3's `packages` map, keyed by "node_modules/<name>" (the
// root "" entry excluded, and NESTED node_modules skipped so only top-level direct
// installs — the pinnable user deps — contribute); falls back to the legacy
// lockfileVersion-1 `dependencies` map. Only entries carrying a concrete `version`
// string count.
export function parseNodeLockVersions(
  lockContent: string | undefined,
): Map<string, string> {
  const versions = new Map<string, string>();
  if (lockContent === undefined) return versions;
  let parsed: unknown;
  try {
    parsed = JSON.parse(lockContent);
  } catch {
    return versions;
  }
  if (typeof parsed !== "object" || parsed === null) return versions;
  const record = parsed as Record<string, unknown>;

  const packages = record.packages;
  if (packages && typeof packages === "object") {
    for (const [key, entry] of Object.entries(packages)) {
      const name = topLevelNodeModulesName(key);
      if (name === undefined) continue;
      const version = readVersion(entry);
      if (version !== undefined) versions.set(name, version);
    }
  }

  const dependencies = record.dependencies;
  if (dependencies && typeof dependencies === "object") {
    for (const [name, entry] of Object.entries(dependencies)) {
      if (versions.has(name)) continue; // the `packages` map (if present) wins.
      const version = readVersion(entry);
      if (version !== undefined) versions.set(name, version);
    }
  }

  return versions;
}

// The package name for a top-level `packages` key ("node_modules/<name>", scope
// included), or undefined for the root "" entry, a non-node_modules key, or a NESTED
// install ("node_modules/a/node_modules/b" — a transitive, not a pinnable direct
// dep). Keeps a nested entry from shadowing a direct dep of the same name.
function topLevelNodeModulesName(key: string): string | undefined {
  const prefix = "node_modules/";
  if (!key.startsWith(prefix)) return undefined;
  const rest = key.slice(prefix.length);
  if (rest.length === 0 || rest.includes("node_modules/")) return undefined;
  return rest;
}

function readVersion(entry: unknown): string | undefined {
  const version = (entry as { version?: unknown })?.version;
  return typeof version === "string" && version.length > 0
    ? version
    : undefined;
}

// Resolve one runtime package to its package.json dependency VALUE via the offline
// precedence ladder (Slice 6.3), highest priority first:
//   1. committed-lock resolved version (EXACT) — pins the whole graph, not just the
//      framework deps, so node_dependency_lock validates an exact whole-graph
//      correspondence rather than a range-satisfies one.
//   2. the specifier's own version, reshaped (exact / range / dist-tag) — the best
//      available offline when no committed lock pins this dep.
//   3. UNPINNED_VERSION_FALLBACK ("*") — last resort for a bare `npm:name` with no
//      lock: a valid, reproducible spec, never a network-resolved version.
// Reads only the committed lock and the specifier — no network, ever.
// An ALIASED package (one whose name collides with a dep the shell itself imports)
// departs from the ladder in two ways, both forced by how npm treats aliases:
//   - the lock is read by the EMITTED key, because `npm i` installs an aliased dep
//     into node_modules/<alias>. The real name's top-level lock entry belongs to the
//     PLATFORM's copy, so reading it would clamp the user's package to the shell's pin.
//   - the value is npm alias syntax (`npm:<realName>@<version>`), not a bare version,
//     because nothing is published under the alias.
function resolveNodeDependencyValue(
  emission: AppPackageEmission,
  specifier: string,
  lockVersions: Map<string, string>,
): string {
  const locked = lockVersions.get(emission.moduleSpecifier);
  const version = locked ??
    reshapeSpecifierVersion(specifier, emission.name) ??
    UNPINNED_VERSION_FALLBACK;
  return emission.aliased ? `npm:${emission.name}@${version}` : version;
}

function generatePackageJson(
  name: string,
  version: string,
  extraDeps: Record<string, string>,
): string {
  const deps: Record<string, string> = {
    "hono": NODE_DEP_HONO,
    "@hono/node-server": NODE_DEP_NODE_SERVER,
    "@electric-sql/pglite": NODE_DEP_PGLITE,
    // extraDeps are user-added packages (kernel.runtime.listPackages), each already
    // resolved to a proper package.json dependency value by resolveNodeDependencyValue:
    // the committed lock's exact resolved version when available (Slice 6.3),
    // otherwise the specifier's own reshaped version. A user package sharing one of
    // the three names above is keyed by its ALIAS (planAppPackageEmission), so the
    // spread can no longer reach a platform pin — and the assertion below is what
    // makes that a checked invariant rather than a property of the code's shape.
    ...extraDeps,
  };
  assertRuntimeDependencyPins(deps, "node", "package.json");
  return JSON.stringify(
    {
      name: sanitizePackageName(name),
      version,
      type: "module",
      // The shell's router is URLPattern, which Node exposes as a global only from 24
      // onwards (23.8 has it behind a `node:url` export that Deno does not mirror, so
      // one source cannot use it portably). This excludes Node 22, in LTS maintenance
      // until April 2027. main.js also checks at startup, because `engines` is advice
      // npm prints and then ignores.
      engines: { node: ">=24" },
      scripts: {
        start: "node main.js",
        migrate: "node main.js --migrate",
        seed: "node main.js --seed",
        "db:prepare": "node main.js --prepare-db",
        "db:check": "node main.js --check-db",
      },
      dependencies: deps,
    },
    null,
    2,
  ) + "\n";
}

function sanitizePackageName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/^-+|-+$/g, "");
}

function rewriteMainForNode(source: string): string {
  let out = source;
  out = out.replace(
    /import\s*\{\s*existsSync\s*\}\s*from\s*["']node:fs["'];?\n?/,
    "",
  );
  out = out.replace(
    /Deno\.readTextFileSync\(runtimeFile\(([^)]+)\)\)/g,
    'readFileSync(runtimeFile($1), "utf-8")',
  );
  out = out.replace(
    /Deno\.readFileSync\(runtimeFile\(([^)]+)\)\)/g,
    "readFileSync(runtimeFile($1))",
  );
  out = out.replace(
    /Deno\.readTextFileSync\(([^)]+)\)/g,
    'readFileSync($1, "utf-8")',
  );
  out = out.replace(
    /Deno\.readFileSync\(([^)]+)\)/g,
    "readFileSync($1)",
  );
  // The Node-only imports ride in after main.ts's deps.ts import, which the generator
  // always emits. This used to anchor on `import … from "hono"` — a line the emitter
  // stopped producing when the shell dropped the framework. A non-matching anchor is
  // silent: it produces an artifact that references `serve` and `readFileSync` and
  // never imports them, and waits for the Node smoke gate to notice, so the count is
  // asserted below.
  const anchor = 'import { db, functions, env, templates } from "./deps.ts";\n';
  const before = out;
  out = out.replace(
    anchor,
    anchor +
      'import { serve } from "@hono/node-server";\nimport { readFileSync, existsSync } from "node:fs";\nimport { pathToFileURL } from "node:url";\n',
  );
  if (out === before) {
    throw new Error(
      `Cannot build for Node: main.ts no longer contains ${
        JSON.stringify(anchor.trim())
      }, the anchor the Node-only imports are injected after. Update rewriteMainForNode alongside generateMain.`,
    );
  }
  out = out.replace(
    "return Deno.serve({ hostname, port, onListen: () => {} }, (req) => app.fetch(req));",
    `return await new Promise((resolve, reject) => {
    let server: { once?: (event: string, handler: (...args: any[]) => void) => void } | undefined;
    server = serve({ fetch: app.fetch, hostname, port }, () => resolve(server));
    server.once?.("error", reject);
  });`,
  );
  // import.meta.main is undefined in Node ESM, so the Deno entrypoint predicate
  // would never fire under `node main.js` and the server would silently not boot.
  // Retarget it to the Node equivalent (this module's URL === the invoked script).
  out = out.replace(
    "  return import.meta.main === true;",
    "  return import.meta.url === pathToFileURL(process.argv[1]).href;",
  );
  return out;
}

// --- Target 6: Standalone Binary ---

export interface BuildJob {
  id: string;
  target: string;
  targetLabel?: string;
  status: "running" | "done" | "error";
  message?: string;
  outputPath?: string;
  startedAt: string;
  completedAt?: string;
  error?: string;
}

const builds = new Map<string, BuildJob>();
// deno-lint-ignore no-control-regex -- ANSI escape bytes are intentional.
const ANSI_ESCAPE_RE = /\x1B\[[0-?]*[ -/]*[@-~]/g;

function decodeCommandOutput(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes).replace(ANSI_ESCAPE_RE, "").trim();
}

function trimDenoBacktrace(output: string): string {
  const stackIdx = output.indexOf("\nStack backtrace:");
  return (stackIdx === -1 ? output : output.slice(0, stackIdx)).trim();
}

function relativeCheckPath(path: string, tmpDir: string): string {
  const normalized = path.startsWith("file://") ? new URL(path).pathname : path;
  return normalized.startsWith(`${tmpDir}/`)
    ? normalized.slice(tmpDir.length + 1)
    : normalized;
}

export function parseDenoCheckIssues(
  output: string,
  tmpDir = "",
): ExportTypeCheckIssue[] {
  const lines = output.split("\n");
  const issues: ExportTypeCheckIssue[] = [];
  const headerRe = /^([A-Z]+\d+)\s+\[(ERROR|WARNING|INFO|HINT)\]:\s+(.+)$/;
  const atRe = /^\s+at\s+(.+):(\d+):(\d+)$/;

  for (let i = 0; i < lines.length; i++) {
    const header = lines[i]?.match(headerRe);
    if (!header) continue;

    const code = header[1];
    const severityText = header[2];
    const message = header[3];
    if (!code || !severityText || !message) continue;
    const snippetLines: string[] = [];
    let location: RegExpMatchArray | null = null;

    for (let j = i + 1; j < lines.length; j++) {
      const line = lines[j] ?? "";
      const at = line.match(atRe);
      if (at) {
        location = at;
        i = j;
        break;
      }
      if (headerRe.test(line) || line.startsWith("Found ")) {
        i = j - 1;
        break;
      }
      if (line.trim()) snippetLines.push(line);
    }

    if (!location) continue;

    const rawFile = location[1];
    const lineText = location[2];
    const columnText = location[3];
    if (!rawFile || !lineText || !columnText) continue;
    issues.push({
      severity: severityText.toLowerCase() as ExportTypeCheckIssue["severity"],
      code,
      message,
      file: relativeCheckPath(rawFile, tmpDir),
      line: Number(lineText),
      column: Number(columnText),
      ...(snippetLines.length > 0
        ? { snippet: snippetLines.join("\n").trimEnd() }
        : {}),
    });
  }

  return issues;
}

export function formatCommandFailure(
  command: string,
  result: { code: number; stdout: Uint8Array; stderr: Uint8Array },
): string {
  const lines = [`${command} failed with exit code ${result.code}.`];
  const stderr = decodeCommandOutput(result.stderr);
  const stdout = decodeCommandOutput(result.stdout);
  if (stderr) lines.push("", stderr);
  if (stdout) lines.push("", "stdout:", stdout);
  if (!stderr && !stdout) {
    lines.push("", "No output was captured from the command.");
  }
  return lines.join("\n");
}

export function getBuild(id: string): BuildJob | undefined {
  return builds.get(id);
}

export function binaryOutputFilename(
  projectName: string,
  version: string,
  target?: BinaryCompileTarget,
): string {
  const outputName = sanitizePackageName(projectName) || "app";
  const suffix = target ? `-${target}` : "";
  const extension = target === "x86_64-pc-windows-msvc" ? ".exe" : "";
  return `${outputName}-v${version}${suffix}${extension}`;
}

export function binaryCompileArgs(
  outputPath: string,
  entryPath: string,
  target?: BinaryCompileTarget,
  includePaths: string[] = [],
): string[] {
  // The same permissions the generated `deno task start` grants — one definition,
  // in core/export.ts. A compiled binary and a `deno task start` of the same export
  // must not disagree about what the app is allowed to do.
  const args = [
    "compile",
    "--no-check",
    ...APP_RUNTIME_PERMISSIONS,
  ];
  for (const includePath of includePaths) {
    args.push("--include", includePath);
  }
  if (target) args.push("--target", target);
  args.push("--output", outputPath, entryPath);
  return args;
}

/* Moved to core/export.ts so the manifest can record the same list this
   computes — an export now carries `runtimeIncludePaths`, and a build driver
   outside this repo reads it instead of reimplementing the rule. Re-exported
   here because this is where every existing caller imports it from, and
   because a compile helper is where you would look for it. */
export { binaryRuntimeIncludePaths };

export async function checkExportTypes(
  kernel: Kernel,
  projectDir: string,
  opts?: BuildOptions,
): Promise<ExportTypeCheckResult> {
  const { files } = await exportProject(
    kernel,
    exportOptionsForBuild(projectDir, opts),
  );
  // Resolve the toolchain before writing anything: `deno check` is the whole
  // job, so with no deno there is no point staging an export tree to run it on.
  const toolchain = resolveDenoToolchain();
  if (!toolchain.ok) {
    return {
      ok: false,
      output: denoToolchainFailure(
        "The export type check needs a Deno toolchain",
        toolchain.error,
      ),
      fileCount: files.length,
      issues: [],
    };
  }
  const tmpDir = join(projectDir, "dist", ".tmp-check");
  try {
    rmSync(tmpDir, { recursive: true, force: true });
    writeExportFiles(tmpDir, files);

    const cmd = new Deno.Command(toolchain.data, {
      args: ["check", "main.ts"],
      cwd: tmpDir,
      stdout: "piped",
      stderr: "piped",
      // Bounded, because an unbounded await here is how a wedged subprocess
      // wedges the HTTP request behind it with no way back.
      signal: AbortSignal.timeout(EXPORT_TYPE_CHECK_TIMEOUT_MS),
    });
    let result: Deno.CommandOutput;
    try {
      result = await cmd.output();
    } catch (err) {
      return {
        ok: false,
        output: `Type check could not run: ${
          err instanceof Error ? err.message : String(err)
        }`,
        fileCount: files.length,
        issues: [],
      };
    }
    const stderr = decodeCommandOutput(result.stderr);
    const stdout = decodeCommandOutput(result.stdout);
    const output = trimDenoBacktrace(
      [stderr, stdout].filter(Boolean).join("\n\n"),
    );
    return {
      ok: result.success,
      output: output ||
        (result.success
          ? "Type check passed."
          : "Type check failed with no output."),
      fileCount: files.length,
      issues: parseDenoCheckIssues(output, tmpDir),
    };
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

export async function buildBinary(
  kernel: Kernel,
  projectDir: string,
  projectName: string,
  version: string,
  opts?: BuildOptions,
  compileTarget?: BinaryCompileTarget,
  waitForCompletion = true,
): Promise<string> {
  const id = createTimestampedShortId("build");
  const targetLabel = compileTarget
    ? BINARY_COMPILE_TARGETS.find((target) => target.id === compileTarget)
      ?.label
    : undefined;
  const job: BuildJob = {
    id,
    target: compileTarget ?? "binary",
    targetLabel,
    status: "running",
    message: "Preparing source files...",
    startedAt: new Date().toISOString(),
  };
  builds.set(id, job);

  const runBuild = async () => {
    const tmpDir = join(
      projectDir,
      "dist",
      compileTarget ? `.tmp-compile-${compileTarget}` : ".tmp-compile",
    );
    const outputPath = join(
      projectDir,
      "dist",
      binaryOutputFilename(projectName, version, compileTarget),
    );

    try {
      // `deno compile` is the entire job, so a missing toolchain is reported as
      // what it is before any export work happens. Without this the job failed
      // with the bare spawn error ("Failed to spawn 'deno': entity not found"),
      // which tells a desktop user nothing about what they need.
      const toolchain = resolveDenoToolchain();
      if (!toolchain.ok) {
        job.status = "error";
        job.error = denoToolchainFailure(
          "Binary export needs a Deno toolchain",
          toolchain.error,
        );
        return;
      }

      const { files } = await exportProject(
        kernel,
        exportOptionsForBuild(projectDir, opts, {
          projectName,
          projectVersion: version,
        }),
      );
      writeExportFiles(tmpDir, files);
      job.message = compileTarget
        ? `Compiling ${targetLabel ?? compileTarget} binary...`
        : "Compiling binary...";

      const cmd = new Deno.Command(toolchain.data, {
        args: binaryCompileArgs(
          outputPath,
          join(tmpDir, "main.ts"),
          compileTarget,
          binaryRuntimeIncludePaths(files).map((path) => join(tmpDir, path)),
        ),
        stdout: "piped",
        stderr: "piped",
      });

      const result = await cmd.output();

      if (result.success) {
        job.status = "done";
        job.message = compileTarget
          ? `${targetLabel ?? compileTarget} binary ready`
          : "Compilation complete";
        job.outputPath = outputPath;
      } else {
        job.status = "error";
        job.error = formatCommandFailure("deno compile", result);
      }
    } catch (err) {
      job.status = "error";
      job.error = err instanceof Error ? err.message : String(err);
    } finally {
      job.completedAt = new Date().toISOString();
      try {
        rmSync(tmpDir, { recursive: true });
      } catch { /* ignore */ }
    }
  };

  const completion = runBuild();
  if (waitForCompletion) {
    await completion;
  } else {
    completion.catch(() => {
      // runBuild records errors on the job; this prevents an unhandled
      // rejection if a future edit throws outside its internal guard.
    });
  }

  return id;
}

// --- Shared Utilities ---

// Materialize an export's virtual file list under `outDir` (mkdir -p per file,
// binary vs text as appropriate). Exported for the `opentide export` CLI's
// unpacked-tree output (composition root cli.ts) so it reuses the exact write
// path the builders use rather than re-implementing the mkdir/binary loop.
export function writeExportFiles(outDir: string, files: ExportFile[]): void {
  // Entity/asset names flow into file.path verbatim and originate from agent
  // tool calls driven by untrusted prompts. A name with `../` segments would
  // otherwise let `join` collapse out of outDir and write anywhere the process
  // can (confirmed: F-08). Contain every write under the resolved output root.
  const root = resolve(outDir);
  const rootPrefix = root + sep;
  for (const file of files) {
    const filePath = resolve(outDir, file.path);
    if (filePath !== root && !filePath.startsWith(rootPrefix)) {
      throw new Error(
        `Export path escapes the output directory: ${file.path}`,
      );
    }
    const dir = filePath.substring(0, filePath.lastIndexOf(sep));
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    if (file.binary) {
      writeFileSync(filePath, file.binary);
    } else {
      writeFileSync(filePath, file.content ?? "");
    }
  }
}

function createZip(files: ExportFile[], prefix: string): Uint8Array {
  const entries: { name: string; data: Uint8Array }[] = [];
  const enc = new TextEncoder();

  for (const file of files) {
    entries.push({
      name: prefix + file.path,
      data: file.binary ?? enc.encode(file.content ?? ""),
    });
  }

  // Stable member order (mod time/date are already fixed at 0 and no comments or
  // extra fields are written), so the same file set always zips to the same bytes.
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  const parts: Uint8Array[] = [];
  const centralDir: Uint8Array[] = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBytes = enc.encode(entry.name);
    const crc = crc32(entry.data);

    // Local file header
    const local = new Uint8Array(30 + nameBytes.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true); // signature
    lv.setUint16(4, 20, true); // version needed
    lv.setUint16(6, 0, true); // flags
    lv.setUint16(8, 0, true); // compression: store
    lv.setUint16(10, 0, true); // mod time
    lv.setUint16(12, 0, true); // mod date
    lv.setUint32(14, crc, true);
    lv.setUint32(18, entry.data.length, true); // compressed size
    lv.setUint32(22, entry.data.length, true); // uncompressed size
    lv.setUint16(26, nameBytes.length, true);
    lv.setUint16(28, 0, true); // extra length
    local.set(nameBytes, 30);

    parts.push(local);
    parts.push(entry.data);

    // Central directory entry
    const central = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true); // signature
    cv.setUint16(4, 20, true); // version made by
    cv.setUint16(6, 20, true); // version needed
    cv.setUint16(8, 0, true); // flags
    cv.setUint16(10, 0, true); // compression: store
    cv.setUint16(12, 0, true); // mod time
    cv.setUint16(14, 0, true); // mod date
    cv.setUint32(16, crc, true);
    cv.setUint32(20, entry.data.length, true);
    cv.setUint32(24, entry.data.length, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint16(30, 0, true); // extra length
    cv.setUint16(32, 0, true); // comment length
    cv.setUint16(34, 0, true); // disk number
    cv.setUint16(36, 0, true); // internal attrs
    cv.setUint32(38, 0, true); // external attrs
    cv.setUint32(42, offset, true); // local header offset
    central.set(nameBytes, 46);

    centralDir.push(central);
    offset += local.length + entry.data.length;
  }

  const centralDirOffset = offset;
  let centralDirSize = 0;
  for (const cd of centralDir) {
    parts.push(cd);
    centralDirSize += cd.length;
  }

  // End of central directory
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true); // signature
  ev.setUint16(4, 0, true); // disk number
  ev.setUint16(6, 0, true); // central dir disk
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, centralDirSize, true);
  ev.setUint32(16, centralDirOffset, true);
  ev.setUint16(20, 0, true); // comment length
  parts.push(eocd);

  let total = 0;
  for (const p of parts) total += p.length;
  const result = new Uint8Array(total);
  let pos = 0;
  for (const p of parts) {
    result.set(p, pos);
    pos += p.length;
  }
  return result;
}

function crc32(data: Uint8Array): number {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < data.length; i++) {
    crc ^= data[i]!;
    for (let j = 0; j < 8; j++) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xEDB88320 : 0);
    }
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}
