import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { testStoreComposition } from "../verification/test-stores.ts";
import { binaryCompileArgs, writeExportFiles } from "./build.ts";
import { Database } from "./db.ts";
import { APP_RUNTIME_PERMISSIONS, exportProject } from "./export.ts";
import { PROJECT_GITIGNORE } from "./config.ts";
import { Kernel } from "./registries.ts";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

function fileContent(
  files: Awaited<ReturnType<typeof exportProject>>["files"],
  path: string,
): string {
  const file = files.find((f) => f.path === path);
  if (!file?.content) throw new Error(`Expected exported file ${path}`);
  return file.content;
}

Deno.test("exportProject initializes runtime config values in deps.ts", async () => {
  const db = await Database.create({ driver: "pglite" });
  try {
    const kernel = new Kernel(db, { composition: testStoreComposition() });
    kernel.configs.set("PAGE_SIZE", 25, "Default page size");
    kernel.configs.set("FEATURE_FLAGS", { newCheckout: true, theme: "light" });
    kernel.configs.set("API_TITLE", 'A "quoted"\nvalue');

    const { files } = await exportProject(kernel);
    const deps = fileContent(files, "deps.ts");

    assertStringIncludes(deps, `const configMap = new Map<string, unknown>([`);
    assertStringIncludes(deps, `  ["PAGE_SIZE", 25],`);
    assertStringIncludes(
      deps,
      `  ["FEATURE_FLAGS", {"newCheckout":true,"theme":"light"}],`,
    );
    assertStringIncludes(deps, `  ["API_TITLE", "A \\"quoted\\"\\nvalue"],`);
    assertStringIncludes(
      deps,
      `function readRuntimeEnv(key: string): string | undefined`,
    );
    assertStringIncludes(deps, `process?.env`);
    assertStringIncludes(deps, `dotEnv[key]`);
  } finally {
    await db.close();
  }
});

Deno.test("exportProject does not expose internal Genie configs", async () => {
  const db = await Database.create({ driver: "pglite" });
  try {
    const kernel = new Kernel(db, { composition: testStoreComposition() });
    kernel.configs.set("PUBLIC_LIMIT", 10);
    kernel.configs.set("_genie_custom_instructions", "Do not expose");
    kernel.configs.set("_genie_mcp_servers", [{ name: "private" }]);

    const { files } = await exportProject(kernel);
    const deps = fileContent(files, "deps.ts");

    assertStringIncludes(deps, `  ["PUBLIC_LIMIT", 10],`);
    assert(!deps.includes("_genie_custom_instructions"));
    assert(!deps.includes("_genie_mcp_servers"));
    assert(!deps.includes("Do not expose"));
  } finally {
    await db.close();
  }
});

Deno.test("exportProject emits Deno manifest with env loading and runtime database dependency", async () => {
  const db = await Database.create({ driver: "pglite" });
  try {
    const kernel = new Kernel(db, { composition: testStoreComposition() });
    const { files } = await exportProject(kernel);
    const denoJson = JSON.parse(fileContent(files, "deno.json"));

    assertStringIncludes(denoJson.tasks.start, "deno run --env");
    assertStringIncludes(denoJson.tasks.start, "--no-check");
    assertStringIncludes(denoJson.tasks.start, "--allow-env");
    assert(denoJson.imports["@electric-sql/pglite"]);
  } finally {
    await db.close();
  }
});

// A compiled binary and `deno task start` must grant the same capabilities. They
// did not: the tasks and binaryCompileArgs were separate literals, and only the
// binary path mattered to anyone, so `--allow-sys` was missing from both while
// @napi-rs/canvas needed it on Linux — an app that ran on macOS and died in
// production with nothing to explain it. Both now build from one constant; this
// pins that they agree, and that every documented task grants the full set.
Deno.test("exported tasks and binary compile args grant the same permissions", async () => {
  const db = await Database.create({ driver: "pglite" });
  try {
    const kernel = new Kernel(db, { composition: testStoreComposition() });
    const { files } = await exportProject(kernel);
    const denoJson = JSON.parse(fileContent(files, "deno.json"));

    const compileArgs = binaryCompileArgs("/tmp/out", "/tmp/main.ts");
    const permsInBinary = compileArgs.filter((a: string) =>
      a.startsWith("--allow-")
    );

    assertEquals(
      permsInBinary,
      [...APP_RUNTIME_PERMISSIONS],
      "the compiled binary must grant exactly the declared app permission set",
    );

    // Every task that boots the app, not just `start`: db:prepare runs migrations
    // on a production database and needs the same capabilities as serving.
    for (const task of ["start", "migrate", "seed", "db:prepare", "db:check"]) {
      const line = String(denoJson.tasks[task]);
      for (const perm of APP_RUNTIME_PERMISSIONS) {
        assertStringIncludes(
          line,
          perm,
          `task "${task}" must grant ${perm}, or it behaves differently from the binary`,
        );
      }
    }
  } finally {
    await db.close();
  }
});

Deno.test("exportProject exports schema only by default and seed data when requested", async () => {
  const db = await Database.create({ driver: "pglite" });
  try {
    const kernel = new Kernel(db, { composition: testStoreComposition() });
    const schema = await kernel.db.defineSchema(
      "items",
      "CREATE TABLE items (id SERIAL PRIMARY KEY, name TEXT NOT NULL)",
    );
    assertEquals(schema.ok, true);
    await kernel.db.execute("INSERT INTO items (name) VALUES ($1)", ["apple"]);

    const schemaOnly = await exportProject(kernel);
    assert(schemaOnly.files.some((f) => f.path === "schema.sql"));
    assert(!schemaOnly.files.some((f) => f.path === "seed.sql"));

    const withSeed = await exportProject(kernel, { includeSeedData: true });
    const seed = fileContent(withSeed.files, "seed.sql");
    const main = fileContent(withSeed.files, "main.ts");
    assertStringIncludes(seed, `INSERT INTO "items"`);
    assertStringIncludes(seed, `'apple'`);
    assertStringIncludes(main, `const schemaPath = runtimeFile("schema.sql");`);
    assertStringIncludes(main, `if (!existsSync(schemaPath)) return false;`);
    assertStringIncludes(main, `const seedPath = runtimeFile("seed.sql");`);
    assertStringIncludes(
      main,
      `if (initialized) await applyCapturedSeedSqlIfPending();`,
    );
    assertStringIncludes(
      main,
      `const seedKey = "seed.sql:" + hashString(seed);`,
    );
    assert(!main.includes(`catch { /* schema.sql may not exist */ }`));
  } finally {
    await db.close();
  }
});

Deno.test("exported app applies captured seed only to a freshly initialized db", async () => {
  const db = await Database.create({ driver: "pglite" });
  const freshDir = await Deno.makeTempDir({
    prefix: "genie_export_seed_fresh_",
  });
  const existingDir = await Deno.makeTempDir({
    prefix: "genie_export_seed_existing_",
  });
  try {
    const kernel = new Kernel(db, { composition: testStoreComposition() });
    const schema = await kernel.db.defineSchema(
      "items",
      "CREATE TABLE items (id SERIAL PRIMARY KEY, name TEXT NOT NULL)",
    );
    assertEquals(schema.ok, true);
    await kernel.db.execute("INSERT INTO items (name) VALUES ($1)", ["apple"]);

    const { files } = await exportProject(kernel, { includeSeedData: true });
    writeExportFiles(freshDir, files);
    writeExportFiles(existingDir, files);

    const runArgs = [
      "run",
      "--env",
      "--no-check",
      "--allow-net",
      "--allow-read",
      "--allow-write",
      "--allow-env",
      "--allow-ffi",
      "main.ts",
    ];
    const freshPrepare = await new Deno.Command(Deno.execPath(), {
      args: [...runArgs, "--prepare-db"],
      cwd: freshDir,
      stdout: "piped",
      stderr: "piped",
    }).output();
    assertEquals(
      freshPrepare.success,
      true,
      new TextDecoder().decode(freshPrepare.stderr),
    );

    const freshDepsUrl = pathToFileURL(join(freshDir, "deps.ts")).href;
    const freshInspect = await new Deno.Command(Deno.execPath(), {
      args: [
        "eval",
        "--allow-read",
        "--allow-write",
        "--allow-env",
        "--allow-ffi",
        `import { db } from ${JSON.stringify(freshDepsUrl)};
const rows = await db.query("SELECT name FROM items ORDER BY id");
const meta = await db.query("SELECT key FROM _genie_seed_meta");
console.log(JSON.stringify({ rows, meta }));
Deno.exit(0);`,
      ],
      cwd: freshDir,
      stdout: "piped",
      stderr: "piped",
    }).output();
    assertEquals(
      freshInspect.success,
      true,
      new TextDecoder().decode(freshInspect.stderr),
    );
    const fresh = JSON.parse(new TextDecoder().decode(freshInspect.stdout)) as {
      rows: Array<{ name: string }>;
      meta: Array<{ key: string }>;
    };
    assertEquals(fresh.rows, [{ name: "apple" }]);
    assertEquals(fresh.meta.length, 1);

    const existingDepsUrl = pathToFileURL(join(existingDir, "deps.ts")).href;
    const existingMainUrl = pathToFileURL(join(existingDir, "main.ts")).href;
    const existingInspect = await new Deno.Command(Deno.execPath(), {
      args: [
        "eval",
        "--allow-net",
        "--allow-read",
        "--allow-write",
        "--allow-env",
        "--allow-ffi",
        `import { db } from ${JSON.stringify(existingDepsUrl)};
await db.execute("CREATE TABLE items (id SERIAL PRIMARY KEY, name TEXT NOT NULL)");
const mod = await import(${
          JSON.stringify(existingMainUrl)
        }) as { createApp: () => Promise<unknown> };
await mod.createApp();
const rows = await db.query("SELECT name FROM items ORDER BY id");
console.log(JSON.stringify({ rows }));
Deno.exit(0);`,
      ],
      cwd: existingDir,
      stdout: "piped",
      stderr: "piped",
    }).output();
    assertEquals(
      existingInspect.success,
      true,
      new TextDecoder().decode(existingInspect.stderr),
    );
    const existing = JSON.parse(
      new TextDecoder().decode(existingInspect.stdout),
    ) as { rows: Array<{ name: string }> };
    assertEquals(existing.rows, []);
  } finally {
    await db.close();
    rmSync(freshDir, { recursive: true, force: true });
    rmSync(existingDir, { recursive: true, force: true });
  }
});

Deno.test("exportProject bundles app migrations with a deploy ledger runtime", async () => {
  const db = await Database.create({ driver: "pglite" });
  const tmpDir = await Deno.makeTempDir({
    prefix: "genie_export_migrations_",
  });
  try {
    const kernel = new Kernel(db, { composition: testStoreComposition() });
    const schema = await kernel.db.defineSchema(
      "items",
      "CREATE TABLE items (id SERIAL PRIMARY KEY, name TEXT NOT NULL)",
    );
    assertEquals(schema.ok, true);
    const altered = await kernel.db.alterSchema(
      "items",
      "ALTER TABLE items ADD COLUMN sku TEXT",
    );
    assertEquals(altered.ok, true);

    const { files } = await exportProject(kernel, {
      includeMigrations: true,
      projectVersion: "1.2.3",
    });
    const manifest = JSON.parse(
      fileContent(files, "migrations/manifest.json"),
    ) as {
      projectVersion: string;
      migrations: Array<{
        id: string;
        path: string;
        tableName: string;
        version: number;
        sha256: string;
      }>;
    };
    const main = fileContent(files, "main.ts");

    assertEquals(manifest.projectVersion, "1.2.3");
    assertEquals(
      manifest.migrations.map((migration) => ({
        id: migration.id,
        path: migration.path,
        tableName: migration.tableName,
        version: migration.version,
      })),
      [
        {
          id: "items_v1",
          path: "migrations/items_v1.sql",
          tableName: "items",
          version: 1,
        },
        {
          id: "items_v2",
          path: "migrations/items_v2.sql",
          tableName: "items",
          version: 2,
        },
      ],
    );
    assertStringIncludes(
      fileContent(files, manifest.migrations[0]!.path),
      "CREATE TABLE items",
    );
    assertStringIncludes(
      fileContent(files, manifest.migrations[1]!.path),
      "ALTER TABLE items ADD COLUMN sku TEXT",
    );
    assertStringIncludes(main, `const APP_MIGRATIONS_TABLE`);
    assertStringIncludes(main, `async function applyPendingMigrations()`);
    assertStringIncludes(main, `--prepare-db`);

    writeExportFiles(tmpDir, files);
    const prevCwd = Deno.cwd();
    Deno.chdir(tmpDir);
    try {
      const mod = await import(pathToFileURL(join(tmpDir, "main.ts")).href) as {
        createApp?: () => Promise<unknown>;
      };
      await mod.createApp!();
      const deps = await import(
        pathToFileURL(join(tmpDir, "deps.ts")).href
      ) as {
        db: {
          query(
            sql: string,
            params?: unknown[],
          ): Promise<Record<string, unknown>[]>;
        };
      };
      const rows = await deps.db.query(
        `SELECT "id", "hash", "app_version" FROM "_genie_app_migrations" ORDER BY "id"`,
      );
      assertEquals(rows.map((row) => row.id), ["items_v1", "items_v2"]);
      assertEquals(rows[0]?.app_version, "1.2.3");
    } finally {
      Deno.chdir(prevCwd);
    }
  } finally {
    await db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

Deno.test("exportProject keeps migration IDs stable when a new earlier migration is added", async () => {
  const db = await Database.create({ driver: "pglite" });
  try {
    const kernel = new Kernel(db, { composition: testStoreComposition() });
    const items = await kernel.db.defineSchema(
      "items",
      "CREATE TABLE items (id SERIAL PRIMARY KEY, name TEXT NOT NULL)",
    );
    assertEquals(items.ok, true);

    const before = await exportProject(kernel, { includeMigrations: true });
    const beforeManifest = JSON.parse(
      fileContent(before.files, "migrations/manifest.json"),
    ) as {
      migrations: Array<{ id: string; path: string }>;
    };
    assertEquals(
      beforeManifest.migrations.map((migration) => ({
        id: migration.id,
        path: migration.path,
      })),
      [{ id: "items_v1", path: "migrations/items_v1.sql" }],
    );

    const agents = await kernel.db.defineSchema(
      "agents",
      "CREATE TABLE agents (id SERIAL PRIMARY KEY, handle TEXT NOT NULL)",
    );
    assertEquals(agents.ok, true);
    await kernel.db.execute(
      `UPDATE "_genie_schema_migrations" SET "applied_at" = $1 WHERE "table_name" = $2`,
      ["1970-01-01T00:00:00.000Z", "agents"],
    );

    const after = await exportProject(kernel, { includeMigrations: true });
    const afterManifest = JSON.parse(
      fileContent(after.files, "migrations/manifest.json"),
    ) as {
      migrations: Array<{ id: string; path: string }>;
    };
    assertEquals(
      afterManifest.migrations.map((migration) => ({
        id: migration.id,
        path: migration.path,
      })),
      [
        { id: "agents_v1", path: "migrations/agents_v1.sql" },
        { id: "items_v1", path: "migrations/items_v1.sql" },
      ],
    );
    assertStringIncludes(
      fileContent(after.files, "migrations/items_v1.sql"),
      "CREATE TABLE items",
    );
  } finally {
    await db.close();
  }
});

Deno.test("exported app prepare-db and check-db commands reconcile bundled migrations", async () => {
  const db = await Database.create({ driver: "pglite" });
  const tmpDir = await Deno.makeTempDir({
    prefix: "genie_export_prepare_db_",
  });
  try {
    const kernel = new Kernel(db, { composition: testStoreComposition() });
    const schema = await kernel.db.defineSchema(
      "items",
      "CREATE TABLE items (id SERIAL PRIMARY KEY, name TEXT NOT NULL)",
    );
    assertEquals(schema.ok, true);
    const altered = await kernel.db.alterSchema(
      "items",
      "ALTER TABLE items ADD COLUMN sku TEXT",
    );
    assertEquals(altered.ok, true);

    const { files } = await exportProject(kernel, {
      includeMigrations: true,
      projectVersion: "2.0.0",
    });
    writeExportFiles(tmpDir, files);

    const permissions = [
      "run",
      "--env",
      "--no-check",
      "--allow-net",
      "--allow-read",
      "--allow-write",
      "--allow-env",
      "--allow-ffi",
      "main.ts",
    ];
    const prepare = await new Deno.Command(Deno.execPath(), {
      args: [...permissions, "--prepare-db"],
      cwd: tmpDir,
      stdout: "piped",
      stderr: "piped",
    }).output();
    assertEquals(
      prepare.success,
      true,
      new TextDecoder().decode(prepare.stderr),
    );
    assertStringIncludes(
      new TextDecoder().decode(prepare.stdout),
      "initialized=true",
    );

    const check = await new Deno.Command(Deno.execPath(), {
      args: [...permissions, "--check-db"],
      cwd: tmpDir,
      stdout: "piped",
      stderr: "piped",
    }).output();
    assertEquals(check.success, true, new TextDecoder().decode(check.stderr));
    assertStringIncludes(
      new TextDecoder().decode(check.stdout),
      "Database schema is current.",
    );
  } finally {
    await db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

Deno.test("exported app with stable applied IDs applies only new pending migrations", async () => {
  const db = await Database.create({ driver: "pglite" });
  const tmpDir = await Deno.makeTempDir({
    prefix: "genie_export_stable_pending_",
  });
  try {
    const kernel = new Kernel(db, { composition: testStoreComposition() });
    const schema = await kernel.db.defineSchema(
      "documents",
      "CREATE TABLE documents (id SERIAL PRIMARY KEY, title TEXT NOT NULL)",
    );
    assertEquals(schema.ok, true);

    const first = await exportProject(kernel, {
      includeMigrations: true,
      projectVersion: "0.1.0",
    });
    writeExportFiles(tmpDir, first.files);

    const runArgs = [
      "run",
      "--env",
      "--no-check",
      "--allow-net",
      "--allow-read",
      "--allow-write",
      "--allow-env",
      "--allow-ffi",
      "main.ts",
    ];
    const firstPrepare = await new Deno.Command(Deno.execPath(), {
      args: [...runArgs, "--prepare-db"],
      cwd: tmpDir,
      stdout: "piped",
      stderr: "piped",
    }).output();
    assertEquals(
      firstPrepare.success,
      true,
      new TextDecoder().decode(firstPrepare.stderr),
    );

    const depsUrl = pathToFileURL(join(tmpDir, "deps.ts")).href;
    const firstLedger = await new Deno.Command(Deno.execPath(), {
      args: [
        "eval",
        "--allow-read",
        "--allow-write",
        "--allow-env",
        "--allow-ffi",
        `import { db } from ${JSON.stringify(depsUrl)};
const migrations = await db.query('SELECT "id" FROM "_genie_app_migrations" ORDER BY "id"');
console.log(JSON.stringify(migrations));
Deno.exit(0);`,
      ],
      cwd: tmpDir,
      stdout: "piped",
      stderr: "piped",
    }).output();
    assertEquals(
      firstLedger.success,
      true,
      new TextDecoder().decode(firstLedger.stderr),
    );
    assertEquals(
      (JSON.parse(new TextDecoder().decode(firstLedger.stdout)) as Array<
        { id: string }
      >).map((row) => row.id),
      ["documents_v1"],
    );

    const altered = await kernel.db.alterSchema(
      "documents",
      "ALTER TABLE documents ADD COLUMN summary TEXT",
    );
    assertEquals(altered.ok, true);
    const second = await exportProject(kernel, {
      includeMigrations: true,
      projectVersion: "0.2.0",
    });
    writeExportFiles(tmpDir, second.files);

    const secondPrepare = await new Deno.Command(Deno.execPath(), {
      args: [...runArgs, "--prepare-db"],
      cwd: tmpDir,
      stdout: "piped",
      stderr: "piped",
    }).output();
    assertEquals(
      secondPrepare.success,
      true,
      new TextDecoder().decode(secondPrepare.stderr),
    );
    assertStringIncludes(
      new TextDecoder().decode(secondPrepare.stdout),
      "migrations=1",
    );

    const secondLedger = await new Deno.Command(Deno.execPath(), {
      args: [
        "eval",
        "--allow-read",
        "--allow-write",
        "--allow-env",
        "--allow-ffi",
        `import { db } from ${JSON.stringify(depsUrl)};
const migrations = await db.query('SELECT "id" FROM "_genie_app_migrations" ORDER BY "id"');
const docs = await db.query("SELECT summary FROM documents");
console.log(JSON.stringify({ migrations, docs }));
Deno.exit(0);`,
      ],
      cwd: tmpDir,
      stdout: "piped",
      stderr: "piped",
    }).output();
    assertEquals(
      secondLedger.success,
      true,
      new TextDecoder().decode(secondLedger.stderr),
    );
    const inspected = JSON.parse(
      new TextDecoder().decode(secondLedger.stdout),
    ) as {
      migrations: Array<{ id: string }>;
      docs: Array<{ summary: null }>;
    };
    assertEquals(inspected.migrations.map((row) => row.id), [
      "documents_v1",
      "documents_v2",
    ]);
    assertEquals(inspected.docs, []);
  } finally {
    await db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

Deno.test("exported app adopts a compatible existing db without replaying schema.sql", async () => {
  const db = await Database.create({ driver: "pglite" });
  const tmpDir = await Deno.makeTempDir({
    prefix: "genie_export_adopt_db_",
  });
  try {
    const kernel = new Kernel(db, { composition: testStoreComposition() });
    const schema = await kernel.db.defineSchema(
      "documents",
      "CREATE TABLE documents (id SERIAL PRIMARY KEY, title TEXT NOT NULL)",
    );
    assertEquals(schema.ok, true);

    const first = await exportProject(kernel, { projectVersion: "0.2.0" });
    writeExportFiles(tmpDir, first.files);

    const permissions = [
      "run",
      "--env",
      "--no-check",
      "--allow-net",
      "--allow-read",
      "--allow-write",
      "--allow-env",
      "--allow-ffi",
      "main.ts",
    ];
    const firstPrepare = await new Deno.Command(Deno.execPath(), {
      args: [...permissions, "--prepare-db"],
      cwd: tmpDir,
      stdout: "piped",
      stderr: "piped",
    }).output();
    assertEquals(
      firstPrepare.success,
      true,
      new TextDecoder().decode(firstPrepare.stderr),
    );

    const depsUrl = pathToFileURL(join(tmpDir, "deps.ts")).href;
    const insert = await new Deno.Command(Deno.execPath(), {
      args: [
        "eval",
        "--allow-read",
        "--allow-write",
        "--allow-env",
        "--allow-ffi",
        `import { db } from ${JSON.stringify(depsUrl)};
await db.execute("INSERT INTO documents (title) VALUES ($1)", ["kept"]);
Deno.exit(0);`,
      ],
      cwd: tmpDir,
      stdout: "piped",
      stderr: "piped",
    }).output();
    assertEquals(insert.success, true, new TextDecoder().decode(insert.stderr));

    const second = await exportProject(kernel, {
      includeMigrations: true,
      projectVersion: "0.3.0",
    });
    writeExportFiles(tmpDir, second.files);

    const secondPrepare = await new Deno.Command(Deno.execPath(), {
      args: [...permissions, "--prepare-db"],
      cwd: tmpDir,
      stdout: "piped",
      stderr: "piped",
    }).output();
    assertEquals(
      secondPrepare.success,
      true,
      new TextDecoder().decode(secondPrepare.stderr),
    );
    assertStringIncludes(
      new TextDecoder().decode(secondPrepare.stdout),
      "adopted=true",
    );

    const inspect = await new Deno.Command(Deno.execPath(), {
      args: [
        "eval",
        "--allow-read",
        "--allow-write",
        "--allow-env",
        "--allow-ffi",
        `import { db } from ${JSON.stringify(depsUrl)};
const docs = await db.query("SELECT title FROM documents ORDER BY id");
const migrations = await db.query('SELECT COUNT(*) AS count FROM "_genie_app_migrations"');
console.log(JSON.stringify({ docs, migrations }));
Deno.exit(0);`,
      ],
      cwd: tmpDir,
      stdout: "piped",
      stderr: "piped",
    }).output();
    assertEquals(
      inspect.success,
      true,
      new TextDecoder().decode(inspect.stderr),
    );
    const inspected = JSON.parse(new TextDecoder().decode(inspect.stdout)) as {
      docs: Array<{ title: string }>;
      migrations: Array<{ count: unknown }>;
    };
    assertEquals(inspected.docs, [{ title: "kept" }]);
    assertEquals(String(inspected.migrations[0]?.count), "1");
  } finally {
    await db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

Deno.test("exported app migrates an older existing db without replaying base CREATE TABLE", async () => {
  const db = await Database.create({ driver: "pglite" });
  const tmpDir = await Deno.makeTempDir({
    prefix: "genie_export_upgrade_db_",
  });
  try {
    const kernel = new Kernel(db, { composition: testStoreComposition() });
    const schema = await kernel.db.defineSchema(
      "documents",
      "CREATE TABLE documents (id SERIAL PRIMARY KEY, title TEXT NOT NULL)",
    );
    assertEquals(schema.ok, true);

    const first = await exportProject(kernel, { projectVersion: "0.2.0" });
    writeExportFiles(tmpDir, first.files);

    const permissions = [
      "run",
      "--env",
      "--no-check",
      "--allow-net",
      "--allow-read",
      "--allow-write",
      "--allow-env",
      "--allow-ffi",
      "main.ts",
    ];
    const firstPrepare = await new Deno.Command(Deno.execPath(), {
      args: [...permissions, "--prepare-db"],
      cwd: tmpDir,
      stdout: "piped",
      stderr: "piped",
    }).output();
    assertEquals(
      firstPrepare.success,
      true,
      new TextDecoder().decode(firstPrepare.stderr),
    );

    const depsUrl = pathToFileURL(join(tmpDir, "deps.ts")).href;
    const insert = await new Deno.Command(Deno.execPath(), {
      args: [
        "eval",
        "--allow-read",
        "--allow-write",
        "--allow-env",
        "--allow-ffi",
        `import { db } from ${JSON.stringify(depsUrl)};
await db.execute("INSERT INTO documents (title) VALUES ($1)", ["kept"]);
Deno.exit(0);`,
      ],
      cwd: tmpDir,
      stdout: "piped",
      stderr: "piped",
    }).output();
    assertEquals(insert.success, true, new TextDecoder().decode(insert.stderr));

    const altered = await kernel.db.alterSchema(
      "documents",
      "ALTER TABLE documents ADD COLUMN summary TEXT",
    );
    assertEquals(altered.ok, true);
    const second = await exportProject(kernel, {
      includeMigrations: true,
      projectVersion: "0.3.0",
    });
    writeExportFiles(tmpDir, second.files);

    const secondPrepare = await new Deno.Command(Deno.execPath(), {
      args: [...permissions, "--prepare-db"],
      cwd: tmpDir,
      stdout: "piped",
      stderr: "piped",
    }).output();
    assertEquals(
      secondPrepare.success,
      true,
      new TextDecoder().decode(secondPrepare.stderr),
    );
    assertStringIncludes(
      new TextDecoder().decode(secondPrepare.stdout),
      "adopted=false, migrations=2",
    );

    const inspect = await new Deno.Command(Deno.execPath(), {
      args: [
        "eval",
        "--allow-read",
        "--allow-write",
        "--allow-env",
        "--allow-ffi",
        `import { db } from ${JSON.stringify(depsUrl)};
const docs = await db.query("SELECT title, summary FROM documents ORDER BY id");
const migrations = await db.query('SELECT COUNT(*) AS count FROM "_genie_app_migrations"');
console.log(JSON.stringify({ docs, migrations }));
Deno.exit(0);`,
      ],
      cwd: tmpDir,
      stdout: "piped",
      stderr: "piped",
    }).output();
    assertEquals(
      inspect.success,
      true,
      new TextDecoder().decode(inspect.stderr),
    );
    const inspected = JSON.parse(new TextDecoder().decode(inspect.stdout)) as {
      docs: Array<{ title: string; summary: null }>;
      migrations: Array<{ count: unknown }>;
    };
    assertEquals(inspected.docs, [{ title: "kept", summary: null }]);
    assertEquals(String(inspected.migrations[0]?.count), "2");
  } finally {
    await db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

Deno.test("exportProject orders schema and seed output by foreign-key dependencies", async () => {
  const db = await Database.create({ driver: "pglite" });
  try {
    const kernel = new Kernel(db, { composition: testStoreComposition() });
    const documents = await kernel.db.defineSchema(
      "documents",
      "CREATE TABLE documents (id SERIAL PRIMARY KEY, title TEXT NOT NULL)",
    );
    assertEquals(documents.ok, true);
    const versions = await kernel.db.defineSchema(
      "versions",
      "CREATE TABLE versions (id SERIAL PRIMARY KEY, document_id INTEGER NOT NULL REFERENCES documents(id), label TEXT NOT NULL)",
    );
    assertEquals(versions.ok, true);
    const events = await kernel.db.defineSchema(
      "agent_events",
      "CREATE TABLE agent_events (id SERIAL PRIMARY KEY, document_id INTEGER REFERENCES documents(id), version_id INTEGER REFERENCES versions(id), event_type TEXT NOT NULL)",
    );
    assertEquals(events.ok, true);

    await kernel.db.execute(
      "INSERT INTO documents (title) VALUES ($1)",
      ["Plan"],
    );
    await kernel.db.execute(
      "INSERT INTO versions (document_id, label) VALUES ($1, $2)",
      [1, "v1"],
    );
    await kernel.db.execute(
      "INSERT INTO agent_events (document_id, version_id, event_type) VALUES ($1, $2, $3)",
      [1, 1, "created"],
    );

    const { files } = await exportProject(kernel, { includeSeedData: true });
    const schema = fileContent(files, "schema.sql");
    const seed = fileContent(files, "seed.sql");

    const documentsSchemaIndex = schema.indexOf("CREATE TABLE documents");
    const versionsSchemaIndex = schema.indexOf("CREATE TABLE versions");
    const eventsSchemaIndex = schema.indexOf("CREATE TABLE agent_events");
    assert(documentsSchemaIndex !== -1);
    assert(versionsSchemaIndex !== -1);
    assert(eventsSchemaIndex !== -1);
    assert(documentsSchemaIndex < versionsSchemaIndex);
    assert(versionsSchemaIndex < eventsSchemaIndex);

    const documentsSeedIndex = seed.indexOf('INSERT INTO "documents"');
    const versionsSeedIndex = seed.indexOf('INSERT INTO "versions"');
    const eventsSeedIndex = seed.indexOf('INSERT INTO "agent_events"');
    assert(documentsSeedIndex !== -1);
    assert(versionsSeedIndex !== -1);
    assert(eventsSeedIndex !== -1);
    assert(documentsSeedIndex < versionsSeedIndex);
    assert(versionsSeedIndex < eventsSeedIndex);
  } finally {
    await db.close();
  }
});

Deno.test("exportProject emits portable seed literals for dates and JSON", async () => {
  const db = await Database.create({ driver: "pglite" });
  const tmpDir = await Deno.makeTempDir({ prefix: "genie_export_seed_" });
  try {
    const kernel = new Kernel(db, { composition: testStoreComposition() });
    const schema = await kernel.db.defineSchema(
      "articles",
      "CREATE TABLE articles (id SERIAL PRIMARY KEY, payload JSONB NOT NULL DEFAULT '{}'::jsonb, created_at TIMESTAMPTZ DEFAULT NOW())",
    );
    assertEquals(schema.ok, true);
    await kernel.db.execute(
      "INSERT INTO articles (payload) VALUES ($1::jsonb)",
      [
        JSON.stringify({
          title: "One",
          text: "Code in a REPL is useful; it isn't magic.",
          tags: ["fast", "read"],
        }),
      ],
    );

    const { files } = await exportProject(kernel, { includeSeedData: true });
    const seed = fileContent(files, "seed.sql");
    assertEquals(seed.includes("GMT"), false);
    assertEquals(seed.includes("[object Object]"), false);
    assertStringIncludes(seed, `"title":"One"`);
    assertStringIncludes(seed, "useful; it isn''t magic");
    assertStringIncludes(seed, "T");
    assertStringIncludes(seed, "Z");

    writeExportFiles(tmpDir, files);
    const prevCwd = Deno.cwd();
    Deno.chdir(tmpDir);
    try {
      const mod = await import(pathToFileURL(join(tmpDir, "main.ts")).href) as {
        createApp?: () => Promise<unknown>;
      };
      assertEquals(typeof mod.createApp, "function");
      await mod.createApp!();
    } finally {
      Deno.chdir(prevCwd);
    }
  } finally {
    await db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

Deno.test("exportProject advances serial sequences after applying seed rows", async () => {
  const db = await Database.create({ driver: "pglite" });
  const tmpDir = await Deno.makeTempDir({
    prefix: "genie_export_seed_serial_",
  });
  try {
    const kernel = new Kernel(db, { composition: testStoreComposition() });
    const schema = await kernel.db.defineSchema(
      "items",
      "CREATE TABLE items (id SERIAL PRIMARY KEY, name TEXT NOT NULL)",
    );
    assertEquals(schema.ok, true);
    await kernel.db.execute("INSERT INTO items (name) VALUES ($1)", ["apple"]);

    const { files } = await exportProject(kernel, { includeSeedData: true });
    const seed = fileContent(files, "seed.sql");
    assertStringIncludes(seed, `pg_get_serial_sequence('"items"', 'id')`);

    writeExportFiles(tmpDir, files);
    const prevCwd = Deno.cwd();
    Deno.chdir(tmpDir);
    try {
      const mod = await import(pathToFileURL(join(tmpDir, "main.ts")).href) as {
        createApp?: () => Promise<unknown>;
      };
      await mod.createApp!();
      const deps = await import(
        pathToFileURL(join(tmpDir, "deps.ts")).href
      ) as {
        db: {
          query(
            sql: string,
            params?: unknown[],
          ): Promise<Record<string, unknown>[]>;
        };
      };
      const inserted = await deps.db.query(
        "INSERT INTO items (name) VALUES ($1) RETURNING id",
        ["banana"],
      );
      assertEquals(Number(inserted[0]?.id), 2);
    } finally {
      Deno.chdir(prevCwd);
    }
  } finally {
    await db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

Deno.test("exportProject emits runtime helpers that tolerate app-level TypeScript", async () => {
  const db = await Database.create({ driver: "pglite" });
  try {
    const kernel = new Kernel(db, { composition: testStoreComposition() });
    kernel.functions.register(
      "double",
      "function double(value: number) { return value * 2; }",
      (value: unknown) => Number(value) * 2,
    );
    kernel.handlers.register(
      "servePage",
      "function servePage(c) { return c.html(templates.get('home') ?? ''); }",
      () => new Response(),
    );
    kernel.routes.register("GET", "/", "servePage");
    kernel.templates.register("home", "<h1>Hello</h1>");

    const { files } = await exportProject(kernel);
    const deps = fileContent(files, "deps.ts");
    const main = fileContent(files, "main.ts");
    const handler = fileContent(files, "handlers/servePage.ts");

    assertStringIncludes(
      deps,
      "type ExportedFunction = (...args: any[]) => any;",
    );
    assertStringIncludes(deps, "call(name: string, ...args: any[]): any");
    assertStringIncludes(deps, "get(name: string): any");
    assertStringIncludes(deps, "export const templates");
    assertStringIncludes(deps, "export const log");
    assertStringIncludes(deps, "export function assertNever");
    assertStringIncludes(handler, "templates, log } from");
    // The wired app is an importable factory; registration, DB init, built-in
    // routes and route mounts all live inside it (indented), not at module top.
    assertStringIncludes(
      main,
      `export async function createApp(): Promise<ExportedApp> {`,
    );
    assertStringIncludes(main, `  functions.register("double", $f_double);`);
    assertStringIncludes(
      main,
      `  templates.register("home", "<h1>Hello</h1>");`,
    );
    // The generated platform routes lead the table, because precedence is
    // registration order and that is where the Hono shell's app.get calls put them.
    assertStringIncludes(
      main,
      `    { method: "GET", path: "/_health", handlerName: "platform:health" },`,
    );
    assertStringIncludes(
      main,
      `      Response.json({ ok: true, name: APP_NAME, version: APP_VERSION }),`,
    );
    assertStringIncludes(
      main,
      `    { method: "GET", path: "/", handlerName: "servePage" },`,
    );
    assertStringIncludes(main, `    "servePage": $legacy_servePage,`);
    // An EMPTY validators table, and no validators.ts, because this kernel's one route
    // declares no schema. An app with nothing to validate keeps the bytes it had before
    // validation existed — the conditional emission is what buys that.
    assertStringIncludes(
      main,
      `  return createFetchApp(routeTable, handlers, {});`,
    );
    assertEquals(files.some((f) => f.path === "validators.ts"), false);
    // validation.ts ships regardless: the shell imports it unconditionally.
    assertStringIncludes(main, `} from "./validation.ts";`);
  } finally {
    await db.close();
  }
});

Deno.test("exportProject imports assertNever only when the module needs it", async () => {
  const db = await Database.create({ driver: "pglite" });
  try {
    const kernel = new Kernel(db, { composition: testStoreComposition() });
    kernel.handlers.register(
      "withImportedAssertNever",
      `function withImportedAssertNever(c) {
  const status = "ready" as "ready";
  switch (status) {
    case "ready": return c.text("ok");
    default: return assertNever(status);
  }
}`,
      () => new Response(),
    );
    kernel.handlers.register(
      "withLocalAssertNever",
      `function assertNever(x: never): never {
  throw new Error(String(x));
}
function withLocalAssertNever(c) {
  return c.text("ok");
}`,
      () => new Response(),
    );

    const { files } = await exportProject(kernel);
    const imported = fileContent(files, "handlers/withImportedAssertNever.ts");
    const local = fileContent(files, "handlers/withLocalAssertNever.ts");

    assertStringIncludes(imported, "templates, log, assertNever } from");
    assert(!local.includes("assertNever } from"));
  } finally {
    await db.close();
  }
});

Deno.test("exportProject serves OpenAPI spec when one is exported", async () => {
  const db = await Database.create({ driver: "pglite" });
  try {
    const kernel = new Kernel(db, { composition: testStoreComposition() });
    kernel.handlers.register(
      "smoke",
      "function smoke(c: any) { return c.json({ ok: true }); }",
      () => new Response(),
    );
    kernel.routes.register("GET", "/smoke", "smoke", {
      summary: "Smoke test",
    });

    const { files } = await exportProject(kernel);
    const main = fileContent(files, "main.ts");

    assert(files.some((file) => file.path === "openapi.json"));
    assertStringIncludes(
      main,
      `    { method: "GET", path: "/openapi.json", handlerName: "platform:openapi" },`,
    );
    assertStringIncludes(
      main,
      `Deno.readTextFileSync(runtimeFile("openapi.json"))`,
    );
    assertStringIncludes(
      main,
      `"content-type": "application/json; charset=utf-8"`,
    );
  } finally {
    await db.close();
  }
});

Deno.test("exportProject emits runtime CLI, port fallback, and shutdown defaults", async () => {
  const db = await Database.create({ driver: "pglite" });
  try {
    const kernel = new Kernel(db, { composition: testStoreComposition() });
    const { files } = await exportProject(kernel, {
      projectName: "CLI App",
      projectVersion: "9.8.7",
    });
    const main = fileContent(files, "main.ts");

    assertStringIncludes(main, `const APP_NAME = "CLI App";`);
    assertStringIncludes(main, `const APP_VERSION = "9.8.7";`);
    assertStringIncludes(main, `-h, --help`);
    assertStringIncludes(main, `-p, --port <port|auto>`);
    assertStringIncludes(main, `--random-port`);
    assertStringIncludes(main, `if (arg === "--")`);
    assertStringIncludes(main, `hostname: cliHost || env.HOST || "127.0.0.1"`);
    assertStringIncludes(
      main,
      `allowPortFallback: randomizeFirstPort || autoPort || !explicitPort`,
    );
    assertStringIncludes(
      main,
      `Port \${nextPort} is unavailable; trying another port.`,
    );
    // The Deno.serve line is still emitted verbatim so the Node build can rewrite
    // it; startServer now takes the app so no module-global `app` binding remains.
    assertStringIncludes(
      main,
      `return Deno.serve({ hostname, port, onListen: () => {} }, (req) => app.fetch(req));`,
    );
    assertStringIncludes(main, `async function startServer(app: ExportedApp,`);
    // Server startup is behind the entrypoint guard; a plain import runs none of it.
    assertStringIncludes(main, `function isEntrypoint(): boolean {`);
    assertStringIncludes(main, `  return import.meta.main === true;`);
    assertStringIncludes(main, `if (isEntrypoint()) {`);
    assertStringIncludes(main, `  const app = await createApp();`);
    assertStringIncludes(
      main,
      `  const server = await startServer(app, startup);`,
    );
    assertStringIncludes(main, `registerShutdown(server);`);
    assertStringIncludes(main, `handle.shutdown`);
    assertStringIncludes(main, `displayHost(boundHost)`);
  } finally {
    await db.close();
  }
});

Deno.test("exportProject quotes generated .env values", async () => {
  const db = await Database.create({ driver: "pglite" });
  try {
    const kernel = new Kernel(db, { composition: testStoreComposition() });
    kernel.envVars.define("PLAIN", "simple");
    kernel.envVars.define("WITH_SPACE", "hello world");
    kernel.envVars.define("WITH_QUOTE", 'hello "world"');
    kernel.envVars.define("WITH_NEWLINE", "hello\nworld");

    const { files } = await exportProject(kernel, { includeEnvFile: true });
    const dotEnv = fileContent(files, ".env");

    assertStringIncludes(dotEnv, "PLAIN=simple");
    assertStringIncludes(dotEnv, 'WITH_SPACE="hello world"');
    assertStringIncludes(dotEnv, 'WITH_QUOTE="hello \\"world\\""');
    assertStringIncludes(dotEnv, 'WITH_NEWLINE="hello\\nworld"');
  } finally {
    await db.close();
  }
});

Deno.test("exportProject documents runtime config, env, and seed behavior", async () => {
  const db = await Database.create({ driver: "pglite" });
  try {
    const kernel = new Kernel(db, { composition: testStoreComposition() });
    kernel.configs.set("PAGE_SIZE", 25);
    kernel.envVars.define("PUBLIC_URL", "https://example.test");
    await kernel.db.defineSchema(
      "items",
      "CREATE TABLE items (id SERIAL PRIMARY KEY, name TEXT NOT NULL)",
    );

    const { files } = await exportProject(kernel, {
      includeSeedData: true,
      projectName: "Docs App",
    });
    const readme = fileContent(files, "README.md");
    const agent = fileContent(files, "AGENT.md");

    assertStringIncludes(
      readme,
      "Configuration values are embedded into the exported app at build time",
    );
    assertStringIncludes(
      readme,
      "Runtime environment values are read from process environment first",
    );
    assertStringIncludes(
      readme,
      "Captured local rows are applied only when initializing a fresh database",
    );
    assertStringIncludes(readme, "deno task start -- --help");
    assertStringIncludes(readme, "./app --random-port");
    assertStringIncludes(
      readme,
      "`GET /_health` returns a health response with app name and version.",
    );
    assertStringIncludes(
      readme,
      "`GET /openapi.json` serves the exported OpenAPI spec when present.",
    );
    assertStringIncludes(
      agent,
      "App configs are embedded into `deps.ts` at export time",
    );
    assertStringIncludes(agent, "## Application Source of Truth");
    assertStringIncludes(
      agent,
      "`_temp_build` and temporary export/typecheck tables are not where the app's JavaScript lives",
    );
    assertStringIncludes(
      agent,
      "`seed.sql` is included and applies captured local rows only when initializing a fresh database",
    );
  } finally {
    await db.close();
  }
});

Deno.test("exported .gitignore is the one scaffolding template, not a copy", async () => {
  // These were two byte-identical literals that had already drifted apart.
  const db = await Database.create({ driver: "pglite" });
  try {
    const kernel = new Kernel(db, { composition: testStoreComposition() });
    const { files } = await exportProject(kernel, { includeGitignore: true });
    assertEquals(fileContent(files, ".gitignore"), PROJECT_GITIGNORE);
  } finally {
    await db.close();
  }
});

// --- Handler ABI in the exported shell (stage 7) -------------------------------
//
// The exported app is hosted on Hono, so wiring depends on which ABI the handler
// was written against: a fetch handler gets an adapter closure, a legacy one gets
// the real Context handed straight to it. Both shapes must work in one app, since
// a project mid-migration will have both.

Deno.test("exportProject wires each route by its handler's ABI", async () => {
  const db = await Database.create({ driver: "pglite" });
  try {
    const kernel = new Kernel(db, { composition: testStoreComposition() });
    kernel.handlers.register(
      "fetchStyle",
      `async function fetchStyle(req: Request, ctx: HandlerContext): Promise<Response> {
  const body = await req.json();
  return Response.json({ body, id: ctx.params.id });
}`,
      () => new Response(),
    );
    kernel.handlers.register(
      "legacyStyle",
      `function legacyStyle(c) { return c.json({ id: c.req.param("id") }); }`,
      () => new Response(),
    );
    kernel.routes.register("POST", "/fetch/:id", "fetchStyle");
    kernel.routes.register("GET", "/legacy/:id", "legacyStyle");

    const { files } = await exportProject(kernel);
    const main = fileContent(files, "main.ts");

    assertStringIncludes(
      main,
      `    { method: "POST", path: "/fetch/:id", handlerName: "fetchStyle" },`,
    );
    assertStringIncludes(main, `    "fetchStyle": $h_fetchStyle,`);
    // A legacy handler reaches the same adapter closure as a fetch handler; the
    // emitted shim (not Hono) builds the context it is called with.
    assertStringIncludes(
      main,
      `const $legacy_legacyStyle = wrapLegacyContextHandler($h_legacyStyle as unknown as LegacyHandlerFn);`,
    );
    assertStringIncludes(
      main,
      `    { method: "GET", path: "/legacy/:id", handlerName: "legacyStyle" },`,
    );
    assertStringIncludes(main, `    "legacyStyle": $legacy_legacyStyle,`);
  } finally {
    await db.close();
  }
});

Deno.test("exported handler modules import the ambient types they annotate with", async () => {
  const db = await Database.create({ driver: "pglite" });
  try {
    const kernel = new Kernel(db, { composition: testStoreComposition() });
    kernel.handlers.register(
      "annotated",
      `function annotated(req: Request, ctx: HandlerContext): Response {
  return Response.json({ id: ctx.params.id });
}`,
      () => new Response(),
    );
    kernel.handlers.register(
      "legacyAnnotated",
      `function legacyAnnotated(c: Context) { return c.text("hi"); }`,
      () => new Response(),
    );
    kernel.handlers.register(
      "legacySelfImporting",
      `import type { Context } from "hono";\nfunction legacySelfImporting(c: Context) { return c.text("hi"); }`,
      () => new Response(),
    );
    kernel.handlers.register(
      "bare",
      `function bare(c) { return c.text("hi"); }`,
      () => new Response(),
    );

    const { files } = await exportProject(kernel);
    const deps = fileContent(files, "deps.ts");

    // HandlerContext is ambient in the kernel; the export has to hand it over.
    assertStringIncludes(deps, "export interface HandlerContext {");
    assertStringIncludes(
      fileContent(files, "handlers/annotated.ts"),
      'log, type HandlerContext } from "../deps.ts";',
    );

    // Legacy: the Context type import the source omitted, added once and only once,
    // pointing at the emitted shim rather than at Hono — the exported tree has no
    // `hono` import-map entry to resolve.
    const legacy = fileContent(files, "handlers/legacyAnnotated.ts");
    assertStringIncludes(
      legacy,
      `import type { Context } from "../context-shim.ts";`,
    );
    // Once: the injected import line, plus the annotation the source already had.
    assertEquals(
      legacy.match(/from "\.\.\/context-shim\.ts"/g)?.length,
      1,
    );
    assert(!legacy.includes("hono"));

    // A source carrying its own Context import keeps it, with the specifier moved.
    const selfImporting = fileContent(
      files,
      "handlers/legacySelfImporting.ts",
    );
    assertStringIncludes(
      selfImporting,
      `import type { Context } from "../context-shim.ts";`,
    );
    assertEquals(
      selfImporting.match(/from "\.\.\/context-shim\.ts"/g)?.length,
      1,
    );
    assert(!selfImporting.includes("hono"));

    // And the shim it all resolves to is actually in the tree.
    assertStringIncludes(
      fileContent(files, "context-shim.ts"),
      "export function wrapLegacyContextHandler(",
    );

    // A handler that annotates nothing gets neither — byte-identical to before.
    const bare = fileContent(files, "handlers/bare.ts");
    assert(!bare.includes("context-shim"));
    assert(!bare.includes("HandlerContext"));
  } finally {
    await db.close();
  }
});

Deno.test("exported app serves both handler ABIs over a real request", async () => {
  const db = await Database.create({ driver: "pglite" });
  const tmpDir = Deno.makeTempDirSync({ prefix: "export-abi-" });
  try {
    const kernel = new Kernel(db, { composition: testStoreComposition() });
    // The whole point of the stage: `await req.json()` must return the parsed body.
    // Wired the old way this invokes Hono's c.json() — the RESPONSE constructor —
    // and the handler silently receives a Response instead. No error, wrong data.
    kernel.handlers.register(
      "echo",
      `async function echo(req, ctx) {
  const body = await req.json();
  return Response.json({ echoed: body.value, id: ctx.params.id, method: req.method });
}`,
      () => new Response(),
    );
    kernel.handlers.register(
      "legacyEcho",
      `function legacyEcho(c) { return c.json({ id: c.req.param("id") }); }`,
      () => new Response(),
    );
    kernel.routes.register("POST", "/echo/:id", "echo");
    kernel.routes.register("GET", "/legacy/:id", "legacyEcho");

    const { files } = await exportProject(kernel);
    writeExportFiles(tmpDir, files);
    const prevCwd = Deno.cwd();
    Deno.chdir(tmpDir);
    try {
      const mod = await import(pathToFileURL(join(tmpDir, "main.ts")).href) as {
        createApp: () => Promise<{ fetch(req: Request): Promise<Response> }>;
      };
      const app = await mod.createApp();

      const fetched = await app.fetch(
        new Request("http://localhost/echo/42", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ value: "hello" }),
        }),
      );
      assertEquals(fetched.status, 200);
      assertEquals(await fetched.json(), {
        echoed: "hello",
        id: "42",
        method: "POST",
      });

      const legacy = await app.fetch(new Request("http://localhost/legacy/7"));
      assertEquals(legacy.status, 200);
      assertEquals(await legacy.json(), { id: "7" });
    } finally {
      Deno.chdir(prevCwd);
    }
  } finally {
    await db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  }
});
