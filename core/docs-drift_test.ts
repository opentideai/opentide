import { assert, assertEquals } from "@std/assert";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  diffDocsAgainstKernel,
  docsDriftIssues,
  driftIsClean,
  parseDocumentedEntities,
  readDocsDrift,
} from "./docs-drift.ts";
import { Database } from "./db.ts";
import { Kernel } from "./registries.ts";

// A doc in the exact shape generateAgentMd (core/export.ts) emits.
const DOC = `# Speed Read

## Modules

- \`reader\`

## Routes

- \`GET /read/:id\` → \`serveReader\` (reader)
- \`GET /doc/:id\` → \`redirectLegacyDocLink\` (reader)

## Handlers

- \`serveReader\` (reader) — Serve the reader page for a saved article.
- \`redirectLegacyDocLink\` (reader) — Redirect the old /doc/:id editor URL.

## Functions

- \`loadDocumentBundle\` (reader) — Load an article with everything the reader renders.

## Runtime Notes

- Not a bullet section: \`notAnEntity\` should be ignored.
`;

Deno.test("parseDocumentedEntities reads only the three entity sections", () => {
  const found = parseDocumentedEntities(DOC);
  assertEquals([...found.routes].sort(), ["GET /doc/:id", "GET /read/:id"]);
  assertEquals([...found.handlers].sort(), [
    "redirectLegacyDocLink",
    "serveReader",
  ]);
  assertEquals([...found.functions], ["loadDocumentBundle"]);
  // A backtick-quoted token under an unrelated heading is not an entity.
  assert(!found.handlers.has("notAnEntity"));
  assert(!found.functions.has("notAnEntity"));
  // The module bullet sits under ## Modules, which closes the previous section.
  assert(!found.routes.has("reader"));
});

Deno.test("parseDocumentedEntities takes only the first quoted token per bullet", () => {
  // The handler name is the first token; the purpose may itself contain backticks.
  const found = parseDocumentedEntities(
    "## Handlers\n\n- `serveReader` (reader) — Serves `/read/:id` for an article.\n",
  );
  assertEquals([...found.handlers], ["serveReader"]);
});

async function kernelWith(
  handlers: string[],
  functions: string[],
): Promise<{ kernel: Kernel; close: () => Promise<void> }> {
  const db = await Database.create({ driver: "pglite" });
  const kernel = new Kernel(db);
  for (const name of handlers) {
    kernel.handlers.register(
      name,
      `async function ${name}(c) { return c.json({}); }`,
      () => new Response("{}"),
      undefined,
      "reader",
    );
  }
  for (const name of functions) {
    kernel.functions.register(
      name,
      `function ${name}() { return null; }`,
      () => null,
      "reader",
    );
  }
  return { kernel, close: () => db.close() };
}

Deno.test("diffDocsAgainstKernel: a doc matching the registry has no drift", async () => {
  const { kernel, close } = await kernelWith(
    ["serveReader", "redirectLegacyDocLink"],
    ["loadDocumentBundle"],
  );
  try {
    kernel.routes.register(
      "GET",
      "/read/:id",
      "serveReader",
      undefined,
      "reader",
    );
    kernel.routes.register(
      "GET",
      "/doc/:id",
      "redirectLegacyDocLink",
      undefined,
      "reader",
    );
    const drift = diffDocsAgainstKernel(parseDocumentedEntities(DOC), kernel);
    assert(driftIsClean(drift), JSON.stringify(drift));
    assertEquals(docsDriftIssues(drift), []);
  } finally {
    await close();
  }
});

Deno.test("diffDocsAgainstKernel: entities removed from the registry are reported stale", async () => {
  // The studio sweep's shape: the doc still names handlers and a function that are gone.
  const { kernel, close } = await kernelWith(["serveReader"], []);
  try {
    kernel.routes.register(
      "GET",
      "/read/:id",
      "serveReader",
      undefined,
      "reader",
    );
    const drift = diffDocsAgainstKernel(parseDocumentedEntities(DOC), kernel);
    assertEquals(drift.staleRoutes, ["GET /doc/:id"]);
    assertEquals(drift.staleHandlers, ["redirectLegacyDocLink"]);
    assertEquals(drift.staleFunctions, ["loadDocumentBundle"]);
    assertEquals(drift.missingRoutes, []);
    assertEquals(drift.missingHandlers, []);

    const issues = docsDriftIssues(drift);
    const stale = issues.find((i) => i.code === "DOCS_STALE_ENTITIES");
    assert(stale, "expected a DOCS_STALE_ENTITIES warning");
    assertEquals(stale.severity, "warning", "drift never blocks completion");
    assert(stale.message.includes("redirectLegacyDocLink"), stale.message);
    assert(stale.action.includes("generate_project_docs"), stale.action);
  } finally {
    await close();
  }
});

Deno.test("diffDocsAgainstKernel: registered entities absent from the doc are reported missing", async () => {
  const { kernel, close } = await kernelWith(
    ["serveReader", "redirectLegacyDocLink", "listBookmarks"],
    ["loadDocumentBundle"],
  );
  try {
    kernel.routes.register(
      "GET",
      "/read/:id",
      "serveReader",
      undefined,
      "reader",
    );
    kernel.routes.register(
      "GET",
      "/doc/:id",
      "redirectLegacyDocLink",
      undefined,
      "reader",
    );
    kernel.routes.register(
      "GET",
      "/api/bookmarks",
      "listBookmarks",
      undefined,
      "reader",
    );
    const drift = diffDocsAgainstKernel(parseDocumentedEntities(DOC), kernel);
    assertEquals(drift.missingRoutes, ["GET /api/bookmarks"]);
    assertEquals(drift.missingHandlers, ["listBookmarks"]);
    assertEquals(drift.staleHandlers, []);

    const issues = docsDriftIssues(drift);
    const missing = issues.find((i) => i.code === "DOCS_MISSING_ENTITIES");
    assert(missing, "expected a DOCS_MISSING_ENTITIES warning");
    assertEquals(missing.severity, "warning");
    assert(missing.message.includes("listBookmarks"), missing.message);
  } finally {
    await close();
  }
});

Deno.test("readDocsDrift: a project with no AGENT.md reports nothing", async () => {
  const dir = mkdtempSync(join(tmpdir(), "docs-drift-"));
  const { kernel, close } = await kernelWith(["serveReader"], []);
  try {
    kernel.projectDir = dir;
    assert(
      driftIsClean(readDocsDrift(kernel)),
      "absence of a doc is not a defect",
    );
  } finally {
    await close();
    rmSync(dir, { recursive: true, force: true });
  }
});

Deno.test("readDocsDrift: reads AGENT.md from the project directory", async () => {
  const dir = mkdtempSync(join(tmpdir(), "docs-drift-"));
  const { kernel, close } = await kernelWith(["serveReader"], []);
  try {
    writeFileSync(join(dir, "AGENT.md"), DOC, "utf8");
    kernel.projectDir = dir;
    const drift = readDocsDrift(kernel);
    assert(drift.staleHandlers.includes("redirectLegacyDocLink"));
    assert(drift.staleFunctions.includes("loadDocumentBundle"));
  } finally {
    await close();
    rmSync(dir, { recursive: true, force: true });
  }
});

Deno.test("docsDriftIssues: many stale entities are summarised, not listed in full", () => {
  const drift = {
    staleRoutes: [],
    staleHandlers: ["a", "b", "c", "d", "e"],
    staleFunctions: [],
    missingRoutes: [],
    missingHandlers: [],
    missingFunctions: [],
  };
  const [issue] = docsDriftIssues(drift);
  assert(issue);
  assert(issue.message.includes("+2 more"), issue.message);
  assert(issue.message.includes("5 entities"), issue.message);
});
