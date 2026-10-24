import {
  assert,
  assertEquals,
  assertFalse,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import { testStoreComposition } from "../verification/test-stores.ts";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { Database } from "./db.ts";
import {
  BINARY_COMPILE_TARGETS,
  binaryCompileArgs,
  binaryOutputFilename,
  binaryRuntimeIncludePaths,
  buildBinary,
  buildDenoProject,
  buildDocker,
  buildDockerZip,
  buildDocsMarkdown,
  buildDocsSite,
  buildNodeFiles,
  buildNodeProject,
  checkExportTypes,
  DEFAULT_BUILD_OPTIONS,
  formatCommandFailure,
  getBuild,
  isBinaryCompileTarget,
  parseDenoCheckIssues,
  parseNodeLockVersions,
  reshapeSpecifierVersion,
  writeExportFiles,
} from "./build.ts";
import { Kernel } from "./registries.ts";

async function withKernel(
  fn: (kernel: Kernel, projectDir: string) => Promise<void>,
): Promise<void> {
  const projectDir = await Deno.makeTempDir({ prefix: "genie_build_test_" });
  const db = await Database.create({ driver: "pglite" });
  const kernel = new Kernel(db, { composition: testStoreComposition() });
  try {
    await fn(kernel, projectDir);
  } finally {
    await db.close();
    rmSync(projectDir, { recursive: true, force: true });
  }
}

Deno.test("DEFAULT_BUILD_OPTIONS includes production-safe content by default", () => {
  assertEquals(DEFAULT_BUILD_OPTIONS, {
    includeEnvFile: false,
    includeSeedData: false,
    includeMigrations: true,
    includeReferenceSeeds: true,
    includeReadme: true,
    includeAgent: true,
    includeGitignore: true,
    includeDocsMarkdown: true,
    includeDocsSite: true,
    includeManifest: false,
    includeDenoLock: false,
    includePackageLock: false,
  });
});

async function waitForJson(url: string, timeoutMs = 15_000): Promise<unknown> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return await res.json();
      await res.body?.cancel();
    } catch (err) {
      lastError = err;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out waiting for ${url}: ${String(lastError)}`);
}

async function waitForText(url: string, timeoutMs = 15_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return await res.text();
      await res.body?.cancel();
    } catch (err) {
      lastError = err;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out waiting for ${url}: ${String(lastError)}`);
}

async function waitForServerUrl(
  child: Deno.ChildProcess,
  timeoutMs = 15_000,
): Promise<URL> {
  if (!child.stdout) throw new Error("Expected child stdout to be piped");
  const reader = child.stdout.getReader();
  const decoder = new TextDecoder();
  const deadline = Date.now() + timeoutMs;
  let output = "";
  try {
    while (Date.now() < deadline) {
      const remaining = deadline - Date.now();
      const result = await Promise.race([
        reader.read(),
        new Promise<"timeout">((resolve) =>
          setTimeout(() => resolve("timeout"), remaining)
        ),
      ]);
      if (result === "timeout") break;
      if (result.done) break;
      output += decoder.decode(result.value, { stream: true });
      const match = output.match(/Server running on (http:\/\/[^\s]+)/);
      if (match?.[1]) return new URL(match[1]);
    }
  } finally {
    reader.releaseLock();
  }
  throw new Error(`Timed out waiting for server URL. Output:\n${output}`);
}

async function commandOutput(
  command: string,
  args: string[],
  cwd: string,
  options?: { env?: Record<string, string>; timeoutMs?: number },
): Promise<{
  success: boolean;
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}> {
  const child = new Deno.Command(command, {
    args,
    cwd,
    env: options?.env,
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    try {
      child.kill("SIGTERM");
    } catch {
      // Process may already have exited.
    }
  }, options?.timeoutMs ?? 15_000);
  try {
    const output = await child.output();
    return {
      success: output.success,
      code: output.code,
      stdout: new TextDecoder().decode(output.stdout),
      stderr: new TextDecoder().decode(output.stderr),
      timedOut,
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function runCommand(
  command: string,
  args: string[],
  cwd: string,
  timeoutMs = 60_000,
): Promise<void> {
  const child = new Deno.Command(command, {
    args,
    cwd,
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  const timeout = setTimeout(() => {
    try {
      child.kill("SIGTERM");
    } catch {
      // Process may already have exited.
    }
  }, timeoutMs);
  try {
    const output = await child.output();
    if (!output.success) {
      const stderr = new TextDecoder().decode(output.stderr);
      const stdout = new TextDecoder().decode(output.stdout);
      throw new Error(
        `${command} ${args.join(" ")} failed\n${stdout}\n${stderr}`,
      );
    }
  } finally {
    clearTimeout(timeout);
  }
}

Deno.test("buildDenoProject writes runnable config/env artifacts", async () => {
  await withKernel(async (kernel, projectDir) => {
    kernel.configs.set("PAGE_SIZE", 25);
    kernel.envVars.define("PUBLIC_URL", "https://example.test", "Public URL");

    const result = await buildDenoProject(kernel, projectDir, "1.2.3", {
      includeEnvFile: true,
    });

    assertEquals(result.version, "1.2.3");
    const outDir = join(projectDir, "dist", "v1.2.3");
    const deps = readFileSync(join(outDir, "deps.ts"), "utf-8");
    const denoJson = JSON.parse(
      readFileSync(join(outDir, "deno.json"), "utf-8"),
    );
    const dotEnv = readFileSync(join(outDir, ".env"), "utf-8");
    const main = readFileSync(join(outDir, "main.ts"), "utf-8");

    assertStringIncludes(deps, `["PAGE_SIZE", 25]`);
    assertStringIncludes(deps, "loadDotEnv");
    assertStringIncludes(denoJson.tasks.start, "deno run --env");
    assertEquals(denoJson.tasks.migrate.includes("--migrate"), true);
    assertEquals(denoJson.tasks.seed.includes("--seed"), true);
    assertEquals(denoJson.tasks["db:prepare"].includes("--prepare-db"), true);
    assertEquals(denoJson.tasks["db:check"].includes("--check-db"), true);
    assertEquals(
      denoJson.imports["@electric-sql/pglite"],
      "npm:@electric-sql/pglite",
    );
    assertStringIncludes(dotEnv, "PUBLIC_URL=https://example.test");
    assertStringIncludes(main, "await db.execute(stmt +");
    assertStringIncludes(main, `const APP_VERSION = "1.2.3";`);
    assertStringIncludes(main, "parseStartupOptions(runtimeArgs())");
    assertStringIncludes(
      main,
      `    { method: "GET", path: "/_health", handlerName: "platform:health" },`,
    );
    // Nothing the Deno artifact emits imports the framework any more, so its manifest
    // does not declare it either.
    assertEquals(denoJson.imports["hono"], undefined);
    assert(!main.includes(`from "hono"`));
    assertStringIncludes(main, `const schemaPath = runtimeFile("schema.sql");`);
    assertStringIncludes(main, `if (!existsSync(schemaPath)) return false;`);
    assert(!main.includes(`catch { /* schema.sql may not exist */ }`));
    assert(!existsSync(join(outDir, "seed.sql")));
  });
});

Deno.test("formatCommandFailure preserves compiler output", () => {
  const encoder = new TextEncoder();
  const message = formatCommandFailure("deno compile", {
    code: 1,
    stdout: encoder.encode("Download https://deno.land/std/path/mod.ts\n"),
    stderr: encoder.encode("\x1b[31merror\x1b[0m: Uncaught SyntaxError\n"),
  });

  assertStringIncludes(message, "deno compile failed with exit code 1.");
  assertStringIncludes(message, "error: Uncaught SyntaxError");
  assertStringIncludes(message, "stdout:");
  assertStringIncludes(message, "Download https://deno.land/std/path/mod.ts");
});

Deno.test("formatCommandFailure explains empty compiler output", () => {
  const message = formatCommandFailure("deno compile", {
    code: 1,
    stdout: new Uint8Array(),
    stderr: new Uint8Array(),
  });

  assertStringIncludes(message, "deno compile failed with exit code 1.");
  assertStringIncludes(message, "No output was captured from the command.");
});

Deno.test("parseDenoCheckIssues extracts structured diagnostics", () => {
  const output = `TS7006 [ERROR]: Parameter 'c' implicitly has an 'any' type.
async function serveApp(c) {
                        ^
    at file:///tmp/app/weather/handlers/serveApp.ts:5:25

Found 1 error.

error: Type checking failed.`;

  const issues = parseDenoCheckIssues(output, "/tmp/app");
  assertEquals(issues.length, 1);
  assertEquals(issues[0]?.severity, "error");
  assertEquals(issues[0]?.code, "TS7006");
  assertEquals(issues[0]?.file, "weather/handlers/serveApp.ts");
  assertEquals(issues[0]?.line, 5);
  assertEquals(issues[0]?.column, 25);
  assertStringIncludes(issues[0]?.snippet ?? "", "async function serveApp");
});

Deno.test("buildDenoProject includes seed.sql only when requested", async () => {
  await withKernel(async (kernel, projectDir) => {
    await kernel.db.defineSchema(
      "items",
      "CREATE TABLE items (id SERIAL PRIMARY KEY, name TEXT NOT NULL)",
    );
    await kernel.db.execute("INSERT INTO items (name) VALUES ($1)", ["apple"]);

    await buildDenoProject(kernel, projectDir, "1.0.0");
    assert(!existsSync(join(projectDir, "dist", "v1.0.0", "seed.sql")));

    await buildDenoProject(kernel, projectDir, "1.0.1", {
      includeSeedData: true,
    });
    const seed = readFileSync(
      join(projectDir, "dist", "v1.0.1", "seed.sql"),
      "utf-8",
    );
    const main = readFileSync(
      join(projectDir, "dist", "v1.0.1", "main.ts"),
      "utf-8",
    );
    assertStringIncludes(seed, `'apple'`);
    assertStringIncludes(main, "_genie_seed_meta");
    assertStringIncludes(
      main,
      `const seedKey = "seed.sql:" + hashString(seed);`,
    );
  });
});

Deno.test("buildDocker inherits exported runtime config", async () => {
  await withKernel(async (kernel, projectDir) => {
    kernel.configs.set("RATE_LIMIT", 100);

    const result = await buildDocker(kernel, projectDir, "2.0.0", true);
    const outDir = join(projectDir, "dist", "v2.0.0");

    assertEquals(result.version, "2.0.0");
    assert(existsSync(join(outDir, "Dockerfile")));
    assert(existsSync(join(outDir, "docker-compose.yml")));
    assertStringIncludes(
      readFileSync(join(outDir, "Dockerfile"), "utf-8"),
      "ENV HOST=0.0.0.0",
    );
    assertStringIncludes(
      readFileSync(join(outDir, "deps.ts"), "utf-8"),
      `["RATE_LIMIT", 100]`,
    );
  });
});

Deno.test("buildDockerZip includes Docker files", async () => {
  await withKernel(async (kernel, _projectDir) => {
    const zip = await buildDockerZip(kernel, "Docker App", "4.0.0", true);
    const text = new TextDecoder().decode(zip);

    assertStringIncludes(text, "Dockerfile");
    assertStringIncludes(text, "docker-compose.yml");
    assertStringIncludes(text, "Docker App-v4.0.0-docker/");
  });
});

Deno.test("buildNodeProject rewrites runtime env support for Node", async () => {
  await withKernel(async (kernel, projectDir) => {
    kernel.configs.set("FEATURE_FLAGS", { beta: true });

    const result = await buildNodeProject(
      kernel,
      projectDir,
      "My App",
      "3.0.0",
    );
    const outDir = join(projectDir, "dist", "v3.0.0-node");
    const deps = readFileSync(join(outDir, "deps.js"), "utf-8");
    const main = readFileSync(join(outDir, "main.js"), "utf-8");
    const packageJson = JSON.parse(
      readFileSync(join(outDir, "package.json"), "utf-8"),
    );

    assertEquals(result.version, "3.0.0");
    assertStringIncludes(deps, `["FEATURE_FLAGS", { "beta": true }]`);
    assertStringIncludes(deps, "process?.env");
    assert(!deps.includes("Deno.env"));
    // The Node-only imports are injected exactly once, after main.ts's deps.ts import
    // — the anchor that replaced the `from "hono"` line the shell no longer emits.
    assertEquals((main.match(/@hono\/node-server/g) ?? []).length, 1);
    assertEquals((main.match(/node:fs/g) ?? []).length, 1);
    // @hono/node-server is the only thing that pulls the framework in; the generated
    // source does not import it.
    assert(!main.includes(`from "hono"`));
    assertStringIncludes(main, `const APP_NAME = "My App";`);
    assertStringIncludes(main, `const APP_VERSION = "3.0.0";`);
    assertStringIncludes(main, "serve({ fetch: app.fetch, hostname, port }");
    assert(!main.includes("Deno.serve"));
    // Top-level framework deps are pinned to exact versions (no caret) so a
    // frozen install resolves the same tree — see generatePackageJson's pins.
    assertEquals(packageJson.dependencies["@electric-sql/pglite"], "0.4.5");
    // URLPattern, which the emitted router is built on, is a Node global only from 24.
    assertEquals(packageJson.engines, { node: ">=24" });
  });
});

// --- User dependency pinning (Slice 6.3) -------------------------------------

// Override the kernel's package listing with synthetic entries so a build can be
// driven offline (no real npm import), then RESTORE it. `kernel.runtime` is a
// shared module-level singleton (getDefaultRuntimeRegistry resolves the same
// adapter for every kernel), so a bare override would leak fake specifiers into
// every later test in this file — whose export/boot gates would then try to resolve
// them from npm and 404/timeout. Save-and-restore contains the stub to one test.
async function withStubbedPackages(
  kernel: Kernel,
  entries: Array<{ name: string; specifier: string }>,
  fn: () => Promise<void>,
): Promise<void> {
  const runtime = kernel.runtime as unknown as {
    listPackages: (kernel: Kernel) => Array<
      { name: string; specifier: string; installedAt: string }
    >;
  };
  const original = runtime.listPackages;
  runtime.listPackages = () =>
    entries.map((e) => ({ ...e, installedAt: "2026-01-01T00:00:00.000Z" }));
  try {
    await fn();
  } finally {
    runtime.listPackages = original;
  }
}

Deno.test("reshapeSpecifierVersion peels every specifier form the runtime mints", () => {
  // Confirmed empirically against buildNodeFiles' output (npm 11 / node 24).
  assertEquals(reshapeSpecifierVersion("npm:marked@1", "marked"), "1");
  assertEquals(reshapeSpecifierVersion("npm:exact@1.2.3", "exact"), "1.2.3");
  assertEquals(reshapeSpecifierVersion("npm:tag@latest", "tag"), "latest");
  // Scoped: the leading scope `@` is not the version separator.
  assertEquals(reshapeSpecifierVersion("npm:@scope/pkg@2", "@scope/pkg"), "2");
  assertEquals(
    reshapeSpecifierVersion("npm:@scope/pkg", "@scope/pkg"),
    undefined,
  );
  // Bare, no version → undefined so the caller applies the fallback.
  assertEquals(reshapeSpecifierVersion("npm:bare", "bare"), undefined);
});

Deno.test("parseNodeLockVersions reads top-level pins and never throws", () => {
  const lock = JSON.stringify({
    lockfileVersion: 3,
    packages: {
      "": { dependencies: { marked: "1" } },
      "node_modules/marked": { version: "1.2.3" },
      "node_modules/@scope/pkg": { version: "2.4.0" },
      // A nested transitive of the same name must NOT shadow the top-level pin.
      "node_modules/marked/node_modules/marked": { version: "9.9.9" },
      // No version → skipped.
      "node_modules/no-version": {},
    },
  });
  const versions = parseNodeLockVersions(lock);
  assertEquals(versions.get("marked"), "1.2.3");
  assertEquals(versions.get("@scope/pkg"), "2.4.0");
  assertFalse(versions.has("no-version"));

  // Legacy lockfileVersion-1 `dependencies` fallback.
  const legacy = JSON.stringify({
    lockfileVersion: 1,
    dependencies: { "is-number": { version: "7.0.0" } },
  });
  assertEquals(parseNodeLockVersions(legacy).get("is-number"), "7.0.0");

  // Malformed / absent → empty map, not an error.
  assertEquals(parseNodeLockVersions("{not json").size, 0);
  assertEquals(parseNodeLockVersions(undefined).size, 0);
  assertEquals(parseNodeLockVersions("[]").size, 0);
});

Deno.test("buildNodeFiles reshapes user deps to bare version values (no committed lock)", async () => {
  await withKernel(async (kernel) => {
    await withStubbedPackages(kernel, [
      { name: "marked", specifier: "npm:marked@1" },
      { name: "exact-pkg", specifier: "npm:exact-pkg@1.2.3" },
      { name: "tag-pkg", specifier: "npm:tag-pkg@latest" },
      { name: "bare-pkg", specifier: "npm:bare-pkg" },
      { name: "@scope/pkg", specifier: "npm:@scope/pkg@2" },
    ], async () => {
      const nodeFiles = await buildNodeFiles(kernel, "App", "1.0.0");
      const packageJson = JSON.parse(
        nodeFiles.find((f) => f.path === "package.json")!.content!,
      );
      const deps = packageJson.dependencies;

      // No committed lock → each value is the reshaped specifier version, never the
      // wrong `name@spec` shape.
      assertEquals(deps["marked"], "1");
      assertEquals(deps["exact-pkg"], "1.2.3");
      assertEquals(deps["tag-pkg"], "latest");
      assertEquals(deps["bare-pkg"], "*");
      assertEquals(deps["@scope/pkg"], "2");
      // Framework pins are unchanged.
      assertEquals(deps["hono"], "4.13.1");
      assertEquals(deps["@hono/node-server"], "1.19.17");
      assertEquals(deps["@electric-sql/pglite"], "0.4.5");
      assertEquals(packageJson.scripts.migrate, "node main.js --migrate");
      assertEquals(packageJson.scripts.seed, "node main.js --seed");
      assertEquals(
        packageJson.scripts["db:prepare"],
        "node main.js --prepare-db",
      );
      assertEquals(packageJson.scripts["db:check"], "node main.js --check-db");
    });
  });
});

Deno.test("buildNodeFiles pins user deps to the committed lock's exact version", async () => {
  await withKernel(async (kernel) => {
    const packageLock = JSON.stringify({
      lockfileVersion: 3,
      packages: {
        "": { dependencies: { marked: "1", "@scope/pkg": "2" } },
        "node_modules/marked": { version: "1.7.0" },
        "node_modules/@scope/pkg": { version: "2.4.0" },
      },
    });
    await withStubbedPackages(kernel, [
      { name: "marked", specifier: "npm:marked@1" },
      { name: "@scope/pkg", specifier: "npm:@scope/pkg@2" },
      // Not in the lock → falls back to the reshaped specifier version.
      { name: "loose-pkg", specifier: "npm:loose-pkg@^3" },
    ], async () => {
      const nodeFiles = await buildNodeFiles(kernel, "App", "1.0.0", {
        packageLock,
      });
      const deps = JSON.parse(
        nodeFiles.find((f) => f.path === "package.json")!.content!,
      ).dependencies;

      // Lock-derived exact pins (whole-graph, not just framework deps).
      assertEquals(deps["marked"], "1.7.0");
      assertEquals(deps["@scope/pkg"], "2.4.0");
      // Absent from the lock → reshaped specifier value.
      assertEquals(deps["loose-pkg"], "^3");
      // Framework pins still exact and unchanged.
      assertEquals(deps["@electric-sql/pglite"], "0.4.5");
    });
  });
});

Deno.test("documentation build targets write markdown and static site", async () => {
  await withKernel(async (kernel, projectDir) => {
    kernel.handlers.register(
      "listThings",
      "async function listThings(c) { return c.json([]); }",
      () => new Response("[]"),
    );
    kernel.routes.register("GET", "/things", "listThings", {
      summary: "List things",
    });

    const markdown = await buildDocsMarkdown(
      kernel,
      projectDir,
      "Docs Test",
      "1.2.3",
    );
    const site = await buildDocsSite(kernel, projectDir, "Docs Test", "1.2.3");

    assertEquals(markdown.version, "1.2.3");
    assertEquals(site.version, "1.2.3");
    assert(existsSync(join(projectDir, "docs", "index.md")));
    assert(existsSync(join(projectDir, "docs", "api", "index.md")));
    assert(existsSync(join(projectDir, "docs", ".genie-docs-manifest.json")));
    assertStringIncludes(
      readFileSync(join(projectDir, "docs", "api", "index.md"), "utf-8"),
      "GET",
    );
    const siteHtml = readFileSync(
      join(projectDir, "dist", "v1.2.3", "docs", "index.html"),
      "utf-8",
    );
    assertStringIncludes(siteHtml, "Docs Test Docs");
    assertStringIncludes(siteHtml, "listThings");
  });
});

Deno.test("buildDenoProject includes selected build content extras", async () => {
  await withKernel(async (kernel, projectDir) => {
    kernel.handlers.register(
      "listThings",
      "async function listThings(c) { return c.json([]); }",
      () => new Response("[]"),
    );
    kernel.routes.register("GET", "/things", "listThings", {
      summary: "List things",
    });

    await buildDenoProject(kernel, projectDir, "9.0.0", {
      includeReadme: false,
      includeAgent: false,
      includeGitignore: true,
      includeDocsMarkdown: true,
      includeDocsSite: true,
    });

    const outDir = join(projectDir, "dist", "v9.0.0");
    assert(existsSync(join(outDir, ".gitignore")));
    assert(existsSync(join(outDir, "docs", "index.md")));
    assert(existsSync(join(outDir, "docs", "index.html")));
    assert(!existsSync(join(outDir, "README.md")));
    assert(!existsSync(join(outDir, "AGENT.md")));
  });
});

function registerLooseRuntimeFixture(kernel: Kernel): void {
  kernel.functions.register(
    "double",
    "function double(value: number) { return value * 2; }",
    (value: unknown) => Number(value) * 2,
  );
  kernel.handlers.register(
    "servePage",
    `function servePage(c) {
  log.info('serving page');
  const rawHtml = templates.get('home') ?? '';
  const doubled = functions.call('double', 21);
  return c.html(rawHtml.replace('{{value}}', String(doubled)));
}`,
    () => new Response(),
  );
  kernel.routes.register("GET", "/", "servePage");
  kernel.templates.register("home", "<h1>{{value}}</h1>");
}

Deno.test({
  name:
    "binary compile targets expose supported architectures and output names",
  fn: () => {
    assertEquals(
      BINARY_COMPILE_TARGETS.map((target) => target.id),
      [
        "x86_64-unknown-linux-gnu",
        "aarch64-unknown-linux-gnu",
        "x86_64-pc-windows-msvc",
        "x86_64-apple-darwin",
        "aarch64-apple-darwin",
      ],
    );
    assert(isBinaryCompileTarget("aarch64-apple-darwin"));
    assert(!isBinaryCompileTarget("armv7-unknown-linux-gnueabihf"));
    assertEquals(
      binaryOutputFilename("My App", "1.2.3", "x86_64-pc-windows-msvc"),
      "my-app-v1.2.3-x86_64-pc-windows-msvc.exe",
    );
    assertEquals(
      binaryOutputFilename("My App", "1.2.3", "aarch64-apple-darwin"),
      "my-app-v1.2.3-aarch64-apple-darwin",
    );
    assertEquals(
      binaryCompileArgs(
        "/tmp/out",
        "/tmp/main.ts",
        "aarch64-unknown-linux-gnu",
        ["/tmp/assets/app.css"],
      ),
      // Deliberately a literal, not APP_RUNTIME_PERMISSIONS: this test exists to
      // pin the exact command line a release is compiled with, and deriving it
      // from the same constant the code uses would assert nothing. Changing the
      // app's permissions should require consciously editing this list.
      [
        "compile",
        "--no-check",
        "--allow-net",
        "--allow-read",
        "--allow-write",
        "--allow-env",
        "--allow-ffi",
        "--allow-sys",
        "--include",
        "/tmp/assets/app.css",
        "--target",
        "aarch64-unknown-linux-gnu",
        "--output",
        "/tmp/out",
        "/tmp/main.ts",
      ],
    );
    assertEquals(
      binaryRuntimeIncludePaths([
        { path: "main.ts", content: "" },
        { path: "schema.sql", content: "" },
        { path: "migrations/manifest.json", content: "" },
        { path: "migrations/items_v1.sql", content: "" },
        { path: "seeds/reference/manifest.json", content: "" },
        { path: "openapi.json", content: "" },
        { path: "docs/index.html", content: "" },
        /* Generated docs are not runtime files. This one matches the
           "/assets/" test and would otherwise be embedded in every binary —
           it is the generated reference page FOR an asset, not the asset. */
        { path: "docs/assets/asset-app-css.md", content: "" },
        { path: "assets/app.css", binary: new Uint8Array() },
        { path: "reader/assets/theme.css", binary: new Uint8Array() },
      ]),
      [
        "assets/app.css",
        "migrations/items_v1.sql",
        "migrations/manifest.json",
        "openapi.json",
        "reader/assets/theme.css",
        "schema.sql",
        "seeds/reference/manifest.json",
      ],
    );
  },
});

Deno.test({
  sanitizeOps: false,
  sanitizeResources: false,
  name:
    "binary compile uses no-check while export type check reports diagnostics",
  fn: async () => {
    await withKernel(async (kernel, projectDir) => {
      registerLooseRuntimeFixture(kernel);

      const check = await checkExportTypes(kernel, projectDir);
      assertEquals(check.ok, false);
      assertStringIncludes(check.output, "TS7006");
      assert(!check.output.includes("Stack backtrace"));
      assert(
        check.issues.some((issue) =>
          issue.severity === "error" && issue.code === "TS7006" &&
          issue.file.endsWith("handlers/servePage.ts")
        ),
      );

      const buildId = await buildBinary(
        kernel,
        projectDir,
        "Loose Runtime",
        "1.0.0",
      );
      const job = getBuild(buildId);
      assertEquals(job?.status, "done");
      assert(job?.outputPath);
      assert(existsSync(job.outputPath));
    });
  },
});

Deno.test({
  sanitizeOps: false,
  sanitizeResources: false,
  name: "compiled binary serves embedded assets without exported sidecar files",
  fn: async () => {
    await withKernel(async (kernel, projectDir) => {
      const css = new TextEncoder().encode("main { color: rgb(1, 2, 3); }");
      kernel.assets.register("app.css", css, "text/css; charset=utf-8");
      kernel.handlers.register(
        "home",
        `function home(c: any) {
          return c.html('<link rel="stylesheet" href="/_assets/app.css"><main>Speed Read</main>');
        }`,
        () => new Response(),
      );
      kernel.routes.register("GET", "/", "home");

      const buildId = await buildBinary(
        kernel,
        projectDir,
        "Asset Runtime",
        "1.0.0",
      );
      const job = getBuild(buildId);
      assertEquals(job?.status, "done");
      assert(job?.outputPath);

      const child = new Deno.Command(job.outputPath, {
        args: ["--random-port"],
        cwd: projectDir,
        stdout: "piped",
        stderr: "null",
      }).spawn();

      try {
        const url = await waitForServerUrl(child);
        const res = await fetch(new URL("/_assets/app.css", url));
        const body = await res.text();
        assertEquals(res.status, 200);
        assertEquals(
          res.headers.get("content-type"),
          "text/css; charset=utf-8",
        );
        assertEquals(body, "main { color: rgb(1, 2, 3); }");
      } finally {
        try {
          child.kill("SIGTERM");
        } catch {
          // Process may already have exited.
        }
        await child.status.catch(() => undefined);
      }
    });
  },
});

Deno.test({
  sanitizeOps: false,
  sanitizeResources: false,
  name: "compiled binary adopts a compatible existing database",
  fn: async () => {
    await withKernel(async (kernel, projectDir) => {
      const schema = await kernel.db.defineSchema(
        "documents",
        "CREATE TABLE documents (id SERIAL PRIMARY KEY, title TEXT NOT NULL)",
      );
      assertEquals(schema.ok, true);

      const firstBuildId = await buildBinary(
        kernel,
        projectDir,
        "Upgrade Runtime",
        "0.2.0",
        { includeMigrations: false },
      );
      const firstJob = getBuild(firstBuildId);
      assertEquals(firstJob?.status, "done");
      assert(firstJob?.outputPath);

      const firstPrepare = await commandOutput(
        firstJob.outputPath,
        ["--prepare-db"],
        projectDir,
        { timeoutMs: 20_000 },
      );
      assertEquals(firstPrepare.success, true, firstPrepare.stderr);

      const insert = await commandOutput(
        Deno.execPath(),
        [
          "eval",
          "--allow-read",
          "--allow-write",
          "--allow-env",
          "--allow-ffi",
          `import { PGlite } from "npm:@electric-sql/pglite";
const pg = new PGlite("./data");
await pg.waitReady;
await pg.query("INSERT INTO documents (title) VALUES ($1)", ["kept"]);
await pg.close();`,
        ],
        projectDir,
        { timeoutMs: 20_000 },
      );
      assertEquals(insert.success, true, insert.stderr);

      const secondBuildId = await buildBinary(
        kernel,
        projectDir,
        "Upgrade Runtime",
        "0.3.0",
        { includeMigrations: true },
      );
      const secondJob = getBuild(secondBuildId);
      assertEquals(secondJob?.status, "done");
      assert(secondJob?.outputPath);

      const secondPrepare = await commandOutput(
        secondJob.outputPath,
        ["--prepare-db"],
        projectDir,
        { timeoutMs: 20_000 },
      );
      assertEquals(secondPrepare.success, true, secondPrepare.stderr);
      assertStringIncludes(secondPrepare.stdout, "adopted=true");

      const inspect = await commandOutput(
        Deno.execPath(),
        [
          "eval",
          "--allow-read",
          "--allow-write",
          "--allow-env",
          "--allow-ffi",
          `import { PGlite } from "npm:@electric-sql/pglite";
const pg = new PGlite("./data");
await pg.waitReady;
const docs = await pg.query("SELECT title FROM documents ORDER BY id");
const migrations = await pg.query('SELECT COUNT(*) AS count FROM "_genie_app_migrations"');
console.log(JSON.stringify({ docs: docs.rows, migrations: migrations.rows }));
await pg.close();`,
        ],
        projectDir,
        { timeoutMs: 20_000 },
      );
      assertEquals(inspect.success, true, inspect.stderr);
      const inspected = JSON.parse(inspect.stdout) as {
        docs: Array<{ title: string }>;
        migrations: Array<{ count: unknown }>;
      };
      assertEquals(inspected.docs, [{ title: "kept" }]);
      assertEquals(String(inspected.migrations[0]?.count), "1");
    });
  },
});

Deno.test({
  sanitizeOps: false,
  sanitizeResources: false,
  name: "exported Deno app prints help and version without starting server",
  fn: async () => {
    await withKernel(async (kernel, projectDir) => {
      await buildDenoProject(kernel, projectDir, "8.0.0");
      const outDir = join(projectDir, "dist", "v8.0.0");

      const help = await commandOutput(
        Deno.execPath(),
        ["task", "start", "--", "--help"],
        outDir,
      );
      assertEquals(help.success, true);
      assertEquals(help.timedOut, false);
      assertStringIncludes(help.stdout, "Usage:");
      assertStringIncludes(help.stdout, "-p, --port <port|auto>");
      assertStringIncludes(help.stdout, "--random-port");
      assert(!help.stdout.includes("Server running on"));

      const version = await commandOutput(
        Deno.execPath(),
        ["task", "start", "--", "--version"],
        outDir,
      );
      assertEquals(version.success, true);
      assertEquals(version.timedOut, false);
      assertStringIncludes(version.stdout, "OpenTide App 8.0.0");
      assert(!version.stdout.includes("Server running on"));
    });
  },
});

Deno.test({
  sanitizeOps: false,
  sanitizeResources: false,
  name: "exported Deno app fails when explicit port is occupied",
  fn: async () => {
    const blocker = Deno.serve(
      { hostname: "127.0.0.1", port: 0, onListen: () => {} },
      () => new Response("occupied"),
    );
    const occupiedPort = blocker.addr.port;

    try {
      await withKernel(async (kernel, projectDir) => {
        await buildDenoProject(kernel, projectDir, "8.1.0");
        const outDir = join(projectDir, "dist", "v8.1.0");
        const output = await commandOutput(
          Deno.execPath(),
          ["task", "start"],
          outDir,
          {
            env: { HOST: "127.0.0.1", PORT: String(occupiedPort) },
            timeoutMs: 10_000,
          },
        );

        assertEquals(output.timedOut, false);
        assertEquals(output.success, false);
        assert(!output.stdout.includes("Server running on"));
        assert(!output.stderr.includes("trying another port"));
        assert(
          output.stderr.includes("Address already in use") ||
            output.stderr.includes("AddrInUse") ||
            output.stderr.includes("EADDRINUSE"),
        );
      });
    } finally {
      await blocker.shutdown();
    }
  },
});

Deno.test({
  sanitizeOps: false,
  sanitizeResources: false,
  name:
    "exported Deno app falls back to a random port when default port is busy",
  fn: async () => {
    let blocker: Deno.HttpServer<Deno.NetAddr> | null = null;
    try {
      blocker = Deno.serve(
        { hostname: "127.0.0.1", port: 3001, onListen: () => {} },
        () => new Response("occupied"),
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes("Address already in use")) {
        console.warn("Skipping fallback test because port 3001 is in use.");
        return;
      }
      throw err;
    }

    try {
      await withKernel(async (kernel, projectDir) => {
        const source = `function smoke(c: any) {
        return c.json({ ok: true });
      }`;
        kernel.handlers.register("smoke", source, () => new Response());
        kernel.routes.register("GET", "/smoke", "smoke", {
          summary: "Smoke test",
        });

        await buildDenoProject(kernel, projectDir, "7.0.0");
        const outDir = join(projectDir, "dist", "v7.0.0");
        const child = new Deno.Command(Deno.execPath(), {
          args: ["task", "start"],
          cwd: outDir,
          env: { HOST: "127.0.0.1", PORT: "" },
          stdout: "piped",
          stderr: "null",
        }).spawn();

        try {
          const url = await waitForServerUrl(child);
          assert(url.port !== "3001");

          const health = await waitForJson(
            new URL("/_health", url).toString(),
          ) as {
            ok: boolean;
            name: string;
            version: string;
          };
          assertEquals(health, {
            ok: true,
            name: "OpenTide App",
            version: "7.0.0",
          });

          const spec = await waitForJson(
            new URL("/openapi.json", url).toString(),
          ) as {
            paths?: Record<string, unknown>;
          };
          assert(spec.paths?.["/smoke"]);
        } finally {
          try {
            child.kill("SIGTERM");
          } catch {
            // Process may already have exited.
          }
          await child.status.catch(() => undefined);
        }
      });
    } finally {
      await blocker.shutdown();
    }
  },
});

Deno.test({
  sanitizeOps: false,
  sanitizeResources: false,
  name: "exported Deno app starts with templates log and loose handler types",
  fn: async () => {
    await withKernel(async (kernel, projectDir) => {
      const port = 45_233;
      registerLooseRuntimeFixture(kernel);

      await buildDenoProject(kernel, projectDir, "6.0.0");
      const outDir = join(projectDir, "dist", "v6.0.0");
      const child = new Deno.Command(Deno.execPath(), {
        args: ["task", "start"],
        cwd: outDir,
        env: { PORT: String(port) },
        stdout: "null",
        stderr: "null",
      }).spawn();

      try {
        const html = await waitForText(`http://127.0.0.1:${port}/`);
        assertStringIncludes(html, "<h1>42</h1>");
      } finally {
        try {
          child.kill("SIGTERM");
        } catch {
          // Process may already have exited.
        }
        await child.status.catch(() => undefined);
      }
    });
  },
});

Deno.test({
  sanitizeOps: false,
  sanitizeResources: false,
  name: "exported Node app serves route with config and env",
  fn: async () => {
    await withKernel(async (kernel, projectDir) => {
      const port = 45_232;
      kernel.configs.set("PAGE_SIZE", 50);
      kernel.envVars.define("PUBLIC_URL", "https://node.example.test");

      const source = `function smoke(c: any) {
        return c.json({
          pageSize: config.get("PAGE_SIZE"),
          publicUrl: env.PUBLIC_URL,
        });
      }`;
      kernel.handlers.register("smoke", source, () => new Response());
      kernel.routes.register("GET", "/smoke", "smoke");

      await buildNodeProject(kernel, projectDir, "Node Smoke", "5.0.0", {
        includeEnvFile: true,
      });
      const outDir = join(projectDir, "dist", "v5.0.0-node");

      await runCommand(
        "npm",
        [
          "install",
          "--ignore-scripts",
          "--no-audit",
          "--no-fund",
          "--package-lock=false",
        ],
        outDir,
        120_000,
      );

      const child = new Deno.Command("node", {
        args: ["main.js"],
        cwd: outDir,
        env: { PORT: String(port) },
        stdout: "null",
        // A boot failure only shows up here; the fetch just times out.
        stderr: "inherit",
      }).spawn();

      try {
        const data = await waitForJson(`http://127.0.0.1:${port}/smoke`) as {
          pageSize: number;
          publicUrl: string;
        };
        assertEquals(data.pageSize, 50);
        assertEquals(data.publicUrl, "https://node.example.test");
      } finally {
        try {
          child.kill("SIGTERM");
        } catch {
          // Process may already have exited.
        }
        await child.status.catch(() => undefined);
      }
    });
  },
});

Deno.test({
  sanitizeOps: false,
  sanitizeResources: false,
  name: "exported Deno app serves route with config and env",
  fn: async () => {
    await withKernel(async (kernel, projectDir) => {
      const port = 45_231;
      kernel.configs.set("PAGE_SIZE", 25);
      kernel.envVars.define("PUBLIC_URL", "https://example.test");

      const source = `function smoke(c: any) {
        return c.json({
          pageSize: config.get("PAGE_SIZE"),
          publicUrl: env.PUBLIC_URL,
        });
      }`;
      kernel.handlers.register("smoke", source, () => new Response());
      kernel.routes.register("GET", "/smoke", "smoke");

      await buildDenoProject(kernel, projectDir, "4.0.0", {
        includeEnvFile: true,
      });
      const outDir = join(projectDir, "dist", "v4.0.0");
      const child = new Deno.Command(Deno.execPath(), {
        args: ["task", "start"],
        cwd: outDir,
        env: { PORT: String(port) },
        stdout: "null",
        stderr: "null",
      }).spawn();

      try {
        const data = await waitForJson(`http://127.0.0.1:${port}/smoke`) as {
          pageSize: number;
          publicUrl: string;
        };
        assertEquals(data.pageSize, 25);
        assertEquals(data.publicUrl, "https://example.test");
      } finally {
        try {
          child.kill("SIGTERM");
        } catch {
          // Process may already have exited.
        }
        await child.status.catch(() => undefined);
      }
    });
  },
});

// PGlite is Postgres in-process: an export that exits without closing it leaves the
// data directory with an unflushed WAL, and the standard "stop the service, tar data/"
// backup then captures a database that still needs recovery. The close is also the
// thing most likely to hang a shutdown, which systemd escalates to SIGKILL — the exact
// unclean exit it was added to prevent — so both halves are pinned here.
Deno.test({
  name:
    "exported Deno app closes its database on SIGTERM and still exits promptly",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await withKernel(async (kernel, projectDir) => {
      const port = 45_237;
      kernel.handlers.register(
        "ping",
        `function ping(c: any) { return c.json({ ok: true }); }`,
        () => new Response(),
      );
      kernel.routes.register("GET", "/ping", "ping");

      await buildDenoProject(kernel, projectDir, "4.0.0", {});
      const outDir = join(projectDir, "dist", "v4.0.0");

      const deps = readFileSync(join(outDir, "deps.ts"), "utf8");
      assert(
        deps.includes("async close()") && deps.includes("CHECKPOINT"),
        "the exported db must expose a checkpointing close()",
      );
      const main = readFileSync(join(outDir, "main.ts"), "utf8");
      assert(
        main.includes("await closeDatabase();"),
        "the exported shutdown must close the database",
      );

      const child = new Deno.Command(Deno.execPath(), {
        args: ["task", "start"],
        cwd: outDir,
        env: { PORT: String(port) },
        stdout: "null",
        stderr: "null",
      }).spawn();

      let exited = false;
      try {
        await waitForJson(`http://127.0.0.1:${port}/ping`);
        child.kill("SIGTERM");
        const status = await Promise.race([
          child.status.then((s) => ({ timedOut: false, code: s.code })),
          new Promise<{ timedOut: true; code: number }>((resolve) =>
            setTimeout(() => resolve({ timedOut: true, code: -1 }), 20_000)
          ),
        ]);
        exited = !status.timedOut;
        assert(
          !status.timedOut,
          "SIGTERM must still stop the app — closing the database cannot hang shutdown",
        );
        assertEquals(status.code, 0);
      } finally {
        if (!exited) {
          try {
            child.kill("SIGKILL");
          } catch {
            // Process may already have exited.
          }
          await child.status.catch(() => undefined);
        }
      }
    });
  },
});

// SIGHUP is the signal that actually costs data directories: a closed terminal, a
// dropped SSH session or a parent going away all deliver it, and the DEFAULT ACTION IS
// DEATH — no shutdown handler, no closeDatabase(), no checkpoint. PGlite's emscripten
// filesystem has no working fsync, so skipping the checkpoint does not merely lose the
// recent writes, it leaves ./data unopenable. Pinned separately from SIGTERM because a
// handler registered for one proves nothing about the other.
Deno.test({
  name: "exported Deno app closes its database on SIGHUP too",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await withKernel(async (kernel, projectDir) => {
      const port = 45_239;
      kernel.handlers.register(
        "ping",
        `function ping(c: any) { return c.json({ ok: true }); }`,
        () => new Response(),
      );
      kernel.routes.register("GET", "/ping", "ping");

      await buildDenoProject(kernel, projectDir, "4.0.0", {});
      const outDir = join(projectDir, "dist", "v4.0.0");

      const main = readFileSync(join(outDir, "main.ts"), "utf8");
      assert(
        main.includes('"SIGHUP"'),
        "the exported shutdown must register SIGHUP, not just the interactive signals",
      );

      const child = new Deno.Command(Deno.execPath(), {
        args: ["task", "start"],
        cwd: outDir,
        env: { PORT: String(port) },
        stdout: "null",
        stderr: "null",
      }).spawn();

      let exited = false;
      try {
        await waitForJson(`http://127.0.0.1:${port}/ping`);
        child.kill("SIGHUP");
        const status = await Promise.race([
          child.status.then((s) => ({ timedOut: false, code: s.code })),
          new Promise<{ timedOut: true; code: number }>((resolve) =>
            setTimeout(() => resolve({ timedOut: true, code: -1 }), 20_000)
          ),
        ]);
        exited = !status.timedOut;
        assert(
          !status.timedOut,
          "SIGHUP must run the clean shutdown, not hang and not kill outright",
        );
        // Exit 0 is the handler's own exitProcess(0). An uncaught SIGHUP would kill
        // the process with a signal instead, which is the bug this pins.
        assertEquals(status.code, 0);
      } finally {
        if (!exited) {
          try {
            child.kill("SIGKILL");
          } catch {
            // Process may already have exited.
          }
          await child.status.catch(() => undefined);
        }
      }
    });
  },
});

// F-08: entity/asset names flow into file.path verbatim from agent tool calls
// (untrusted prompts). A `../` name must not let a write escape the out dir.
Deno.test("writeExportFiles: contains writes within the output dir (F-08)", async () => {
  const root = await Deno.makeTempDir({ prefix: "genie_export_contain_" });
  try {
    const outDir = join(root, "out", "nested");

    // A normal, well-behaved export writes where expected.
    writeExportFiles(outDir, [
      { path: "handlers/ok.ts", content: "export const ok = 1;\n" },
    ]);
    assert(existsSync(join(outDir, "handlers", "ok.ts")));

    // A traversal name is rejected and writes nothing outside the out dir.
    assertThrows(
      () =>
        writeExportFiles(outDir, [
          { path: "assets/../../../ESCAPED.txt", content: "pwned\n" },
        ]),
      Error,
      "escapes the output directory",
    );
    assertFalse(existsSync(join(root, "ESCAPED.txt")));
    assertFalse(existsSync(join(root, "out", "ESCAPED.txt")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// A fetch-ABI handler annotated with the real thing — `Request`, `Response`,
// `HandlerContext` — has to survive the export's `deno check`. The first two are
// Deno globals and need nothing; `HandlerContext` is an ambient LSP declaration
// inside the kernel and ambient declarations do not survive an export, so this is
// the gate that would catch it going missing from the generated deps.ts.
Deno.test({
  sanitizeOps: false,
  sanitizeResources: false,
  name: "export type check accepts a fetch-ABI handler's annotations",
  fn: async () => {
    await withKernel(async (kernel, projectDir) => {
      kernel.handlers.register(
        "getItem",
        `async function getItem(req: Request, ctx: HandlerContext): Promise<Response> {
  const url = new URL(req.url);
  const limit: string | null = url.searchParams.get("limit");
  const id: string = ctx.params.id;
  if (req.method === "POST") {
    const body = await req.json();
    return Response.json({ body, id }, { status: 201 });
  }
  return Response.json({ id, limit });
}`,
        () => new Response(),
      );
      kernel.routes.register("GET", "/items/:id", "getItem", {
        summary: "get item",
      });

      const check = await checkExportTypes(kernel, projectDir);
      assertEquals(check.issues, []);
      assertEquals(check.ok, true);
    });
  },
});
