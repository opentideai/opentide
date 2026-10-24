// The install smoke: the path a new user takes, end to end, from this commit.
//
//   deno task smoke:install
//
// 1. Package the tree at HEAD and run install.sh on it under a throwaway HOME,
//    with a `deno` first on PATH that fails if anything calls it: OpenTide
//    must run on the runtime it installs, never on one it finds.
// 2. `opentide scaffold` a project.
// 3. Over the MCP bridge (which starts `opentide serve`): open a changeset,
//    install an npm package, define a handler, a route and a test, and run the
//    tests.
// 4. Stop the server, `opentide export` (Node), `npm install`, start it with
//    node and request the route.
//
// Needs network, git with a user.name, and Node 24+ with npm. Exits 1 on the
// first failure.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { dirname, join, normalize } from "node:path";
import { OPENTIDE_VERSION } from "../core/config.ts";
import { isProjectLockHeld, readLockHolder } from "../core/project-lock.ts";
import { packageOpenTide, tarballName } from "./package-opentide.ts";

const REPO_ROOT = normalize(
  join(dirname(new URL(import.meta.url).pathname), ".."),
);
const PROJECT_NAME = "Smoke App";
const PROJECT_SLUG = "smoke-app";
const EXPORT_PORT = 38_417;
const EXPORT_BOOT_TIMEOUT_MS = 60_000;
const SERVE_EXIT_TIMEOUT_MS = 30_000;
const POLL_MS = 500;

const PLAN = {
  summary: "Add GET /api/hello returning a slugified greeting.",
  steps: ["Install slugify", "Define the handler and route", "Test it"],
  acceptanceCriteria: [{
    id: "c1",
    text: "GET /api/hello returns hello-world",
    priority: "should",
  }],
  verificationPlan: [{
    id: "v1",
    description: "run_tests",
    kind: "unit",
    claimIds: ["c1"],
  }],
};

const HANDLER = `function hello(c: { json: (v: unknown) => Response }) {
  const slugify = (packages.slugify as { default: (s: string) => string }).default;
  return c.json({ msg: slugify("hello world") });
}`;

const TEST = `async function test_hello() {
  const r = await fetch(appUrl("/api/hello"));
  assertEquals(r.status, 200);
  assertEquals((await r.json()).msg, "hello-world");
}`;

function step(message: string): void {
  console.log(`… ${message}`);
}

function fail(message: string): never {
  console.error(`\n✗ ${message}`);
  Deno.exit(1);
}

// Runs a command and returns its stdout. stderr is kept for the failure
// message only: a first run prints dependency downloads there.
async function run(
  command: string,
  args: string[],
  env: Record<string, string>,
  cwd?: string,
): Promise<string> {
  const out = await new Deno.Command(command, {
    args,
    env,
    cwd,
    stdout: "piped",
    stderr: "piped",
  }).output();
  const stdout = new TextDecoder().decode(out.stdout);
  if (!out.success) {
    fail(
      `${command} ${args.join(" ")}\n${stdout}${
        new TextDecoder().decode(out.stderr)
      }`,
    );
  }
  return stdout;
}

function denoDir(): string {
  const out = new Deno.Command(Deno.execPath(), {
    args: ["info", "--json"],
    stdout: "piped",
    stderr: "null",
  }).outputSync();
  return (JSON.parse(new TextDecoder().decode(out.stdout)) as {
    denoDir: string;
  }).denoDir;
}

// One MCP tool call; fails the smoke on a tool error.
async function call(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<string> {
  const result = await client.callTool({ name, arguments: args });
  const content = result.content as Array<{ type: string; text?: string }>;
  const text = content.map((c) => c.text ?? "").join("\n");
  if (result.isError) fail(`${name}: ${text}`);
  return text;
}

async function driveChangeset(
  launcher: string,
  project: string,
  env: Record<string, string>,
): Promise<void> {
  const transport = new StdioClientTransport({
    command: launcher,
    args: ["mcp", "--project", project],
    env,
    stderr: "ignore",
  });
  const client = new Client({ name: "install-smoke", version: "0" });
  await client.connect(transport);
  try {
    const { tools } = await client.listTools();
    step(`bridge up, ${tools.length} tools`);
    await call(client, "create_changeset", { title: "Hello", plan: PLAN });
    await call(client, "install_package", { name: "slugify" });
    await call(client, "define_handler", {
      name: "hello",
      module: "hello",
      purpose: "Greets.",
      source: HANDLER,
    });
    await call(client, "register_route", {
      method: "GET",
      path: "/api/hello",
      handlerName: "hello",
      module: "hello",
    });
    await call(client, "define_test", {
      name: "test_hello",
      module: "hello",
      source: TEST,
    });
    const tests = JSON.parse(await call(client, "run_tests", {})) as {
      passed: number;
      failed: number;
    };
    if (tests.passed !== 1 || tests.failed !== 0) {
      fail(`run_tests: ${JSON.stringify(tests)}`);
    }
    step("changeset built, test passes");
    await call(client, "flush_project_state", {});
  } finally {
    await client.close();
  }
}

// The bridge leaves its serve running; stop it so export can load the project.
async function stopServe(project: string): Promise<void> {
  const holder = readLockHolder(project);
  if (!holder) return;
  Deno.kill(holder.pid, "SIGTERM");
  const deadline = Date.now() + SERVE_EXIT_TIMEOUT_MS;
  while (isProjectLockHeld(project)) {
    if (Date.now() > deadline) fail("opentide serve did not stop");
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

async function requestExportedApp(
  exportDir: string,
  env: Record<string, string>,
): Promise<void> {
  await run("npm", ["install", "--no-audit", "--no-fund"], env, exportDir);
  const app = new Deno.Command("node", {
    args: ["main.js"],
    cwd: exportDir,
    env: { ...env, PORT: String(EXPORT_PORT) },
    stdout: "null",
    stderr: "inherit",
  }).spawn();
  try {
    const deadline = Date.now() + EXPORT_BOOT_TIMEOUT_MS;
    while (Date.now() < deadline) {
      try {
        const res = await fetch(`http://127.0.0.1:${EXPORT_PORT}/api/hello`);
        const body = await res.json() as { msg?: string };
        if (body.msg !== "hello-world") {
          fail(`exported app answered ${JSON.stringify(body)}`);
        }
        return;
      } catch {
        await new Promise((r) => setTimeout(r, POLL_MS));
      }
    }
    fail("the exported app never answered /api/hello");
  } finally {
    app.kill("SIGTERM");
    await app.status;
  }
}

// A directory holding a `deno` that fails loudly, to put first on PATH.
async function denoTrap(root: string): Promise<string> {
  const dir = join(root, "deno-trap");
  await Deno.mkdir(dir);
  const trap = join(dir, "deno");
  await Deno.writeTextFile(
    trap,
    '#!/bin/sh\necho "install-smoke: deno from PATH was used" >&2\nexit 97\n',
  );
  await Deno.chmod(trap, 0o755);
  return dir;
}

async function main(): Promise<void> {
  const root = await Deno.makeTempDir({ prefix: "opentide-smoke-" });
  const home = join(root, "home");
  await Deno.mkdir(home);
  const env: Record<string, string> = {
    HOME: home,
    PATH: `${await denoTrap(root)}:${Deno.env.get("PATH") ?? ""}`,
    DENO_DIR: denoDir(),
    NO_COLOR: "1",
  };
  for (const name of ["GIT_CONFIG_GLOBAL", "TMPDIR"]) {
    const value = Deno.env.get(name);
    if (value) env[name] = value;
  }
  const gitconfig = join(Deno.env.get("HOME") ?? "", ".gitconfig");
  if (!env.GIT_CONFIG_GLOBAL) env.GIT_CONFIG_GLOBAL = gitconfig;

  step("packaging HEAD");
  await packageOpenTide(join(root, "release"));
  step("running install.sh");
  await run("sh", [join(REPO_ROOT, "install.sh")], {
    ...env,
    OPENTIDE_INSTALL_TARBALL: join(root, "release", tarballName()),
  });
  const launcher = join(home, ".opentide", "bin", "opentide");
  const version = (await run(launcher, ["--version"], env)).trim();
  if (version !== `opentide ${OPENTIDE_VERSION}`) {
    fail(`--version printed "${version}"`);
  }
  step(version);

  const apps = join(root, "apps");
  await Deno.mkdir(apps);
  await run(launcher, ["scaffold", apps, PROJECT_NAME], env);
  const project = join(apps, PROJECT_SLUG);
  step(`scaffolded ${project}`);

  await driveChangeset(launcher, project, env);
  await stopServe(project);

  const exportDir = join(root, "export");
  await run(
    launcher,
    ["export", "--project", project, "--out", exportDir],
    env,
  );
  await requestExportedApp(exportDir, env);
  step("exported app serves /api/hello");

  await Deno.remove(root, { recursive: true }).catch(() => {});
  console.log("\nInstall smoke passed.");
}

if (import.meta.main) await main();
