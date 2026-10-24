import { assertEquals } from "@std/assert";
import { Database } from "./db.ts";
import { kernelInspectAPI } from "./dev-views.ts";
import { Kernel } from "./registries.ts";
import {
  createDefaultRuntimeRegistry,
  DEFAULT_RUNTIME_ID,
  runtimeMetadata,
  sharedGatewayContract,
} from "./runtime.ts";

Deno.test("default runtime registry resolves TypeScript runtime", () => {
  const registry = createDefaultRuntimeRegistry();
  const runtime = registry.resolve(undefined);

  assertEquals(runtime.id, DEFAULT_RUNTIME_ID);
  assertEquals(runtime.defaultLanguage, "typescript");
  assertEquals(runtime.supportedLanguages, ["typescript", "javascript"]);
  assertEquals(runtime.capabilities.executionMode, "in-process");
  assertEquals(runtime.capabilities.handlers, true);
  assertEquals(runtime.capabilities.languageIntelligence, true);
  assertEquals(sharedGatewayContract(runtime), {
    executionMode: "in-process",
    request: "web-request",
    response: "web-response",
  });
});

Deno.test("runtime registry falls back to TypeScript for unknown ids", () => {
  const registry = createDefaultRuntimeRegistry();
  const runtime = registry.resolve("python");

  assertEquals(runtime.id, DEFAULT_RUNTIME_ID);
});

Deno.test("kernel defaults to TypeScript runtime metadata", async () => {
  const db = await Database.create({ driver: "pglite" });
  try {
    const kernel = new Kernel(db);
    const metadata = runtimeMetadata(kernel.runtime);

    assertEquals(kernel.runtimeId, DEFAULT_RUNTIME_ID);
    assertEquals(metadata.id, DEFAULT_RUNTIME_ID);
    assertEquals(metadata.label, "TypeScript / JavaScript");
  } finally {
    await db.close();
  }
});

Deno.test("runScript reports TIMEOUT and a late script rejection is not unhandled", async () => {
  const db = await Database.create({ driver: "pglite" });
  try {
    const kernel = new Kernel(db);
    const deps = await kernel.compileDeps();
    // The script rejects ~40ms in, but the timeout fires at 10ms. The race
    // returns TIMEOUT; the script's later rejection must not surface as an
    // unhandledrejection (Deno's test runner fails the test if it does).
    const result = await kernel.runtime.runScript?.(
      `await new Promise((_, rej) => setTimeout(() => rej(new Error("late")), 40)); return 1;`,
      deps,
      10,
      kernel.log,
    );
    assertEquals(result?.ok, false);
    if (result && !result.ok) assertEquals(result.error.code, "TIMEOUT");
    // Wait past the script's own timer so its (handled) rejection settles.
    await new Promise((r) => setTimeout(r, 80));
  } finally {
    await db.close();
  }
});

Deno.test("TypeScript runtime delegates compiler operations", async () => {
  const db = await Database.create({ driver: "pglite" });
  try {
    const kernel = new Kernel(db);
    const deps = await kernel.compileDeps();
    const runtime = kernel.runtime;

    const handler = await runtime.compileHandler?.(
      "hello",
      `async function hello(c: any) { return c.text("hi"); }`,
      deps,
    );
    assertEquals(handler?.ok, true);

    const fn = await runtime.compileFunction?.(
      "add",
      `function add(a: number, b: number) { return a + b; }`,
      deps,
    );
    assertEquals(fn?.ok, true);
    if (fn?.ok) assertEquals(fn.data(2, 3), 5);

    const test = await runtime.compileTest?.(
      "sample_test",
      `async function sample_test() { assertEquals(1, 1); }`,
      deps,
    );
    assertEquals(test?.ok, true);
    if (test?.ok) await test.data();

    const devView = await runtime.compileDevView?.(
      "viewThing",
      `function viewThing(object: any) {
        return { type: "markdown", content: String(object) };
      }`,
      deps,
      kernelInspectAPI(kernel),
    );
    assertEquals(devView?.ok, true);

    const devTool = await runtime.compileDevTool?.(
      "toolThing",
      `function toolThing() { return "ok"; }`,
      [],
      deps,
    );
    assertEquals(devTool?.ok, true);
    if (devTool?.ok) assertEquals(await devTool.data(), "ok");

    const script = await runtime.runScript?.(
      `log("script ran"); log.info("script info"); return 7;`,
      deps,
      undefined,
      kernel.log,
    );
    assertEquals(script?.ok, true);
    if (script?.ok) {
      assertEquals(script.output, 7);
      assertEquals(script.logs, ["script ran", "script info"]);
      const scriptLogs = kernel.log.query({ source: "script", limit: 10 });
      assertEquals(
        scriptLogs.map((entry) => ({
          level: entry.level,
          message: entry.message,
        })),
        [
          { level: "debug", message: "script ran" },
          { level: "info", message: "script info" },
        ],
      );
    }

    const diagnostics = await runtime.getDiagnostics?.(
      "function",
      "answer",
      kernel,
      `function answer() { return 42; }`,
    );
    assertEquals(diagnostics, []);
  } finally {
    await db.close();
  }
});

Deno.test("TypeScript runtime delegates package operations", async () => {
  const db = await Database.create({ driver: "pglite" });
  try {
    const kernel = new Kernel(db);
    const runtime = kernel.runtime;
    const packageStore = (kernel.packages as unknown as {
      packages: Map<
        string,
        {
          name: string;
          specifier: string;
          installedAt: string;
          module: Record<string, unknown>;
        }
      >;
    }).packages;
    packageStore.set("marked", {
      name: "marked",
      specifier: "npm:marked@1",
      installedAt: "2026-01-01T00:00:00.000Z",
      module: { parse: "ok" },
    });
    packageStore.set("chalk", {
      name: "chalk",
      specifier: "npm:chalk@5",
      installedAt: "2026-01-02T00:00:00.000Z",
      module: { default: "chalk" },
    });
    kernel.handlers.register(
      "usesPackage",
      `async function usesPackage(c: any) { return c.text(String(packages.marked.parse)); }`,
      async () => new Response("ok"),
      undefined,
      undefined,
      kernel.runtimeId,
      runtime.defaultLanguage,
    );

    assertEquals(runtime.listPackages?.(kernel).map((pkg) => pkg.name), [
      "marked",
      "chalk",
    ]);
    assertEquals(
      runtime.getPackageEntry?.(kernel, "marked")?.specifier,
      "npm:marked@1",
    );
    assertEquals(
      (runtime.packageProxy?.(kernel).marked as Record<string, unknown>).parse,
      "ok",
    );

    const usage = await runtime.findUnusedPackages?.(kernel);
    assertEquals(usage?.used.map((pkg) => pkg.name), ["marked"]);
    assertEquals(usage?.unused.map((pkg) => pkg.name), ["chalk"]);

    assertEquals(runtime.removePackage?.(kernel, "chalk"), true);
    assertEquals(runtime.listPackages?.(kernel).map((pkg) => pkg.name), [
      "marked",
    ]);

    const restoreErrors = await runtime.restorePackages?.(kernel, []);
    assertEquals(restoreErrors, []);
    assertEquals(runtime.listPackages?.(kernel), []);
  } finally {
    await db.close();
  }
});
