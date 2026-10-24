import { assert, assertEquals } from "@std/assert";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { testComposition } from "../cli/test-composition.ts";
import {
  type AbandonRewind,
  pruneChangesetSnapshots,
  readChangesetSnapshot,
  takeChangesetSnapshot,
} from "./changeset-snapshots.ts";
import { initCompiler, stopCompiler } from "./compiler.ts";
import {
  OPENTIDE_MAX_CHANGESET_SNAPSHOTS_ENV,
  getKernelSettings,
  MAX_CHANGESET_SNAPSHOTS_DEFAULT,
} from "./config.ts";
import { Database } from "./db.ts";
import { getProjectPaths } from "./project-manager.ts";
import { Kernel } from "./registries.ts";
import { dispatchTool } from "./tools/dispatch.ts";

const testOpts = { sanitizeResources: false, sanitizeOps: false };
const noop = () => {};

const handlerSource = (name: string) =>
  `async function ${name}(c) { return c.json({ ok: true }); }`;

// Work done before any changeset: a handler, a table with one row, a file.
async function withBaseline(
  fn: (kernel: Kernel, projectDir: string) => Promise<void>,
): Promise<void> {
  await initCompiler();
  const prevLimit = Deno.env.get(OPENTIDE_MAX_CHANGESET_SNAPSHOTS_ENV);
  Deno.env.set(OPENTIDE_MAX_CHANGESET_SNAPSHOTS_ENV, "10");
  const db = await Database.create({ driver: "pglite" });
  const kernel = new Kernel(db, { composition: testComposition() });
  const projectDir = await Deno.makeTempDir({ prefix: "tide-cs-snapshot-" });
  kernel.projectDir = projectDir;
  try {
    const manual = { manualEdit: true };
    for (
      const [verb, input] of [
        ["define_handler", { name: "kept", source: handlerSource("kept") }],
        ["define_schema", {
          tableName: "items",
          sql: "CREATE TABLE items (id SERIAL PRIMARY KEY, name TEXT NOT NULL)",
        }],
        ["execute_sql", { sql: "INSERT INTO items (name) VALUES ('before')" }],
        ["write_project_file", { path: "notes.md", content: "v1\n" }],
      ] as const
    ) {
      const r = await dispatchTool(verb, input, kernel, noop, manual);
      assert(r.ok, `${verb}: ${JSON.stringify(r.error)}`);
    }
    await fn(kernel, projectDir);
  } finally {
    await db.close();
    stopCompiler();
    await Deno.remove(projectDir, { recursive: true });
    if (prevLimit === undefined) {
      Deno.env.delete(OPENTIDE_MAX_CHANGESET_SNAPSHOTS_ENV);
    } else Deno.env.set(OPENTIDE_MAX_CHANGESET_SNAPSHOTS_ENV, prevLimit);
  }
}

async function startChangeset(kernel: Kernel): Promise<string> {
  const created = await dispatchTool(
    "create_changeset",
    {
      title: "Add extras",
      plan: {
        summary: "Add a handler, a table, a column and files.",
        steps: ["Add them"],
        acceptanceCriteria: ["They exist."],
        verificationPlan: [{
          id: "check_extras",
          claimIds: ["claim_0"],
          kind: "unit",
          description: "The extras exist.",
        }],
      },
    },
    kernel,
    noop,
  );
  assert(created.ok, JSON.stringify(created.error));
  const id = (created.data as { id: string }).id;
  await kernel.changesets.approve(id);
  await kernel.changesets.startWork(id);
  return id;
}

async function work(kernel: Kernel): Promise<void> {
  for (
    const [verb, input] of [
      ["define_handler", {
        name: "added",
        source: handlerSource("added"),
        duplicateJustification: "Test fixture.",
      }],
      ["define_schema", {
        tableName: "extra",
        sql: "CREATE TABLE extra (id SERIAL PRIMARY KEY)",
      }],
      ["alter_schema", {
        tableName: "items",
        sql: "ALTER TABLE items ADD COLUMN note TEXT",
      }],
      ["execute_sql", { sql: "INSERT INTO items (name) VALUES ('during')" }],
      ["write_project_file", { path: "notes.md", content: "v2\n" }],
      ["write_project_file", { path: "docs/new.md", content: "new\n" }],
    ] as const
  ) {
    const r = await dispatchTool(verb, input, kernel, noop, {});
    assert(r.ok, `${verb}: ${JSON.stringify(r.error)}`);
  }
}

async function abandon(kernel: Kernel, id: string): Promise<AbandonRewind> {
  const r = await dispatchTool(
    "abandon_changeset",
    { changeset_id: id },
    kernel,
    noop,
    {},
  );
  assert(r.ok, JSON.stringify(r.error));
  return (r.data as { rewind: AbandonRewind }).rewind;
}

async function columns(kernel: Kernel, table: string): Promise<string[]> {
  const rows = await kernel.db.query(
    "SELECT column_name FROM information_schema.columns WHERE table_name = $1 ORDER BY column_name",
    [table],
  );
  return rows.map((r) => String(r.column_name));
}

async function itemNames(kernel: Kernel): Promise<string[]> {
  const rows = await kernel.db.query("SELECT name FROM items ORDER BY id");
  return rows.map((r) => String(r.name));
}

Deno.test({
  ...testOpts,
  name:
    "abandon rewinds code, schema and files to the changeset start; rows stay",
  fn: () =>
    withBaseline(async (kernel, projectDir) => {
      const id = await startChangeset(kernel);
      assert(readChangesetSnapshot(projectDir, id), "snapshot taken at start");
      await work(kernel);

      const rewind = await abandon(kernel, id);
      assert(rewind.rewound, JSON.stringify(rewind));
      assertEquals(rewind.migrationsUndone, 2);

      assert(kernel.handlers.get("kept"));
      assertEquals(kernel.handlers.get("added"), undefined);
      assertEquals((await kernel.db.getSchema("extra")).ok, false);
      assertEquals(await columns(kernel, "items"), ["id", "name"]);
      assertEquals(await itemNames(kernel), ["before", "during"]);
      assertEquals(readFileSync(join(projectDir, "notes.md"), "utf-8"), "v1\n");
      assert(!existsSync(join(projectDir, "docs")), "new file and dir gone");
      assertEquals(readChangesetSnapshot(projectDir, id), null);
      assertEquals((await kernel.changesets.get(id))?.status, "abandoned");
    }),
});

Deno.test({
  ...testOpts,
  name: "an irreversible migration stops the rewind before anything changes",
  fn: () =>
    withBaseline(async (kernel, projectDir) => {
      const id = await startChangeset(kernel);
      await work(kernel);
      await kernel.db.execute(
        "UPDATE _genie_schema_migrations SET reversible = false WHERE changeset_id = $1 AND table_name = 'items'",
        [id],
      );

      const rewind = await abandon(kernel, id);
      assertEquals(rewind.rewound, false);
      assertEquals(
        rewind.rewound ? null : rewind.code,
        "CHANGESET_IRREVERSIBLE",
      );
      assert(kernel.handlers.get("added"), "code left alone");
      assertEquals((await kernel.db.getSchema("extra")).ok, true);
      assertEquals(await columns(kernel, "items"), ["id", "name", "note"]);
      assertEquals(readFileSync(join(projectDir, "notes.md"), "utf-8"), "v2\n");
      assertEquals((await kernel.changesets.get(id))?.status, "abandoned");
    }),
});

Deno.test({
  ...testOpts,
  name: "changeset snapshots prune oldest first and never the protected one",
  fn: async () => {
    const projectDir = await Deno.makeTempDir({ prefix: "tide-cs-prune-" });
    try {
      const dir = getProjectPaths(projectDir).snapshotsDir;
      mkdirSync(dir, { recursive: true });
      ["a", "b", "c", "d"].forEach((id, i) => {
        const file = join(dir, `${id}.json`);
        writeFileSync(file, "{}");
        utimesSync(file, 1_000 + i, 1_000 + i);
      });
      const deleted = pruneChangesetSnapshots(projectDir, 2, ["a"]);
      assertEquals(deleted, ["b", "c"]);
      assertEquals(pruneChangesetSnapshots(projectDir, 1, ["a", "d"]), []);
    } finally {
      await Deno.remove(projectDir, { recursive: true });
    }
  },
});

Deno.test({
  ...testOpts,
  name:
    "maxChangesetSnapshots: env wins, a bad value falls back, 0 turns it off",
  fn: () =>
    withBaseline(async (kernel) => {
      Deno.env.set(OPENTIDE_MAX_CHANGESET_SNAPSHOTS_ENV, "3");
      assertEquals(getKernelSettings().maxChangesetSnapshots, 3);
      Deno.env.set(OPENTIDE_MAX_CHANGESET_SNAPSHOTS_ENV, "-1");
      assert(getKernelSettings().maxChangesetSnapshots >= 0);
      Deno.env.set(OPENTIDE_MAX_CHANGESET_SNAPSHOTS_ENV, "0");
      const off = await takeChangesetSnapshot(kernel, "cs_off");
      assertEquals(off.ok ? null : off.error.code, "SNAPSHOTS_OFF");
      assertEquals(MAX_CHANGESET_SNAPSHOTS_DEFAULT, 10);
    }),
});
