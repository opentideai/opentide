import { assert, assertEquals } from "@std/assert";
import {
  checkDependants,
  type EntitySource,
  findUnusedPackages,
  runQC,
} from "./qc.ts";
import { initCompiler } from "./compiler.ts";

Deno.test("QC passes clean handler code", {
  sanitizeResources: false,
  sanitizeOps: false,
}, async () => {
  await initCompiler();
  const result = await runQC(
    `
async function listTodos(c: any) {
  const rows = db.query("SELECT * FROM todos ORDER BY id");
  return c.json({ todos: rows });
}
`,
    "handler",
  );
  assertEquals(result.passed, true);
  assertEquals(result.issues.filter((i) => i.level === "error").length, 0);
});

Deno.test("QC catches eval()", async () => {
  const result = await runQC(
    `
function dangerous(input: string) {
  return eval(input);
}
`,
    "function",
  );
  assertEquals(result.passed, false);
  assert(result.issues.some((i) => i.rule === "no-eval"));
});

Deno.test("QC catches new Function()", async () => {
  const result = await runQC(
    `
function dangerous(code: string) {
  return new Function(code)();
}
`,
    "function",
  );
  assertEquals(result.passed, false);
  assert(result.issues.some((i) => i.rule === "no-new-function"));
});

Deno.test("QC rejects handlers that query internal temp tables", async () => {
  const result = await runQC(
    `
async function serveSailingJs(c: any) {
  const rows = await db.query("SELECT content FROM _temp_build WHERE id = 1");
  return c.body(rows[0].content);
}
`,
    "handler",
  );
  assertEquals(result.passed, false);
  assert(result.issues.some((i) => i.rule === "no-internal-artifacts"));
  assert(result.issues.some((i) => i.rule === "no-internal-tables"));
});

Deno.test("QC rejects generated build artifact paths in app source", async () => {
  const result = await runQC(
    `
function readGeneratedFile(c: any) {
  return c.text("dist/.tmp-check/app.ts");
}
`,
    "handler",
  );
  assertEquals(result.passed, false);
  assert(result.issues.some((i) => i.rule === "no-internal-artifacts"));
});

Deno.test("QC allows comments about internal artifacts", async () => {
  const result = await runQC(
    `
// Replaced the old _temp_build workaround with a registered asset.
async function serveAsset(c: any) {
  return c.redirect("/_assets/app.js");
}
`,
    "handler",
  );
  assertEquals(
    result.issues.filter((i) => i.rule.startsWith("no-internal")).length,
    0,
  );
});

Deno.test("QC warns on unused variables", async () => {
  const result = await runQC(
    `
function example(c: any) {
  const unused = 42;
  return c.json({ ok: true });
}
`,
    "handler",
  );
  assert(
    result.issues.some((i) =>
      i.rule === "no-unused-vars" && i.message.includes("unused")
    ),
  );
});

Deno.test("QC warns on empty catch block", async () => {
  const result = await runQC(
    `
function risky(c: any) {
  try { JSON.parse("bad"); } catch (e) {}
  return c.json({ ok: true });
}
`,
    "handler",
  );
  assert(result.issues.some((i) => i.rule === "no-empty-catch"));
});

Deno.test("QC warns on multi-line and bindingless empty catch", async () => {
  const multiline = await runQC(
    `
function risky(c: any) {
  try {
    JSON.parse("bad");
  } catch (e) {
  }
  return c.json({ ok: true });
}
`,
    "handler",
  );
  assert(multiline.issues.some((i) => i.rule === "no-empty-catch"));

  const bindingless = await runQC(
    `
function risky(c: any) {
  try { JSON.parse("bad"); } catch {}
  return c.json({ ok: true });
}
`,
    "handler",
  );
  assert(bindingless.issues.some((i) => i.rule === "no-empty-catch"));

  // A comment inside the catch is the intentional escape hatch — not flagged.
  const commented = await runQC(
    `
function risky(c: any) {
  try { JSON.parse("bad"); } catch { /* ignore */ }
  return c.json({ ok: true });
}
`,
    "handler",
  );
  assert(!commented.issues.some((i) => i.rule === "no-empty-catch"));
});

Deno.test("QC warns on console.log", async () => {
  const result = await runQC(
    `
function debug(c: any) {
  console.log("test");
  return c.json({ ok: true });
}
`,
    "handler",
  );
  assert(result.issues.some((i) => i.rule === "no-console"));
});

Deno.test("QC warns on async without await", async () => {
  const result = await runQC(
    `
async function noAwait(c: any) {
  return c.json({ ok: true });
}
`,
    "handler",
  );
  assert(result.issues.some((i) => i.rule === "require-await"));
});

Deno.test("QC skips underscore-prefixed unused vars", async () => {
  const result = await runQC(
    `
function example(c: any) {
  const _unused = 42;
  return c.json({ ok: true });
}
`,
    "handler",
  );
  assertEquals(
    result.issues.filter((i) => i.rule === "no-unused-vars").length,
    0,
  );
});

Deno.test("QC checks template for missing doctype", async () => {
  const result = await runQC(
    `<html><head></head><body>Hello</body></html>`,
    "template",
  );
  assert(result.issues.some((i) => i.rule === "missing-doctype"));
});

Deno.test("QC checks template for missing viewport", async () => {
  const result = await runQC(
    `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body>Hello</body></html>`,
    "template",
  );
  assert(result.issues.some((i) => i.rule === "missing-viewport"));
});

Deno.test("QC warns on large inline style in template", async () => {
  const bigCSS = "body { margin: 0; } " + "div { padding: 10px; } ".repeat(20);
  const result = await runQC(
    `<!DOCTYPE html><html><head><style>${bigCSS}</style></head><body></body></html>`,
    "template",
  );
  assert(result.issues.some((i) => i.rule === "no-inline-styles"));
});

Deno.test("QC checks CSS for duplicate selectors", async () => {
  const result = await runQC(
    `
.header { color: red; }
.footer { color: blue; }
.header { font-size: 14px; }
`,
    "css",
  );
  assert(result.issues.some((i) => i.rule === "duplicate-selector"));
});

Deno.test("QC checks CSS for excessive !important", async () => {
  const result = await runQC(
    `
.a { color: red !important; }
.b { margin: 0 !important; }
.c { padding: 0 !important; }
.d { display: flex !important; }
`,
    "css",
  );
  assert(result.issues.some((i) => i.rule === "excessive-important"));
});

Deno.test("QC passes clean template", async () => {
  const result = await runQC(
    `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>App</title>
</head>
<body>Hello</body>
</html>`,
    "template",
  );
  assertEquals(result.issues.filter((i) => i.level === "error").length, 0);
});

// --- Accessibility checks ---

Deno.test("a11y: img without alt", async () => {
  const result = await runQC(`<div><img src="logo.png"></div>`, "template");
  assert(result.issues.some((i) => i.rule === "a11y-img-alt"));
});

Deno.test("a11y: img with alt passes", async () => {
  const result = await runQC(
    `<div><img src="logo.png" alt="Logo"></div>`,
    "template",
  );
  assertEquals(
    result.issues.filter((i) => i.rule === "a11y-img-alt").length,
    0,
  );
});

Deno.test("a11y: input without label", async () => {
  const result = await runQC(`<div><input type="text"></div>`, "template");
  assert(result.issues.some((i) => i.rule === "a11y-input-label"));
});

Deno.test("a11y: input with aria-label passes", async () => {
  const result = await runQC(
    `<div><input type="text" aria-label="Search"></div>`,
    "template",
  );
  assertEquals(
    result.issues.filter((i) => i.rule === "a11y-input-label").length,
    0,
  );
});

Deno.test("a11y: input with matching label passes", async () => {
  const result = await runQC(
    `<label for="name">Name</label><input type="text" id="name">`,
    "template",
  );
  assertEquals(
    result.issues.filter((i) => i.rule === "a11y-input-label").length,
    0,
  );
});

Deno.test("a11y: button without text", async () => {
  const result = await runQC(`<button><svg></svg></button>`, "template");
  assert(result.issues.some((i) => i.rule === "a11y-button-text"));
});

Deno.test("a11y: button with aria-label passes", async () => {
  const result = await runQC(
    `<button aria-label="Close"><svg></svg></button>`,
    "template",
  );
  assertEquals(
    result.issues.filter((i) => i.rule === "a11y-button-text").length,
    0,
  );
});

Deno.test("a11y: anchor without href", async () => {
  const result = await runQC(`<a onclick="doStuff()">Click</a>`, "template");
  assert(result.issues.some((i) => i.rule === "a11y-anchor-href"));
});

Deno.test("a11y: html without lang", async () => {
  const result = await runQC(
    `<!DOCTYPE html><html><head></head><body></body></html>`,
    "template",
  );
  assert(result.issues.some((i) => i.rule === "a11y-html-lang"));
});

Deno.test("a11y: hidden input skipped", async () => {
  const result = await runQC(`<input type="hidden" name="csrf">`, "template");
  assertEquals(
    result.issues.filter((i) => i.rule === "a11y-input-label").length,
    0,
  );
});

// --- Cross-entity dependency checks ---

Deno.test("dep check: warns when referenced function is removed", () => {
  const oldSource =
    `function validateEmail(email: string) { return /@/.test(email); }`;
  const newSource =
    `function checkEmail(email: string) { return /@/.test(email); }`;
  const entities: EntitySource[] = [
    {
      name: "createUser",
      kind: "handler",
      source:
        `async function createUser(c: any) { const ok = validateEmail(email); }`,
    },
    {
      name: "listUsers",
      kind: "handler",
      source: `async function listUsers(c: any) { return c.json([]); }`,
    },
  ];
  const warnings = checkDependants(
    "validateEmail",
    "function",
    oldSource,
    newSource,
    entities,
  );
  assertEquals(warnings.length, 1);
  assertEquals(warnings[0]!.entity, "createUser");
  assert(warnings[0]!.reason.includes("validateEmail"));
});

Deno.test("dep check: warns when function signature changes", () => {
  const oldSource = `function formatDate(date: string) { return date; }`;
  const newSource =
    `function formatDate(date: string, locale: string) { return date; }`;
  const entities: EntitySource[] = [
    {
      name: "showEvent",
      kind: "handler",
      source:
        `async function showEvent(c: any) { const d = formatDate(event.date); }`,
    },
  ];
  const warnings = checkDependants(
    "formatDate",
    "function",
    oldSource,
    newSource,
    entities,
  );
  assertEquals(warnings.length, 1);
  assert(warnings[0]!.reason.includes("signature changed"));
});

Deno.test("dep check: warns on functions.call() reference", () => {
  const oldSource = `function sendEmail(to: string) { return true; }`;
  const newSource =
    `function sendEmail(to: string, subject: string) { return true; }`;
  const entities: EntitySource[] = [
    {
      name: "notify",
      kind: "handler",
      source:
        `async function notify(c: any) { functions.call("sendEmail", addr); }`,
    },
  ];
  const warnings = checkDependants(
    "sendEmail",
    "function",
    oldSource,
    newSource,
    entities,
  );
  assertEquals(warnings.length, 1);
  assert(warnings[0]!.reason.includes("functions.call()"));
});

Deno.test("dep check: no warnings for new entities", () => {
  const newSource = `function brand_new() { return 1; }`;
  const entities: EntitySource[] = [
    {
      name: "other",
      kind: "handler",
      source: `async function other(c: any) { return c.json({}); }`,
    },
  ];
  const warnings = checkDependants(
    "brand_new",
    "function",
    null,
    newSource,
    entities,
  );
  assertEquals(warnings.length, 0);
});

Deno.test("dep check: no warnings when nothing changed", () => {
  const source = `function helper(x: string) { return x.trim(); }`;
  const entities: EntitySource[] = [
    {
      name: "user",
      kind: "handler",
      source: `async function user(c: any) { helper(name); }`,
    },
  ];
  const warnings = checkDependants(
    "helper",
    "function",
    source,
    source,
    entities,
  );
  assertEquals(warnings.length, 0);
});

Deno.test("unused packages: detects dot and bracket package references", () => {
  const entities: EntitySource[] = [
    {
      name: "extractArticleContent",
      kind: "function",
      source: `
const { Readability } = packages["@mozilla/readability"] as { Readability: any };
const { parseHTML } = packages.linkedom as { parseHTML: any };
`,
    },
  ];

  const result = findUnusedPackages([
    "@mozilla/readability",
    "linkedom",
    "marked",
  ], entities);

  assertEquals(result.used.map((p) => p.name), [
    "@mozilla/readability",
    "linkedom",
  ]);
  assertEquals(result.unused.map((p) => p.name), ["marked"]);
  assertEquals(result.used[0]!.usedBy, ["function:extractArticleContent"]);
});

Deno.test("unused packages: detects single and template quoted bracket references", () => {
  const entities: EntitySource[] = [
    {
      name: "renderMarkdown",
      kind: "function",
      source: `
const marked = packages['marked'];
const ajv = packages[\`ajv\`];
`,
    },
  ];

  const result = findUnusedPackages(["marked", "ajv"], entities);

  assertEquals(result.used.map((p) => p.name), ["marked", "ajv"]);
  assertEquals(result.unused.length, 0);
});
