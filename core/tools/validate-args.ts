// @layer core — argument checking against a tool's own input_schema.
//
// Dispatch reads arguments by name and ignores everything else, so a wrong name
// is not an error — it is a silently missing value. `query_database({query})`
// returns zero rows, `run_tests({name})` runs the whole suite, a criterion with a
// typo'd priority is quietly stored as `should`. This module turns
// those into a refusal that names the right key.
//
// Deliberately small: every tool schema in definitions.ts is a flat
// `{type, properties, required}` (no oneOf/anyOf/$ref), so this checks exactly
// what they declare — unknown keys, missing required keys, enum values — at
// every level the schema describes (object properties and array items). An
// object schema is closed unless it says `additionalProperties: true`. It does not
// type-check values: dispatch coerces in places, and refusing those would break
// calls that work today.

type Schema = Record<string, unknown>;

export interface ArgIssue {
  // Dotted location, e.g. "plan.acceptanceCriteria[0].priority".
  path: string;
  message: string;
}

export interface ArgCheck {
  // The arguments to dispatch: the input with accepted aliases renamed.
  args: Record<string, unknown>;
  issues: ArgIssue[];
}

// Names that are always accepted for another key, because dispatch already
// honours them (set_env/delete_env read `key ?? name`). Not a place for new
// conveniences: each entry is permanent surface.
const ARG_ALIASES: Readonly<Record<string, Readonly<Record<string, string>>>> =
  {
    set_env: { name: "key" },
    delete_env: { name: "key" },
  };

// The wrong names agents actually send, per tool, mapped to the right one. Edit
// distance cannot find these (`query` is nowhere near `sql`), and each one has
// cost a session at least once (speed-read docs/known-issues.md).
const ARG_HINTS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  query_database: { query: "sql", statement: "sql" },
  execute_sql: { query: "sql", statement: "sql" },
  define_handler: { code: "source", body: "source" },
  define_function: { code: "source", body: "source" },
  define_test: { code: "source", body: "source" },
  run_script: { code: "source", script: "source" },
  lint_code: { code: "source" },
  register_route: { handler: "handlerName" },
  edit_entity_text: { kind: "type", key: "name" },
  remove_entity: { kind: "type", name: "key" },
  run_tests: { name: "pattern", names: "pattern", filter: "pattern" },
  create_changeset: {
    acceptanceCriteria: "plan.acceptanceCriteria",
    acceptance_criteria: "plan.acceptanceCriteria",
    steps: "plan.steps",
    summary: "plan.summary",
    verificationPlan: "plan.verificationPlan",
    verification_plan: "plan.verificationPlan",
  },
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function camelToSnake(key: string): string {
  return key.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
}

function snakeToCamel(key: string): string {
  return key.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());
}

// The declared key a camelCase/snake_case spelling of `key` stands for, if any.
// `changesetId` → `changeset_id`, `table_name` → `tableName`. Unambiguous, so it
// is accepted rather than refused.
function caseVariant(key: string, declared: Set<string>): string | undefined {
  for (const candidate of [camelToSnake(key), snakeToCamel(key)]) {
    if (candidate !== key && declared.has(candidate)) return candidate;
  }
  return undefined;
}

function editDistance(a: string, b: string): number {
  let row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const next = [i];
    for (let j = 1; j <= b.length; j++) {
      next.push(Math.min(
        (row[j] ?? 0) + 1,
        (next[j - 1] ?? 0) + 1,
        (row[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1),
      ));
    }
    row = next;
  }
  return row[b.length] ?? 0;
}

function closest(key: string, declared: string[]): string | undefined {
  let best: string | undefined;
  let bestDistance = 3; // accept a distance of at most 2
  for (const candidate of declared) {
    const d = editDistance(key.toLowerCase(), candidate.toLowerCase());
    if (d < bestDistance) {
      best = candidate;
      bestDistance = d;
    }
  }
  return best;
}

function join(path: string, key: string): string {
  return path ? `${path}.${key}` : key;
}

function quoteList(values: unknown[]): string {
  return values.map((v) => `\`${String(v)}\``).join(", ");
}

// Check one object against an object schema. `hints` applies only at the top
// level, where the per-tool table is keyed. Returns the object with accepted
// spellings renamed.
function checkObject(
  value: Record<string, unknown>,
  schema: Schema,
  path: string,
  issues: ArgIssue[],
  aliases: Readonly<Record<string, string>> = {},
  hints: Readonly<Record<string, string>> = {},
): Record<string, unknown> {
  const properties = isRecord(schema.properties)
    ? schema.properties as Record<string, Schema>
    : undefined;
  if (!properties) return value;
  const declared = new Set(Object.keys(properties));
  const open = schema.additionalProperties === true ||
    isRecord(schema.additionalProperties);

  const out: Record<string, unknown> = {};
  // Unknown keys with no suggestion, held until the missing keys are known.
  const unplaced: ArgIssue[] = [];
  for (const [rawKey, raw] of Object.entries(value)) {
    let key = rawKey;
    if (!declared.has(key)) {
      const renamed = aliases[key] ?? caseVariant(key, declared);
      if (renamed && !(renamed in value)) key = renamed;
    }
    if (declared.has(key)) {
      out[key] = checkValue(raw, properties[key], join(path, key), issues);
      continue;
    }
    out[key] = raw;
    if (open) continue;
    const hint = hints[rawKey];
    const near = hint ? hint : closest(rawKey, [...declared]);
    if (near) {
      issues.push(unknownArg(join(path, rawKey), hint ?? join(path, near)));
    } else {
      unplaced.push({ path: join(path, rawKey), message: "" });
    }
  }

  const required = Array.isArray(schema.required)
    ? schema.required as string[]
    : [];
  const missing = required.filter((key) => out[key] === undefined)
    .map((key) => join(path, key));
  // One unrecognised key and one missing required key: that is the rename.
  const [only] = missing;
  if (unplaced.length === 1 && missing.length === 1 && only) {
    issues.push(unknownArg(unplaced[0]!.path, only));
  } else {
    for (const issue of unplaced) {
      issues.push({
        path: issue.path,
        message: `unknown argument \`${issue.path}\`. Accepted: ${
          quoteList([...declared])
        }.`,
      });
    }
  }
  for (const key of missing) {
    issues.push({
      path: key,
      message: `missing required argument \`${key}\`.`,
    });
  }
  return out;
}

function unknownArg(path: string, suggestion: string): ArgIssue {
  return {
    path,
    message: `unknown argument \`${path}\` — did you mean \`${suggestion}\`?`,
  };
}

function checkValue(
  value: unknown,
  schema: Schema | undefined,
  path: string,
  issues: ArgIssue[],
): unknown {
  if (!schema || value === undefined || value === null) return value;
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
    issues.push({
      path,
      message: `\`${path}\` is ${JSON.stringify(value)}; it must be one of ${
        quoteList(schema.enum)
      }.`,
    });
    return value;
  }
  if (isRecord(value) && isRecord(schema.properties)) {
    return checkObject(value, schema, path, issues);
  }
  if (Array.isArray(value) && isRecord(schema.items)) {
    const items = schema.items as Schema;
    return value.map((item, i) => {
      const itemPath = `${path}[${i}]`;
      if (isRecord(item) && isRecord(items.properties)) {
        return checkObject(item, items, itemPath, issues);
      }
      return checkValue(item, items, itemPath, issues);
    });
  }
  return value;
}

// Check a tool call's arguments against its input_schema. Pure: never throws,
// never touches the kernel. Callers decide whether issues refuse the call.
export function checkToolArgs(
  toolName: string,
  schema: Schema,
  args: unknown,
): ArgCheck {
  const issues: ArgIssue[] = [];
  if (!isRecord(args)) {
    if (args === undefined || args === null) {
      return { args: {}, issues: [] };
    }
    return {
      args: {},
      issues: [{ path: "", message: "arguments must be a JSON object." }],
    };
  }
  const checked = checkObject(
    args,
    schema,
    "",
    issues,
    ARG_ALIASES[toolName],
    ARG_HINTS[toolName],
  );
  return { args: checked, issues };
}

// One refusal message for a failed check, listing every issue so the agent can
// fix the call in one retry instead of one issue per round-trip.
export function formatArgIssues(toolName: string, issues: ArgIssue[]): string {
  const lines = issues.map((issue) => `- ${issue.message}`);
  return `Tool "${toolName}" was not called: its arguments do not match its ` +
    `input schema.\n${lines.join("\n")}`;
}
