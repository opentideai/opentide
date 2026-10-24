import { assertEquals, assertExists } from "@std/assert";
import { createDatabase, type DatabaseConnection } from "./factory.ts";
import { SkillManager } from "../skills.ts";

const TABLE_DDL = `CREATE TABLE IF NOT EXISTS _genie_skills (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  description TEXT NOT NULL DEFAULT '',
  prompt TEXT NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT true,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
)`;

async function withSkills(
  fn: (mgr: SkillManager, conn: DatabaseConnection) => Promise<void>,
): Promise<void> {
  const conn = await createDatabase({ driver: "pglite" });
  await conn.drizzle.execute(TABLE_DDL);
  const mgr = new SkillManager(conn.drizzle);
  try {
    await fn(mgr, conn);
  } finally {
    await conn.close();
  }
}

Deno.test("create returns a skill with an auto-generated id", async () => {
  await withSkills(async (mgr) => {
    const skill = await mgr.create("greet", "Greeting skill", "Say hello");
    assertEquals(skill.name, "greet");
    assertEquals(skill.description, "Greeting skill");
    assertEquals(skill.prompt, "Say hello");
    assertEquals(skill.enabled, true);
    assertEquals(typeof skill.id, "number");
    assertExists(skill.createdAt);
    assertExists(skill.updatedAt);
  });
});

Deno.test("get returns a skill by id", async () => {
  await withSkills(async (mgr) => {
    const created = await mgr.create("test", "desc", "prompt");
    const fetched = await mgr.get(created.id);
    assertEquals(fetched?.name, "test");
    assertEquals(fetched?.id, created.id);
  });
});

Deno.test("get returns null for missing id", async () => {
  await withSkills(async (mgr) => {
    assertEquals(await mgr.get(999), null);
  });
});

Deno.test("update modifies skill fields", async () => {
  await withSkills(async (mgr) => {
    const skill = await mgr.create("original", "desc", "prompt");
    const updated = await mgr.update(skill.id, {
      name: "renamed",
      description: "new desc",
    });
    assertEquals(updated?.name, "renamed");
    assertEquals(updated?.description, "new desc");
    assertEquals(updated?.prompt, "prompt");
  });
});

Deno.test("update can disable a skill", async () => {
  await withSkills(async (mgr) => {
    const skill = await mgr.create("test", "desc", "prompt");
    const updated = await mgr.update(skill.id, { enabled: false });
    assertEquals(updated?.enabled, false);
  });
});

Deno.test("update returns null for missing id", async () => {
  await withSkills(async (mgr) => {
    assertEquals(await mgr.update(999, { name: "nope" }), null);
  });
});

Deno.test("delete removes a skill", async () => {
  await withSkills(async (mgr) => {
    const skill = await mgr.create("test", "desc", "prompt");
    const deleted = await mgr.delete(skill.id);
    assertEquals(deleted, true);
    assertEquals(await mgr.get(skill.id), null);
  });
});

Deno.test("delete returns false for missing id", async () => {
  await withSkills(async (mgr) => {
    assertEquals(await mgr.delete(999), false);
  });
});

Deno.test("list returns all skills ordered by name", async () => {
  await withSkills(async (mgr) => {
    await mgr.create("zebra", "", "p");
    await mgr.create("alpha", "", "p");
    await mgr.create("middle", "", "p");
    const list = await mgr.list();
    assertEquals(list.length, 3);
    assertEquals(list[0]!.name, "alpha");
    assertEquals(list[1]!.name, "middle");
    assertEquals(list[2]!.name, "zebra");
  });
});

Deno.test("listEnabled returns only enabled skills", async () => {
  await withSkills(async (mgr) => {
    const _s1 = await mgr.create("enabled1", "", "p");
    const s2 = await mgr.create("disabled1", "", "p");
    await mgr.create("enabled2", "", "p");
    await mgr.update(s2.id, { enabled: false });

    const enabled = await mgr.listEnabled();
    assertEquals(enabled.length, 2);
    assertEquals(enabled.every((s) => s.enabled), true);
  });
});

Deno.test("getSkillsHash returns consistent hash", async () => {
  await withSkills(async (mgr) => {
    await mgr.create("a", "desc", "prompt-a");
    await mgr.create("b", "desc", "prompt-b");
    const hash1 = await mgr.getSkillsHash();
    const hash2 = await mgr.getSkillsHash();
    assertEquals(hash1, hash2);
    const parsed = JSON.parse(hash1);
    assertEquals(parsed.length, 2);
    assertEquals(parsed[0].name, "a");
  });
});

Deno.test("auto-incremented ids are sequential", async () => {
  await withSkills(async (mgr) => {
    const s1 = await mgr.create("first", "", "p");
    const s2 = await mgr.create("second", "", "p");
    assertEquals(s2.id, s1.id + 1);
  });
});
