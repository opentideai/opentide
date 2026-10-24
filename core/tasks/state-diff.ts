// @layer core — the 3-way diff a task merge runs on: the fork's state at fork time
// (base), the fork now, and main now. Pure: the caller loads all three. What only
// the fork changed is applied; what both changed differently is a conflict; what
// only main changed is ignored. Things a merge never carries (rows, documents,
// secret values, schema drops) are reported instead (docs/opentide-task-forks-plan.md
// Slice 4).
import { canonicalizeJson } from "../fingerprint.ts";
import type { PersistedState } from "../persistence.ts";
import { DEFAULT_RUNTIME_ID } from "../runtime.ts";
import type { MigrationEntry, SchemaEntry } from "../types.ts";
import type {
  Change,
  ChangeOp,
  Conflict,
  DiffCategory,
  Note,
  StateDiffCategory,
  TaskStateDiff,
} from "../../shared/tasks.ts";

export type {
  Change,
  ChangeOp,
  Conflict,
  DiffCategory,
  Note,
  NoteKind,
  NoteSeverity,
  StateDiffCategory,
  TaskStateDiff,
} from "../../shared/tasks.ts";

// State categories in apply order. Schema goes before all of them, project files
// after; deletes run last, in reverse.
export const STATE_DIFF_CATEGORIES = [
  "types",
  "configs",
  "envVars",
  "packages",
  "functions",
  "handlers",
  "routes",
  "templates",
  "assets",
  "devViews",
  "devTools",
  "tests",
  "customAudits",
] as const satisfies readonly StateDiffCategory[];

// Every category in the wire type has a place in the apply order.
type UnorderedCategory = Exclude<
  StateDiffCategory,
  typeof STATE_DIFF_CATEGORIES[number]
>;
const _everyCategoryOrdered: UnorderedCategory extends never ? true : never =
  true;

export const ENV_FILE_PATH = ".env";
// Generated from the registries by generate_project_docs and never hand-edited.
// Two forks that both regenerate it would always conflict, so instead of
// copying the fork's text the merge regenerates it on main.
export const GENERATED_DOC_PATH = "AGENT.md";

// Bookkeeping that changes without the entity changing: timestamps, revision
// counters, identity, and test evidence (void on main anyway).
const VOLATILE_FIELDS = new Set([
  "registeredAt",
  "updatedAt",
  "createdAt",
  "installedAt",
  "revision",
  "entityUid",
  "lastResult",
  "verification",
  "changesetId",
]);

// Categories whose entries carry a runtime and a source language. An entry
// written before those fields existed gets them on its next load, which isn't
// an edit.
const RUNTIME_CATEGORIES = new Set<StateDiffCategory>([
  "functions",
  "handlers",
  "devViews",
  "devTools",
  "tests",
]);

// What the loader fills in for an entry that has no runtimeId or language.
export interface EntryDefaults {
  runtimeId: string;
  language: string;
}

const TYPESCRIPT_DEFAULTS: EntryDefaults = {
  runtimeId: DEFAULT_RUNTIME_ID,
  language: "typescript",
};

export interface SchemaState {
  tables: Record<string, SchemaEntry>;
  migrations: Record<string, MigrationEntry[]>;
}

// A project file by content hash. `text` is null for a binary or oversized file,
// and always null on the base side, which keeps hashes only.
export interface DiffFile {
  sha256: string;
  text: string | null;
}

export interface DiffSide {
  state: PersistedState;
  schema: SchemaState;
  // Null when the side has no record of its files (a fork cut before bases kept
  // them).
  files: Record<string, DiffFile> | null;
  // Project document blob paths, relative to the documents dir.
  documents: string[];
}

// A merge may go ahead with warnings outstanding, never with a conflict or a
// blocking note.
export function diffBlocksMerge(diff: TaskStateDiff): boolean {
  return diff.conflicts.length > 0 ||
    diff.notMerged.some((n) => n.severity === "blocking");
}

interface Entity {
  // entityUid where the category has one, so a rename keeps its identity.
  id: string;
  key: string;
  content: string;
  entry: unknown;
}

interface EntityDiff {
  apply: Change[];
  conflicts: Conflict[];
}

function contentOf(
  entry: Record<string, unknown>,
  keyFields: string[],
): string {
  const kept = Object.fromEntries(
    Object.entries(entry).filter(([k]) =>
      !VOLATILE_FIELDS.has(k) && !keyFields.includes(k)
    ),
  );
  return JSON.stringify(canonicalizeJson(kept));
}

function keyFieldsOf(category: StateDiffCategory): string[] {
  if (category === "routes") return ["method", "path"];
  if (category === "envVars") return ["key"];
  return ["name"];
}

function keyOf(category: StateDiffCategory, entry: Record<string, unknown>) {
  if (category === "routes") return `${entry.method} ${entry.path}`;
  return String(category === "envVars" ? entry.key : entry.name);
}

function withLoadDefaults(
  entry: Record<string, unknown>,
  runtimeId: string,
  language: string,
): Record<string, unknown> {
  return {
    ...entry,
    runtimeId: entry.runtimeId ?? runtimeId,
    language: entry.language ?? language,
  };
}

function stateEntities(
  state: PersistedState,
  category: StateDiffCategory,
  defaults: EntryDefaults,
): Entity[] {
  const entries = (state[category] ?? []) as Array<Record<string, unknown>>;
  const runtimeId = state.runtimeId ?? defaults.runtimeId;
  return entries.map((entry) => {
    const key = keyOf(category, entry);
    const uid = entry.entityUid;
    const compared = RUNTIME_CATEGORIES.has(category)
      ? withLoadDefaults(entry, runtimeId, defaults.language)
      : entry;
    return {
      id: typeof uid === "string" ? uid : `key:${key}`,
      key,
      content: contentOf(compared, keyFieldsOf(category)),
      entry,
    };
  });
}

function byId(entities: Entity[]): Map<string, Entity> {
  return new Map(entities.map((e) => [e.id, e]));
}

function byKey(entities: Entity[]): Map<string, Entity> {
  return new Map(entities.map((e) => [e.key, e]));
}

function same(a: Entity | undefined, b: Entity | undefined): boolean {
  return !!a && !!b && a.key === b.key && a.content === b.content;
}

// The fork changed an entity that was in the base: apply it if main left it
// alone, skip it if main made the identical change, conflict otherwise.
function forkChanged(
  category: DiffCategory,
  base: Entity,
  fork: Entity,
  main: { byId: Map<string, Entity>; byKey: Map<string, Entity> },
): EntityDiff {
  const m = main.byId.get(base.id);
  if (same(m, fork)) return { apply: [], conflicts: [] };
  if (!same(m, base)) {
    return {
      apply: [],
      conflicts: [{
        category,
        key: fork.key,
        reason: m
          ? `Changed in both the fork and main.`
          : `Deleted in main, changed in the fork.`,
      }],
    };
  }
  const renamed = fork.key !== base.key;
  const taken = main.byKey.get(fork.key);
  if (renamed && taken && taken.id !== base.id) {
    return {
      apply: [],
      conflicts: [{
        category,
        key: fork.key,
        reason: `The fork renamed "${base.key}" to a name main already uses.`,
      }],
    };
  }
  const change: Change = renamed
    ? {
      category,
      key: fork.key,
      op: "rename",
      renamedFrom: base.key,
      entry: fork.entry,
      ...(fork.content !== base.content ? { contentChanged: true } : {}),
    }
    : { category, key: fork.key, op: "update", entry: fork.entry };
  return { apply: [change], conflicts: [] };
}

function forkDeleted(
  category: DiffCategory,
  base: Entity,
  main: Map<string, Entity>,
): EntityDiff {
  const m = main.get(base.id);
  if (!m) return { apply: [], conflicts: [] };
  if (same(m, base)) {
    return {
      apply: [{ category, key: base.key, op: "delete" }],
      conflicts: [],
    };
  }
  return {
    apply: [],
    conflicts: [{
      category,
      key: base.key,
      reason: "Changed in main, deleted in the fork.",
    }],
  };
}

// `vacated` holds the base entities the fork renamed or deleted: main still has
// them under their old names, which the fork is free to reuse.
function forkCreated(
  category: DiffCategory,
  fork: Entity,
  main: Map<string, Entity>,
  vacated: Set<string>,
): EntityDiff {
  const m = main.get(fork.key);
  if (!m || vacated.has(m.id)) {
    return {
      apply: [{ category, key: fork.key, op: "create", entry: fork.entry }],
      conflicts: [],
    };
  }
  if (m.content === fork.content) return { apply: [], conflicts: [] };
  return {
    apply: [],
    conflicts: [{
      category,
      key: fork.key,
      reason: "Created in both the fork and main, differently.",
    }],
  };
}

// A delete and a create of the same name in one category is a replacement,
// e.g. an entity removed and redefined, which mints a new identity.
function collapseReplacements(changes: Change[]): Change[] {
  const creates = new Map(
    changes.filter((c) => c.op === "create").map((c) => [c.key, c]),
  );
  const replaced = new Set(
    changes.filter((c) => c.op === "delete" && creates.has(c.key)).map((c) =>
      c.key
    ),
  );
  return changes
    .filter((c) => !(c.op === "delete" && replaced.has(c.key)))
    .map((c) =>
      c.op === "create" && replaced.has(c.key) ? { ...c, op: "update" } : c
    );
}

const OP_ORDER: Record<ChangeOp, number> = {
  rename: 0,
  update: 1,
  alter: 1,
  create: 2,
  delete: 3,
  regenerate: 4,
};

function byOpThenKey(a: Change, b: Change): number {
  return OP_ORDER[a.op] - OP_ORDER[b.op] || a.key.localeCompare(b.key);
}

function diffEntities(
  category: DiffCategory,
  base: Entity[],
  fork: Entity[],
  main: Entity[],
): EntityDiff {
  const b = byId(base);
  const f = byId(fork);
  const m = { byId: byId(main), byKey: byKey(main) };
  const parts: EntityDiff[] = [];
  const vacated = new Set<string>();
  for (const be of base) {
    const fe = f.get(be.id);
    if (!fe || fe.key !== be.key) vacated.add(be.id);
    if (!fe) parts.push(forkDeleted(category, be, m.byId));
    else if (!same(be, fe)) parts.push(forkChanged(category, be, fe, m));
  }
  for (const fe of fork) {
    if (!b.has(fe.id)) {
      parts.push(forkCreated(category, fe, m.byKey, vacated));
    }
  }
  return {
    apply: collapseReplacements(parts.flatMap((p) => p.apply)).sort(
      byOpThenKey,
    ),
    conflicts: parts.flatMap((p) => p.conflicts),
  };
}

// The statements that build a table now: its live migrations from the last
// CREATE on. A table with no migration record falls back to its definition.
function activeStatements(schema: SchemaState, table: string): string[] {
  const statements: string[] = [];
  const live = (schema.migrations[table] ?? [])
    .filter((m) => m.rolledBackAt === null)
    .sort((a, b) => a.version - b.version);
  for (const m of live) {
    const stmt = m.sql.trim().replace(/;\s*$/, "");
    if (/^\s*CREATE\s+TABLE\b/i.test(stmt)) statements.length = 0;
    statements.push(stmt);
  }
  const definition = schema.tables[table]?.sql;
  return statements.length === 0 && definition ? [definition] : statements;
}

function sameStatements(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((s, i) => s === b[i]);
}

function startsWith(all: string[], prefix: string[]): boolean {
  return prefix.length <= all.length && prefix.every((s, i) => s === all[i]);
}

interface SchemaDiff extends EntityDiff {
  notMerged: Note[];
}

function diffTable(
  table: string,
  base: DiffSide,
  fork: DiffSide,
  main: DiffSide,
): SchemaDiff {
  const none: SchemaDiff = { apply: [], conflicts: [], notMerged: [] };
  const inBase = table in base.schema.tables;
  const inFork = table in fork.schema.tables;
  const inMain = table in main.schema.tables;
  const conflict = (reason: string): SchemaDiff => ({
    ...none,
    conflicts: [{ category: "schema", key: table, reason }],
  });
  const f = activeStatements(fork.schema, table);
  const m = activeStatements(main.schema, table);
  if (inBase && !inFork) {
    return inMain
      ? {
        ...none,
        notMerged: [{
          kind: "schema-drop",
          severity: "blocking",
          key: table,
          message: `The fork dropped table "${table}". Drops don't merge.`,
        }],
      }
      : none;
  }
  if (!inBase) {
    if (!inMain) {
      return {
        ...none,
        apply: [{
          category: "schema",
          key: table,
          op: "create",
          statements: f,
        }],
      };
    }
    return sameStatements(f, m)
      ? none
      : conflict("Created in both the fork and main, differently.");
  }
  const b = activeStatements(base.schema, table);
  if (sameStatements(f, b)) return none;
  if (!startsWith(f, b)) {
    return {
      ...none,
      notMerged: [{
        kind: "schema-undo",
        severity: "blocking",
        key: table,
        message:
          `The fork undid a migration on "${table}" that main has. Undos don't merge.`,
      }],
    };
  }
  if (!inMain) return conflict("Dropped in main, altered in the fork.");
  if (sameStatements(m, f)) return none;
  if (!sameStatements(m, b)) {
    return conflict("Altered in both the fork and main.");
  }
  return {
    ...none,
    apply: [{
      category: "schema",
      key: table,
      op: "alter",
      statements: f.slice(b.length),
    }],
  };
}

function diffSchema(
  base: DiffSide,
  fork: DiffSide,
  main: DiffSide,
): SchemaDiff {
  const tables = [
    ...new Set([
      ...Object.keys(base.schema.tables),
      ...Object.keys(fork.schema.tables),
    ]),
  ].sort();
  const parts = tables.map((t) => diffTable(t, base, fork, main));
  const apply = parts.flatMap((p) => p.apply);
  return {
    // Creates first: an alter may reference a table the fork created.
    apply: [
      ...apply.filter((c) => c.op === "create"),
      ...apply.filter((c) => c.op === "alter"),
    ],
    conflicts: parts.flatMap((p) => p.conflicts),
    notMerged: parts.flatMap((p) => p.notMerged),
  };
}

function fileEntities(files: Record<string, DiffFile>): Entity[] {
  return Object.entries(files).map(([path, file]) => ({
    id: `key:${path}`,
    key: path,
    content: file.sha256,
    entry: file.text,
  }));
}

function diffFiles(base: DiffSide, fork: DiffSide, main: DiffSide): SchemaDiff {
  if (!base.files || !fork.files || !main.files) {
    return {
      apply: [],
      conflicts: [],
      notMerged: [{
        kind: "files-no-base",
        severity: "blocking",
        message:
          "This fork has no record of its starting files, so project files can't be compared.",
      }],
    };
  }
  const { apply, conflicts } = diffEntities(
    "files",
    fileEntities(base.files),
    fileEntities(fork.files),
    fileEntities(main.files),
  );
  const notMerged: Note[] = [];
  const touchesEnv = [...apply, ...conflicts].some((c) =>
    c.key === ENV_FILE_PATH
  );
  if (touchesEnv) {
    notMerged.push({
      kind: "secrets",
      severity: "warning",
      key: ENV_FILE_PATH,
      message: "The fork changed .env. Secret values don't merge.",
    });
  }
  // A delete is judged by main's copy, which is the one it would remove.
  const mainFiles = main.files;
  const binary = apply.filter((c) =>
    c.op === "delete" ? mainFiles[c.key]?.text === null : c.entry === null
  );
  for (const c of binary) {
    notMerged.push({
      kind: "binary-file",
      severity: "blocking",
      key: c.key,
      message: `"${c.key}" is binary or over the size limit and doesn't merge.`,
    });
  }
  const regenerate = regeneratesDoc(base.files, fork.files);
  const skipped = new Set([
    ENV_FILE_PATH,
    ...binary.map((c) => c.key),
    ...(regenerate ? [GENERATED_DOC_PATH] : []),
  ]);
  return {
    apply: [
      ...apply.filter((c) => !skipped.has(c.key)),
      ...(regenerate ? [regenerate] : []),
    ],
    conflicts: conflicts.filter((c) => !skipped.has(c.key)),
    notMerged,
  };
}

// The fork changed the generated doc and still has one: regenerate it on main.
function regeneratesDoc(
  base: Record<string, DiffFile>,
  fork: Record<string, DiffFile>,
): Change | null {
  const forkDoc = fork[GENERATED_DOC_PATH];
  if (!forkDoc || forkDoc.sha256 === base[GENERATED_DOC_PATH]?.sha256) {
    return null;
  }
  return { category: "files", key: GENERATED_DOC_PATH, op: "regenerate" };
}

function documentNotes(base: DiffSide, fork: DiffSide): Note[] {
  const known = new Set(base.documents);
  const added = fork.documents.filter((d) => !known.has(d));
  return added.length === 0 ? [] : [{
    kind: "documents",
    severity: "warning",
    message:
      `The fork wrote ${added.length} document version(s). Documents don't merge.`,
  }];
}

const ROWS_NOTE: Note = {
  kind: "rows",
  severity: "info",
  message: "App data rows stay in the fork. Only code, schema and files merge.",
};

export function diffTaskState(
  base: DiffSide,
  fork: DiffSide,
  main: DiffSide,
  defaults: EntryDefaults = TYPESCRIPT_DEFAULTS,
): TaskStateDiff {
  const schema = diffSchema(base, fork, main);
  const state = STATE_DIFF_CATEGORIES.map((category) =>
    diffEntities(
      category,
      stateEntities(base.state, category, defaults),
      stateEntities(fork.state, category, defaults),
      stateEntities(main.state, category, defaults),
    )
  );
  const files = diffFiles(base, fork, main);
  const ordered = [
    ...schema.apply,
    ...state.flatMap((s) => s.apply),
    ...files.apply,
  ];
  return {
    // Regeneration reads the registries, so it runs after every other change.
    apply: [
      ...ordered.filter((c) => c.op !== "delete" && c.op !== "regenerate"),
      ...ordered.filter((c) => c.op === "delete").reverse(),
      ...ordered.filter((c) => c.op === "regenerate"),
    ],
    conflicts: [
      ...schema.conflicts,
      ...state.flatMap((s) => s.conflicts),
      ...files.conflicts,
    ],
    notMerged: [
      ...schema.notMerged,
      ...files.notMerged,
      ...documentNotes(base, fork),
      ROWS_NOTE,
    ],
  };
}
