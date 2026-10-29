import { createDatabase, type DatabaseConnection } from "./db/factory.ts";
import { genieSchemasTable } from "./db/schema/index.ts";
import {
  getProjectPaths,
  listProjects,
  type ProjectEntry,
} from "./project-manager.ts";
import { SessionManager } from "./sessions.ts";
import type { Kernel } from "./registries.ts";
import { loadProjectStateData, type PersistedState } from "./persistence.ts";
import type { SessionWithLastMessage, StoredMessage } from "./types.ts";

export interface ProjectRef {
  projectPath?: string;
  projectName?: string;
}

export interface ProjectEntityCounts {
  routes: number;
  handlers: number;
  functions: number;
  schemas: number;
  templates: number;
  assets: number;
  tests: number;
  devViews: number;
  devTools: number;
  types: number;
  configs: number;
}

export interface ProjectSummary {
  path: string;
  name: string;
  createdAt: string;
  lastOpenedAt: string;
  current: boolean;
  savedAt: string | null;
  counts: ProjectEntityCounts;
  sessions?: SessionWithLastMessage[];
  sessionError?: string;
}

export interface SessionContext {
  project: ProjectSummary;
  session: Awaited<ReturnType<SessionManager["getSession"]>>;
  contextInfo: Awaited<ReturnType<SessionManager["getContextInfo"]>> | null;
  messages: StoredMessage[];
}

export interface PinnedAttachmentInfo {
  name: string;
  type: string;
  kind: string;
  hasPreview: boolean;
  hasSource: boolean;
}

export interface PinnedMessageInfo {
  pinId: string;
  scope: "session" | "project";
  messageId: number;
  sessionId: string;
  sessionName: string;
  role: StoredMessage["role"];
  createdAt: string;
  title: string;
  messagePreview: string;
  attachments: PinnedAttachmentInfo[];
  pinned: {
    session: boolean;
    project: boolean;
  };
}

interface CurrentProjectAccess {
  projectPath?: string | null;
  kernel?: Kernel;
  sessions?: SessionManager;
}

const EMPTY_COUNTS: ProjectEntityCounts = {
  routes: 0,
  handlers: 0,
  functions: 0,
  schemas: 0,
  templates: 0,
  assets: 0,
  tests: 0,
  devViews: 0,
  devTools: 0,
  types: 0,
  configs: 0,
};

function sameProject(a?: string | null, b?: string | null): boolean {
  return !!a && !!b && a === b;
}

export function readPersistedState(projectPath: string): PersistedState | null {
  const paths = getProjectPaths(projectPath);
  return loadProjectStateData(paths.stateDir).data;
}

export async function liveCounts(kernel: Kernel): Promise<ProjectEntityCounts> {
  const schemas = await kernel.db.listSchemas();
  return {
    routes: kernel.routes.list().length,
    handlers: kernel.handlers.list().length,
    functions: kernel.functions.list().length,
    schemas: schemas.length,
    templates: kernel.templates.list().length,
    assets: kernel.assets.list().length,
    tests: kernel.tests.list().length,
    devViews: kernel.devViews.list().filter((v) => !v.builtIn).length,
    devTools: kernel.devTools.list().length,
    types: kernel.types.list().length,
    configs: kernel.configs.list().length,
  };
}

export function persistedCounts(
  state: PersistedState | null,
): ProjectEntityCounts {
  if (!state) return { ...EMPTY_COUNTS };
  return {
    routes: state.routes?.length ?? 0,
    handlers: state.handlers?.length ?? 0,
    functions: state.functions?.length ?? 0,
    schemas: 0,
    templates: state.templates?.length ?? 0,
    assets: state.assets?.length ?? 0,
    tests: state.tests?.length ?? 0,
    devViews: state.devViews?.length ?? 0,
    devTools: state.devTools?.length ?? 0,
    types: state.types?.length ?? 0,
    configs: state.configs?.length ?? 0,
  };
}

async function persistedSchemaCount(
  projectPath: string,
): Promise<number | null> {
  let db: DatabaseConnection | null = null;
  try {
    db = await createDatabase({
      driver: "pglite",
      dataDir: getProjectPaths(projectPath).dataDir,
    });
    const rows = await db.drizzle.select({
      tableName: genieSchemasTable.tableName,
    }).from(genieSchemasTable);
    return rows.length;
  } catch {
    return null;
  } finally {
    await db?.close();
  }
}

async function withProjectSessions<T>(
  projectPath: string,
  current: CurrentProjectAccess | undefined,
  fn: (sessions: SessionManager) => Promise<T>,
): Promise<T> {
  if (sameProject(projectPath, current?.projectPath) && current?.sessions) {
    return await fn(current.sessions);
  }

  return await fn(new SessionManager(getProjectPaths(projectPath).historyDir));
}

export function resolveProject(
  ref: ProjectRef,
  currentProjectPath?: string | null,
): ProjectEntry | null {
  const projects = listProjects();
  if (ref.projectPath) {
    return projects.find((p) => p.path === ref.projectPath) ?? null;
  }
  if (ref.projectName) {
    const q = ref.projectName.toLowerCase();
    return projects.find((p) => p.name.toLowerCase() === q) ??
      projects.find((p) => p.name.toLowerCase().includes(q)) ??
      null;
  }
  if (currentProjectPath) {
    return projects.find((p) => p.path === currentProjectPath) ?? null;
  }
  return null;
}

export async function getProjectSummary(
  project: ProjectEntry,
  current?: CurrentProjectAccess,
  opts?: { includeSessions?: boolean; sessionLimit?: number },
): Promise<ProjectSummary> {
  const isCurrent = sameProject(project.path, current?.projectPath);
  const state = isCurrent ? null : readPersistedState(project.path);
  const summary: ProjectSummary = {
    path: project.path,
    name: project.name,
    createdAt: project.createdAt,
    lastOpenedAt: project.lastOpenedAt,
    current: isCurrent,
    savedAt: null,
    counts: isCurrent && current?.kernel
      ? await liveCounts(current.kernel)
      : persistedCounts(state),
  };

  if (!isCurrent) {
    const schemaCount = await persistedSchemaCount(project.path);
    if (schemaCount !== null) summary.counts.schemas = schemaCount;
  }

  if (opts?.includeSessions) {
    try {
      summary.sessions = await withProjectSessions(
        project.path,
        current,
        (sessions) => sessions.listSessions(opts.sessionLimit ?? 10),
      );
    } catch (err) {
      summary.sessionError = err instanceof Error ? err.message : String(err);
      summary.sessions = [];
    }
  }

  return summary;
}

export async function listProjectMentionTargets(
  current?: CurrentProjectAccess,
  sessionLimit = 20,
): Promise<ProjectSummary[]> {
  const projects = listProjects();
  const summaries: ProjectSummary[] = [];
  for (const project of projects) {
    summaries.push(
      await getProjectSummary(project, current, {
        includeSessions: true,
        sessionLimit,
      }),
    );
  }
  return summaries;
}

export async function getSessionContext(
  project: ProjectEntry,
  sessionId: string,
  current?: CurrentProjectAccess,
  messageLimit = 50,
): Promise<SessionContext | null> {
  const projectSummary = await getProjectSummary(project, current, {
    includeSessions: false,
  });
  return await withProjectSessions(project.path, current, async (sessions) => {
    const session = await sessions.getSession(sessionId);
    if (!session) return null;
    const [contextInfo, messages] = await Promise.all([
      sessions.getContextInfo(sessionId).catch(() => null),
      sessions.getMessages(sessionId, { limit: messageLimit }),
    ]);
    return { project: projectSummary, session, contextInfo, messages };
  });
}

function truncate(text: string, max = 2400): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n[truncated ${text.length - max} chars]`;
}

function cleanMessageContent(content: string): string {
  return content
    .replace(/\n\n<referenced-entities>[\s\S]*?<\/referenced-entities>/g, "")
    .replace(/\n?\n?<attachments>[\s\S]*?<\/attachments>/g, "")
    .trim();
}

function parseAttachmentMetadata(content: string): PinnedAttachmentInfo[] {
  const match = content.match(/\n?\n?<attachments>([\s\S]*?)<\/attachments>/);
  if (!match) return [];
  try {
    const parsed = JSON.parse(match[1]!) as Array<Record<string, unknown>>;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((att) => {
        const name = typeof att.name === "string" ? att.name : "attachment";
        const type = typeof att.type === "string" ? att.type : "";
        const lowerName = name.toLowerCase();
        const kind = type.startsWith("image/")
          ? "image"
          : lowerName.endsWith(".md") || type.includes("markdown")
          ? "markdown"
          : lowerName.endsWith(".json") || type.includes("json")
          ? "json"
          : lowerName.endsWith(".yaml") || lowerName.endsWith(".yml")
          ? "yaml"
          : lowerName.endsWith(".pdf") || type.includes("pdf")
          ? "pdf"
          : lowerName.endsWith(".txt") || type.startsWith("text/")
          ? "text"
          : "file";
        return {
          name,
          type,
          kind,
          hasPreview: typeof att.thumb === "string" ||
            typeof att.preview === "string",
          hasSource: typeof att.src === "string",
        };
      });
  } catch {
    return [];
  }
}

function titleForPinnedMessage(
  message: StoredMessage,
  attachments: PinnedAttachmentInfo[],
): string {
  const clean = cleanMessageContent(message.content);
  const firstLine = clean.split(/\r?\n/).map((line) => line.trim()).find(
    Boolean,
  );
  if (firstLine) {
    return firstLine.length > 80 ? `${firstLine.slice(0, 77)}...` : firstLine;
  }
  if (attachments.length === 1) return attachments[0]!.name;
  if (attachments.length > 1) return `${attachments.length} attachments`;
  return `${message.role} message #${message.id}`;
}

function describePin(
  message: StoredMessage,
  sessionName: string,
  scope: "session" | "project",
): PinnedMessageInfo {
  const attachments = parseAttachmentMetadata(message.content);
  const preview = cleanMessageContent(message.content);
  return {
    pinId: `${scope}:${message.id}`,
    scope,
    messageId: message.id,
    sessionId: message.sessionId,
    sessionName,
    role: message.role,
    createdAt: message.createdAt,
    title: titleForPinnedMessage(message, attachments),
    messagePreview: truncate(preview || "(no message text)", 500),
    attachments,
    pinned: {
      session: message.pinned,
      project: message.projectPinned === true,
    },
  };
}

export async function getPinnedMessageInfos(
  sessions: Pick<
    SessionManager,
    "getProjectPinnedMessages" | "getPinnedMessages" | "getSession"
  >,
  scope: "session" | "project",
  sessionId?: string,
): Promise<PinnedMessageInfo[]> {
  const messages = scope === "project"
    ? await sessions.getProjectPinnedMessages()
    : sessionId
    ? await sessions.getPinnedMessages(sessionId, "session")
    : [];
  const names = new Map<string, string>();
  const infos: PinnedMessageInfo[] = [];
  for (const message of messages) {
    let sessionName = names.get(message.sessionId);
    if (!sessionName) {
      const session = await sessions.getSession(message.sessionId);
      sessionName = session?.name ?? "Unknown session";
      names.set(message.sessionId, sessionName);
    }
    infos.push(describePin(message, sessionName, scope));
  }
  return infos.toSorted((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function formatPinnedMessagesContext(
  label: string,
  pins: PinnedMessageInfo[],
): string {
  if (pins.length === 0) return `${label}: none`;
  const lines = [`${label}:`];
  for (const pin of pins) {
    const attachmentText = pin.attachments.length > 0
      ? `; attachments: ${
        pin.attachments.map((a) => `${a.name} (${a.kind})`).join(", ")
      }`
      : "";
    lines.push(
      `- #${pin.messageId} in "${pin.sessionName}" (${pin.role}, ${pin.createdAt}): ${pin.title}${attachmentText}`,
    );
    if (pin.messagePreview && pin.messagePreview !== pin.title) {
      lines.push(`  preview: ${pin.messagePreview}`);
    }
  }
  return lines.join("\n");
}

function parseMetadata(metadata: string | null): Record<string, unknown> {
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

function metadataNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function formatProjectContext(project: ProjectSummary): string {
  const c = project.counts;
  const lines = [
    `project "${project.name}"`,
    `path: ${project.path}`,
    `current: ${project.current}`,
    `created: ${project.createdAt}`,
    `last opened: ${project.lastOpenedAt}`,
    `entities: ${c.routes} routes, ${c.handlers} handlers, ${c.functions} functions, ${c.schemas} schemas, ${c.templates} templates, ${c.assets} assets, ${c.tests} tests, ${c.devTools} dev tools`,
  ];
  if (project.sessions) {
    lines.push(`sessions: ${project.sessions.length}`);
    for (const session of project.sessions.slice(0, 12)) {
      lines.push(
        `- ${session.name} (${session.id}) last message: ${
          session.lastMessageAt ?? "none"
        }`,
      );
      if (session.summary) {
        lines.push(`  summary: ${truncate(session.summary, 500)}`);
      }
    }
  }
  if (project.sessionError) {
    lines.push(`session lookup error: ${project.sessionError}`);
  }
  return lines.join("\n");
}

export function formatSessionContext(ctx: SessionContext): string {
  if (!ctx.session) return "";
  const metadata = parseMetadata(ctx.session.metadata);
  const summarizedThrough = metadataNumber(metadata.summarizedThroughMessageId);
  const lines = [
    `session "${ctx.session.name}"`,
    `project: ${ctx.project.name}`,
    `project path: ${ctx.project.path}`,
    `session id: ${ctx.session.id}`,
    `started: ${ctx.session.startedAt}`,
    `ended: ${ctx.session.endedAt ?? "active"}`,
  ];
  if (ctx.session.focus) lines.push(`focus: ${ctx.session.focus}`);
  if (ctx.contextInfo) {
    lines.push(
      `context: ${ctx.contextInfo.messageCount} messages, approx ${ctx.contextInfo.estimatedTokens} tokens, ${ctx.contextInfo.pinnedCount} pinned`,
    );
  }

  let messages = ctx.messages;
  if (ctx.session.summary) {
    lines.push(
      `summary (${metadata.summaryKind ?? "stored"}; through message ${
        summarizedThrough ?? "unknown"
      }):`,
    );
    lines.push(ctx.session.summary);
    if (summarizedThrough !== null) {
      messages = ctx.messages.filter((msg) => msg.id > summarizedThrough);
      lines.push(
        messages.length > 0
          ? `summary is current through message #${summarizedThrough}; ${messages.length} newer message${
            messages.length === 1 ? "" : "s"
          } included below:`
          : `summary is current through message #${summarizedThrough}; no newer messages.`,
      );
    } else {
      lines.push(
        "stored summary has no message boundary; recent messages included below:",
      );
    }
  } else {
    lines.push("summary: not available; using recent messages");
    lines.push("messages:");
  }

  for (const msg of messages) {
    const role = msg.role === "user"
      ? "User"
      : msg.role === "assistant"
      ? "Assistant"
      : "System";
    lines.push(`\n[${role} ${msg.id} at ${msg.createdAt}]`);
    lines.push(truncate(cleanMessageContent(msg.content)));
  }
  return lines.join("\n");
}
