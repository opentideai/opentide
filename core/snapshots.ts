import type { Kernel } from "./registries.ts";
import { kernelInspectAPI } from "./dev-views.ts";
import { createTimestampedShortId } from "./ids.ts";

export interface SnapshotMetadata {
  id: string;
  createdAt: string;
  description: string;
  routeCount: number;
  handlerCount: number;
  functionCount: number;
  schemaCount: number;
  configKeyCount: number;
  envVarCount: number;
  assetCount: number;
  templateCount: number;
  packageCount: number;
  devViewCount: number;
  devToolCount: number;
  testCount: number;
}

export interface SnapshotData {
  metadata: SnapshotMetadata;
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
      returnType?: string;
      module?: string;
      purpose?: string;
      runtimeId?: string;
      language?: string;
    }
  >;
  configs: Array<
    {
      name: string;
      value: unknown;
      description?: string;
      updatedAt: string;
      module?: string;
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
  templates: Array<
    { name: string; content: string; registeredAt: string; module?: string }
  >;
  assets: Array<
    {
      name: string;
      contentBase64: string;
      mimeType: string;
      registeredAt: string;
      module?: string;
    }
  >;
  packages: Array<{ name: string; specifier: string; installedAt: string }>;
  devViews: Array<
    {
      name: string;
      targetType: string;
      title: string;
      source: string;
      builtIn: boolean;
      registeredAt: string;
      module?: string;
      runtimeId?: string;
      language?: string;
    }
  >;
  devTools: Array<
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
    }
  >;
  tests: Array<
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
    }
  >;
  tables: Array<
    {
      tableName: string;
      sql: string;
      rows: Record<string, unknown>[];
      module?: string;
    }
  >;
}

import { getKernelSettings } from "./config.ts";
const MAX_SNAPSHOTS = getKernelSettings().maxSnapshots;

export class SnapshotManager {
  private snapshots: SnapshotData[] = [];
  private branchSnapshots = new Map<string, SnapshotData>();

  async save(kernel: Kernel, description = ""): Promise<SnapshotMetadata> {
    const snapshot = await this.capture(kernel, description);
    this.snapshots.push(snapshot);
    if (this.snapshots.length > MAX_SNAPSHOTS) {
      this.snapshots.shift();
    }
    return snapshot.metadata;
  }

  // The snapshot without keeping it. `rows: false` records each table's
  // definition but not its rows: a code-only snapshot.
  async capture(
    kernel: Kernel,
    description = "",
    opts: { rows?: boolean } = {},
  ): Promise<SnapshotData> {
    const withRows = opts.rows !== false;
    const tables: SnapshotData["tables"] = [];
    for (const schema of await kernel.db.listSchemas()) {
      const rows = withRows
        ? await kernel.db.query(`SELECT * FROM "${schema.tableName}"`)
        : [];
      tables.push({
        tableName: schema.tableName,
        sql: schema.sql,
        rows,
        ...(schema.module ? { module: schema.module } : {}),
      });
    }

    const snapshot: SnapshotData = {
      metadata: {
        id: createTimestampedShortId("snap"),
        createdAt: new Date().toISOString(),
        description,
        routeCount: kernel.routes.list().length,
        handlerCount: kernel.handlers.list().length,
        functionCount: kernel.functions.list().length,
        schemaCount: tables.length,
        configKeyCount: kernel.configs.list().length,
        envVarCount: kernel.envVars.list().length,
        templateCount: kernel.templates.list().length,
        assetCount: kernel.assets.list().length,
        packageCount: (kernel.runtime.listPackages?.(kernel) ?? []).length,
        devViewCount: kernel.devViews.list().filter((v) => !v.builtIn).length,
        devToolCount: kernel.devTools.list().length,
        testCount: kernel.tests.list().length,
      },
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
      tables,
    };
    return snapshot;
  }

  async restore(
    id: string,
    kernel: Kernel,
    rebuild: () => void,
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    const snapshot = this.snapshots.find((s) => s.metadata.id === id) ??
      this.branchSnapshots.get(id);
    if (!snapshot) return { ok: false, error: `Snapshot "${id}" not found.` };
    return await this.restoreData(snapshot, kernel, rebuild);
  }

  // `tables: "keep"` leaves the database alone and restores everything else: the
  // other half of a code-only snapshot.
  async restoreData(
    snapshot: SnapshotData,
    kernel: Kernel,
    rebuild: () => void,
    opts: { tables?: "replace" | "keep" } = {},
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    const deps = await kernel.compileDeps();
    const defaultRuntimeId = snapshot.runtimeId ?? kernel.runtimeId;
    const defaultLanguage = kernel.runtime.defaultLanguage;

    // Clear all registries
    kernel.routes.clear();
    kernel.handlers.clear();
    kernel.functions.clear();
    kernel.tests.clear();
    kernel.configs.clear();
    kernel.templates.clear();
    kernel.assets.clear();
    kernel.packages.clear();

    if (opts.tables !== "keep") await restoreTables(snapshot, kernel);

    // Restore state, templates, and assets
    kernel.configs.restore(snapshot.configs);
    if (snapshot.envVars?.length) {
      kernel.envVars.restore(snapshot.envVars);
    } else {
      kernel.envVars.restore([]);
    }
    if (snapshot.templates?.length) {
      kernel.templates.restore(snapshot.templates);
    }
    if (snapshot.assets) kernel.assets.restore(snapshot.assets);

    // Restore packages (re-import from npm)
    if (snapshot.packages?.length) {
      const errors = kernel.runtime.restorePackages
        ? await kernel.runtime.restorePackages(kernel, snapshot.packages)
        : [`Runtime "${kernel.runtimeId}" does not support package restore.`];
      if (errors.length > 0) {
        return {
          ok: false,
          error: `Package restore errors: ${errors.join("; ")}`,
        };
      }
    }

    // Recompile and restore functions first (handlers may depend on them)
    for (const f of snapshot.functions) {
      const result = kernel.runtime.compileFunction
        ? await kernel.runtime.compileFunction(f.name, f.source, deps)
        : {
          ok: false as const,
          error: {
            code: "RUNTIME_CAPABILITY_UNAVAILABLE",
            message: `Runtime "${kernel.runtimeId}" cannot compile functions.`,
          },
        };
      if (!result.ok) {
        return {
          ok: false,
          error:
            `Failed to recompile function "${f.name}": ${result.error?.message}`,
        };
      }
      kernel.functions.register(
        f.name,
        f.source,
        result.data,
        f.module,
        f.returnType,
        f.runtimeId ?? defaultRuntimeId,
        f.language ?? defaultLanguage,
        f.purpose,
      );
    }

    // Recompile and restore handlers
    for (const h of snapshot.handlers) {
      const result = kernel.runtime.compileHandler
        ? await kernel.runtime.compileHandler(h.name, h.source, deps)
        : {
          ok: false as const,
          error: {
            code: "RUNTIME_CAPABILITY_UNAVAILABLE",
            message: `Runtime "${kernel.runtimeId}" cannot compile handlers.`,
          },
        };
      if (!result.ok) {
        return {
          ok: false,
          error:
            `Failed to recompile handler "${h.name}": ${result.error?.message}`,
        };
      }
      kernel.handlers.register(
        h.name,
        h.source,
        result.data,
        h.schema,
        h.module,
        h.runtimeId ?? defaultRuntimeId,
        h.language ?? defaultLanguage,
        h.purpose,
      );
    }

    // Restore user-created dev views
    for (const v of kernel.devViews.list()) {
      if (!v.builtIn) kernel.devViews.remove(v.name);
    }
    const inspect = kernelInspectAPI(kernel);
    for (const v of snapshot.devViews ?? []) {
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
        );
      }
    }

    // Restore dev tools
    kernel.devTools.clear();
    for (const t of snapshot.devTools ?? []) {
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
        );
      }
    }

    // Restore tests
    kernel.tests.clear();
    for (const t of snapshot.tests ?? []) {
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
        );
      }
    }

    // Restore routes
    kernel.routes.restore(snapshot.routes);
    rebuild();

    return { ok: true };
  }

  list(): SnapshotMetadata[] {
    return this.snapshots.map((s) => s.metadata);
  }

  get(id: string): SnapshotMetadata | undefined {
    return this.snapshots.find((s) => s.metadata.id === id)?.metadata;
  }

  delete(id: string): boolean {
    this.branchSnapshots.delete(id);
    const idx = this.snapshots.findIndex((s) => s.metadata.id === id);
    if (idx === -1) return false;
    this.snapshots.splice(idx, 1);
    return true;
  }

  pinForBranch(id: string): void {
    const snap = this.snapshots.find((s) => s.metadata.id === id);
    if (snap) this.branchSnapshots.set(id, snap);
  }

  unpinBranch(id: string): void {
    this.branchSnapshots.delete(id);
  }

  getBranchSnapshot(id: string): SnapshotData | undefined {
    return this.branchSnapshots.get(id);
  }

  setBranchSnapshot(id: string, data: SnapshotData): void {
    this.branchSnapshots.set(id, data);
  }
}

async function restoreTables(
  snapshot: SnapshotData,
  kernel: Kernel,
): Promise<void> {
  for (const schema of await kernel.db.listSchemas()) {
    await kernel.db.dropSchema(schema.tableName);
  }
  for (const table of snapshot.tables) {
    await kernel.db.defineSchema(table.tableName, table.sql, table.module);
    if (table.rows.length > 0) {
      const columns = Object.keys(table.rows[0]!);
      for (const col of columns) {
        // deno-lint-ignore no-control-regex -- the NUL byte is exactly what this rejects: it terminates a C string and would truncate the quoted identifier server-side
        if (/["\\\x00]/.test(col)) {
          throw new Error(`Invalid column name in snapshot: "${col}"`);
        }
      }
      const BATCH_SIZE = 100;
      for (let i = 0; i < table.rows.length; i += BATCH_SIZE) {
        const batch = table.rows.slice(i, i + BATCH_SIZE);
        const valuesClauses: string[] = [];
        const params: unknown[] = [];
        for (let j = 0; j < batch.length; j++) {
          const row = batch[j]!;
          const offset = j * columns.length;
          valuesClauses.push(
            `(${columns.map((_, k) => `$${offset + k + 1}`).join(", ")})`,
          );
          for (const c of columns) params.push(row[c]);
        }
        await kernel.db.execute(
          `INSERT INTO "${table.tableName}" (${
            columns.map((c) => `"${c}"`).join(", ")
          }) VALUES ${valuesClauses.join(", ")}`,
          params,
        );
      }
    }
  }
}
