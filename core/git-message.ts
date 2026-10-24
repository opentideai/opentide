import {
  DEFAULT_MODEL_ID,
  getProviderKey,
  getUtilityModelForRequest,
  providerFor,
} from "./config.ts";
import { callUtilityModel } from "./utility-model.ts";
import { type GitCommitContext, prepareGitCommitContext } from "./git.ts";
import type { ModelUsageRecord, RecordModelUsageInput } from "./types.ts";

export interface ResolvedGitCommitMessage {
  message: string;
  generated: boolean;
  generatedBy: "user" | "model" | "fallback";
}

export type GitCommitMessageModelCall = (
  input: {
    model: string;
    context: GitCommitContext;
    sessionId?: string | null;
    changesetId?: string | null;
    recordUsage?: (
      input: RecordModelUsageInput,
    ) => Promise<ModelUsageRecord>;
  },
) => Promise<string>;

let testModelCall: GitCommitMessageModelCall | null = null;

export function setGitCommitMessageModelCallForTest(
  call: GitCommitMessageModelCall | null,
): () => void {
  const previous = testModelCall;
  testModelCall = call;
  return () => {
    testModelCall = previous;
  };
}

function sanitizeCommitSubject(raw: string): string {
  const firstLine = raw.split(/\r?\n/)[0]?.trim() ?? "";
  return firstLine
    .replace(/^["'`]+|["'`]+$/g, "")
    .replace(/\s+/g, " ")
    .replace(/[.。]+$/g, "")
    .trim();
}

function validCommitSubject(subject: string): boolean {
  return subject.length > 0 && subject.length <= 72 &&
    !/[<>]/.test(subject) &&
    !subject.includes("\n");
}

async function defaultModelCall(
  input: Parameters<GitCommitMessageModelCall>[0],
): Promise<string> {
  const { text } = await callUtilityModel({
    model: input.model,
    maxTokens: 64,
    system:
      "You write concise Git commit subjects. Return one imperative sentence, no markdown, no quotes, no body, at most 72 characters.",
    user: `Generate a commit subject for these staged changes.\n\n` +
      `Status:\n${input.context.porcelain || "(none)"}\n\n` +
      `Name status:\n${input.context.nameStatus || "(none)"}\n\n` +
      `Diff stat:\n${input.context.stat || "(none)"}`,
    accounting: {
      role: "utility",
      caller: "git_message",
      sessionId: input.sessionId ?? null,
      changesetId: input.changesetId ?? null,
      recordUsage: input.recordUsage,
      metadata: {
        stagedFiles: input.context.nameStatus
          .split(/\r?\n/)
          .filter((line) => line.trim()).length,
      },
    },
  });
  return text;
}

export async function resolveGitCommitMessage(
  projectDir: string,
  message?: string,
  flush?: () => void,
  opts: {
    sessionId?: string | null;
    changesetId?: string | null;
    recordUsage?: (
      input: RecordModelUsageInput,
    ) => Promise<ModelUsageRecord>;
  } = {},
): Promise<ResolvedGitCommitMessage> {
  const explicit = message?.trim() ?? "";
  if (explicit) {
    return { message: explicit, generated: false, generatedBy: "user" };
  }

  const context = prepareGitCommitContext(projectDir, flush);
  const fallback = context.fallbackMessage;
  const call = testModelCall;
  const model = getUtilityModelForRequest();
  // Real generation needs a key AND a configured utility model (D9): without either,
  // use the deterministic fallback rather than call a provider with no model. A test
  // seam supplies its own call and ignores the model id, so it still runs.
  if (!call && (!model || !getProviderKey(providerFor(model)))) {
    return { message: fallback, generated: true, generatedBy: "fallback" };
  }

  try {
    const subject = sanitizeCommitSubject(
      await (call ?? defaultModelCall)({
        model: model ?? DEFAULT_MODEL_ID,
        context,
        sessionId: opts.sessionId ?? null,
        changesetId: opts.changesetId ?? null,
        recordUsage: opts.recordUsage,
      }),
    );
    if (validCommitSubject(subject)) {
      return { message: subject, generated: true, generatedBy: "model" };
    }
  } catch {
    // Commit should not be blocked only because message generation failed.
  }

  return { message: fallback, generated: true, generatedBy: "fallback" };
}
