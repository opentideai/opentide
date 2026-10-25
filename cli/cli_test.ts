import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { dirname } from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  createProject,
  isProject,
  projectSlug,
  removeProject,
} from "../core/project-manager.ts";
import { loadProject, unloadProject } from "../core/project-loader.ts";
import { testStoreComposition } from "../verification/test-stores.ts";
import { join } from "node:path";
import { isolateHome } from "../core/test-home_test.ts";

isolateHome();

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

// Run `deno task opentide <args>` and return its exit code + captured streams.
// The dispatch cases below all exit promptly (they never stand up a server).
async function runOpentide(
  args: string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  const cmd = new Deno.Command("deno", {
    args: ["task", "opentide", ...args],
    cwd: REPO_ROOT,
    stdout: "piped",
    stderr: "piped",
  });
  const { code, stdout, stderr } = await cmd.output();
  return {
    code,
    stdout: new TextDecoder().decode(stdout),
    stderr: new TextDecoder().decode(stderr),
  };
}

Deno.test("opentide with no command: usage on stderr, exit 2", async () => {
  const { code, stderr } = await runOpentide([]);
  assertEquals(code, 2);
  assertStringIncludes(stderr, "USAGE:");
});

Deno.test("opentide --help: usage on stdout, exit 0", async () => {
  const { code, stdout } = await runOpentide(["--help"]);
  assertEquals(code, 0);
  assertStringIncludes(stdout, "serve");
  assertStringIncludes(stdout, "mcp");
});

Deno.test("opentide <unknown>: rejected with exit 2", async () => {
  const { code, stderr } = await runOpentide(["bogus"]);
  assertEquals(code, 2);
  assertStringIncludes(stderr, "unknown command");
});

Deno.test("opentide serve without --project: rejected headless (D2), exit 2", async () => {
  const { code, stderr } = await runOpentide(["serve"]);
  assertEquals(code, 2);
  assertStringIncludes(stderr, "requires --project");
});

Deno.test("opentide scaffold without <name>: usage on stderr, exit 2", async () => {
  const { code, stderr } = await runOpentide(["scaffold", "./only-a-dir"]);
  assertEquals(code, 2);
  assertStringIncludes(stderr, "requires <dir> and <name>");
});

Deno.test("opentide scaffold <dir> <name>: creates a loadable project, prints its path, exit 0", async () => {
  const parent = await Deno.makeTempDir({ prefix: "opentide-scaffold-cli-" });
  const created = join(parent, "todo-app"); // slug of "Todo App" under <dir>
  try {
    const { code, stdout } = await runOpentide([
      "scaffold",
      parent,
      "Todo App",
    ]);
    assertEquals(code, 0);
    // The dispatcher echoes the resolved path (not the literal <dir>) — D2.
    assertStringIncludes(stdout, created);
    assert(
      isProject(created),
      "the scaffolded path should be a loadable project",
    );
  } finally {
    removeProject(created);
    await Deno.remove(parent, { recursive: true }).catch(() => {});
  }
});

Deno.test("opentide build/export/lock:refresh without --project: usage on stderr, exit 2", async () => {
  for (const command of ["build", "export", "lock:refresh"]) {
    const { code, stderr } = await runOpentide([command]);
    assertEquals(code, 2, `${command} without --project should exit 2`);
    assertStringIncludes(stderr, "requires --project");
  }
});

Deno.test("opentide build and export reject an unknown --target", async () => {
  for (const command of ["build", "export"]) {
    const { code, stderr } = await runOpentide([
      command,
      "--project",
      "/nonexistent",
      "--target",
      "rust",
    ]);
    assertEquals(code, 2, `${command} --target rust should exit 2`);
    assertStringIncludes(stderr, "unknown --target");
  }
});

Deno.test("opentide lock:refresh with an unknown --target: usage on stderr, exit 2", async () => {
  // Target validation runs before the project check, so no --project is needed to
  // reject `binary` (a compiled binary has no lock of its own).
  const { code, stderr } = await runOpentide([
    "lock:refresh",
    "--project",
    "/nonexistent",
    "--target",
    "binary",
  ]);
  assertEquals(code, 2);
  assertStringIncludes(stderr, "unknown --target");
});

// build and export run headless against a loaded Kernel and land real
// artifacts: Node by default, Deno with --target deno, and the --tarball form.
// One scaffolded project serves every run-once subprocess.
Deno.test("opentide build + export run headless against a loaded project", async () => {
  const parent = await Deno.makeTempDir({ prefix: "opentide-build-cli-" });
  const project = createProject(parent, "Build Smoke");
  try {
    // build → dist/v<version>-node, a Node app (fresh project has no
    // version.json, so getVersion falls back to 0.1.0).
    const built = await runOpentide(["build", "--project", project.path]);
    assertEquals(built.code, 0, built.stderr);
    assert(
      existsSync(join(project.path, "dist", "v0.1.0-node", "package.json")),
      "build should write dist/v0.1.0-node/package.json",
    );
    const builtDeno = await runOpentide([
      "build",
      "--project",
      project.path,
      "--target",
      "deno",
    ]);
    assertEquals(builtDeno.code, 0, builtDeno.stderr);
    assert(
      existsSync(join(project.path, "dist", "v0.1.0", "deno.json")),
      "build --target deno should write dist/v0.1.0/deno.json",
    );

    // export (default, unpacked tree) → a Node app under <project>/export.
    const exported = await runOpentide(["export", "--project", project.path]);
    assertEquals(exported.code, 0, exported.stderr);
    assert(
      existsSync(join(project.path, "export", "main.js")),
      "export should write the Node file tree (main.js) to <project>/export",
    );
    assertStringIncludes(
      await Deno.readTextFile(join(project.path, "export", "README.md")),
      "npm start",
    );
    const exportedDeno = await runOpentide([
      "export",
      "--project",
      project.path,
      "--target",
      "deno",
      "--out",
      join(parent, "deno-export"),
    ]);
    assertEquals(exportedDeno.code, 0, exportedDeno.stderr);
    assert(
      existsSync(join(parent, "deno-export", "deps.ts")),
      "export --target deno should write the Deno tree (deps.ts)",
    );

    // export --tarball → the packed form at the default <project>/<slug>.tar.
    // The default filename is a SLUG of the project name (F-10), matching the
    // project directory, so a name with spaces/traversal can't escape it.
    const tar = await runOpentide([
      "export",
      "--project",
      project.path,
      "--tarball",
    ]);
    assertEquals(tar.code, 0, tar.stderr);
    assert(
      existsSync(join(project.path, `${projectSlug(project.name)}.tar`)),
      "export --tarball should write <project>/<slug>.tar",
    );
  } finally {
    removeProject(project.path);
    await Deno.remove(parent, { recursive: true }).catch(() => {});
  }
});

Deno.test("opentide build/export include captured seed data only with explicit flag", async () => {
  const parent = await Deno.makeTempDir({ prefix: "opentide-seed-cli-" });
  const project = createProject(parent, "Seed Flag");
  const defaultOut = join(parent, "default-export");
  const seedOut = join(parent, "seed-export");
  let ctx: Awaited<ReturnType<typeof loadProject>> | null = null;
  try {
    ctx = await loadProject(project.path, {
      appPort: 0,
      composition: testStoreComposition(),
    });
    const schema = await ctx.db.defineSchema(
      "items",
      "CREATE TABLE items (id SERIAL PRIMARY KEY, name TEXT NOT NULL)",
    );
    assertEquals(schema.ok, true);
    await ctx.db.execute("INSERT INTO items (name) VALUES ($1)", ["apple"]);
    await unloadProject(ctx);
    ctx = null;

    const builtDefault = await runOpentide([
      "build",
      "--project",
      project.path,
    ]);
    assertEquals(builtDefault.code, 0, builtDefault.stderr);
    assert(
      !existsSync(join(project.path, "dist", "v0.1.0-node", "seed.sql")),
      "default build should not include captured seed data",
    );

    const builtWithSeed = await runOpentide([
      "build",
      "--project",
      project.path,
      "--include-seed-data",
    ]);
    assertEquals(builtWithSeed.code, 0, builtWithSeed.stderr);
    assertStringIncludes(
      await Deno.readTextFile(
        join(project.path, "dist", "v0.1.0-node", "seed.sql"),
      ),
      "apple",
    );

    const exportedDefault = await runOpentide([
      "export",
      "--project",
      project.path,
      "--out",
      defaultOut,
    ]);
    assertEquals(exportedDefault.code, 0, exportedDefault.stderr);
    assert(
      !existsSync(join(defaultOut, "seed.sql")),
      "default export should not include captured seed data",
    );

    const exportedWithSeed = await runOpentide([
      "export",
      "--project",
      project.path,
      "--out",
      seedOut,
      "--include-seed-data",
    ]);
    assertEquals(exportedWithSeed.code, 0, exportedWithSeed.stderr);
    assertStringIncludes(
      await Deno.readTextFile(join(seedOut, "seed.sql")),
      "apple",
    );
  } finally {
    if (ctx) await unloadProject(ctx);
    removeProject(project.path);
    await Deno.remove(parent, { recursive: true }).catch(() => {});
  }
});

// F-11: an explicit `--out` into a non-empty directory must refuse (non-zero
// exit) rather than merge-and-clobber, and `--force` must clear stale files
// first so a since-deleted entity's file can't linger in the export.
Deno.test("opentide export --out guards a non-empty dir; --force overwrites", async () => {
  const parent = await Deno.makeTempDir({ prefix: "opentide-export-force-" });
  const project = createProject(parent, "Export Force");
  const outDir = join(parent, "out");
  try {
    // Seed the target with a stale file the export will never produce.
    Deno.mkdirSync(outDir, { recursive: true });
    const staleFile = join(outDir, "stale-handler.ts");
    Deno.writeTextFileSync(staleFile, "// left over from a prior export");

    // (a) Without --force: refuse with a non-zero exit, leaving the dir intact.
    const refused = await runOpentide([
      "export",
      "--project",
      project.path,
      "--out",
      outDir,
    ]);
    assert(
      refused.code !== 0,
      "export into a non-empty --out should exit non-zero",
    );
    assertStringIncludes(refused.stderr, "already exists");
    assert(existsSync(staleFile), "a refused export must not touch the target");

    // (b) With --force: overwrite, removing the stale file and writing the tree.
    const forced = await runOpentide([
      "export",
      "--project",
      project.path,
      "--out",
      outDir,
      "--force",
    ]);
    assertEquals(forced.code, 0, forced.stderr);
    assert(
      existsSync(join(outDir, "main.js")),
      "--force should write the export tree",
    );
    assert(!existsSync(staleFile), "--force should clear stale files first");
  } finally {
    removeProject(project.path);
    await Deno.remove(parent, { recursive: true }).catch(() => {});
  }
});

// Pick an ephemeral loopback port by binding :0 and releasing it.
function freePort(): number {
  const listener = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  const { port } = listener.addr as Deno.NetAddr;
  listener.close();
  return port;
}

// Read `stream` until `needle` appears; cancels (unblocking the pending read) on
// timeout so a stuck child can't hang the test.
async function waitForLine(
  stream: ReadableStream<Uint8Array>,
  needle: string,
  timeoutMs: number,
): Promise<void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    reader.cancel().catch(() => {});
  }, timeoutMs);
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      if (buf.includes(needle)) return;
    }
  } finally {
    clearTimeout(timer);
    reader.releaseLock();
  }
  throw new Error(
    timedOut
      ? `timed out waiting for "${needle}"`
      : `stream ended before "${needle}"\n--- output ---\n${buf}`,
  );
}

// The phase gate, automated: `opentide serve --project <x>` runs the full REST
// core headless (no UI, no API key) and answers a REST endpoint. --port steps the
// server onto a free port so this never collides with a running kernel.
Deno.test("opentide serve --project boots the headless REST core (no key)", async () => {
  const port = freePort();
  const parent = await Deno.makeTempDir({ prefix: "opentide-serve-" });
  const project = createProject(parent, "serve smoke");

  const env: Record<string, string> = {
    ...Deno.env.toObject(),
    // Local single-user headless mode: resolve REST requests to the dev account
    // (no browser login flow). This is request auth, orthogonal to the LLM key.
    OPENTIDE_DEV_ACCOUNT_AUTH: "1",
  };
  // Prove "no API key" (the LLM provider key) is not required to serve headless.
  delete env.ANTHROPIC_API_KEY;

  const child = new Deno.Command("deno", {
    args: [
      "task",
      "opentide",
      "serve",
      "--project",
      project.path,
      "--port",
      String(port),
    ],
    cwd: REPO_ROOT,
    env,
    clearEnv: true,
    stdout: "piped",
    stderr: "piped",
  }).spawn();

  try {
    await waitForLine(child.stdout, `listening on :${port}`, 90_000);

    const res = await fetch(`http://127.0.0.1:${port}/api/status`);
    assertEquals(res.status, 200);
    const body = await res.json();
    assert(
      typeof body.routes === "number",
      "status should report a route count",
    );
  } finally {
    child.kill("SIGTERM");
    await child.status;
    await child.stdout.cancel().catch(() => {});
    await child.stderr.cancel().catch(() => {});
    removeProject(project.path);
    await Deno.remove(parent, { recursive: true }).catch(() => {});
  }
});

// The environment without INIT_CWD. `deno task test` sets it to the repo root,
// and a spawned `deno task` keeps an inherited one, so the child would look for
// a project there instead of in its cwd.
function envWithoutInitCwd(): Record<string, string> {
  const { INIT_CWD: _inherited, ...env } = Deno.env.toObject();
  return env;
}

Deno.test("opentide mcp --http outside a project names the directory, exit 2", async () => {
  const dir = await Deno.makeTempDir({ prefix: "opentide-mcp-noproject-" });
  try {
    const { code, stdout, stderr } = await new Deno.Command("deno", {
      args: [
        "task",
        "--config",
        `${REPO_ROOT}/deno.json`,
        "opentide",
        "mcp",
        "--http",
      ],
      cwd: dir,
      env: envWithoutInitCwd(),
      clearEnv: true,
      stdout: "piped",
      stderr: "piped",
    }).output();
    const err = new TextDecoder().decode(stderr);
    assertEquals(code, 2);
    assertEquals(new TextDecoder().decode(stdout), "");
    assertStringIncludes(
      err,
      `${await Deno.realPath(dir)} is not an OpenTide project`,
    );
    assertStringIncludes(err, "--project");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("opentide mcp on stdio outside a project connects with only the app tools", async () => {
  const dir = await Deno.makeTempDir({ prefix: "opentide-mcp-noproject-" });
  try {
    const child = new Deno.Command("deno", {
      args: ["task", "--config", `${REPO_ROOT}/deno.json`, "opentide", "mcp"],
      cwd: dir,
      env: envWithoutInitCwd(),
      clearEnv: true,
      stdin: "piped",
      stdout: "piped",
      stderr: "piped",
    }).spawn();
    const messages = [
      {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "cli-test", version: "0" },
        },
      },
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
    ];
    const writer = child.stdin.getWriter();
    await writer.write(
      new TextEncoder().encode(
        messages.map((m) => JSON.stringify(m)).join("\n") + "\n",
      ),
    );
    // Read until both responses are in, then hang up like a client would.
    const responses = new Map<number, Record<string, unknown>>();
    const decoder = new TextDecoder();
    let buffered = "";
    for await (const chunk of child.stdout) {
      buffered += decoder.decode(chunk, { stream: true });
      const lines = buffered.split("\n");
      buffered = lines.pop() ?? "";
      for (const line of lines.filter((l) => l.trim())) {
        const msg = JSON.parse(line);
        responses.set(msg.id, msg.result);
      }
      if (responses.has(1) && responses.has(2)) break;
    }
    await writer.close();
    const { code } = await child.status;
    await child.stderr.cancel().catch(() => {});

    const init = responses.get(1) as { instructions: string };
    assertStringIncludes(
      init.instructions,
      `${await Deno.realPath(dir)} is not an OpenTide app`,
    );
    assertStringIncludes(init.instructions, "new_project");
    const { tools } = responses.get(2) as { tools: Array<{ name: string }> };
    assertEquals(tools.map((t) => t.name), [
      "list_projects",
      "open_project",
      "new_project",
    ]);
    assertEquals(code, 0);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
