// @layer agent-loop — what the agent process serves the IDE.
//
// The chat socket (/chat), the live turn's status (/api/chat/status), the
// session actions that touch the live turn (new, clear, compact and resume) and
// the external MCP servers the chat connects to (/api/mcp-servers), and what
// needs a model outside a turn: the Audits panel's runs (/api/audits/run) and
// the commit button's subject (/api/git/commit). It holds the login too
// (/api/auth/*): serve has none. The IDE
// reads everything else, history included, from serve. The agent holds
// no Kernel: an AgentHost tells it who is asking and which project they have
// open, and attaches a chat runtime to that project.
import { type Context, Hono, type MiddlewareHandler } from "hono";
import { upgradeWebSocket } from "hono/deno";
import type { WSContext } from "hono/ws";
import { canReadUserSession, type CurrentUser } from "../core/auth.ts";
import type {
  ChatEvent,
  ChatEventHandler,
  ChatRuntime,
} from "../core/chat-contract.ts";
import { isAllowedWebSocketRequest } from "../core/loopback-guard.ts";
import { errorMessage } from "../core/util.ts";
import { AGENT_TURN_SETTLE_TIMEOUT_MS } from "../core/config.ts";
import type { ToolResult } from "../core/tools/dispatch.ts";
import type { HistoryClient } from "./chat-backend.ts";
import type { McpServerEdit, ProjectMcpServers } from "./agent-mcp-servers.ts";
import type { ChatTelemetry } from "./chat-telemetry.ts";
import type { Forward } from "./front-door.ts";

// The history a project's routes read besides the chat runtime's own.
export type AgentHistory = Pick<
  HistoryClient,
  "getSession" | "listSessions" | "endSession" | "summarize"
>;

// The chat runtime, plus what the IDE asks of the agent outside a turn.
export interface AgentChat extends ChatRuntime {
  runAudit(category: string): Promise<ToolResult>;
  commit(message?: string): Promise<ToolResult>;
}

export interface AgentProject {
  readonly path: string;
  readonly chat: AgentChat;
  readonly history: AgentHistory;
  readonly mcpServers: ProjectMcpServers;
  // True once the project's connection can't be used any more, as when serve
  // reopened the project with a new token. The next request attaches afresh.
  stale?(): boolean;
  close(): Promise<void>;
}

export interface AgentHost {
  // Who is asking; null refuses the request.
  user(req: Request): Promise<CurrentUser | null>;
  // False when there's no account service to ask for entitlements.
  readonly accountEntitlementsSupported?: boolean;
  // Sign-in, sign-out and the OAuth callbacks, under /api/auth/. They're
  // reached without a user, so a login can start.
  mountAuthRoutes?(app: Hono): void;
  // The project the asking IDE has open; null when none is.
  projectPath(req: Request): Promise<string | null>;
  // A chat runtime on that project, initialized.
  attach(path: string): Promise<AgentProject>;
}

export type AgentLogLevel = "info" | "warn" | "error";

export interface AgentServerOptions {
  telemetry?: ChatTelemetry;
  log?: (level: AgentLogLevel, message: string) => void;
  // Where requests the agent doesn't serve go, when the agent is the IDE's
  // only origin (the desktop app). They pass the same loopback check, and
  // under /api the same login, as the agent's own.
  forward?: Forward;
}

export interface AgentServer {
  app: Hono;
  // The project the chat is attached to, if any.
  currentProject(): string | null;
  close(): Promise<void>;
}

type Session = NonNullable<Awaited<ReturnType<AgentHistory["getSession"]>>>;

interface UserMessage {
  type: string;
  sessionId?: string | null;
  content?: string;
  attachments?: Array<{ name: string; type: string; data: string }>;
  rerun?: boolean;
  changesetId?: string;
  documentRefs?: Array<{ id: string; versionHash?: string }>;
}

const BUSY = "Agent is busy. Wait for the current turn to complete.";
const ARCHIVED_SEND = "Archived sessions must be unarchived before sending";
const NO_PROJECT = "No project open";
const AUTH_PATH_PREFIX = "/api/auth/";
// How many of the most recently active sessions to look through for the one
// to reopen.
const LAST_SESSION_SCAN_LIMIT = 20;

// One turn at a time. settle() waits for the running one, for a project switch
// or shutdown that has just aborted it.
class TurnGate {
  busy = false;
  private running: Promise<void> | null = null;
  private done: (() => void) | null = null;

  begin(): void {
    this.busy = true;
    this.running = new Promise((resolve) => this.done = resolve);
  }

  finish(): void {
    this.busy = false;
    const done = this.done;
    this.done = null;
    this.running = null;
    done?.();
  }

  async settle(): Promise<void> {
    const running = this.running;
    if (!running) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        running,
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, AGENT_TURN_SETTLE_TIMEOUT_MS);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
}

export function createAgentServer(
  host: AgentHost,
  options: AgentServerOptions = {},
): AgentServer {
  const log = options.log ?? (() => {});
  const telemetry = options.telemetry;
  const turns = new TurnGate();
  let attached: AgentProject | null = null;
  let attaching: { path: string; project: Promise<AgentProject> } | null = null;
  let socket: WSContext | null = null;
  // A compaction asked for during a turn runs when the turn ends.
  let pendingCompaction: { sessionId: string; user: CurrentUser } | null = null;
  let compacting = false;

  function send(data: unknown): void {
    try {
      socket?.send(JSON.stringify(data));
    } catch {
      // The socket is closing; the IDE re-reads status when it reconnects.
    }
  }

  async function detach(): Promise<void> {
    const project = attached;
    if (!project) return;
    if (turns.busy) {
      project.chat.abort();
      await turns.settle();
    }
    attached = null;
    pendingCompaction = null;
    await project.close().catch((err) =>
      log("warn", `Closing ${project.path} failed: ${errorMessage(err)}`)
    );
  }

  // The chat for a project, switching to it when the IDE opened another.
  function projectAt(path: string): Promise<AgentProject> {
    if (attached?.path === path && !attached.stale?.()) {
      return Promise.resolve(attached);
    }
    if (attaching?.path === path) return attaching.project;
    const project = (async () => {
      await detach();
      const next = await host.attach(path);
      attached = next;
      return next;
    })();
    attaching = { path, project };
    project.finally(() => {
      if (attaching?.project === project) attaching = null;
    }).catch(() => {});
    return project;
  }

  async function projectFor(req: Request): Promise<AgentProject | null> {
    const path = await host.projectPath(req);
    return path ? await projectAt(path) : null;
  }

  const readable = (user: CurrentUser, session: Session) =>
    canReadUserSession(user, session);

  // A project opens on the user's last session, not an empty one. The agent
  // keeps the current session in memory, so after a restart (every desktop
  // launch) there is none. Done once per attached project: after that, no
  // current session means the user started a new one.
  const sessionChosen = new WeakSet<AgentProject>();

  async function reopenLastSession(
    project: AgentProject,
    user: CurrentUser,
  ): Promise<string | null> {
    const sessions = await project.history.listSessions(
      LAST_SESSION_SCAN_LIMIT,
    );
    const last = sessions.find((s) =>
      s.lastMessageAt !== null && s.ownerUserId === user.id
    );
    if (!last) return null;
    return (await project.chat.resumeSession(last.id, user)).newSessionId;
  }

  async function flushPendingCompaction(
    project: AgentProject,
    onEvent?: ChatEventHandler,
  ): Promise<void> {
    if (compacting || !pendingCompaction) return;
    const pending = pendingCompaction;
    if (project.chat.getCurrentSessionId() !== pending.sessionId) return;
    compacting = true;
    try {
      pendingCompaction = null;
      const session = await project.history.getSession(pending.sessionId);
      if (!session || session.archived || !readable(pending.user, session)) {
        return;
      }
      const summarized = await project.history.summarize({
        sessionId: pending.sessionId,
        kind: "handoff",
        store: true,
        refresh: true,
        requester: "user",
        accountingCaller: "session_compaction",
      });
      const summary = summarized?.summary ?? session.summary ?? "";
      if (!summary.trim()) return;
      const compacted = await project.chat.compactSession(
        summary,
        pending.user,
      );
      onEvent?.({
        type: "session_compacted",
        sessionId: compacted.sessionId,
        sessionName: session.name,
        text: "Context compacted after the current agent turn completed.",
      });
    } catch (err) {
      const msg = errorMessage(err);
      log("error", `queued compaction failed: ${msg}`);
      onEvent?.({ type: "error", text: `Queued compaction failed: ${msg}` });
    } finally {
      compacting = false;
    }
  }

  // Points the chat at the session the IDE is showing. A null means "carry
  // on", unless the session carried on is gone, archived or not the user's.
  async function alignSession(
    project: AgentProject,
    user: CurrentUser,
    sessionId: string | null | undefined,
  ): Promise<string | null> {
    const chat = project.chat;
    if (sessionId) {
      const session = await project.history.getSession(sessionId);
      if (!session) return "Session not found";
      if (!readable(user, session)) return "Forbidden";
      if (session.archived) return ARCHIVED_SEND;
      if (chat.getCurrentSessionId() !== sessionId) {
        await chat.resumeSession(sessionId, user);
        send({
          type: "system_message",
          text:
            "Agent context was realigned with the active visible session before sending.",
        });
      }
      return null;
    }
    const current = chat.getCurrentSessionId();
    if (!current) return null;
    const session = await project.history.getSession(current);
    if (session && !session.archived && readable(user, session)) return null;
    if (session?.archived) await project.history.endSession(current);
    chat.clearCurrentSession();
    await chat.clearContext();
    return null;
  }

  function runTurn(
    project: AgentProject,
    user: CurrentUser,
    data: UserMessage & { content: string },
  ): void {
    const chat = project.chat;
    telemetry?.messageSent({
      hasAttachments: (data.attachments?.length ?? 0) > 0,
      activeChangeset: Boolean(data.changesetId),
      rerun: Boolean(data.rerun),
    });
    const onEvent = (event: ChatEvent) => {
      send(event);
      telemetry?.turnEvent(event);
      if (event.type === "error" && event.text) log("error", event.text);
    };
    chat.sendMessage(
      data.content,
      onEvent,
      data.attachments,
      addAttachmentSourcesToContent(data.content, data.attachments),
      data.changesetId,
      user,
      data.documentRefs,
    ).catch((err) => {
      const msg = errorMessage(err);
      send({ type: "error", text: msg });
      log("error", msg);
      telemetry?.turnFailed("send_message_error");
    }).finally(async () => {
      await flushPendingCompaction(project, send);
      turns.finish();
      send({ type: "agent_status", busy: false });
    });
  }

  async function onUserMessage(
    ws: WSContext,
    user: CurrentUser,
    project: AgentProject,
    data: UserMessage,
  ): Promise<void> {
    if (data.type === "cancel") {
      if (turns.busy) project.chat.abort();
      return;
    }
    if (data.type !== "user_message" || !data.content) {
      ws.send(JSON.stringify({
        type: "error",
        text: "Expected { type: 'user_message', content: string }",
      }));
      return;
    }
    if (turns.busy) {
      ws.send(JSON.stringify({
        type: "error",
        text: "Agent is busy. Wait for message_complete.",
      }));
      log("warn", "Message rejected: agent is busy");
      return;
    }
    turns.begin();
    try {
      const refused = await alignSession(project, user, data.sessionId);
      if (refused) {
        turns.finish();
        ws.send(JSON.stringify({ type: "error", text: refused }));
        return;
      }
      if (data.rerun) await project.chat.clearContext();
      // The model is a machine setting serve's IDE changes; read it per turn.
      await project.chat.reloadModel();
      runTurn(project, user, { ...data, content: data.content });
    } catch (err) {
      turns.finish();
      const msg = errorMessage(err);
      ws.send(JSON.stringify({ type: "error", text: msg }));
      log("error", msg);
      telemetry?.turnFailed("send_message_exception");
    }
  }

  const app = new Hono();

  // Loopback only, as serve's own sockets and trusted routes are: defeats DNS
  // rebinding and foreign pages.
  const loopbackOnly: MiddlewareHandler = async (c, next) => {
    if (
      !isAllowedWebSocketRequest(c.req.header("origin"), c.req.header("host"))
    ) {
      return c.json({ error: "Forbidden" }, 403);
    }
    await next();
  };

  const users = new WeakMap<Request, CurrentUser>();
  const userOf = (c: Context) => users.get(c.req.raw)!;

  app.use("/api/*", loopbackOnly, async (c, next) => {
    if (c.req.path.startsWith(AUTH_PATH_PREFIX)) return await next();
    const user = await host.user(c.req.raw);
    if (!user) return c.json({ error: "Unauthorized" }, 401);
    users.set(c.req.raw, user);
    await next();
  });

  // --- Login ---

  // The IDE's gate asks here.
  app.get("/api/auth/me", async (c) => {
    const user = await host.user(c.req.raw);
    if (!user) return c.json({ error: "Unauthorized" }, 401);
    return c.json({
      user,
      accountEntitlementsSupported: host.accountEntitlementsSupported !== false,
    });
  });
  host.mountAuthRoutes?.(app);

  // The project for a REST call, or the response refusing it.
  async function requireProject(c: Context): Promise<AgentProject | Response> {
    try {
      return await projectFor(c.req.raw) ?? c.json({ error: NO_PROJECT }, 400);
    } catch (err) {
      return c.json({ error: errorMessage(err) }, 502);
    }
  }

  app.get("/api/chat/status", async (c) => {
    const project = await requireProject(c);
    if (project instanceof Response) return project;
    const detail = c.req.query("detail") === "full" ? "full" : "compact";
    return c.json({
      busy: turns.busy,
      currentSessionId: project.chat.getCurrentSessionId(),
      inProgress: project.chat.getInProgressState(detail),
    });
  });

  app.post("/api/sessions/new", async (c) => {
    const project = await requireProject(c);
    if (project instanceof Response) return project;
    sessionChosen.add(project);
    return c.json(await project.chat.clearSession(userOf(c)));
  });

  app.post("/api/sessions/clear", async (c) => {
    const project = await requireProject(c);
    if (project instanceof Response) return project;
    if (turns.busy) return c.json({ error: BUSY }, 409);
    await project.chat.clearContext();
    return c.json({ ok: true });
  });

  app.post("/api/sessions/compact", async (c) => {
    const project = await requireProject(c);
    if (project instanceof Response) return project;
    const body = await c.req.json<{ summary?: string; defer?: boolean }>()
      .catch(() => null);
    if (turns.busy) {
      if (!body?.defer) return c.json({ error: BUSY }, 409);
      return await queueCompaction(c, project);
    }
    if (!body?.summary) return c.json({ error: "summary is required" }, 400);
    try {
      return c.json(await project.chat.compactSession(body.summary, userOf(c)));
    } catch (err) {
      return c.json({ error: errorMessage(err) }, 500);
    }
  });

  async function queueCompaction(
    c: Context,
    project: AgentProject,
  ): Promise<Response> {
    const user = userOf(c);
    const sessionId = project.chat.getCurrentSessionId();
    if (!sessionId) return c.json({ error: "No active session" }, 400);
    const session = await project.history.getSession(sessionId);
    if (!session) return c.json({ error: "Session not found" }, 404);
    if (!readable(user, session)) return c.json({ error: "Forbidden" }, 403);
    if (session.archived) {
      return c.json({
        error: "Archived sessions must be unarchived before compacting",
      }, 409);
    }
    const coalesced = pendingCompaction?.sessionId === sessionId;
    if (!coalesced) pendingCompaction = { sessionId, user };
    return c.json({ queued: true, sessionId, coalesced }, 202);
  }

  app.post("/api/sessions/resume", async (c) => {
    const project = await requireProject(c);
    if (project instanceof Response) return project;
    const body = await c.req.json<{ sessionId?: string }>().catch(() => null);
    if (!body?.sessionId) {
      return c.json({ error: "sessionId is required" }, 400);
    }
    const session = await project.history.getSession(body.sessionId);
    if (!session) return c.json({ error: "Session not found" }, 404);
    if (!readable(userOf(c), session)) {
      return c.json({ error: "Forbidden" }, 403);
    }
    if (session.archived) {
      return c.json({
        error: "Archived sessions must be unarchived before resuming",
      }, 409);
    }
    if (turns.busy) return c.json({ error: BUSY }, 409);
    sessionChosen.add(project);
    try {
      const result = await project.chat.resumeSession(
        body.sessionId,
        userOf(c),
      );
      return c.json({
        ...result,
        session: await project.history.getSession(result.newSessionId),
      });
    } catch (err) {
      return c.json({ error: errorMessage(err) }, 500);
    }
  });

  app.get("/api/sessions/current", async (c) => {
    const project = await requireProject(c);
    if (project instanceof Response) return project;
    let id = project.chat.getCurrentSessionId();
    if (!id && !sessionChosen.has(project) && !turns.busy) {
      sessionChosen.add(project);
      try {
        id = await reopenLastSession(project, userOf(c));
      } catch (err) {
        return c.json({ error: errorMessage(err) }, 500);
      }
    }
    if (!id) return c.json({ error: "No active session" }, 404);
    const session = await project.history.getSession(id);
    if (!session) return c.json({ error: "Session not found" }, 404);
    if (session.archived) {
      await project.history.endSession(id);
      project.chat.clearCurrentSession();
      await project.chat.clearContext();
      return c.json({ error: "No active session" }, 404);
    }
    if (!readable(userOf(c), session)) {
      return c.json({ error: "Forbidden" }, 403);
    }
    return c.json(session);
  });

  // The terminal's ask("..."): a turn on the current session, streamed back as
  // terminal text.
  app.post("/api/chat/ask", async (c) => {
    const project = await requireProject(c);
    if (project instanceof Response) return project;
    const body = await c.req.json<{ question?: unknown }>().catch(() => null);
    const question = typeof body?.question === "string"
      ? body.question.trim()
      : "";
    if (!question) return c.json({ error: "question is required" }, 400);
    if (turns.busy) {
      return c.json({
        error: "Agent is busy. Wait for current turn to finish.",
      }, 409);
    }
    turns.begin();
    await project.chat.reloadModel();
    const user = userOf(c);
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start: async (controller) => {
        const write = (text: string) =>
          controller.enqueue(encoder.encode(text));
        try {
          await project.chat.sendMessage(
            question,
            (event) => {
              if (event.type === "text_delta" && event.text) write(event.text);
              else if (event.type === "tool_use_start" && event.toolName) {
                write(`\x1b[90m[calling ${event.toolName}...]\x1b[0m\n`);
              }
            },
            undefined,
            undefined,
            undefined,
            user,
          );
          write("\r\n");
        } catch (err) {
          write(`\x1b[91m${errorMessage(err)}\x1b[0m\r\n`);
        } finally {
          await flushPendingCompaction(project);
          turns.finish();
          controller.close();
        }
      },
    });
    return c.body(stream, 200, { "content-type": "text/plain; charset=utf-8" });
  });

  // --- Audits ---

  // The Audits panel's run, on the agent's reviewer; serve stores the result
  // and serves everything else under /api/audits.
  app.post("/api/audits/run", async (c) => {
    const project = await requireProject(c);
    if (project instanceof Response) return project;
    const body = await readJsonObject(c);
    if (body instanceof Response) return body;
    if (typeof body.category !== "string") {
      return c.json({ error: "category is required" }, 400);
    }
    const result = await project.chat.runAudit(body.category);
    if (result.ok) return c.json(result.data);
    const status = result.error?.code === "INVALID_CATEGORY" ? 400 : 502;
    return c.json({ error: result.error?.message ?? "Audit failed" }, status);
  });

  // --- Git ---

  // The commit button. Errors keep serve's shape for its git routes.
  app.post("/api/git/commit", async (c) => {
    const project = await requireProject(c);
    if (project instanceof Response) return project;
    const body = await c.req.json<{ message?: unknown }>().catch(() => null);
    const message = typeof body?.message === "string" ? body.message : "";
    const result = await project.chat.commit(message);
    if (result.ok) return c.json({ ok: true, ...result.data as object });
    const code = result.error?.code ?? "GIT_ERROR";
    return c.json(
      { ok: false, code, error: result.error?.message ?? "Commit failed" },
      code === "GIT_ERROR" ? 500 : 400,
    );
  });

  // --- External MCP servers ---

  async function readJsonObject(
    c: Context,
  ): Promise<Record<string, unknown> | Response> {
    const body: unknown = await c.req.json().catch(() => null);
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      return c.json({ error: "Request body must be a JSON object" }, 400);
    }
    return body as Record<string, unknown>;
  }

  function editResponse(c: Context, edit: McpServerEdit, created = false) {
    if (!edit.ok) return c.json({ error: edit.error }, edit.status);
    const { server, syncErrors } = edit;
    return c.json(
      { ok: true, status: server.status, error: server.error, syncErrors },
      created ? 201 : 200,
    );
  }

  app.get("/api/mcp-servers", async (c) => {
    const project = await requireProject(c);
    if (project instanceof Response) return project;
    return c.json(project.mcpServers.list());
  });

  app.post("/api/mcp-servers", async (c) => {
    const project = await requireProject(c);
    if (project instanceof Response) return project;
    const body = await readJsonObject(c);
    if (body instanceof Response) return body;
    return editResponse(c, await project.mcpServers.add(body), true);
  });

  app.post("/api/mcp-servers/sync", async (c) => {
    const project = await requireProject(c);
    if (project instanceof Response) return project;
    const { errors } = await project.mcpServers.sync();
    return c.json({ ok: true, errors });
  });

  app.put("/api/mcp-servers/:name", async (c) => {
    const project = await requireProject(c);
    if (project instanceof Response) return project;
    const body = await readJsonObject(c);
    if (body instanceof Response) return body;
    const edit = await project.mcpServers.update(c.req.param("name"), body);
    return editResponse(c, edit);
  });

  app.delete("/api/mcp-servers/:name", async (c) => {
    const project = await requireProject(c);
    if (project instanceof Response) return project;
    const name = c.req.param("name");
    if (!await project.mcpServers.remove(name)) {
      return c.json({ error: `Server "${name}" not found` }, 404);
    }
    return c.json({ ok: true });
  });

  app.get(
    "/chat",
    loopbackOnly,
    upgradeWebSocket((c) => {
      const req = c.req.raw;
      const userPromise = host.user(req);
      return {
        async onOpen(_evt, ws) {
          const user = await userPromise;
          if (!user) {
            ws.close(1008, "Unauthorized");
            return;
          }
          socket = ws;
          if (!turns.busy || !attached) return;
          const state = attached.chat.getInProgressState("compact");
          ws.send(JSON.stringify(
            state
              ? {
                type: "agent_status",
                busy: true,
                text: state.text,
                toolCalls: state.toolCalls,
                segmentText: state.segmentText,
                segmentToolCalls: state.segmentToolCalls,
              }
              : { type: "agent_status", busy: true },
          ));
        },
        async onMessage(evt, ws) {
          const user = await userPromise;
          if (!user) {
            ws.close(1008, "Unauthorized");
            return;
          }
          socket = ws;
          let data: UserMessage;
          try {
            data = JSON.parse(String(evt.data)) as UserMessage;
          } catch {
            ws.send(JSON.stringify({ type: "error", text: "Invalid JSON" }));
            return;
          }
          let project: AgentProject | null;
          try {
            project = await projectFor(req);
          } catch (err) {
            ws.send(JSON.stringify({ type: "error", text: errorMessage(err) }));
            return;
          }
          if (!project) {
            ws.send(JSON.stringify({ type: "error", text: NO_PROJECT }));
            return;
          }
          await onUserMessage(ws, user, project, data);
        },
        onClose(_evt, ws) {
          if (socket === ws) socket = null;
        },
      };
    }),
  );

  const forward = options.forward;
  if (forward) app.all("*", loopbackOnly, (c) => forward(c.req.raw));

  return {
    app,
    currentProject: () => attached?.path ?? null,
    close: detach,
  };
}

// Image attachments go into the stored message as data URLs, so the IDE can
// show them when the session is read back.
export function addAttachmentSourcesToContent(
  content: string,
  attachments?: Array<{ name: string; type: string; data: string }>,
): string {
  if (!attachments?.length) return content;
  const match = content.match(/<attachments>([\s\S]*?)<\/attachments>/);
  if (!match) return content;
  try {
    const parsed = JSON.parse(match[1]!) as Array<
      { name: string; type: string; thumb?: string; src?: string }
    >;
    const withSources = parsed.map((meta, index) => {
      const attachment = attachments[index];
      if (!attachment || !attachment.type.startsWith("image/")) return meta;
      return {
        ...meta,
        src: `data:${attachment.type};base64,${attachment.data}`,
      };
    });
    return content.replace(
      match[0],
      `<attachments>${JSON.stringify(withSources)}</attachments>`,
    );
  } catch {
    return content;
  }
}
