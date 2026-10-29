// @layer agent-loop — the chat's product telemetry: what a turn cost and how it
// ended, bucketed so no prompt, token count or price leaves the machine exact.
// The agent process owns it because it runs the turns.
import type { ChatEvent } from "../core/chat-contract.ts";
import type { TelemetryManager } from "../core/telemetry.ts";
import { contextOccupancyTokens } from "../core/usage.ts";

export interface ChatTelemetry {
  messageSent(props: {
    hasAttachments: boolean;
    activeChangeset: boolean;
    rerun: boolean;
  }): void;
  // Every event of a turn, in order; it picks out the ones it counts.
  turnEvent(event: ChatEvent): void;
  turnFailed(kind: "send_message_error" | "send_message_exception"): void;
}

export function bucketTokens(value: number): string {
  if (value <= 0) return "0";
  if (value <= 1_000) return "1-1k";
  if (value <= 5_000) return "1k-5k";
  if (value <= 20_000) return "5k-20k";
  if (value <= 100_000) return "20k-100k";
  return "100k+";
}

export function bucketCost(value: number): string {
  if (value <= 0) return "0";
  if (value <= 0.01) return "0-0.01";
  if (value <= 0.10) return "0.01-0.10";
  if (value <= 1) return "0.10-1";
  if (value <= 10) return "1-10";
  return "10+";
}

export function modelFamily(model: string): string {
  if (model.includes("opus")) return "claude-opus";
  if (model.includes("sonnet")) return "claude-sonnet";
  if (model.includes("haiku")) return "claude-haiku";
  return "other";
}

// The chat's events over a TelemetryManager. Whether a turn made a changeset
// spans its events, so the flag resets on each message.
export function managedChatTelemetry(
  telemetry: TelemetryManager,
  onSyncError: (message: string) => void,
): ChatTelemetry {
  let turnHadChangeset = false;
  const track = (name: string, props: Record<string, unknown>) => {
    telemetry.track(name, props);
    telemetry.syncIfAllowed()?.catch((err) =>
      onSyncError(err instanceof Error ? err.message : String(err))
    );
  };
  return {
    messageSent(props) {
      turnHadChangeset = false;
      track("chat_message_sent", {
        message_has_attachments: props.hasAttachments,
        active_project: true,
        active_changeset: props.activeChangeset,
        rerun: props.rerun,
      });
    },
    turnEvent(event) {
      if (event.type === "turn_usage" && event.usage) {
        track("agent_turn_completed", {
          duration_ms: event.usage.durationMs,
          tool_calls_count: event.usage.toolCallsCount,
          input_tokens_bucket: bucketTokens(
            contextOccupancyTokens(event.usage),
          ),
          output_tokens_bucket: bucketTokens(event.usage.outputTokens),
          estimated_cost_usd_bucket: bucketCost(event.usage.costUsd),
          model_family: modelFamily(event.usage.model),
          completed_with_changeset: turnHadChangeset,
        });
      } else if (event.type === "error" && event.text) {
        track("agent_turn_failed", {
          failure_kind: "stream_error",
          model_family: "unknown",
        });
      } else if (event.type === "changeset_created" && event.changeset) {
        turnHadChangeset = true;
        const changeset = event.changeset as {
          changes?: unknown[];
          plan?: unknown;
        };
        track("changeset_created", {
          changeset_kind: changeset.plan ? "plan" : "direct",
          change_count: Array.isArray(changeset.changes)
            ? changeset.changes.length
            : 0,
        });
      }
    },
    turnFailed(kind) {
      track("agent_turn_failed", {
        failure_kind: kind,
        model_family: "unknown",
      });
    },
  };
}
