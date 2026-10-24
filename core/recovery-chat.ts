import type { ChatEventHandler } from "./chat-contract.ts";
import { getAgentModel } from "./config.ts";
import type {
  ModelProvider,
  NeutralMessage,
  NeutralTool,
  NeutralToolResultBlock,
  ProviderStopReason,
} from "./model-provider.ts";
import {
  diagnoseRecoveryProject,
  type RecoveryDiagnostics,
  recoveryInitialMessage,
} from "./recovery-diagnostics.ts";
import { errorMessage } from "./util.ts";

export interface RecoveryChatRequest {
  projectPath: string;
  text: string;
  failedOpenError?: string;
}

export interface RecoveryChatRuntime {
  sendMessage(
    request: RecoveryChatRequest,
    onEvent?: ChatEventHandler,
  ): Promise<string>;
  abort(): void;
}

const RECOVERY_TOOLS: NeutralTool[] = [
  {
    name: "inspect_project_manifest",
    description:
      "Read the project manifest status for a project that failed to open. Read-only.",
    inputSchema: {
      type: "object",
      required: ["projectPath"],
      properties: { projectPath: { type: "string" } },
    },
  },
  {
    name: "list_recovery_backups",
    description:
      "List local database backups and branch snapshot counts for recovery. Read-only.",
    inputSchema: {
      type: "object",
      required: ["projectPath"],
      properties: { projectPath: { type: "string" } },
    },
  },
  {
    name: "inspect_recovery_state",
    description:
      "Inspect .opentide state/history and schema metadata enough to explain what survives reset. Read-only.",
    inputSchema: {
      type: "object",
      required: ["projectPath"],
      properties: { projectPath: { type: "string" } },
    },
  },
  {
    name: "summarize_db_symptoms",
    description:
      "Summarize failed-open database symptoms and filesystem markers without attempting repair. Read-only.",
    inputSchema: {
      type: "object",
      required: ["projectPath"],
      properties: {
        projectPath: { type: "string" },
        failedOpenError: { type: "string" },
      },
    },
  },
];

function stringArg(input: unknown, name: string): string | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return undefined;
  }
  const value = (input as Record<string, unknown>)[name];
  return typeof value === "string" ? value : undefined;
}

function textMessage(text: string): NeutralMessage {
  return { role: "user", content: [{ type: "text", text }] };
}

function recoverySystemPrompt(diagnostics: RecoveryDiagnostics): string {
  return `You are Tide's bounded database recovery console.

You are not the normal project agent. No Kernel is loaded. You may not plan app changes, write files, repair databases, reset databases, restore backups, run commands, or imply that you performed a mutation.

You may answer questions about the failed project open using the diagnostics below and the read-only tools provided. Recommend only these explicit UI actions when appropriate: Attempt Repair, Restore Selected Backup, Reset Empty, Cancel. Destructive or mutating actions require the user to press a separate button.

Keep answers concise and practical. Explain data-at-risk clearly: project definition and .opentide state/history may survive an empty reset when present, while local rows under data/ may be lost unless a backup restores them.

Initial deterministic diagnosis:
${recoveryInitialMessage(diagnostics)}`;
}

async function dispatchRecoveryTool(
  name: string,
  input: unknown,
  fallbackProjectPath: string,
  fallbackFailedOpenError?: string,
): Promise<unknown> {
  const projectPath = stringArg(input, "projectPath") ?? fallbackProjectPath;
  const failedOpenError = stringArg(input, "failedOpenError") ??
    fallbackFailedOpenError;
  const diagnostics = await diagnoseRecoveryProject(
    projectPath,
    failedOpenError,
  );
  if (name === "inspect_project_manifest") {
    return { projectPath, manifest: diagnostics.manifest };
  }
  if (name === "list_recovery_backups") {
    return {
      projectPath,
      backups: diagnostics.backups,
      branchSnapshotCount: diagnostics.branchSnapshotCount,
    };
  }
  if (name === "inspect_recovery_state") {
    return {
      projectPath,
      state: diagnostics.state,
      history: diagnostics.history,
      schemaFileCount: diagnostics.schemaFileCount,
      schemaMigrationFileCount: diagnostics.schemaMigrationFileCount,
    };
  }
  if (name === "summarize_db_symptoms") {
    return {
      projectPath,
      failedOpenError: diagnostics.failedOpenError ?? null,
      data: diagnostics.data,
      likelyDataRisk: diagnostics.backups.length > 0
        ? "Local rows can likely be restored from a selected backup."
        : "Local rows in data/ may be lost if repair fails and the database is reset empty.",
    };
  }
  return { ok: false, error: `Unknown recovery tool: ${name}` };
}

export function recoveryToolNames(): string[] {
  return RECOVERY_TOOLS.map((tool) => tool.name);
}

export function createRecoveryChatRuntime(
  provider: ModelProvider,
): RecoveryChatRuntime {
  let abortController: AbortController | null = null;
  return {
    abort(): void {
      abortController?.abort();
    },

    async sendMessage(
      request: RecoveryChatRequest,
      onEvent?: ChatEventHandler,
    ): Promise<string> {
      const diagnostics = await diagnoseRecoveryProject(
        request.projectPath,
        request.failedOpenError,
      );
      const model = getAgentModel();
      const messages: NeutralMessage[] = [textMessage(request.text)];
      let fullText = "";
      abortController = new AbortController();
      try {
        for (let i = 0; i < 4; i++) {
          const toolUses: Array<{ id: string; name: string; input: unknown }> =
            [];
          let providerStop: ProviderStopReason | null = null;
          let thinkingBuffer = "";
          for await (
            const event of provider.streamTurn({
              model,
              system: recoverySystemPrompt(diagnostics),
              messages,
              tools: RECOVERY_TOOLS,
            }, abortController.signal)
          ) {
            if (abortController.signal.aborted) break;
            if (event.type === "text_delta") {
              fullText += event.text;
              onEvent?.({ type: "text_delta", text: event.text });
            } else if (event.type === "thinking_start") {
              thinkingBuffer = "";
              onEvent?.({ type: "thinking_start" });
            } else if (event.type === "thinking_delta") {
              thinkingBuffer += event.text;
            } else if (event.type === "thinking_end") {
              onEvent?.(
                thinkingBuffer
                  ? { type: "thinking_end", text: thinkingBuffer }
                  : { type: "thinking_end" },
              );
              thinkingBuffer = "";
            } else if (event.type === "tool_use_start") {
              const id = event.toolCallId ?? `recovery_tool_${toolUses.length}`;
              toolUses.push({
                id,
                name: event.toolName,
                input: event.toolInput,
              });
              onEvent?.({
                type: "tool_use_start",
                toolName: event.toolName,
                toolInput: event.toolInput,
              });
            } else if (event.type === "model_request_usage") {
              onEvent?.({ type: "model_request_usage", usage: event.usage });
            } else if (event.type === "turn_usage") {
              onEvent?.({ type: "turn_usage", usage: event.usage });
            } else if (event.type === "error") {
              const text = event.error.message;
              onEvent?.({ type: "error", text });
              return fullText;
            } else if (event.type === "message_complete") {
              providerStop = event.stopReason;
            }
          }
          if (abortController.signal.aborted) break;
          if (providerStop === "requires_action" && toolUses.length > 0) {
            messages.push({
              role: "assistant",
              content: toolUses.map((tool) => ({
                type: "tool_use",
                id: tool.id,
                name: tool.name,
                input: tool.input,
              })),
            });
            const results: NeutralToolResultBlock[] = [];
            for (const tool of toolUses) {
              const result = await dispatchRecoveryTool(
                tool.name,
                tool.input,
                request.projectPath,
                request.failedOpenError,
              );
              onEvent?.({
                type: "tool_use_end",
                toolName: tool.name,
                toolResult: result,
              });
              results.push({
                type: "tool_result",
                toolCallId: tool.id,
                output: result,
              });
            }
            messages.push({ role: "tool", content: results });
            continue;
          }
          onEvent?.({ type: "message_complete" });
          return fullText;
        }
        onEvent?.({ type: "message_complete" });
        return fullText;
      } catch (err) {
        onEvent?.({ type: "error", text: errorMessage(err) });
        return fullText;
      } finally {
        abortController = null;
      }
    },
  };
}
