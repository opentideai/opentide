import { assertEquals } from "@std/assert";

// Stage 9 acceptance gate (docs/framework-free-handler-abi-plan.md; D5 amendment
// 2026-09 in docs/opentide-separation-plan.md §1.1). The decision record states an
// enforceable rule — "no kernel, verification, or export code may read or branch on
// which web framework an app's handlers use" — and calls it testable by grep. This
// is that grep, so the rule is a gate rather than a sentence someone wrote once.
//
// It fails on reintroduction of the adapter vocabulary the amendment deleted. That
// is the realistic regression: not someone typing `if (framework === "hono")`, but
// someone growing a field to hang it off, exactly as `FrameworkRegistry` /
// `FrameworkAdapter` / `frameworkId` were specced in 2026-07 and never built.
const FORBIDDEN = [
  "FrameworkAdapter",
  "FrameworkRegistry",
  "frameworkId",
  "framework_id",
];

const SCANNED_ROOTS = [
  "core",
  "verification",
  "cli",
  "mcp",
  "agent",
  "agent-loop",
  "providers",
  "shared",
];

// core/codebase/ is a deliberate carve-out, not an oversight. It models *imported,
// source-backed* projects, where "this repo uses Hono" is a fact about someone
// else's code that the semantics plugins exist to discover (`frameworkHints`,
// `hono-plugin.ts`). That is the opposite direction from the rule: the rule forbids
// the kernel imposing or branching on a framework for the handlers *it* owns. If a
// framework id is ever genuinely needed for an imported repo it belongs here.
const EXEMPT_PREFIXES = ["core/codebase/"];

// Blank block and line comments so prose — this file's, or a call site's comment
// explaining the rule — never counts as a violation.
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, "");
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

async function collectShippedTsFiles(
  dir: string,
  out: string[],
): Promise<void> {
  // A closed layer folder is absent from the open repository; skip it.
  if (!(await folderExists(dir))) return;
  for await (const entry of Deno.readDir(dir)) {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory) {
      await collectShippedTsFiles(path, out);
    } else if (
      entry.isFile && entry.name.endsWith(".ts") &&
      !entry.name.endsWith("_test.ts")
    ) {
      // The gate is over what ships; tests may legitimately name the dead concepts.
      out.push(path);
    }
  }
}

Deno.test("no shipped module carries a web-framework identifier for app handlers", async () => {
  const files: string[] = [];
  for (const root of SCANNED_ROOTS) {
    await collectShippedTsFiles(root, files);
  }
  const scanned = files.filter((f) =>
    !EXEMPT_PREFIXES.some((prefix) => f.startsWith(prefix))
  );

  // If the walk ever silently finds nothing, the gate is vacuous. Assert it ran.
  assertEquals(
    scanned.length > 200,
    true,
    `only scanned ${scanned.length} files`,
  );

  const offenders: string[] = [];
  for (const file of scanned) {
    const source = stripComments(await Deno.readTextFile(file));
    for (const name of FORBIDDEN) {
      if (source.includes(name)) offenders.push(`${file}: ${name}`);
    }
  }

  assertEquals(
    offenders,
    [],
    `The user-app handler ABI is framework-free (D5 amendment 2026-09). What ` +
      `libraries an app uses is per-project metadata in kernel.packages, not a ` +
      `kernel contract:\n${offenders.join("\n")}`,
  );
});
