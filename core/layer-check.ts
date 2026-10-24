// Layer-import rule (OpenTide §3.2). Scans the backend layer folders (core/
// verification/ mcp/ cli/ agent/ desktop/) for upward imports and fails on any
// that are not on the baseline in ./layers.ts. Paths are repo-relative, so a
// module's first path segment is its folder (= its layer). Kept dependency-light
// (it imports only the manifest) so the standalone `deno task lint:layers` runner
// can scan the source tree without loading the kernel's runtime graph.
import {
  BASELINE_UPWARD_IMPORTS,
  isBaselined,
  isUpwardImport,
  LAYER_ROOTS,
  layerOf,
} from "./layers.ts";

export interface LayerIssue {
  level: "error" | "warning" | "info";
  rule: string;
  message: string;
}

export interface LayerCheckResult {
  passed: boolean;
  issues: LayerIssue[];
  summary: string;
}

// A single intra-kernel import edge, kernel-relative POSIX paths.
export interface ImportEdge {
  from: string;
  to: string;
}

// Matches the specifier of `import ... from "x"` / `export ... from "x"`.
const STATIC_IMPORT_RE = /\bfrom\s*["']([^"']+)["']/g;
// Matches dynamic `import("x")`, including type-position `import("x").Foo`.
const DYNAMIC_IMPORT_RE = /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g;
// Matches bare side-effect imports `import "x";` (no clause, no `from`).
const BARE_IMPORT_RE = /\bimport\s+["']([^"']+)["']/g;

// Blank out block and line comments so commented-out imports don't count.
// Deliberately simple: it can also blank a `//` sequence inside a string, but
// that can never turn a non-import into an import (the worst case is missing a
// contrived import written after a same-line string containing `//`), which
// does not occur in this codebase.
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, "");
}

function isRelativeSpecifier(spec: string): boolean {
  return spec.startsWith("./") || spec.startsWith("../");
}

function dirOf(kernelRelativePath: string): string {
  const idx = kernelRelativePath.lastIndexOf("/");
  return idx === -1 ? "" : kernelRelativePath.slice(0, idx);
}

// Resolve a relative specifier against the importing file's kernel-relative
// directory, normalizing "." and ".." segments. May lack a ".ts" extension.
function resolveKernelRelative(fromDir: string, spec: string): string {
  const stack = fromDir ? fromDir.split("/") : [];
  for (const seg of spec.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") stack.pop();
    else stack.push(seg);
  }
  return stack.join("/");
}

// Map a resolved base path to an actual kernel module, honoring explicit ".ts",
// extensionless files, and directory-index resolution. Returns null when the
// target is not a known kernel .ts module (e.g. an npm/jsr dep or an asset).
function matchKnownModule(
  base: string,
  known: ReadonlySet<string>,
): string | null {
  if (known.has(base)) return base;
  if (known.has(`${base}.ts`)) return `${base}.ts`;
  if (known.has(`${base}/index.ts`)) return `${base}/index.ts`;
  return null;
}

// Extract the deduplicated intra-kernel import edges from one file's source.
export function extractKernelImports(
  fromPath: string,
  source: string,
  known: ReadonlySet<string>,
): ImportEdge[] {
  const stripped = stripComments(source);
  const fromDir = dirOf(fromPath);
  const targets = new Set<string>();

  for (const re of [STATIC_IMPORT_RE, DYNAMIC_IMPORT_RE, BARE_IMPORT_RE]) {
    re.lastIndex = 0;
    for (let m = re.exec(stripped); m; m = re.exec(stripped)) {
      const spec = m[1]!;
      if (!isRelativeSpecifier(spec)) continue;
      const target = matchKnownModule(
        resolveKernelRelative(fromDir, spec),
        known,
      );
      if (target && target !== fromPath) targets.add(target);
    }
  }

  return [...targets].map((to) => ({ from: fromPath, to }));
}

// False only when `dir` does not exist — any other stat failure still throws.
async function folderExists(dir: string): Promise<boolean> {
  try {
    await Deno.stat(dir);
    return true;
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return false;
    throw err;
  }
}

// Recursively collect repo-relative paths of every .ts file under `dir` (which is
// itself repo-relative, e.g. "core"), so paths keep their layer-folder prefix.
async function collectTsFiles(dir: string, out: string[]): Promise<void> {
  // A closed layer folder is absent from the open repository; skip it.
  if (!(await folderExists(dir))) return;
  for await (const entry of Deno.readDir(dir)) {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory) {
      await collectTsFiles(path, out);
    } else if (entry.isFile && entry.name.endsWith(".ts")) {
      out.push(path);
    }
  }
}

// Scan the layer-folder `roots` (repo-relative; defaults to the manifest's
// LAYER_ROOTS) for upward imports. Non-baseline upward imports are errors (fail
// the build); baseline edges are info (known Phase-2 debt); a baseline entry that
// no longer resolves is a warning (keeps the baseline shrinking). Test files are
// exempt as import sources — not part of the shipped graph.
export async function checkLayerImports(
  roots: readonly string[] = LAYER_ROOTS,
): Promise<LayerCheckResult> {
  const files: string[] = [];
  for (const root of roots) {
    await collectTsFiles(root.replace(/\/+$/, ""), files);
  }
  const known = new Set(files);

  const issues: LayerIssue[] = [];
  const seenBaseline = new Set<string>();

  for (const file of files) {
    if (file.endsWith("_test.ts")) continue;
    const source = await Deno.readTextFile(file);
    for (const edge of extractKernelImports(file, source, known)) {
      if (!isUpwardImport(edge.from, edge.to)) continue;
      const detail = `${edge.from} (${layerOf(edge.from)}) → ${edge.to} (${
        layerOf(edge.to)
      })`;
      if (isBaselined(edge.from, edge.to)) {
        seenBaseline.add(`${edge.from} ${edge.to}`);
        issues.push({
          level: "info",
          rule: "layer-import-baseline",
          message: `Known upward-import debt: ${detail}`,
        });
      } else {
        issues.push({
          level: "error",
          rule: "layer-import",
          message:
            `Upward import violates the layer rule (§3.2): ${detail}. Depend downward, or add an extension hook (§3.3).`,
        });
      }
    }
  }

  for (const entry of BASELINE_UPWARD_IMPORTS) {
    if (!seenBaseline.has(`${entry.from} ${entry.to}`)) {
      issues.push({
        level: "warning",
        rule: "layer-baseline-stale",
        message:
          `Baseline entry ${entry.from} → ${entry.to} no longer exists — remove it from BASELINE_UPWARD_IMPORTS in layers.ts.`,
      });
    }
  }

  const counts = { error: 0, warning: 0, info: 0 };
  for (const i of issues) counts[i.level]++;
  const parts = [
    `${counts.error} violation${counts.error !== 1 ? "s" : ""}`,
    `${counts.info} baseline`,
  ];
  if (counts.warning) parts.push(`${counts.warning} stale-baseline`);

  return { passed: counts.error === 0, issues, summary: parts.join(", ") };
}

export function formatLayerIssues(issues: LayerIssue[]): string {
  if (issues.length === 0) return "No issues.";
  return issues
    .map((i) => `[${i.level.toUpperCase()}] ${i.rule}: ${i.message}`)
    .join("\n");
}
