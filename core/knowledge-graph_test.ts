import { assertEquals } from "@std/assert";
import { Database } from "./db.ts";
import { Kernel } from "./registries.ts";
import { buildKnowledgeGraph } from "./knowledge-graph.ts";

const testOpts = { sanitizeResources: false, sanitizeOps: false };

async function withKernel<T>(
  fn: (kernel: Kernel) => T | Promise<T>,
): Promise<T> {
  const db = await Database.create({ driver: "pglite" });
  const kernel = new Kernel(db);
  try {
    return await fn(kernel);
  } finally {
    await db.close();
  }
}

// Build the canonical fixture: route GET /x → handler h → fnA → fnB, with fnA reading
// config "flag" and h rendering template "tpl".
//   route ─routes→ h ─calls→ fnA ─calls→ fnB
//                   │            └reads→ config:flag
//                   └renders→ template:tpl
function registerFixture(kernel: Kernel): void {
  kernel.functions.register("fnB", "function fnB(){ return 1; }", () => 1);
  kernel.functions.register(
    "fnA",
    'function fnA(){ return functions.call("fnB") + config.get("flag"); }',
    () => 1,
  );
  kernel.handlers.register(
    "h",
    'async function h(c){ templates.get("tpl"); return functions.call("fnA"); }',
    () => Promise.resolve(new Response()),
    undefined,
    "m",
  );
  kernel.routes.register("GET", "/x", "h", undefined, "m");
}

Deno.test({
  ...testOpts,
  name: "B1a: degrees — a leaf's inbound edge, a hub's outbound edges",
  fn: async () => {
    await withKernel((kernel) => {
      registerFixture(kernel);
      const g = buildKnowledgeGraph(kernel);

      // fnB is a leaf: one thing calls it (fnA), it calls nothing.
      assertEquals(g.metricsFor("function", "fnB")!.inDegree, 1);
      assertEquals(g.metricsFor("function", "fnB")!.outDegree, 0);

      // fnA references two distinct entities (fnB + config flag) and is called by h.
      assertEquals(g.metricsFor("function", "fnA")!.inDegree, 1);
      assertEquals(g.metricsFor("function", "fnA")!.outDegree, 2);
    });
  },
});

Deno.test({
  ...testOpts,
  name: "B1a: dependentCount is the transitive blast radius",
  fn: async () => {
    await withKernel((kernel) => {
      registerFixture(kernel);
      const g = buildKnowledgeGraph(kernel);

      // Everything upstream of fnB: fnA, handler h, route GET /x → 3.
      assertEquals(g.metricsFor("function", "fnB")!.dependentCount, 3);
      const blast = g.blastRadius("function", "fnB");
      assertEquals(
        blast.map((r) => `${r.category}:${r.name}`).sort(),
        ["function:fnA", "handler:h", "route:GET /x"],
      );
      // Direct dependents are only fnA.
      assertEquals(g.dependentsOf("function", "fnB").map((r) => r.name), [
        "fnA",
      ]);

      // A referenced-but-unregistered target (config flag) still has a blast radius.
      assertEquals(g.metricsFor("config", "flag")!.dependentCount, 3);
    });
  },
});

Deno.test({
  ...testOpts,
  name:
    "B1a: metricsForUid agrees with metricsFor, and uid keying honors A2 scope",
  fn: async () => {
    await withKernel((kernel) => {
      registerFixture(kernel);
      const g = buildKnowledgeGraph(kernel);

      const uid = kernel.functions.getEntry("fnB")!.entityUid;
      assertEquals(g.metricsForUid(uid), g.metricsFor("function", "fnB"));

      // The blast-radius refs carry the uid for uid-bearing nodes...
      const fnARef = g.blastRadius("function", "fnB").find((r) =>
        r.name === "fnA"
      )!;
      assertEquals(
        fnARef.entityUid,
        kernel.functions.getEntry("fnA")!.entityUid,
      );
      // ...and null for routes (no entityUid per A2).
      const routeRef = g.blastRadius("function", "fnB").find((r) =>
        r.category === "route"
      )!;
      assertEquals(routeRef.entityUid, null);
      // An unknown uid resolves to null, never a fabricated metric.
      assertEquals(g.metricsForUid("ent_does_not_exist"), null);
    });
  },
});

Deno.test({
  ...testOpts,
  name: "B1a: unknown entity → null; empty kernel → empty graph",
  fn: async () => {
    await withKernel((kernel) => {
      const empty = buildKnowledgeGraph(kernel);
      assertEquals(empty.nodeCount, 0);
      assertEquals(empty.metricsFor("function", "nope"), null);
      assertEquals(empty.blastRadius("function", "nope"), []);

      registerFixture(kernel);
      const g = buildKnowledgeGraph(kernel);
      assertEquals(g.metricsFor("function", "ghost"), null);
      assertEquals(g.dependentsOf("handler", "ghost"), []);
    });
  },
});

Deno.test({
  ...testOpts,
  name: "B1a: a dependency cycle terminates and excludes self",
  fn: async () => {
    await withKernel((kernel) => {
      // fnP ⇄ fnQ call each other; a route reaches fnP via handler.
      kernel.functions.register(
        "fnP",
        'function fnP(){ return functions.call("fnQ"); }',
        () => 1,
      );
      kernel.functions.register(
        "fnQ",
        'function fnQ(){ return functions.call("fnP"); }',
        () => 1,
      );
      kernel.handlers.register(
        "hc",
        'async function hc(c){ return functions.call("fnP"); }',
        () => Promise.resolve(new Response()),
        undefined,
        "m",
      );
      kernel.routes.register("GET", "/c", "hc", undefined, "m");

      const g = buildKnowledgeGraph(kernel);
      const blast = g.blastRadius("function", "fnP").map((r) =>
        `${r.category}:${r.name}`
      ).sort();
      // fnQ (cycle peer), the handler, and the route depend on fnP; fnP is not its own dependent.
      assertEquals(blast, ["function:fnQ", "handler:hc", "route:GET /c"]);
    });
  },
});
