// Reviews on the client side of request_review and submit_review.
//
// With a reviewer in the brain, the loop offers its model refute_claims and
// run_audit (CLIENT_REVIEW_TOOLS) and runs each as a packet round trip: ask
// the server what to review, review it on the brain's model, submit the
// verdict. Before the model's complete_changeset goes out, it also runs the
// reviews the gate used to run itself, so a changeset whose must claim is
// refuted still can't land.
import type { ChangeContext } from "../core/changelog.ts";
import type { Reviewer, ReviewRunContext } from "../core/chat-intelligence.ts";
import type { ReviewPacket } from "../core/reviews.ts";
import type { Changeset } from "../core/types.ts";
import type { ToolResult } from "../core/tools/dispatch.ts";
import { getKernelSettings } from "../core/config.ts";
import type { ChangesetClient, ToolTransport } from "./chat-backend.ts";

export const CLIENT_REVIEW_TOOL_NAMES: ReadonlySet<string> = new Set([
  "refute_claims",
  "run_audit",
]);

// The packet pair stays out of the model's tools when the loop runs reviews
// itself.
export const REVIEW_PACKET_TOOL_NAMES: ReadonlySet<string> = new Set([
  "request_review",
  "submit_review",
]);

export interface ReviewRun {
  tools: ToolTransport;
  changesets: Pick<ChangesetClient, "get" | "getActive">;
  reviewer: Reviewer;
  context: ChangeContext;
  recordUsage?: ReviewRunContext["recordUsage"];
  // Where a gate review that throws is reported. It never stops the call.
  warn?: (message: string) => void;
}

// A client review tool call, as the model made it, into a request_review call
// and the reviewer's options.
function reviewRequest(
  name: string,
  input: Record<string, unknown>,
): { request: Record<string, unknown>; attempts?: number } {
  if (name === "run_audit") {
    return { request: { kind: "audit", category: input.category } };
  }
  return {
    request: {
      kind: "refute",
      ...(input.changeset_id !== undefined
        ? { changeset_id: input.changeset_id }
        : {}),
      ...(input.claim_ids !== undefined ? { claim_ids: input.claim_ids } : {}),
      ...(input.force !== undefined ? { force: input.force } : {}),
    },
    ...(typeof input.attempts === "number" ? { attempts: input.attempts } : {}),
  };
}

// A refute packet with nothing owed answers without a model.
function nothingOwed(packet: ReviewPacket): ToolResult | null {
  if (packet.kind !== "refute" || packet.claims.length > 0) return null;
  return {
    ok: true,
    data: {
      changesetId: packet.changesetId,
      summary: packet.reused.length > 0
        ? `${packet.reused.length} claim(s) already have a fresh verdict.`
        : "No 'must' acceptance criteria to refute.",
      results: packet.reused.map((r) => ({ ...r, skipped: true })),
    },
  };
}

// Reused verdicts go back to the model beside the new ones, as refute_claims
// always returned them.
function withReused(packet: ReviewPacket, submitted: ToolResult): ToolResult {
  if (packet.kind !== "refute" || packet.reused.length === 0) return submitted;
  const data = submitted.data as { results?: unknown[] } | undefined;
  return {
    ...submitted,
    data: {
      ...data,
      results: [
        ...packet.reused.map((r) => ({ ...r, skipped: true })),
        ...(data?.results ?? []),
      ],
    },
  };
}

export async function runReview(
  run: ReviewRun,
  request: Record<string, unknown>,
  attempts?: number,
): Promise<ToolResult> {
  const requested = await run.tools.callTool(
    "request_review",
    request,
    run.context,
  );
  if (!requested.ok) return requested;
  const packet = requested.data as ReviewPacket;
  const empty = nothingOwed(packet);
  if (empty) return empty;

  const outcome = await run.reviewer.review(packet, {
    sessionId: run.context.sessionId ?? null,
    changesetId: "changesetId" in packet
      ? packet.changesetId
      : run.context.changesetId ?? null,
    ...(attempts !== undefined ? { attempts } : {}),
    ...(run.recordUsage ? { recordUsage: run.recordUsage } : {}),
  });
  if (outcome.status === "unavailable") {
    return {
      ok: false,
      error: {
        code: outcome.code,
        message: outcome.message,
        ...(outcome.suggestion ? { suggestion: outcome.suggestion } : {}),
      },
    };
  }
  if (outcome.status === "failed") {
    return {
      ok: false,
      error: { code: "REVIEW_FAILED", message: outcome.message },
    };
  }
  const submitted = await run.tools.callTool("submit_review", {
    packet_id: packet.packetId,
    verdict: outcome.verdict,
    reviewer: outcome.reviewer,
  }, run.context);
  return submitted.ok ? withReused(packet, submitted) : submitted;
}

// refute_claims or run_audit, run on the brain's reviewer.
export function runClientReviewTool(
  run: ReviewRun,
  name: string,
  input: Record<string, unknown>,
): Promise<ToolResult> {
  const { request, attempts } = reviewRequest(name, input);
  return runReview(run, request, attempts);
}

// The reviews complete_changeset's gate used to run itself: refutation of the
// must claims, then the independent criteria review, each behind its setting.
// Best effort, as they were: a review that can't run leaves its readiness
// finding in place rather than stopping the completion call. The light lane
// skips both; its one criterion is the kernel's, not the agent's.
export async function runOwedGateReviews(
  run: ReviewRun,
  changeset: Changeset,
): Promise<void> {
  if (changeset.plan.changeClass?.effective === "light") return;
  const settings = getKernelSettings();
  const hasMust = (changeset.plan.acceptanceCriteria ?? []).some((c) =>
    c.priority === "must"
  );
  if (settings.autoRefuteAtGate && hasMust) {
    await runReview(run, { kind: "refute", changeset_id: changeset.id });
  }
  if (settings.independentCriteriaAtGate) {
    await runReview(run, { kind: "criteria", changeset_id: changeset.id });
  }
}

// One tool call from the model, with the loop's reviews in front of it:
// refute_claims and run_audit run here, and complete_changeset first gets the
// reviews its gate reads. Everything else goes straight to the server.
export async function callWithReviews(
  run: ReviewRun,
  name: string,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  if (CLIENT_REVIEW_TOOL_NAMES.has(name)) {
    return await runClientReviewTool(run, name, args);
  }
  if (name === "complete_changeset") await gateReviews(run, args.changeset_id);
  const result = await run.tools.callTool(name, args, run.context);
  return name === "index_codebase" ? await classified(run, result) : result;
}

// index_codebase in "assist" mode leaves the classification owed. Run it, and
// hand the model the outcome in place of the owed status, as when the server
// classified.
async function classified(
  run: ReviewRun,
  indexed: ToolResult,
): Promise<ToolResult> {
  const data = indexed.data as
    | { classification?: { status?: string } }
    | undefined;
  if (!indexed.ok || data?.classification?.status !== "review_owed") {
    return indexed;
  }
  const reviewed = await runReview(run, { kind: "imports" });
  const classification = reviewed.ok
    ? (reviewed.data as { classification: unknown }).classification
    : {
      status: reviewed.error?.code === "MODEL_UNCONFIGURED"
        ? "skipped_unconfigured"
        : "failed",
      reason: reviewed.error?.message ?? "Classification failed.",
    };
  return { ...indexed, data: { ...data, classification } };
}

async function gateReviews(run: ReviewRun, changesetId: unknown) {
  try {
    const changeset = typeof changesetId === "string"
      ? await run.changesets.get(changesetId)
      : await run.changesets.getActive(run.context.sessionId);
    if (changeset?.status === "in_progress") {
      await runOwedGateReviews(run, changeset);
    }
  } catch (err) {
    run.warn?.(
      `Gate reviews failed before complete_changeset: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}
