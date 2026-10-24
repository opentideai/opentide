import { assertEquals } from "@std/assert";
import type { PersistedState } from "../persistence.ts";
import type { MigrationEntry, SchemaEntry } from "../types.ts";
import {
  type Change,
  diffBlocksMerge,
  type DiffFile,
  type DiffSide,
  diffTaskState,
  type SchemaState,
} from "./state-diff.ts";

const T0 = "2026-10-01T00:00:00.000Z";
const T1 = "2026-10-02T00:00:00.000Z";

type Handler = PersistedState["handlers"][number];

function handler(name: string, source: string, uid = `uid_${name}`): Handler {
  return { name, source, registeredAt: T0, revision: 1, entityUid: uid };
}

function emptyState(): PersistedState {
  return {
    version: 1,
    routes: [],
    handlers: [],
    functions: [],
    templates: [],
    assets: [],
    packages: [],
    devViews: [],
  };
}

function side(over: {
  handlers?: Handler[];
  routes?: PersistedState["routes"];
  schema?: SchemaState;
  files?: Record<string, DiffFile> | null;
  documents?: string[];
} = {}): DiffSide {
  return {
    state: {
      ...emptyState(),
      handlers: over.handlers ?? [],
      routes: over.routes ?? [],
    },
    schema: over.schema ?? { tables: {}, migrations: {} },
    files: over.files === undefined ? {} : over.files,
    documents: over.documents ?? [],
  };
}

function migration(
  table: string,
  version: number,
  sql: string,
  rolledBackAt: string | null = null,
): MigrationEntry {
  return {
    id: version,
    tableName: table,
    version,
    sql,
    reverseSql: null,
    reversible: true,
    columnsBefore: [],
    columnsAfter: [],
    appliedAt: T0,
    rolledBackAt,
    turnId: null,
  };
}

function table(name: string): SchemaEntry {
  return {
    tableName: name,
    columns: [],
    sql: `CREATE TABLE ${name} (id SERIAL PRIMARY KEY)`,
    createdAt: T0,
    updatedAt: T0,
  };
}

const CREATE_ITEMS = "CREATE TABLE items (id SERIAL PRIMARY KEY)";
const ADD_NOTE = "ALTER TABLE items ADD COLUMN note TEXT";
const ADD_TAG = "ALTER TABLE items ADD COLUMN tag TEXT";

function items(...statements: string[]): SchemaState {
  return {
    tables: { items: table("items") },
    migrations: {
      items: statements.map((sql, i) => migration("items", i + 1, sql)),
    },
  };
}

function file(text: string | null, sha = `sha:${text}`): DiffFile {
  return { sha256: sha, text };
}

function summary(changes: Change[]): string[] {
  return changes.map((c) =>
    `${c.op} ${c.category}:${c.key}${
      c.renamedFrom ? ` from ${c.renamedFrom}` : ""
    }`
  );
}

function stateOnly(d: ReturnType<typeof diffTaskState>) {
  return {
    apply: summary(d.apply),
    conflicts: d.conflicts.map((c) => `${c.category}:${c.key}`),
    blocking: d.notMerged.filter((n) => n.severity !== "info").map((n) =>
      `${n.severity} ${n.kind}${n.key ? `:${n.key}` : ""}`
    ),
  };
}

const a = handler("a", "v1");

const handlerCases: Array<{
  name: string;
  base: Handler[];
  fork: Handler[];
  main: Handler[];
  apply: string[];
  conflicts: string[];
}> = [
  {
    name: "fork-only edit applies",
    base: [a],
    fork: [handler("a", "v2")],
    main: [a],
    apply: ["update handlers:a"],
    conflicts: [],
  },
  {
    name: "both edited differently conflicts",
    base: [a],
    fork: [handler("a", "v2")],
    main: [handler("a", "v3")],
    apply: [],
    conflicts: ["handlers:a"],
  },
  {
    name: "both made the same edit",
    base: [a],
    fork: [handler("a", "v2")],
    main: [handler("a", "v2")],
    apply: [],
    conflicts: [],
  },
  {
    name: "main-only edit is ignored",
    base: [a],
    fork: [a],
    main: [handler("a", "v3")],
    apply: [],
    conflicts: [],
  },
  {
    name: "bookkeeping fields don't count as edits",
    base: [a],
    fork: [{ ...a, registeredAt: T1, revision: 4 }],
    main: [a],
    apply: [],
    conflicts: [],
  },
  {
    name: "a rename keeps its identity",
    base: [a],
    fork: [handler("b", "v1", "uid_a")],
    main: [a],
    apply: ["rename handlers:b from a"],
    conflicts: [],
  },
  {
    name: "a rename onto a name main took conflicts",
    base: [a],
    fork: [handler("b", "v1", "uid_a")],
    main: [a, handler("b", "other")],
    apply: [],
    conflicts: ["handlers:b"],
  },
  {
    name: "rename, then reuse the old name",
    base: [a],
    fork: [handler("b", "v1", "uid_a"), handler("a", "new", "uid_new")],
    main: [a],
    apply: ["rename handlers:b from a", "create handlers:a"],
    conflicts: [],
  },
  {
    name: "fork-only delete applies",
    base: [a],
    fork: [],
    main: [a],
    apply: ["delete handlers:a"],
    conflicts: [],
  },
  {
    name: "fork deleted what main edited",
    base: [a],
    fork: [],
    main: [handler("a", "v3")],
    apply: [],
    conflicts: ["handlers:a"],
  },
  {
    name: "both deleted",
    base: [a],
    fork: [],
    main: [],
    apply: [],
    conflicts: [],
  },
  {
    name: "fork-only create applies",
    base: [],
    fork: [a],
    main: [],
    apply: ["create handlers:a"],
    conflicts: [],
  },
  {
    name: "both created differently conflicts",
    base: [],
    fork: [handler("a", "v1", "uid_f")],
    main: [handler("a", "v2", "uid_m")],
    apply: [],
    conflicts: ["handlers:a"],
  },
  {
    name: "delete and redefine is an edit",
    base: [a],
    fork: [handler("a", "v2", "uid_new")],
    main: [a],
    apply: ["update handlers:a"],
    conflicts: [],
  },
];

for (const c of handlerCases) {
  Deno.test(`diffTaskState handlers: ${c.name}`, () => {
    const d = stateOnly(diffTaskState(
      side({ handlers: c.base }),
      side({ handlers: c.fork }),
      side({ handlers: c.main }),
    ));
    assertEquals(d.apply, c.apply);
    assertEquals(d.conflicts, c.conflicts);
  });
}

Deno.test("diffTaskState keys routes by method and path", () => {
  const route = {
    method: "GET",
    path: "/api/a",
    handlerName: "a",
    registeredAt: T0,
  };
  const d = diffTaskState(side(), side({ routes: [route] }), side());
  assertEquals(summary(d.apply), ["create routes:GET /api/a"]);
});

const schemaCases: Array<{
  name: string;
  base: SchemaState;
  fork: SchemaState;
  main: SchemaState;
  apply: string[];
  statements?: string[];
  conflicts: string[];
  blocking: string[];
}> = [
  {
    name: "fork-only alter applies its new statements",
    base: items(CREATE_ITEMS),
    fork: items(CREATE_ITEMS, ADD_NOTE),
    main: items(CREATE_ITEMS),
    apply: ["alter schema:items"],
    statements: [ADD_NOTE],
    conflicts: [],
    blocking: [],
  },
  {
    name: "an alter on a table main also altered conflicts",
    base: items(CREATE_ITEMS),
    fork: items(CREATE_ITEMS, ADD_NOTE),
    main: items(CREATE_ITEMS, ADD_TAG),
    apply: [],
    conflicts: ["schema:items"],
    blocking: [],
  },
  {
    name: "a rolled-back migration doesn't count",
    base: items(CREATE_ITEMS),
    fork: {
      tables: { items: table("items") },
      migrations: {
        items: [
          migration("items", 1, CREATE_ITEMS),
          migration("items", 2, ADD_TAG, T1),
          migration("items", 3, ADD_NOTE),
        ],
      },
    },
    main: items(CREATE_ITEMS),
    apply: ["alter schema:items"],
    statements: [ADD_NOTE],
    conflicts: [],
    blocking: [],
  },
  {
    name: "a new table applies its statements",
    base: { tables: {}, migrations: {} },
    fork: items(CREATE_ITEMS, ADD_NOTE),
    main: { tables: {}, migrations: {} },
    apply: ["create schema:items"],
    statements: [CREATE_ITEMS, ADD_NOTE],
    conflicts: [],
    blocking: [],
  },
  {
    name: "a drop doesn't merge",
    base: items(CREATE_ITEMS),
    fork: { tables: {}, migrations: {} },
    main: items(CREATE_ITEMS),
    apply: [],
    conflicts: [],
    blocking: ["blocking schema-drop:items"],
  },
  {
    name: "an undo of a base migration doesn't merge",
    base: items(CREATE_ITEMS, ADD_NOTE),
    fork: {
      tables: { items: table("items") },
      migrations: {
        items: [
          migration("items", 1, CREATE_ITEMS),
          migration("items", 2, ADD_NOTE, T1),
        ],
      },
    },
    main: items(CREATE_ITEMS, ADD_NOTE),
    apply: [],
    conflicts: [],
    blocking: ["blocking schema-undo:items"],
  },
];

for (const c of schemaCases) {
  Deno.test(`diffTaskState schema: ${c.name}`, () => {
    const diff = diffTaskState(
      side({ schema: c.base }),
      side({ schema: c.fork }),
      side({ schema: c.main }),
    );
    const d = stateOnly(diff);
    assertEquals(d.apply, c.apply);
    assertEquals(d.conflicts, c.conflicts);
    assertEquals(d.blocking, c.blocking);
    if (c.statements) assertEquals(diff.apply[0]?.statements, c.statements);
  });
}

Deno.test("diffTaskState files: text merges, .env and binaries don't", () => {
  const base = {
    "notes.md": file(null, "sha:v1"),
    "old.md": file(null, "sha:old"),
    ".env": file(null, "sha:env1"),
  };
  const d = diffTaskState(
    side({ files: base }),
    side({
      files: {
        "notes.md": file("v2"),
        "new.md": file("new"),
        ".env": file("KEY=2", "sha:env2"),
        "logo.png": file(null, "sha:png"),
      },
    }),
    side({
      files: {
        "notes.md": file("v1", "sha:v1"),
        "old.md": file("old", "sha:old"),
        ".env": file("KEY=1", "sha:env1"),
      },
    }),
  );
  assertEquals(summary(d.apply), [
    "update files:notes.md",
    "create files:new.md",
    "delete files:old.md",
  ]);
  assertEquals(d.apply[0]?.entry, "v2");
  assertEquals(stateOnly(d).blocking, [
    "warning secrets:.env",
    "blocking binary-file:logo.png",
  ]);
  assertEquals(diffBlocksMerge(d), true);
});

Deno.test("diffTaskState files: deleting a binary file blocks", () => {
  const png = file(null, "sha:png");
  const d = diffTaskState(
    side({ files: { "logo.png": png } }),
    side({ files: {} }),
    side({ files: { "logo.png": png } }),
  );
  assertEquals(d.apply, []);
  assertEquals(stateOnly(d).blocking, ["blocking binary-file:logo.png"]);
});

Deno.test("diffTaskState files: AGENT.md regenerates last instead of conflicting", () => {
  const base = { "AGENT.md": file("v1") };
  const d = diffTaskState(
    side({ files: base }),
    side({ handlers: [a], files: { "AGENT.md": file("fork") } }),
    side({ files: { "AGENT.md": file("main") } }),
  );
  assertEquals(stateOnly(d), {
    apply: ["create handlers:a", "regenerate files:AGENT.md"],
    conflicts: [],
    blocking: [],
  });

  const untouched = diffTaskState(
    side({ files: base }),
    side({ handlers: [a], files: base }),
    side({ files: { "AGENT.md": file("main") } }),
  );
  assertEquals(summary(untouched.apply), ["create handlers:a"]);
});

Deno.test("diffTaskState files: no base record blocks the merge", () => {
  const d = diffTaskState(side({ files: null }), side(), side());
  assertEquals(stateOnly(d).blocking, ["blocking files-no-base"]);
});

Deno.test("diffTaskState documents warn and don't block", () => {
  const d = diffTaskState(
    side({ documents: ["ab/one"] }),
    side({ documents: ["ab/one", "cd/two"] }),
    side({ documents: ["ab/one"] }),
  );
  assertEquals(stateOnly(d).blocking, ["warning documents"]);
  assertEquals(d.notMerged.some((n) => n.kind === "rows"), true);
  assertEquals(diffBlocksMerge(d), false);
});

Deno.test("diffTaskState orders creates and edits forward, deletes in reverse", () => {
  const d = diffTaskState(
    side({
      handlers: [a],
      schema: items(CREATE_ITEMS),
      files: { "old.md": file(null, "sha:old") },
    }),
    side({
      handlers: [handler("b", "v1")],
      schema: {
        tables: { items: table("items"), extra: table("extra") },
        migrations: {
          items: [
            migration("items", 1, CREATE_ITEMS),
            migration("items", 2, ADD_NOTE),
          ],
          extra: [migration("extra", 1, "CREATE TABLE extra (id INT)")],
        },
      },
      files: { "new.md": file("new") },
    }),
    side({
      handlers: [a],
      schema: items(CREATE_ITEMS),
      files: { "old.md": file("old", "sha:old") },
    }),
  );
  assertEquals(summary(d.apply), [
    "create schema:extra",
    "alter schema:items",
    "create handlers:b",
    "create files:new.md",
    "delete files:old.md",
    "delete handlers:a",
  ]);
});

Deno.test("runtime and language filled in on load aren't an edit", () => {
  const bare = handler("calcTotal", "a");
  const loaded = { ...bare, runtimeId: "typescript", language: "typescript" };
  const diff = diffTaskState(
    side({ handlers: [bare] }),
    side({ handlers: [loaded] }),
    side({ handlers: [bare] }),
  );
  assertEquals(diff.apply, []);
  const js = { ...bare, runtimeId: "typescript", language: "javascript" };
  assertEquals(
    diffTaskState(
      side({ handlers: [bare] }),
      side({ handlers: [js] }),
      side({ handlers: [bare] }),
    ).apply.map((c) => `${c.op} ${c.key}`),
    ["update calcTotal"],
  );
});
