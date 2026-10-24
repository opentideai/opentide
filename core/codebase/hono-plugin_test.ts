import { assert, assertEquals } from "@std/assert";
import {
  createEmptyCodebaseGraph,
  createHonoPlugin,
  GENERIC_TSJS_PLUGIN_ID,
  HONO_FRAMEWORK,
  HONO_PLUGIN_ID,
  mergeCodebaseContributions,
  routeSemanticId,
  type SemanticContribution,
  sourceIndexContribution,
  type SourceLanguage,
  symbolSemanticId,
  type TsJsProjectDiscovery,
  type TsJsSourceFile,
  type TsJsSourceIndex,
  validateCodebaseGraph,
} from "./index.ts";
import type { DetectionContext, IndexContext } from "./plugins.ts";

const ROOT = "/repo";

function sourceFile(
  path: string,
  content: string,
  language: SourceLanguage = "typescript",
): TsJsSourceFile {
  return { path, language, sizeBytes: content.length, content };
}

function sourceIndex(files: TsJsSourceFile[]): TsJsSourceIndex {
  return { rootPath: ROOT, files, ignoredDirs: [] };
}

function honoDiscovery(): TsJsProjectDiscovery {
  return {
    rootPath: ROOT,
    packageManager: "npm",
    lockfiles: [],
    configFiles: [],
    frameworkHints: [{
      id: "hono",
      source: "dependency",
      confidence: 0.95,
      evidence: "hono",
    }],
    sourceRoots: ["src"],
    ignoredDirs: [],
  };
}

function indexContext(index: TsJsSourceIndex): IndexContext {
  return {
    projectId: "p1",
    rootPath: ROOT,
    sourceIndex: index,
    detection: {
      matched: true,
      confidence: 0.95,
      evidence: [],
      suggestedPriority: 100,
    },
  };
}

async function runIndex(
  files: TsJsSourceFile[],
): Promise<SemanticContribution> {
  const plugin = createHonoPlugin();
  return await plugin.index(indexContext(sourceIndex(files)));
}

const APP_FIXTURE = sourceFile(
  "src/server.ts",
  `import { Hono } from "hono";

const app = new Hono();

app.use("/api/*", authMiddleware);

app.get("/", (c) => c.text("home"));
app.get("/api/users", listUsers).post("/api/users", (c) => c.json({}));

const api = new Hono();
api.get("/ping", (c) => c.text("pong"));
app.route("/api", api);

function listUsers(c) { return c.json([]); }
const authMiddleware = (c, next) => next();
`,
);

Deno.test("hono plugin extracts routes with method/path/pathSyntax", async () => {
  const contribution = await runIndex([APP_FIXTURE]);
  const routes = (contribution.routes ?? []).map((r) => [
    r.method,
    r.path,
    r.pathSyntax,
    r.framework,
  ]);

  assertEquals(routes, [
    ["GET", "/", "hono", HONO_FRAMEWORK],
    ["GET", "/api/ping", "hono", HONO_FRAMEWORK],
    ["GET", "/api/users", "hono", HONO_FRAMEWORK],
    ["POST", "/api/users", "hono", HONO_FRAMEWORK],
  ]);
});

Deno.test("hono plugin composes mounted sub-app paths under the base", async () => {
  const contribution = await runIndex([APP_FIXTURE]);
  const ping = (contribution.routes ?? []).find((r) => r.path === "/api/ping");

  assert(ping, "expected mounted /api/ping route");
  assertEquals(ping.mountPath, "/api");
  assertEquals(ping.id, routeSemanticId("GET", "/api/ping"));
});

Deno.test("hono plugin links named handlers to generic CodeSymbols by symbolId", async () => {
  const contribution = await runIndex([APP_FIXTURE]);
  const handlers = contribution.handlers ?? [];
  const named = handlers.find((h) => h.symbolId);

  assert(named, "expected a named handler with symbolId");
  assertEquals(named.symbolId, symbolSemanticId("src/server.ts", "listUsers"));
  assertEquals(named.framework, HONO_FRAMEWORK);
  assertEquals(named.abi.params[0]?.role, "context");
  assertEquals(named.abi.responseStyle, "return-response");

  // Four handlers: one named ref + three distinct inline arrows.
  assertEquals(handlers.length, 4);
  assertEquals(handlers.filter((h) => h.symbolId).length, 1);
});

Deno.test("hono plugin maps app.use to middleware covering matching routes", async () => {
  const contribution = await runIndex([APP_FIXTURE]);
  const middleware = contribution.middleware ?? [];

  assertEquals(middleware.length, 1);
  const auth = middleware[0];
  assert(auth);
  assertEquals(auth.name, "authMiddleware");
  // Covers both /api/users routes on the same app, not "/" nor the sub-app.
  assertEquals(auth.routeIds.toSorted(), [
    routeSemanticId("GET", "/api/users"),
    routeSemanticId("POST", "/api/users"),
  ]);
});

Deno.test("hono plugin emits routes-to / uses-middleware / mounts / defines edges", async () => {
  const contribution = await runIndex([APP_FIXTURE]);
  const edges = contribution.edges ?? [];
  const byType = (type: string) => edges.filter((e) => e.type === type);

  assertEquals(byType("routes-to").length, 4);
  assertEquals(byType("uses-middleware").length, 2);
  assertEquals(byType("mounts").length, 1);
  // One defines edge (app fact -> route) per route.
  assertEquals(byType("defines").length, 4);

  const mount = byType("mounts")[0];
  assert(mount);
  assertEquals(mount.label, "/api");

  // Two Hono app instances become entrypoint facts (used as mount endpoints).
  const appFacts = (contribution.facts ?? []).filter((f) =>
    f.factKind === "entrypoint"
  );
  assertEquals(appFacts.length, 2);
});

Deno.test("hono contribution round-trips through merge + validate with zero issues", async () => {
  const index = sourceIndex([APP_FIXTURE]);
  const generic = sourceIndexContribution(GENERIC_TSJS_PLUGIN_ID, index);
  const hono = await runIndex([APP_FIXTURE]);

  const graph = mergeCodebaseContributions(
    createEmptyCodebaseGraph("p1", ROOT, "2026-07-31T00:00:00.000Z"),
    [generic, hono],
  );

  assertEquals(validateCodebaseGraph(graph), []);
  assertEquals(graph.routes.length, 4);
  assertEquals(graph.handlers.length, 4);
  assertEquals(graph.middleware.length, 1);
});

Deno.test("hono plugin lowers confidence and flags dynamically-built paths", async () => {
  const dynamicFixture = sourceFile(
    "src/dyn.ts",
    `import { Hono } from "hono";
const app = new Hono();
const base = "/things";
app.get(base + "/:id", (c) => c.text("ok"));
`,
  );
  const contribution = await runIndex([dynamicFixture]);
  const route = (contribution.routes ?? [])[0];

  assert(route, "expected a route for the dynamic path");
  assertEquals(route.source.inferred, true);
  assert(route.confidence < 0.9, "dynamic route should be lower confidence");

  const diagnostic = (contribution.diagnostics ?? []).find((d) =>
    d.message.includes("non-literal path")
  );
  assert(diagnostic, "expected a diagnostic for the non-literal path");
  assertEquals(diagnostic.severity, "info");
});

Deno.test("hono plugin flags a cross-file sub-app mount as a follow-up", async () => {
  const crossFile = sourceFile(
    "src/main.ts",
    `import { Hono } from "hono";
import { api } from "./api";
const app = new Hono();
app.route("/api", api);
`,
  );
  const contribution = await runIndex([crossFile]);

  // No mounts edge (child app not resolvable in-file) but a diagnostic instead.
  assertEquals(
    (contribution.edges ?? []).filter((e) => e.type === "mounts"),
    [],
  );
  const diagnostic = (contribution.diagnostics ?? []).find((d) =>
    d.message.includes("cross-file route composition")
  );
  assert(diagnostic, "expected a cross-file mount diagnostic");
});

Deno.test("hono plugin detect matches on a dependency hint", async () => {
  const plugin = createHonoPlugin();
  const ctx: DetectionContext = {
    projectId: "p1",
    rootPath: ROOT,
    discovery: honoDiscovery(),
    sourceIndex: sourceIndex([APP_FIXTURE]),
  };
  const result = await plugin.detect(ctx);
  assertEquals(result.matched, true);
  // Must beat the generic plugin's -1000 so its route nodes win merges.
  assert((result.suggestedPriority ?? 0) > -1000);
});

Deno.test("hono plugin detect returns matched:false for a non-Hono project", async () => {
  const plugin = createHonoPlugin();
  const ctx: DetectionContext = {
    projectId: "p1",
    rootPath: ROOT,
    discovery: {
      ...honoDiscovery(),
      frameworkHints: [],
    },
    sourceIndex: sourceIndex([
      sourceFile("src/plain.ts", `export const answer = 42;`),
    ]),
  };
  const result = await plugin.detect(ctx);
  assertEquals(result.matched, false);
  assertEquals(HONO_PLUGIN_ID, "hono");
});
