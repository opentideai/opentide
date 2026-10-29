// --- Assertion helpers for tests ---

export class AssertionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AssertionError";
  }
}

// create() refuses while another session holds an active changeset. Every
// write lands in the one live kernel and readiness is judged on the whole
// project, so a project has one writer at a time.
export class ChangesetActiveError extends Error {
  constructor(readonly holder: Changeset) {
    super(
      `Changeset "${holder.id}" ("${holder.title}") is ${holder.status} ` +
        `in another session.`,
    );
    this.name = "ChangesetActiveError";
  }
}

// --- Result type for all kernel operations ---

export type Result<T> =
  | { ok: true; data: T }
  | {
    ok: false;
    error: { code: string; message: string; suggestion?: string };
  };

// --- Registry entry types ---

export interface RouteSchemaParam {
  type: string;
  description?: string;
  enum?: unknown[];
  default?: unknown;
  format?: string;
}

export interface RouteSchemaQuery extends RouteSchemaParam {
  required?: boolean;
}

export interface RouteSchemaBody {
  type: "object";
  properties?: Record<string, unknown>;
  required?: string[];
  additionalProperties?: boolean;
}

export interface RouteSchemaResponse {
  description: string;
  schema?: Record<string, unknown>;
}

// Test-only metadata: an author's opt-in for the Milestone 4 route smoke plan
// (verification/route-smoke-plan.ts, Slice 4.3). It lets the derivation auto-hit
// a route it would otherwise skip: `safe` unlocks a mutating method, and
// `exampleRequest` supplies the path params / query / body a parameterized route
// needs. It is consumed ONLY by the route smoke plan and is never read by
// core/openapi.ts, so it does NOT leak into the exported openapi.json or any
// exported bytes (regression-tested) — it rides in the canonical registry
// snapshot alone.
export interface RouteProductionTest {
  // The author's explicit assertion that auto-hitting this route is acceptable —
  // required to probe a mutating POST/PUT/PATCH/DELETE. The smoke app is
  // ephemeral (a throwaway export + PGlite `./data`, torn down after), so a probe
  // mutates only that disposable instance. Without it, a mutating method stays
  // skipped (SKIP_MUTATING_METHOD).
  safe?: boolean;
  // A valid example request that satisfies the route's declared inputs, lifting a
  // parameterized route out of the skipped set into a real probe.
  exampleRequest?: {
    pathParams?: Record<string, string>;
    query?: Record<string, string>;
    body?: unknown;
  };
  // The status the probe should expect, overriding the schema-derived default
  // (deriveExpectedStatus).
  expectedStatus?: number;
  // Whether the route's response body is deterministic across targets. Carried
  // through the plan now, consumed by the Slice 4.4 target-parity comparison.
  deterministicBody?: boolean;
}

export interface RouteSchema {
  summary?: string;
  description?: string;
  tags?: string[];
  params?: Record<string, RouteSchemaParam>;
  query?: Record<string, RouteSchemaQuery>;
  body?: RouteSchemaBody;
  responses?: Record<string, RouteSchemaResponse>;
  // Test-only opt-in fixtures for the route smoke plan (Milestone 4, Slice 4.3).
  // Never read by OpenAPI generation, so it does not leak into exported bytes.
  productionTest?: RouteProductionTest;
}

export interface RouteEntry {
  method: string;
  path: string;
  handlerName: string;
  registeredAt: string;
  schema?: RouteSchema;
  module?: string;
}

const METHOD_ORDER: Record<string, number> = {
  GET: 0,
  POST: 1,
  PATCH: 2,
  PUT: 3,
  DELETE: 4,
};

export function sortRoutes<T extends { method: string; path: string }>(
  routes: T[],
): T[] {
  return routes.toSorted((a, b) => {
    const pathCmp = a.path.localeCompare(b.path);
    if (pathCmp !== 0) return pathCmp;
    return (METHOD_ORDER[a.method] ?? 99) - (METHOD_ORDER[b.method] ?? 99);
  });
}

export interface HandlerEntry {
  name: string;
  source: string;
  fn: HandlerFn;
  registeredAt: string;
  // Stable identity (Stream A / A2, docs/stream-a-data-foundation-plan.md §3.2):
  // minted once at creation via createTimestampedId("ent"), preserved verbatim
  // across every update, and threaded into each change record's context so an
  // entity's whole lifecycle (create → update → …) shares one id. Survives a
  // persistence round-trip; pre-existing entities get one minted on first load.
  entityUid: string;
  // Monotonic per-entity revision, bumped on every accepted define_handler write
  // (docs/lsp-support-plan.md Stage 5). The optimistic-concurrency token: a save
  // carrying an expectedRevision that no longer matches is rejected as STALE_WRITE
  // rather than clobbering a concurrent write. Survives a persistence round-trip.
  revision: number;
  schema?: RouteSchema;
  module?: string;
  purpose?: string;
  runtimeId?: string;
  language?: string;
}

export interface FunctionEntry {
  name: string;
  source: string;
  fn: (...args: unknown[]) => unknown;
  registeredAt: string;
  // Stable identity — see HandlerEntry.entityUid (Stream A / A2).
  entityUid: string;
  // Monotonic per-entity revision (see HandlerEntry.revision) — the same
  // optimistic-concurrency token for define_function writes.
  revision: number;
  returnType?: string;
  module?: string;
  purpose?: string;
  runtimeId?: string;
  language?: string;
}

// --- Custom Types ---

export interface TypeFieldDef {
  name: string;
  type: string;
  description?: string;
  optional?: boolean;
}

export interface TypeEntry {
  name: string;
  fields: TypeFieldDef[];
  description?: string;
  registeredAt: string;
  module?: string;
  // Stable identity — see HandlerEntry.entityUid (Stream A / A2).
  entityUid: string;
}

export interface TestResult {
  passed: boolean;
  error?: string;
  errorName?: string;
  durationMs: number;
  ranAt: string;
}

export interface TestVerificationMetadata {
  claimIds?: string[];
  kind?: "unit" | "integration" | "e2e" | "adversarial";
  description?: string;
  generatedFrom?: string;
}

export interface TestEntry {
  name: string;
  source: string;
  fn: TestFn;
  registeredAt: string;
  // Stable identity — see HandlerEntry.entityUid (Stream A / A2).
  entityUid: string;
  module?: string;
  changesetId?: string;
  verification?: TestVerificationMetadata;
  lastResult?: TestResult;
  runtimeId?: string;
  language?: string;
}

export type TestFn = () => Promise<void>;

export interface ConfigEntry {
  name: string;
  value: unknown;
  description?: string;
  updatedAt: string;
  module?: string;
  // Stable identity — see HandlerEntry.entityUid (Stream A / A2).
  entityUid: string;
}

export interface SchemaEntry {
  tableName: string;
  columns: ColumnDef[];
  sql: string;
  createdAt: string;
  updatedAt: string;
  module?: string;
}

export interface ColumnDef {
  name: string;
  type: string;
  nullable: boolean;
  defaultValue: string | null;
  primaryKey: boolean;
}

export interface MigrationEntry {
  id: number;
  tableName: string;
  version: number;
  sql: string;
  reverseSql: string | null;
  reversible: boolean;
  columnsBefore: ColumnDef[];
  columnsAfter: ColumnDef[];
  appliedAt: string;
  rolledBackAt: string | null;
  turnId: string | null;
  changesetId?: string | null;
}

// Who caused a migration: stamped on the migration row and its state entry.
export interface MigrationProvenance {
  turnId?: string | null;
  changesetId?: string | null;
}

// --- Asset entry ---

export interface AssetEntry {
  name: string;
  content: Uint8Array;
  mimeType: string;
  size: number;
  registeredAt: string;
  module?: string;
  // Stable identity — see HandlerEntry.entityUid (Stream A / A2).
  entityUid: string;
}

// --- Template entry ---

export interface TemplateEntry {
  name: string;
  content: string;
  registeredAt: string;
  module?: string;
  // Stable identity — see HandlerEntry.entityUid (Stream A / A2).
  entityUid: string;
}

// --- Handler signature ---

// Everything the kernel knows about a request that the standard Request does not:
// the values it matched out of the route pattern. Deliberately nothing else — the
// handler ABI is a web standard plus route params, and adding a field here is how
// it would stop being one.
export interface HandlerContext {
  readonly params: Readonly<Record<string, string>>;
}

export type HandlerFn = (
  req: Request,
  ctx: HandlerContext,
) => Response | Promise<Response>;

// --- Compilation ---

export interface CompileLog {
  (...args: unknown[]): void;
  debug: (...args: unknown[]) => void;
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
}

export interface CompileDeps {
  // deno-lint-ignore no-explicit-any
  db: DbInterface & Record<string, any>;
  functions: FunctionRegistry;
  config: ConfigRegistry;
  templates: TemplateRegistry;
  packages: Record<string, unknown>;
  env: Record<string, string>;
  log: CompileLog;
  getAppPort: () => number;
  appUrl: (path?: string) => string;
}

export interface DbInterface {
  query: (
    sql: string,
    params?: unknown[],
  ) => Promise<Record<string, unknown>[]>;
  execute: (sql: string, params?: unknown[]) => Promise<{ changes: number }>;
}

// --- Registry interfaces ---

export interface FunctionRegistry {
  get: (name: string) => ((...args: unknown[]) => unknown) | undefined;
  call: (name: string, ...args: unknown[]) => unknown;
}

export interface TemplateRegistry {
  get: (name: string) => string | undefined;
}

export interface ConfigRegistry {
  get: (name: string) => unknown;
}

// --- Request logging ---

export interface RequestLogEntry {
  timestamp: string;
  method: string;
  url: string;
  path: string;
  status: number;
  durationMs: number;
  requestHeaders: Record<string, string>;
  requestBody: string | null;
  responseHeaders: Record<string, string>;
  responseBody: string | null;
}

// --- Unified logging ---

export type LogLevel = "debug" | "info" | "warn" | "error";
export type LogSource =
  | "handler"
  | "system"
  | "script"
  | "agent"
  | "app"
  | "lsp";

export interface LogEntry {
  id: number;
  timestamp: string;
  level: LogLevel;
  source: LogSource;
  route?: string;
  message: string;
  stack?: string;
  metadata?: Record<string, unknown>;
}

// --- Dev Tools ---

export interface DevToolArgDef {
  name: string;
  type: string;
  description: string;
  required: boolean;
}

export interface DevToolEntry {
  name: string;
  description: string;
  args: DevToolArgDef[];
  source: string;
  fn: DevToolFn;
  registeredAt: string;
  module?: string;
  runtimeId?: string;
  language?: string;
  // Stable identity — see HandlerEntry.entityUid (Stream A / A2).
  entityUid: string;
}

export type DevToolFn = (...args: unknown[]) => unknown | Promise<unknown>;

// --- Dev Views ---

export type DevViewFn = (
  object: unknown,
) => ViewDescriptor | Promise<ViewDescriptor>;

export interface DevViewEntry {
  name: string;
  targetType: string;
  title: string;
  source: string;
  fn: DevViewFn;
  builtIn: boolean;
  registeredAt: string;
  module?: string;
  runtimeId?: string;
  language?: string;
  // Stable identity — see HandlerEntry.entityUid (Stream A / A2).
  entityUid: string;
}

export interface KernelInspectAPI {
  listRoutes(): RouteEntry[];
  listHandlers(): Array<{ name: string; source: string; registeredAt: string }>;
  listFunctions(): Array<
    { name: string; source: string; registeredAt: string; returnType?: string }
  >;
  listConfigs(): Array<
    {
      name: string;
      type: string;
      description?: string;
      updatedAt: string;
      module?: string;
    }
  >;
  listSchemas(): Promise<SchemaEntry[]>;
  listTypes(): Array<
    {
      name: string;
      fields: TypeFieldDef[];
      description?: string;
      registeredAt: string;
    }
  >;
  listDevViews(): Array<
    { name: string; targetType: string; title: string; builtIn: boolean }
  >;
  getAssetContent(name: string): string | null;
  getDevViewSource(name: string): string | null;
}

export type ViewDescriptor =
  | ViewTable
  | ViewCode
  | ViewKeyValue
  | ViewMarkdown
  | ViewTree
  | ViewStack
  | ViewImage;

export interface ViewTable {
  type: "table";
  title?: string;
  columns: string[];
  rows: unknown[][];
}

export interface ViewCode {
  type: "code";
  title?: string;
  source: string;
  language?: string;
}

export interface ViewKeyValue {
  type: "key-value";
  title?: string;
  entries: Array<{ key: string; value: string; mono?: boolean }>;
}

export interface ViewMarkdown {
  type: "markdown";
  content: string;
}

export interface ViewTree {
  type: "tree";
  title?: string;
  data: unknown;
}

export interface ViewStack {
  type: "stack";
  children: ViewDescriptor[];
  gap?: number;
}

export interface ViewImage {
  type: "image";
  title?: string;
  src: string;
  alt?: string;
}

// --- Session Management ---

// Session + SessionWithLastMessage are the open wire contract for the session
// surface; their canonical home is the L0 shared/ package (shared with the IDE).
// Re-exported here so existing core callers import them from ./types.ts unchanged.
export type { Session, SessionWithLastMessage } from "../shared/sessions.ts";

export interface StoredMessage {
  id: number;
  sessionId: string;
  role: "user" | "assistant" | "system";
  kind: "chat" | "shell";
  content: string;
  toolCalls: string | null;
  pinned: boolean;
  projectPinned?: boolean;
  turnId: string | null;
  createdAt: string;
  authorUserId?: string | null;
}

// --- Agent Usage Tracking ---

// TurnUsage + AggregatedUsage are the open wire contract for the usage surface;
// their canonical home is the L0 shared/ package (shared with the IDE).
// Re-exported here so existing core callers import them from ./types.ts unchanged.
export type { AggregatedUsage, TurnUsage } from "../shared/sessions.ts";

export type ModelUsageRole =
  | "agent"
  | "planning"
  | "import"
  | "utility"
  | "verification"
  | "pricing";
export type ModelUsagePricingStatus =
  | "priced"
  | "unpriced"
  | "estimated_legacy";
export type ModelUsageProvider = string;

export interface ModelUsageRecord {
  id: string;
  sessionId: string | null;
  turnId: string | null;
  auditResultId: string | null;
  changesetId: string | null;
  provider: ModelUsageProvider;
  model: string;
  role: ModelUsageRole;
  caller: string;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
  toolCallsCount: number;
  costUsd: number | null;
  pricingStatus: ModelUsagePricingStatus;
  pricingProvider: ModelUsageProvider | null;
  pricingModel: string | null;
  pricingVerifiedAt: string | null;
  // WHICH table priced this row — built_in, models_dev, manual, verified. The
  // other three provenance fields say what was priced and when the source last
  // claimed to be current; only this one says where the number came from, which
  // is what makes a bad pricing window findable in the ledger after the fact
  // (docs/agent-cost-reduction.md §4.10). Null on unpriced rows and on rows
  // written before the column existed.
  pricingSource: PricingSource | null;
  metadata: Record<string, unknown>;
}

export interface RecordModelUsageInput {
  id?: string;
  sessionId?: string | null;
  turnId?: string | null;
  auditResultId?: string | null;
  changesetId?: string | null;
  provider: ModelUsageProvider;
  model: string;
  role: ModelUsageRole;
  caller: string;
  startedAt: Date | string;
  endedAt: Date | string;
  durationMs?: number;
  usage: {
    inputTokens: number;
    outputTokens: number;
    cacheCreationInputTokens: number;
    cacheReadInputTokens: number;
    // TTL the cache writes were made at, when the provider set an explicit one.
    // Absent = the 5m default; the ledger's cost calc reads it so a 1h write is
    // priced at 2x input rather than 1.25x (docs/agent-cost-reduction.md §4.9).
    cacheTtl?: CacheTtl;
  };
  toolCallsCount?: number;
  metadata?: Record<string, unknown>;
}

// --- Audits ---

// The audit result wire vocabulary now lives in the L0 shared/ package (open).
// Imported for internal use (the const below, store contracts, package/agent audit
// types) and re-exported so existing core callers import them from ./types.ts
// unchanged.
import type {
  AuditCategory,
  AuditIssue,
  AuditResult,
  BuiltInAuditCategory,
} from "../shared/audits.ts";
export type {
  AuditCategory,
  AuditIssue,
  AuditResult,
  AuditSeverity,
  AuditStatus,
  BuiltInAuditCategory,
} from "../shared/audits.ts";

export const BUILTIN_AUDIT_CATEGORIES: BuiltInAuditCategory[] = [
  "security",
  "performance",
  "seo",
  "accessibility",
  "code-quality",
];

export interface CustomAuditEntry {
  name: string;
  description: string;
  prompt: string;
  registeredAt: string;
  module?: string;
  // Stable identity — see HandlerEntry.entityUid (Stream A / A2).
  entityUid: string;
}

// Package-security audit vocabulary, relocated here from audit-packages.ts so the
// core tool-capability registry (tool-capabilities.ts) can type the auditPackages
// handler without importing upward into verification (§3.2). audit-packages.ts
// re-exports them.
export interface PackageInput {
  name: string;
  specifier: string;
}

export interface PackageSecurityResult {
  issues: AuditIssue[];
  summary: string;
  score: number;
  packageCount: number;
  vulnerabilities: number;
  outdated: number;
  deprecated: number;
}

// One audit definition: a category plus the system prompt that drives it. The
// prompt is deterministic data (audit-configs.ts, verification); the model call
// that consumes it lives in the agent layer behind the audit-provider hook.
export interface AgentAuditConfig {
  category: AuditCategory;
  systemPrompt: string;
}

// --- Verification / changeset vocabulary ---
// The deterministic "shows its work" wire contract. Its canonical home is the L0
// shared/ package (shared/verification.ts), OPEN per D9 — the verification
// mechanism is the adoption wedge. Imported here for internal use by the store
// contracts below, and re-exported so existing core callers (config, qc,
// project-doctor, session-summary, control-server) and the verification layer
// (changesets.ts re-exports these in turn) import them from ./types.ts unchanged.
import type {
  AttestationInput,
  ChangeClass,
  Changeset,
  ChangesetPlan,
  ChangesetPlanAmendment,
  ChangesetStatus,
  ChangesetStep,
  FormalSpecEnforcement,
  LedgerEntry,
  LedgerQuery,
  ProposedCriterion,
  VerificationRun,
} from "../shared/verification.ts";
export type {
  Attestation,
  AttestationInput,
  AttestationKind,
  ChangeClass,
  Changeset,
  ChangesetPlan,
  ChangesetPlanAmendment,
  ChangesetReadiness,
  ChangesetReadinessIssue,
  ChangesetStatus,
  ChangesetStep,
  FormalSpec,
  FormalSpecEnforcement,
  FormalSpecTechnique,
  LedgerEntry,
  LedgerQuery,
  ProportionalVerification,
  ProposedCriterion,
  ReadinessEnforcement,
  VerificationCheck,
  VerificationCheckKind,
  VerificationClaim,
  VerificationClaimPriority,
  VerificationClaimResult,
  VerificationClaimSource,
  VerificationEvidence,
  VerificationRun,
  VerificationStatus,
  VerificationTier,
} from "../shared/verification.ts";

// --- Production-build result projection (Milestone 5, Slice 5.1) ---
// The wire DTO for the production-build result — the serializable, target-grouped
// shape the HTTP API (5.2), the Production Build UI (5.3), and the ledger (5.4)
// consume. Its canonical home is the L0 shared/ package
// (shared/production-build.ts), OPEN like the verification surface above; the
// pure projection that produces it lives in
// verification/production-build-report.ts. Re-exported here so backend callers
// import it from ./types.ts like every other shared wire type.
// The async build-job envelope (Slice 5.2) rides the same shared home: the
// endpoint returns it, the IDE (5.3) polls it, and its `download` carries the
// tarball digest the projection deferred.
export type {
  ProductionArtifactSummary,
  ProductionBuildDownload,
  ProductionBuildJob,
  ProductionBuildJobStatus,
  ProductionBuildResult,
  ProductionGateResult,
  ProductionGateStatus,
  ProductionTargetKey,
  ProductionTargetRollup,
} from "../shared/production-build.ts";

// The wire DTO for the committed-lock REFRESH surface (Milestone 7, Slice 7.2) —
// the serializable per-target result the refresh HTTP API returns and the IDE
// renders. Its canonical home is the L0 shared/ package (shared/lock-refresh.ts),
// OPEN like the production-build surface above; the pure projection that produces
// it lives in verification/production-lock-refresh-report.ts. Re-exported here so
// backend callers import it from ./types.ts like every other shared wire type.
export type {
  LockRefreshJob,
  LockRefreshJobStatus,
  LockRefreshResult,
  LockRefreshTargetResult,
  RefreshTargetKey,
  RefreshTargetStatus,
} from "../shared/lock-refresh.ts";

// --- Pricing research (Stage 2B Slice 2, D10) ---
// The extraction half of agent-driven pricing: a model reads a moving/reshaped
// source and reports per-model rates. These vocabulary types live here (core) so
// the agent module never imports upward and a future tool-capability handler can
// type the researcher without reaching into agent/ — the same §3.2 reason the
// refutation types above were relocated. PricingTier is imported type-only from
// usage.ts (no cycle: usage.ts imports nothing from here).
import type {
  CacheTtl,
  ModelPricing,
  PricingSource,
  PricingTier,
  ProviderModelPricing,
} from "./usage.ts";
// Re-exported so ledger callers shaping a RecordModelUsageInput can name the TTL
// without reaching into usage.ts directly.
export type { CacheTtl } from "./usage.ts";
import type { ModelProviderId } from "./config.ts";

// One extracted pricing row — what the model READ, verbatim-ish. Currency/unit are
// captured AS READ (never normalized) so the Slice 3 verification gate can reject a
// non-USD/non-MTok row before it is ever written. `tier` is set by mapping `apiId`
// through resolvePricingTier (the shared id→tier map), absent when the id maps to no
// tier or only a flagged in-family fallthrough. Cache rates are deliberately NOT
// here: a candidate materializes to ModelPricing via deriveCacheRates, so an
// extracted cache number can never enter the table.
export interface PricingCandidate {
  apiId: string;
  provider?: ModelProviderId;
  model?: string;
  tier?: PricingTier; // from resolvePricingTier; absent ⇒ unmapped
  input: number;
  output: number;
  currency: string; // as read, e.g. "USD"
  unit: string; // as read, e.g. "MTok"
  source: string; // the source URL this row was extracted from
  quote?: string; // the snippet the price was read from
}

// The result of one research run: the tier-mapped candidate table plus provenance.
// Surfaced for review — Slice 2 writes NOTHING to config. `unmapped` collects the
// apiIds that resolved to no tier (or only a flagged fallthrough), so a mispriced
// id is never silently tiered. `extractedAt` is the completion timestamp threaded
// into cost attribution (like the refute/audit agents), not a report-time default.
export interface PricingExtraction {
  candidates: PricingCandidate[];
  // The per-attempt tier-assigned lists (one array per independent extraction
  // attempt), kept alongside the merged `candidates` surface view so the Slice 3
  // verification gate can adjudicate agreement ACROSS attempts (mergeCandidates
  // collapses them first-wins, which the gate can't use). Untiered rows are kept
  // in each attempt list — adjudicatePricing routes them to `unmapped`.
  attempts: PricingCandidate[][];
  sourceUrl: string;
  extractedAt: string;
  model: string;
  costUsd: number;
  pricingStatus?: "priced" | "unpriced";
  unmapped: string[];
  notes?: string;
}

export interface PricingModelAccounting {
  role: ModelUsageRole;
  caller: string;
  sessionId?: string | null;
  turnId?: string | null;
  auditResultId?: string | null;
  changesetId?: string | null;
  metadata?: Record<string, unknown>;
  recordUsage?: (input: RecordModelUsageInput) => Promise<ModelUsageRecord>;
}

export interface PricingModelCall {
  (prompt: {
    system: string;
    user: string;
    accounting?: PricingModelAccounting;
  }): Promise<{
    text: string;
    inputTokens: number;
    outputTokens: number;
    cacheCreationInputTokens: number;
    cacheReadInputTokens: number;
    modelUsage?: ModelUsageRecord;
  }>;
}

export interface PricingDocFetch {
  (url: string): Promise<Result<string>>;
}

export interface RunPricingResearchOpts {
  attempts?: number;
  provider?: ModelProviderId;
  model?: string;
  sourceUrls?: string[];
  callModel?: PricingModelCall;
  fetchDoc?: PricingDocFetch;
  recordUsage?: (
    input: RecordModelUsageInput,
  ) => Promise<ModelUsageRecord>;
}

// --- Verification gate (Stage 2B Slice 3, D10 write half) ---
// The gate turns extracted candidates into a WRITE only when independent attempts
// agree and the row passes deterministic sanity bounds. These vocabulary types live
// here (core) for the same §3.2 reason as PricingCandidate: the L3 agent flow that
// runs the gate never imports upward, and the pure adjudicator (core/pricing-verify)
// shares them with it.

// Per-tier provenance stamped at write time, replacing the single hand-edited global
// PRICING_VERIFIED_AS_OF for agent-written tiers. `agreement` = how many independent
// extractors concurred (agent attempts + an optional corroborating scrape voter). A
// written price can never lack this: setVerifiedPricing writes both atomically.
export interface PricingProvenance {
  sourceUrl: string;
  extractedAt: string;
  model: string;
  provider?: ModelProviderId;
  targetModel?: string;
  agreement: number;
}

// One adjudicated tier. `accepted` is true only when `reasons` is empty; otherwise
// `reasons` explains the rejection ("disagreement", "output<input", "out-of-bounds",
// "non-usd", "non-mtok", "no-prior"). `proposed` is always materialized (for the
// report) but written only when accepted AND apply mode is on.
export interface PricingDecision {
  tier?: PricingTier;
  apiId: string;
  provider?: ModelProviderId;
  model?: string;
  proposed: ModelPricing;
  proposedProviderPricing?: ProviderModelPricing;
  accepted: boolean;
  agreement: number;
  reasons: string[];
  provenance: PricingProvenance;
}

// The full verdict of one adjudication pass. `accepted`/`rejected` partition
// `decisions`; `unmapped` collects apiIds that resolved to no tier (never written).
export interface PricingGateReport {
  decisions: PricingDecision[];
  accepted: PricingDecision[];
  rejected: PricingDecision[];
  unmapped: string[];
}

// --- Store contracts (Kernel-manager inversion) ---
// The Kernel exposes changesets/audits typed as these interfaces; the concrete
// managers (verification layer) implement them and are registered as factories
// so core never imports them (OpenTide §3.3).

// Dependencies of ChangesetStore.aggregate — rolls turn usage across a
// changeset's changes.
export interface ChangesetUsageSource {
  getTurnUsage(
    turnId: string,
  ): Promise<
    {
      inputTokens?: number;
      cacheCreationInputTokens?: number;
      cacheReadInputTokens?: number;
      outputTokens?: number;
      costUsd?: number | null;
      pricingStatus?: ModelUsagePricingStatus;
      durationMs?: number;
    } | null
  >;
  getModelUsagesForTurn?(
    turnId: string,
  ): Promise<ModelUsageRecord[]>;
  getModelUsagesForChangeset?(
    changesetId: string,
  ): Promise<ModelUsageRecord[]>;
}

export interface ChangesetChangelogSource {
  listByChangeset(
    changesetId: string,
  ): Promise<Array<{ turnId: string | null }>>;
}

// A user edit to a formal spec: relax/promote enforcement, or remove it.
export interface FormalSpecPatch {
  enforcement?: FormalSpecEnforcement;
  remove?: boolean;
}

// The changeset governance surface the Kernel exposes as `kernel.changesets`.
export interface ChangesetStore {
  create(opts: {
    sessionId?: string;
    title: string;
    description?: string;
    plan: ChangesetPlan;
    planMessageIds?: number[];
    creatorUserId?: string | null;
  }): Promise<Changeset>;
  get(id: string): Promise<Changeset | null>;
  list(
    opts?: { sessionId?: string; status?: ChangesetStatus; limit?: number },
  ): Promise<Changeset[]>;
  updatePlan(id: string, plan: ChangesetPlan): Promise<Changeset>;
  amendPlan(
    id: string,
    amendment: ChangesetPlanAmendment,
  ): Promise<Changeset>;
  approve(id: string, approvalMessageId?: number): Promise<Changeset>;
  startWork(id: string): Promise<Changeset>;
  updateStep(
    id: string,
    stepId: string,
    status: ChangesetStep["status"],
  ): Promise<Changeset>;
  addWorkMessageId(id: string, messageId: number): Promise<Changeset>;
  addPlanMessageId(id: string, messageId: number): Promise<Changeset>;
  setApprovalMessageId(id: string, messageId: number): Promise<Changeset>;
  complete(id: string): Promise<Changeset>;
  abandon(id: string): Promise<Changeset>;
  reject(id: string): Promise<Changeset>;
  // Resolves the given session's leftover active changesets; never another's.
  completeStaleChangesets(sessionId: string | null): Promise<Changeset[]>;
  getActive(sessionId?: string): Promise<Changeset | null>;
  patch(
    id: string,
    fields: { title?: string; description?: string },
  ): Promise<Changeset | null>;
  // Hands an active changeset to another session (adopt_changeset).
  reassignSession(id: string, sessionId: string): Promise<Changeset | null>;
  aggregate(
    id: string,
    sessions: ChangesetUsageSource,
    changelog: ChangesetChangelogSource,
  ): Promise<Changeset>;
  recordVerificationRun(
    id: string,
    run: Omit<VerificationRun, "id" | "createdAt" | "completedAt"> & {
      id?: string;
      createdAt?: string;
      completedAt?: string;
    },
  ): Promise<Changeset>;
  recordAttestation(id: string, att: AttestationInput): Promise<Changeset>;
  // Kernel-only write of the adjudicated change class (proportional verification).
  // Separate from updatePlan because updatePlan is a PLANNING-status operation and
  // this must work on an in_progress changeset — the completion gate re-adjudicates
  // the declared class against the changelog and records the verdict, exactly as
  // recordAttestation writes kernel-minted proof onto a running changeset.
  recordChangeClass(id: string, changeClass: ChangeClass): Promise<Changeset>;
  // Kernel-only, same provenance rule as recordAttestation: the independent
  // criteria are written by the completion gate from a model call, never copied
  // from agent-supplied plan input. Replaces the set wholesale — the proposals
  // judge the CURRENT diff, so a superseded set is noise.
  recordIndependentCriteria(
    id: string,
    criteria: ProposedCriterion[],
  ): Promise<Changeset>;
  recordLedgerEntry(entry: LedgerEntry): Promise<void>;
  listLedger(query?: LedgerQuery): Promise<LedgerEntry[]>;
  pruneLedger(keep: number): Promise<number>;
  patchFormalSpec(
    id: string,
    specId: string,
    patch: FormalSpecPatch,
  ): Promise<Changeset>;
  deleteBySession(sessionId: string): Promise<string[]>;
}

// One inbound MCP tool call, as the call audit keeps it (verification/
// mcp-audit.ts). Metadata only: argument and result contents are never stored.
export interface McpCallRecord {
  id: number;
  principalId: string;
  toolName: string;
  sessionId: string | null;
  transport: "stdio" | "http";
  decision: "allow" | "deny";
  reason: string | null;
  changesetId: string | null;
  argBytes: number;
  createdAt: string;
}

export type McpCallInput = Omit<McpCallRecord, "id" | "createdAt">;

// The MCP call audit the Kernel exposes as `kernel.mcpAudit`.
export interface McpAuditStore {
  recordMcpCall(call: McpCallInput): Promise<void>;
  // Newest first.
  list(limit?: number): Promise<McpCallRecord[]>;
}

// The audit-results surface the Kernel exposes as `kernel.audits`.
export interface AuditStore {
  loadFromDb(): Promise<void>;
  store(result: AuditResult): Promise<void>;
  get(id: string): AuditResult | undefined;
  latest(category: AuditCategory): AuditResult | undefined;
  listByCategory(category: AuditCategory): AuditResult[];
  list(): AuditResult[];
  clearCategory(category: AuditCategory): Promise<void>;
  removeIssue(auditId: string, issueIndex: number): Promise<boolean>;
  clearIssues(auditId: string): Promise<boolean>;
  clear(): Promise<void>;
}
