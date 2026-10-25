import { readEnv } from "./process-env.ts";
import { userConfigDir } from "./user-config-dir.ts";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  getModelPricing,
  getProviderModelPricing,
  isDeepLegacyModel,
  type ModelPricing,
  type PricingTier,
  type ProviderModelPricing,
} from "./usage.ts";
import type {
  PricingProvenance,
  ProportionalVerification,
  ReadinessEnforcement,
} from "./types.ts";
// Type-only (erased at runtime), so this does not create an import cycle:
// pricing-refresh.ts is pure and imports nothing from config.ts.
import type { PricingCheckRecord } from "./pricing-refresh.ts";
import type { ChangeCategory } from "../shared/changelog.ts";
import type { TelemetryConsent } from "../shared/telemetry.ts";
import {
  isOpenAiCompatibleModelsDevProvider,
  modelFromModelsDev,
  type ModelsDevCatalog,
  type ModelsDevProvider,
  pricingRowsFromModelsDev,
  readModelsDevCatalogCache,
  refreshModelsDevCatalog,
} from "./models-dev.ts";

// A5 (Stream A privacy gate): the current consent version. The first-run modal is
// shown — and all telemetry/feedback egress stays blocked — whenever the version
// the user last answered is below this. Bump it to re-prompt when the consent copy
// or the categories collected materially change. Lives here (not in type-only
// shared/) because it is a runtime value; the IDE receives it via the telemetry
// settings API rather than importing it.
export const CONSENT_VERSION = 1;

function configPath(): string {
  return join(userConfigDir(), "config.json");
}
function modelCachePath(): string {
  return join(userConfigDir(), "models-cache.json");
}

export function getUserConfigDir(): string {
  return userConfigDir();
}

export function getTideDir(): string {
  return getUserConfigDir();
}

export const DEFAULT_MODEL_ID = "default";

// The transport a model is served over — the disambiguator the multi-model harness
// (docs/multi-model-harness-plan.md, Stage 2) hands to the AI SDK factory
// (`anthropic(id)` vs `openai(id)`). It is a provider TAG, not an id namespace: ids
// stay canonical (bare `claude-*` / `gpt-*`, which don't collide), so this field —
// not a slash prefix — is what picks the backing provider. Mirrors the
// ModelRole/MODEL_ROLES pattern below (named union + runtime array, no magic strings
// at call sites).
export type BuiltInModelProviderId = "anthropic" | "openai";
// `string & Record<never, never>` is the same type as `string & {}` — the idiom
// that keeps the literal union from collapsing to bare `string`, so editors still
// suggest "anthropic"/"openai" while any provider id remains assignable. Spelled
// this way because deno lint's ban-types rule matches the `{}` SYNTAX, not the type.
export type ModelProviderId =
  | BuiltInModelProviderId
  | (string & Record<never, never>);
export const MODEL_PROVIDER_IDS: readonly ModelProviderId[] = [
  "anthropic",
  "openai",
];
// Every legacy/unprefixed model id predates multi-provider support and is Claude, so
// this is providerFor's total-resolver fallback for an id with no `provider` tag
// (including dynamically-loaded cache entries, which never carry one).
export const DEFAULT_MODEL_PROVIDER: ModelProviderId = "anthropic";

export interface ModelOption {
  id: string;
  label: string;
  family?: string;
  pricing?: ModelPricing;
  // Which provider transport backs this model (Stage 2). Optional so cache entries
  // loaded from the live catalog — which have no provider field — still typecheck;
  // an absent value resolves to DEFAULT_MODEL_PROVIDER via providerFor.
  provider?: ModelProviderId;
  // Context-window hardening (Slice 1): the live per-model context window when the
  // provider's catalog exposes one (OpenRouter-style `context_length` /
  // `top_provider.context_length`). Persisted on the cached descriptor alongside
  // pricing; a positive integer or absent. When present it wins over the family
  // table in contextWindowFor (core/context-window.ts); absent falls back to it.
  contextWindow?: number;
  outputLimit?: number;
  providerLabel?: string;
  metadataSource?: "models.dev" | "provider" | "manual" | "unknown";
  modalities?: { input?: string[]; output?: string[] };
  capabilities?: {
    toolCall?: boolean;
    structuredOutput?: boolean;
    reasoning?: boolean;
    attachment?: boolean;
  };
  lastUpdated?: string;
  // Feature E4: set when a surfaced model is deep-legacy/retired. Deep-legacy ids
  // are normally hidden from the picker; one only surfaces because a role is still
  // pinned to it, so it is flagged here and rendered muted/last rather than hidden
  // outright (which would blank the dropdown and hide what's actually running).
  deprecated?: boolean;
}

type ModelMetadata = Omit<ModelOption, "id">;

// D7 (docs/multi-model-harness-plan.md §3): the model catalog is fully dynamic —
// zero hardcoded model ids. "Discover, don't enumerate." The catalog is whatever
// per-provider discovery (refreshAvailableModels over PROVIDER_DESCRIPTORS) found and
// cached; the only built-in entry is DEFAULT_MODEL_ID, injected by getAvailableModels.
// This map is intentionally empty — every branch that reads `id in MODELS` (isSurfacedModel)
// simply falls through, which is correct for a discovered-only catalog. Slice 2's curated
// Claude + gpt-* rows were reverted here (D7); the surviving Slice-2 shape is the
// ModelProviderId union + the `provider` tag, now sourced from discovery, not this map.
export const MODELS: Record<string, ModelMetadata> = {};

export type ModelId = string;

// Pure, total resolver: which provider transport backs `modelId` right now. With the
// curated MODELS map emptied (D7), the tag is sourced from the discovered catalog
// (models-cache.json — the same union getAvailableModels resolves over), which
// readModelCache now carries the `provider` tag through (D8). Falls back to
// DEFAULT_MODEL_PROVIDER for any id not found (legacy/unknown ids, which are all
// Claude) so it never throws. Pure + total. Additive/dark: not yet wired into role
// resolution.
export function providerFor(modelId: ModelId): ModelProviderId {
  const cached = readModelCache()?.models.find((m) => m.id === modelId)
    ?.provider;
  return cached ?? DEFAULT_MODEL_PROVIDER;
}

// Slice 1: the live per-model context window persisted in the model cache, or
// undefined if never discovered / invalid. context-window.ts prefers this over
// the family table. Reads the same cache row providerFor resolves over.
export function getCachedContextWindow(modelId: ModelId): number | undefined {
  return readModelCache()?.models.find((m) => m.id === modelId)?.contextWindow;
}

export const DEFAULT_AGENT_MODEL: ModelId = DEFAULT_MODEL_ID;
export const DEFAULT_CODE_MODEL: ModelId = DEFAULT_MODEL_ID;

// D9 (docs/multi-model-harness-plan.md §3): a role that can't be satisfied from the
// discovered catalog (keyless / empty / target family absent / no recommendation yet)
// resolves to `undefined` — an explicit UNCONFIGURED state, never a hardcoded id. This
// is the user-facing message every caller surfaces instead of shipping a dead id to a
// provider; MODEL_UNCONFIGURED_LABEL is the short token a status/diff surface renders.
export const MODEL_UNCONFIGURED_MESSAGE =
  "No model is configured for this role. Add a provider key or pick a model in Settings.";
export const MODEL_UNCONFIGURED_LABEL = "unconfigured";

// A model ROLE — each is resolved independently so different kinds of work can run
// on the right model (Feature G). "agent" authors chat/code, "planning" writes
// plans and acceptance criteria, "import" interprets source-backed codebases,
// "utility" does latency-cheap work (autocomplete, titles, summaries), and
// "verification" runs the confidence layer (audits, refute/adversarial pass).
export type ModelRole =
  | "agent"
  | "planning"
  | "import"
  | "utility"
  | "verification";
export const MODEL_ROLES: readonly ModelRole[] = [
  "agent",
  "planning",
  "import",
  "utility",
  "verification",
];

// The config.json key each role's stored selection persists under. The value is
// either DEFAULT_MODEL_ID ("default" → follows the role's recommendation) or an
// explicit pin (a concrete model id — never auto-changes).
const ROLE_CONFIG_KEY: Record<
  ModelRole,
  | "agentModel"
  | "planningModel"
  | "importModel"
  | "utilityModel"
  | "verificationModel"
> = {
  agent: "agentModel",
  planning: "planningModel",
  import: "importModel",
  utility: "utilityModel",
  verification: "verificationModel",
};
export const AUDIT_TIMEOUT_MS = 55_000;
export const REGISTRY_CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

// Feature G (G4): the auto-refresh throttle window. On project load the catalog +
// recommendations freshen at most once per this interval, keyed off the model
// cache's `cachedAt` — so startup never pays a Models API call (and its token
// cost) every boot. Kept a distinctly-named constant from REGISTRY_CACHE_MAX_AGE_MS
// (npm registry cache): the two concerns are unrelated even though both are 24h.
export const MODELS_REFRESH_TTL_MS = 24 * 60 * 60 * 1000;

// Max output tokens for the (non-streaming) audit-agent model call.
export const AUDIT_AGENT_MAX_TOKENS = 4096;
// Default number of independent adversarial refutation attempts per claim.
export const REFUTE_ATTEMPTS_DEFAULT = 2;
// Max changed entities whose source is inlined into a refutation prompt. The
// refuter runs REFUTE_ATTEMPTS_DEFAULT times per claim, so an unbounded context
// is paid twice per claim.
export const REFUTE_CONTEXT_MAX_ENTITIES = 12;
// Hard cap for any adversarial-refutation prompt context assembled from project
// code or changed scopes. This bounds worst-case spend even when a changeset is
// broad enough to need the guarded whole-project fallback.
export const REFUTE_CONTEXT_MAX_CHARS = 40_000;
// Max independently-proposed acceptance criteria kept from one criteria-agent
// call. The agent is asked for the gaps that matter, not an exhaustive spec; a
// long list is a sign it started enumerating rather than judging, and every item
// becomes a readiness finding a human has to adjudicate.
export const INDEPENDENT_CRITERIA_MAX = 6;
// Hard cap on one proposed criterion's text, so a runaway generation can't push
// an essay into the plan JSON (and from there into every later prompt).
export const INDEPENDENT_CRITERION_MAX_CHARS = 400;
// npm registry network timeouts: bulk advisory lookup vs per-package metadata.
export const NPM_AUDIT_BULK_TIMEOUT_MS = 15_000;
export const NPM_REGISTRY_FETCH_TIMEOUT_MS = 10_000;
// Default character budget when truncating content for the agent context.
export const CHAT_CONTEXT_TRUNCATE_DEFAULT = 1400;

// Dev servers (control + MCP) bind to loopback only. They expose privileged
// surfaces (terminal/eval, filesystem, secrets) and must never be reachable
// from the LAN. The exported standalone app uses its own configurable host.
export const DEV_SERVER_HOST = "127.0.0.1";

// Env var selecting the app-preview server's bind host. The preview iframe
// derives its host from the IDE's own origin (not a hardcoded localhost), so
// when the IDE is reached over a trusted overlay (a tailnet box) the app server
// must be reachable at that same host. Default loopback keeps local dev
// localhost-only; set OPENTIDE_APP_HOST=0.0.0.0 on such a box to bind the overlay.
// Mirrors OPENTIDE_IDE_HOST for Vite. Unlike the control server — which stays
// loopback, reached via the Vite proxy — the preview server is plain app content
// with no privileged surface, so exposing it on a trusted network is an
// acceptable, opt-in relaxation, not a hole in the loopback posture above.
export const APP_HOST_ENV = "OPENTIDE_APP_HOST";

// Resolve the app-preview bind host: OPENTIDE_APP_HOST if set, else loopback.
export function getAppServerHost(): string {
  return readEnv(APP_HOST_ENV) || DEV_SERVER_HOST;
}

// Resolve the host other same-machine tooling should dial for the app preview.
// A concrete bind host (for example a tailnet IP) is directly reachable; wildcard
// binds are not valid client destinations, so they collapse to loopback.
export function getAppServerDialHost(
  host: string = getAppServerHost(),
): string {
  if (host === "0.0.0.0" || host === "::") return "localhost";
  return host;
}

export function appPreviewUrl(port: number, path = "/"): string {
  const normalized = path.startsWith("/") ? path : "/" + path;
  return `http://${getAppServerDialHost()}:${port}${normalized}`;
}

// The OpenTide release version: `opentide --version` and the serverInfo both
// servers advertise.
export const OPENTIDE_VERSION = "0.1.4";

// Set by install.sh's `opentide` launcher to its own path, so a spawned serve
// and a generated client config run the launcher rather than a bare `deno run`
// that would miss the release's config and lockfile.
export const LAUNCHER_ENV = "OPENTIDE_LAUNCHER";

// Identity the outbound MCP server (mcp-server.ts) advertises to connecting
// external agents during the MCP handshake. `opentide` is the product face of
// the headless core (OpenTide §1); keep the name stable — clients key on it.
export const MCP_SERVER_NAME = "opentide";
export const MCP_SERVER_VERSION = OPENTIDE_VERSION;

// Version of the projected MCP TOOL SURFACE — the published external contract of
// tool names + input schemas an external agent pins against (OpenTide §10). This
// is deliberately DISTINCT from the two other versions in play:
//   - the MCP protocol version — the spec, negotiated by the SDK at connect();
//   - MCP_SERVER_VERSION (= OPENTIDE_VERSION) — the OpenTide server BUILD/impl maturity.
// The surface can be stable (1.x) while the impl is still early (0.x); versioning
// the surface separately is exactly what lets pinned integrations survive impl
// churn. The surface reached its stable shape in Phase 3 Slice F1 (122 verbs) and
// stayed constant through F2/F3 (only additive advisory metadata), so F4 ratifies
// it as the v1 contract. Bump policy (semver — see docs/mcp-connect.md):
//   MAJOR — a verb removed, renamed, or an input schema changed incompatibly;
//   MINOR — a new verb added, or an existing verb marked deprecated;
//   PATCH — advisory-only metadata (annotations, description wording).
// A structural fingerprint (mcp-projection.ts) is pinned by a test so a name/
// schema change can never land without a conscious bump here.
// 1.1.0 (Stage 5, docs/lsp-support-plan.md): define_handler/define_function gained an
// optional `expectedRevision` input (optimistic concurrency) — an additive, backward-
// compatible schema change, so MINOR, not MAJOR.
// 3.0.0 (Stream B / B1c): added the blast_radius verb (MINOR) and dropped get_asset
// from the projected surface (it's now unhooked from AGENT_TOOLS to stay within the
// 128-tool model budget; still reachable via direct dispatch). A removed verb is a
// breaking surface change, so MAJOR.
// 3.1.0: git_commit.message became optional so clients can request generated
// commit messages. Existing callers that pass message remain compatible, so MINOR.
// 3.2.0: list_assets gained optional name/includeContent fields so agents can
// read live text asset source without adding a tool above the 128-tool budget.
// 4.0.0 (project import Slice 1): added the index_codebase verb (source-backed
// codebase indexing) and, to stay within the 128-tool model budget, dropped
// get_config from AGENT_TOOLS/the projected surface (single-config reads are
// covered by list_configs; still reachable via direct dispatch). A removed verb
// is a breaking surface change, so MAJOR.
// 5.0.0 (tool-surface consolidation): reclaimed model-budget headroom by folding
// redundant verbs, dropping the projected surface 124 → 97. Reads: 11 singular
// get_* folded into their list_* sibling (list_templates/list_dev_views/list_tests/
// list_modules gained an optional `name`; the rest were already covered), matching
// the get_asset/get_config precedent. Writes: value set/clear folded into
// define_env_var/define_secret via `value`/`clearValue`; 12 per-entity removals
// folded into remove_entity({type,key}); analyze_complexity + find_dead_code folded
// into analyze({kind}). All folded verbs stay reachable via direct dispatch. Two
// new verbs added (remove_entity, analyze). Removed/renamed surface verbs = MAJOR.
// 5.1.0 (document store Phase 1, docs/document-store-plan.md §6): added three
// role-split document-store verbs — document_query (read), document_write
// (additive mutation, changeset-exempt), document_pin (working-set membership).
// Purely additive (surface 97 → 100), so MINOR.
// 5.2.0 (work-items formal-specs clarification, commit bbcd29c): the shared
// formalSpecs property description on create_changeset / update_changeset_plan /
// amend_changeset_plan gained `discriminant?` guidance (document the discriminant
// field; don't encode it only in prose). Property-description-only — no structural
// change to accepted inputs (identical properties/types/required/enums), so
// backward-compatible → MINOR. The structural pin (mcp-projection_test.ts) still
// moved because mcpSurfaceFingerprint hashes the whole inputSchema, prose included;
// pin refreshed in the same change. Surface count unchanged (100).
// 5.3.0 (route smoke fixtures, Milestone 4 Slice 4.3): register_route and
// define_handler gained an optional `productionTest` schema property (mark a route
// safe to auto-hit + supply example requests for the production route-smoke gate).
// Purely additive optional input — existing callers are unaffected — so
// backward-compatible → MINOR. Surface count unchanged (100); the structural pin
// moved because the added property is part of the hashed inputSchema.
// 5.4.0 (project text file authoring): added preview_project_file (read-only) and
// apply_project_file (destructive mutation) so agents can create/update/delete safe
// text files inside the current project through a two-step preview/apply flow.
// Purely additive (surface 100 → 102), so MINOR.
// v5.7.0 (codebase import classifier): index_codebase gained optional
// classification mode so imports can request shaping for Tide code. Optional input
// schema expansion, backward-compatible -> MINOR.
// v5.8.0 (agent cost reduction, docs/agent-cost-reduction.md §4.2): list_handlers,
// list_functions and list_types gained an optional `name` and now return a summary
// (name/module/purpose/line count) instead of every entity's full source. The input
// contract is only relaxed — an existing caller that passes nothing still gets a
// result — so MINOR, same precedent as the 5.0.0 list_templates/list_tests/
// list_modules fold. NOTE the gap this exposes: mcpSurfaceFingerprint
// (mcp/mcp-projection.ts) hashes names and inputSchema only, so the OUTPUT shape of
// a verb is under no contract test at all. An external MCP client reading
// list_functions[].source breaks against this change with nothing failing. If output
// ever needs to be pinned, that pin does not exist yet.
// v5.10.0 adds flush_project_state (103 -> 104). The registries load from the project's
// state directory, but every existing flush hung off the IDE (control-server REST routes,
// the agent-loop per-step checkpoint), off git (git_status / git_commit / git_push), or off
// a clean unload — so a headless MCP session could mutate the registry for an entire
// session with no durable write, and lose all of it to an unclean exit. complete_changeset
// now flushes as well. Purely additive verb, so MINOR.
// v5.11.0 adds out/force/includeManifest to export_project (tool count stays 104).
// The verb built the file list in memory and told the caller to download it from the UI —
// but this face has no UI, so the only way to get an export onto disk was the `opentide
// export` CLI, which takes the project lock loadProject already holds and rewrites
// .opentide/state on unload. `out` lets the process that owns the project write the tree.
// The same call now starts from DEFAULT_BUILD_OPTIONS and passes projectName/projectVersion,
// so an MCP export finally matches the CLI's: it used to silently omit migrations/ entirely
// and stamp APP_VERSION as "unversioned". Additive optional params, so MINOR.
// v5.12.0 corrects register_route's `schema` description (tool count stays 104). It
// claimed only "requests with a body schema are validated", which understated the
// contract — params and query are validated too — and it was silently false for an
// EXPORTED app, which validated nothing at all until the export gained its own
// validators. Both are true now, in both hosts, so the description says so. It also
// states what `format` does, because the answer is "documents, does not enforce" and an
// agent that relies on it gets no rejection: `enum` constrains a param, `enum` or
// `pattern` a body property. Prose only — no property, type, required or enum changed —
// so backward-compatible → MINOR, same call as 5.2.0. The structural pin
// (mcp-projection_test.ts) still moved, because mcpSurfaceFingerprint hashes the whole
// inputSchema, prose included; refreshed in this change.
// v5.13.0 adds project_status (104 -> 105) and tightens the changeset and
// verification schemas: update_changeset_step.status and
// record_verification_run.status gained their enums, and the acceptanceCriteria,
// verificationPlan, evidence and claimResults items now declare their fields
// (open objects — extra fields still pass). Over MCP, arguments are checked
// against these schemas before dispatch (core/tools/validate-args.ts), so a value
// outside an enum, or a key the tool does not declare, is refused with
// INVALID_ARGUMENTS where it used to be ignored or silently normalized. The IDE
// agent loop runs the same check (agent-loop/chat.ts). A caller sending correct
// arguments sees no difference, and every refused call was one
// that already did not do what its sender meant — so MINOR, not MAJOR. The one
// exception worth knowing: a call that omitted a key the schema always marked
// required (record_verification_run.residualRisks, for one) now gets refused
// instead of tolerated.
// v6.0.0: `opentide mcp` boots the open assembly (no closed agent), so the
// agent-backed refute_claims leaves the published surface (105 -> 104). A removal,
// so MAJOR. The Tide assembly advertises it on top of this surface; nothing else
// moved. The pinned fingerprint is now the open surface's.
// v6.1.0: write_project_file, generate_project_docs, rename_module and
// move_to_module now need an in-progress changeset and write changelog records,
// so each gained the optional rationale/implementation fields. MINOR.
// v6.2.0: task forks — start_task, list_tasks, merge_task, discard_task
// (104 -> 108). Additive, so MINOR.
// v6.2.1: shorter descriptions on the changeset-plan and productionTest schemas.
// Text only, so PATCH.
// v6.3.0: adopt_changeset, for continuing a changeset whose client is gone
// (108 -> 109). Additive, so MINOR.
export const MCP_SURFACE_VERSION = "6.3.0";

// Default loopback port for the outbound MCP HTTP/SSE transport (mcp-http.ts,
// `deno task mcp --http`). Distinct from the control server (:3003) and the app
// preview server (:3001) so all three can run side by side. Overridable with
// --port; binds to DEV_SERVER_HOST only — the MCP surface exposes the mutating
// tool verbs and must never be reachable from the LAN.
export const MCP_HTTP_PORT = 3005;

// Path of the MCP endpoint, both on `opentide serve` and on standalone
// `opentide mcp --http`. One path, so a client config only changes the port.
export const MCP_HTTP_PATH = "/mcp";

// The per-server bearer token that gates the MCP HTTP endpoint (core/server-
// token.ts). Minted fresh on every project open unless this env var pins it, which
// is how a static HTTP client config keeps working across restarts.
export const SERVER_TOKEN_ENV = "OPENTIDE_MCP_TOKEN";
export const SERVER_TOKEN_BYTES = 32;

// `opentide mcp` bridges stdio to the project's serve process, starting one when
// none is running. A cold start compiles the kernel graph and opens PGlite, so
// the wait is generous; the poll reads two small files.
export const MCP_BRIDGE_STARTUP_TIMEOUT_MS = 90_000;
export const MCP_BRIDGE_POLL_MS = 200;
// Where a serve process the bridge started writes its output, under .opentide/.
export const SERVE_LOG_FILE = "serve.log";

// Task forks (docs/opentide-task-forks-plan.md). Each open task is a full copy of
// the project with its own serve process, so this caps disk and processes, not
// just bookkeeping.
export const MAX_OPEN_TASKS = 4;
// How long discarding a task waits for the fork's serve to let go of its lock
// after SIGTERM before refusing.
export const TASK_STOP_TIMEOUT_MS = 10_000;

// Changeset start snapshots: project code and files as they stood when a changeset
// began, for abandon to rewind to and a mid-changeset fork to start from. How
// many to keep is the maxChangesetSnapshots kernel setting (0 turns them off);
// the env var overrides the file.
export const MAX_CHANGESET_SNAPSHOTS_DEFAULT = 10;
export const OPENTIDE_MAX_CHANGESET_SNAPSHOTS_ENV =
  "OPENTIDE_MAX_CHANGESET_SNAPSHOTS";
// A project file bigger than this, or one that isn't UTF-8 text, stays out of the
// snapshot, and a rewind leaves it where it is.
export const CHANGESET_SNAPSHOT_MAX_FILE_BYTES = 1_000_000;

// The MCP call audit (verification/mcp-audit.ts) keeps the newest this many
// records. A call whose JSON arguments exceed MCP_MAX_ARG_BYTES is refused
// before dispatch and audited as a deny.
export const MCP_AUDIT_MAX_RECORDS = 10_000;
export const MCP_MAX_ARG_BYTES = 1024 * 1024;
// An MCP client's self-reported name (initialize clientInfo.name) names its
// session and principal. It is the client's own string, so it is cut to this.
export const MCP_CLIENT_NAME_MAX_CHARS = 64;
// Random hex appended to an MCP session's name. Clients send one name for
// every session (Claude Code always says "claude-code"), so without it two
// sessions read the same in CHANGESET_ACTIVE and the IDE's session list.
export const MCP_SESSION_TAG_BYTES = 2;

// An MCP session that has made no call for this long counts as gone, so its
// open changeset can be adopted (core/session-liveness.ts). Covers a client
// killed without closing its connection.
export const MCP_SESSION_IDLE_MS = 30 * 60_000;

// --- Document store (docs/document-store-plan.md §3-§5) ---

// Id prefixes for the document store, mirroring the changeset ("cs") convention
// (createTimestampedId appends the underscore → doc_<ts>_<rand>, dref_<ts>_<rand>).
export const DOCUMENT_ID_PREFIX = "doc";
export const DOCUMENT_REF_ID_PREFIX = "dref";

// Directory name for the content-addressed blob store, joined under the project
// artifacts root (<artifactsDir>/documents) for project/session docs and under the
// user config root (getTideDir()/documents) for global docs. Blobs are sharded
// <hash[0:2]>/<hash> beneath it (§4).
export const DOCUMENT_STORAGE_DIRNAME = "documents";

// File mode for document blobs written under the user-level global root
// (secrets-adjacent convention, §4).
export const DOCUMENT_BLOB_FILE_MODE = 0o600;

// The larger content cap (bytes) for UPLOADED binary blobs — images and PDFs
// (document store Phase 4 Slice 9, plan §7/§9). Text content still uses the
// smaller DOCUMENT_MAX_CONTENT_BYTES (= DEFAULT_MAX_FILE_BYTES ≈ 512 KB), which
// is right for source/markdown but far too small for a real photo or PDF. The
// cap is kind-aware in capCheck (documents.ts): text/* → the text cap, everything
// else → this one. 10 MiB comfortably covers previewable images/PDFs while still
// bounding a single blob.
export const DOCUMENT_UPLOAD_MAX_BYTES = 10 * 1024 * 1024;

// Tier-2 working-set token budget (D3). Pinning past this fails
// (WORKING_SET_BUDGET_EXCEEDED) and instructs the agent to release something first;
// enforcement lives in DocumentStore.setPinned and prompt injection in
// prompt-compose.ts (docs/document-store-plan.md §5, §11).
export const DOCUMENT_WORKING_SET_MAX_TOKENS = 20000;

// The kernel-wide rough token estimator: ~4 bytes/chars per token. Shared so the
// working-set budget and session token accounting agree on one convention rather
// than forking a bare `/ 4` at each call site (CLAUDE.md — no magic numbers). Mirrors
// the Math.ceil(chars / 4) already used in sessions.ts.
export const BYTES_PER_TOKEN_ESTIMATE = 4;

export function estimateTokensFromBytes(bytes: number): number {
  return Math.ceil(bytes / BYTES_PER_TOKEN_ESTIMATE);
}

// Identity the outbound LSP server (lsp/server.ts) advertises to connecting
// editors and agents in the `initialize` result's `serverInfo`. Mirrors the MCP
// pair above: `opentide` is the stable product face; the version tracks the LSP
// server BUILD/impl maturity (distinct from the LSP protocol version the client
// negotiates). Keep the name stable — clients key on it.
export const LSP_SERVER_NAME = "opentide";
export const LSP_SERVER_VERSION = OPENTIDE_VERSION;

// The version of the ADVERTISED LSP capability surface — the LSP analog of
// MCP_SURFACE_VERSION (mirror the discipline; docs/lsp-connect.md). Distinct from
// both LSP_SERVER_VERSION (the server BUILD/impl maturity, in serverInfo) and the
// LSP protocol version the client negotiates: this pins the CONTRACT a client
// keys on — which capabilities/providers/commands and which opentide/* custom
// notifications the `initialize` result declares. Advertised in the initialize
// result under the `opentideSurface` capability (lsp/surface.ts), alongside a
// structural fingerprint that a pinned test (lsp/surface_test.ts) freezes so a
// capability change can't land without a conscious bump here.
// Bump policy (semver — see docs/lsp-connect.md):
//   MAJOR — a capability/method removed or renamed, or an incompatible change;
//   MINOR — a new capability/provider/command or opentide/* notification added;
//   PATCH — advisory-only (a policy-value field like opentideReadinessEnforcement,
//           or the serverInfo build version) — the fingerprint is unchanged.
// 1.0.0 — the Stage 8 baseline: the read providers + the Stage 3–7 write surface
// (save, executeCommand opentide.createEntity, didCreate, rename) + the two opentide/*
// custom notifications (changesetStatus, documentChanged).
// 2.0.0 — every genie-named wire identifier renamed to opentide: the URI scheme,
// the custom notifications, the createEntity command and both capability keys.
export const LSP_SURFACE_VERSION = "2.0.0";

// Debounce for LSP push diagnostics (lsp/server.ts): didOpen/didChange schedule a
// getDiagnostics run this many ms after the last edit, so a burst of keystrokes
// yields one publish, not one per character. Mirrors the IDE lint source's coalesce
// window. A superseded buffer is discarded by the stale-version guard, not by this.
export const LSP_DIAGNOSTICS_DEBOUNCE_MS = 250;

// The LSP diagnostic `source` labels — the namespace stamped on every merged
// diagnostic so a client (external editor or the Genie IDE) can tell the three
// streams apart and filter them. `tsc` is the TypeScript compiler (Stage 1's only
// source); Stage 2 (unified diagnostics) adds the QC engine (`qc`) and the
// verification layer (`verify`) alongside it via core/diagnostics.ts. Keep these
// stable — clients key on them. (docs/lsp-support-plan.md Stages 1–2.)
export const LSP_DIAGNOSTIC_SOURCE_TS = "tsc";
export const LSP_DIAGNOSTIC_SOURCE_QC = "qc";
export const LSP_DIAGNOSTIC_SOURCE_VERIFY = "verify";

// QC issues carry a 1-based `line` but no column, so they anchor at column 1; an
// issue with no line at all (whole-entity findings like `require-await`) anchors at
// line 1 — the gutter — so it still surfaces rather than being dropped. Service
// coordinates are 1-based (core/language-service.ts). (docs/lsp-support-plan.md
// Stage 2.)
export const QC_DIAGNOSTIC_DEFAULT_LINE = 1;
export const QC_DIAGNOSTIC_DEFAULT_COLUMN = 1;

// Master feature flag for the LSP write path (didSave/rename → the `define_*`
// upsert; docs/lsp-support-plan.md Stages 3–7). ON as of Stage 3 (write path A:
// edit existing entities, diagnostics-as-rejection): a write-capable server
// advertises save support and persists a didSave through the tool layer's QC gate
// + changelog (direct tool-level, no session changeset — plan §11.1). A read-only
// deployment can still force it off by passing `writeFeaturesEnabled: false` to the
// LspServer, which then advertises no save and rejects didSave.
export const LSP_WRITE_FEATURES_ENABLED = true;

// The `userMessage` stamped on the ChangeContext for an LSP didSave (mirrors the
// control server's "Manual edit from Code panel" for its Code-panel PUT). It rides
// into the changelog so an ungated edit is attributable to the editor, not a chat
// turn. Paired with `manualEdit: true` — the sanctioned escape hatch that lets a
// direct tool-level write skip the session-changeset requirement (dispatch.ts).
export const LSP_MANUAL_EDIT_USER_MESSAGE = "Manual edit via LSP didSave";

// Shown (window/showMessage) when a didSave arrives at a server with the write flag
// off — the flag-off server advertised no save capability, so a save here is a
// client that ignored capabilities; tell it plainly rather than silently dropping.
export const LSP_READ_ONLY_SAVE_MESSAGE =
  "This OpenTide LSP server is read-only; the save was not persisted.";

// The approval hint carried on a opentide/changesetStatus notification (Stage 4): a
// gated save is held as a _genie_changeset in "planning"; resolution runs through
// the changeset store's approve(id). There is no LSP approve request yet, so this
// describes the path rather than naming a callable endpoint (a rich client surfaces
// its own approve UI). (docs/lsp-support-plan.md Stage 4.)
export const LSP_CHANGESET_APPROVAL_HINT =
  "Approve this changeset to apply the held edit (changeset approval flow).";

// Stage 6 creation (docs/lsp-support-plan.md Stage 6, §11.3): the LSP command name a
// client invokes over workspace/executeCommand to create a NEW entity with its full
// metadata form (a bare file carries none — plan §3). The supported creation path;
// didSave stays edit-only. Keep it stable — clients register/invoke it by this name.
export const LSP_CREATE_ENTITY_COMMAND = "opentide.createEntity";

// The `userMessage` stamped on the ChangeContext for a opentide.createEntity command
// (mirrors LSP_MANUAL_EDIT_USER_MESSAGE for didSave): it rides into the changelog so a
// created entity is attributable to the editor's create command. Paired with
// `manualEdit: true` — the same escape hatch the edit path uses to skip the
// session-changeset requirement for a direct tool-level write (dispatch.ts).
export const LSP_CREATE_ENTITY_USER_MESSAGE =
  "Entity created via LSP opentide.createEntity command";

// Shown (window/showMessage) when a opentide.createEntity arrives at a server with the
// write flag off — a read-only server advertises no command, so this is a client that
// ignored capabilities; tell it plainly (plan §3 "never lie about governance").
export const LSP_CREATE_WRITE_DISABLED_MESSAGE =
  "This OpenTide LSP server is read-only; the entity was not created.";

// Shown (window/showMessage) when a client reports a new opentide:// file via
// workspace/didCreateFiles (Stage 6 trigger): a bare file can't become an entity
// silently (no metadata — plan §3), so point the user at the create command instead
// of auto-defining an under-specified entity.
export const LSP_DID_CREATE_FILES_MESSAGE =
  `New opentide:// files don't become entities on their own — run the ` +
  `"${LSP_CREATE_ENTITY_COMMAND}" command to define one with its route, module, and ` +
  `purpose.`;

// Stage 7 rename (docs/lsp-support-plan.md Stage 7): the internal dispatch verb the
// LSP rename path calls to apply a cross-entity WorkspaceEdit as ONE atomic, governed,
// reversible operation. Deliberately NOT projected to MCP (not in CUSTOM_TOOLS /
// AGENT_TOOLS): it consumes pre-computed full-entity sources — the product of applying
// an LSP WorkspaceEdit — which is editor-mechanism data, not agent-authoring vocabulary
// (an agent renames by calling define_* itself). So the MCP surface (and
// MCP_SURFACE_VERSION) is UNCHANGED by Stage 7. Named here so the server's dispatchTool
// call site reads intent, not a bare literal (the dispatch case label stays literal, per
// the file's convention). A guard test pins that it is not on the projected surface.
export const LSP_RENAME_TOOL = "apply_rename";

// The `userMessage` stamped on the ChangeContext for an LSP rename (mirrors
// LSP_MANUAL_EDIT_USER_MESSAGE for didSave). Every changelog entry the rename records —
// the rewritten reference edits, the register-new/retire-old of an entity-name rename,
// the route rebind — shares one turnId under this message, so the whole rename is one
// reversible turn attributable to the editor. Paired with `manualEdit: true`.
export const LSP_RENAME_USER_MESSAGE = "Rename via LSP textDocument/rename";

// Shown (window/showMessage) when a textDocument/rename arrives at a server with the
// write flag off — a read-only server advertised no renameProvider, so this is a client
// that ignored capabilities; tell it plainly (plan §3 "never lie about governance").
export const LSP_RENAME_DISABLED_MESSAGE =
  "This OpenTide LSP server is read-only; the rename was not applied.";

// Tool-dispatch error codes the LSP write path (lsp/server.ts) branches on to turn
// a rejected define_* upsert into editor feedback. They mirror the codes
// core/tools/dispatch.ts emits: QC_FAILED (the QC gate blocked the persist) and
// POSSIBLE_DUPLICATE_ENTITY (the semantic-duplicate check blocked it). Named here
// so the branch reads intent, not a bare string literal.
export const TOOL_ERROR_QC_FAILED = "QC_FAILED";
export const TOOL_ERROR_POSSIBLE_DUPLICATE = "POSSIBLE_DUPLICATE_ENTITY";
// STALE_WRITE (docs/lsp-support-plan.md Stage 5): an optimistic-concurrency reject.
// define_* takes an optional expectedRevision; when the entity's current revision no
// longer matches, someone wrote in between, so the upsert refuses to clobber and
// returns this code. The LSP write path (lsp/server.ts) branches on it to warn the
// editor + push a opentide/documentChanged reload rather than re-derive squiggles.
export const TOOL_ERROR_STALE_WRITE = "STALE_WRITE";
// RENAME_REJECTED (docs/lsp-support-plan.md Stage 7): the atomic-rename verb
// (LSP_RENAME_TOOL) rejects the WHOLE rename — nothing half-applied — when any affected
// entity would fail compile/QC, or the new entity name collides with an existing one.
// The rejected entities ride in the result's `data.failures`; the LSP path surfaces them
// as diagnostics/toasts and applies no registry change.
export const TOOL_ERROR_RENAME_REJECTED = "RENAME_REJECTED";

// Default loopback port for the headless control server (`deno task kernel` /
// `opentide serve`). Overridable with `--port` (mirroring desktop-main.ts and
// `mcp --port`) so a headless serve can step around a port already held by a
// running IDE kernel. Distinct from app preview (:3001) and MCP HTTP (:3005).
export const CONTROL_SERVER_PORT = 3003;

// Default loopback port for a project's app-preview server (the user app under
// development). The headless `serve` root now defaults the app port to 0
// (OS-assigned free port) so two stacks never collide; this constant is the
// stable fallback for programmatic callers that don't specify one (tests,
// `loadProject` without an explicit appPort). The IDE reads the actual bound
// port back from the kernel, so a dynamic port is transparent to the client.
export const APP_SERVER_PORT = 3001;

// Sentinel app port meaning "let the OS assign a free port" (Deno.serve binds a
// free ephemeral port when given 0, exposed back via server.addr.port). Passing
// this is how the headless serve and desktop roots avoid app-port collisions.
export const APP_PORT_AUTO = 0;

// The semantic codes in the platform's own 404/405 envelopes (F-03/F-04). TWO places
// answer a route miss for a user app — the live preview (core/app-server.ts) and the
// app export's emitted shell (core/export.ts interpolates these into the emitted
// source) — and CLAUDE.md requires both to answer `{ error: true, code, message }`
// "including its framework-level 404/405 envelopes". Held here so the two spellings
// cannot drift apart.
export const ROUTE_NOT_FOUND_CODE = "NOT_FOUND";
export const ROUTE_METHOD_NOT_ALLOWED_CODE = "METHOD_NOT_ALLOWED";

// The `access-control-allow-methods` list a CORS preflight is answered with, in both
// hosts. Pinned rather than derived, and that is the improvement: it started life as
// Hono's `cors()` default, which CHANGES between versions — QUERY arrived in 4.13.1 —
// so the two hosts advertised different method lists purely because the kernel's lock
// (hono@4.12.21) is behind the version an exported app installs (4.13.1). Held here so
// the answer no longer depends on which Hono resolved where.
export const CORS_ALLOW_METHODS = "GET,HEAD,PUT,POST,DELETE,PATCH,QUERY";

// The app config naming a user handler that sees every matched request first, in both
// hosts — the preview reads it per request, the export bakes it in at export time. The
// gate gets a body-less copy of the request and `{ params, route: { method, path } }`,
// and answers null to let the request through or a Response to answer it. It runs after
// route matching and before platform routes, validation and the handler, so it covers
// /_assets and the OpenAPI spec too; a route miss is never gated. It fails CLOSED: a
// throw or an answer that is neither null nor a Response is a 500, and so is a missing
// gate handler in the preview (the export refuses to build). With a gate set, responses
// stop carrying `access-control-allow-origin: *` and an unrouted OPTIONS is a route miss
// rather than a preflight — an app behind a login is not a public API.
export const APP_AUTH_GATE_CONFIG = "APP_AUTH_GATE";

// --- Source-backed dev server (project import, Slice 3) ---
// An imported project runs on its own native runtime (`npm run dev` / `deno task
// dev`) as a child process; Genie's app-preview listener proxies to it. These
// tunables govern that child's lifecycle in core/dev-server.ts — no magic numbers
// in the process manager.

// How long DevServerManager.start waits for the child to bind an accepting port
// before declaring the start failed (and tearing the child down). Generous: a
// cold dev server may install deps / cold-compile before it binds.
export const DEV_SERVER_STARTUP_TIMEOUT_MS = 60_000;

// Interval between readiness probes (TCP connect) against the candidate port.
export const DEV_SERVER_PORT_PROBE_INTERVAL_MS = 250;

// Grace period after SIGTERM before DevServerManager escalates to SIGKILL on the
// child (and its descendants). Lets a dev server flush and exit cleanly first.
export const DEV_SERVER_STOP_GRACE_MS = 3_000;

// Max stdout/stderr lines DevServerManager retains in its bounded log tail (also
// mirrored into the kernel structured log). Older lines are dropped once full, so
// a chatty dev server can't grow memory without bound. Surfaced by the status API.
export const DEV_SERVER_LOG_TAIL_LINES = 200;

// Env var used to hint the child dev server which port to bind (near-universal
// Node convention — Vite/Next/Express/Nest all honor PORT). Set when the resolved
// run config pins a fixed child port so detection is deterministic, not banner-parsed.
export const DEV_SERVER_PORT_ENV = "PORT";

// --- Project source files (browse + source-backed editing) ---

// Max UTF-8 byte size of a project file the control server will read into a JSON
// body (GET /api/files/*) or write through a source-backed edit. A file above
// this is truncated on read and refused on write (FILE_TOO_LARGE) — never
// silently truncated on write. Shared by the file browser and the source-editor
// so both agree on what "too large to round-trip as text" means.
export const MAX_FILE_CONTENT_BYTES = 128 * 1024;

// Max number of app-source entries `gitStatus` puts on the wire in its `files[]`
// array before setting `truncated: true`. Everything under `.opentide/` is already
// excluded from `files[]` (rolled into `projectState` counts), so this only bites
// on a genuinely huge app-source diff. The totals (`changedCount`,
// `untrackedCount`) are never capped, so the count stays honest either way.
// Sized so the worst case stays around 10 KB on the wire — `git_status` was the
// single largest tool result at 64.9 KB/call before the split (see
// docs/agent-cost-reduction.md §4.4).
export const GIT_STATUS_FILE_LIMIT = 100;

// Path prefix under a project that holds Tide's own state and provenance tree.
// Changes below it are summarised, not listed, by `gitStatus`.
export const TIDE_PROJECT_STATE_PREFIX = ".opentide/";

// The `.gitignore` a new Tide project is scaffolded with, and the one an exported
// project carries. ONE constant: this template used to exist as two byte-identical
// copies (project-manager.ts and export.ts) that had already drifted behind the
// on-disk file real projects carry, which is how you end up with a third.
//
// What is ignored under `.opentide/` is deliberately narrow — only the
// machine-local, per-install churn. `changelog/`, `changesets/`, `sessions/` and
// `verification-ledger.json` are the provenance chain and stay tracked: a clone
// without them has changesets referencing a changelog that is not there.
export const PROJECT_GITIGNORE = `# Local secrets and environment overrides.
.env

# Local app/test database rows. Export intentional seed data to fixtures/.
data/

# Build output.
dist/

# Local caches and generated backups.
.opentide/caches/
.opentide/backups/

# Machine-local agent telemetry and cursors. Everything else under
# .opentide/history/ is provenance and stays tracked.
.opentide/history/usage/
.opentide/history/model-usage.jsonl
.opentide/history/survival.jsonl
.opentide/history/episodes.jsonl
.opentide/history/cursor.json
.opentide/history/cache-composition.jsonl

# Task forks are machine-local: their records name directories on this machine.
.opentide/tasks.json

# Changeset start snapshots: local undo points, pruned to a setting.
.opentide/snapshots/

# A running server's lock, bearer token and log. The token grants full
# control of the server, so it must never be committed.
.opentide/kernel.lock
.opentide/kernel.token
.opentide/serve.log
`;

// Top-level file names hidden from the file browser and refused as edit targets
// (secrets / kernel manifest). Kept here so the browser and the source-editor
// enforce one list.
export const PROJECT_FILE_IGNORED_FILES: readonly string[] = [
  "opentide.json",
  ".env",
];

// Directory names never descended into by the browser and never written into by
// a source-backed edit — build output, VCS, dependencies, and Genie's own state.
// A write whose path passes through any of these segments is refused (IGNORED_PATH).
export const PROJECT_FILE_IGNORED_DIRS: readonly string[] = [
  "assets",
  "data",
  "node_modules",
  ".git",
  "dist",
  ".genie",
];

// The changelog category a source-backed file edit is recorded under. It reuses
// `module` (the closest existing kind) rather than adding a ChangeCategory, so the
// shared/ wire contract and the MCP surface stay stable; a source-backed record is
// told apart from a registry `module` record by context.sourceBacked === true.
// See docs/project-import-strategy.md "Slice 5".
export const SOURCE_EDIT_CHANGE_CATEGORY: ChangeCategory = "module";

// --- Source-backed project commands (project import, Slice 6) ---
// A discovered project command (test/build/lint/typecheck/format/…) from the
// codebase graph's allow-list is run through the login shell like the dev server,
// but as a one-shot: CommandRunner streams its output into the kernel structured
// log, enforces this timeout, and tree-kills the child (and its descendants) on
// cancel/timeout/shutdown so a forking package manager (npm test → node → vitest)
// leaves no orphan. Distinct from DEV_SERVER_STARTUP_TIMEOUT_MS: that bounds how
// long a long-LIVED dev server may take to bind a port; this bounds a whole
// one-shot run (a test suite or build can legitimately run for minutes).
export const SOURCE_COMMAND_TIMEOUT_MS = 300_000;

// Grace period after SIGTERM before CommandRunner escalates to SIGKILL on the
// child process tree (mirrors DEV_SERVER_STOP_GRACE_MS for the dev server).
export const SOURCE_COMMAND_STOP_GRACE_MS = 3_000;

// Max chars of stdout (and, separately, stderr) CommandRunner captures into the
// returned transcript before middle-truncating (mirrors core/shell.ts). Keeps a
// chatty test/build run bounded in the JSON response.
export const SOURCE_COMMAND_MAX_OUTPUT_CHARS = 80_000;

// Max stdout/stderr lines CommandRunner retains in its bounded live log tail
// (surfaced by GET /api/commands/status), independent of the captured transcript.
export const SOURCE_COMMAND_LOG_TAIL_LINES = 200;

// --- Orchestrator (Feature B) ---
// The multi-project orchestrator supervises one `opentide serve --project X`
// child per running project (docs/orchestrator-design.md §6.4). These are the
// supervisor's tunables — no magic numbers in the reconciler.

// The orchestrator's own dashboard port (§6.4). B1c serves NO HTTP, so nothing
// binds this yet — it is defined ready for B3's dashboard + repurposed /projects
// picker. Deliberately BELOW the child port base (3101) so it is memorable, and
// distinct from CONTROL_SERVER_PORT (3003) so a standalone kernel and the
// orchestrator can run side by side without colliding.
export const ORCHESTRATOR_DASHBOARD_PORT = 3100;

// Base of the control-port pool handed to spawned children. Walks upward from
// here to the next free port, skipping ports already assigned to live children.
// Kept clear of the orchestrator's own dashboard (CONTROL_SERVER_PORT = 3003)
// and a stray app-preview server (APP_SERVER_PORT = 3001) so nothing collides.
export const ORCHESTRATOR_CHILD_PORT_BASE = 3101;

// How many ports above the base the allocator will probe before giving up (a
// child then moves to actualState="failed"). Bounds the transient test-bind scan.
export const ORCHESTRATOR_CHILD_PORT_RANGE = 200;

// How long the supervisor waits for a spawned child's ready line before treating
// the start as failed (SIGTERM + retry per §3.4). Generous: a cold child compiles
// its project and loads PGlite before it binds.
export const ORCHESTRATOR_READY_TIMEOUT_MS = 30_000;

// Grace period after SIGTERM before the supervisor escalates to SIGKILL on stop
// (and on shutdownAll). A child flushes its DB and unloads the project in between.
export const ORCHESTRATOR_STOP_TIMEOUT_MS = 10_000;

// Max spawn attempts for a single start before actualState="failed" (§3.4). Each
// exit-before-ready reallocates a fresh port and respawns, up to this many times.
export const ORCHESTRATOR_MAX_START_RETRIES = 3;

// Max automatic crash restarts within a backoff window before actualState="failed"
// (§6.3). restartCount resets once a child stays running past the stability window.
export const ORCHESTRATOR_MAX_RESTARTS = 5;

// Interval between child health polls (GET /api/status). A child whose process is
// alive but whose status endpoint fails repeatedly is treated as hung → restart.
export const ORCHESTRATOR_HEALTH_INTERVAL_MS = 5_000;

// Consecutive failed health polls that mark an alive-but-unresponsive child hung.
export const ORCHESTRATOR_HEALTH_MAX_FAILURES = 3;

// Exponential-backoff schedule for start-retry and crash-restart: delay =
// min(cap, base * 2^(attempt-1)) plus jitter, so a crash-looping child backs off
// instead of hammering the port pool.
export const ORCHESTRATOR_BACKOFF_BASE_MS = 1_000;
export const ORCHESTRATOR_BACKOFF_CAP_MS = 30_000;

// A child that stays running this long has its restartCount reset to 0, so a
// stable child that crashes much later gets a fresh restart budget (§6.3).
export const ORCHESTRATOR_STABILITY_WINDOW_MS = 60_000;

// Max stdout/stderr lines the supervisor retains per child in its bounded ring
// buffer (Feature B / B4b). Older lines are dropped once the cap is hit, so a
// chatty or long-lived child can't grow memory without bound. The buffer is kept
// across a crash/exit (so a dead child's crash tail stays readable) and cleared
// only on a fresh manual start. Surfaced by GET /api/orchestrator/logs.
export const ORCHESTRATOR_LOG_BUFFER_LINES = 500;

// Env var passed through to every spawned child when set on the orchestrator, so
// children share the parent's Postgres data source (plan line 549). Read via
// Deno.env; named here so the supervisor doesn't inline the literal.
export const OPENTIDE_DB_URL_ENV = "OPENTIDE_DB_URL";

// Read-side override for the orchestrator state-file location. When set, it wins
// over getTideDir()/orchestrator.json — the clean seam an integration test (or a
// side-by-side orchestrator) uses to point at a temp state file without touching
// the real ~/.config/opentide/orchestrator.json. Read via Deno.env in
// getOrchestratorStatePath(); named here so state.ts doesn't inline the literal.
export const OPENTIDE_ORCHESTRATOR_STATE_PATH_ENV =
  "OPENTIDE_ORCHESTRATOR_STATE_PATH";

// Kernel log persistence is coalesced on this debounce: persisting the full
// ring buffer on every log() call would block the event loop under request
// volume. Flushes still happen immediately on clear/restore/shutdown.
export const LOG_PERSIST_DEBOUNCE_MS = 1_000;

// Max bounded repair sub-turns the per-step execution loop runs when a step
// fails its gate before halting and surfacing to the user (per-step-execution
// plan, Stage 4). Defined here so the constant has a single home; consumed by
// the step orchestrator in a later stage.
export const MAX_STEP_REPAIRS = 2;

// The light-lane budget (proportional verification). A changeset stays in the
// reduced-ceremony lane only while it touches at most this many distinct entities
// across at most this many plan steps. These are blast-radius caps, not size
// preferences: past them the change is broad enough that the full gate — authored
// criteria, adversarial review, a human approval — is the proportionate response.
export const LIGHT_TIER_MAX_ENTITIES = 3;
export const LIGHT_TIER_MAX_STEPS = 2;

// Attempts (initial run + retries) the browser gate makes before it surfaces a
// page-error failure (per-step-execution plan, Stage 6). Browser launch failures fail
// immediately because browser support is a required agent capability; this retry
// count only filters transient page errors after Chromium successfully launches.
export const BROWSER_GATE_ATTEMPTS = 2;

// User-facing test/browser timeout bounds. Stored in milliseconds, surfaced in
// Settings as seconds.
export const KERNEL_TIMEOUT_MIN_MS = 1_000;
export const KERNEL_TIMEOUT_MAX_MS = 300_000;
export const TEST_TIMEOUT_DEFAULT_MS = 60_000;
export const BROWSER_ACTION_TIMEOUT_DEFAULT_MS = 10_000;

// The token that opens a step's handoff block — a protocol shared between the
// producer (each brain's handoff instruction tells the model to end its turn
// with this marker) and the consumer (the step orchestrator's parseHandoff,
// which slices from the last occurrence to end of text). Lives in core so both
// the open loop and either brain can reference it without a magic string
// (per-step-execution plan, Stage 3).
export const HANDOFF_MARKER = "HANDOFF:";

// Auto-compaction tuning (context-hardening plan, Slice 4). Declared before
// KERNEL_DEFAULTS so AUTOCOMPACT_ENABLED_DEFAULT — and the two occupancy ratios
// below — are initialized when they back the corresponding kernel-setting defaults
// (no temporal-dead-zone reference).
//
// AUTOCOMPACT_RETAINED_TURNS raw recent messages are carried PAST the self-generated
// summary into the fresh window so an auto-compact reads more smoothly than a
// summary-only reset. AUTOCOMPACT_ENABLED_DEFAULT gates the whole pre-turn guard —
// the plan wants it disableable if a provider's usage accounting proves unreliable;
// Slice 6 surfaces it in the config cascade, for now it is the default backing the
// autoCompactEnabled kernel setting.
export const AUTOCOMPACT_RETAINED_TURNS = 4;
export const AUTOCOMPACT_ENABLED_DEFAULT = true;

// Occupancy thresholds the loop trips on (nudge banner / pre-turn auto-compact).
// Defined here — above KERNEL_DEFAULTS — so they back the contextNudgeRatio /
// contextAutoCompactRatio kernel-setting defaults without a temporal-dead-zone
// reference (Slice 6 moved them up from below for exactly that; every context
// threshold still lives in one place — CLAUDE.md: no magic numbers). These are the
// constant-layer defaults; getKernelSettings resolves the effective values through
// the file → env → constant cascade.
export const CONTEXT_NUDGE_RATIO = 0.80;
export const CONTEXT_AUTOCOMPACT_RATIO = 0.95;

// Env-var names for the Slice-6 context-tuning cascade (file → env → constant),
// named so nothing inlines a magic string (CLAUDE.md), mirroring the OPENTIDE_TELEMETRY_*
// env naming. The two ratios take a finite number in (0, 1]; OPENTIDE_AUTO_COMPACT_ENABLED
// takes "0"/"1". An unset or invalid env value falls through to the file value, then
// the constant — see normalizeContextRatio / getKernelSettings.
export const OPENTIDE_CONTEXT_NUDGE_RATIO_ENV = "OPENTIDE_CONTEXT_NUDGE_RATIO";
export const OPENTIDE_CONTEXT_AUTOCOMPACT_RATIO_ENV =
  "OPENTIDE_CONTEXT_AUTOCOMPACT_RATIO";
export const OPENTIDE_AUTO_COMPACT_ENABLED_ENV =
  "OPENTIDE_AUTO_COMPACT_ENABLED";

// The cost-driven working ceiling, distinct from the model's hard window (agent cost
// reduction, §4.6). A 1M-window model will happily accept 800k of context and bill
// $0.50/MTok to re-read it on every tool round-trip. Cap the *working* budget well
// below the window so the loop compacts on economics, not on overflow. It never
// RAISES the budget above the model's real one — effectiveInputBudget
// (core/context-window.ts) takes the Math.min of the two, so on a 128K model this is
// a no-op. A token COUNT, not a ratio: it has its own normalizer
// (normalizeWorkingBudgetTokens), not normalizeContextRatio.
export const CONTEXT_WORKING_BUDGET_TOKENS = 200_000;
export const OPENTIDE_CONTEXT_WORKING_BUDGET_ENV =
  "OPENTIDE_CONTEXT_WORKING_BUDGET";

// The floor a configured working budget must clear. Below this nothing works — the
// system prompt and tool schemas alone are a five-figure token count — so a typo
// (200 instead of 200_000) fails SAFE to CONTEXT_WORKING_BUDGET_TOKENS rather than
// landing at a boundary that bricks every turn. Same skip-never-clamp philosophy as
// normalizeContextRatio.
export const CONTEXT_WORKING_BUDGET_MIN_TOKENS = 20_000;

// In-turn tool-result pruning (agent cost reduction, §4.7). The pre-turn guard
// measures occupancy ONCE per sendMessage; the turn then makes dozens of provider
// requests against a context that only grows — on the measured changeset, 67 requests
// carrying 200k → 450k tokens with no check in between. CONTEXT_PRUNE_RATIO is the
// mid-turn trigger, deliberately BELOW the 0.80 nudge and 0.95 auto-compact ratios:
// stubbing old tool output is the cheap intervention, so it fires before either
// expensive one. CONTEXT_RETAIN_TOOL_RESULTS is how many of the most recent tool
// results survive a prune untouched — enough that the model still sees what it just
// did. Results under CONTEXT_PRUNE_MIN_RESULT_BYTES are left alone: stubbing a
// 40-byte run_tests result invalidates the cached prefix from that point on and
// reclaims nothing.
// Corrected 2026-09-14 from 0.60 (§8's re-measurement). 0.60 against the 200k
// working budget trips at 120k, in a turn measured to PEAK at 151,663 — so it fired
// twice as a routine cost optimisation on a turn that was never near the budget, and
// netted -$0.21. 0.85 puts it above the measured 0.758 peak with ~12% headroom for
// turn-to-turn variance, and 10 points clear of the 0.95 auto-compact so the cheap
// intervention still has room to defer the expensive one. Deliberately NOT the same
// value as the 0.80 nudge: the nudge is advisory and routinely clears on its own; the
// trim is an action and should not share a threshold with a warning.
export const CONTEXT_PRUNE_RATIO = 0.85;
export const OPENTIDE_CONTEXT_PRUNE_RATIO_ENV = "OPENTIDE_CONTEXT_PRUNE_RATIO";
export const CONTEXT_RETAIN_TOOL_RESULTS = 12;
export const CONTEXT_PRUNE_MIN_RESULT_BYTES = 2_048;

// The cost gate in front of every prefix mutation (agent cost reduction, §8). A trim
// rewrites the cached prefix ONCE and saves a re-read on every request that follows,
// so it pays iff
//
//     rewritten / reclaimed  <  remaining requests / 12.5
//
// where 12.5 = cache-write price / cache-read price ($6.25 / $0.50 per MTok, i.e.
// CACHE_CREATION_MULTIPLIER / the cache-read multiplier). `remaining requests` is NOT
// observable at trim time — the loop cannot know how many more provider requests the
// turn will make — so this constant fixes the half that is: the ceiling on
// rewritten/reclaimed, which is equivalent to ASSUMING 12.5 x this many requests
// remain. At 2.0 that is ~25 remaining requests.
//
// 2.0 sits between the two measured prunes on turn_mu0zfxi7: prune 1 rewrote 1.69x
// what it reclaimed and netted +$0.16; prune 2 rewrote 2.76x and netted -$0.36. Those
// are the provider's real tokens, while the gate computes the ratio in the context
// meter's chars/4 estimate — and on that turn the two agree closely (est 1.67 vs real
// 1.69; est 2.72 vs real 2.76), because numerator and denominator are both dominated
// by tool traffic and the under-count cancels. Don't assume it cancels on a turn with
// a different mix; re-check against a trace before moving this number far.
export const CONTEXT_PRUNE_MAX_REWRITE_RATIO = 2.0;
export const OPENTIDE_CONTEXT_PRUNE_MAX_REWRITE_RATIO_ENV =
  "OPENTIDE_CONTEXT_PRUNE_MAX_REWRITE_RATIO";

// The SAFETY tier of the mid-turn trim (agent cost reduction, §8). Measured against
// the model's real input CAPACITY — contextWindowFor - maxOutputTokensFor -
// CONTEXT_SAFETY_MARGIN — not against the cost-driven working budget, because those
// are two different walls and only one of them is fatal. CONTEXT_PRUNE_RATIO and
// CONTEXT_PRUNE_MAX_REWRITE_RATIO decide whether a trim is worth PAYING FOR; this one
// decides whether the turn survives, so when it fires the trim is unconditional: the
// rewrite-ratio ceiling and the arm-once brake are both bypassed. A $0.50 rewrite
// beats a failed turn.
//
// 0.90 sits above CONTEXT_PRUNE_RATIO (0.85) on purpose — the cost tier gets first
// refusal across that band, and the valve only takes over once refusing has become
// the more expensive option. On a model where the WINDOW binds (capacity ==
// effectiveInputBudget), the two tiers measure the same number and this is simply an
// ungated trim 0.05 higher up.
//
// Headroom at 0.90, i.e. what is left between the trim and the capacity line:
//   claude-haiku-4-5   capacity 132_000 → fires at 118_800, 13_200 tokens of room
//   unknown id / 128K  capacity  92_000 → fires at  82_800,  9_200 tokens of room
// Behind that line sit the output reservation and the safety margin (68_000 and
// 36_000 respectively), which the request can eat into before the provider's hard
// window actually rejects it. So the real cushion is larger than the headroom; 0.90
// is chosen so a trim fires while a typical tool round-trip (a few thousand tokens)
// still fits in front of the capacity line, not after it.
export const CONTEXT_PRUNE_SAFETY_RATIO = 0.90;
export const OPENTIDE_CONTEXT_PRUNE_SAFETY_RATIO_ENV =
  "OPENTIDE_CONTEXT_PRUNE_SAFETY_RATIO";

// How long the loop must have been idle before it treats the provider's cached
// prefix as GONE (agent cost reduction, §4.8). Anthropic's default ephemeral cache
// entry lives 5 minutes and every read refreshes it, so an idle gap longer than that
// means the next request rewrites the whole prefix whatever we do — which is the one
// moment when mutating it is free. 330s = the 300s TTL plus 30s of slack, so the
// judgement errs toward "still warm" (declines to mutate) rather than paying an
// unnecessary rewrite on a bad guess.
export const CACHE_COLD_PREFIX_IDLE_MS = 330_000;

// Growth the arm-once brake demands before a second prune in the same window:
// occupancy must reach 1.25x what it was at the last prune. A prune rewrites the
// middle of the prefix, so it costs one cache write from the first stubbed block
// onward — the whole strategy is "one big step, rarely". Pruning one block per
// request would invalidate the prefix on EVERY request and cost more than doing
// nothing at all.
export const CONTEXT_PRUNE_REARM_GROWTH = 1.25;

// Inline notice shown once per trim — sibling of CONTEXT_NUDGE_MESSAGE and
// CONTEXT_AUTOCOMPACT_MESSAGE. Emitted as transient stream text, not persisted.
// Deliberately vague about WHAT was trimmed: one trim can stub old tool results
// (§4.7), drop settled turns' reasoning (§4.8), or both.
export const CONTEXT_PRUNE_NOTICE =
  "*Trimmed older context to keep it healthy.*";

// Chars-per-token divisor for the cheap pre-turn token estimate (Slice 4): the
// standard ~4-chars-per-token approximation, no bundled tokenizer (plan non-goal).
export const TOKEN_ESTIMATE_CHARS_PER_TOKEN = 4;

// --- Cache-composition trace (agent cost reduction, §8) ---

// Env override for the cacheCompositionTrace kernel setting: "1" on, "0" off,
// anything else falls through to the file value. Same shape as
// OPENTIDE_AUTO_COMPACT_ENABLED.
export const OPENTIDE_CACHE_TRACE_ENABLED_ENV = "OPENTIDE_CACHE_TRACE";

// Filename of the per-request cache-composition trace, written under the project's
// history dir alongside model-usage.jsonl. Local capture, never egress.
export const CACHE_COMPOSITION_TRACE_FILE = "cache-composition.jsonl";

// Inline copy carried in the session_compacted event (Slice 4), shown when the
// pre-turn guard auto-compacts. Sibling of CONTEXT_NUDGE_MESSAGE.
export const CONTEXT_AUTOCOMPACT_MESSAGE =
  "↻ Compacted to keep context healthy.";

// --- Database backups ---

// How much work a periodic backup is allowed to leave unprotected. Consulted by
// backup-cadence.ts, which every face that drives the kernel goes through — the IDE
// (per completed chat turn) and an external MCP agent (before a mutating tool call).
// Ten minutes is the interval the IDE used inline before the two faces shared a clock.
export const DB_BACKUP_INTERVAL_MS = 10 * 60 * 1000;

// How long a PGlite project is allowed to run with writes that exist only inside the
// process. PGlite's emscripten filesystem has no working fsync, so an unclean exit
// between checkpoints does not cost the recent writes — it costs the data directory,
// which then refuses to open at all. A checkpoint is cheap next to a backup (no rows
// are read and nothing is serialised), so this interval is much shorter than
// DB_BACKUP_INTERVAL_MS: it bounds how much of a session an unclean kill can destroy.
export const DB_CHECKPOINT_INTERVAL_MS = 60 * 1000;

// --- Kernel settings defaults ---

const KERNEL_DEFAULTS: Required<KernelSettings> = {
  handlerTimeoutMs: 30_000,
  scriptTimeoutMs: 30_000,
  auditTimeoutMs: 55_000,
  cdpTimeoutMs: 10_000,
  testTimeoutMs: TEST_TIMEOUT_DEFAULT_MS,
  browserActionTimeoutMs: BROWSER_ACTION_TIMEOUT_DEFAULT_MS,
  maxSnapshots: 20,
  maxDbBackups: 10,
  maxChangesetSnapshots: MAX_CHANGESET_SNAPSHOTS_DEFAULT,
  maxTraces: 50,
  maxBodyCapture: 16_384,
  maxAuditResults: 5,
  autoRefuteAtGate: true,
  independentCriteriaAtGate: true,
  readinessEnforcement: "advisory",
  proportionalVerification: "auto",
  verificationLedgerRetention: 0,
  episodeLogEnabled: true,
  episodeLogRetention: 0,
  perStepExecution: true,
  autoCompactEnabled: AUTOCOMPACT_ENABLED_DEFAULT,
  cacheCompositionTrace: false,
  contextNudgeRatio: CONTEXT_NUDGE_RATIO,
  contextAutoCompactRatio: CONTEXT_AUTOCOMPACT_RATIO,
  contextPruneRatio: CONTEXT_PRUNE_RATIO,
  contextPruneMaxRewriteRatio: CONTEXT_PRUNE_MAX_REWRITE_RATIO,
  contextPruneSafetyRatio: CONTEXT_PRUNE_SAFETY_RATIO,
  contextWorkingBudgetTokens: CONTEXT_WORKING_BUDGET_TOKENS,
};

const DEFAULT_TELEMETRY_SETTINGS: Omit<
  Required<TelemetrySettings>,
  "installationId"
> = {
  enabled: readEnv("OPENTIDE_TELEMETRY_ENABLED") === "1",
  endpoint: readEnv("OPENTIDE_TELEMETRY_ENDPOINT") ?? "",
  releaseChannel: normalizeReleaseChannel(
    readEnv("OPENTIDE_RELEASE_CHANNEL"),
  ),
  syncIntervalMs: 30_000,
  maxBatchSize: 50,
  includeDiagnosticsByDefault: false,
  // A never-consented install is inert and anonymous: no consent, no grant
  // timestamp, both categories off. These defaults are what a fresh config reads.
  consentVersion: 0,
  consentGrantedAt: "",
  consent: { telemetry: false, feedback: false },
};

export function getKernelSettings(): Required<KernelSettings> {
  const config = readConfig();
  const merged = { ...KERNEL_DEFAULTS, ...config.kernel };
  return {
    ...merged,
    readinessEnforcement: normalizeReadinessEnforcement(
      merged.readinessEnforcement,
    ),
    proportionalVerification: normalizeProportionalVerification(
      merged.proportionalVerification,
    ),
    // Slice-6 context tuning: each knob resolves through file → env → constant. The
    // merged value already folds the file over the constant; the env override (when
    // set + valid) wins over that. Ratios are clamped INDEPENDENTLY — the loop
    // tolerates any ordering (an inverted nudge just fires closer to / after the
    // auto-compact point), so nudge ≤ autoCompact is not hard-enforced here.
    contextNudgeRatio: normalizeContextRatio(
      merged.contextNudgeRatio,
      OPENTIDE_CONTEXT_NUDGE_RATIO_ENV,
      CONTEXT_NUDGE_RATIO,
    ),
    contextAutoCompactRatio: normalizeContextRatio(
      merged.contextAutoCompactRatio,
      OPENTIDE_CONTEXT_AUTOCOMPACT_RATIO_ENV,
      CONTEXT_AUTOCOMPACT_RATIO,
    ),
    contextPruneRatio: normalizeContextRatio(
      merged.contextPruneRatio,
      OPENTIDE_CONTEXT_PRUNE_RATIO_ENV,
      CONTEXT_PRUNE_RATIO,
    ),
    contextPruneMaxRewriteRatio: normalizePositiveRatio(
      merged.contextPruneMaxRewriteRatio,
      OPENTIDE_CONTEXT_PRUNE_MAX_REWRITE_RATIO_ENV,
      CONTEXT_PRUNE_MAX_REWRITE_RATIO,
    ),
    contextPruneSafetyRatio: normalizeContextRatio(
      merged.contextPruneSafetyRatio,
      OPENTIDE_CONTEXT_PRUNE_SAFETY_RATIO_ENV,
      CONTEXT_PRUNE_SAFETY_RATIO,
    ),
    contextWorkingBudgetTokens: normalizeWorkingBudgetTokens(
      merged.contextWorkingBudgetTokens,
    ),
    autoCompactEnabled: normalizeAutoCompactEnabled(merged.autoCompactEnabled),
    cacheCompositionTrace: normalizeCacheCompositionTrace(
      merged.cacheCompositionTrace,
    ),
    testTimeoutMs: normalizeKernelTimeoutMs(
      merged.testTimeoutMs,
      KERNEL_DEFAULTS.testTimeoutMs,
    ),
    browserActionTimeoutMs: normalizeKernelTimeoutMs(
      merged.browserActionTimeoutMs,
      KERNEL_DEFAULTS.browserActionTimeoutMs,
    ),
    maxChangesetSnapshots: normalizeMaxChangesetSnapshots(
      merged.maxChangesetSnapshots,
    ),
  };
}

// Env (a whole number ≥ 0) → file → default. Anything else is skipped, so a typo
// falls back to the default instead of turning snapshots off.
function normalizeMaxChangesetSnapshots(fileValue: number): number {
  const isValid = (n: number) => Number.isInteger(n) && n >= 0;
  const envRaw = readEnv(OPENTIDE_MAX_CHANGESET_SNAPSHOTS_ENV);
  if (envRaw !== undefined && envRaw !== "" && isValid(Number(envRaw))) {
    return Number(envRaw);
  }
  return isValid(fileValue) ? fileValue : MAX_CHANGESET_SNAPSHOTS_DEFAULT;
}

function normalizeReadinessEnforcement(
  value: string | undefined,
): ReadinessEnforcement {
  return value === "graduated" || value === "strict" ? value : "advisory";
}

// Mirrors normalizeReadinessEnforcement: an unrecognized value reads as the
// default rather than throwing, so a hand-edited config can never brick the gate.
function normalizeProportionalVerification(
  value: string | undefined,
): ProportionalVerification {
  return value === "always" || value === "never" ? value : "auto";
}

// A ratio is valid iff it is a finite number in (0, 1]. Resolution order:
// OPENTIDE_CONTEXT_*_RATIO env (parsed, must be valid) → the merged file value (must be
// valid) → the constant fallback. Any invalid input (NaN, ≤ 0, > 1, an unparseable
// env string) is skipped, never clamped-into-range, so a typo fails SAFE to the
// documented default rather than silently landing at a boundary.
function normalizeContextRatio(
  rawFileValue: number | undefined,
  envVar: string,
  fallback: number,
): number {
  const isValid = (n: number): boolean => Number.isFinite(n) && n > 0 && n <= 1;
  const envRaw = readEnv(envVar);
  if (envRaw !== undefined && envRaw !== "") {
    const parsed = Number(envRaw);
    if (isValid(parsed)) return parsed;
  }
  if (rawFileValue !== undefined && isValid(rawFileValue)) return rawFileValue;
  return fallback;
}

// normalizeContextRatio's sibling for a ratio that is NOT an occupancy fraction:
// rewritten/reclaimed is a cost ratio and is routinely above 1, so the (0, 1] clamp
// would reject every sane value. Same resolution order and same skip-never-clamp
// rule — env (parsed, must be valid) → merged file value → constant.
function normalizePositiveRatio(
  rawFileValue: number | undefined,
  envVar: string,
  fallback: number,
): number {
  const isValid = (n: number): boolean => Number.isFinite(n) && n > 0;
  const envRaw = readEnv(envVar);
  if (envRaw !== undefined && envRaw !== "") {
    const parsed = Number(envRaw);
    if (isValid(parsed)) return parsed;
  }
  if (rawFileValue !== undefined && isValid(rawFileValue)) return rawFileValue;
  return fallback;
}

// The working-budget sibling of normalizeContextRatio, in the same style: a valid
// value is a finite INTEGER at or above CONTEXT_WORKING_BUDGET_MIN_TOKENS.
// Resolution order: OPENTIDE_CONTEXT_WORKING_BUDGET env (parsed, must be valid) → the
// merged file value (must be valid) → CONTEXT_WORKING_BUDGET_TOKENS. Invalid input
// (NaN, a fraction, below the floor, an unparseable env string) is skipped, never
// clamped into range, so a typo fails safe to the documented constant.
function normalizeWorkingBudgetTokens(
  rawFileValue: number | undefined,
): number {
  const isValid = (n: number): boolean =>
    Number.isInteger(n) && n >= CONTEXT_WORKING_BUDGET_MIN_TOKENS;
  const envRaw = readEnv(OPENTIDE_CONTEXT_WORKING_BUDGET_ENV);
  if (envRaw !== undefined && envRaw !== "") {
    const parsed = Number(envRaw);
    if (isValid(parsed)) return parsed;
  }
  if (rawFileValue !== undefined && isValid(rawFileValue)) return rawFileValue;
  return CONTEXT_WORKING_BUDGET_TOKENS;
}

// The resolved working budget, for core/context-window.ts to Math.min against the
// model's real budget. A function, not a constant, because it reads settings: the
// cascade resolves per call so an IDE edit takes effect without a restart.
export function resolvedWorkingBudget(): number {
  return getKernelSettings().contextWorkingBudgetTokens;
}

// autoCompactEnabled shares the file → env → constant cascade (Slice 6). The
// OPENTIDE_AUTO_COMPACT_ENABLED env override takes "1" (on) / "0" (off); any other value
// (or unset) falls through to the merged file/constant boolean.
function normalizeAutoCompactEnabled(fileValue: boolean): boolean {
  const envRaw = readEnv(OPENTIDE_AUTO_COMPACT_ENABLED_ENV);
  if (envRaw === "1") return true;
  if (envRaw === "0") return false;
  return fileValue;
}

// cacheCompositionTrace shares the file → env → constant cascade, in the same
// shape as normalizeAutoCompactEnabled. Default FALSE: this is an instrument, not
// a feature, and it writes a line per provider request when on.
function normalizeCacheCompositionTrace(fileValue: boolean): boolean {
  const envRaw = readEnv(OPENTIDE_CACHE_TRACE_ENABLED_ENV);
  if (envRaw === "1") return true;
  if (envRaw === "0") return false;
  return fileValue;
}

function normalizeKernelTimeoutMs(value: number, fallback: number): number {
  return Number.isFinite(value) &&
      value >= KERNEL_TIMEOUT_MIN_MS &&
      value <= KERNEL_TIMEOUT_MAX_MS
    ? value
    : fallback;
}

export function formatKernelTimeoutMs(ms: number): string {
  const seconds = ms / 1_000;
  return Number.isInteger(seconds) ? `${seconds}s` : `${ms}ms`;
}

export function setKernelSettings(settings: KernelSettings): void {
  const config = readConfig();
  const nextKernel = { ...config.kernel, ...settings };
  if (Object.prototype.hasOwnProperty.call(settings, "testTimeoutMs")) {
    nextKernel.testTimeoutMs = normalizeKernelTimeoutMs(
      nextKernel.testTimeoutMs as number,
      KERNEL_DEFAULTS.testTimeoutMs,
    );
  }
  if (
    Object.prototype.hasOwnProperty.call(settings, "browserActionTimeoutMs")
  ) {
    nextKernel.browserActionTimeoutMs = normalizeKernelTimeoutMs(
      nextKernel.browserActionTimeoutMs as number,
      KERNEL_DEFAULTS.browserActionTimeoutMs,
    );
  }
  config.kernel = nextKernel;
  writeConfig(config);
}

// The per-request output-token ceiling the client-side loop's ModelProvider hands
// the model (multi-model harness). The client-side loop must set it explicitly.
// Generous so long agent turns are not truncated, and comfortably above any
// extended-thinking budget (which must fit under max output). A named constant, not
// an inline literal (CLAUDE.md).
//
// This is the DESIRED ceiling, not the one that ships: maxOutputTokensFor
// (core/context-window.ts) clamps it down to what the resolved model actually
// accepts, so a model with a smaller cap never receives an over-limit request.
export const LOCAL_LOOP_MAX_OUTPUT_TOKENS = 64_000;

// The output ceiling for a model whose real cap isn't known (unenumerated id, no
// live catalog entry). Deliberately below LOCAL_LOOP_MAX_OUTPUT_TOKENS and equal to
// the pre-hardening flat ceiling: an unrecognized model keeps exactly its old
// behaviour rather than being handed a limit its API may reject.
export const MAX_OUTPUT_TOKENS_DEFAULT = 32_000;

// Output-cap continuation (this is the fix for turns that stopped mid-write). A
// provider stop of "max_tokens" means the model ran out of output budget MID-ANSWER
// — a truncated turn, not a finished one. The loop resumes it by appending
// TURN_CONTINUATION_PROMPT as a user turn (the retained assistant message can't be
// the last one: trailing-assistant prefills are rejected on current Claude models)
// and re-requesting, at most MAX_TURN_CONTINUATIONS times per turn so a pathological
// turn can't spin forever. When the budget IS exhausted the turn settles with the
// max_tokens stop reason and MAX_OUTPUT_TRUNCATED_MESSAGE surfaces — a truncated
// turn is never silently reported as complete.
export const MAX_TURN_CONTINUATIONS = 3;
export const TURN_CONTINUATION_PROMPT =
  "Your previous message hit the output-token limit and was cut off mid-answer. " +
  "Continue exactly where you left off. Do not restart the file, repeat work you " +
  "already emitted, or re-explain what you were doing — resume from the cut-off " +
  "point. If you were writing a tool call, issue that tool call now.";
export const TURN_CONTINUATION_NOTICE =
  "*Output limit reached — continuing where the response was cut off.*";
export const MAX_OUTPUT_TRUNCATED_MESSAGE =
  "This turn hit the model's output-token limit and stayed truncated after " +
  `${MAX_TURN_CONTINUATIONS} continuation attempts. Ask the agent to continue, ` +
  "or break the change into smaller steps.";

// Context-window hardening (Slice 1, docs/context-hardening-plan.md). The
// per-model context ceiling the input-side budget measures against. No per-model
// window is enumerated (MODELS is empty, D7), so it is resolved family-first with
// a conservative default; a live per-model window discovered from the provider's
// catalog (persisted on the cached descriptor) wins over this table. The table is
// the FLOOR — a never-fetched model is always given a safe window.
//
// The default is deliberately conservative: a mis-detected window should fail
// SAFE (compact early) rather than LATE (a hard context-length error). See
// core/context-window.ts for the resolution order.
export const CONTEXT_WINDOW_DEFAULT = 128_000;

// Headroom subtracted from the raw window on top of the output cap: the system
// prompt + tool-schema tokens the turn accumulators don't see mid-assembly.
export const CONTEXT_SAFETY_MARGIN = 4_000;

// The family key each context-window entry is looked up under. Anthropic Claude
// families all carry a 200K window; OpenAI GPT families carry 128K. Keyed by a
// coarse family (not a model id) so a freshly launched model in a known family is
// covered without a hand edit — the same "resolve by family, default otherwise"
// shape pricing uses (resolvePricingTier / DEFAULT_PRICING in usage.ts).
export type ContextWindowFamily = "anthropic" | "openai";
export const CONTEXT_WINDOW_BY_FAMILY: Record<ContextWindowFamily, number> = {
  anthropic: 200_000,
  openai: 128_000,
};

// Human copy carried in the one-shot context_warning event (Slice 3). Kept here so
// the backend emit and the IDE banner fall back to one canonical string.
export const CONTEXT_NUDGE_MESSAGE =
  "Context ~80% full. Compact to keep responses sharp.";

// Reactive context-length recovery (context-hardening plan, Slice 5). When a request
// still overflows the model's real window despite the pre-turn estimate (the chars/4
// heuristic under-counted, or cached-prefix drift pushed it over), the loop
// auto-compacts and retries — at most MAX_CONTEXT_RECOVERY_ATTEMPTS times. A single
// unavoidable payload that still overflows after that (e.g. one huge pinned document
// compaction can't shrink) terminates the turn with CONTEXT_LENGTH_HARD_FLOOR_MESSAGE
// instead of looping compaction forever. Kept beside the other context copy.
export const MAX_CONTEXT_RECOVERY_ATTEMPTS = 1;
export const CONTEXT_LENGTH_HARD_FLOOR_MESSAGE =
  "This turn's content exceeds the model's context even after compaction — " +
  "unpin or split a large pinned document or attachment.";

export type { KernelSettings };

interface KernelSettings {
  handlerTimeoutMs?: number;
  scriptTimeoutMs?: number;
  auditTimeoutMs?: number;
  cdpTimeoutMs?: number;
  testTimeoutMs?: number;
  browserActionTimeoutMs?: number;
  maxSnapshots?: number;
  maxDbBackups?: number;
  maxChangesetSnapshots?: number;
  maxTraces?: number;
  maxBodyCapture?: number;
  maxAuditResults?: number;
  // When true, complete_changeset auto-runs adversarial refutation on any
  // `must` acceptance criterion lacking a fresh verdict (API-key permitting).
  autoRefuteAtGate?: boolean;
  // When true, complete_changeset asks an independently-prompted reviewer what
  // the change had to do for the user's request to be satisfied, and reports any
  // proposal no acceptance criterion covers. The refuter attacks the claims the
  // agent wrote; this is the only thing that asks whether those were the right
  // claims. Advisory by default — it reports gaps, it does not adjudicate them.
  independentCriteriaAtGate?: boolean;
  // Readiness enforcement policy (Phase 5B). "advisory" (default) keeps the
  // graduated readiness signals as non-blocking warnings; "graduated" promotes
  // the deterministic evidence codes to hard errors; "strict" also promotes the
  // model-dependent adversarial codes.
  readinessEnforcement?: ReadinessEnforcement;
  // Proportional verification (the light lane). "auto" (default) uses the agent's
  // per-task change-class declaration, kernel-verified; "always" starts every
  // changeset light; "never" disables the lane. See ProportionalVerification.
  proportionalVerification?: ProportionalVerification;
  // Max verification-ledger entries to retain (newest kept), pruned on boot.
  // 0 (default) keeps the full history unbounded.
  verificationLedgerRetention?: number;
  // A4 (Stream A): master switch for the append-only episode + survival log. True
  // by default — this is LOCAL capture (.opentide/history/*.jsonl), not egress, so
  // it needs no consent gate (that is A5's concern). Off ⇒ no EpisodeLog is wired
  // and no episodes/observations are written.
  episodeLogEnabled?: boolean;
  // Max episode + survival lines to retain (newest kept), pruned on boot. Mirrors
  // verificationLedgerRetention; 0 (default) keeps the full history unbounded.
  episodeLogRetention?: number;
  // When true, an approved multi-step plan executes as a per-step loop (one turn
  // per step against a fresh session, orchestrator-advanced status) instead of a
  // single giant turn. Default false keeps the current single-turn path; the flag
  // gates all per-step-execution behavior (per-step-execution plan, Stage 0).
  perStepExecution?: boolean;
  // Master switch for the pre-turn auto-compaction guard (context-hardening plan,
  // Slice 4). Default AUTOCOMPACT_ENABLED_DEFAULT (true); off ⇒ the loop never
  // auto-compacts, however high the pressure. Slice 6 surfaces it in the config
  // cascade (OPENTIDE_AUTO_COMPACT_ENABLED env override) + SettingsPanel toggle.
  autoCompactEnabled?: boolean;
  // Occupancy ratio (0, 1] at which a completed turn emits the one-shot 80%-nudge
  // context_warning (context-hardening plan, Slice 6). Tunable without a rebuild via
  // the file → env → constant cascade: this file value, overridden by the
  // OPENTIDE_CONTEXT_NUDGE_RATIO env var when set + valid, else CONTEXT_NUDGE_RATIO.
  // getKernelSettings returns the resolved effective value; an invalid input falls
  // back rather than clamping. Not order-constrained against contextAutoCompactRatio.
  contextNudgeRatio?: number;
  // Master switch for the per-request cache-composition trace (agent cost
  // reduction, §8). Default FALSE — a measuring instrument, off in normal use.
  // On ⇒ the local loop appends one line per provider request to
  // .opentide/history/cache-composition.jsonl: the five-way split of the outbound
  // context, the delta since the previous request, the cache breakpoint positions,
  // and that request's reported usage. Changes no loop behaviour. File → env
  // cascade (OPENTIDE_CACHE_TRACE=1/0).
  cacheCompositionTrace?: boolean;
  // Occupancy ratio (0, 1] at which the pre-turn reactive guard auto-compacts before
  // the next turn (context-hardening plan, Slice 6). Same file → env → constant
  // cascade as contextNudgeRatio: this file value, overridden by the
  // OPENTIDE_CONTEXT_AUTOCOMPACT_RATIO env var when set + valid, else
  // CONTEXT_AUTOCOMPACT_RATIO. Clamped independently of the nudge ratio.
  contextAutoCompactRatio?: number;
  // Occupancy ratio (0, 1] at which the loop stubs older tool results MID-turn
  // (agent cost reduction, §4.7). Same file → env → constant cascade as its two
  // siblings (OPENTIDE_CONTEXT_PRUNE_RATIO), clamped independently; gated by
  // autoCompactEnabled. Lower fires sooner and rewrites the cached prefix more
  // often, so it trades cache writes for a smaller re-read on every later request.
  contextPruneRatio?: number;
  // Ceiling on rewritten/reclaimed for any mid-turn prefix mutation (agent cost
  // reduction, §8). A trim pays its rewrite ONCE and collects its saving on every
  // later request, so this constant stands in for the unobservable "how many requests
  // are left" half of the break-even: a ceiling of C assumes 12.5 x C remaining
  // requests. File → env → constant cascade (OPENTIDE_CONTEXT_PRUNE_MAX_REWRITE_RATIO);
  // unlike its occupancy siblings it is a cost ratio, so it is not clamped to (0, 1].
  contextPruneMaxRewriteRatio?: number;
  // Occupancy ratio (0, 1] of the model's real input CAPACITY (window - output
  // reservation - safety margin) at which the mid-turn trim fires UNCONDITIONALLY
  // (agent cost reduction, §8). The safety tier: contextPruneRatio and
  // contextPruneMaxRewriteRatio ask whether a trim is worth its cost, this one asks
  // whether the turn survives, so when it trips both the rewrite-ratio ceiling and
  // the arm-once brake are bypassed. Measured against capacity rather than
  // effectiveInputBudget because the working budget is a COST ceiling on a
  // large-window model and a CAPACITY ceiling on a small-window one. Same file → env
  // → constant cascade as its occupancy siblings
  // (OPENTIDE_CONTEXT_PRUNE_SAFETY_RATIO); gated by autoCompactEnabled.
  contextPruneSafetyRatio?: number;
  // The cost-driven working context ceiling in TOKENS (agent cost reduction, §4.6).
  // effectiveInputBudget takes Math.min(model budget, this), so it can only ever
  // LOWER the budget — a 1M-window model stops being handed 868k of billable
  // re-read context on every tool round-trip. File → env → constant cascade
  // (OPENTIDE_CONTEXT_WORKING_BUDGET), floored at CONTEXT_WORKING_BUDGET_MIN_TOKENS;
  // an invalid value falls back to CONTEXT_WORKING_BUDGET_TOKENS. The right number
  // is empirical — sweep it against .opentide/history/model-usage.jsonl.
  contextWorkingBudgetTokens?: number;
}

export interface TelemetrySettings {
  enabled?: boolean;
  endpoint?: string;
  releaseChannel?: "dev" | "beta" | "stable";
  installationId?: string;
  syncIntervalMs?: number;
  maxBatchSize?: number;
  includeDiagnosticsByDefault?: boolean;
  // --- A5 consent (Stream A privacy gate) ---
  // The CONSENT_VERSION the user last answered the first-run prompt at. Absent or
  // below the current CONSENT_VERSION ⇒ treated as not-consented (egress blocked,
  // re-prompt shown). Stamped by setTelemetrySettings on any deliberate answer.
  consentVersion?: number;
  // ISO 8601 timestamp of the first grant. Absent until a category is granted;
  // preserved across revoke/re-grant so it records when consent first started.
  consentGrantedAt?: string;
  // Per-category egress opt-in. No byte leaves the machine for a category that is
  // false — see egressAllowed() in telemetry.ts. Defaults to both-false.
  consent?: TelemetryConsent;
}

interface GenieConfig {
  anthropicApiKey?: string;
  // Per-provider key storage (Stage 2A, D8 half). Mirrors anthropicApiKey; read via
  // getOpenaiApiKey with an OPENAI_API_KEY env fallback. The per-provider key UI is
  // Stage 6 — the /api/config/api-key endpoint still speaks only Anthropic for now.
  openaiApiKey?: string;
  // Base URL for the OpenAI provider (chat + utility + discovery). When set it
  // REPLACES api.openai.com, routing the `openai` tag at any OpenAI-compatible
  // endpoint (gateway or local server). Read via getOpenaiBaseUrl with an
  // OPENAI_BASE_URL env fallback; absent ⇒ the SDK/discovery defaults, byte-identical
  // to before this field existed.
  openaiBaseUrl?: string;
  agentModel?: string;
  planningModel?: string;
  importModel?: string;
  // Deprecated (pre-G1): the single "code model" role that conflated utility work
  // with the verification layer. Migrates into `utilityModel` — its main historical
  // purpose — when the new keys are absent. Read via getUtilityModel(); never written.
  codeModel?: string;
  utilityModel?: string;
  verificationModel?: string;
  // The recommended model per role — the value a role's "default" pointer resolves
  // to. Written by the recommend tool / auto-refresh (Feature G, G3–G5); an absent
  // role is the explicit UNCONFIGURED state (D9), not a hardcoded seed. Updating this
  // flows to every "default" role and never touches an explicit pin (the G5 property).
  recommendedModels?: Partial<Record<ModelRole, string>>;
  // Config overlay for the pricing table (Stage 2B Slice 1, D10). A per-tier entry
  // overrides the built-in DEFAULT_PRICING seed in usage.ts WHOLESALE; absent tiers
  // keep the seed. Reached by usage.ts only through the injected provider seam
  // (setPricingTableProvider, wired in project-loader.ts) — usage.ts never imports
  // config.ts. Written by setPricingTier (Slice 2's research agent uses it; the
  // Slice 3 verification gate guards the write). Empty ⇒ prices identical to today.
  pricingTable?: Partial<Record<PricingTier, ModelPricing>>;
  // Exact provider/model pricing rows (model-pricing-accounting-fix-plan Stage B).
  // These coexist with the legacy Anthropic tier table above: exact rows win for
  // provider-aware lookups, while absent rows fall back to Anthropic built-ins only
  // for provider === "anthropic". OpenAI is intentionally unpriced unless a row is
  // present and verified/manual data has been written.
  providerPricingTable?: ProviderModelPricing[];
  // Per-tier provenance for agent-written prices (Stage 2B Slice 3, D10). Written
  // ATOMICALLY with pricingTable by setVerifiedPricing, so a written price can never
  // lack its provenance. Replaces the single hand-edited PRICING_VERIFIED_AS_OF for
  // agent-verified tiers; seed tiers never agent-verified fall back to that global.
  pricingProvenance?: Partial<Record<PricingTier, PricingProvenance>>;
  // The last SUCCESSFUL pricing drift-check run (Slice 11, Part A). Deliberately
  // NOT folded into pricingProvenance above: that records which agent wrote which
  // PRICE, and a check that finds no drift writes no price — so a clean run would
  // leave no trace there, which is the exact blind spot this closes. Absent means
  // the check has never completed here, and startup says so out loud.
  pricingCheckRun?: PricingCheckRecord;
  kernel?: KernelSettings;
  telemetry?: TelemetrySettings;
}

interface ModelCache {
  models: ModelOption[];
  cachedAt: string;
}

function readConfig(): GenieConfig {
  const path = configPath();
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as GenieConfig;
  } catch {
    return {};
  }
}

function writeConfig(config: GenieConfig): void {
  mkdirSync(userConfigDir(), { recursive: true });
  writeFileSync(configPath(), JSON.stringify(config, null, 2) + "\n", {
    mode: 0o600,
  });
}

function normalizeReleaseChannel(
  value: string | undefined,
): "dev" | "beta" | "stable" {
  return value === "beta" || value === "stable" ? value : "dev";
}

// Pure read: return the installation id if one has been minted, else "". A5
// forbids minting on a read — an id is minted exactly once, at consent grant, in
// setTelemetrySettings. A never-consented install therefore has no id on disk and
// getTelemetrySettings() reports the empty sentinel.
function readInstallationId(config: GenieConfig): string {
  const existing = config.telemetry?.installationId;
  return existing && existing.trim() ? existing : "";
}

function normalizeConsent(
  value: TelemetryConsent | undefined,
): TelemetryConsent {
  return {
    telemetry: value?.telemetry === true,
    feedback: value?.feedback === true,
  };
}

export function getTelemetrySettings(): Required<TelemetrySettings> {
  const config = readConfig();
  return {
    ...DEFAULT_TELEMETRY_SETTINGS,
    ...config.telemetry,
    installationId: readInstallationId(config),
    consent: normalizeConsent(config.telemetry?.consent),
    consentVersion: Number(config.telemetry?.consentVersion) || 0,
    consentGrantedAt: config.telemetry?.consentGrantedAt ?? "",
    releaseChannel: normalizeReleaseChannel(
      config.telemetry?.releaseChannel ??
        DEFAULT_TELEMETRY_SETTINGS.releaseChannel,
    ),
    syncIntervalMs: Math.max(
      5_000,
      Number(config.telemetry?.syncIntervalMs) ||
        DEFAULT_TELEMETRY_SETTINGS.syncIntervalMs,
    ),
    maxBatchSize: Math.max(
      1,
      Math.min(
        250,
        Number(config.telemetry?.maxBatchSize) ||
          DEFAULT_TELEMETRY_SETTINGS.maxBatchSize,
      ),
    ),
  };
}

// The consent-grant write path. A PUT that carries a `consent` object is a
// deliberate answer to the first-run prompt (accept or decline): we stamp
// consentVersion so the prompt is not shown again, and — only when a category is
// actually granted — stamp the grant timestamp and mint the installation id HERE
// (never on a read). The mint is idempotent (a second grant preserves the id) and
// survives revoke (halting egress does not erase identity, so re-consent does not
// re-mint). The whole grant lands in ONE atomic 0o600 writeConfig.
export function setTelemetrySettings(
  settings: TelemetrySettings,
): Required<TelemetrySettings> {
  const config = readConfig();
  const prev = config.telemetry ?? {};
  const merged: TelemetrySettings = {
    ...prev,
    ...settings,
    releaseChannel: normalizeReleaseChannel(
      settings.releaseChannel ?? prev.releaseChannel,
    ),
  };

  if (settings.consent !== undefined) {
    const consent = normalizeConsent(settings.consent);
    merged.consent = consent;
    merged.consentVersion = CONSENT_VERSION;
    if (consent.telemetry || consent.feedback) {
      merged.consentGrantedAt =
        prev.consentGrantedAt && prev.consentGrantedAt.trim()
          ? prev.consentGrantedAt
          : new Date().toISOString();
      merged.installationId =
        merged.installationId && merged.installationId.trim()
          ? merged.installationId
          : crypto.randomUUID();
    }
  }

  config.telemetry = merged;
  writeConfig(config);
  return getTelemetrySettings();
}

// Per-provider key env-var fallbacks (config file → env var → undefined). Named so
// the accessors below carry no magic strings (CLAUDE.md).
const ANTHROPIC_API_KEY_ENV = "ANTHROPIC_API_KEY";
const OPENAI_API_KEY_ENV = "OPENAI_API_KEY";
const OPENAI_BASE_URL_ENV = "OPENAI_BASE_URL";

export function getAnthropicApiKey(): string | undefined {
  const config = readConfig();
  return config.anthropicApiKey || Deno.env.get(ANTHROPIC_API_KEY_ENV) ||
    undefined;
}

export function setAnthropicApiKey(key: string): void {
  const config = readConfig();
  config.anthropicApiKey = key;
  writeConfig(config);
}

export function clearAnthropicApiKey(): void {
  const config = readConfig();
  delete config.anthropicApiKey;
  writeConfig(config);
}

// OpenAI key trio (Stage 2A) — mirrors the Anthropic trio exactly, including the
// 0o600 write perms (writeConfig) and the config → env fallback (OPENAI_API_KEY).
export function getOpenaiApiKey(): string | undefined {
  const config = readConfig();
  return config.openaiApiKey || Deno.env.get(OPENAI_API_KEY_ENV) || undefined;
}

export function setOpenaiApiKey(key: string): void {
  const config = readConfig();
  config.openaiApiKey = key;
  writeConfig(config);
}

export function clearOpenaiApiKey(): void {
  const config = readConfig();
  delete config.openaiApiKey;
  writeConfig(config);
}

// OpenAI base-URL trio — mirrors the key trio (config → OPENAI_BASE_URL env →
// undefined). When set it reroutes the OpenAI provider's chat, utility, and
// discovery traffic at an OpenAI-compatible endpoint; absent leaves every call site
// on its default (the SDK's api.openai.com + OPENAI_MODELS_URL), unchanged.
export function getOpenaiBaseUrl(): string | undefined {
  const config = readConfig();
  return config.openaiBaseUrl || Deno.env.get(OPENAI_BASE_URL_ENV) || undefined;
}

export function setOpenaiBaseUrl(url: string): void {
  const config = readConfig();
  config.openaiBaseUrl = url;
  writeConfig(config);
}

export function clearOpenaiBaseUrl(): void {
  const config = readConfig();
  delete config.openaiBaseUrl;
  writeConfig(config);
}

// The config-side of the pricing overlay (Stage 2B Slice 1, D10). This is the value
// usage.ts's provider seam reads — wired in project-loader.ts as
// setPricingTableProvider(getPricingTableOverrides), re-read on each price lookup so
// a setPricingTier write takes effect immediately. Empty ⇒ every price is the seed.
export function getPricingTableOverrides(): Partial<
  Record<PricingTier, ModelPricing>
> {
  return readConfig().pricingTable ?? {};
}

// Writer for one tier's price override (Stage 2B Slice 1). Prefer setVerifiedPricing
// below in production — it couples the price with its provenance. Kept as the pure
// price-only writer (used by the Slice 1 test). Same atomic 0o600 write path.
export function setPricingTier(tier: PricingTier, pricing: ModelPricing): void {
  const config = readConfig();
  const table = config.pricingTable ?? {};
  table[tier] = pricing;
  config.pricingTable = table;
  writeConfig(config);
}

function normalizeProviderModelPricing(
  value: unknown,
): ProviderModelPricing | undefined {
  if (!value || typeof value !== "object") return undefined;
  const row = value as Partial<ProviderModelPricing>;
  const provider = normalizeProvider(row.provider);
  const source = ["built_in", "verified", "manual", "provider_metadata"]
      .includes(row.source ?? "")
    ? row.source
    : undefined;
  const effectiveFrom = typeof row.effectiveFrom === "string"
    ? row.effectiveFrom
    : undefined;
  const effectiveThrough = typeof row.effectiveThrough === "string"
    ? row.effectiveThrough
    : undefined;
  if (
    provider === undefined ||
    typeof row.model !== "string" ||
    row.model.trim() === "" ||
    typeof row.input !== "number" ||
    typeof row.output !== "number" ||
    row.unit !== "MTok" ||
    row.currency !== "USD" ||
    source === undefined ||
    (provider !== "anthropic" && source !== "manual" &&
      source !== "verified") ||
    (effectiveFrom !== undefined && !isIsoCalendarDate(effectiveFrom)) ||
    (effectiveThrough !== undefined && !isIsoCalendarDate(effectiveThrough))
  ) {
    return undefined;
  }
  return {
    provider,
    model: row.model.trim(),
    input: row.input,
    output: row.output,
    ...(typeof row.cacheCreation === "number"
      ? { cacheCreation: row.cacheCreation }
      : {}),
    ...(typeof row.cacheRead === "number" ? { cacheRead: row.cacheRead } : {}),
    unit: "MTok",
    currency: "USD",
    source,
    ...(typeof row.verifiedAt === "string"
      ? { verifiedAt: row.verifiedAt }
      : {}),
    ...(typeof row.sourceUrl === "string" ? { sourceUrl: row.sourceUrl } : {}),
    ...(typeof row.notes === "string" ? { notes: row.notes } : {}),
    ...(effectiveFrom ? { effectiveFrom } : {}),
    ...(effectiveThrough ? { effectiveThrough } : {}),
  };
}

function isIsoCalendarDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value);
}

export function getProviderModelPricingOverrides(): ProviderModelPricing[] {
  return (readConfig().providerPricingTable ?? [])
    .map(normalizeProviderModelPricing)
    .filter((row): row is ProviderModelPricing => row !== undefined);
}

export function getProviderModelPricingRows(): ProviderModelPricing[] {
  return [
    ...getProviderModelPricingOverrides(),
    ...pricingRowsFromModelsDev(
      readModelsDevCatalogCache(Number.POSITIVE_INFINITY),
    ),
  ];
}

export function setProviderModelPricing(
  row: ProviderModelPricing,
  opts: { replaceProviderModel?: boolean } = {},
): void {
  const normalized = normalizeProviderModelPricing(row);
  if (!normalized) {
    throw new Error("Invalid provider model pricing row.");
  }
  const config = readConfig();
  const existing = (config.providerPricingTable ?? [])
    .map(normalizeProviderModelPricing)
    .filter((r): r is ProviderModelPricing => r !== undefined)
    .filter((r) =>
      opts.replaceProviderModel
        ? r.provider !== normalized.provider || r.model !== normalized.model
        : r.provider !== normalized.provider ||
          r.model !== normalized.model ||
          r.effectiveFrom !== normalized.effectiveFrom ||
          r.effectiveThrough !== normalized.effectiveThrough
    );
  config.providerPricingTable = [...existing, normalized];
  writeConfig(config);
}

// The last successful drift-check run, or undefined if the check has never
// completed on this machine. Consumed by the startup freshness warning
// (project-loader.ts) through evaluatePricingCheckFreshness.
export function getPricingCheckRecord(): PricingCheckRecord | undefined {
  return readConfig().pricingCheckRun;
}

// Written by scripts/refresh-pricing.ts when a run actually compared prices —
// including a run that FOUND drift. Only a run that could not fetch or parse the
// docs leaves the record untouched, so staleness means "could not check", never
// "checked and disliked the answer".
export function recordPricingCheckRun(record: PricingCheckRecord): void {
  const config = readConfig();
  config.pricingCheckRun = record;
  writeConfig(config);
}

// Per-tier provenance for agent-written prices (Stage 2B Slice 3). Empty ⇒ no tier
// has been agent-verified yet (every price is still the seed / a Slice-1 write), so
// consumers fall back to the global PRICING_VERIFIED_AS_OF.
export function getPricingProvenance(): Partial<
  Record<PricingTier, PricingProvenance>
> {
  return readConfig().pricingProvenance ?? {};
}

// The gated write behind D10: a tier's price AND its provenance land together in ONE
// atomic 0o600 writeConfig, so a written price can NEVER exist without provenance.
// This is the single production call site reached only through an accepted
// PricingDecision in apply mode (agent/pricing-research-agent.ts researchAndApply).
export function setVerifiedPricing(
  tier: PricingTier,
  pricing: ModelPricing,
  provenance: PricingProvenance,
): void {
  const config = readConfig();
  const table = config.pricingTable ?? {};
  table[tier] = pricing;
  config.pricingTable = table;
  const prov = config.pricingProvenance ?? {};
  prov[tier] = provenance;
  config.pricingProvenance = prov;
  writeConfig(config);
}

// The one DRY key resolver behind the provider descriptors: providerId → its key
// (config → env → undefined). Keeps the descriptor table id-driven and stops each
// row from re-deriving key resolution.
export function getProviderKey(
  providerId: ModelProviderId,
): string | undefined {
  switch (providerId) {
    case "anthropic":
      return getAnthropicApiKey();
    case "openai":
      return getOpenaiApiKey();
    default: {
      const descriptor = providerDescriptorFor(providerId);
      return descriptor?.getKey();
    }
  }
}

// Writer/clearer counterparts to getProviderKey (Stage 6): the settings UI writes a
// key per provider by id, so dispatch over the SAME ModelProviderId union to the
// concrete per-provider trio (each preserving the 0o600 writeConfig path). No magic
// strings — the switch is exhaustive over the union.
export function setProviderKey(providerId: ModelProviderId, key: string): void {
  switch (providerId) {
    case "anthropic":
      return setAnthropicApiKey(key);
    case "openai":
      return setOpenaiApiKey(key);
    default:
      throw new Error(
        `Provider "${providerId}" is configured via environment.`,
      );
  }
}

export function clearProviderKey(providerId: ModelProviderId): void {
  switch (providerId) {
    case "anthropic":
      return clearAnthropicApiKey();
    case "openai":
      return clearOpenaiApiKey();
    default:
      throw new Error(
        `Provider "${providerId}" is configured via environment.`,
      );
  }
}

// Per-provider key status for the settings UI (Stage 6). One row per PROVIDER_DESCRIPTORS
// entry so the HTTP layer never hardcodes the provider list: `set` reflects config-or-env
// presence (via the descriptor's getKey), `display` is the obfuscated key when set (never
// the raw key), null when unset.
export interface ProviderKeyStatus {
  id: ModelProviderId;
  label: string;
  envVar: string;
  set: boolean;
  display: string | null;
  editable?: boolean;
  baseUrl?: string;
}

export function getProviderKeyStatuses(): ProviderKeyStatus[] {
  return providerDescriptors().map((descriptor) => {
    const key = descriptor.getKey();
    return {
      id: descriptor.id,
      label: descriptor.label,
      envVar: descriptor.envVars[0] ?? "",
      set: key !== undefined,
      display: key !== undefined ? obfuscateKey(key) : null,
      editable: descriptor.editable,
      ...(descriptor.baseUrl ? { baseUrl: descriptor.baseUrl() } : {}),
    };
  });
}

// --- Provider-descriptor table (Stage 2A, D8) — the ONLY per-provider constant ---
//
// Discovery is driven by this table, never a hardcoded model-id list: each row carries
// its /v1/models endpoint, its auth-header shape, and its key accessor — endpoints +
// auth + key, no model ids. Adding a provider is one row. The base URLs, the Anthropic
// version pin, and the header names are named constants (CLAUDE.md — no magic strings).
const ANTHROPIC_MODELS_URL = "https://api.anthropic.com/v1/models";
const OPENAI_MODELS_URL = "https://api.openai.com/v1/models";
const ANTHROPIC_VERSION = "2023-06-01";
const ANTHROPIC_VERSION_HEADER = "anthropic-version";
const ANTHROPIC_API_KEY_HEADER = "x-api-key";
const AUTHORIZATION_HEADER = "Authorization";
// Max discovery pages fetched per provider — a paginating provider (Anthropic's
// /v1/models) is capped so a runaway `has_more` can't loop; a non-paginating one
// (OpenAI returns a flat list) breaks after page 0.
const MODELS_FETCH_MAX_PAGES = 10;

// The OpenAI discovery endpoint, following a configured base URL so a gateway's
// catalog is discovered instead of api.openai.com's. Derived (not a constant)
// because the base URL is runtime config; unset ⇒ the hardcoded default. The chat
// base URL and this share the same `${base}` root (providers/openai-client.ts).
export function openaiModelsUrl(): string {
  const base = getOpenaiBaseUrl();
  return base ? `${base.replace(/\/$/, "")}/models` : OPENAI_MODELS_URL;
}

export interface ProviderDescriptor {
  id: ModelProviderId;
  label: string;
  envVars: readonly string[];
  transport: "anthropic" | "openai-compatible";
  editable: boolean;
  // A thunk (like getKey) so it re-reads runtime config at discovery time rather
  // than being frozen at module load — the OpenAI row follows the configured base URL.
  modelsUrl: () => string;
  baseUrl?: () => string | undefined;
  authHeaders: (key: string) => Record<string, string>;
  getKey: () => string | undefined;
}

const BUILT_IN_PROVIDER_DESCRIPTORS: readonly ProviderDescriptor[] = [
  {
    id: "anthropic",
    label: "Anthropic",
    envVars: [ANTHROPIC_API_KEY_ENV],
    transport: "anthropic",
    editable: true,
    modelsUrl: () => ANTHROPIC_MODELS_URL,
    authHeaders: (key) => ({
      [ANTHROPIC_API_KEY_HEADER]: key,
      [ANTHROPIC_VERSION_HEADER]: ANTHROPIC_VERSION,
    }),
    getKey: () => getProviderKey("anthropic"),
  },
  {
    id: "openai",
    label: "OpenAI",
    envVars: [OPENAI_API_KEY_ENV],
    transport: "openai-compatible",
    editable: true,
    modelsUrl: openaiModelsUrl,
    baseUrl: () => getOpenaiBaseUrl(),
    authHeaders: (key) => ({ [AUTHORIZATION_HEADER]: `Bearer ${key}` }),
    getKey: () => getProviderKey("openai"),
  },
];

function envKeyForProvider(provider: ModelsDevProvider): string | undefined {
  for (const envVar of provider.env) {
    const value = Deno.env.get(envVar);
    if (value) return value;
  }
  return undefined;
}

function expandProviderApiUrl(api: string): string | undefined {
  let missing = false;
  const expanded = api.replace(/\$\{([A-Z0-9_]+)\}/g, (_match, name) => {
    const value = Deno.env.get(String(name));
    if (!value) {
      missing = true;
      return "";
    }
    return value;
  });
  return missing ? undefined : expanded;
}

function modelsUrlFromBase(base: string): string {
  return `${base.replace(/\/$/, "")}/models`;
}

function catalogProviderDescriptors(
  catalog: ModelsDevCatalog | null = readModelsDevCatalogCache(),
): ProviderDescriptor[] {
  if (!catalog) return [];
  return Object.values(catalog.providers)
    .filter((provider) => provider.id !== "openai")
    .filter(isOpenAiCompatibleModelsDevProvider)
    .filter((provider) => envKeyForProvider(provider) !== undefined)
    .map((provider) => ({
      id: provider.id,
      label: provider.name,
      envVars: provider.env,
      transport: "openai-compatible" as const,
      editable: false,
      modelsUrl: () => {
        const base = provider.api
          ? expandProviderApiUrl(provider.api)
          : undefined;
        return base ? modelsUrlFromBase(base) : "";
      },
      baseUrl: () =>
        provider.api ? expandProviderApiUrl(provider.api) : undefined,
      authHeaders: (key: string) => ({
        [AUTHORIZATION_HEADER]: `Bearer ${key}`,
      }),
      getKey: () => envKeyForProvider(provider),
    }));
}

export function providerDescriptors(
  catalog: ModelsDevCatalog | null = readModelsDevCatalogCache(
    Number.POSITIVE_INFINITY,
  ),
): ProviderDescriptor[] {
  const seen = new Set<string>();
  const descriptors = [
    ...BUILT_IN_PROVIDER_DESCRIPTORS,
    ...catalogProviderDescriptors(catalog),
  ].filter((descriptor) => {
    if (seen.has(descriptor.id)) return false;
    seen.add(descriptor.id);
    return true;
  });
  return descriptors;
}

export const PROVIDER_DESCRIPTORS: readonly ProviderDescriptor[] =
  BUILT_IN_PROVIDER_DESCRIPTORS;

export function providerDescriptorFor(
  providerId: ModelProviderId,
  catalog: ModelsDevCatalog | null = readModelsDevCatalogCache(
    Number.POSITIVE_INFINITY,
  ),
): ProviderDescriptor | undefined {
  return providerDescriptors(catalog).find((d) => d.id === providerId);
}

export function isKnownProviderId(
  providerId: string,
  catalog: ModelsDevCatalog | null = readModelsDevCatalogCache(
    Number.POSITIVE_INFINITY,
  ),
): providerId is ModelProviderId {
  return providerDescriptors(catalog).some((d) => d.id === providerId);
}

// True when ANY provider descriptor has a key set (config or env). Replaces the
// Anthropic-only refresh gate so an OpenAI-only install still discovers models.
export function hasAnyProviderKey(): boolean {
  return providerDescriptors().some((d) => d.getKey() !== undefined);
}

export function obfuscateKey(key: string): string {
  if (key.length <= 11) return "****";
  const prefix = key.slice(0, 4);
  const suffix = key.slice(-7);
  const middle = "*".repeat(Math.min(key.length - 11, 20));
  return `${prefix}${middle}${suffix}`;
}

function readModelCache(): ModelCache | null {
  const path = modelCachePath();
  if (!existsSync(path)) return null;
  try {
    const cache = JSON.parse(
      readFileSync(path, "utf-8"),
    ) as ModelCache;
    if (!Array.isArray(cache.models)) return null;
    const catalog = readModelsDevCatalogCache(Number.POSITIVE_INFINITY);
    return {
      cachedAt: String(cache.cachedAt ?? ""),
      models: cache.models
        .filter((m) =>
          typeof m?.id === "string" && typeof m?.label === "string"
        )
        .map((m) => {
          const provider = normalizeProvider(m.provider);
          return catalogEnrichedModel({
            id: m.id,
            label: m.label,
            family: m.family,
            // D8: carry the persisted provider tag through (readModelCache used to
            // strip it — the real gap that made providerFor undata-driven). An invalid
            // or absent tag validates to undefined, resolving to DEFAULT_MODEL_PROVIDER.
            provider,
            // Provider-aware pricing wins over persisted cache pricing. Cached
            // pricing is trusted only for legacy untagged rows, so a stale OpenAI
            // cache entry cannot masquerade as priced without an exact provider row.
            pricing: hydratedModelPricing(m.id, provider, m.pricing),
            // Slice 1: carry the persisted live context window through; validated,
            // so a corrupt value drops to the family table rather than mis-sizing.
            contextWindow: normalizeContextWindow(m.contextWindow),
            outputLimit: normalizeContextWindow(m.outputLimit),
            providerLabel: typeof m.providerLabel === "string"
              ? m.providerLabel
              : undefined,
            metadataSource: normalizeMetadataSource(m.metadataSource),
            modalities: normalizeModalities(m.modalities),
            capabilities: normalizeCapabilities(m.capabilities),
            lastUpdated: typeof m.lastUpdated === "string"
              ? m.lastUpdated
              : undefined,
          }, catalog);
        }),
    };
  } catch {
    return null;
  }
}

// True when the model cache is older than `ttlMs` or has never been written — the
// G4 auto-refresh throttle predicate. An absent or unparseable `cachedAt` counts
// as stale so a missing/corrupt cache re-refreshes rather than sticking forever.
export function isModelCacheStale(ttlMs: number): boolean {
  const cachedAt = readModelCache()?.cachedAt;
  if (!cachedAt) return true;
  const ts = Date.parse(cachedAt);
  if (Number.isNaN(ts)) return true;
  return Date.now() - ts >= ttlMs;
}

// Validate a persisted provider tag: a member of MODEL_PROVIDER_IDS survives, any
// other value (or absent) drops to undefined so providerFor falls back to the default.
function normalizeProvider(value: unknown): ModelProviderId | undefined {
  if (typeof value !== "string" || value.trim() === "") return undefined;
  const providerId = value.trim();
  if (MODEL_PROVIDER_IDS.includes(providerId as BuiltInModelProviderId)) {
    return providerId;
  }
  const catalog = readModelsDevCatalogCache(Number.POSITIVE_INFINITY);
  return catalog?.providers[providerId] ? providerId : undefined;
}

export function openAiCompatibleBaseUrlFor(
  providerId: ModelProviderId,
): string | undefined {
  if (providerId === "openai") return getOpenaiBaseUrl();
  return providerDescriptorFor(providerId)?.baseUrl?.();
}

// Validate a persisted/discovered context window: a positive integer survives,
// anything else (absent, zero, negative, non-integer, non-number) drops to
// undefined so contextWindowFor falls back to the family table.
function normalizeContextWindow(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0
    ? value
    : undefined;
}

function normalizeMetadataSource(
  value: unknown,
): ModelOption["metadataSource"] | undefined {
  return value === "models.dev" || value === "provider" ||
      value === "manual" || value === "unknown"
    ? value
    : undefined;
}

function normalizeModalities(value: unknown): ModelOption["modalities"] {
  if (!value || typeof value !== "object") return undefined;
  const row = value as { input?: unknown; output?: unknown };
  const strings = (items: unknown): string[] | undefined =>
    Array.isArray(items)
      ? items.filter((item): item is string => typeof item === "string")
      : undefined;
  const input = strings(row.input);
  const output = strings(row.output);
  return input || output
    ? { ...(input ? { input } : {}), ...(output ? { output } : {}) }
    : undefined;
}

function normalizeCapabilities(value: unknown): ModelOption["capabilities"] {
  if (!value || typeof value !== "object") return undefined;
  const row = value as Record<string, unknown>;
  const out: NonNullable<ModelOption["capabilities"]> = {};
  for (
    const key of [
      "toolCall",
      "structuredOutput",
      "reasoning",
      "attachment",
    ] as const
  ) {
    if (typeof row[key] === "boolean") out[key] = row[key];
  }
  return Object.keys(out).length ? out : undefined;
}

function providerModelPricingToModelPricing(
  pricing: ProviderModelPricing,
): ModelPricing | undefined {
  return {
    input: pricing.input,
    output: pricing.output,
    cacheCreation: pricing.cacheCreation ?? 0,
    cacheRead: pricing.cacheRead ?? 0,
    unit: pricing.unit,
  };
}

function modelsDevProviderPricing(
  provider: ModelProviderId,
  id: string,
): ProviderModelPricing | undefined {
  return pricingRowsFromModelsDev(
    readModelsDevCatalogCache(Number.POSITIVE_INFINITY),
  ).find((row) => row.provider === provider && row.model === id);
}

function normalizeModelPricing(value: unknown): ModelPricing | undefined {
  if (!value || typeof value !== "object") return undefined;
  const pricing = value as Partial<ModelPricing>;
  if (
    typeof pricing.input !== "number" ||
    typeof pricing.output !== "number" ||
    typeof pricing.cacheCreation !== "number" ||
    typeof pricing.cacheRead !== "number"
  ) {
    return undefined;
  }
  const fast = pricing.fast &&
      typeof pricing.fast.input === "number" &&
      typeof pricing.fast.output === "number"
    ? { input: pricing.fast.input, output: pricing.fast.output }
    : undefined;
  return {
    input: pricing.input,
    output: pricing.output,
    cacheCreation: pricing.cacheCreation,
    cacheRead: pricing.cacheRead,
    unit: "MTok",
    ...(fast ? { fast } : {}),
  };
}

function hydratedModelPricing(
  id: string,
  provider: ModelProviderId | undefined,
  cachedPricing?: unknown,
): ModelPricing | undefined {
  if (provider) {
    const providerPricing = getProviderModelPricing(provider, id);
    const catalogPricing = modelsDevProviderPricing(provider, id);
    if (!providerPricing && !catalogPricing) return undefined;
    if (
      provider === "anthropic" && providerPricing?.source === "built_in"
    ) {
      return getModelPricing(id);
    }
    return providerModelPricingToModelPricing(
      providerPricing ?? catalogPricing!,
    );
  }
  return getModelPricing(id) ?? normalizeModelPricing(cachedPricing);
}

function catalogEnrichedModel(
  model: ModelOption,
  catalog: ModelsDevCatalog | null = readModelsDevCatalogCache(
    Number.POSITIVE_INFINITY,
  ),
): ModelOption {
  const provider = model.provider;
  const catalogModel = provider
    ? modelFromModelsDev(catalog, provider, model.id)
    : undefined;
  if (!catalogModel) {
    return {
      ...model,
      metadataSource: model.metadataSource ??
        (provider ? "provider" : "unknown"),
    };
  }
  return {
    ...model,
    label: catalogModel.name ?? model.label,
    family: catalogModel.family ?? model.family,
    contextWindow: catalogModel.contextWindow ?? model.contextWindow,
    outputLimit: catalogModel.outputLimit ?? model.outputLimit,
    providerLabel: catalog?.providers[provider!]?.name ?? model.providerLabel,
    metadataSource: "models.dev",
    ...(catalogModel.modalities ? { modalities: catalogModel.modalities } : {}),
    capabilities: {
      ...(model.capabilities ?? {}),
      ...(catalogModel.toolCall !== undefined
        ? { toolCall: catalogModel.toolCall }
        : {}),
      ...(catalogModel.structuredOutput !== undefined
        ? { structuredOutput: catalogModel.structuredOutput }
        : {}),
      ...(catalogModel.reasoning !== undefined
        ? { reasoning: catalogModel.reasoning }
        : {}),
      ...(catalogModel.attachment !== undefined
        ? { attachment: catalogModel.attachment }
        : {}),
    },
    lastUpdated: catalogModel.lastUpdated ?? model.lastUpdated,
  };
}

function writeModelCache(models: ModelOption[]): void {
  mkdirSync(userConfigDir(), { recursive: true });
  writeFileSync(
    modelCachePath(),
    JSON.stringify({ models, cachedAt: new Date().toISOString() }, null, 2) +
      "\n",
    { mode: 0o600 },
  );
}

function modelFamily(id: string): string | undefined {
  if (id.includes("claude-opus")) return "claude-opus";
  if (id.includes("claude-sonnet")) return "claude-sonnet";
  if (id.includes("claude-haiku")) return "claude-haiku";
  return undefined;
}

function dedupeModels(models: ModelOption[]): ModelOption[] {
  const seen = new Set<string>();
  const result: ModelOption[] = [];
  const catalog = readModelsDevCatalogCache(Number.POSITIVE_INFINITY);
  for (const model of models) {
    const id = model.id.trim();
    if (!id || seen.has(id) || id === DEFAULT_MODEL_ID) continue;
    seen.add(id);
    result.push(catalogEnrichedModel({
      id,
      label: model.label.trim() || id,
      family: model.family ?? modelFamily(id),
      pricing: hydratedModelPricing(id, model.provider, model.pricing),
      // D8: preserve the provider tag so it survives the cache round-trip and
      // getAvailableModels union — the linchpin that lets providerFor read it.
      provider: model.provider,
      // Slice 1: preserve the live context window through the dedupe/cache round-trip.
      contextWindow: model.contextWindow,
      outputLimit: model.outputLimit,
      providerLabel: model.providerLabel,
      metadataSource: model.metadataSource,
      modalities: model.modalities,
      capabilities: model.capabilities,
      lastUpdated: model.lastUpdated,
    }, catalog));
  }
  return result;
}

// The concrete (non-sentinel) model id each role is explicitly PINNED to right now.
// A role on "default" contributes nothing (it follows a recommendation, always a
// current-tier model). Used by the E4 hygiene filter so a pin to an otherwise-hidden
// deep-legacy id is never dropped from the picker.
function pinnedRoleModels(config: GenieConfig): Set<string> {
  const pinned = new Set<string>();
  for (const role of MODEL_ROLES) {
    const selection = readRoleSelection(config, role);
    if (selection !== DEFAULT_MODEL_ID) pinned.add(selection);
  }
  return pinned;
}

// Feature E4 — picker hygiene. The live Models API is a superset that includes
// retired/deep-legacy ids (Opus 4.1, Claude 2/3.x) that only clutter the role
// dropdowns. Surface the curated MODELS set UNION every live model that is not
// deep-legacy — so a freshly launched model still appears without a hand edit, while
// retired lines drop off. A model a role is currently pinned to is ALWAYS kept
// (never blank a dropdown or hide what's running). This is display-only: pricing and
// role resolution do not read this list, so a hidden id still costs + resolves.
function isMainstreamOpenAiModel(id: string): boolean {
  if (
    /\b(embedding|moderation|audio|realtime|transcribe|tts|image|dall-e|whisper)\b/i
      .test(id)
  ) {
    return false;
  }
  if (/-\d{4}-\d{2}-\d{2}$/.test(id)) return false;
  return /^gpt-4o(?:$|[-.])/.test(id) ||
    /^gpt-4\.1(?:$|[-.])/.test(id) ||
    /^gpt-5(?:$|[-.])/.test(id);
}

function isSurfacedModel(
  id: string,
  pinned: ReadonlySet<string>,
  provider: ModelProviderId | undefined,
): boolean {
  if (id in MODELS) return true; // curated set is always surfaced
  if (pinned.has(id)) return true; // never hide a live pin
  if (provider === "openai") return isMainstreamOpenAiModel(id);
  return !isDeepLegacyModel(id);
}

export function getAvailableModels(): ModelOption[] {
  const pinned = pinnedRoleModels(readConfig());
  const cached = readModelCache()?.models ?? [];
  const cachedIds = new Set(cached.map((m) => m.id));
  const pinnedModels = [...pinned]
    .filter((id) => !cachedIds.has(id))
    .map((id) => ({
      id,
      label: id,
      provider: providerFor(id),
      metadataSource: "manual" as const,
    }));
  const surfaced = dedupeModels([
    ...cached,
    ...Object.entries(MODELS).map(([id, model]) => ({ ...model, id })),
    ...pinnedModels,
  ])
    .filter((m) => isSurfacedModel(m.id, pinned, m.provider))
    // Flag a surfaced deep-legacy model (only here because it is pinned) so the UI
    // can render it muted/last with a "(deprecated)" note instead of pretending
    // it's a first-class choice.
    .map((m) => (isDeepLegacyModel(m.id) ? { ...m, deprecated: true } : m));
  return [
    { id: DEFAULT_MODEL_ID, label: "Default", family: "default" },
    ...surfaced,
  ];
}

// Discover one provider's catalog: paginate its /v1/models, tagging each returned
// model with the descriptor's provider. Best-effort and NON-throwing — a provider
// whose fetch fails returns [] so it never breaks the others in the discovery loop
// (the caller falls back to the last-good cache). Keeps the 10-page cap.
async function fetchProviderModels(
  descriptor: ProviderDescriptor,
  key: string,
  catalog: ModelsDevCatalog | null,
): Promise<ModelOption[]> {
  const fetched: ModelOption[] = [];
  let afterId: string | undefined;
  try {
    for (let page = 0; page < MODELS_FETCH_MAX_PAGES; page++) {
      const modelsUrl = descriptor.modelsUrl();
      if (!modelsUrl) break;
      const url = new URL(modelsUrl);
      if (!url.toString()) break;
      if (afterId) url.searchParams.set("after_id", afterId);
      const res = await fetch(url, { headers: descriptor.authHeaders(key) });
      if (!res.ok) break;
      const data = await res.json() as {
        data?: Array<{
          id?: string;
          display_name?: string;
          // Optional context window when the provider exposes one. Sources, in
          // preference order: `context_length` / nested `top_provider.context_length`
          // (OpenRouter-style gateway catalogs), then `max_input_tokens` (Anthropic's
          // own /v1/models exposes this — it IS the context window), then a bare
          // `context_window`. OpenAI's /v1/models still omits all of these. Absent or
          // invalid ⇒ omitted, so contextWindowFor falls back to the curated tier map
          // / family table.
          context_length?: unknown;
          top_provider?: { context_length?: unknown };
          max_input_tokens?: unknown;
          context_window?: unknown;
        }>;
        has_more?: boolean;
        last_id?: string | null;
      };
      for (const model of data.data ?? []) {
        if (!model.id) continue;
        const contextWindow = normalizeContextWindow(
          model.context_length ?? model.top_provider?.context_length ??
            model.max_input_tokens ?? model.context_window,
        );
        fetched.push(catalogEnrichedModel({
          id: model.id,
          label: model.display_name ?? model.id,
          family: modelFamily(model.id),
          provider: descriptor.id,
          providerLabel: descriptor.label,
          metadataSource: "provider",
          ...(contextWindow !== undefined ? { contextWindow } : {}),
        }, catalog));
      }
      // OpenAI's list is a flat, unpaginated array (no has_more/last_id) → one page.
      if (!data.has_more || !data.last_id) break;
      afterId = data.last_id;
    }
  } catch {
    // Per-provider best-effort: a failing provider contributes nothing rather than
    // aborting the whole discovery loop.
  }
  return fetched;
}

// Per-provider discovery (Stage 2A, D7/D8): loop the descriptor table, discover +
// tag every keyed provider's catalog, merge, dedupe, and cache. Keyless providers are
// skipped (no network without a key — same property as before). Best-effort: a failing
// provider leaves the others intact, and any write failure falls back to the last-good
// cache (the caller runModelRefresh owns logging).
export async function refreshAvailableModels(): Promise<ModelOption[]> {
  const catalog = await refreshModelsDevCatalog();
  const descriptors = providerDescriptors(catalog);
  if (!descriptors.some((d) => d.getKey() !== undefined)) {
    return getAvailableModels();
  }

  try {
    const fetched: ModelOption[] = [];
    for (const descriptor of descriptors) {
      const key = descriptor.getKey();
      if (!key) continue;
      fetched.push(...(await fetchProviderModels(descriptor, key, catalog)));
    }

    const models = dedupeModels(fetched);
    if (models.length > 0) writeModelCache(models);
  } catch {
    // Model discovery is best-effort; callers still get cached and built-in options.
  }

  return getAvailableModels();
}

// The raw stored selection for a role: either DEFAULT_MODEL_ID ("default") or an
// explicit pin. The legacy single `codeModel` key seeds the utility role (its main
// historical purpose) when the new `utilityModel` key is absent.
function readRoleSelection(config: GenieConfig, role: ModelRole): ModelId {
  const stored = config[ROLE_CONFIG_KEY[role]]?.trim();
  if (stored) return stored;
  if (role === "utility") {
    const legacy = config.codeModel?.trim();
    if (legacy) return legacy;
  }
  return DEFAULT_MODEL_ID;
}

// The recommended model a role's "default" pointer resolves to: the stored
// recommendation (written by the catalog-driven recommend engine), or `undefined`
// when none has been written yet (keyless / empty catalog / target family absent).
// D9: there is no seed fallback — an unsatisfiable role is explicitly unconfigured.
function recommendedForRole(
  config: GenieConfig,
  role: ModelRole,
): string | undefined {
  return config.recommendedModels?.[role]?.trim() || undefined;
}

// The one shared resolver behind every *ForRequest getter: a stored "default" (or
// unset) resolves to the role's recommendation — or `undefined` when the catalog
// can't satisfy it (the explicit UNCONFIGURED state); an explicit pin is returned
// verbatim regardless of catalog.
function resolveRoleModel(
  config: GenieConfig,
  role: ModelRole,
): string | undefined {
  const selection = readRoleSelection(config, role);
  return selection === DEFAULT_MODEL_ID
    ? recommendedForRole(config, role)
    : selection;
}

function writeRoleSelection(role: ModelRole, model: string): void {
  if (!model.trim()) return;
  const config = readConfig();
  config[ROLE_CONFIG_KEY[role]] = model;
  writeConfig(config);
}

// Raw stored selection for a role (DEFAULT_MODEL_ID or a pin) — for the picker UI.
export function getModelForRole(role: ModelRole): ModelId {
  return readRoleSelection(readConfig(), role);
}

// Resolved concrete model id a role runs on right now, or `undefined` when the
// role is UNCONFIGURED (D9): keyless / empty catalog / no recommendation. Callers
// must surface the unconfigured state, never pass undefined to a provider call.
export function getModelForRoleRequest(role: ModelRole): string | undefined {
  return resolveRoleModel(readConfig(), role);
}

export function setModelForRole(role: ModelRole, model: string): void {
  writeRoleSelection(role, model);
}

// The recommended-model map. Partial by construction (D9): a role with no stored
// recommendation is absent, not seed-filled — an absent key is the unconfigured state.
export function getRecommendedModels(): Partial<Record<ModelRole, string>> {
  const config = readConfig();
  const result: Partial<Record<ModelRole, string>> = {};
  for (const role of MODEL_ROLES) {
    const recommended = recommendedForRole(config, role);
    if (recommended) result[role] = recommended;
  }
  return result;
}

// Update the recommended map (Feature G, G3–G5). Flows to every "default" role;
// never touches an explicit pin, since a pin is a concrete id by definition.
export function setRecommendedModels(
  partial: Partial<Record<ModelRole, string>>,
): void {
  const config = readConfig();
  const next: Partial<Record<ModelRole, string>> = {};
  for (const role of MODEL_ROLES) {
    const value = partial[role]?.trim();
    if (value) next[role] = value;
  }
  config.recommendedModels = next;
  writeConfig(config);
}

// --- agent role ---
export function getAgentModel(): ModelId {
  return getModelForRole("agent");
}

export function getAgentModelForRequest(): string | undefined {
  return getModelForRoleRequest("agent");
}

export function setAgentModel(model: string): void {
  setModelForRole("agent", model);
}

// --- planning role (plans, scope, acceptance criteria) ---
export function getPlanningModel(): ModelId {
  return getModelForRole("planning");
}

export function getPlanningModelForRequest(): string | undefined {
  return getModelForRoleRequest("planning");
}

export function setPlanningModel(model: string): void {
  setModelForRole("planning", model);
}

// --- import role (codebase import and semantic mapping) ---
export function getImportModel(): ModelId {
  return getModelForRole("import");
}

export function getImportModelForRequest(): string | undefined {
  return getModelForRoleRequest("import");
}

export function setImportModel(model: string): void {
  setModelForRole("import", model);
}

// --- utility role (autocomplete, session titles, summaries) ---
export function getUtilityModel(): ModelId {
  return getModelForRole("utility");
}

export function getUtilityModelForRequest(): string | undefined {
  return getModelForRoleRequest("utility");
}

export function setUtilityModel(model: string): void {
  setModelForRole("utility", model);
}

// --- verification role (audits, refute/adversarial pass) ---
export function getVerificationModel(): ModelId {
  return getModelForRole("verification");
}

export function getVerificationModelForRequest(): string | undefined {
  return getModelForRoleRequest("verification");
}

export function setVerificationModel(model: string): void {
  setModelForRole("verification", model);
}

// --- deprecated "code model" aliases (pre-G1) — thin wrappers over the utility
// role so there is one code path, not two divergent ones. Kept for back-compat with
// callers/config that still speak the old single-role vocabulary. ---
export function getCodeModel(): ModelId {
  return getUtilityModel();
}

export function getCodeModelForRequest(): string | undefined {
  return getUtilityModelForRequest();
}

export function setCodeModel(model: string): void {
  setUtilityModel(model);
}
