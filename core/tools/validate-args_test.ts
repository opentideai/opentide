import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { AGENT_TOOLS } from "./definitions.ts";
import { checkToolArgs, formatArgIssues } from "./validate-args.ts";

function schemaOf(name: string): Record<string, unknown> {
  const tool = AGENT_TOOLS.find((t) => t.name === name);
  assert(tool, `no tool ${name}`);
  return tool.input_schema;
}

function check(name: string, args: unknown) {
  return checkToolArgs(name, schemaOf(name), args);
}

function messages(name: string, args: unknown): string {
  return check(name, args).issues.map((i) => i.message).join("\n");
}

// Each row is a wrong call that has cost a session (speed-read
// docs/known-issues.md), and the key the refusal must point at.
const TRAPS: Array<[string, Record<string, unknown>, string]> = [
  ["query_database", { query: "select 1" }, "`sql`"],
  ["run_tests", { name: "testFoo" }, "`pattern`"],
  ["run_tests", { names: ["testFoo"] }, "`pattern`"],
  ["define_handler", { name: "h", code: "x" }, "`source`"],
  ["define_function", { name: "f", code: "x" }, "`source`"],
  ["run_script", { code: "1" }, "`source`"],
  ["register_route", {
    method: "GET",
    path: "/x",
    handler: "h",
  }, "`handlerName`"],
  ["edit_entity_text", { kind: "template", name: "t", edits: [] }, "`type`"],
  ["remove_entity", { type: "handler", name: "h" }, "`key`"],
  ["update_changeset_step", {
    changeset_id: "c",
    step_id: "step_0",
    status: "completed",
  }, "`done`"],
  ["create_changeset", {
    title: "t",
    plan: { summary: "s", steps: [] },
    acceptance_criteria: [],
  }, "`plan.acceptanceCriteria`"],
  ["create_changeset", {
    title: "t",
    plan: {
      summary: "s",
      steps: [],
      acceptanceCriteria: [{ id: "a", text: "x", priority: "high" }],
    },
  }, "`should`"],
  ["create_changeset", {
    title: "t",
    plan: {
      summary: "s",
      steps: [],
      acceptanceCriteria: [{ description: "x" }],
    },
  }, "plan.acceptanceCriteria[0].text"],
  ["record_verification_run", {
    changeset_id: "c",
    status: "passed",
    summary: "s",
    evidence: [{ id: "e", status: "passed", description: "ran it" }],
    claimResults: [],
    residualRisks: [],
  }, "evidence[0].summary"],
  ["record_verification_run", {
    changeset_id: "c",
    status: "passed",
    summary: "s",
    evidence: [],
    claimResults: [{ claimId: "a", status: "supported" }],
    residualRisks: [],
  }, "`passed`"],
];

for (const [tool, args, expected] of TRAPS) {
  Deno.test(`checkToolArgs refuses ${tool}(${Object.keys(args)}) → ${expected}`, () => {
    const result = check(tool, args);
    assert(result.issues.length > 0, `expected a refusal for ${tool}`);
    assertStringIncludes(messages(tool, args), expected);
  });
}

Deno.test("checkToolArgs accepts camelCase/snake_case spellings by renaming", () => {
  const result = check("complete_changeset", { changesetId: "c1" });
  assertEquals(result.issues, []);
  assertEquals(result.args, { changeset_id: "c1" });

  const schema = check("define_schema", {
    table_name: "widgets",
    sql: "CREATE TABLE widgets (id int)",
  });
  assertEquals(schema.issues, []);
  assertEquals(schema.args.tableName, "widgets");
});

Deno.test("checkToolArgs honours the aliases dispatch already reads", () => {
  const result = check("set_env", { name: "API_HOST", value: "x" });
  assertEquals(result.issues, []);
  assertEquals(result.args, { key: "API_HOST", value: "x" });
});

Deno.test("checkToolArgs does not rename onto a key that is also present", () => {
  const result = check("complete_changeset", {
    changeset_id: "c1",
    changesetId: "c2",
  });
  assertEquals(result.issues.length, 1);
});

Deno.test("checkToolArgs passes a correct call through untouched", () => {
  const args = {
    title: "t",
    plan: {
      summary: "s",
      steps: ["one"],
      acceptanceCriteria: [
        "a plain string criterion",
        { id: "a", text: "x", priority: "should", extra: "kept" },
      ],
      verificationPlan: [{ claimIds: ["a"], kind: "e2e", description: "d" }],
    },
    change_class: "standard",
  };
  const result = check("create_changeset", args);
  assertEquals(result.issues, []);
  assertEquals(result.args, args);
});

Deno.test("checkToolArgs reports a missing required argument", () => {
  assertStringIncludes(
    messages("query_database", {}),
    "missing required argument `sql`",
  );
});

Deno.test("checkToolArgs lists accepted keys when nothing is close", () => {
  assertStringIncludes(
    messages("complete_changeset", { changeset_id: "c", zzzzzz: 1 }),
    "Accepted: `changeset_id`",
  );
});

Deno.test("checkToolArgs pairs a lone unknown key with the lone missing one", () => {
  const text = messages("register_route", {
    method: "GET",
    path: "/a",
    handlr: "x",
  });
  assertStringIncludes(
    text,
    "unknown argument `handlr` — did you mean `handlerName`?",
  );
  assertStringIncludes(text, "missing required argument `handlerName`");
});

Deno.test("checkToolArgs treats absent arguments as empty, junk as an issue", () => {
  assertEquals(check("run_tests", undefined).issues, []);
  assertEquals(check("run_tests", "pattern").issues.length, 1);
});

Deno.test("formatArgIssues names the tool and every issue", () => {
  const { issues } = check("query_database", { query: "x" });
  const text = formatArgIssues("query_database", issues);
  assertStringIncludes(text, 'Tool "query_database" was not called');
  assertStringIncludes(text, "`sql`");
  assertEquals(text.split("\n- ").length - 1, issues.length);
});

// Every schema must stay inside what checkToolArgs understands — flat object
// schemas with properties/required/enum/items. A combinator would be silently
// ignored, so its arrival should fail here and force a decision.
Deno.test("no tool schema uses a construct checkToolArgs ignores", () => {
  const unsupported = ["oneOf", "anyOf", "allOf", "$ref", "patternProperties"];
  const found: string[] = [];
  const walk = (node: unknown, path: string) => {
    if (!node || typeof node !== "object") return;
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      if (unsupported.includes(k)) found.push(`${path}.${k}`);
      walk(v, `${path}.${k}`);
    }
  };
  for (const tool of AGENT_TOOLS) walk(tool.input_schema, tool.name);
  assertEquals(found, []);
});
