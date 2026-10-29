// @layer core — reviews the connected client runs.
//
// Refutation, independent criteria and model audits need a model, and the
// server doesn't call one. request_review hands the client a packet: what to
// review, the code, the instructions and the answer's shape. submit_review
// checks the answer and records it the way the server used to record its own
// reviewer's. The client picks the model and pays for it; the server decides
// what is owed, builds what the reviewer sees, and applies the rules.
//
// A client's pass comes from the agent that wrote the code, and nothing proves
// it reviewed in a fresh context. Its attestations say so (`producer: "client"`
// and the reviewer it names). Its refutations are as good as anyone's.
import type { Kernel } from "./registries.ts";
import type { ChangeContext } from "./changelog.ts";
import type {
  AgentAuditConfig,
  AttestationKind,
  AuditIssue,
  AuditResult,
  AuditSeverity,
  Changeset,
  ProposedCriterion,
  Result,
  VerificationClaim,
  VerificationClaimPriority,
  VerificationStatus,
} from "./types.ts";
import {
  buildChangedScopeContext,
  buildClaimContext,
  buildCodeContext,
  changedScopesOf,
} from "./code-context.ts";
import { fingerprintProject, PROJECT_SCOPE } from "./fingerprint.ts";
import {
  INDEPENDENT_CRITERIA_MAX,
  INDEPENDENT_CRITERION_MAX_CHARS,
  REVIEW_PACKETS_MAX,
} from "./config.ts";
import { createTimestampedId } from "./ids.ts";
import { computeAuditScore, formatAuditSummary } from "./audit-scoring.ts";
import {
  codebaseGraphEntityIds,
  IMPORT_CLASSIFIER_MAPPING_CONFIDENCE_MIN,
  type ImportClassification,
  type ImportClassifierRequest,
  importClassifierResultToSemanticContribution,
  mergeCodebaseContributions,
  parseImportClassification,
} from "./codebase/index.ts";
import type { CodebaseGraph } from "./codebase/types.ts";
import { errorMessage } from "./util.ts";

export type ReviewKind = "refute" | "criteria" | "audit" | "imports";
export const REVIEW_KINDS: readonly ReviewKind[] = [
  "refute",
  "criteria",
  "audit",
  "imports",
];

type Confidence = "high" | "medium" | "low";

// --- packets -----------------------------------------------------------------

interface PacketBase {
  packetId: string;
  // What the reviewer is told. A client with its own tuned reviewer may ignore
  // it; the context and the answer's shape are what it can't.
  instructions: string;
  // How to submit the answer.
  response: string;
}

export interface RefuteClaimTarget {
  id: string;
  text: string;
  priority: VerificationClaimPriority;
  // The key into `contexts`. Claims that share code share a context, so it
  // crosses the wire once.
  contextId: string;
}

// A claim with a verdict already fresh against the current code. Not reviewed
// again unless the request forces it.
export interface ReusedVerdict {
  claimId: string;
  claimText: string;
  refuted: boolean;
  summary: string;
}

export interface RefutePacket extends PacketBase {
  kind: "refute";
  changesetId: string;
  claims: RefuteClaimTarget[];
  contexts: Record<string, string>;
  reused: ReusedVerdict[];
}

export interface CriteriaPacket extends PacketBase {
  kind: "criteria";
  changesetId: string;
  // The user's words, when the session has them; otherwise the changeset's own
  // title and description, and requestFromUser says so.
  request: string;
  requestFromUser: boolean;
  context: string;
}

export interface AuditPacket extends PacketBase {
  kind: "audit";
  category: string;
  context: string;
}

// The last index_codebase's classifier input: the graph summary, package and
// framework hints, and bounded source excerpts.
export interface ImportsPacket extends PacketBase {
  kind: "imports";
  request: ImportClassifierRequest;
}

export type ReviewPacket =
  | RefutePacket
  | CriteriaPacket
  | AuditPacket
  | ImportsPacket;

// --- verdicts ----------------------------------------------------------------

// One attempt at one claim. A claim may get several; one confident, concrete
// counterexample refutes it.
export interface RefuteAttempt {
  claimId: string;
  refuted: boolean;
  confidence: Confidence;
  counterexample?: string;
  reasoning?: string;
}

export interface RefuteVerdict {
  results: RefuteAttempt[];
}

export interface CriteriaVerdict {
  criteria: Array<{
    text: string;
    priority?: VerificationClaimPriority;
    rationale?: string;
  }>;
}

export interface AuditVerdict {
  issues: AuditIssue[];
}

export type ImportsVerdict = ImportClassification;

export type ReviewVerdict =
  | RefuteVerdict
  | CriteriaVerdict
  | AuditVerdict
  | ImportsVerdict;

// --- the instructions an open client gets ------------------------------------

const FRESH_CONTEXT =
  "Run this review in a fresh context, a subagent or a new conversation, not " +
  "in the conversation that wrote the code. Reason only from the code given; " +
  "don't assume behaviour you can't see.";

const REFUTE_INSTRUCTIONS = `${FRESH_CONTEXT}

For each claim, try to disprove it: find a specific input, state or sequence under which the code fails it. The code for a claim is contexts[claim.contextId].

- Only a concrete counterexample is a refutation: the exact inputs or conditions and the wrong outcome. A vague worry is not.
- Use confidence "high" only when the counterexample clearly holds against the code shown.
- If you find none after a real attempt, report refuted: false. Never invent one.
- You may send several attempts for a claim. One high-confidence attempt with a counterexample refutes it.`;

const REFUTE_RESPONSE =
  'submit_review { packet_id, verdict: { results: [{ claimId, refuted, confidence: "high" | "medium" | "low", counterexample, reasoning }] } }, ' +
  "with at least one result for every claim in the packet.";

const CRITERIA_INSTRUCTIONS = `${FRESH_CONTEXT}

You get the user's request and the code as it stands, and none of what the implementer claimed. Keep it that way. Say what the request required, especially what a hurried implementer skips: the empty case, the duplicate, the second concurrent caller, the boundary value, the failure path.

- Each criterion is concrete and user-observable: a behaviour, input or state, and the outcome it must produce.
- Don't restate the request as one criterion. Don't propose code-style preferences.
- "must" only for behaviour the request is worthless without.
- At most ${INDEPENDENT_CRITERIA_MAX}. An empty list means you found nothing missing.`;

const CRITERIA_RESPONSE =
  'submit_review { packet_id, verdict: { criteria: [{ text, priority: "must" | "should" | "nice", rationale }] } }';

const IMPORTS_INSTRUCTIONS = `${FRESH_CONTEXT}

Classify this TypeScript/JavaScript project from its index: the graph summary, package and framework hints, and source excerpts. Say what the deterministic index couldn't: which framework conventions it follows, which symbols are routes, handlers, functions, schemas or components, and where conversion is risky.

- Every claim needs evidence in the excerpts or hints. Leave out what you can't support, or report it as a diagnostic.
- Confidence runs from 0 to 1. Mappings below ${IMPORT_CLASSIFIER_MAPPING_CONFIDENCE_MIN} aren't applied.
- Candidate entities are suggestions for a human, not registry writes.
- Give locations as {file, startLine, startColumn} where the source shows it.`;

const IMPORTS_RESPONSE =
  'submit_review { packet_id, verdict: { facts: [{ kind, name, value, confidence }], mappings: [{ kind: "route" | "handler" | "function" | "schema" | "component", name, confidence, ... }], diagnostics: [{ severity, message }], candidateEntities: [{ entityType, name, confidence, rationale }] } }';

const AUDIT_RESPONSE =
  'submit_review { packet_id, verdict: { issues: [{ severity: "critical" | "high" | "medium" | "low" | "info", rule, message, entity, line, suggestion }] } }';

// --- issued packets ----------------------------------------------------------

// What the server remembers about a packet it issued. The packet itself isn't
// kept: everything the verdict is checked against is here.
interface IssuedPacket {
  id: string;
  kind: ReviewKind;
  fingerprint: string;
  issuedAt: string;
  changesetId?: string;
  claims?: Array<{ id: string; text: string }>;
  category?: string;
  requestFromUser?: boolean;
  // imports: the graph the classification describes. Staleness is a new index,
  // not a code fingerprint: source-backed files aren't in the fingerprint.
  graph?: CodebaseGraph;
  used: boolean;
}

// In memory, per kernel: a packet is answered within a turn, and a restart
// just means asking again.
const issuedByKernel = new WeakMap<Kernel, Map<string, IssuedPacket>>();

function issuedPackets(kernel: Kernel): Map<string, IssuedPacket> {
  let packets = issuedByKernel.get(kernel);
  if (!packets) {
    packets = new Map();
    issuedByKernel.set(kernel, packets);
  }
  return packets;
}

function remember(kernel: Kernel, packet: IssuedPacket): void {
  const packets = issuedPackets(kernel);
  packets.set(packet.id, packet);
  // Oldest first: Map keeps insertion order.
  for (const id of packets.keys()) {
    if (packets.size <= REVIEW_PACKETS_MAX) break;
    packets.delete(id);
  }
}

function issue(
  kernel: Kernel,
  fields: Omit<IssuedPacket, "id" | "fingerprint" | "issuedAt" | "used">,
): IssuedPacket {
  const packet: IssuedPacket = {
    ...fields,
    id: createTimestampedId("rvw"),
    fingerprint: fingerprintProject(kernel),
    issuedAt: new Date().toISOString(),
    used: false,
  };
  remember(kernel, packet);
  return packet;
}

// --- request_review ----------------------------------------------------------

export interface ReviewDeps {
  // The audit's configuration, built-in or custom. Verification owns the
  // built-in configs, so the composition supplies this.
  auditConfig(category: string): AgentAuditConfig | undefined;
  auditCategories(): string[];
}

export interface RequestReviewInput {
  kind: ReviewKind;
  changesetId?: string;
  claimIds?: string[];
  force?: boolean;
  category?: string;
}

export async function requestReview(
  kernel: Kernel,
  input: RequestReviewInput,
  context: ChangeContext | null,
  deps: ReviewDeps,
): Promise<Result<ReviewPacket>> {
  if (input.kind === "audit") return requestAudit(kernel, input, deps);
  if (input.kind === "imports") return requestImports(kernel);
  const changeset = await resolveChangeset(kernel, input.changesetId, context);
  if (!changeset.ok) return changeset;
  return input.kind === "refute"
    ? { ok: true, data: await requestRefute(kernel, changeset.data, input) }
    : { ok: true, data: await requestCriteria(kernel, changeset.data) };
}

async function resolveChangeset(
  kernel: Kernel,
  changesetId: string | undefined,
  context: ChangeContext | null,
): Promise<Result<Changeset>> {
  const changeset = changesetId
    ? await kernel.changesets.get(changesetId)
    : await kernel.changesets.getActive(context?.sessionId);
  if (changeset) return { ok: true, data: changeset };
  return {
    ok: false,
    error: changesetId
      ? {
        code: "CHANGESET_NOT_FOUND",
        message: `Changeset "${changesetId}" not found.`,
      }
      : {
        code: "NO_ACTIVE_CHANGESET",
        message: "No active changeset found.",
        suggestion: "Pass changeset_id.",
      },
  };
}

// The claims a refute review covers: the ones asked for, or every `must`
// claim, each once.
export function refuteTargets(
  changeset: Changeset,
  claimIds: readonly string[] | undefined,
): VerificationClaim[] {
  const all = changeset.plan.acceptanceCriteria ?? [];
  const wanted = claimIds && claimIds.length > 0
    ? all.filter((c) => claimIds.includes(c.id))
    : all.filter((c) => c.priority === "must");
  return [...new Map(wanted.map((claim) => [claim.id, claim])).values()];
}

// The latest adversarial verdict on a claim, if it was minted against the code
// as it is now.
function freshVerdict(
  changeset: Changeset,
  claimId: string,
  fingerprint: string,
) {
  const latest = (changeset.plan.attestations ?? [])
    .filter((a) => a.kind === "adversarial" && a.checkId === claimId)
    .at(-1);
  return latest && latest.fingerprint === fingerprint ? latest : null;
}

async function requestRefute(
  kernel: Kernel,
  changeset: Changeset,
  input: RequestReviewInput,
): Promise<RefutePacket> {
  const fingerprint = fingerprintProject(kernel);
  const reused: ReusedVerdict[] = [];
  const owed: VerificationClaim[] = [];
  for (const claim of refuteTargets(changeset, input.claimIds)) {
    const cached = input.force
      ? null
      : freshVerdict(changeset, claim.id, fingerprint);
    if (!cached) {
      owed.push(claim);
      continue;
    }
    reused.push({
      claimId: claim.id,
      claimText: claim.text,
      refuted: cached.status === "failed",
      summary: `Reused fresh verdict: ${cached.summary}`,
    });
  }

  const scopes = owed.length > 0
    ? await changedScopesOf(kernel, changeset.id)
    : [];
  const contexts: Record<string, string> = {};
  const contextIds = new Map<string, string>();
  const claims = owed.map((claim) => {
    const code = buildClaimContext(kernel, changeset, claim.id, scopes);
    let contextId = contextIds.get(code);
    if (!contextId) {
      contextId = `ctx${contextIds.size + 1}`;
      contextIds.set(code, contextId);
      contexts[contextId] = code;
    }
    return {
      id: claim.id,
      text: claim.text,
      priority: claim.priority,
      contextId,
    };
  });

  const issued = issue(kernel, {
    kind: "refute",
    changesetId: changeset.id,
    claims: claims.map((c) => ({ id: c.id, text: c.text })),
  });
  return {
    kind: "refute",
    packetId: issued.id,
    changesetId: changeset.id,
    instructions: REFUTE_INSTRUCTIONS,
    response: REFUTE_RESPONSE,
    claims,
    contexts,
    reused,
  };
}

async function requestCriteria(
  kernel: Kernel,
  changeset: Changeset,
): Promise<CriteriaPacket> {
  const scopes = await changedScopesOf(kernel, changeset.id);
  const request = await resolveChangesetRequest(kernel, changeset);
  const issued = issue(kernel, {
    kind: "criteria",
    changesetId: changeset.id,
    requestFromUser: request.fromUser,
  });
  return {
    kind: "criteria",
    packetId: issued.id,
    changesetId: changeset.id,
    instructions: CRITERIA_INSTRUCTIONS,
    response: CRITERIA_RESPONSE,
    request: request.text,
    requestFromUser: request.fromUser,
    // The same changed-scope code a refute review falls back to, so a client
    // running both can share a cached prefix.
    context: buildChangedScopeContext(kernel, scopes),
  };
}

function requestAudit(
  kernel: Kernel,
  input: RequestReviewInput,
  deps: ReviewDeps,
): Result<AuditPacket> {
  const category = input.category ?? "";
  const config = deps.auditConfig(category);
  if (!config) {
    return {
      ok: false,
      error: {
        code: "INVALID_CATEGORY",
        message: `Unknown audit category "${category}". Valid: ${
          deps.auditCategories().join(", ")
        }`,
      },
    };
  }
  const issued = issue(kernel, { kind: "audit", category });
  const code = buildCodeContext(kernel);
  return {
    ok: true,
    data: {
      kind: "audit",
      packetId: issued.id,
      category,
      instructions: `${config.systemPrompt}\n\n${FRESH_CONTEXT}`,
      response: AUDIT_RESPONSE,
      context: code.trim()
        ? code
        : "The application has no code yet. Report no issues.",
    },
  };
}

function requestImports(kernel: Kernel): Result<ImportsPacket> {
  const pending = kernel.codebaseClassification;
  if (!pending || pending.graph !== kernel.codebaseGraph) {
    return fail(
      "NO_INDEX_TO_CLASSIFY",
      "No codebase index is waiting for classification.",
      'Run index_codebase with classification "assist" first.',
    );
  }
  const issued = issue(kernel, { kind: "imports", graph: pending.graph });
  return {
    ok: true,
    data: {
      kind: "imports",
      packetId: issued.id,
      instructions: IMPORTS_INSTRUCTIONS,
      response: IMPORTS_RESPONSE,
      request: pending.request,
    },
  };
}

// The user's own words for what they asked for: the one input to the criteria
// reviewer the implementing agent didn't write. The last user chat message
// before the plan; without one, the changeset's title and description, labelled
// as such, because a review of a restatement is weaker than a review of the
// request.
async function resolveChangesetRequest(
  kernel: Kernel,
  changeset: Changeset,
): Promise<{ text: string; fromUser: boolean }> {
  const fallback = {
    text: [changeset.title, changeset.description].filter(Boolean).join("\n\n"),
    fromUser: false,
  };
  const sessionId = changeset.sessionId;
  if (!sessionId) return fallback;
  const planAnchor = changeset.planMessageIds.length > 0
    ? Math.min(...changeset.planMessageIds)
    : Number.POSITIVE_INFINITY;
  try {
    const messages = await kernel.sessions.getMessages(sessionId);
    for (let i = messages.length - 1; i >= 0; i--) {
      const message = messages[i]!;
      if (message.role !== "user" || message.kind !== "chat") continue;
      if (message.id >= planAnchor) continue;
      const text = message.content.trim();
      if (text) return { text, fromUser: true };
    }
  } catch (err) {
    kernel.log.log(
      "debug",
      "system",
      `Could not resolve the request text for changeset "${changeset.id}": ${
        errorMessage(err)
      }`,
    );
  }
  return fallback;
}

// --- submit_review -----------------------------------------------------------

export interface ReviewAttestation {
  kind: AttestationKind;
  status: VerificationStatus;
  fingerprint: string;
  scope: string;
  summary: string;
  checkId?: string;
  producer: "client";
  reviewer?: string;
}

export type MintReviewAttestation = (
  attestation: ReviewAttestation,
  changesetId?: string,
) => Promise<string | null>;

export interface SubmitReviewInput {
  packetId: string;
  verdict: unknown;
  reviewer?: string;
}

export interface SubmitReviewResult {
  data: Record<string, unknown>;
  // The changeset the review recorded onto, for the changeset event.
  changesetId?: string;
}

export async function submitReview(
  kernel: Kernel,
  input: SubmitReviewInput,
  mint: MintReviewAttestation,
): Promise<Result<SubmitReviewResult>> {
  const packet = issuedPackets(kernel).get(input.packetId);
  if (!packet) {
    return fail(
      "REVIEW_PACKET_NOT_FOUND",
      `No review packet "${input.packetId}". Packets live until the server restarts.`,
      "Call request_review for a new packet.",
    );
  }
  if (packet.used) {
    return fail(
      "REVIEW_PACKET_USED",
      `Review packet "${input.packetId}" was already submitted.`,
      "Call request_review for a new packet.",
    );
  }
  if (isStale(kernel, packet)) {
    return fail(
      "STALE_REVIEW",
      "The code changed after this review packet was issued, so the verdict is about code that no longer exists.",
      "Call request_review again and review the current code.",
    );
  }
  const reviewer = input.reviewer?.trim() || undefined;
  const result = packet.kind === "refute"
    ? await submitRefute(packet, input.verdict, reviewer, mint)
    : packet.kind === "criteria"
    ? await submitCriteria(kernel, packet, input.verdict, reviewer, mint)
    : packet.kind === "audit"
    ? await submitAudit(kernel, packet, input.verdict, reviewer, mint)
    : submitImports(kernel, packet, input.verdict, reviewer);
  // A rejected verdict leaves the packet open, so the client can fix its
  // answer and send it again.
  if (result.ok) packet.used = true;
  return result;
}

function isStale(kernel: Kernel, packet: IssuedPacket): boolean {
  return packet.kind === "imports"
    ? kernel.codebaseGraph !== packet.graph
    : fingerprintProject(kernel) !== packet.fingerprint;
}

function fail(
  code: string,
  message: string,
  suggestion?: string,
): {
  ok: false;
  error: { code: string; message: string; suggestion?: string };
} {
  return {
    ok: false,
    error: { code, message, ...(suggestion ? { suggestion } : {}) },
  };
}

function invalidVerdict(message: string, response: string) {
  return fail("INVALID_VERDICT", message, `Send ${response}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

// --- refute ------------------------------------------------------------------

const CONFIDENCES = new Set<string>(["high", "medium", "low"]);

// Garbage fails shut: a verdict the server can't read records nothing, rather
// than reading as "survived".
export function parseRefuteVerdict(
  verdict: unknown,
  claimIds: readonly string[],
): Result<RefuteAttempt[]> {
  const raw = isRecord(verdict) ? verdict.results : undefined;
  if (!Array.isArray(raw)) {
    return invalidVerdict("verdict.results must be an array.", REFUTE_RESPONSE);
  }
  const known = new Set(claimIds);
  const attempts: RefuteAttempt[] = [];
  for (const [index, item] of raw.entries()) {
    if (
      !isRecord(item) || typeof item.claimId !== "string" ||
      typeof item.refuted !== "boolean" ||
      typeof item.confidence !== "string" ||
      !CONFIDENCES.has(item.confidence)
    ) {
      return invalidVerdict(
        `verdict.results[${index}] needs claimId, refuted (boolean) and confidence ("high", "medium" or "low").`,
        REFUTE_RESPONSE,
      );
    }
    if (!known.has(item.claimId)) {
      return invalidVerdict(
        `verdict.results[${index}].claimId "${item.claimId}" isn't in this packet. It covers: ${
          claimIds.join(", ") || "nothing"
        }.`,
        REFUTE_RESPONSE,
      );
    }
    const counterexample = optionalText(item.counterexample);
    const reasoning = optionalText(item.reasoning);
    attempts.push({
      claimId: item.claimId,
      refuted: item.refuted,
      confidence: item.confidence as Confidence,
      ...(counterexample ? { counterexample } : {}),
      ...(reasoning ? { reasoning } : {}),
    });
  }
  const answered = new Set(attempts.map((a) => a.claimId));
  const missing = claimIds.filter((id) => !answered.has(id));
  if (missing.length > 0) {
    return invalidVerdict(
      `No result for ${
        missing.join(", ")
      }. Every claim in the packet needs one.`,
      REFUTE_RESPONSE,
    );
  }
  return { ok: true, data: attempts };
}

// The attempt that refutes a claim: confident AND concrete. One valid
// counterexample disproves; a vague or unsure one doesn't.
export function refutingAttempt<
  T extends { refuted: boolean; confidence: string; counterexample?: string },
>(attempts: readonly T[]): T | undefined {
  return attempts.find((a) =>
    a.refuted && a.confidence === "high" && !!a.counterexample?.trim()
  );
}

async function submitRefute(
  packet: IssuedPacket,
  verdict: unknown,
  reviewer: string | undefined,
  mint: MintReviewAttestation,
): Promise<Result<SubmitReviewResult>> {
  const claims = packet.claims ?? [];
  const parsed = parseRefuteVerdict(verdict, claims.map((c) => c.id));
  if (!parsed.ok) return parsed;
  const results: Array<Record<string, unknown>> = [];
  for (const { id: claimId, text: claimText } of claims) {
    const attempts = parsed.data.filter((a) => a.claimId === claimId);
    const refuting = refutingAttempt(attempts);
    const summary = refuting
      ? `Refuted: ${refuting.counterexample}`
      : `Survived ${attempts.length} refutation attempt(s).`;
    const attestationId = await mint({
      kind: "adversarial",
      status: refuting ? "failed" : "passed",
      fingerprint: packet.fingerprint,
      scope: PROJECT_SCOPE,
      checkId: claimId,
      summary,
      producer: "client",
      ...(reviewer ? { reviewer } : {}),
    }, packet.changesetId);
    results.push({
      claimId,
      claimText,
      refuted: !!refuting,
      ...(refuting ? { counterexample: refuting.counterexample } : {}),
      ...(attestationId ? { attestationId } : {}),
      summary,
    });
  }
  const refuted = results.filter((r) => r.refuted).length;
  return {
    ok: true,
    data: {
      data: {
        changesetId: packet.changesetId,
        summary: `${results.length} claim(s) reviewed, ${refuted} refuted.`,
        results,
      },
      ...(packet.changesetId ? { changesetId: packet.changesetId } : {}),
    },
  };
}

// --- criteria ----------------------------------------------------------------

const PRIORITIES = new Set<string>(["must", "should", "nice"]);

function clamp(text: string): string {
  return text.length <= INDEPENDENT_CRITERION_MAX_CHARS
    ? text
    : `${text.slice(0, INDEPENDENT_CRITERION_MAX_CHARS)}…`;
}

// Garbage fails shut here too, and that matters more than for refutation: an
// empty list is a real verdict ("nothing missing") that clears findings, so a
// broken answer must never read as one.
export function parseCriteriaVerdict(
  verdict: unknown,
): Result<ProposedCriterion[]> {
  const raw = isRecord(verdict) ? verdict.criteria : undefined;
  if (!Array.isArray(raw)) {
    return invalidVerdict(
      "verdict.criteria must be an array.",
      CRITERIA_RESPONSE,
    );
  }
  const proposals: ProposedCriterion[] = [];
  for (const [index, item] of raw.entries()) {
    const text = isRecord(item) ? optionalText(item.text) : undefined;
    if (!isRecord(item) || !text) {
      return invalidVerdict(
        `verdict.criteria[${index}] needs a non-empty text.`,
        CRITERIA_RESPONSE,
      );
    }
    if (proposals.length >= INDEPENDENT_CRITERIA_MAX) break;
    // An unknown priority reads as `should`. Reading it as `must` would let a
    // malformed answer manufacture blocking findings.
    const priority = typeof item.priority === "string" &&
        PRIORITIES.has(item.priority)
      ? item.priority as VerificationClaimPriority
      : "should";
    proposals.push({
      id: createTimestampedId("icr"),
      text: clamp(text),
      priority,
      rationale: clamp(optionalText(item.rationale) ?? ""),
    });
  }
  return { ok: true, data: proposals };
}

// --- coverage: plain code, not a second model call ---------------------------

// deno-fmt-ignore
const STOP_WORDS = new Set([
  "the", "a", "an", "and", "or", "of", "to", "in", "is", "are", "be", "that",
  "this", "it", "its", "for", "on", "with", "as", "at", "by", "from", "not",
  "no", "must", "should", "will", "can", "when", "then", "if", "user", "users",
  "does", "do", "any", "all", "each", "has", "have", "was", "were", "so",
]);

// Content words, lowercased and de-duplicated. Crude on purpose: this decides
// whether to show a proposal to a human, not whether to block.
function contentTokens(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((word) => word.length > 2 && !STOP_WORDS.has(word)),
  );
}

// Overlap normalised by the smaller set, so a terse criterion can cover a wordy
// proposal.
function overlapRatio(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const token of a) if (b.has(token)) shared++;
  return shared / Math.min(a.size, b.size);
}

// At or above this, a proposal counts as covered by an acceptance criterion.
// Low-ish on purpose: over-reporting is the safer error, and the finding is
// advisory.
export const CRITERION_COVERAGE_THRESHOLD = 0.6;

// Tags each proposal with the acceptance criterion that already covers it. The
// reviewer never sees the agent's claims, so that this comparison happens here,
// where it can be read, and not inside a prompt.
export function markCoverage(
  proposals: readonly ProposedCriterion[],
  acceptanceCriteria: readonly VerificationClaim[],
): ProposedCriterion[] {
  const claims = acceptanceCriteria.map((claim) => ({
    id: claim.id,
    tokens: contentTokens(claim.text),
  }));
  return proposals.map((proposal) => {
    const tokens = contentTokens(proposal.text);
    let best: { id: string; ratio: number } | null = null;
    for (const claim of claims) {
      const ratio = overlapRatio(tokens, claim.tokens);
      if (!best || ratio > best.ratio) best = { id: claim.id, ratio };
    }
    return best && best.ratio >= CRITERION_COVERAGE_THRESHOLD
      ? { ...proposal, coveredBy: best.id }
      : proposal;
  });
}

async function submitCriteria(
  kernel: Kernel,
  packet: IssuedPacket,
  verdict: unknown,
  reviewer: string | undefined,
  mint: MintReviewAttestation,
): Promise<Result<SubmitReviewResult>> {
  const parsed = parseCriteriaVerdict(verdict);
  if (!parsed.ok) return parsed;
  const changesetId = packet.changesetId!;
  const changeset = await kernel.changesets.get(changesetId);
  if (!changeset) {
    return fail(
      "CHANGESET_NOT_FOUND",
      `Changeset "${changesetId}" not found.`,
    );
  }
  const proposals = markCoverage(
    parsed.data,
    changeset.plan.acceptanceCriteria ?? [],
  );
  const uncovered = proposals.filter((p) => !p.coveredBy);
  await kernel.changesets.recordIndependentCriteria(changesetId, proposals);
  const found = uncovered.length === 0
    ? `Independent review proposed ${proposals.length} criterion/criteria; the plan covers all of them.`
    : `Independent review proposed ${proposals.length} criterion/criteria; ${uncovered.length} not covered by the plan.`;
  const summary = packet.requestFromUser
    ? found
    : `${found} (Reviewed against the changeset summary; the original request text was unavailable.)`;
  const attestationId = await mint({
    kind: "criteria",
    // Never "failed": an uncovered proposal is a gap for a human to judge, not
    // a verdict that the work is wrong.
    status: uncovered.length === 0 ? "passed" : "partial",
    fingerprint: packet.fingerprint,
    scope: PROJECT_SCOPE,
    summary,
    producer: "client",
    ...(reviewer ? { reviewer } : {}),
  }, changesetId);
  return {
    ok: true,
    data: {
      data: {
        changesetId,
        summary,
        proposals,
        uncovered: uncovered.map((p) => p.id),
        ...(attestationId ? { attestationId } : {}),
      },
      changesetId,
    },
  };
}

// --- audit -------------------------------------------------------------------

const SEVERITIES = new Set<string>([
  "critical",
  "high",
  "medium",
  "low",
  "info",
]);

export function parseAuditVerdict(verdict: unknown): Result<AuditIssue[]> {
  const raw = isRecord(verdict) ? verdict.issues : undefined;
  if (!Array.isArray(raw)) {
    return invalidVerdict("verdict.issues must be an array.", AUDIT_RESPONSE);
  }
  const issues: AuditIssue[] = [];
  for (const [index, item] of raw.entries()) {
    const message = isRecord(item) ? optionalText(item.message) : undefined;
    if (!isRecord(item) || !message) {
      return invalidVerdict(
        `verdict.issues[${index}] needs a non-empty message.`,
        AUDIT_RESPONSE,
      );
    }
    const entity = optionalText(item.entity);
    const suggestion = optionalText(item.suggestion);
    issues.push({
      severity: typeof item.severity === "string" &&
          SEVERITIES.has(item.severity)
        ? item.severity as AuditSeverity
        : "medium",
      rule: optionalText(item.rule) ?? "unknown",
      message,
      ...(entity ? { entity } : {}),
      ...(typeof item.line === "number" ? { line: item.line } : {}),
      ...(suggestion ? { suggestion } : {}),
    });
  }
  return { ok: true, data: issues };
}

async function submitAudit(
  kernel: Kernel,
  packet: IssuedPacket,
  verdict: unknown,
  reviewer: string | undefined,
  mint: MintReviewAttestation,
): Promise<Result<SubmitReviewResult>> {
  const parsed = parseAuditVerdict(verdict);
  if (!parsed.ok) return parsed;
  const issues = parsed.data;
  const category = packet.category!;
  const result: AuditResult = {
    id: crypto.randomUUID(),
    category,
    status: "complete",
    startedAt: packet.issuedAt,
    completedAt: new Date().toISOString(),
    issues,
    summary: issues.length === 0
      ? "No issues found"
      : formatAuditSummary(issues),
    score: computeAuditScore(issues),
    metadata: {
      producer: "client",
      ...(reviewer ? { reviewer } : {}),
    },
  };
  await kernel.audits.clearCategory(category);
  await kernel.audits.store(result);
  const attestationId = await mint({
    kind: "audit",
    status: issues.length === 0 ? "passed" : "partial",
    fingerprint: packet.fingerprint,
    scope: PROJECT_SCOPE,
    summary: `${category}: ${result.summary}`,
    producer: "client",
    ...(reviewer ? { reviewer } : {}),
  });
  return {
    ok: true,
    data: {
      data: { ...result, ...(attestationId ? { attestationId } : {}) },
    },
  };
}

// --- imports -------------------------------------------------------------------

// Merges the classification into the indexed graph. No attestation: it describes
// the project, it doesn't verify a change.
function submitImports(
  kernel: Kernel,
  packet: IssuedPacket,
  verdict: unknown,
  reviewer: string | undefined,
): Result<SubmitReviewResult> {
  const parsed = parseImportClassification(verdict);
  if (!parsed.ok) return invalidVerdict(parsed.reason, IMPORTS_RESPONSE);
  const graph = packet.graph!;
  const classification = parsed.data;
  kernel.codebaseGraph = mergeCodebaseContributions(graph, [
    importClassifierResultToSemanticContribution(
      {
        status: "completed",
        ...(reviewer ? { model: reviewer } : {}),
        ...classification,
      },
      { existingEntityIds: codebaseGraphEntityIds(graph) },
    ),
  ]);
  kernel.codebaseClassification = null;
  return {
    ok: true,
    data: {
      data: {
        classification: {
          status: "completed",
          ...(reviewer ? { model: reviewer } : {}),
        },
        facts: classification.facts.length,
        mappings: classification.mappings.length,
        diagnostics: classification.diagnostics.length,
        candidateEntities: classification.candidateEntities.length,
      },
    },
  };
}
