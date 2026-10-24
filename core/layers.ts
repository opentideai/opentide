// Layer manifest for the OpenTide layered separation (docs/opentide-separation-plan.md).
//
// The one hard rule (§3.2): a module in layer N must not import from any layer > N.
// This file is the single source of truth for which layer each backend module
// belongs to; `checkLayerImports` in ./layer-check.ts enforces the rule against it.
//
// Phase 5 landed the §5 physical layout: each top-level folder *is* a layer
// (core/ verification/ mcp/ lsp/ cli/ agent-loop/ agent/), so a module's layer falls
// out of its path's first segment — see `FOLDER_LAYERS` + `layerOf`. The only per-file
// overrides are the composition roots, which live *inside* an entry folder
// (cli/, desktop/) but sit at the apex. `auth/` (the L4 account *service*) is a
// separate non-Deno subproject and out of scope. `tide/` IS a scanned Deno layer
// (the Tide product backend: auth enforcement/entitlements) sitting above
// OpenTide — imported only by the Tide composition roots. Note core/auth.ts is
// the unrelated request-scoped identity seam and stays core L1.

// Layers, lowest (most depended-upon) to highest. `shared` (L0, rank 0) is the
// populated top-level shared/ package: the OpenTide open wire contract, type-only
// and import-free, consumed by both the backend and the IDE. Internal-only
// vocabulary types (verification, etc.) stay in core/types.ts — only on-the-wire
// open shapes belong in shared/. `client` sits outside the import graph (REST/WS
// only) and is included so the ordering is total.
export type Layer =
  | "shared"
  | "core"
  | "verification"
  | "mcp"
  | "lsp"
  | "cli"
  | "agent-loop"
  | "providers"
  | "agent"
  | "tide"
  | "auth"
  | "client"
  | "composition";

// Numeric rank per layer. Siblings at L2 (verification/mcp/cli) share rank 2, so
// the rule permits imports *among* them; it only forbids importing a higher rank.
export const LAYER_ORDER: Record<Layer, number> = {
  shared: 0,
  core: 1,
  verification: 2,
  mcp: 2,
  // The outbound LSP server (JSON-RPC standard-protocol adapter over the runtime
  // language-intelligence seam; docs/lsp-support-plan.md). Open L2 sibling of
  // mcp: it imports core (down) and must NEVER import upward — the composition
  // root (cli/lsp-main.ts) wires it. Same "plug into tools we don't own" shape as
  // mcp (authoring) and the planned DAP (debugger).
  lsp: 2,
  cli: 2,
  // The OPEN agentic loop (streaming, tool dispatch, changeset-lifecycle driving) —
  // the extracted mechanism half of the old agent/chat.ts. An L2 sibling: it imports
  // core (down) and verification (sibling) but must NEVER import agent (its tuned
  // intelligence is injected via core/chat-intelligence.ts). This is what keeps
  // OpenTide runnable without the closed brain.
  "agent-loop": 2,
  // The concrete ModelProvider impls (multi-model harness, Stage 3b) — the
  // AI-SDK-backed transport plugged into the loop's ModelProvider seam. An OPEN L2
  // sibling of agent-loop: it imports core (down, incl. the L1 ModelProvider
  // contract) and the provider SDK, and is wired in by the composition roots
  // (cli/assembly.ts). It must NEVER import agent-loop or agent — both stacks
  // (closed brain + BYO-key open) construct it, so it cannot live in closed agent/,
  // and keeping it out of agent-loop keeps that loop SDK-free (D1).
  providers: 2,
  agent: 3,
  // The Tide product backend (auth enforcement, entitlements, future cloud
  // concerns). It sits above OpenTide (imports core downward) and is imported
  // ONLY by the Tide composition roots — never by any OpenTide layer, which is
  // what keeps core auth-free. Sibling of the auth/ account service at L4.
  tide: 4,
  auth: 4,
  client: 5,
  // The composition root is the apex: it assembles the layers it wants and is
  // the only place allowed to import upward (OpenTide §3.3). Ranking it above
  // everything keeps "the entry point wires all layers" legal under the rule.
  composition: 6,
};

// A folder's default layer: the top-level folder name IS the layer. Files under
// core/ (incl. db/**, codebase/**, tools/**, docs/** subtrees) are core; the L2
// siblings each own a folder (verification/ mcp/ lsp/ cli/ agent-loop/ providers/); agent/ is L3. Clients (ide/, desktop/) sit outside
// the import graph — desktop/desktop-main.ts is the one exception (a composition
// root, overridden below). NOTE: core/mcp.ts is the INBOUND MCP manager (consuming
// external MCP servers) and is plain core — do not conflate it with the outbound
// mcp/ layer.
const FOLDER_LAYERS: Record<string, Layer> = {
  shared: "shared",
  core: "core",
  verification: "verification",
  mcp: "mcp",
  lsp: "lsp",
  cli: "cli",
  "agent-loop": "agent-loop",
  providers: "providers",
  agent: "agent",
  tide: "tide",
  auth: "auth",
  ide: "client",
  desktop: "client",
};

// Folders that exist but are *not* part of the scanned backend import graph:
// auth/ (separate non-Deno subproject), ide/ (pure npm client, imports zero
// backend). shared/ IS scanned (Phase R): it is L0 (rank 0), so every import TO
// it is downward and legal, and scanning it guards that no upward import ever
// sneaks INTO the shared wire contract (it must stay import-free). Note desktop/
// IS scanned even though it maps to `client` — it hosts the Tauri composition
// root — so the scanned set is an exclusion over the declared folders, not a
// filter on layer value.
const UNSCANNED_FOLDERS: ReadonlySet<string> = new Set([
  "auth",
  "ide",
]);

// The layer-folder roots the import rule scans (§3.2), derived from the manifest
// so a new backend layer folder is auto-scanned by adding it to FOLDER_LAYERS
// alone. Consumed by `checkLayerImports` and its runner/test.
export const LAYER_ROOTS: readonly string[] = Object.keys(FOLDER_LAYERS)
  .filter((f) => !UNSCANNED_FOLDERS.has(f));

// Per-file overrides, keyed by repo-relative POSIX path. Only the composition
// roots need one: they live inside an entry folder (cli/, desktop/) whose default
// layer they must NOT take (as the apex they alone import upward). Everything else
// resolves from its folder via FOLDER_LAYERS.
export const MODULE_LAYERS: Record<string, Layer> = {
  // COMPOSITION — apex entry points that assemble the layers below (core +
  // agent + verification). They alone import upward. cli.ts is the `opentide`
  // dispatcher; main.ts/mcp-main.ts are the headless serve/mcp entries; both
  // live in cli/ alongside the cli L2 module (cli-commands.ts, which is a plain
  // cli-layer default). assembly.ts is the shared composition helper; and
  // test-composition.ts registers the full layer set (stores + verification/
  // agent tool handlers) for tests that dispatch tools crossing those layers.
  "cli/main.ts": "composition",
  "cli/mcp-main.ts": "composition",
  "cli/lsp-main.ts": "composition",
  // The orchestrator apex (Feature B / B1c): lives in cli/ but supervises the
  // per-project stacks above it (imports core/orchestrator + the composition
  // helper), so it takes the composition override like the other roots.
  "cli/orchestrator-main.ts": "composition",
  "cli/cli.ts": "composition",
  "cli/assembly.ts": "composition",
  "cli/test-composition.ts": "composition",
  // The closed Tide composition: tide/assembly.ts layers the agent seams onto
  // the open assembly, tide/main.ts is the Tide headless kernel entry, and
  // tide/test-composition.ts is the agent-carrying test composition. All three
  // sit in tide/ but assemble (and import) the open roots below them.
  "tide/assembly.ts": "composition",
  "tide/main.ts": "composition",
  "tide/test-composition.ts": "composition",
  // The Tauri desktop entry (its §6 home is desktop/, beside the shell it packages).
  "desktop/desktop-main.ts": "composition",
};

// Resolve the layer of a repo-relative module path (first segment = folder =
// layer, save for the composition-root overrides above).
export function layerOf(repoRelativePath: string): Layer {
  const override = MODULE_LAYERS[repoRelativePath];
  if (override) return override;
  const top = repoRelativePath.split("/")[0] ?? "";
  return FOLDER_LAYERS[top] ?? "core";
}

// True when `from` (in layer Lf) importing `to` (in layer Lt) violates §3.2,
// i.e. Lt ranks strictly above Lf.
export function isUpwardImport(fromPath: string, toPath: string): boolean {
  return LAYER_ORDER[layerOf(toPath)] > LAYER_ORDER[layerOf(fromPath)];
}

// A single tolerated upward import. Each is a behavioral value-import that Phase 2
// resolves with an inversion-of-control hook (§3.3); until then the rule reports
// it as known debt instead of failing the build. Keys are repo-relative paths.
export interface BaselineUpwardImport {
  from: string;
  to: string;
  reason: string;
}

// The Phase 1 baseline started at ~15 behavioral upward edges, each needing an
// inversion-of-control hook (§3.3). Phase 2 resolved them slice by slice and the
// baseline is now EMPTY — §3.2 holds with no exceptions. New or worsened upward
// imports fail the build outright. Keep this empty; a genuinely new IoC need
// should get its own hook, not a re-opened baseline.
//
// Resolution history (every edge is gone):
//   Slice A — control-server → chat (agent-provider hook).
//   Slice B — control-server → changeset-context / verification-overview (route-mount hook).
//   Slice C — control-server → audit-agent / audit-runner (audit-provider hook).
//   Slice E — registries → changesets / audit-manager (registered store factories).
//   Slice F — project-loader → verification-ledger (project-init hook);
//             audit-complexity → audit-runner (scoring primitive → audit-scoring.ts).
//   Slice D — tools/dispatch → refute-agent / audit-runner / audit-packages /
//             changesets / changeset-context (tool-capability registry;
//             tool-capabilities.ts + verification-/agent-tool-handlers.ts).
export const BASELINE_UPWARD_IMPORTS: ReadonlyArray<BaselineUpwardImport> = [];

// Set of "from to" keys for O(1) baseline membership tests.
const BASELINE_KEYS: ReadonlySet<string> = new Set(
  BASELINE_UPWARD_IMPORTS.map((e) => `${e.from} ${e.to}`),
);

// "from to" key for an edge, matching the shape stored in BASELINE_KEYS.
function edgeKey(fromPath: string, toPath: string): string {
  return `${fromPath} ${toPath}`;
}

export function isBaselined(fromPath: string, toPath: string): boolean {
  return BASELINE_KEYS.has(edgeKey(fromPath, toPath));
}
