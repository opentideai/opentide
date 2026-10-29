// @layer agent-loop — the IDE's commit button. With no message, the agent's
// utility model writes the subject from the project's git status, read over
// MCP as any client would, and git_commit lands it. With no model, or a reply
// that won't do, git_commit builds the subject from the staged files itself.
import type { ChangeContext } from "../core/changelog.ts";
import {
  COMMIT_SUBJECT_MAX_CHARS,
  COMMIT_SUBJECT_MAX_TOKENS,
  getProviderKey,
  getUtilityModelForRequest,
  providerFor,
} from "../core/config.ts";
import type { ToolResult } from "../core/tools/dispatch.ts";
import type { ModelUsageRecord, RecordModelUsageInput } from "../core/types.ts";
import { callUtilityModel } from "../core/utility-model.ts";
import type { GitProjectStatus } from "../shared/git.ts";
import type { ToolTransport } from "./chat-backend.ts";

export type CommitSubjectCall = (
  input: { model: string; status: GitProjectStatus },
) => Promise<string>;

export interface CommitOptions {
  context?: ChangeContext;
  recordUsage?: (input: RecordModelUsageInput) => Promise<ModelUsageRecord>;
  // Stands in for the model.
  call?: CommitSubjectCall;
}

export interface Committed {
  status: GitProjectStatus;
  // The subject used; null when git_commit built it.
  message: string | null;
  messageGenerated: boolean;
  messageGeneratedBy: "user" | "model" | "fallback";
}

export async function commitProject(
  tools: ToolTransport,
  message: string | undefined,
  opts: CommitOptions = {},
): Promise<ToolResult> {
  const explicit = message?.trim() ?? "";
  const subject = explicit ? explicit : await modelSubject(tools, opts);
  const committed = await tools.callTool(
    "git_commit",
    subject ? { message: subject } : {},
    opts.context,
  );
  if (!committed.ok) return committed;
  const by = explicit ? "user" : subject ? "model" : "fallback";
  const status = committed.data as GitProjectStatus;
  const result: Committed = {
    status,
    message: subject ?? status.latestCommit?.subject ?? null,
    messageGenerated: by !== "user",
    messageGeneratedBy: by,
  };
  return { ok: true, data: result };
}

// The model's subject, or null to leave it to git_commit.
async function modelSubject(
  tools: ToolTransport,
  opts: CommitOptions,
): Promise<string | null> {
  const model = getUtilityModelForRequest();
  if (!opts.call && (!model || !getProviderKey(providerFor(model)))) {
    return null;
  }
  const read = await tools.callTool("git_status", {}, opts.context);
  if (!read.ok) return null;
  const status = read.data as GitProjectStatus;
  if (status.clean) return null;
  try {
    const call = opts.call ?? defaultCall(opts);
    const subject = sanitizeCommitSubject(
      await call({ model: model ?? "", status }),
    );
    return validCommitSubject(subject) ? subject : null;
  } catch {
    // A commit isn't blocked because the subject couldn't be written.
    return null;
  }
}

function defaultCall(opts: CommitOptions): CommitSubjectCall {
  return async ({ model, status }) => {
    const { text } = await callUtilityModel({
      model,
      maxTokens: COMMIT_SUBJECT_MAX_TOKENS,
      system:
        `You write concise Git commit subjects. Return one imperative sentence, no markdown, no quotes, no body, at most ${COMMIT_SUBJECT_MAX_CHARS} characters.`,
      user: `Generate a commit subject for these changes.\n\n${
        describeChanges(status)
      }`,
      accounting: {
        role: "utility",
        caller: "git_message",
        sessionId: opts.context?.sessionId ?? null,
        changesetId: opts.context?.changesetId ?? null,
        recordUsage: opts.recordUsage,
        metadata: { changedFiles: status.changedCount + status.untrackedCount },
      },
    });
    return text;
  };
}

// The status as `git status --short` would print it, app source first.
export function describeChanges(status: GitProjectStatus): string {
  const lines = status.files.map((f) =>
    f.untracked ? `?? ${f.path}` : `${f.index}${f.worktree} ${f.path}`
  );
  const shown = lines.length;
  const total = status.changedCount + status.untrackedCount;
  const state = status.projectState.changedCount +
    status.projectState.untrackedCount;
  const more = total - state - shown;
  if (more > 0) lines.push(`(${more} more)`);
  if (state > 0) {
    lines.push(`(${state} OpenTide state file(s) under .opentide/)`);
  }
  return lines.join("\n") || "(none)";
}

export function sanitizeCommitSubject(raw: string): string {
  const firstLine = raw.split(/\r?\n/)[0]?.trim() ?? "";
  return firstLine
    .replace(/^["'`]+|["'`]+$/g, "")
    .replace(/\s+/g, " ")
    .replace(/[.。]+$/g, "")
    .trim();
}

function validCommitSubject(subject: string): boolean {
  return subject.length > 0 && subject.length <= COMMIT_SUBJECT_MAX_CHARS &&
    !/[<>]/.test(subject);
}
