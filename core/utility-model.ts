// @layer core — the neutral utility-role model seam (multi-model harness,
// docs/multi-model-harness-plan.md §5 Stage 5).
//
// This is the one-shot, non-streaming sibling of core/model-provider.ts's
// streaming ModelProvider seam. Where streamTurn drives the interactive chat
// loop, callUtilityModel serves the kernel's many small "ask the model once,
// parse the reply" jobs: approval classification, adversarial refutation,
// model-backed audits, pricing extraction, session naming/summaries, commit
// subjects, and inline completions.
//
// Like the streaming seam, the CONTRACT lives here in core (L1) free of any
// provider SDK, and a concrete impl (providers/utility-provider.ts, L2) is
// injected by the composition root (cli/assembly.ts) via installUtilityModelProvider.
// Core call sites reach the provider through this indirection because core must
// not import upward into providers/ (OpenTide §3.2/§3.3); the SDK is thereby
// owned in exactly one layer (providers/), the whole point of Stage 5.

import type {
  ModelUsageProvider,
  ModelUsageRecord,
  ModelUsageRole,
  RecordModelUsageInput,
} from "./types.ts";
import type { CacheTtl } from "./usage.ts";

export interface UtilityModelAccounting {
  role: ModelUsageRole;
  caller: string;
  sessionId?: string | null;
  turnId?: string | null;
  auditResultId?: string | null;
  changesetId?: string | null;
  metadata?: Record<string, unknown>;
  recordUsage?: (input: RecordModelUsageInput) => Promise<ModelUsageRecord>;
}

// A single one-shot request. `system` is optional (some callers bake their
// instructions into `user`); a single user turn is all the utility jobs need.
// `timeoutMs`/`timeoutMessage` are optional: when set the impl races the call and
// rejects with `timeoutMessage` (each site keeps its exact wording, so routing a
// site through the seam is behavior-preserving down to the timeout string).
export interface UtilityModelRequest {
  system?: string;
  // A large, byte-stable block that PRECEDES `user` in the prompt and is offered to
  // the provider as a cache breakpoint (docs/agent-cost-reduction.md §4.5). Callers
  // that repeat the same bulk context across many calls — refutation sends the same
  // code to every claim in a gate run — put it here and keep only the varying part
  // in `user`. Providers without prompt caching concatenate it onto `user`, so the
  // prompt the model sees is the same either way.
  cachePrefix?: string;
  user: string;
  model: string;
  maxTokens: number;
  temperature?: number;
  timeoutMs?: number;
  timeoutMessage?: string;
  accounting?: UtilityModelAccounting;
}

// Provider-neutral token counts, mirroring the streaming seam's TurnUsage fields
// the utility callers attribute cost from (audit/refute/pricing). Cache counts
// are 0 when the provider reports none.
export interface UtilityModelUsage {
  // Uncached input tokens only; cache write/read are separate billing buckets.
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
  // Set by the provider when it wrote the cache at a non-default TTL, so the ledger
  // can price the write correctly (1h writes at 2x input, not 1.25x). Absent = 5m.
  cacheTtl?: CacheTtl;
}

// The one-shot result: the concatenated text of the reply's text blocks plus the
// neutral usage. Callers own their own parsing (JSON slice, first-line, regex).
export interface UtilityModelResult {
  text: string;
  usage: UtilityModelUsage;
  provider?: ModelUsageProvider;
  model?: string;
  modelUsage?: ModelUsageRecord;
}

export type UtilityModelCall = (
  req: UtilityModelRequest,
) => Promise<UtilityModelResult>;

// Message surfaced when no provider is installed (keyless/coreless boots) and no
// test override is set. Call sites already guard on a key + configured model
// before reaching here, so in practice this only fires in a misassembled stack;
// every site catches it and degrades to its deterministic fallback.
export const UTILITY_MODEL_UNINSTALLED_MESSAGE =
  "No utility model provider is installed for this stack.";

// The composition-installed concrete impl (providers/utility-provider.ts) and the
// test override. testOverride wins so a unit test can exercise a seamless site
// with a canned reply and no network — the analogue of the per-agent seams
// (setApprovalMessageModelCallForTest, __setRefuteModelForTests).
let installed: UtilityModelCall | null = null;
let testOverride: UtilityModelCall | null = null;
let usageRecorder:
  | ((input: RecordModelUsageInput) => Promise<ModelUsageRecord>)
  | null = null;

// Wire the concrete provider. Called by the composition roots (cli/assembly.ts)
// once per boot; idempotent, so re-installing the same stateless impl is safe.
export function installUtilityModelProvider(call: UtilityModelCall): void {
  installed = call;
}

// Test seam: override the effective utility call for the seamless sites (audit,
// session-summary, session-name, ai-completions) that have no per-call injection
// point of their own. Returns a restore closure. Production never sets this.
export function setUtilityModelCallForTest(
  call: UtilityModelCall | null,
): () => void {
  const previous = testOverride;
  testOverride = call;
  return () => {
    testOverride = previous;
  };
}

export function installUtilityModelUsageRecorder(
  recorder: (input: RecordModelUsageInput) => Promise<ModelUsageRecord>,
): void {
  usageRecorder = recorder;
}

export function setUtilityModelUsageRecorderForTest(
  recorder:
    | ((input: RecordModelUsageInput) => Promise<ModelUsageRecord>)
    | null,
): () => void {
  const previous = usageRecorder;
  usageRecorder = recorder;
  return () => {
    usageRecorder = previous;
  };
}

// The single entry point every utility call site delegates to. Dispatches to the
// test override, then the composition-installed provider; rejects when neither is
// present rather than silently returning empty (a caller's catch turns that into
// its fallback).
export function callUtilityModel(
  req: UtilityModelRequest,
): Promise<UtilityModelResult> {
  const call = testOverride ?? installed;
  if (!call) {
    return Promise.reject(new Error(UTILITY_MODEL_UNINSTALLED_MESSAGE));
  }
  return callUtilityModelAndRecord(call, req);
}

async function callUtilityModelAndRecord(
  call: UtilityModelCall,
  req: UtilityModelRequest,
): Promise<UtilityModelResult> {
  const startedAt = new Date();
  const result = await call(req);
  const endedAt = new Date();
  const recordUsage = req.accounting?.recordUsage ?? usageRecorder;
  if (!req.accounting || !recordUsage) return result;

  const provider = result.provider ?? "anthropic";
  const model = result.model ?? req.model;
  const modelUsage = await recordUsage({
    sessionId: req.accounting.sessionId ?? null,
    turnId: req.accounting.turnId ?? null,
    auditResultId: req.accounting.auditResultId ?? null,
    changesetId: req.accounting.changesetId ?? null,
    provider,
    model,
    role: req.accounting.role,
    caller: req.accounting.caller,
    startedAt,
    endedAt,
    usage: result.usage,
    metadata: req.accounting.metadata,
  });
  return { ...result, provider, model, modelUsage };
}
