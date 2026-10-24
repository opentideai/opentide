import { assert, assertEquals } from "@std/assert";
import { Database } from "./db.ts";
import { Kernel } from "./registries.ts";
import { computeCoverage } from "./coverage.ts";

const testOpts = { sanitizeResources: false, sanitizeOps: false };

async function withKernel<T>(fn: (kernel: Kernel) => Promise<T>): Promise<T> {
  const db = await Database.create({ driver: "pglite" });
  const kernel = new Kernel(db);
  try {
    return await fn(kernel);
  } finally {
    await db.close();
  }
}

Deno.test({
  ...testOpts,
  name: "coverage: empty kernel returns 100%",
  fn: async () => {
    await withKernel(async (kernel) => {
      const report = await computeCoverage(kernel);
      assertEquals(report.summary.overall.percent, 100);
      assertEquals(report.summary.overall.total, 0);
      assertEquals(report.untested.length, 0);
    });
  },
});

Deno.test({
  ...testOpts,
  name: "coverage: untested handler shows 0%",
  fn: async () => {
    await withKernel(async (kernel) => {
      kernel.handlers.register(
        "getUsers",
        "async function getUsers(c) { return c.json([]); }",
        () => Promise.resolve(new Response()),
        undefined,
        "users",
      );
      const report = await computeCoverage(kernel);
      assertEquals(report.summary.handlers.total, 1);
      assertEquals(report.summary.handlers.covered, 0);
      assertEquals(report.untested, ["handler:getUsers"]);
    });
  },
});

Deno.test({
  ...testOpts,
  name: "coverage: test referencing handler name counts as covered",
  fn: async () => {
    await withKernel(async (kernel) => {
      kernel.handlers.register(
        "getUsers",
        "async function getUsers(c) { return c.json([]); }",
        () => Promise.resolve(new Response()),
        undefined,
        "users",
      );
      kernel.tests.register(
        "test_getUsers",
        'async function test_getUsers() { const res = await fetch("http://localhost:3001/users"); }',
        async () => {},
        "users",
      );
      const report = await computeCoverage(kernel);
      assertEquals(report.summary.handlers.covered, 1);
      assertEquals(report.untested.length, 0);
    });
  },
});

Deno.test({
  ...testOpts,
  name: "coverage: functions.call reference counts as covered",
  fn: async () => {
    await withKernel(async (kernel) => {
      kernel.functions.register(
        "calculateTotal",
        "function calculateTotal(items) { return 0; }",
        () => 0,
      );
      kernel.tests.register(
        "test_calc",
        'async function test_calc() { const r = functions.call("calculateTotal", [{price: 10}]); }',
        async () => {},
        "orders",
      );
      const report = await computeCoverage(kernel);
      assertEquals(report.summary.functions.covered, 1);
      assertEquals(report.summary.functions.total, 1);
    });
  },
});

Deno.test({
  ...testOpts,
  name: "coverage: route covered via fetch path match",
  fn: async () => {
    await withKernel(async (kernel) => {
      kernel.handlers.register(
        "listTodos",
        "async function listTodos(c) { return c.json([]); }",
        () => Promise.resolve(new Response()),
        undefined,
        "todos",
      );
      kernel.routes.register(
        "GET",
        "/api/todos",
        "listTodos",
        undefined,
        "todos",
      );
      kernel.tests.register(
        "test_list",
        'async function test_list() { const res = await fetch("http://localhost:3001/api/todos"); }',
        async () => {},
        "todos",
      );
      const report = await computeCoverage(kernel);
      assertEquals(report.routes[0]?.tested, true);
    });
  },
});

Deno.test({
  ...testOpts,
  name: "coverage: fetch with query string still matches the route",
  fn: async () => {
    await withKernel(async (kernel) => {
      kernel.handlers.register(
        "listTodos",
        "async function listTodos(c) { return c.json([]); }",
        () => Promise.resolve(new Response()),
        undefined,
        "todos",
      );
      kernel.routes.register(
        "GET",
        "/api/todos",
        "listTodos",
        undefined,
        "todos",
      );
      kernel.tests.register(
        "test_list",
        'async function test_list() { const res = await fetch("http://localhost:3001/api/todos?limit=5"); }',
        async () => {},
        "todos",
      );
      const report = await computeCoverage(kernel);
      assertEquals(report.routes[0]?.tested, true);
    });
  },
});

Deno.test({
  ...testOpts,
  name: "coverage: module filter limits scope",
  fn: async () => {
    await withKernel(async (kernel) => {
      kernel.handlers.register(
        "getUsers",
        "async function getUsers(c) {}",
        () => Promise.resolve(new Response()),
        undefined,
        "users",
      );
      kernel.handlers.register(
        "getTodos",
        "async function getTodos(c) {}",
        () => Promise.resolve(new Response()),
        undefined,
        "todos",
      );
      kernel.tests.register(
        "test_getTodos",
        "async function test_getTodos() { getTodos(); }",
        async () => {},
        "todos",
      );

      const full = await computeCoverage(kernel);
      assertEquals(full.summary.handlers.total, 2);

      const todosOnly = await computeCoverage(kernel, "todos");
      assertEquals(todosOnly.summary.handlers.total, 1);
      assertEquals(todosOnly.summary.handlers.covered, 1);
    });
  },
});

Deno.test({
  ...testOpts,
  name: "coverage: parameterized route matches dynamic path",
  fn: async () => {
    await withKernel(async (kernel) => {
      kernel.handlers.register(
        "getTodo",
        "async function getTodo(c) {}",
        () => Promise.resolve(new Response()),
        undefined,
        "todos",
      );
      kernel.routes.register(
        "GET",
        "/api/todos/:id",
        "getTodo",
        undefined,
        "todos",
      );
      kernel.tests.register(
        "test_get_one",
        'async function test_get_one() { await fetch("http://localhost:3001/api/todos/123"); }',
        async () => {},
        "todos",
      );
      const report = await computeCoverage(kernel);
      assertEquals(report.routes[0]?.tested, true);
    });
  },
});

Deno.test({
  ...testOpts,
  name: "coverage: functions.get reference counts as covered",
  fn: async () => {
    await withKernel(async (kernel) => {
      kernel.functions.register(
        "formatDate",
        "function formatDate(d) { return d; }",
        (d: unknown) => d,
      );
      kernel.tests.register(
        "test_fmt",
        'async function test_fmt() { const fn = functions.get("formatDate"); }',
        async () => {},
        "utils",
      );
      const report = await computeCoverage(kernel);
      assertEquals(report.summary.functions.covered, 1);
    });
  },
});

// --- Route-to-handler backlink ---

Deno.test({
  ...testOpts,
  name: "coverage: fetch to route marks handler as covered (backlink)",
  fn: async () => {
    await withKernel(async (kernel) => {
      kernel.handlers.register(
        "listItems",
        "async function listItems(c) { return c.json([]); }",
        () => Promise.resolve(new Response()),
        undefined,
        "items",
      );
      kernel.routes.register(
        "GET",
        "/api/items",
        "listItems",
        undefined,
        "items",
      );
      // test only fetches the route — no direct handler name mention
      kernel.tests.register(
        "test_api",
        'async function test_api() { await fetch("http://localhost:3001/api/items"); }',
        async () => {},
        "items",
      );
      const report = await computeCoverage(kernel);
      assertEquals(report.handlers[0]?.tested, true);
      assertEquals(report.handlers[0]?.tests, ["test_api"]);
      assertEquals(report.routes[0]?.tested, true);
    });
  },
});

// --- Template coverage ---

Deno.test({
  ...testOpts,
  name: "coverage: templates.get reference marks template covered",
  fn: async () => {
    await withKernel(async (kernel) => {
      kernel.templates.register("layout", "<html>{{content}}</html>", "layout");
      kernel.tests.register(
        "test_layout",
        'async function test_layout() { const t = templates.get("layout"); }',
        async () => {},
        "layout",
      );
      const report = await computeCoverage(kernel);
      assertEquals(report.summary.templates.total, 1);
      assertEquals(report.summary.templates.covered, 1);
      assertEquals(report.templates[0]?.tested, true);
    });
  },
});

Deno.test({
  ...testOpts,
  name: "coverage: untested template shows in untested list",
  fn: async () => {
    await withKernel(async (kernel) => {
      kernel.templates.register("footer", "<footer></footer>", "footer");
      const report = await computeCoverage(kernel);
      assertEquals(report.untested.includes("template:footer"), true);
    });
  },
});

// --- Schema coverage ---

Deno.test({
  ...testOpts,
  name: "coverage: SQL table reference marks schema covered",
  fn: async () => {
    await withKernel(async (kernel) => {
      await kernel.db.defineSchema(
        "products",
        "CREATE TABLE products (id SERIAL PRIMARY KEY, name TEXT NOT NULL)",
      );
      kernel.tests.register(
        "test_products",
        'async function test_products() { const rows = await db.query("SELECT * FROM products"); }',
        async () => {},
        "shop",
      );
      const report = await computeCoverage(kernel);
      assertEquals(report.summary.schemas.total, 1);
      assertEquals(report.summary.schemas.covered, 1);
      assertEquals(report.schemas[0]?.tested, true);
    });
  },
});

Deno.test({
  ...testOpts,
  name: "coverage: untested schema shows in untested list",
  fn: async () => {
    await withKernel(async (kernel) => {
      await kernel.db.defineSchema(
        "orders",
        "CREATE TABLE orders (id SERIAL PRIMARY KEY, total INTEGER)",
      );
      const report = await computeCoverage(kernel);
      assertEquals(report.untested.includes("schema:orders"), true);
    });
  },
});

// --- Test status enrichment ---

Deno.test({
  ...testOpts,
  name: "coverage: status is 'untested' when no tests",
  fn: async () => {
    await withKernel(async (kernel) => {
      kernel.handlers.register(
        "orphan",
        "async function orphan(c) {}",
        () => Promise.resolve(new Response()),
      );
      const report = await computeCoverage(kernel);
      assertEquals(report.handlers[0]?.status, "untested");
    });
  },
});

Deno.test({
  ...testOpts,
  name: "coverage: status is 'never_run' when tests exist but never executed",
  fn: async () => {
    await withKernel(async (kernel) => {
      kernel.handlers.register(
        "getItems",
        "async function getItems(c) {}",
        () => Promise.resolve(new Response()),
        undefined,
        "items",
      );
      kernel.tests.register(
        "test_getItems",
        "async function test_getItems() { getItems(); }",
        async () => {},
        "items",
      );
      const report = await computeCoverage(kernel);
      assertEquals(report.handlers[0]?.status, "never_run");
    });
  },
});

Deno.test({
  ...testOpts,
  name: "coverage: status is 'passing' when all covering tests pass",
  fn: async () => {
    await withKernel(async (kernel) => {
      kernel.handlers.register(
        "getItems",
        "async function getItems(c) {}",
        () => Promise.resolve(new Response()),
        undefined,
        "items",
      );
      kernel.tests.register(
        "test_getItems",
        "async function test_getItems() { getItems(); }",
        async () => {},
        "items",
      );
      kernel.tests.updateResult("test_getItems", {
        passed: true,
        durationMs: 5,
        ranAt: new Date().toISOString(),
      });
      const report = await computeCoverage(kernel);
      assertEquals(report.handlers[0]?.status, "passing");
      assertEquals(report.summary.handlers.passing, 1);
      assertEquals(report.summary.handlers.failing, 0);
    });
  },
});

Deno.test({
  ...testOpts,
  name: "coverage: status is 'failing' when any covering test fails",
  fn: async () => {
    await withKernel(async (kernel) => {
      kernel.handlers.register(
        "getItems",
        "async function getItems(c) {}",
        () => Promise.resolve(new Response()),
        undefined,
        "items",
      );
      kernel.tests.register(
        "test_getItems",
        "async function test_getItems() { getItems(); }",
        async () => {},
        "items",
      );
      kernel.tests.register(
        "test_getItems2",
        "async function test_getItems2() { getItems(); }",
        async () => {},
        "items",
      );
      kernel.tests.updateResult("test_getItems", {
        passed: true,
        durationMs: 5,
        ranAt: new Date().toISOString(),
      });
      kernel.tests.updateResult("test_getItems2", {
        passed: false,
        error: "boom",
        durationMs: 3,
        ranAt: new Date().toISOString(),
      });
      const report = await computeCoverage(kernel);
      assertEquals(report.handlers[0]?.status, "failing");
      assertEquals(report.summary.handlers.failing, 1);
    });
  },
});

// --- Transitive coverage ---

Deno.test({
  ...testOpts,
  name: "transitive: handler calling function gives function coverage",
  fn: async () => {
    await withKernel(async (kernel) => {
      kernel.functions.register(
        "formatItem",
        "function formatItem(item) { return item.name; }",
        (x: unknown) => x,
      );
      kernel.handlers.register(
        "listItems",
        'async function listItems(c) { const fmt = functions.call("formatItem", {}); return c.json(fmt); }',
        () => Promise.resolve(new Response()),
        undefined,
        "items",
      );
      kernel.routes.register(
        "GET",
        "/api/items",
        "listItems",
        undefined,
        "items",
      );
      // test only fetches the route — never mentions formatItem
      kernel.tests.register(
        "test_items",
        'async function test_items() { await fetch("http://localhost:3001/api/items"); }',
        async () => {},
        "items",
      );
      const report = await computeCoverage(kernel);
      assertEquals(
        report.functions.find((f) => f.name === "formatItem")?.tested,
        true,
      );
    });
  },
});

Deno.test({
  ...testOpts,
  name: "transitive: handler querying table gives schema coverage",
  fn: async () => {
    await withKernel(async (kernel) => {
      await kernel.db.defineSchema(
        "products",
        "CREATE TABLE products (id SERIAL PRIMARY KEY, name TEXT NOT NULL)",
      );
      kernel.handlers.register(
        "listProducts",
        'async function listProducts(c) { const rows = await db.query("SELECT * FROM products"); return c.json(rows); }',
        () => Promise.resolve(new Response()),
        undefined,
        "shop",
      );
      kernel.routes.register(
        "GET",
        "/api/products",
        "listProducts",
        undefined,
        "shop",
      );
      kernel.tests.register(
        "test_products",
        'async function test_products() { await fetch("http://localhost:3001/api/products"); }',
        async () => {},
        "shop",
      );
      const report = await computeCoverage(kernel);
      assertEquals(
        report.schemas.find((s) => s.name === "products")?.tested,
        true,
      );
    });
  },
});

Deno.test({
  ...testOpts,
  name: "transitive: handler rendering template gives template coverage",
  fn: async () => {
    await withKernel(async (kernel) => {
      kernel.templates.register("page", "<html>{{body}}</html>", "web");
      kernel.handlers.register(
        "renderPage",
        'async function renderPage(c) { const html = templates.get("page"); return c.html(html); }',
        () => Promise.resolve(new Response()),
        undefined,
        "web",
      );
      kernel.routes.register("GET", "/page", "renderPage", undefined, "web");
      kernel.tests.register(
        "test_page",
        'async function test_page() { await fetch("http://localhost:3001/page"); }',
        async () => {},
        "web",
      );
      const report = await computeCoverage(kernel);
      assertEquals(
        report.templates.find((t) => t.name === "page")?.tested,
        true,
      );
    });
  },
});

Deno.test({
  ...testOpts,
  name: "transitive: multi-hop function chain gives deep coverage",
  fn: async () => {
    await withKernel(async (kernel) => {
      // Chain: handler -> fnA -> fnB -> fnC
      kernel.functions.register(
        "fnC",
        "function fnC() { return 42; }",
        () => 42,
      );
      kernel.functions.register(
        "fnB",
        'function fnB() { return functions.call("fnC"); }',
        () => 42,
      );
      kernel.functions.register(
        "fnA",
        'function fnA() { return functions.call("fnB"); }',
        () => 42,
      );
      kernel.handlers.register(
        "deepHandler",
        'async function deepHandler(c) { return c.json(functions.call("fnA")); }',
        () => Promise.resolve(new Response()),
        undefined,
        "deep",
      );
      kernel.routes.register(
        "GET",
        "/api/deep",
        "deepHandler",
        undefined,
        "deep",
      );
      kernel.tests.register(
        "test_deep",
        'async function test_deep() { await fetch("http://localhost:3001/api/deep"); }',
        async () => {},
        "deep",
      );
      const report = await computeCoverage(kernel);
      assertEquals(
        report.functions.find((f) => f.name === "fnA")?.tested,
        true,
      );
      assertEquals(
        report.functions.find((f) => f.name === "fnB")?.tested,
        true,
      );
      assertEquals(
        report.functions.find((f) => f.name === "fnC")?.tested,
        true,
      );
    });
  },
});

Deno.test({
  ...testOpts,
  name: "transitive: function calling function gives indirect coverage",
  fn: async () => {
    await withKernel(async (kernel) => {
      kernel.functions.register(
        "helper",
        "function helper() { return 1; }",
        () => 1,
      );
      kernel.functions.register(
        "caller",
        'function caller() { return functions.call("helper"); }',
        () => 1,
      );
      // test calls caller directly — helper should get transitive coverage
      kernel.tests.register(
        "test_caller",
        'async function test_caller() { const r = functions.call("caller"); }',
        async () => {},
        "utils",
      );
      const report = await computeCoverage(kernel);
      assertEquals(
        report.functions.find((f) => f.name === "helper")?.tested,
        true,
      );
      assertEquals(
        report.functions.find((f) => f.name === "caller")?.tested,
        true,
      );
    });
  },
});

// --- Formatted text output ---

Deno.test({
  ...testOpts,
  name: "text: includes overall percentage",
  fn: async () => {
    await withKernel(async (kernel) => {
      kernel.handlers.register(
        "h1",
        "async function h1(c) {}",
        () => Promise.resolve(new Response()),
      );
      kernel.handlers.register(
        "h2",
        "async function h2(c) {}",
        () => Promise.resolve(new Response()),
      );
      kernel.tests.register(
        "test_h1",
        "async function test_h1() { h1(); }",
        async () => {},
      );
      const report = await computeCoverage(kernel);
      assert(report.text.includes("Coverage: 1/2"));
      assert(report.text.includes("50%"));
    });
  },
});

Deno.test({
  ...testOpts,
  name: "text: lists untested entities",
  fn: async () => {
    await withKernel(async (kernel) => {
      kernel.functions.register("orphanFn", "function orphanFn() {}", () => {});
      const report = await computeCoverage(kernel);
      assert(report.text.includes("Untested (1):"));
      assert(report.text.includes("function:orphanFn"));
    });
  },
});

Deno.test({
  ...testOpts,
  name: "text: shows failing count when tests fail",
  fn: async () => {
    await withKernel(async (kernel) => {
      kernel.handlers.register(
        "h1",
        "async function h1(c) {}",
        () => Promise.resolve(new Response()),
      );
      kernel.tests.register(
        "test_h1",
        "async function test_h1() { h1(); }",
        async () => {},
      );
      kernel.tests.updateResult("test_h1", {
        passed: false,
        error: "nope",
        durationMs: 1,
        ranAt: new Date().toISOString(),
      });
      const report = await computeCoverage(kernel);
      assert(report.text.includes("1 failing"));
    });
  },
});

Deno.test({
  ...testOpts,
  name: "text: empty kernel shows 100%",
  fn: async () => {
    await withKernel(async (kernel) => {
      const report = await computeCoverage(kernel);
      assert(report.text.includes("Coverage: 0/0"));
      assert(report.text.includes("100%"));
    });
  },
});
