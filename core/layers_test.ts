import { assert, assertEquals } from "@std/assert";
import { checkLayerImports, extractKernelImports } from "./layer-check.ts";
import { isUpwardImport, layerOf } from "./layers.ts";

// The load-bearing invariant (OpenTide §3.2): no non-baseline upward imports,
// and no stale baseline entries (an entry that no longer resolves must be
// removed). Both are asserted from a single tree scan.
Deno.test("kernel layer rule: no violations, no stale baseline", async () => {
  const result = await checkLayerImports();
  // assertEquals on the message list surfaces exactly which edge regressed.
  const violations = result.issues
    .filter((i) => i.level === "error")
    .map((i) => i.message);
  assertEquals(violations, [], "unexpected upward imports");
  const stale = result.issues
    .filter((i) => i.rule === "layer-baseline-stale")
    .map((i) => i.message);
  assertEquals(stale, [], "stale baseline entries");
  assert(result.passed, "layer-import check should pass");
});

// The import-path resolver is the correctness crux — subdir-relative, parent
// (`../`), and directory-index specifiers must all resolve to the right module.
Deno.test("import resolver: ../ from a subdirectory", () => {
  const known = new Set(["changesets.ts", "tools/dispatch.ts"]);
  assertEquals(
    extractKernelImports(
      "tools/dispatch.ts",
      'import { x } from "../changesets.ts";',
      known,
    ),
    [{ from: "tools/dispatch.ts", to: "changesets.ts" }],
  );
});

Deno.test("import resolver: ./ sibling inside a subdirectory", () => {
  const known = new Set(["tools/definitions.ts", "tools/dispatch.ts"]);
  assertEquals(
    extractKernelImports(
      "tools/definitions.ts",
      'import { d } from "./dispatch.ts";',
      known,
    ),
    [{ from: "tools/definitions.ts", to: "tools/dispatch.ts" }],
  );
});

Deno.test("import resolver: explicit and extensionless dir-index", () => {
  const known = new Set(["db/schema/index.ts", "changesets.ts"]);
  assertEquals(
    extractKernelImports(
      "changesets.ts",
      'import { t } from "./db/schema/index.ts";',
      known,
    ),
    [{ from: "changesets.ts", to: "db/schema/index.ts" }],
  );
  assertEquals(
    extractKernelImports(
      "a.ts",
      'export { z } from "./db/schema";',
      new Set(["db/schema/index.ts"]),
    ),
    [{ from: "a.ts", to: "db/schema/index.ts" }],
  );
});

Deno.test("import resolver: dynamic and type-position imports count", () => {
  const known = new Set(["a.ts", "chat.ts"]);
  assertEquals(
    extractKernelImports(
      "a.ts",
      'const x: import("./chat.ts").Foo = await import("./chat.ts");',
      known,
    ),
    [{ from: "a.ts", to: "chat.ts" }],
  );
});

Deno.test("import resolver: bare side-effect imports count", () => {
  const known = new Set(["a.ts", "chat.ts"]);
  assertEquals(
    extractKernelImports("a.ts", 'import "./chat.ts";', known),
    [{ from: "a.ts", to: "chat.ts" }],
  );
});

Deno.test("import resolver: commented-out imports are ignored", () => {
  const known = new Set(["a.ts", "chat.ts"]);
  assertEquals(
    extractKernelImports(
      "a.ts",
      '// import { x } from "./chat.ts";\nconst y = 1;',
      known,
    ),
    [],
  );
});

Deno.test("layer ordering and tags", () => {
  assert(isUpwardImport("core/control-server.ts", "agent/brain.ts")); // core → agent
  assert(!isUpwardImport("agent/brain.ts", "verification/changesets.ts")); // agent → verification (down)
  assert(
    !isUpwardImport(
      "verification/changesets.ts",
      "verification/audit-runner.ts",
    ),
  ); // L2 siblings
  assert(!isUpwardImport("core/registries.ts", "core/types.ts")); // core → core
  // The open/closed split: the agent-loop (L2) must never import the tuned brain (L3);
  // it depends on core (down) and verification (sibling), receiving intelligence by injection.
  assert(isUpwardImport("agent-loop/chat.ts", "agent/brain.ts")); // agent-loop → agent (FORBIDDEN)
  assert(!isUpwardImport("agent-loop/chat.ts", "core/chat-intelligence.ts")); // agent-loop → core (down)
  assert(!isUpwardImport("agent-loop/chat.ts", "verification/changesets.ts")); // agent-loop → verification (sibling)
  assert(!isUpwardImport("agent/brain.ts", "agent-loop/prompt-compose.ts")); // agent → agent-loop (down)
  assertEquals(layerOf("core/audit-complexity.ts"), "core"); // decision-3 deviation
  assertEquals(layerOf("core/custom-audits.ts"), "core"); // registry collection
  assertEquals(layerOf("core/db/schema/index.ts"), "core"); // core subtree
  assertEquals(layerOf("core/mcp.ts"), "core"); // inbound MCP manager stays core
  assertEquals(layerOf("verification/changesets.ts"), "verification");
  assertEquals(layerOf("agent-loop/chat.ts"), "agent-loop"); // the moved open loop
  assertEquals(layerOf("agent/brain.ts"), "agent"); // the closed brain
  assertEquals(layerOf("cli/main.ts"), "composition"); // apex composition root
  assertEquals(layerOf("cli/cli-commands.ts"), "cli"); // cli L2 (not composition)
  assertEquals(layerOf("desktop/desktop-main.ts"), "composition"); // Tauri apex
  assert(isUpwardImport("cli/main.ts", "agent/brain.ts") === false); // apex → agent is downward
});
