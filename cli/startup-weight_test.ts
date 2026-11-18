// `opentide mcp` is what the Claude Code plugin starts in every session, in
// every folder. Run that way it is only a relay: to the project's serve, or for
// a folder of apps, three tools of its own. So what it imports at startup must
// stay clear of the stack. Loading it anyway costs every session about 85MB and
// half a second. This walks the module graph `deno info` reports and fails if
// one of the heavy packages is in it. Type-only imports don't count. Literal
// `await import("...")` calls do: Deno loads those at startup even if they never
// run. Code that loads later goes through core/import-later.ts.
import { assert, assertEquals } from "@std/assert";
import { relative } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = fileURLToPath(new URL("..", import.meta.url));

// Each is tens of megabytes once loaded, and none is needed to relay.
const HEAVY = [
  "@electric-sql/pglite",
  "drizzle-orm",
  "postgres",
  "esbuild",
  "typescript",
  "playwright",
  "ai",
  "@ai-sdk/anthropic",
  "@ai-sdk/openai",
  "@anthropic-ai/sdk",
  "hono",
];

interface Dependency {
  code?: { specifier?: string };
}
interface Module {
  specifier: string;
  kind?: string;
  npmPackage?: string;
  dependencies?: Dependency[];
}
interface Graph {
  roots: string[];
  modules: Module[];
  redirects?: Record<string, string>;
}

async function moduleGraph(entry: string): Promise<Graph> {
  const out = await new Deno.Command(Deno.execPath(), {
    args: ["info", "--json", entry],
    cwd: REPO,
    stdout: "piped",
    stderr: "piped",
  }).output();
  assert(out.success, new TextDecoder().decode(out.stderr));
  return JSON.parse(new TextDecoder().decode(out.stdout));
}

// The local files and npm packages Deno loads for `entry` at startup, each with
// the chain of imports that reached it.
async function startupImports(entry: string): Promise<{
  files: Set<string>;
  packages: Map<string, string[]>;
}> {
  const graph = await moduleGraph(entry);
  const byName = new Map(graph.modules.map((m) => [m.specifier, m]));
  const redirects = graph.redirects ?? {};
  const follow = (s: string) => {
    for (let to = redirects[s]; to; to = redirects[s]) s = to;
    return s;
  };
  const files = new Set<string>();
  const packages = new Map<string, string[]>();
  const seen = new Set<string>();
  const queue = graph.roots.map((r) => ({
    spec: follow(r),
    via: [] as string[],
  }));
  while (queue.length > 0) {
    const { spec, via } = queue.shift()!;
    if (seen.has(spec)) continue;
    seen.add(spec);
    const mod = byName.get(spec);
    if (!mod) continue;
    if (mod.kind === "npm" && mod.npmPackage) {
      // "name@version_peers"; a scoped name starts with @ of its own.
      const name = mod.npmPackage.match(/^@?[^@]+/)![0];
      if (!packages.has(name)) packages.set(name, via);
      continue;
    }
    const here = spec.startsWith("file:")
      ? relative(REPO, fileURLToPath(spec))
      : spec;
    if (spec.startsWith("file:")) files.add(here);
    for (const dep of mod.dependencies ?? []) {
      const next = dep.code?.specifier;
      if (next) queue.push({ spec: follow(next), via: [...via, here] });
    }
  }
  return { files, packages };
}

function heavyReached(packages: Map<string, string[]>): string[] {
  return HEAVY.filter((name) => packages.has(name)).map((name) =>
    `${name}, via ${packages.get(name)!.join(" → ")}`
  );
}

Deno.test("the opentide entry point loads nothing but the command it runs", async () => {
  const { files, packages } = await startupImports("cli/cli.ts");
  assertEquals(heavyReached(packages), []);
  assert(!files.has("cli/cli-run.ts"), "cli.ts imports cli-run.ts statically");
  assert(
    !files.has("cli/mcp-main.ts"),
    "cli.ts imports mcp-main.ts statically",
  );
});

Deno.test("opentide mcp starts without the database, compiler or model SDKs", async () => {
  const { packages } = await startupImports("cli/mcp-main.ts");
  assertEquals(heavyReached(packages), []);
});
