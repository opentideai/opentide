import { assertEquals } from "@std/assert";
import { generateReverseSql } from "./reverse-sql.ts";
import type { ColumnDef } from "../types.ts";

const cols: ColumnDef[] = [
  {
    name: "id",
    type: "INTEGER",
    nullable: false,
    defaultValue: null,
    primaryKey: true,
  },
  {
    name: "name",
    type: "TEXT",
    nullable: false,
    defaultValue: null,
    primaryKey: false,
  },
  {
    name: "email",
    type: "TEXT",
    nullable: true,
    defaultValue: null,
    primaryKey: false,
  },
  {
    name: "score",
    type: "INTEGER",
    nullable: false,
    defaultValue: "0",
    primaryKey: false,
  },
];

Deno.test("ADD COLUMN → DROP COLUMN", () => {
  const r = generateReverseSql(
    "ALTER TABLE users ADD COLUMN age INTEGER",
    "users",
    cols,
  );
  assertEquals(r.reversible, true);
  assertEquals(r.reverseSql, 'ALTER TABLE "users" DROP COLUMN "age"');
});

Deno.test("ADD COLUMN with COLUMN keyword omitted", () => {
  const r = generateReverseSql(
    'ALTER TABLE "users" ADD age INTEGER',
    "users",
    cols,
  );
  assertEquals(r.reversible, true);
  assertEquals(r.reverseSql, 'ALTER TABLE "users" DROP COLUMN "age"');
});

Deno.test("DROP COLUMN → ADD COLUMN from snapshot", () => {
  const r = generateReverseSql(
    "ALTER TABLE users DROP COLUMN name",
    "users",
    cols,
  );
  assertEquals(r.reversible, true);
  assertEquals(
    r.reverseSql,
    'ALTER TABLE "users" ADD COLUMN "name" TEXT NOT NULL',
  );
});

Deno.test("DROP COLUMN with default → ADD COLUMN with default", () => {
  const r = generateReverseSql(
    "ALTER TABLE users DROP COLUMN score",
    "users",
    cols,
  );
  assertEquals(r.reversible, true);
  assertEquals(
    r.reverseSql,
    'ALTER TABLE "users" ADD COLUMN "score" INTEGER NOT NULL DEFAULT 0',
  );
});

Deno.test("DROP COLUMN nullable → ADD COLUMN without NOT NULL", () => {
  const r = generateReverseSql(
    "ALTER TABLE users DROP COLUMN email",
    "users",
    cols,
  );
  assertEquals(r.reversible, true);
  assertEquals(r.reverseSql, 'ALTER TABLE "users" ADD COLUMN "email" TEXT');
});

Deno.test("DROP COLUMN unknown → not reversible", () => {
  const r = generateReverseSql(
    "ALTER TABLE users DROP COLUMN nonexistent",
    "users",
    cols,
  );
  assertEquals(r.reversible, false);
  assertEquals(r.reverseSql, null);
});

Deno.test("DROP COLUMN IF EXISTS", () => {
  const r = generateReverseSql(
    "ALTER TABLE users DROP COLUMN IF EXISTS name",
    "users",
    cols,
  );
  assertEquals(r.reversible, true);
  assertEquals(
    r.reverseSql,
    'ALTER TABLE "users" ADD COLUMN "name" TEXT NOT NULL',
  );
});

Deno.test("RENAME COLUMN → reverse rename", () => {
  const r = generateReverseSql(
    "ALTER TABLE users RENAME COLUMN name TO full_name",
    "users",
    cols,
  );
  assertEquals(r.reversible, true);
  assertEquals(
    r.reverseSql,
    'ALTER TABLE "users" RENAME COLUMN "full_name" TO "name"',
  );
});

Deno.test("ALTER COLUMN TYPE → reverse type from snapshot", () => {
  const r = generateReverseSql(
    "ALTER TABLE users ALTER COLUMN name TYPE VARCHAR(255)",
    "users",
    cols,
  );
  assertEquals(r.reversible, true);
  assertEquals(
    r.reverseSql,
    'ALTER TABLE "users" ALTER COLUMN "name" TYPE TEXT',
  );
});

Deno.test("ALTER COLUMN SET DATA TYPE → reverse type", () => {
  const r = generateReverseSql(
    "ALTER TABLE users ALTER COLUMN name SET DATA TYPE VARCHAR(255)",
    "users",
    cols,
  );
  assertEquals(r.reversible, true);
  assertEquals(
    r.reverseSql,
    'ALTER TABLE "users" ALTER COLUMN "name" TYPE TEXT',
  );
});

Deno.test("ALTER COLUMN TYPE unknown column → not reversible", () => {
  const r = generateReverseSql(
    "ALTER TABLE users ALTER COLUMN foo TYPE TEXT",
    "users",
    cols,
  );
  assertEquals(r.reversible, false);
  assertEquals(r.reverseSql, null);
});

Deno.test("SET NOT NULL → DROP NOT NULL", () => {
  const r = generateReverseSql(
    "ALTER TABLE users ALTER COLUMN email SET NOT NULL",
    "users",
    cols,
  );
  assertEquals(r.reversible, true);
  assertEquals(
    r.reverseSql,
    'ALTER TABLE "users" ALTER COLUMN "email" DROP NOT NULL',
  );
});

Deno.test("DROP NOT NULL → SET NOT NULL", () => {
  const r = generateReverseSql(
    "ALTER TABLE users ALTER COLUMN name DROP NOT NULL",
    "users",
    cols,
  );
  assertEquals(r.reversible, true);
  assertEquals(
    r.reverseSql,
    'ALTER TABLE "users" ALTER COLUMN "name" SET NOT NULL',
  );
});

Deno.test("SET DEFAULT (no previous) → DROP DEFAULT", () => {
  const r = generateReverseSql(
    "ALTER TABLE users ALTER COLUMN name SET DEFAULT 'anon'",
    "users",
    cols,
  );
  assertEquals(r.reversible, true);
  assertEquals(
    r.reverseSql,
    'ALTER TABLE "users" ALTER COLUMN "name" DROP DEFAULT',
  );
});

Deno.test("SET DEFAULT (had previous) → SET DEFAULT old", () => {
  const r = generateReverseSql(
    "ALTER TABLE users ALTER COLUMN score SET DEFAULT 100",
    "users",
    cols,
  );
  assertEquals(r.reversible, true);
  assertEquals(
    r.reverseSql,
    'ALTER TABLE "users" ALTER COLUMN "score" SET DEFAULT 0',
  );
});

Deno.test("DROP DEFAULT (had previous) → SET DEFAULT old", () => {
  const r = generateReverseSql(
    "ALTER TABLE users ALTER COLUMN score DROP DEFAULT",
    "users",
    cols,
  );
  assertEquals(r.reversible, true);
  assertEquals(
    r.reverseSql,
    'ALTER TABLE "users" ALTER COLUMN "score" SET DEFAULT 0',
  );
});

Deno.test("DROP DEFAULT (no previous) → not reversible", () => {
  const r = generateReverseSql(
    "ALTER TABLE users ALTER COLUMN name DROP DEFAULT",
    "users",
    cols,
  );
  assertEquals(r.reversible, false);
  assertEquals(r.reverseSql, null);
});

Deno.test("CREATE INDEX → DROP INDEX", () => {
  const r = generateReverseSql(
    "CREATE INDEX idx_users_name ON users (name)",
    "users",
    cols,
  );
  assertEquals(r.reversible, true);
  assertEquals(r.reverseSql, 'DROP INDEX IF EXISTS "idx_users_name"');
});

Deno.test("CREATE UNIQUE INDEX → DROP INDEX", () => {
  const r = generateReverseSql(
    "CREATE UNIQUE INDEX idx_email ON users (email)",
    "users",
    cols,
  );
  assertEquals(r.reversible, true);
  assertEquals(r.reverseSql, 'DROP INDEX IF EXISTS "idx_email"');
});

Deno.test("CREATE INDEX IF NOT EXISTS → DROP INDEX", () => {
  const r = generateReverseSql(
    "CREATE INDEX IF NOT EXISTS idx_name ON users (name)",
    "users",
    cols,
  );
  assertEquals(r.reversible, true);
  assertEquals(r.reverseSql, 'DROP INDEX IF EXISTS "idx_name"');
});

Deno.test("DROP INDEX → not reversible", () => {
  const r = generateReverseSql("DROP INDEX idx_users_name", "users", cols);
  assertEquals(r.reversible, false);
  assertEquals(r.reverseSql, null);
});

Deno.test("CREATE TABLE → DROP TABLE", () => {
  const r = generateReverseSql(
    "CREATE TABLE users (id SERIAL PRIMARY KEY)",
    "users",
    [],
  );
  assertEquals(r.reversible, true);
  assertEquals(r.reverseSql, 'DROP TABLE IF EXISTS "users"');
});

Deno.test("unrecognized DDL → not reversible", () => {
  const r = generateReverseSql("TRUNCATE TABLE users", "users", cols);
  assertEquals(r.reversible, false);
  assertEquals(r.reverseSql, null);
});

Deno.test("trailing semicolon is stripped", () => {
  const r = generateReverseSql(
    "ALTER TABLE users ADD COLUMN age INTEGER;",
    "users",
    cols,
  );
  assertEquals(r.reversible, true);
  assertEquals(r.reverseSql, 'ALTER TABLE "users" DROP COLUMN "age"');
});
