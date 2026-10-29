// Everything the chat loop reaches outside itself: tools, history, changesets,
// documents, gates and a few project facts. chat.ts never sees a Kernel.
//
// The in-process clients here forward to the kernel. chat-backend-mcp.ts has
// the MCP-backed tools and history, which reach serve only the way any MCP
// client can (docs/tide-client-plan.md).
import type { Kernel, KernelLog } from "../core/registries.ts";
import type { SessionManager } from "../core/sessions.ts";
import type { ChangeContext, Changelog } from "../core/changelog.ts";
import type { DocumentStore } from "../core/documents.ts";
import type {
  Changeset,
  ChangesetReadiness,
  ChangesetStore,
} from "../core/types.ts";
import {
  dispatchTool,
  type ExportTypeCheckToolData,
  flushKernelProjectState,
  type TestRunSummary,
  type ToolResult,
} from "../core/tools/dispatch.ts";
import { checkProjectAwareReadiness } from "../core/project-readiness.ts";
import {
  getPinnedMessageInfos,
  type PinnedMessageInfo,
} from "../core/project-context.ts";
import {
  type SessionSummaryResult,
  summarizeSession,
  type SummarizeSessionOptions,
} from "../core/session-summary.ts";
import {
  commitLandedChangeset,
  commitManagedPaths,
} from "../core/landing-commit.ts";
import { getProjectPaths } from "../core/project-manager.ts";
import { projectGuide } from "../core/agent-guide.ts";
import {
  approveChangeset,
  type ApproveChangesetOptions,
} from "../core/changeset-approval.ts";

// Calls one project tool by name, as an MCP `tools/call` would.
export interface ToolTransport {
  callTool(
    name: string,
    args: Record<string, unknown>,
    context?: ChangeContext,
  ): Promise<ToolResult>;
}

// The session and history operations the chat loop uses.
export interface HistoryClient extends
  Pick<
    SessionManager,
    | "createSession"
    | "getSession"
    | "listSessions"
    | "renameSession"
    | "endSession"
    | "reopenSession"
    | "getMessages"
    | "addMessage"
    | "updateSummaryMetadata"
    | "recordModelUsage"
    | "recordTurnUsage"
  > {
  // Pinned messages, as list_current_session_pins and list_current_project_pins
  // return them.
  pinnedMessages(
    scope: "session" | "project",
    sessionId?: string,
  ): Promise<PinnedMessageInfo[]>;
  summarize(
    opts: SummarizeSessionOptions,
  ): Promise<SessionSummaryResult | null>;
}

// The change records the chat loop reads and annotates.
export type ChangelogClient = Pick<
  Changelog,
  "list" | "updateWorkblockMetadata"
>;

// The document operations the chat loop uses.
export type DocumentClient = Pick<
  DocumentStore,
  | "create"
  | "listPinned"
  | "readContent"
  | "readContentBytes"
  | "recordRef"
>;

// The per-step gates. Each matches a public tool: check_export_types,
// run_tests, test_coverage and test_app.
// Each takes the turn's context, so its attestation is the session's.
export interface GateClient {
  checkExportTypes(
    context?: ChangeContext,
  ): Promise<ToolResult & { data?: ExportTypeCheckToolData }>;
  runTests(
    context?: ChangeContext,
  ): Promise<ToolResult & { data?: TestRunSummary }>;
  coverage(context?: ChangeContext): Promise<{ untested: string[] }>;
  loadApp(
    path: string,
    context?: ChangeContext,
  ): Promise<{ pageErrors: string[] }>;
}

// What the system prompt carries from the project.
export interface PromptFacts {
  customInstructions?: string;
  skills: Array<{ name: string; prompt: string }>;
  secrets: Array<{
    key: string;
    description?: string;
    status: "set" | "env" | "unset";
  }>;
}

// Project facts the prompt and checkpoints need.
export interface ProjectClient {
  // Where the agent keeps its cache-composition trace, or null for none.
  historyDir(): string | null;
  promptFacts(): Promise<PromptFacts>;
  // Commits what OpenTide manages and the files `changesetId` wrote. False
  // with no project loaded, nothing to commit, or commits turned off; throws
  // GitProjectError when git refuses.
  commit(message: string, changesetId: string): Promise<boolean>;
}

// The changeset operations the chat loop uses.
export interface ChangesetClient extends
  Pick<
    ChangesetStore,
    | "get"
    | "getActive"
    | "updateStep"
    | "setApprovalMessageId"
    | "addWorkMessageId"
    | "addPlanMessageId"
    | "complete"
  > {
  // Starts a changeset waiting for approval, as approve_changeset does: on the
  // user's word, or on the light lane. Throws when it can't.
  approve(id: string, options?: ApproveChangesetOptions): Promise<Changeset>;
  // Rolls the changeset's turn usage up onto it, as complete_changeset does.
  aggregate(id: string): Promise<Changeset>;
  // The readiness gate complete_changeset applies.
  readiness(changeset: Changeset): Promise<ChangesetReadiness>;
}

export interface ChatBackend {
  tools: ToolTransport;
  history: HistoryClient;
  changesets: ChangesetClient;
  changelog: ChangelogClient;
  documents: DocumentClient;
  gates: GateClient;
  project: ProjectClient;
  // The agent's own log.
  log: KernelLog;
}

export function inProcessToolTransport(
  kernel: Kernel,
  rebuild: () => void,
): ToolTransport {
  return {
    callTool: (name, args, context) =>
      dispatchTool(name, args, kernel, rebuild, context),
  };
}

export function inProcessChangesetClient(kernel: Kernel): ChangesetClient {
  // Read per call: kernel.changesets throws until a composition provides it.
  const store = () => kernel.changesets;
  return {
    get: (id) => store().get(id),
    getActive: (sessionId) => store().getActive(sessionId),
    approve: async (id, options) => {
      const approved = await approveChangeset(kernel, id, options);
      if (!approved.ok) throw new Error(approved.error.message);
      return approved.data;
    },
    updateStep: (id, stepId, status) => store().updateStep(id, stepId, status),
    setApprovalMessageId: (id, messageId) =>
      store().setApprovalMessageId(id, messageId),
    addWorkMessageId: (id, messageId) =>
      store().addWorkMessageId(id, messageId),
    addPlanMessageId: (id, messageId) =>
      store().addPlanMessageId(id, messageId),
    complete: async (id) => {
      const completed = await store().complete(id);
      // As complete_changeset does: flush, then commit what landed.
      if (kernel.projectDir) flushKernelProjectState(kernel);
      await commitLandedChangeset(kernel, completed);
      return completed;
    },
    aggregate: (id) => store().aggregate(id, kernel.sessions, kernel.changelog),
    readiness: (changeset) => checkProjectAwareReadiness(kernel, changeset),
  };
}

export function inProcessHistoryClient(kernel: Kernel): HistoryClient {
  const sessions = kernel.sessions;
  return {
    createSession: (...a) => sessions.createSession(...a),
    getSession: (...a) => sessions.getSession(...a),
    listSessions: (...a) => sessions.listSessions(...a),
    renameSession: (...a) => sessions.renameSession(...a),
    endSession: (...a) => sessions.endSession(...a),
    reopenSession: (...a) => sessions.reopenSession(...a),
    getMessages: (...a) => sessions.getMessages(...a),
    addMessage: (...a) => sessions.addMessage(...a),
    updateSummaryMetadata: (...a) => sessions.updateSummaryMetadata(...a),
    recordModelUsage: (...a) => sessions.recordModelUsage(...a),
    recordTurnUsage: (...a) => sessions.recordTurnUsage(...a),
    pinnedMessages: (scope, sessionId) =>
      getPinnedMessageInfos(sessions, scope, sessionId),
    summarize: (opts) => summarizeSession(kernel, opts),
  };
}

// The gates go through their public tools, as they do over MCP, so each mints
// its attestation the same way.
export function inProcessGateClient(
  kernel: Kernel,
  rebuild: () => void,
): GateClient {
  const tool = (
    name: string,
    args: Record<string, unknown>,
    context?: ChangeContext,
  ) => dispatchTool(name, args, kernel, rebuild, context);
  const data = async <T>(
    name: string,
    args: Record<string, unknown>,
    context?: ChangeContext,
  ) => {
    const result = await tool(name, args, context);
    if (!result.ok) {
      throw new Error(`${name}: ${result.error?.message ?? "failed"}`);
    }
    return result.data as T;
  };
  return {
    checkExportTypes: async (context) =>
      await tool("check_export_types", {}, context) as ToolResult & {
        data?: ExportTypeCheckToolData;
      },
    runTests: async (context) =>
      await tool("run_tests", {}, context) as ToolResult & {
        data?: TestRunSummary;
      },
    coverage: async (context) => ({
      untested:
        (await data<{ untested?: string[] }>("test_coverage", {}, context))
          .untested ?? [],
    }),
    loadApp: async (path, context) => ({
      pageErrors: (await data<{ pageErrors?: string[] }>(
        "test_app",
        { path },
        context,
      )).pageErrors ?? [],
    }),
  };
}

export function inProcessProjectClient(kernel: Kernel): ProjectClient {
  return {
    historyDir: () =>
      kernel.projectDir ? getProjectPaths(kernel.projectDir).historyDir : null,
    promptFacts: async () => ({
      customInstructions: projectGuide(kernel) || undefined,
      skills: await kernel.skills.listEnabled(),
      secrets: kernel.secrets.list().map((s) => ({
        key: s.key,
        description: s.description,
        status: kernel.secrets.status(s.key),
      })),
    }),
    commit: async (message, changesetId) => {
      if (!kernel.projectDir) return false;
      flushKernelProjectState(kernel);
      return await commitManagedPaths(
        kernel,
        kernel.projectDir,
        message,
        changesetId,
      ) !== null;
    },
  };
}

export function inProcessChatBackend(
  kernel: Kernel,
  rebuild: () => void,
): ChatBackend {
  return {
    tools: inProcessToolTransport(kernel, rebuild),
    history: inProcessHistoryClient(kernel),
    changesets: inProcessChangesetClient(kernel),
    changelog: kernel.changelog,
    documents: kernel.documents,
    gates: inProcessGateClient(kernel, rebuild),
    project: inProcessProjectClient(kernel),
    log: kernel.log,
  };
}
