// Writes the public OpenTide tree: what github.com/opentideai/opentide holds
// and what the release tarball (scripts/package-opentide.ts) contains.
//
//   deno task export:opentide --out <dir>
//
// The tree is cut from HEAD, so uncommitted edits never leave this repo:
//   - the open set (scripts/check-open-standalone.ts);
//   - the docs in MIRROR_DOCS;
//   - mirror/, copied over the root (README, CI, art, the Claude Code plugin);
//   - deno.json, keeping only the tasks whose files are in the tree.
//
// <dir> must be empty, or a checkout of the public repo: then everything but
// .git is replaced, and committing is left to you.
import { existsSync, readdirSync } from "node:fs";
import { dirname, join, normalize } from "node:path";
import { OPENTIDE_VERSION } from "../core/config.ts";
import {
  CLIENT_PACKAGE_PATHS,
  OPEN_FILES,
  OPEN_FOLDERS,
} from "./check-open-standalone.ts";

const REPO_ROOT = normalize(
  join(dirname(new URL(import.meta.url).pathname), ".."),
);

// Files only the public repo has: its README, .gitignore, CI, art and the Claude
// Code plugin. Copied over the root of the tree.
const OVERLAY_DIR = "mirror";
const OVERLAY_FILES: readonly string[] = [
  "README.md",
  ".gitignore",
  ".github",
  "assets",
  ...CLIENT_PACKAGE_PATHS,
];

// The docs the public repo ships. Everything else in docs/ is internal.
export const MIRROR_DOCS: readonly string[] = [
  "docs/opentide-cli.md",
  "docs/mcp-connect.md",
  "docs/lsp-connect.md",
  "docs/project-storage.md",
];

export interface OpenTree {
  // deno.json tasks dropped because a file they name isn't in the tree.
  droppedTasks: string[];
}

async function run(
  command: string,
  args: string[],
  cwd = REPO_ROOT,
): Promise<string> {
  const out = await new Deno.Command(command, {
    args,
    cwd,
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (!out.success) {
    throw new Error(
      `${command} ${args.join(" ")} failed: ${
        new TextDecoder().decode(out.stderr)
      }`,
    );
  }
  return new TextDecoder().decode(out.stdout);
}

// `git archive <treeish> -- <paths>` unpacked into dest.
async function extractFromHead(
  dest: string,
  treeish: string,
  paths: readonly string[],
): Promise<void> {
  const tar = join(await Deno.makeTempDir({ prefix: "opentide-tree-" }), "t");
  try {
    await run("git", [
      "archive",
      "--format=tar",
      "--output",
      tar,
      treeish,
      ...(paths.length > 0 ? ["--", ...paths] : []),
    ]);
    await run("tar", ["-xf", tar, "-C", dest]);
  } finally {
    await Deno.remove(dirname(tar), { recursive: true });
  }
}

async function existsAtHead(path: string): Promise<boolean> {
  const out = await new Deno.Command("git", {
    args: ["cat-file", "-e", `HEAD:${path}`],
    cwd: REPO_ROOT,
    stdout: "null",
    stderr: "null",
  }).output();
  return out.success;
}

// Tokens in a task that name a file or folder: anything shaped like a path
// (`tide/main.ts`), and a bare name that is one here (`ide` in
// `npm --prefix ide run build`).
function localPaths(task: string): string[] {
  return task.split(/\s+/).filter((t) =>
    !t.startsWith("-") && !t.includes(":") &&
    (t.includes("/") || /\.(ts|js|json)$/.test(t) ||
      existsSync(join(REPO_ROOT, t)))
  );
}

interface DenoJson {
  tasks?: Record<string, string>;
  exclude?: string[];
  [key: string]: unknown;
}

// The public deno.json: tasks and excludes that reach only into the tree.
export function mirrorDenoJson(
  source: DenoJson,
  exists: (path: string) => boolean,
): { json: DenoJson; droppedTasks: string[] } {
  const tasks: Record<string, string> = {};
  const droppedTasks: string[] = [];
  for (const [name, task] of Object.entries(source.tasks ?? {})) {
    if (localPaths(task).every(exists)) tasks[name] = task;
    else droppedTasks.push(name);
  }
  const exclude = (source.exclude ?? []).filter(exists);
  const { exclude: _dropped, ...rest } = source;
  return {
    json: {
      version: OPENTIDE_VERSION,
      license: "Apache-2.0",
      ...rest,
      tasks,
      ...(exclude.length > 0 ? { exclude } : {}),
    },
    droppedTasks,
  };
}

export async function writeOpenTree(dest: string): Promise<OpenTree> {
  await Deno.mkdir(dest, { recursive: true });
  await extractFromHead(dest, "HEAD", [
    ...OPEN_FOLDERS,
    ...OPEN_FILES,
    ...MIRROR_DOCS,
  ]);
  // In this repo the root-only files come from mirror/; in the public repo,
  // which has no mirror/, they are already at the root.
  if (await existsAtHead(OVERLAY_DIR)) {
    await extractFromHead(dest, `HEAD:${OVERLAY_DIR}`, []);
  } else {
    await extractFromHead(dest, "HEAD", OVERLAY_FILES);
  }

  const denoJsonPath = join(dest, "deno.json");
  const source = JSON.parse(await Deno.readTextFile(denoJsonPath)) as DenoJson;
  const { json, droppedTasks } = mirrorDenoJson(
    source,
    (path) => existsSync(join(dest, path)),
  );
  await Deno.writeTextFile(denoJsonPath, JSON.stringify(json, null, 2) + "\n");
  return { droppedTasks };
}

// The working tree of a public-repo checkout, emptied but for .git.
async function clearCheckout(dir: string): Promise<void> {
  if (!existsSync(dir)) return;
  const entries = readdirSync(dir);
  if (entries.length > 0 && !entries.includes(".git")) {
    throw new Error(
      `${dir} is not empty and not a git checkout; refusing to write into it.`,
    );
  }
  for (const entry of entries) {
    if (entry !== ".git") {
      await Deno.remove(join(dir, entry), { recursive: true });
    }
  }
}

export async function warnIfDirty(): Promise<void> {
  const dirty = (await run("git", [
    "status",
    "--porcelain",
    "--",
    ...OPEN_FOLDERS,
    ...OPEN_FILES,
    ...MIRROR_DOCS,
    OVERLAY_DIR,
  ])).trim();
  if (dirty) {
    console.warn(
      `Uncommitted changes are NOT exported (HEAD is):\n${dirty}\n`,
    );
  }
}

function readOut(args: string[]): string {
  const i = args.indexOf("--out");
  const value = i >= 0 ? args[i + 1] : undefined;
  if (!value) {
    console.error("usage: deno task export:opentide --out <dir>");
    Deno.exit(2);
  }
  return value;
}

if (import.meta.main) {
  const out = readOut(Deno.args);
  await warnIfDirty();
  await clearCheckout(out);
  const { droppedTasks } = await writeOpenTree(out);
  const head = (await run("git", ["rev-parse", "--short", "HEAD"])).trim();
  console.log(`Wrote the OpenTide tree from ${head} to ${out}`);
  if (droppedTasks.length > 0) {
    console.log(`deno.json tasks left out: ${droppedTasks.join(", ")}`);
  }
}
