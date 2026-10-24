import { join } from "node:path";

export type PackageManager =
  | "npm"
  | "pnpm"
  | "yarn"
  | "bun"
  | "deno"
  | "unknown";

export interface PackageJsonSummary {
  name?: string;
  version?: string;
  type?: string;
  scripts: Record<string, string>;
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
}

export interface CodebaseConfigFile {
  path: string;
  kind:
    | "package-json"
    | "tsconfig"
    | "jsconfig"
    | "vite"
    | "eslint"
    | "vitest"
    | "jest"
    | "playwright"
    | "svelte"
    | "next"
    | "astro"
    | "prettier"
    | "tailwind"
    | "postcss"
    | "deno"
    | "unknown";
}

export interface FrameworkHint {
  id:
    | "express"
    | "fastify"
    | "hono"
    | "next"
    | "sveltekit"
    | "astro"
    | "remix"
    | "react-router"
    | "vite"
    | "unknown";
  source: "dependency" | "config";
  confidence: number;
  evidence: string;
}

export interface TsJsProjectDiscovery {
  rootPath: string;
  packageManager: PackageManager;
  packageJson?: PackageJsonSummary;
  lockfiles: string[];
  configFiles: CodebaseConfigFile[];
  frameworkHints: FrameworkHint[];
  sourceRoots: string[];
  ignoredDirs: string[];
}

const IGNORED_DIR_NAMES = new Set([
  ".git",
  ".opentide",
  "node_modules",
  "dist",
  "build",
  "coverage",
  ".next",
  ".svelte-kit",
  ".turbo",
  ".cache",
  "out",
]);

const SOURCE_ROOT_CANDIDATES = [
  "src",
  "app",
  "pages",
  "routes",
  "server",
  "api",
  "lib",
  "components",
];

const LOCKFILE_PACKAGE_MANAGERS: Array<[string, PackageManager]> = [
  ["pnpm-lock.yaml", "pnpm"],
  ["yarn.lock", "yarn"],
  ["bun.lockb", "bun"],
  ["bun.lock", "bun"],
  ["deno.lock", "deno"],
  ["package-lock.json", "npm"],
  ["npm-shrinkwrap.json", "npm"],
];

const CONFIG_FILE_KINDS: Array<[string, CodebaseConfigFile["kind"]]> = [
  ["package.json", "package-json"],
  ["tsconfig.json", "tsconfig"],
  ["jsconfig.json", "jsconfig"],
  ["vite.config.ts", "vite"],
  ["vite.config.js", "vite"],
  ["eslint.config.js", "eslint"],
  ["eslint.config.mjs", "eslint"],
  [".eslintrc.json", "eslint"],
  ["vitest.config.ts", "vitest"],
  ["vitest.config.js", "vitest"],
  ["jest.config.ts", "jest"],
  ["jest.config.js", "jest"],
  ["playwright.config.ts", "playwright"],
  ["playwright.config.js", "playwright"],
  ["svelte.config.js", "svelte"],
  ["next.config.js", "next"],
  ["next.config.mjs", "next"],
  ["astro.config.mjs", "astro"],
  ["astro.config.ts", "astro"],
  ["deno.json", "deno"],
  ["deno.jsonc", "deno"],
];

const CONFIG_FILE_PATTERNS: Array<[RegExp, CodebaseConfigFile["kind"]]> = [
  [/^tsconfig\..+\.json$/, "tsconfig"],
  [/^\.eslintrc\.(js|cjs|mjs|json|ya?ml)$/, "eslint"],
  [/^prettier\.config\.(js|cjs|mjs|ts)$/, "prettier"],
  [/^\.prettierrc(\.(js|cjs|mjs|json|json5|ya?ml))?$/, "prettier"],
  [/^tailwind\.config\.(js|cjs|mjs|ts)$/, "tailwind"],
  [/^postcss\.config\.(js|cjs|mjs|ts)$/, "postcss"],
];

const FRAMEWORK_DEPENDENCIES: Array<[string, FrameworkHint["id"], number]> = [
  ["express", "express", 0.95],
  ["fastify", "fastify", 0.95],
  ["hono", "hono", 0.95],
  ["next", "next", 0.95],
  ["@sveltejs/kit", "sveltekit", 0.95],
  ["astro", "astro", 0.95],
  ["@remix-run/node", "remix", 0.85],
  ["@remix-run/react", "remix", 0.85],
  ["react-router", "react-router", 0.85],
  ["vite", "vite", 0.65],
];

const FRAMEWORK_CONFIGS: Array<
  [CodebaseConfigFile["kind"], FrameworkHint["id"], number]
> = [
  ["next", "next", 0.9],
  ["svelte", "sveltekit", 0.8],
  ["astro", "astro", 0.9],
  ["vite", "vite", 0.6],
];

export async function discoverTsJsProject(
  rootPath: string,
): Promise<TsJsProjectDiscovery> {
  const entries = await readRootEntries(rootPath);
  const fileNames = new Set(
    entries.filter((entry) => entry.isFile).map((entry) => entry.name),
  );
  const dirNames = new Set(
    entries.filter((entry) => entry.isDirectory).map((entry) => entry.name),
  );

  const lockfiles = LOCKFILE_PACKAGE_MANAGERS
    .map(([file]) => file)
    .filter((file) => fileNames.has(file));
  const packageManager = inferPackageManager(fileNames);
  const packageJson = fileNames.has("package.json")
    ? await readPackageJson(join(rootPath, "package.json"))
    : undefined;
  const configFiles = discoverConfigFiles(fileNames);

  return {
    rootPath,
    packageManager,
    ...(packageJson ? { packageJson } : {}),
    lockfiles,
    configFiles,
    frameworkHints: discoverFrameworkHints(packageJson, configFiles),
    sourceRoots: discoverSourceRoots(dirNames),
    ignoredDirs: [...dirNames].filter((name) => IGNORED_DIR_NAMES.has(name))
      .toSorted(),
  };
}

async function readRootEntries(rootPath: string): Promise<Deno.DirEntry[]> {
  const entries: Deno.DirEntry[] = [];
  try {
    for await (const entry of Deno.readDir(rootPath)) {
      entries.push(entry);
    }
  } catch {
    return [];
  }
  return entries;
}

async function readPackageJson(
  path: string,
): Promise<PackageJsonSummary | undefined> {
  try {
    const raw = await Deno.readTextFile(path);
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return {
      ...(typeof parsed.name === "string" ? { name: parsed.name } : {}),
      ...(typeof parsed.version === "string"
        ? { version: parsed.version }
        : {}),
      ...(typeof parsed.type === "string" ? { type: parsed.type } : {}),
      scripts: stringRecord(parsed.scripts),
      dependencies: stringRecord(parsed.dependencies),
      devDependencies: stringRecord(parsed.devDependencies),
    };
  } catch {
    return undefined;
  }
}

function inferPackageManager(fileNames: Set<string>): PackageManager {
  for (const [file, packageManager] of LOCKFILE_PACKAGE_MANAGERS) {
    if (fileNames.has(file)) return packageManager;
  }
  if (fileNames.has("package.json")) return "npm";
  return fileNames.has("deno.json") || fileNames.has("deno.jsonc")
    ? "deno"
    : "unknown";
}

function discoverConfigFiles(fileNames: Set<string>): CodebaseConfigFile[] {
  const configs = CONFIG_FILE_KINDS
    .filter(([file]) => fileNames.has(file))
    .map(([path, kind]) => ({ path, kind }));
  for (const file of fileNames) {
    for (const [pattern, kind] of CONFIG_FILE_PATTERNS) {
      if (pattern.test(file)) configs.push({ path: file, kind });
    }
  }
  return dedupeConfigFiles(configs).toSorted((a, b) =>
    a.path.localeCompare(b.path)
  );
}

function discoverFrameworkHints(
  packageJson: PackageJsonSummary | undefined,
  configFiles: CodebaseConfigFile[],
): FrameworkHint[] {
  const hints: FrameworkHint[] = [];
  const deps = {
    ...(packageJson?.dependencies ?? {}),
    ...(packageJson?.devDependencies ?? {}),
  };

  for (const [dependency, id, confidence] of FRAMEWORK_DEPENDENCIES) {
    if (deps[dependency]) {
      hints.push({
        id,
        source: "dependency",
        confidence,
        evidence: dependency,
      });
    }
  }

  for (const config of configFiles) {
    for (const [kind, id, confidence] of FRAMEWORK_CONFIGS) {
      if (config.kind === kind) {
        hints.push({
          id,
          source: "config",
          confidence,
          evidence: config.path,
        });
      }
    }
  }

  return dedupeFrameworkHints(hints).toSorted((a, b) =>
    b.confidence - a.confidence ||
    a.id.localeCompare(b.id) ||
    a.evidence.localeCompare(b.evidence)
  );
}

function dedupeConfigFiles(
  configs: CodebaseConfigFile[],
): CodebaseConfigFile[] {
  const byPath = new Map<string, CodebaseConfigFile>();
  for (const config of configs) byPath.set(config.path, config);
  return [...byPath.values()];
}

function dedupeFrameworkHints(hints: FrameworkHint[]): FrameworkHint[] {
  const byKey = new Map<string, FrameworkHint>();
  for (const hint of hints) {
    const key = `${hint.id}:${hint.source}:${hint.evidence}`;
    const existing = byKey.get(key);
    if (!existing || hint.confidence > existing.confidence) {
      byKey.set(key, hint);
    }
  }
  return [...byKey.values()];
}

function discoverSourceRoots(dirNames: Set<string>): string[] {
  const roots = SOURCE_ROOT_CANDIDATES
    .filter((name) => dirNames.has(name))
    .filter((name) => !IGNORED_DIR_NAMES.has(name));
  return roots.length > 0 ? roots : [];
}

function stringRecord(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out: Record<string, string> = {};
  for (const [key, val] of Object.entries(value)) {
    if (typeof val === "string") out[key] = val;
  }
  return out;
}
