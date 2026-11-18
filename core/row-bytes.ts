// @layer core — how many bytes a table's rows come to once read into JS, without
// reading them. Snapshots, data fixtures and an export's seed data all hold whole
// tables in the heap; on a big project that is what ran the server out of memory.
import type { Database } from "./db.ts";

// Size of a table's rows in bytes of their text form, or null when that is more
// than `limit`. On-disk size is checked first so a table that is plainly too big
// is never scanned; compression means it can only under-count, so a table that
// passes is then measured exactly, in the database, without a row reaching JS.
export async function rowBytesWithin(
  db: Database,
  tableName: string,
  limit: number,
): Promise<number | null> {
  if (limit <= 0) return null;
  const quoted = `"${tableName.replaceAll('"', '""')}"`;
  const [disk] = await db.query(
    `SELECT pg_table_size(to_regclass($1))::float8 AS bytes`,
    [quoted],
  );
  if (Number(disk?.bytes ?? 0) > limit) return null;
  const [text] = await db.query(
    `SELECT coalesce(sum(octet_length(t::text)), 0)::float8 AS bytes FROM ${quoted} t`,
  );
  const bytes = Number(text?.bytes ?? 0);
  return bytes > limit ? null : bytes;
}

// Throws when the rows of `tableNames` together come to more than `limit` bytes,
// naming the tables that did not fit. `what` names the thing being made, `advice`
// says what to do instead.
export async function assertRowsFit(
  db: Database,
  tableNames: string[],
  limit: number,
  what: string,
  advice: string,
): Promise<void> {
  let left = limit;
  const over: string[] = [];
  for (const tableName of tableNames) {
    const bytes = await rowBytesWithin(db, tableName, left);
    if (bytes === null) over.push(`"${tableName}"`);
    else left -= bytes;
  }
  if (over.length === 0) return;
  throw new Error(
    `${what} holds at most ${formatBytes(limit)} of rows, and ${
      over.join(", ")
    } ${over.length === 1 ? "does" : "do"} not fit. ${advice}`,
  );
}

export function formatBytes(n: number): string {
  return n >= 1024 * 1024
    ? `${(n / 1024 / 1024).toFixed(0)}MB`
    : `${(n / 1024).toFixed(0)}KB`;
}
