import type { ColumnDef } from "../types.ts";

export interface ReverseSqlResult {
  reverseSql: string | null;
  reversible: boolean;
}

export function generateReverseSql(
  sql: string,
  tableName: string,
  columnsBefore: ColumnDef[],
): ReverseSqlResult {
  const normalized = sql.trim().replace(/;\s*$/, "");
  const t = `"${tableName}"`;

  const addCol = normalized.match(
    /^ALTER\s+TABLE\s+(?:"?\w+"?)\s+ADD\s+(?:COLUMN\s+)?("?\w+"?)/i,
  );
  if (addCol) {
    const colName = addCol[1]!.replace(/"/g, "");
    return {
      reverseSql: `ALTER TABLE ${t} DROP COLUMN "${colName}"`,
      reversible: true,
    };
  }

  const dropCol = normalized.match(
    /^ALTER\s+TABLE\s+(?:"?\w+"?)\s+DROP\s+(?:COLUMN\s+)?(?:IF\s+EXISTS\s+)?("?\w+"?)/i,
  );
  if (dropCol) {
    const colName = dropCol[1]!.replace(/"/g, "");
    const col = columnsBefore.find((c) => c.name === colName);
    if (col) {
      let def = `"${col.name}" ${col.type}`;
      if (!col.nullable && !col.primaryKey) def += " NOT NULL";
      if (col.defaultValue) def += ` DEFAULT ${col.defaultValue}`;
      return {
        reverseSql: `ALTER TABLE ${t} ADD COLUMN ${def}`,
        reversible: true,
      };
    }
    return { reverseSql: null, reversible: false };
  }

  const renameCol = normalized.match(
    /^ALTER\s+TABLE\s+(?:"?\w+"?)\s+RENAME\s+COLUMN\s+("?\w+"?)\s+TO\s+("?\w+"?)/i,
  );
  if (renameCol) {
    const from = renameCol[1]!.replace(/"/g, "");
    const to = renameCol[2]!.replace(/"/g, "");
    return {
      reverseSql: `ALTER TABLE ${t} RENAME COLUMN "${to}" TO "${from}"`,
      reversible: true,
    };
  }

  const alterType = normalized.match(
    /^ALTER\s+TABLE\s+(?:"?\w+"?)\s+ALTER\s+COLUMN\s+("?\w+"?)\s+(?:SET\s+DATA\s+)?TYPE\s+/i,
  );
  if (alterType) {
    const colName = alterType[1]!.replace(/"/g, "");
    const col = columnsBefore.find((c) => c.name === colName);
    if (col) {
      return {
        reverseSql:
          `ALTER TABLE ${t} ALTER COLUMN "${colName}" TYPE ${col.type}`,
        reversible: true,
      };
    }
    return { reverseSql: null, reversible: false };
  }

  const setNotNull = normalized.match(
    /^ALTER\s+TABLE\s+(?:"?\w+"?)\s+ALTER\s+COLUMN\s+("?\w+"?)\s+SET\s+NOT\s+NULL$/i,
  );
  if (setNotNull) {
    const colName = setNotNull[1]!.replace(/"/g, "");
    return {
      reverseSql: `ALTER TABLE ${t} ALTER COLUMN "${colName}" DROP NOT NULL`,
      reversible: true,
    };
  }

  const dropNotNull = normalized.match(
    /^ALTER\s+TABLE\s+(?:"?\w+"?)\s+ALTER\s+COLUMN\s+("?\w+"?)\s+DROP\s+NOT\s+NULL$/i,
  );
  if (dropNotNull) {
    const colName = dropNotNull[1]!.replace(/"/g, "");
    return {
      reverseSql: `ALTER TABLE ${t} ALTER COLUMN "${colName}" SET NOT NULL`,
      reversible: true,
    };
  }

  const setDefault = normalized.match(
    /^ALTER\s+TABLE\s+(?:"?\w+"?)\s+ALTER\s+COLUMN\s+("?\w+"?)\s+SET\s+DEFAULT\s+/i,
  );
  if (setDefault) {
    const colName = setDefault[1]!.replace(/"/g, "");
    const col = columnsBefore.find((c) => c.name === colName);
    if (col?.defaultValue) {
      return {
        reverseSql:
          `ALTER TABLE ${t} ALTER COLUMN "${colName}" SET DEFAULT ${col.defaultValue}`,
        reversible: true,
      };
    }
    return {
      reverseSql: `ALTER TABLE ${t} ALTER COLUMN "${colName}" DROP DEFAULT`,
      reversible: true,
    };
  }

  const dropDefault = normalized.match(
    /^ALTER\s+TABLE\s+(?:"?\w+"?)\s+ALTER\s+COLUMN\s+("?\w+"?)\s+DROP\s+DEFAULT$/i,
  );
  if (dropDefault) {
    const colName = dropDefault[1]!.replace(/"/g, "");
    const col = columnsBefore.find((c) => c.name === colName);
    if (col?.defaultValue) {
      return {
        reverseSql:
          `ALTER TABLE ${t} ALTER COLUMN "${colName}" SET DEFAULT ${col.defaultValue}`,
        reversible: true,
      };
    }
    return { reverseSql: null, reversible: false };
  }

  const createIdx = normalized.match(
    /^CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:CONCURRENTLY\s+)?(?:IF\s+NOT\s+EXISTS\s+)?("?\w+"?)\s+ON\b/i,
  );
  if (createIdx) {
    const idxName = createIdx[1]!.replace(/"/g, "");
    return {
      reverseSql: `DROP INDEX IF EXISTS "${idxName}"`,
      reversible: true,
    };
  }

  const dropIdx = normalized.match(
    /^DROP\s+INDEX\s+(?:CONCURRENTLY\s+)?(?:IF\s+EXISTS\s+)?("?\w+"?)/i,
  );
  if (dropIdx) {
    return { reverseSql: null, reversible: false };
  }

  if (/^CREATE\s+TABLE\b/i.test(normalized)) {
    return { reverseSql: `DROP TABLE IF EXISTS ${t}`, reversible: true };
  }

  return { reverseSql: null, reversible: false };
}
