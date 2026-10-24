// @layer core — regrouping an entity under another module. One verb-agnostic
// primitive shared by move_to_module and rename_module, so both write the same
// per-entity changelog record with real before/after snapshots.
import type { ChangeCategory, ChangeContext } from "../changelog.ts";
import type { Kernel } from "../registries.ts";
import { assetSnapshot, assetSnapshotRestorable } from "./asset-snapshot.ts";
import type { Result } from "../types.ts";

export const MODULE_MOVE_CATEGORIES = [
  "handler",
  "function",
  "route",
  "template",
  "asset",
  "schema",
  "test",
  "dev_view",
  "dev_tool",
] as const satisfies readonly ChangeCategory[];

export type ModuleMoveCategory = typeof MODULE_MOVE_CATEGORIES[number];

export interface ModuleMove {
  category: ModuleMoveCategory;
  key: string;
  before: Record<string, unknown>;
  after: Record<string, unknown>;
  // False only for an asset whose bytes had nowhere to go (no project dir).
  undoable: boolean;
}

function withModule<T extends Record<string, unknown>>(
  base: T,
  module: string | undefined,
): T & { module?: string } {
  return { ...base, ...(module ? { module } : {}) };
}

function notFound(label: string, key: string): Result<ModuleMove> {
  return {
    ok: false,
    error: { code: "NOT_FOUND", message: `${label} "${key}" not found.` },
  };
}

function moved(
  category: ModuleMoveCategory,
  key: string,
  base: Record<string, unknown>,
  from: string | undefined,
  to: string | undefined,
  undoable = true,
): Result<ModuleMove> {
  return {
    ok: true,
    data: {
      category,
      key,
      before: withModule(base, from),
      after: withModule(base, to),
      undoable,
    },
  };
}

export function isModuleMoveCategory(
  category: string,
): category is ModuleMoveCategory {
  return (MODULE_MOVE_CATEGORIES as readonly string[]).includes(category);
}

// Re-registers one entity under `module` (undefined = ungrouped) and returns the
// snapshots to record. Never recompiles and never runs DDL.
export async function moveEntityToModule(
  kernel: Kernel,
  category: ModuleMoveCategory,
  key: string,
  module: string | undefined,
): Promise<Result<ModuleMove>> {
  switch (category) {
    case "handler": {
      const h = kernel.handlers.get(key);
      if (!h) return notFound("Handler", key);
      kernel.handlers.register(
        h.name,
        h.source,
        h.fn,
        h.schema,
        module,
        h.runtimeId,
        h.language,
        h.purpose,
      );
      return moved(
        category,
        key,
        {
          name: h.name,
          source: h.source,
          ...(h.schema ? { schema: h.schema } : {}),
          ...(h.purpose ? { purpose: h.purpose } : {}),
          runtimeId: h.runtimeId,
          language: h.language,
        },
        h.module,
        module,
      );
    }
    case "function": {
      const f = kernel.functions.getEntry(key);
      if (!f) return notFound("Function", key);
      kernel.functions.register(
        f.name,
        f.source,
        f.fn,
        module,
        f.returnType,
        f.runtimeId,
        f.language,
        f.purpose,
      );
      return moved(
        category,
        key,
        {
          name: f.name,
          source: f.source,
          ...(f.returnType ? { returnType: f.returnType } : {}),
          ...(f.purpose ? { purpose: f.purpose } : {}),
          runtimeId: f.runtimeId,
          language: f.language,
        },
        f.module,
        module,
      );
    }
    case "route": {
      const [method, ...pathParts] = key.split(" ");
      const r = kernel.routes.get(method!, pathParts.join(" "));
      if (!r) return notFound("Route", key);
      kernel.routes.register(r.method, r.path, r.handlerName, r.schema, module);
      return moved(
        category,
        `${r.method} ${r.path}`,
        {
          method: r.method,
          path: r.path,
          handlerName: r.handlerName,
          ...(r.schema ? { schema: r.schema } : {}),
        },
        r.module,
        module,
      );
    }
    case "template": {
      const t = kernel.templates.getEntry(key);
      if (!t) return notFound("Template", key);
      kernel.templates.register(t.name, t.content, module);
      return moved(
        category,
        key,
        { name: t.name, content: t.content },
        t.module,
        module,
      );
    }
    case "asset": {
      const a = kernel.assets.get(key);
      if (!a) return notFound("Asset", key);
      kernel.assets.register(a.name, a.content, a.mimeType, module);
      const { module: _from, ...rest } = assetSnapshot(kernel, a);
      return moved(
        category,
        key,
        rest,
        a.module,
        module,
        assetSnapshotRestorable(rest),
      );
    }
    case "schema": {
      const s = await kernel.db.getSchema(key);
      if (!s.ok) return notFound("Schema", key);
      const updated = await kernel.db.setSchemaModule(key, module);
      if (!updated.ok) return updated;
      return moved(
        category,
        key,
        { tableName: key, moduleOnly: true },
        s.data.module,
        module,
      );
    }
    case "test": {
      const t = kernel.tests.get(key);
      if (!t) return notFound("Test", key);
      kernel.tests.register(
        t.name,
        t.source,
        t.fn,
        module,
        t.changesetId,
        t.runtimeId,
        t.language,
        t.verification,
      );
      return moved(
        category,
        key,
        {
          name: t.name,
          source: t.source,
          ...(t.changesetId ? { changesetId: t.changesetId } : {}),
          ...(t.verification ? { verification: t.verification } : {}),
          runtimeId: t.runtimeId,
          language: t.language,
        },
        t.module,
        module,
      );
    }
    case "dev_view": {
      const v = kernel.devViews.get(key);
      if (!v) return notFound("Dev view", key);
      if (v.builtIn) {
        return {
          ok: false,
          error: {
            code: "CANNOT_MOVE",
            message: `Cannot move built-in dev view "${key}".`,
          },
        };
      }
      kernel.devViews.register(
        v.name,
        v.targetType,
        v.title,
        v.source,
        v.fn,
        false,
        module,
        v.runtimeId,
        v.language,
      );
      return moved(
        category,
        key,
        {
          name: v.name,
          targetType: v.targetType,
          title: v.title,
          source: v.source,
          runtimeId: v.runtimeId,
          language: v.language,
        },
        v.module,
        module,
      );
    }
    case "dev_tool": {
      const t = kernel.devTools.get(key);
      if (!t) return notFound("Dev tool", key);
      kernel.devTools.register(
        t.name,
        t.description,
        t.args,
        t.source,
        t.fn,
        module,
        t.runtimeId,
        t.language,
      );
      return moved(
        category,
        key,
        {
          name: t.name,
          description: t.description,
          args: t.args,
          source: t.source,
          runtimeId: t.runtimeId,
          language: t.language,
        },
        t.module,
        module,
      );
    }
  }
}

// Every entity currently grouped under `module`, as move targets.
export async function entitiesInModule(
  kernel: Kernel,
  module: string,
): Promise<Array<{ category: ModuleMoveCategory; key: string }>> {
  const of = (
    category: ModuleMoveCategory,
    entries: Array<{ key: string; module?: string }>,
  ) =>
    entries.filter((e) => e.module === module).map((e) => ({
      category,
      key: e.key,
    }));
  const named = (list: Array<{ name: string; module?: string }>) =>
    list.map((e) => ({ key: e.name, module: e.module }));
  return [
    ...of(
      "route",
      kernel.routes.list().map((r) => ({
        key: `${r.method} ${r.path}`,
        module: r.module,
      })),
    ),
    ...of("handler", named(kernel.handlers.list())),
    ...of("function", named(kernel.functions.list())),
    ...of("test", named(kernel.tests.list())),
    ...of("template", named(kernel.templates.list())),
    ...of("asset", named(kernel.assets.list())),
    ...of("dev_view", named(kernel.devViews.list().filter((v) => !v.builtIn))),
    ...of("dev_tool", named(kernel.devTools.list())),
    ...of(
      "schema",
      (await kernel.db.listSchemas()).map((s) => ({
        key: s.tableName,
        module: s.module,
      })),
    ),
  ];
}

export async function recordModuleMove(
  kernel: Kernel,
  move: ModuleMove,
  context: ChangeContext | null,
): Promise<void> {
  await kernel.changelog.record({
    category: move.category,
    key: move.key,
    action: "update",
    beforeSnapshot: move.before,
    afterSnapshot: move.after,
    context,
    undoable: move.undoable,
  });
}
