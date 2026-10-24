import { assertEquals, assertExists } from "@std/assert";
import { Database } from "../db.ts";
import { SessionManager } from "../sessions.ts";
import { Changelog } from "../changelog.ts";

const CONNECTION_STRING = Deno.env.get("OPENTIDE_POSTGRES_TEST_URL") ??
  "postgres://postgres:testpass@localhost:5433/genie_test";

async function canConnect(connectionString: string): Promise<boolean> {
  let conn: Deno.TcpConn | null = null;
  try {
    const url = new URL(connectionString);
    conn = await Deno.connect({
      hostname: url.hostname,
      port: Number(url.port || "5432"),
    });
    return true;
  } catch {
    return false;
  } finally {
    try {
      conn?.close();
    } catch {
      // Ignore probe cleanup failures.
    }
  }
}

const POSTGRES_AVAILABLE = await canConnect(CONNECTION_STRING);

async function withDb<T>(fn: (db: Database) => Promise<T>): Promise<T> {
  const db = await Database.create({
    driver: "postgres",
    connectionString: CONNECTION_STRING,
  });
  try {
    return await fn(db);
  } finally {
    await db.close();
  }
}

Deno.test({
  name: "postgres: migrations run and tables exist",
  ignore: !POSTGRES_AVAILABLE,
  fn: async () => {
    await withDb(async (db) => {
      const rows = await db.query(
        `SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename LIKE '_genie_%' ORDER BY tablename`,
      );
      const tables = rows.map((r) => r.tablename);
      assertEquals(tables.includes("_genie_sessions"), true);
      assertEquals(tables.includes("_genie_messages"), true);
      assertEquals(tables.includes("_genie_changelog"), true);
      assertEquals(tables.includes("_genie_schemas"), true);
      assertEquals(tables.includes("_genie_skills"), true);
      assertEquals(tables.includes("_genie_changesets"), true);
      assertEquals(tables.includes("_genie_meta"), true);
      assertEquals(tables.includes("_genie_turn_usage"), true);
    });
  },
});

Deno.test({
  name: "postgres: GIN index exists on messages",
  ignore: !POSTGRES_AVAILABLE,
  fn: async () => {
    await withDb(async (db) => {
      const rows = await db.query(
        `SELECT indexname FROM pg_indexes WHERE tablename = '_genie_messages' AND indexname = 'messages_content_search_idx'`,
      );
      assertEquals(rows.length, 1);
    });
  },
});

Deno.test({
  name: "postgres: defineSchema, query, execute roundtrip",
  ignore: !POSTGRES_AVAILABLE,
  fn: async () => {
    await withDb(async (db) => {
      const result = await db.defineSchema(
        "test_items",
        "CREATE TABLE test_items (id SERIAL PRIMARY KEY, name TEXT NOT NULL)",
      );
      assertEquals(result.ok, true);
      if (!result.ok) throw new Error("unreachable");

      await db.execute("INSERT INTO test_items (name) VALUES ($1)", ["widget"]);
      await db.execute("INSERT INTO test_items (name) VALUES ($1)", ["gadget"]);

      const rows = await db.query("SELECT * FROM test_items ORDER BY id");
      assertEquals(rows.length, 2);
      assertEquals(rows[0]?.name, "widget");
      assertEquals(rows[1]?.name, "gadget");

      await db.dropSchema("test_items");
    });
  },
});

Deno.test({
  name: "postgres: SessionManager CRUD",
  ignore: !POSTGRES_AVAILABLE,
  fn: async () => {
    await withDb(async (db) => {
      const sm = new SessionManager(db.drizzle);

      const session = await sm.createSession("Test Session");
      assertExists(session.id);
      assertEquals(session.name, "Test Session");

      const msg = await sm.addMessage({
        sessionId: session.id,
        role: "user",
        content: "hello postgres",
      });
      assertExists(msg.id);

      const messages = await sm.getMessages(session.id);
      assertEquals(messages.length, 1);
      assertEquals(messages[0]?.content, "hello postgres");

      const results = await sm.searchMessages("postgres");
      assertEquals(results.length, 1);

      await sm.deleteSession(session.id);
      const deleted = await sm.getSession(session.id);
      assertEquals(deleted, null);
    });
  },
});

Deno.test({
  name: "postgres: Changelog record and retrieve",
  ignore: !POSTGRES_AVAILABLE,
  fn: async () => {
    await withDb(async (db) => {
      const cl = new Changelog(db.drizzle);
      const countBefore = await cl.count();

      const record = await cl.record({
        category: "config",
        key: "pg_test_key",
        action: "update",
        beforeSnapshot: { value: 0 },
        afterSnapshot: { value: 1 },
        context: null,
      });
      assertExists(record.id);
      assertEquals(record.category, "config");
      assertEquals(record.key, "pg_test_key");

      const entry = await cl.get(record.id);
      assertExists(entry);
      assertEquals(entry!.key, "pg_test_key");
      assertEquals(entry!.beforeSnapshot, { value: 0 });
      assertEquals(entry!.afterSnapshot, { value: 1 });

      const countAfter = await cl.count();
      assertEquals(countAfter, countBefore + 1);
    });
  },
});
