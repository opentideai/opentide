import { assertEquals } from "@std/assert";

// Stage 5/7 acceptance gate (docs/multi-model-harness-plan.md §5): the Anthropic
// SDK is owned in exactly one layer — providers/. No shipped module under core/,
// agent/, or agent-loop/ may import "@anthropic-ai/sdk" (value OR type); they reach
// the model through the neutral seams (core/model-provider.ts, core/utility-model.ts).
// This is the real proof the slices landed — it fails the moment a `new Anthropic()`
// or `import type Anthropic` creeps back into any of those layers. agent-loop joined
// the scanned roots at Stage 7, once its chat loop stopped importing the SDK.

const SDK_SPECIFIER = "@anthropic-ai/sdk";
const SCANNED_ROOTS = ["core", "agent", "agent-loop"];

// Blank block and line comments so a commented-out or documented reference (this
// file's own prose, a call site's explanatory comment) never counts.
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
      // Tests are not part of the shipped import graph (and may legitimately
      // construct SDK types); the gate is over what ships.
      out.push(path);
    }
  }
}

Deno.test("no shipped core/, agent/, or agent-loop/ module imports the Anthropic SDK", async () => {
  const files: string[] = [];
  for (const root of SCANNED_ROOTS) {
    await collectShippedTsFiles(root, files);
  }

  const offenders: string[] = [];
  for (const file of files) {
    const source = stripComments(await Deno.readTextFile(file));
    if (source.includes(SDK_SPECIFIER)) offenders.push(file);
  }

  assertEquals(
    offenders,
    [],
    `These modules must reach the model through core/utility-model.ts or ` +
      `core/model-provider.ts, not the SDK directly:\n${offenders.join("\n")}`,
  );
});
