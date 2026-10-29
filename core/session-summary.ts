import type { Kernel, KernelLog } from "./registries.ts";
import type { Session, StoredMessage } from "./types.ts";
import type { Changeset } from "./types.ts";
import type { ChangeRecord } from "./changelog.ts";
import type { ModelUsageRecord, RecordModelUsageInput } from "./types.ts";
import {
  getProviderKey,
  getUtilityModelForRequest,
  providerFor,
} from "./config.ts";
import { callUtilityModel } from "./utility-model.ts";

export type SessionSummaryKind =
  | "brief"
  | "handoff"
  | "full"
  | "decisions"
  | "todo";

export interface SummarizeSessionOptions {
  sessionId: string;
  kind?: SessionSummaryKind;
  throughMessageId?: number;
  store?: boolean;
  refresh?: boolean;
  requester?: "user" | "agent";
  accountingCaller?: "session_summary" | "session_compaction";
}

export interface SessionSummaryResult {
  sessionId: string;
  kind: SessionSummaryKind;
  summary: string;
  throughMessageId: number | null;
  stored: boolean;
  generatedBy: "model" | "fallback" | "cached";
  metadata: Record<string, unknown>;
}

export interface SessionSummaryStatus {
  sessionId: string;
  name: string;
  hasSummary: boolean;
  kind: string | null;
  generatedBy: string | null;
  summarizedAt: string | null;
  summarizedThroughMessageId: number | null;
  latestMessageId: number | null;
  newerMessageCount: number;
  fresh: boolean;
}

export interface SummarySource {
  session: NonNullable<Awaited<ReturnType<Kernel["sessions"]["getSession"]>>>;
  messages: StoredMessage[];
  changesets: Changeset[];
  changesByChangeset: Map<string, ChangeRecord[]>;
  usage: Awaited<ReturnType<Kernel["sessions"]["getSessionUsage"]>>;
}

const SUMMARY_KINDS: SessionSummaryKind[] = [
  "brief",
  "handoff",
  "full",
  "decisions",
  "todo",
];

export function normalizeSummaryKind(value: unknown): SessionSummaryKind {
  return SUMMARY_KINDS.includes(value as SessionSummaryKind)
    ? value as SessionSummaryKind
    : "handoff";
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n[truncated ${text.length - max} chars]`;
}

function cleanMessageContent(content: string): string {
  return content
    .replace(/\n\n<referenced-entities>[\s\S]*?<\/referenced-entities>/g, "")
    .replace(/\n?\n?<attachments>[\s\S]*?<\/attachments>/g, "")
    .trim();
}

function parseSessionMetadata(
  metadata: string | null,
): Record<string, unknown> {
  if (!metadata) return {};
  try {
    const parsed = JSON.parse(metadata);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function numberMeta(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function stringMeta(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function formatToolNames(message: StoredMessage): string {
  if (!message.toolCalls) return "";
  try {
    const calls = JSON.parse(message.toolCalls) as Array<{ name?: string }>;
    return calls.map((c) => c.name).filter(Boolean).join(", ");
  } catch {
    return "";
  }
}

function formatSourceForModel(
  source: SummarySource,
  kind: SessionSummaryKind,
): string {
  const messageLimit = kind === "full" ? 120 : 80;
  const contentLimit = kind === "full" ? 1600 : 900;
  const messages = source.messages.slice(-messageLimit).map((m) => {
    const tools = formatToolNames(m);
    const suffix = tools ? ` tools=[${tools}]` : "";
    return `#${m.id} ${m.role} ${m.createdAt}${suffix}\n${
      truncate(cleanMessageContent(m.content), contentLimit)
    }`;
  });

  const changesets = source.changesets.map((cs) => {
    const changes = source.changesByChangeset.get(cs.id) ?? [];
    const changeLines = changes.slice(0, 25).map((c) =>
      `- #${c.id} ${c.action} ${c.category}:${c.key}`
    );
    const more = changes.length > changeLines.length
      ? `\n- ... ${changes.length - changeLines.length} more changes`
      : "";
    const steps = cs.plan.steps.map((s) => `- [${s.status}] ${s.description}`)
      .join("\n");
    return [
      `changeset ${cs.id}: ${cs.title} (${cs.status})`,
      cs.description ? `description: ${cs.description}` : "",
      cs.plan.summary ? `plan: ${cs.plan.summary}` : "",
      steps ? `steps:\n${steps}` : "",
      changeLines.length ? `changes:\n${changeLines.join("\n")}${more}` : "",
    ].filter(Boolean).join("\n");
  });

  return [
    `session: ${source.session.name} (${source.session.id})`,
    source.session.focus ? `focus: ${source.session.focus}` : "",
    source.session.summary
      ? `previous summary:\n${source.session.summary}`
      : "",
    `usage: ${source.usage.turns} turns, ${
      source.usage.totalInputTokens + source.usage.totalOutputTokens
    } tokens, priced $${source.usage.totalCostUsd.toFixed(4)}${
      source.usage.unpricedCalls > 0
        ? `, ${source.usage.unpricedCalls} unpriced calls`
        : ""
    }`,
    changesets.length
      ? `changesets:\n${changesets.join("\n\n")}`
      : "changesets: none",
    messages.length ? `messages:\n${messages.join("\n\n")}` : "messages: none",
  ].filter(Boolean).join("\n\n");
}

function summaryInstructions(kind: SessionSummaryKind): string {
  switch (kind) {
    case "brief":
      return "Write 5-8 concise bullets covering purpose, current state, key decisions, completed work, and next action.";
    case "full":
      return "Write a detailed archival summary with sections: Objective, Timeline, Decisions, Work Completed, Implementation Notes, Validation, Open Questions, Work Remaining, Suggested Next Prompt.";
    case "decisions":
      return "Extract only stable decisions. For each, include decision, rationale if present, and source message or changeset IDs when available.";
    case "todo":
      return "Extract only actionable remaining work. Group by priority when inferable, include blockers and relevant source IDs.";
    case "handoff":
    default:
      return "Write a development handoff with sections: Objective, Decisions, Work Completed, Files or Entities Changed, Validation, Known Issues, Work Remaining, Suggested Next Prompt.";
  }
}

async function generateModelSummary(
  source: SummarySource,
  kind: SessionSummaryKind,
  accountingCaller: "session_summary" | "session_compaction",
  opts: Pick<SummarizeSessionOptions, "throughMessageId" | "requester">,
  recordUsage?: (input: RecordModelUsageInput) => Promise<ModelUsageRecord>,
  log?: KernelLog,
): Promise<string | null> {
  // D9: no configured utility model → skip the summary rather than call with no model.
  const model = getUtilityModelForRequest();
  if (!model) return null;
  const apiKey = getProviderKey(providerFor(model));
  if (!apiKey) return null;

  try {
    const { text } = await callUtilityModel({
      model,
      maxTokens: kind === "full" ? 1800 : 1000,
      user: [
        "You summarize Genie IDE development sessions for future human and agent continuity.",
        "Return markdown only. Be specific, avoid filler, and preserve useful message IDs, changeset IDs, and change IDs when available.",
        summaryInstructions(kind),
        "",
        "<session_source>",
        formatSourceForModel(source, kind),
        "</session_source>",
      ].join("\n"),
      accounting: {
        role: "utility",
        caller: accountingCaller,
        sessionId: source.session.id,
        recordUsage,
        metadata: {
          kind,
          requester: opts.requester ?? "user",
          throughMessageId: opts.throughMessageId ?? null,
        },
      },
    });
    return text.trim() || null;
  } catch (err) {
    log?.log(
      "warn",
      "system",
      `session summary model call failed: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return null;
  }
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

export function buildFallbackSummary(
  source: SummarySource,
  kind: SessionSummaryKind,
): string {
  const userMessages = source.messages.filter((m) => m.role === "user");
  const assistantMessages = source.messages.filter((m) =>
    m.role === "assistant"
  );
  const latestUser = userMessages.at(-1);
  const decisions = userMessages
    .filter((m) =>
      /\b(decide|decision|should|let'?s|use|avoid|prefer)\b/i.test(m.content)
    )
    .slice(-6)
    .map((m) =>
      `- #${m.id}: ${
        truncate(cleanMessageContent(m.content).replace(/\s+/g, " "), 180)
      }`
    );
  const changed = unique(
    [...source.changesByChangeset.values()]
      .flat()
      .map((c) => `${c.category}:${c.key}`),
  ).slice(0, 20);
  const completed = source.changesets
    .filter((cs) => cs.status === "completed")
    .map((cs) => `- ${cs.title} (${cs.id})`);
  const active = source.changesets
    .filter((cs) =>
      cs.status !== "completed" &&
      cs.status !== "abandoned" &&
      cs.status !== "rejected"
    )
    .map((cs) => `- ${cs.title} (${cs.status}, ${cs.id})`);

  if (kind === "decisions") {
    return [
      "**Decisions**",
      decisions.length
        ? decisions.join("\n")
        : "- No explicit decisions found in the available session messages.",
    ].join("\n");
  }

  if (kind === "todo") {
    const openSteps = source.changesets.flatMap((cs) =>
      cs.plan.steps
        .filter((s) => s.status === "pending" || s.status === "in_progress")
        .map((s) => `- ${s.description} (${cs.id}, ${s.status})`)
    );
    return [
      "**Work Remaining**",
      openSteps.length
        ? openSteps.join("\n")
        : "- No explicit remaining changeset steps found.",
      "",
      "**Suggested Next Prompt**",
      latestUser
        ? `Continue from message #${latestUser.id}: ${
          truncate(cleanMessageContent(latestUser.content), 160)
        }`
        : "Review the session and decide the next task.",
    ].join("\n");
  }

  const sections = [
    "**Objective**",
    latestUser
      ? truncate(cleanMessageContent(latestUser.content), 300)
      : `Session "${source.session.name}".`,
    "",
    "**Decisions**",
    decisions.length ? decisions.join("\n") : "- No explicit decisions found.",
    "",
    "**Work Completed**",
    completed.length
      ? completed.join("\n")
      : assistantMessages.length
      ? `- ${assistantMessages.length} assistant response(s) recorded.`
      : "- No completed changesets found.",
    "",
    "**Files or Entities Changed**",
    changed.length
      ? changed.map((v) => `- ${v}`).join("\n")
      : "- No linked changelog changes found.",
    "",
    "**Validation**",
    `- Usage recorded for ${source.usage.turns} turn(s); ${source.usage.totalToolCalls} tool call(s).`,
    "",
    "**Known Issues**",
    active.length
      ? active.join("\n")
      : "- None captured in structured session metadata.",
    "",
    "**Work Remaining**",
    active.length
      ? active.join("\n")
      : "- Review current project state and choose the next task.",
    "",
    "**Suggested Next Prompt**",
    latestUser
      ? `Pick up from message #${latestUser.id} and continue the remaining work.`
      : "What should we work on next?",
  ];

  if (kind === "brief") {
    return sections.filter((line) =>
      line && !line.startsWith("**Files") && !line.startsWith("**Validation")
    ).slice(0, 14).join("\n");
  }

  return sections.join("\n");
}

async function collectSummarySource(
  kernel: Kernel,
  sessionId: string,
  throughMessageId?: number,
): Promise<SummarySource | null> {
  const session = await kernel.sessions.getSession(sessionId);
  if (!session) return null;

  const [rawMessages, changesets, usage] = await Promise.all([
    kernel.sessions.getMessages(sessionId),
    kernel.changesets.list({ sessionId, limit: 50 }),
    kernel.sessions.getSessionUsage(sessionId),
  ]);
  const messages = throughMessageId
    ? rawMessages.filter((m) => m.id <= throughMessageId)
    : rawMessages;
  const changesByChangeset = new Map<string, ChangeRecord[]>();
  await Promise.all(changesets.map(async (cs) => {
    changesByChangeset.set(
      cs.id,
      await kernel.changelog.listByChangeset(cs.id),
    );
  }));
  return { session, messages, changesets, changesByChangeset, usage };
}

export function buildSessionSummaryStatus(
  session: Session,
  messages: StoredMessage[],
): SessionSummaryStatus {
  const metadata = parseSessionMetadata(session.metadata);
  const latestMessageId = messages.at(-1)?.id ?? null;
  const summarizedThrough = numberMeta(metadata.summarizedThroughMessageId);
  const hasSummary = !!session.summary;
  const newerMessageCount = summarizedThrough === null
    ? messages.length
    : messages.filter((msg) => msg.id > summarizedThrough).length;
  const fresh = hasSummary &&
    (latestMessageId === null ||
      (summarizedThrough !== null && summarizedThrough >= latestMessageId));

  return {
    sessionId: session.id,
    name: session.name,
    hasSummary,
    kind: stringMeta(metadata.summaryKind),
    generatedBy: stringMeta(metadata.summaryGeneratedBy),
    summarizedAt: stringMeta(metadata.summarizedAt),
    summarizedThroughMessageId: summarizedThrough,
    latestMessageId,
    newerMessageCount,
    fresh,
  };
}

export async function getSessionSummaryStatus(
  kernel: Kernel,
  sessionId: string,
): Promise<SessionSummaryStatus | null> {
  const session = await kernel.sessions.getSession(sessionId);
  if (!session) return null;
  const messages = await kernel.sessions.getMessages(sessionId);
  return buildSessionSummaryStatus(session, messages);
}

// What summarizing needs from wherever the history lives: the kernel
// in-process, or the history tools over MCP.
export interface SummaryDeps {
  loadSource(
    sessionId: string,
    throughMessageId?: number,
  ): Promise<SummarySource | null>;
  recordUsage(input: RecordModelUsageInput): Promise<ModelUsageRecord>;
  updateSummaryMetadata(
    sessionId: string,
    summary: string,
    metadata: string,
  ): Promise<void>;
  log?: KernelLog;
}

export function summarizeSession(
  kernel: Kernel,
  opts: SummarizeSessionOptions,
): Promise<SessionSummaryResult | null> {
  return summarizeSessionWith({
    loadSource: (sessionId, through) =>
      collectSummarySource(kernel, sessionId, through),
    recordUsage: (input) => kernel.sessions.recordModelUsage(input),
    updateSummaryMetadata: (sessionId, summary, metadata) =>
      kernel.sessions.updateSummaryMetadata(sessionId, summary, metadata),
    log: kernel.log,
  }, opts);
}

export async function summarizeSessionWith(
  deps: SummaryDeps,
  opts: SummarizeSessionOptions,
): Promise<SessionSummaryResult | null> {
  const kind = normalizeSummaryKind(opts.kind);
  const source = await deps.loadSource(opts.sessionId, opts.throughMessageId);
  if (!source) return null;

  const existingMetadata = parseSessionMetadata(source.session.metadata);
  const latestMessageId = source.messages.at(-1)?.id ?? null;
  const summarizedThrough = numberMeta(
    existingMetadata.summarizedThroughMessageId,
  );
  const cachedIsFresh = opts.throughMessageId === undefined &&
    !!source.session.summary &&
    existingMetadata.summaryKind === kind &&
    latestMessageId !== null &&
    summarizedThrough !== null &&
    summarizedThrough >= latestMessageId;

  if (!opts.refresh && (opts.store ?? true) && cachedIsFresh) {
    return {
      sessionId: opts.sessionId,
      kind,
      summary: source.session.summary!,
      throughMessageId: summarizedThrough,
      stored: true,
      generatedBy: "cached",
      metadata: existingMetadata,
    };
  }

  const modelSummary = await generateModelSummary(
    source,
    kind,
    opts.accountingCaller ?? "session_summary",
    opts,
    deps.recordUsage,
    deps.log,
  );
  const summary = modelSummary ?? buildFallbackSummary(source, kind);
  const throughMessageId = latestMessageId;
  const now = new Date().toISOString();
  const metadata = {
    ...existingMetadata,
    summaryKind: kind,
    summarizedAt: now,
    summarizedThroughMessageId: throughMessageId,
    summaryVersion: 1,
    summaryRequester: opts.requester ?? "user",
    summaryGeneratedBy: modelSummary ? "model" : "fallback",
  };

  const shouldStore = opts.store ?? true;
  if (shouldStore) {
    await deps.updateSummaryMetadata(
      opts.sessionId,
      summary,
      JSON.stringify(metadata),
    );
  }

  return {
    sessionId: opts.sessionId,
    kind,
    summary,
    throughMessageId,
    stored: shouldStore,
    generatedBy: modelSummary ? "model" : "fallback",
    metadata,
  };
}
