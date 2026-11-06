import { assert, assertEquals, assertRejects } from "@std/assert";
import { Database } from "../db.ts";
import { DynamicSchemaRegistry } from "../db/dynamic-schema.ts";
import { buildHandlerDb, type HandlerDb } from "../handler-db.ts";
import { tracedDb, Tracer } from "../tracer.ts";
import { dbExecHandler } from "./db-service.ts";
import { RpcPeer } from "./peer.ts";
import { RUNNER_METHODS } from "./protocol.ts";
import { buildRunnerDb, rpcDbExec } from "./runner-db.ts";
import { createMemoryTransportPair } from "./transport.ts";

const ITEMS_SQL = `CREATE TABLE items (
  id serial PRIMARY KEY,
  name text NOT NULL UNIQUE,
  tags jsonb,
  seen_at timestamp,
  big bigint,
  flag boolean
)`;

interface Side {
  db: HandlerDb;
  tracer: Tracer;
  close(): Promise<void>;
}

async function freshDatabase(): Promise<Database> {
  const database = await Database.create({ driver: "pglite" });
  const defined = await database.defineSchema("items", ITEMS_SQL);
  assert(defined.ok, JSON.stringify(defined));
  return database;
}

async function inProcess(): Promise<Side> {
  const database = await freshDatabase();
  return {
    db: buildHandlerDb(tracedDb(database), database.drizzle, database.schemas),
    tracer: new Tracer(),
    close: () => database.close(),
  };
}

async function overRpc(requestId?: () => string | undefined): Promise<Side> {
  const database = await freshDatabase();
  const tracer = new Tracer();
  const [kernelEnd, runnerEnd] = createMemoryTransportPair();
  const kernel = new RpcPeer(kernelEnd, {
    handlers: { [RUNNER_METHODS.dbExec]: dbExecHandler(database, tracer) },
  });
  const runner = new RpcPeer(runnerEnd);
  // Slice 4 pushes these; here they're copied from the kernel's registry.
  const schemas = new DynamicSchemaRegistry();
  for (const entry of await database.listSchemas()) {
    schemas.register(entry.tableName, entry.columns);
  }
  return {
    db: buildRunnerDb(rpcDbExec(runner, requestId), schemas),
    tracer,
    async close() {
      await runner.close();
      await kernel.close();
      await database.close();
    },
  };
}

// Runs the same user code against both and returns both answers.
async function both<T>(
  scenario: (db: HandlerDb) => Promise<T>,
): Promise<[T, T]> {
  const local = await inProcess();
  const remote = await overRpc();
  try {
    return [await scenario(local.db), await scenario(remote.db)];
  } finally {
    await local.close();
    await remote.close();
  }
}

const AT = new Date("2026-11-06T09:30:00.000Z");

async function seed(db: HandlerDb): Promise<unknown> {
  const items = db.tables.items;
  return await db.insert(items).values([
    {
      name: "a",
      tags: { k: [1, "two"] },
      seen_at: AT,
      big: 2 ** 40,
      flag: true,
    },
    { name: "b", tags: null, seen_at: null, big: 1, flag: false },
  ]).returning();
}

Deno.test("drizzle reads and writes come back the same as in-process", async () => {
  const [local, remote] = await both(async (db) => {
    const items = db.tables.items;
    const inserted = await seed(db);
    const plain = await db.insert(items).values({ name: "c", flag: null });
    const filtered = await db.select().from(items)
      .where(db.and(db.eq(items.flag, true), db.isNotNull(items.tags)));
    const picked = await db.select({ name: items.name, at: items.seen_at })
      .from(items).orderBy(db.desc(items.name));
    const counted = await db.select({ n: db.count() }).from(items);
    const updated = await db.update(items).set({ tags: ["x"] })
      .where(db.eq(items.name, "b")).returning({ tags: items.tags });
    const deleted = await db.delete(items).where(db.eq(items.name, "c"))
      .returning({ id: items.id });
    const viaSql = await db.select({
      upper: db.sql<string>`upper(${items.name})`,
    })
      .from(items).where(db.sql`${items.big} > ${10}`);
    return {
      inserted,
      plain,
      filtered,
      picked,
      counted,
      updated,
      deleted,
      viaSql,
    };
  });
  assertEquals(remote, local);
  const first = (local.inserted as { seen_at: Date }[])[0];
  assert(first?.seen_at instanceof Date, "timestamp maps to a Date");
});

Deno.test("raw db.query and db.execute come back the same, Dates included", async () => {
  const [local, remote] = await both(async (db) => {
    await seed(db);
    const rows = await db.query(
      "SELECT name, tags, seen_at, $1::timestamptz AS param_at FROM items ORDER BY id",
      [AT],
    );
    const changed = await db.execute("UPDATE items SET flag = $1", [true]);
    const noParams = await db.query("SELECT count(*)::int AS n FROM items");
    return { rows, changed, noParams };
  });
  assertEquals(remote, local);
});

async function caught(fn: () => Promise<unknown>): Promise<Error> {
  try {
    await fn();
  } catch (err) {
    assert(err instanceof Error);
    return err;
  }
  throw new Error("expected a failure");
}

Deno.test("a failed statement throws what in-process throws, driver fields included", async () => {
  const [local, remote] = await both(async (db) => {
    await seed(db);
    const dup = await caught(() =>
      db.insert(db.tables.items).values({ name: "a" })
    );
    const cause = dup.cause as Record<string, unknown>;
    const raw = await caught(() => db.query("SELECT nope FROM items"));
    return {
      dup: dup.message,
      causeName: (dup.cause as Error).name,
      causeMessage: (dup.cause as Error).message,
      code: cause.code,
      constraint: cause.constraint,
      raw: raw.message,
    };
  });
  assertEquals(remote, local);
  assertEquals(local.code, "23505");
});

Deno.test("raw statements land in the runner request's trace; drizzle ones don't, as in-process", async () => {
  const requestId = "req-1";
  const remote = await overRpc(() => requestId);
  try {
    const { trace } = await remote.tracer.run(
      requestId,
      "GET",
      "/",
      async () => {
        await remote.db.query("SELECT 1 AS one");
        await remote.db.select().from(remote.db.tables.items);
        await remote.db.execute("DELETE FROM items");
      },
    );
    assertEquals(trace.events.map((e) => e.type), ["db-query", "db-execute"]);
    assertEquals(trace.events[0]?.data.rowCount, 1);
  } finally {
    await remote.close();
  }
});

Deno.test("a statement for a request that's already finished runs untraced", async () => {
  const remote = await overRpc(() => "gone");
  try {
    assertEquals(await remote.db.query("SELECT 1 AS one"), [{ one: 1 }]);
    assertEquals(remote.tracer.getRecentTraces(), []);
  } finally {
    await remote.close();
  }
});

Deno.test("with the kernel gone, a statement fails instead of hanging", async () => {
  const remote = await overRpc();
  await remote.close();
  await assertRejects(() => remote.db.query("SELECT 1"), Error, "db.exec");
});

async function importedSpecifiers(module: string): Promise<string[]> {
  const out = await new Deno.Command(Deno.execPath(), {
    args: ["info", "--json", new URL(module, import.meta.url).href],
    stdout: "piped",
    stderr: "piped",
  }).output();
  assert(out.success, new TextDecoder().decode(out.stderr));
  const graph = JSON.parse(new TextDecoder().decode(out.stdout)) as {
    modules: { specifier: string }[];
  };
  return graph.modules.map((m) => m.specifier);
}

// The runner has no database: no driver should even load there.
Deno.test("runner-db.ts loads no database driver; db-service.ts does", async () => {
  const drivers = ["@electric-sql/pglite", "postgres"];
  const loads = (specifiers: string[], pkg: string) =>
    specifiers.some((s) => s.startsWith(`npm:/${pkg}@`));
  const runnerSide = await importedSpecifiers("./runner-db.ts");
  for (const pkg of drivers) assert(!loads(runnerSide, pkg), pkg);
  const kernelSide = await importedSpecifiers("./db-service.ts");
  for (const pkg of drivers) assert(loads(kernelSide, pkg), pkg);
});
