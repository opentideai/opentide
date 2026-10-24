import { assertEquals } from "@std/assert";
import { getVersion } from "./build.ts";
import { Database } from "./db.ts";
import { Kernel } from "./registries.ts";
import {
  getDefaultRuntimeRegistry,
  type RuntimeAdapter,
  runtimeMetadata,
} from "./runtime.ts";
import { dispatchTool } from "./tools/dispatch.ts";

const FAKE_RUNTIME_ID = "contract-fake";

function createFakeRuntimeAdapter(): RuntimeAdapter {
  return {
    id: FAKE_RUNTIME_ID,
    label: "Contract Fake",
    defaultLanguage: "fake",
    supportedLanguages: ["fake"],
    capabilities: {
      executionMode: "in-process",
      handlers: true,
      functions: true,
      tests: true,
      scripts: true,
      devViews: false,
      devTools: false,
      packages: false,
      languageIntelligence: false,
      exportTargets: ["fake-archive"],
      buildTargets: [],
    },
    async compileHandler(name, source) {
      return {
        ok: true,
        data: async () => new Response(`${name}:${source}`),
      };
    },
    async compileFunction(name, source) {
      return {
        ok: true,
        data: (...args: unknown[]) => ({ name, source, args }),
      };
    },
    async compileTest(name, source) {
      return {
        ok: true,
        data: async () => {
          void name;
          void source;
        },
      };
    },
    async runScript(source) {
      return {
        ok: true,
        output: { source },
        logs: ["fake script"],
        durationMs: 0,
      };
    },
    async exportProject() {
      const bytes = new TextEncoder().encode("fake export");
      return {
        files: [{ path: "fake.runtime", content: "contract-fake" }],
        tarball: bytes,
        skippedSchemas: [],
      };
    },
  };
}

function registerFakeRuntime(): void {
  const registry = getDefaultRuntimeRegistry();
  if (!registry.get(FAKE_RUNTIME_ID)) {
    registry.register(createFakeRuntimeAdapter());
  }
}

async function withFakeKernel<T>(
  fn: (kernel: Kernel) => Promise<T>,
): Promise<T> {
  registerFakeRuntime();
  const db = await Database.create({ driver: "pglite" });
  const kernel = new Kernel(db, { runtimeId: FAKE_RUNTIME_ID });
  try {
    return await fn(kernel);
  } finally {
    await db.close();
  }
}

Deno.test("fake runtime resolves through the shared registry", () => {
  registerFakeRuntime();
  const runtime = getDefaultRuntimeRegistry().resolve(FAKE_RUNTIME_ID);
  const metadata = runtimeMetadata(runtime);

  assertEquals(metadata.id, FAKE_RUNTIME_ID);
  assertEquals(metadata.defaultLanguage, "fake");
  assertEquals(metadata.capabilities.exportTargets, ["fake-archive"]);
  assertEquals(metadata.capabilities.buildTargets, []);
});

Deno.test("generic dispatch routes execution through fake runtime", async () => {
  await withFakeKernel(async (kernel) => {
    const context = { manualEdit: true, userMessage: "contract test" };

    const fn = await dispatchTool(
      "define_function",
      { name: "answer", source: "function answer() { return 42; }" },
      kernel,
      () => {},
      context,
    );
    assertEquals(fn.ok, true);
    assertEquals(kernel.runtimeId, FAKE_RUNTIME_ID);
    assertEquals(kernel.functions.call("answer", 1, 2), {
      name: "answer",
      source: "function answer() { return 42; }",
      args: [1, 2],
    });

    const handler = await dispatchTool(
      "define_handler",
      { name: "hello", source: "async function hello(c: any) { return c; }" },
      kernel,
      () => {},
      context,
    );
    assertEquals(handler.ok, true);
    assertEquals(kernel.handlers.get("hello")?.runtimeId, FAKE_RUNTIME_ID);

    const test = await dispatchTool(
      "define_test",
      { name: "sample_test", source: "async function sample_test() {}" },
      kernel,
      () => {},
      context,
    );
    assertEquals(test.ok, true);

    const script = await dispatchTool(
      "run_script",
      { source: "fake script source" },
      kernel,
      () => {},
    );
    assertEquals(script.ok, true);
    assertEquals(script.data, {
      output: { source: "fake script source" },
      logs: ["fake script"],
      durationMs: 0,
    });
  });
});

Deno.test("fake runtime package and language fallbacks are explicit", async () => {
  await withFakeKernel(async (kernel) => {
    const packages = await dispatchTool("list_packages", {}, kernel, () => {});
    assertEquals(packages, { ok: true, data: [] });

    const install = await dispatchTool(
      "install_package",
      { name: "left-pad" },
      kernel,
      () => {},
      { manualEdit: true, userMessage: "contract test" },
    );
    assertEquals(install.ok, false);
    if (!install.ok && install.error) {
      assertEquals(install.error.code, "UNSUPPORTED_RUNTIME");
    }

    const diagnostics = await kernel.runtime.getDiagnostics?.(
      "function",
      "answer",
      kernel,
      "fake",
    ) ?? [];
    assertEquals(diagnostics, []);
  });
});

Deno.test("snapshot restore recompiles source through fake runtime", async () => {
  await withFakeKernel(async (kernel) => {
    const context = { manualEdit: true, userMessage: "contract test" };
    await dispatchTool(
      "define_function",
      { name: "snap", source: "function snap() { return 1; }" },
      kernel,
      () => {},
      context,
    );

    const meta = await kernel.snapshots.save(kernel, "fake runtime snapshot");
    kernel.functions.clear();
    assertEquals(kernel.functions.getEntry("snap"), undefined);

    const restored = await kernel.snapshots.restore(meta.id, kernel, () => {});
    assertEquals(restored.ok, true);
    assertEquals(kernel.functions.call("snap"), {
      name: "snap",
      source: "function snap() { return 1; }",
      args: [],
    });
  });
});

Deno.test("fake runtime export target delegates through dispatch", async () => {
  await withFakeKernel(async (kernel) => {
    // export_project reads the project version and manifest name off disk, so it
    // refuses a kernel with no project directory. Every kernel that can reach the
    // tool for real has one (project-loader.ts sets it on load), so the fake needs
    // one too — a bare Kernel stopped being a realistic stand-in when the tool
    // learned to write its output to disk.
    const projectDir = await Deno.makeTempDir({ prefix: "contract-export-" });
    kernel.projectDir = projectDir;
    try {
      const exported = await dispatchTool(
        "export_project",
        {},
        kernel,
        () => {},
      );
      assertEquals(exported.ok, true);
      assertEquals(exported.data, {
        fileCount: 1,
        files: ["fake.runtime"],
        projectVersion: getVersion(projectDir),
        message:
          "Project exported. Download from the Export button in the command palette or GET /api/export, or pass `out` to write the tree to disk.",
      });
    } finally {
      kernel.projectDir = null;
      await Deno.remove(projectDir, { recursive: true });
    }
  });
});
