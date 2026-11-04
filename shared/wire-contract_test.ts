// Enforcement for shared/, the open wire contract: the serialized REST/WS
// response shapes both the Deno backend and the IDE consume. Two invariants:
//
//   1. Type-only — no runtime code, so a bundler erases every import (nothing to
//      resolve at runtime; only type-checking must resolve them).
//   2. Import-free — nothing sits below L0, so a shared module imports NOTHING
//      (not even another shared module). This is stronger than the layer rule
//      (core/layers_test.ts), which only forbids *upward* imports.

import { assert } from "@std/assert";

const SHARED_DIR = new URL("./", import.meta.url);

async function sharedModules(): Promise<Array<{ name: string; src: string }>> {
  const mods: Array<{ name: string; src: string }> = [];
  for await (const entry of Deno.readDir(SHARED_DIR)) {
    if (!entry.isFile || !entry.name.endsWith(".ts")) continue;
    if (entry.name.endsWith("_test.ts")) continue;
    const src = await Deno.readTextFile(new URL(entry.name, SHARED_DIR));
    mods.push({ name: entry.name, src });
  }
  return mods.sort((a, b) => a.name.localeCompare(b.name));
}

// Blank out comments so a `//`-commented example can't trip the checks.
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, "");
}

Deno.test("shared/ is populated with wire-contract modules", async () => {
  const mods = await sharedModules();
  assert(
    mods.length > 0,
    "shared/ must contain at least one wire-contract module",
  );
});

Deno.test("shared/ modules import NOTHING (self-contained L0)", async () => {
  for (const { name, src } of await sharedModules()) {
    const code = stripComments(src);
    // Any `import ...` statement, bare `import "x"`, or re-export `export ... from`
    // pulls in another module — forbidden for an L0, dependency-free package.
    assert(
      !/^\s*import\b/m.test(code),
      `shared/${name} must not import anything (found an import statement)`,
    );
    assert(
      !/\bfrom\s*["']/.test(code),
      `shared/${name} must not import/re-export from another module (found a 'from' specifier)`,
    );
  }
});

Deno.test("shared/ modules are type-only (no runtime code)", async () => {
  // `interface`/`type` are erased; a runtime binding (const/function/class/enum/
  // let/var) is not, and would break the IDE's assumption that these specifiers
  // vanish at bundle time.
  const RUNTIME_EXPORT =
    /\bexport\s+(?:default\s+)?(?:const|let|var|function|class|enum|namespace)\b/;
  const RUNTIME_DECL = /^\s*(?:const|let|var|function|class|enum)\b/m;
  for (const { name, src } of await sharedModules()) {
    const code = stripComments(src);
    assert(
      !RUNTIME_EXPORT.test(code),
      `shared/${name} must be type-only (found a runtime export)`,
    );
    assert(
      !RUNTIME_DECL.test(code),
      `shared/${name} must be type-only (found a runtime declaration)`,
    );
  }
});
