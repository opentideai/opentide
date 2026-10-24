// The open-standalone gate: proves OpenTide works with every closed folder
// physically absent, rather than trusting the layer rule (which exempts tests and
// composition roots). It copies the open set — and nothing else — into a temp
// directory, then fails on any of:
//   1. an import that resolves outside the copy (agent/, tide/, auth/, ide/,
//      desktop/, or any file not in the open set), tests and roots included;
//   2. `deno check` over the copy;
//   3. the open tests, run inside the copy (skipped with --quick);
//   4. `opentide serve` not coming up on a freshly scaffolded project;
//   5. `opentide mcp --standalone` not answering initialize + tools/list over
//      stdio, or advertising a verb only the closed agent can serve;
//   6. `opentide mcp` (the bridge) not reaching a running serve, or listing a
//      different surface through it than the standalone server does.
//
//   deno task check:open            full gate (tests take several minutes)
//   deno task check:open --quick    scan + typecheck + boots only
//   deno task check:open --keep     leave the temp copy behind for inspection
import { cpSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join, normalize, relative } from "node:path";

// The open set: what the public OpenTide repository contains. The export mirror
// (Phase 4) copies the same list.
export const OPEN_FOLDERS: readonly string[] = [
  "shared",
  "core",
  "verification",
  "mcp",
  "lsp",
  "cli",
  "agent-loop",
  "providers",
];

export const OPEN_FILES: readonly string[] = [
  "LICENSE",
  "NOTICE",
  // The runtime version install.sh downloads, and CI runs on.
  ".deno-version",
  "install.sh",
  "deno.json",
  "deno.lock",
  // Generators whose output is checked in under core/; the export tests rerun
  // them to prove the checked-in output is current.
  "scripts/generate-export-context-shim.ts",
  "scripts/generate-export-router.ts",
  "scripts/generate-export-validation.ts",
  // The open set's own definition, which the release packager reads. Its test
  // stays behind: its fixtures import closed paths on purpose.
  "scripts/check-open-standalone.ts",
  "scripts/export-opentide.ts",
  "scripts/export-opentide_test.ts",
  "scripts/package-opentide.ts",
  "scripts/package-opentide_test.ts",
  "scripts/install-smoke.ts",
  "scripts/claude-plugin.ts",
  "scripts/claude-plugin_test.ts",
  "scripts/claude-desktop-extension.ts",
  "scripts/claude-desktop-extension_test.ts",
  // `deno task db:generate` reads it.
  "drizzle.config.ts",
  // The one backend test that lives outside a layer folder. Everything else in
  // tests/ exercises ide/ code (approval-flow_full_app_test drives the built IDE)
  // and ships with the IDE.
  "tests/layer-subsets_test.ts",
];

// The Claude Code plugin, its marketplace file and the Claude Desktop extension's
// sources. Here they live under mirror/, which the export copies over the public
// root; the copy puts them at its root, where the public repo has them.
export const CLIENT_PACKAGE_PATHS: readonly string[] = [
  ".claude-plugin",
  "plugins",
  "claude-desktop",
];

// Verbs only the closed agent can serve. The open MCP surface must not list them.
const CLOSED_ONLY_VERBS: readonly string[] = ["refute_claims"];

const DENO_RUN_FLAGS = [
  "--allow-net",
  "--allow-read",
  "--allow-write",
  "--allow-env",
  "--allow-ffi",
  "--allow-run",
  "--allow-sys",
];

const BOOT_TIMEOUT_MS = 90_000;
const BOOT_POLL_MS = 500;
const LIVENESS_PATH = "/api/config/kernel";
const SCAFFOLD_NAME = "Open Standalone Check";

const REPO_ROOT = normalize(
  join(dirname(new URL(import.meta.url).pathname), ".."),
);

// Static and dynamic import specifiers, plus `export … from`. Only relative
// specifiers can reach a sibling folder; bare ones go through the import map.
const IMPORT_RE =
  /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)["'](\.{1,2}\/[^"']+)["']/g;

interface Failure {
  step: string;
  detail: string;
}

function copyOpenSet(dest: string): void {
  for (const folder of OPEN_FOLDERS) {
    cpSync(join(REPO_ROOT, folder), join(dest, folder), { recursive: true });
  }
  for (const file of OPEN_FILES) {
    const target = join(dest, file);
    mkdirSync(dirname(target), { recursive: true });
    cpSync(join(REPO_ROOT, file), target);
  }
  const mirror = join(REPO_ROOT, "mirror");
  const overlay = existsSync(join(mirror, "plugins")) ? mirror : REPO_ROOT;
  for (const path of CLIENT_PACKAGE_PATHS) {
    cpSync(join(overlay, path), join(dest, path), { recursive: true });
  }
}

function* walkTs(dir: string): Generator<string> {
  for (const entry of Deno.readDirSync(dir)) {
    const path = join(dir, entry.name);
    if (entry.isDirectory) yield* walkTs(path);
    else if (entry.isFile && entry.name.endsWith(".ts")) yield path;
  }
}

function copiedTsFiles(root: string): string[] {
  const roots = [
    ...OPEN_FOLDERS.map((f) => join(root, f)),
    ...OPEN_FILES.filter((f) => f.endsWith(".ts")).map((f) => join(root, f)),
  ];
  return roots.flatMap((p) =>
    Deno.statSync(p).isDirectory ? [...walkTs(p)] : [p]
  );
}

// The closed folders, which never ship open.
const CLOSED_FOLDERS: ReadonlySet<string> = new Set([
  "agent",
  "tide",
  "auth",
  "ide",
  "desktop",
]);

// True when a relative specifier in `file` reaches a closed folder or out of the
// copy altogether. A missing file elsewhere in the open set is deno check's to
// report; this catches what it cannot see — dynamic imports, and closed folders
// that happen to exist beside the copy.
function reachesClosed(root: string, file: string, specifier: string): boolean {
  const target = relative(root, normalize(join(dirname(file), specifier)));
  const top = target.split(/[\\/]/)[0] ?? "";
  return top === ".." || CLOSED_FOLDERS.has(top);
}

// Every import-shaped relative specifier under `root` that reaches a closed
// folder. Template literals (code generators, test fixtures) never match: a
// `${…}` specifier is not a module path, and the closed-folder test drops the
// rest of their noise.
export function scanImports(
  root: string,
  files = copiedTsFiles(root),
): Failure[] {
  const failures: Failure[] = [];
  for (const file of files) {
    const source = Deno.readTextFileSync(file);
    for (const [, specifier] of source.matchAll(IMPORT_RE)) {
      if (!specifier || specifier.includes("${")) continue;
      if (!reachesClosed(root, file, specifier)) continue;
      failures.push({
        step: "imports",
        detail: `${relative(root, file)} imports ${specifier}, which is closed`,
      });
    }
  }
  return failures;
}

// The environment for the boot steps: a throwaway HOME so scaffolding and
// loading a project never touch the real ~/.config, with DENO_DIR pinned to the
// real cache so the children do not re-download every dependency.
async function isolatedEnv(root: string): Promise<Record<string, string>> {
  const info = await new Deno.Command(Deno.execPath(), {
    args: ["info", "--json"],
    stdout: "piped",
    stderr: "null",
  }).output();
  const { denoDir } = JSON.parse(new TextDecoder().decode(info.stdout)) as {
    denoDir: string;
  };
  const home = join(root, "home");
  mkdirSync(home, { recursive: true });
  return { NO_COLOR: "1", HOME: home, DENO_DIR: denoDir };
}

async function run(
  args: string[],
  cwd: string,
  opts: { logPath?: string; env?: Record<string, string> } = {},
): Promise<{ ok: boolean; output: string }> {
  const out = await new Deno.Command(Deno.execPath(), {
    args,
    cwd,
    stdout: "piped",
    stderr: "piped",
    env: opts.env ?? { NO_COLOR: "1" },
  }).output();
  const decoder = new TextDecoder();
  const output = decoder.decode(out.stdout) + decoder.decode(out.stderr);
  if (opts.logPath) await Deno.writeTextFile(opts.logPath, output);
  return { ok: out.success, output };
}

function tail(output: string, lines = 25): string {
  return output.trimEnd().split("\n").slice(-lines).join("\n");
}

async function typecheck(root: string): Promise<Failure[]> {
  const targets = [
    ...OPEN_FOLDERS.map((f) => `${f}/`),
    ...OPEN_FILES.filter((f) => f.endsWith(".ts")),
  ];
  const { ok, output } = await run(["check", ...targets], root);
  return ok ? [] : [{ step: "deno check", detail: tail(output) }];
}

async function openTests(root: string): Promise<Failure[]> {
  const logPath = join(root, "open-tests.log");
  const targets = [
    ...OPEN_FOLDERS.map((f) => `${f}/`),
    ...OPEN_FILES.filter((f) => f.endsWith("_test.ts")),
  ];
  const { ok, output } = await run(
    ["test", ...DENO_RUN_FLAGS, ...targets],
    root,
    { logPath },
  );
  // deno test lists every failed test after its FAILURES banner; that block,
  // not the tail of the typecheck chatter, is what a reader needs.
  const failures = output.slice(output.lastIndexOf(" FAILURES "));
  return ok ? [] : [{
    step: "open tests",
    detail: `full log: ${logPath}\n${tail(failures, 40)}`,
  }];
}

function freePort(): number {
  const listener = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  const { port } = listener.addr as Deno.NetAddr;
  listener.close();
  return port;
}

async function scaffold(
  root: string,
  parent: string,
  env: Record<string, string>,
): Promise<string> {
  const { ok, output } = await run(
    ["run", ...DENO_RUN_FLAGS, "cli/cli.ts", "scaffold", parent, SCAFFOLD_NAME],
    root,
    { env },
  );
  const match = output.match(/ at (.+)$/m);
  if (!ok || !match?.[1]) throw new Error(`scaffold failed:\n${tail(output)}`);
  return match[1].trim();
}

function spawnCli(
  root: string,
  args: string[],
  stdin: "piped" | "null",
  env: Record<string, string>,
) {
  return new Deno.Command(Deno.execPath(), {
    args: ["run", ...DENO_RUN_FLAGS, "cli/cli.ts", ...args],
    cwd: root,
    stdin,
    stdout: "piped",
    stderr: "piped",
    env,
  }).spawn();
}

async function collect(stream: ReadableStream<Uint8Array>): Promise<string> {
  return await new Response(stream).text();
}

async function waitForLiveness(port: number): Promise<boolean> {
  const deadline = Date.now() + BOOT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}${LIVENESS_PATH}`);
      await res.body?.cancel();
      if (res.ok) return true;
    } catch {
      // Not listening yet; poll again.
    }
    await new Promise((r) => setTimeout(r, BOOT_POLL_MS));
  }
  return false;
}

async function bootServe(
  root: string,
  project: string,
  env: Record<string, string>,
): Promise<Failure[]> {
  const port = freePort();
  const child = spawnCli(
    root,
    ["serve", "--project", project, "--port", String(port)],
    "null",
    env,
  );
  const stdout = collect(child.stdout);
  const stderr = collect(child.stderr);
  const live = await waitForLiveness(port);
  child.kill("SIGTERM");
  const status = await child.status;
  const output = `${await stdout}${await stderr}`;
  if (!live) {
    return [{
      step: "opentide serve",
      detail: `no answer on ${LIVENESS_PATH} within ${BOOT_TIMEOUT_MS}ms\n${
        tail(output)
      }`,
    }];
  }
  return status.success ? [] : [{
    step: "opentide serve",
    detail: `did not shut down cleanly (code ${status.code})\n${tail(output)}`,
  }];
}

// Newline-delimited JSON-RPC over the child's stdio: the transport the MCP SDK's
// stdio server speaks. Returns the response carrying `id`.
async function rpc(
  writer: WritableStreamDefaultWriter<Uint8Array>,
  lines: AsyncIterator<string>,
  message: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  await writer.write(new TextEncoder().encode(`${JSON.stringify(message)}\n`));
  if (!("id" in message)) return {};
  while (true) {
    const next = await lines.next();
    if (next.done) throw new Error("MCP server closed stdout before answering");
    if (!next.value.trim()) continue;
    const parsed = JSON.parse(next.value) as Record<string, unknown>;
    if (parsed.id === message.id) return parsed;
  }
}

async function* splitLines(
  stream: ReadableStream<Uint8Array>,
): AsyncGenerator<string> {
  let buffer = "";
  for await (const chunk of stream.pipeThrough(new TextDecoderStream())) {
    buffer += chunk;
    let index = buffer.indexOf("\n");
    while (index !== -1) {
      yield buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      index = buffer.indexOf("\n");
    }
  }
}

async function listOpenMcpTools(
  root: string,
  args: string[],
  env: Record<string, string>,
): Promise<string[]> {
  const child = spawnCli(root, ["mcp", ...args], "piped", env);
  const stderr = collect(child.stderr);
  const writer = child.stdin.getWriter();
  const lines = splitLines(child.stdout)[Symbol.asyncIterator]();
  try {
    const init = await rpc(writer, lines, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "check-open-standalone", version: "0.0.0" },
      },
    });
    if (!init.result) {
      throw new Error(`initialize failed: ${JSON.stringify(init)}`);
    }
    await rpc(writer, lines, {
      jsonrpc: "2.0",
      method: "notifications/initialized",
    });
    const list = await rpc(writer, lines, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
    });
    const tools = (list.result as { tools?: Array<{ name: string }> })?.tools;
    if (!tools) throw new Error(`tools/list failed: ${JSON.stringify(list)}`);
    return tools.map((t) => t.name);
  } catch (err) {
    child.kill("SIGTERM");
    await child.status;
    throw new Error(`${(err as Error).message}\n${tail(await stderr)}`);
  } finally {
    // Closing stdin is the client disconnecting: the server unloads and exits.
    // Wait for it, so the project lock is free for whatever runs next.
    await writer.close().catch(() => {});
    await lines.return?.(undefined);
    await child.status;
  }
}

async function bootMcp(
  root: string,
  project: string,
  env: Record<string, string>,
  listed: string[],
): Promise<Failure[]> {
  try {
    const names = await listOpenMcpTools(
      root,
      ["--project", project, "--standalone"],
      env,
    );
    listed.push(...names);
    const leaked = CLOSED_ONLY_VERBS.filter((v) => names.includes(v));
    if (names.length === 0) {
      return [{ step: "opentide mcp", detail: "tools/list returned no tools" }];
    }
    return leaked.length === 0 ? [] : [{
      step: "opentide mcp",
      detail: `advertises closed-only verbs: ${leaked.join(", ")}`,
    }];
  } catch (err) {
    return [{ step: "opentide mcp", detail: (err as Error).message }];
  }
}

// The bridge must reach the serve process that holds the project and show the
// same surface the standalone server does. Serve is started here, so the bridge
// attaches rather than spawning one that would outlive the check.
async function bridgeMcp(
  root: string,
  project: string,
  env: Record<string, string>,
  standalone: readonly string[],
): Promise<Failure[]> {
  const port = freePort();
  const serve = spawnCli(
    root,
    ["serve", "--project", project, "--port", String(port)],
    "null",
    env,
  );
  const serveOutput = collect(serve.stdout);
  const serveErrors = collect(serve.stderr);
  try {
    if (!await waitForLiveness(port)) {
      return [{ step: "opentide mcp bridge", detail: "serve never came up" }];
    }
    const names = await listOpenMcpTools(root, ["--project", project], env);
    const missing = standalone.filter((n) => !names.includes(n));
    const extra = names.filter((n) => !standalone.includes(n));
    return missing.length + extra.length === 0 ? [] : [{
      step: "opentide mcp bridge",
      detail: `surface differs from standalone: missing [${
        missing.join(", ")
      }], extra [${extra.join(", ")}]`,
    }];
  } catch (err) {
    return [{ step: "opentide mcp bridge", detail: (err as Error).message }];
  } finally {
    try {
      serve.kill("SIGTERM");
    } catch {
      // Already gone; its output below says why.
    }
    await serve.status;
    const output = `${await serveOutput}${await serveErrors}`;
    if (Deno.env.get("CHECK_OPEN_DEBUG")) console.error(tail(output, 60));
  }
}

async function main(): Promise<void> {
  const quick = Deno.args.includes("--quick");
  const keep = Deno.args.includes("--keep");
  const root = await Deno.makeTempDir({ prefix: "opentide-standalone-" });
  const failures: Failure[] = [];
  const step = async (
    name: string,
    fn: () => Promise<Failure[]> | Failure[],
  ) => {
    console.log(`… ${name}`);
    const found = await fn();
    failures.push(...found);
    console.log(found.length === 0 ? `  ok` : `  FAILED (${found.length})`);
  };

  try {
    copyOpenSet(root);
    console.log(`Open set copied to ${root}`);
    await step("imports stay inside the open set", () => scanImports(root));
    await step("deno check", () => typecheck(root));
    if (!quick) await step("open tests", () => openTests(root));
    const env = await isolatedEnv(root);
    const project = await scaffold(root, join(root, "projects"), env);
    await step("opentide serve boots", () => bootServe(root, project, env));
    const listed: string[] = [];
    await step(
      "opentide mcp --standalone lists tools",
      () => bootMcp(root, project, env, listed),
    );
    await step(
      "opentide mcp bridges to serve",
      () => bridgeMcp(root, project, env, listed),
    );
  } catch (err) {
    failures.push({ step: "harness", detail: (err as Error).message });
  }

  for (const f of failures) console.error(`\n✗ ${f.step}\n${f.detail}`);
  if (keep || failures.length > 0) console.log(`\nCopy kept at ${root}`);
  else await Deno.remove(root, { recursive: true });
  if (failures.length > 0) {
    console.error(
      `\nOpen set does NOT stand alone (${failures.length} failure(s)).`,
    );
    Deno.exit(1);
  }
  console.log("\nOpen set stands alone.");
}

if (import.meta.main) await main();
