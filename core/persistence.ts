import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { SnapshotData } from "./snapshots.ts";
import type { Kernel } from "./registries.ts";
import { kernelInspectAPI } from "./dev-views.ts";
import { DEFAULT_RUNTIME_ID } from "./runtime.ts";

export interface PersistedState {
  version: 1;
  runtimeId?: string;
  routes: Array<
    {
      method: string;
      path: string;
      handlerName: string;
      registeredAt: string;
      schema?: import("./types.ts").RouteSchema;
      module?: string;
    }
  >;
  handlers: Array<
    {
      name: string;
      source: string;
      registeredAt: string;
      // Optional for backward compatibility with state written before Stage 5; a
      // missing revision restores as a fresh bump (registry defaults it to 1).
      revision?: number;
      // A2 (Stream A): optional for back-compat with pre-A2 state; a missing uid
      // is minted by the registry on restore (the migration). Accrues forward.
      entityUid?: string;
      schema?: import("./types.ts").RouteSchema;
      module?: string;
      purpose?: string;
      runtimeId?: string;
      language?: string;
    }
  >;
  functions: Array<
    {
      name: string;
      source: string;
      registeredAt: string;
      revision?: number;
      entityUid?: string;
      returnType?: string;
      module?: string;
      purpose?: string;
      runtimeId?: string;
      language?: string;
    }
  >;
  configs?: Array<
    {
      name: string;
      value: unknown;
      description?: string;
      updatedAt: string;
      module?: string;
      entityUid?: string;
    }
  >;
  templates: Array<
    {
      name: string;
      content: string;
      registeredAt: string;
      module?: string;
      entityUid?: string;
    }
  >;
  assets: Array<
    {
      name: string;
      contentBase64: string;
      mimeType: string;
      registeredAt: string;
      module?: string;
      entityUid?: string;
    }
  >;
  packages: Array<{ name: string; specifier: string; installedAt: string }>;
  devViews: Array<
    {
      name: string;
      targetType: string;
      title: string;
      source: string;
      registeredAt: string;
      module?: string;
      runtimeId?: string;
      language?: string;
      entityUid?: string;
    }
  >;
  devTools?: Array<
    {
      name: string;
      description: string;
      args: Array<
        { name: string; type: string; description: string; required: boolean }
      >;
      source: string;
      registeredAt: string;
      module?: string;
      runtimeId?: string;
      language?: string;
      entityUid?: string;
    }
  >;
  tests?: Array<
    {
      name: string;
      source: string;
      registeredAt: string;
      module?: string;
      changesetId?: string;
      verification?: import("./types.ts").TestVerificationMetadata;
      lastResult?: import("./types.ts").TestResult;
      runtimeId?: string;
      language?: string;
      entityUid?: string;
    }
  >;
  customAudits?: Array<
    {
      name: string;
      description: string;
      prompt: string;
      registeredAt: string;
      module?: string;
      entityUid?: string;
    }
  >;
  envVars?: Array<
    {
      key: string;
      value?: string;
      description?: string;
      createdAt: string;
      updatedAt: string;
    }
  >;
  types?: Array<
    {
      name: string;
      fields: Array<
        { name: string; type: string; description?: string; optional?: boolean }
      >;
      description?: string;
      registeredAt: string;
      module?: string;
      entityUid?: string;
    }
  >;
  branches?: Array<
    { name: string; snapshotId: string; createdAt: string; isActive: boolean }
  >;
}

export function serializeKernelState(kernel: Kernel): PersistedState {
  return {
    version: 1,
    runtimeId: kernel.runtimeId,
    routes: kernel.routes.list(),
    handlers: kernel.handlers.serialize(),
    functions: kernel.functions.serialize(),
    configs: kernel.configs.serialize(),
    envVars: kernel.envVars.serialize(),
    templates: kernel.templates.serialize(),
    assets: kernel.assets.serialize(),
    packages: kernel.runtime.listPackages?.(kernel) ?? [],
    devViews: kernel.devViews.serialize().filter((v) => !v.builtIn),
    devTools: kernel.devTools.serialize(),
    tests: kernel.tests.serialize(),
    customAudits: kernel.customAudits.serialize(),
    types: kernel.types.serialize(),
    branches: kernel.branches.serialize(),
  };
}

function sortByName<T extends { name: string }>(entries: T[]): T[] {
  return entries.toSorted((a, b) => a.name.localeCompare(b.name));
}

function sortByKey<T extends { key: string }>(entries: T[]): T[] {
  return entries.toSorted((a, b) => a.key.localeCompare(b.key));
}

function sortRoutes<T extends { method: string; path: string }>(
  entries: T[],
): T[] {
  return entries.toSorted((a, b) => {
    const pathCmp = a.path.localeCompare(b.path);
    if (pathCmp !== 0) return pathCmp;
    return a.method.localeCompare(b.method);
  });
}

function stableState(data: PersistedState): PersistedState {
  return {
    version: 1,
    runtimeId: data.runtimeId ?? DEFAULT_RUNTIME_ID,
    routes: sortRoutes(data.routes ?? []),
    handlers: sortByName(data.handlers ?? []),
    functions: sortByName(data.functions ?? []),
    configs: sortByName(data.configs ?? []),
    envVars: sortByKey(data.envVars ?? []),
    templates: sortByName(data.templates ?? []),
    assets: sortByName(data.assets ?? []),
    packages: sortByName(data.packages ?? []),
    devViews: sortByName(data.devViews ?? []),
    devTools: sortByName(data.devTools ?? []),
    tests: sortByName(data.tests ?? []),
    customAudits: sortByName(data.customAudits ?? []),
    types: sortByName(data.types ?? []),
    branches: (data.branches ?? []).toSorted((a, b) =>
      a.name.localeCompare(b.name)
    ),
  };
}

function toJson(value: unknown): string {
  return JSON.stringify(value, null, 2) + "\n";
}

function writeJsonIfChanged(filePath: string, value: unknown): void {
  const next = toJson(value);
  if (existsSync(filePath)) {
    const current = readFileSync(filePath, "utf-8");
    if (current === next) return;
  }
  const tmpPath = filePath + ".tmp";
  writeFileSync(tmpPath, next);
  renameSync(tmpPath, filePath);
}

function stateFile(stateDir: string, name: string): string {
  return join(stateDir, `${name}.json`);
}

function entryFile(dir: string, name: string): string {
  return join(dir, `${encodeURIComponent(name)}.json`);
}

function readJsonFile<T>(
  filePath: string,
): { ok: true; data: T } | { ok: false; error: string } {
  if (!existsSync(filePath)) return { ok: true, data: undefined as T };
  try {
    return { ok: true, data: JSON.parse(readFileSync(filePath, "utf-8")) as T };
  } catch {
    return {
      ok: false,
      error:
        `State file is corrupted (invalid JSON). Delete ${filePath} to reset.`,
    };
  }
}

function writeEntryDir<T extends { name: string }>(
  stateDir: string,
  dirName: string,
  entries: T[],
): void {
  const dir = join(stateDir, dirName);
  mkdirSync(dir, { recursive: true });
  const expected = new Set<string>();
  for (const entry of sortByName(entries)) {
    const filePath = entryFile(dir, entry.name);
    expected.add(filePath);
    writeJsonIfChanged(filePath, entry);
  }
  for (const file of readdirSync(dir)) {
    if (!file.endsWith(".json")) continue;
    const filePath = join(dir, file);
    if (!expected.has(filePath)) rmSync(filePath, { force: true });
  }
}

function readEntryDir<T>(
  stateDir: string,
  dirName: string,
): { entries: T[]; errors: string[] } {
  const dir = join(stateDir, dirName);
  if (!existsSync(dir)) return { entries: [], errors: [] };
  const entries: T[] = [];
  const errors: string[] = [];
  for (const file of readdirSync(dir).toSorted()) {
    if (!file.endsWith(".json")) continue;
    const filePath = join(dir, file);
    const result = readJsonFile<T>(filePath);
    if (result.ok) {
      if (result.data !== undefined) entries.push(result.data);
    } else {
      errors.push(result.error);
    }
  }
  return { entries, errors };
}

export function saveProjectStateData(
  data: PersistedState,
  stateDir: string,
): void {
  const stable = stableState(data);
  mkdirSync(stateDir, { recursive: true });

  writeJsonIfChanged(stateFile(stateDir, "manifest"), {
    version: stable.version,
    runtimeId: stable.runtimeId ?? DEFAULT_RUNTIME_ID,
  });
  writeJsonIfChanged(stateFile(stateDir, "routes"), stable.routes);
  writeJsonIfChanged(stateFile(stateDir, "configs"), stable.configs ?? []);
  writeJsonIfChanged(stateFile(stateDir, "env-vars"), stable.envVars ?? []);
  writeJsonIfChanged(stateFile(stateDir, "packages"), stable.packages);
  writeJsonIfChanged(
    stateFile(stateDir, "custom-audits"),
    stable.customAudits ?? [],
  );
  writeJsonIfChanged(stateFile(stateDir, "branches"), stable.branches ?? []);

  writeEntryDir(stateDir, "handlers", stable.handlers);
  writeEntryDir(stateDir, "functions", stable.functions);
  writeEntryDir(stateDir, "templates", stable.templates);
  writeEntryDir(stateDir, "assets", stable.assets);
  writeEntryDir(stateDir, "dev-views", stable.devViews);
  writeEntryDir(stateDir, "dev-tools", stable.devTools ?? []);
  writeEntryDir(stateDir, "tests", stable.tests ?? []);
  writeEntryDir(stateDir, "types", stable.types ?? []);
}

export function saveKernelState(kernel: Kernel, stateDir: string): void {
  saveProjectStateData(serializeKernelState(kernel), stateDir);
}

export function loadProjectStateData(
  stateDir: string,
): { data: PersistedState | null; errors: string[] } {
  if (!existsSync(stateDir)) return { data: null, errors: [] };

  const errors: string[] = [];
  const manifest = readJsonFile<{ version?: number; runtimeId?: string }>(
    stateFile(stateDir, "manifest"),
  );
  if (!manifest.ok) errors.push(manifest.error);
  const readArray = <T>(name: string): T[] => {
    const result = readJsonFile<T[]>(stateFile(stateDir, name));
    if (!result.ok) {
      errors.push(result.error);
      return [];
    }
    return result.data ?? [];
  };

  const readEntries = <T>(dirName: string): T[] => {
    const result = readEntryDir<T>(stateDir, dirName);
    errors.push(...result.errors);
    return result.entries;
  };

  return {
    data: {
      version: 1,
      runtimeId: manifest.ok
        ? manifest.data?.runtimeId ?? DEFAULT_RUNTIME_ID
        : DEFAULT_RUNTIME_ID,
      routes: readArray("routes"),
      handlers: readEntries("handlers"),
      functions: readEntries("functions"),
      configs: readArray("configs"),
      envVars: readArray("env-vars"),
      templates: readEntries("templates"),
      assets: readEntries("assets"),
      packages: readArray("packages"),
      devViews: readEntries("dev-views"),
      devTools: readEntries("dev-tools"),
      tests: readEntries("tests"),
      customAudits: readArray("custom-audits"),
      types: readEntries("types"),
      branches: readArray("branches"),
    },
    errors,
  };
}

async function restoreKernelState(
  kernel: Kernel,
  data: PersistedState,
  rebuild: () => void,
): Promise<{ errors: string[] }> {
  const errors: string[] = [];

  const deps = await kernel.compileDeps();
  const defaultRuntimeId = data.runtimeId ?? kernel.runtimeId;
  const defaultLanguage = kernel.runtime.defaultLanguage;

  // Restore configs first (handlers/functions may read them)
  if (data.configs?.length) {
    kernel.configs.restore(data.configs);
  }
  // Restore env vars
  if (data.envVars?.length) {
    kernel.envVars.restore(data.envVars);
  }

  // Restore templates
  if (data.templates?.length) {
    kernel.templates.restore(data.templates);
  }

  // Restore assets
  if (data.assets?.length) {
    kernel.assets.restore(data.assets);
  }

  // Restore packages
  if (data.packages?.length) {
    const pkgErrors = kernel.runtime.restorePackages
      ? await kernel.runtime.restorePackages(kernel, data.packages)
      : [`Runtime "${kernel.runtimeId}" does not support package restore.`];
    errors.push(...pkgErrors);
  }

  // Compile and restore functions (handlers may depend on them)
  for (const f of data.functions) {
    const result = kernel.runtime.compileFunction
      ? await kernel.runtime.compileFunction(f.name, f.source, deps)
      : {
        ok: false as const,
        error: {
          code: "RUNTIME_CAPABILITY_UNAVAILABLE",
          message: `Runtime "${kernel.runtimeId}" cannot compile functions.`,
        },
      };
    if (result.ok) {
      kernel.functions.register(
        f.name,
        f.source,
        result.data,
        f.module,
        f.returnType,
        f.runtimeId ?? defaultRuntimeId,
        f.language ?? defaultLanguage,
        f.purpose,
        f.revision,
        f.entityUid,
      );
    } else {
      errors.push(`Function "${f.name}": ${result.error?.message}`);
    }
  }

  // Compile and restore handlers
  for (const h of data.handlers) {
    const result = kernel.runtime.compileHandler
      ? await kernel.runtime.compileHandler(h.name, h.source, deps)
      : {
        ok: false as const,
        error: {
          code: "RUNTIME_CAPABILITY_UNAVAILABLE",
          message: `Runtime "${kernel.runtimeId}" cannot compile handlers.`,
        },
      };
    if (result.ok) {
      kernel.handlers.register(
        h.name,
        h.source,
        result.data,
        h.schema,
        h.module,
        h.runtimeId ?? defaultRuntimeId,
        h.language ?? defaultLanguage,
        h.purpose,
        h.revision,
        h.entityUid,
      );
    } else {
      errors.push(`Handler "${h.name}": ${result.error?.message}`);
    }
  }

  // Restore user dev views
  const inspect = kernelInspectAPI(kernel);
  for (const v of data.devViews ?? []) {
    const result = kernel.runtime.compileDevView
      ? await kernel.runtime.compileDevView(v.name, v.source, deps, inspect)
      : {
        ok: false as const,
        error: {
          code: "RUNTIME_CAPABILITY_UNAVAILABLE",
          message: `Runtime "${kernel.runtimeId}" cannot compile dev views.`,
        },
      };
    if (result.ok) {
      kernel.devViews.register(
        v.name,
        v.targetType,
        v.title,
        v.source,
        result.data,
        false,
        v.module,
        v.runtimeId ?? defaultRuntimeId,
        v.language ?? defaultLanguage,
        v.entityUid,
      );
    } else {
      errors.push(`DevView "${v.name}": ${result.error?.message}`);
    }
  }

  // Restore dev tools
  for (const t of data.devTools ?? []) {
    const result = kernel.runtime.compileDevTool
      ? await kernel.runtime.compileDevTool(t.name, t.source, t.args, deps)
      : {
        ok: false as const,
        error: {
          code: "RUNTIME_CAPABILITY_UNAVAILABLE",
          message: `Runtime "${kernel.runtimeId}" cannot compile dev tools.`,
        },
      };
    if (result.ok) {
      kernel.devTools.register(
        t.name,
        t.description,
        t.args,
        t.source,
        result.data,
        t.module,
        t.runtimeId ?? defaultRuntimeId,
        t.language ?? defaultLanguage,
        t.entityUid,
      );
    } else {
      errors.push(`DevTool "${t.name}": ${result.error?.message}`);
    }
  }

  // Restore custom audits
  for (const a of data.customAudits ?? []) {
    kernel.customAudits.register(
      a.name,
      a.description,
      a.prompt,
      a.module,
      a.entityUid,
    );
  }

  // Restore types
  for (const t of data.types ?? []) {
    kernel.types.register(
      t.name,
      t.fields,
      t.description,
      t.module,
      t.entityUid,
    );
  }

  // Restore tests
  for (const t of data.tests ?? []) {
    const result = kernel.runtime.compileTest
      ? await kernel.runtime.compileTest(t.name, t.source, deps)
      : {
        ok: false as const,
        error: {
          code: "RUNTIME_CAPABILITY_UNAVAILABLE",
          message: `Runtime "${kernel.runtimeId}" cannot compile tests.`,
        },
      };
    if (result.ok) {
      kernel.tests.register(
        t.name,
        t.source,
        result.data,
        t.module,
        t.changesetId,
        t.runtimeId ?? defaultRuntimeId,
        t.language ?? defaultLanguage,
        t.verification,
        t.entityUid,
      );
    } else {
      errors.push(`Test "${t.name}": ${result.error?.message}`);
    }
  }

  // Restore routes last (all handlers must be registered first)
  kernel.routes.restore(data.routes);
  rebuild();

  if (data.branches?.length) {
    kernel.branches.restore(data.branches);
  }

  return { errors };
}

export async function loadKernelState(
  kernel: Kernel,
  stateDir: string,
  rebuild: () => void,
): Promise<{ errors: string[] }> {
  const { data, errors } = loadProjectStateData(stateDir);
  if (!data) return { errors };
  const result = await restoreKernelState(kernel, data, rebuild);
  return { errors: [...errors, ...result.errors] };
}

export function saveBranchSnapshots(
  kernel: Kernel,
  snapshotsDir: string,
): void {
  mkdirSync(snapshotsDir, { recursive: true });

  const branchSnapshotIds = new Set(
    kernel.branches.list().map((b) => b.snapshotId),
  );

  for (const id of branchSnapshotIds) {
    const snapshot = kernel.snapshots.getBranchSnapshot(id);
    if (!snapshot) continue;
    const filePath = join(snapshotsDir, `${id}.json`);
    const tmpPath = filePath + ".tmp";
    writeFileSync(tmpPath, toJson(snapshot));
    renameSync(tmpPath, filePath);
  }

  try {
    for (const file of readdirSync(snapshotsDir)) {
      if (!file.endsWith(".json")) continue;
      const id = file.replace(".json", "");
      if (!branchSnapshotIds.has(id)) {
        unlinkSync(join(snapshotsDir, file));
      }
    }
  } catch { /* dir may not exist yet */ }
}

export function loadBranchSnapshots(
  kernel: Kernel,
  snapshotsDir: string,
): void {
  if (!existsSync(snapshotsDir)) return;

  try {
    for (const file of readdirSync(snapshotsDir)) {
      if (!file.endsWith(".json")) continue;
      const filePath = join(snapshotsDir, file);
      const raw = readFileSync(filePath, "utf-8");
      const snapshot = JSON.parse(raw) as SnapshotData;
      kernel.snapshots.setBranchSnapshot(snapshot.metadata.id, snapshot);
    }
  } catch { /* ignore read errors */ }
}
