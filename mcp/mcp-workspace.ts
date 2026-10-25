// @layer mcp — `opentide mcp` on a folder of apps instead of one app.
//
// A client holds one setting for where OpenTide runs: the Desktop extension's
// folder, or the directory the Claude Code plugin was started in. When that is
// a project, mcp-bridge.ts relays to its serve. When it isn't, this module
// treats it as a folder of apps: three tools of its own (list_projects,
// open_project, new_project) list, open and create apps there, and every other
// call is relayed to the open app's serve process.
//
// The tool list doesn't depend on which app is open, so when the folder was
// named explicitly the whole surface is listed from the start and an open takes
// effect in the same chat. Claude Desktop only applies a changed tool list from
// the next chat, so relying on list_changed would strand the chat that asked.
// When the folder is just the directory a client happened to start in, it lists
// only the three tools until an app is open, then sends list_changed.
//
// It remembers the app it last opened per folder (MCP_WORKSPACES_FILE), and
// reopens it on the next start.
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  type JSONRPCMessage,
  LATEST_PROTOCOL_VERSION,
  SUPPORTED_PROTOCOL_VERSIONS,
} from "@modelcontextprotocol/sdk/types.js";
import {
  getUserConfigDir,
  MCP_SERVER_NAME,
  MCP_SERVER_VERSION,
  MCP_WORKSPACES_FILE,
} from "../core/config.ts";
import type { CompositionContext } from "../core/composition.ts";
import { generalGuide } from "../core/agent-guide.ts";
import { hasProjectManifest } from "../core/project-layout.ts";
import { createProject } from "../core/project-manager.ts";
import type { Result } from "../core/types.ts";
import { errorMessage } from "../core/util.ts";
import {
  isRequest,
  locateAndReport,
  METHOD_NOT_FOUND,
  preInitializeReply,
  stdioTransport,
} from "./mcp-bridge.ts";
import {
  appPreviewResourceContents,
  appPreviewResourceListing,
  isAppPreviewUri,
} from "./mcp-app-preview.ts";
import {
  MCP_SURFACE_META_KEY,
  mcpSurfaceMeta,
  type McpToolListing,
  projectedMcpTools,
} from "./mcp-projection.ts";

type RequestId = string | number;
type Params = Record<string, unknown>;

// JSON-RPC's "internal error": a relayed request the bridge can no longer
// answer, because the app it went to was switched or lost.
const INTERNAL_ERROR = -32603;
const INVALID_PARAMS = -32602;
const INTERNAL_ID_PREFIX = "opentide-workspace-";

export const LIST_PROJECTS = "list_projects";
export const OPEN_PROJECT = "open_project";
export const NEW_PROJECT = "new_project";

const NAME_ARG = {
  type: "object",
  properties: {
    name: {
      type: "string",
      description: "The app's folder name, as list_projects gives it.",
    },
  },
  required: ["name"],
};

export const WORKSPACE_TOOLS: McpToolListing[] = [
  {
    name: LIST_PROJECTS,
    description:
      "List the OpenTide apps in this server's app folder, and which one is open.",
    inputSchema: { type: "object", properties: {} },
    annotations: {
      title: "List apps",
      readOnlyHint: true,
      openWorldHint: false,
    },
  },
  {
    name: OPEN_PROJECT,
    description:
      "Open an app from list_projects. Every other OpenTide tool acts on it from " +
      "the next call on, in this chat. Starts the app's server if it isn't running.",
    inputSchema: NAME_ARG,
    annotations: {
      title: "Open app",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: NEW_PROJECT,
    description:
      "Create a new, empty OpenTide app in this server's app folder and open it.",
    inputSchema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description:
            "The app's name. Its folder is the name in lowercase, with dashes.",
        },
      },
      required: ["name"],
    },
    annotations: {
      title: "New app",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
];

const WORKSPACE_TOOL_NAMES = new Set(WORKSPACE_TOOLS.map((t) => t.name));

export interface UpstreamTarget {
  url: string;
  token: string;
}

// The app last opened in each folder, so a restart reopens it.
export interface WorkspaceMemory {
  read(folder: string): string | null;
  write(folder: string, app: string): void;
}

export interface WorkspaceOptions {
  folder: string;
  // List the whole surface before an app is open (the folder was named), or
  // only the three workspace tools (it's just where the client started).
  eager: boolean;
  // The tool surface and general guide, as serve would give them.
  surface: McpToolListing[];
  guide: string;
  locate: (projectDir: string) => Promise<Result<UpstreamTarget>>;
  // Create an app in the folder; returns its directory.
  create: (folder: string, name: string) => Result<string>;
  memory: WorkspaceMemory;
}

function workspacesPath(): string {
  return join(getUserConfigDir(), MCP_WORKSPACES_FILE);
}

function readWorkspaces(path: string): Record<string, string> {
  if (!existsSync(path)) return {};
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    return parsed && typeof parsed === "object"
      ? parsed as Record<string, string>
      : {};
  } catch {
    return {};
  }
}

export function fileWorkspaceMemory(
  path: string = workspacesPath(),
): WorkspaceMemory {
  return {
    read: (folder) => readWorkspaces(path)[folder] ?? null,
    write: (folder, app) => {
      try {
        mkdirSync(dirname(path), { recursive: true });
        const all = { ...readWorkspaces(path), [folder]: app };
        writeFileSync(path, `${JSON.stringify(all, null, 2)}\n`);
      } catch (err) {
        console.error(
          `  Couldn't remember the open app in ${path}: ${errorMessage(err)}`,
        );
      }
    },
  };
}

// The apps directly under `folder`, by directory name. Lists only; never writes.
export function listApps(folder: string): string[] {
  if (!existsSync(folder)) return [];
  try {
    return readdirSync(folder, { withFileTypes: true })
      .filter((e) =>
        e.isDirectory() && hasProjectManifest(join(folder, e.name))
      )
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
}

function createApp(folder: string, name: string): Result<string> {
  try {
    return { ok: true, data: createProject(folder, name).path };
  } catch (err) {
    return {
      ok: false,
      error: { code: "PROJECT_CREATE_FAILED", message: errorMessage(err) },
    };
  }
}

function textResult(text: string, isError = false) {
  return {
    content: [{ type: "text", text }],
    ...(isError ? { isError: true } : {}),
  };
}

function appsLine(folder: string): string {
  const apps = listApps(folder);
  return apps.length
    ? `Apps in ${folder}: ${apps.join(", ")}.`
    : `There are no apps in ${folder} yet.`;
}

export function noAppOpenText(folder: string): string {
  return `No app is open. ${appsLine(folder)} Call ${OPEN_PROJECT} to work ` +
    `on one or ${NEW_PROJECT} to create one, then try again.`;
}

function workspaceNote(folder: string, app: string): string {
  return `This OpenTide server works on a folder of apps, ${folder}. The open ` +
    `app is ${app}. ${LIST_PROJECTS}, ${OPEN_PROJECT} and ${NEW_PROJECT} ` +
    "switch between them; every other OpenTide tool acts on the open app.";
}

function noAppInstructions(opts: WorkspaceOptions): string {
  const how = `Call ${OPEN_PROJECT} to work on one, or ${NEW_PROJECT} to ` +
    "create one, before any other OpenTide tool.";
  if (opts.eager) {
    return `${opts.guide}\n\nNo app is open yet. ${
      appsLine(opts.folder)
    } ${how}`;
  }
  return `OpenTide is connected, but ${opts.folder} is not an OpenTide app. ` +
    "Ignore it unless the user asks about OpenTide. " +
    `${
      appsLine(opts.folder)
    } ${how} Its other tools appear once an app is open.`;
}

function negotiate(params: Params): string {
  const requested = params.protocolVersion;
  return typeof requested === "string" &&
      SUPPORTED_PROTOCOL_VERSIONS.includes(requested)
    ? requested
    : LATEST_PROTOCOL_VERSION;
}

interface OpenedApp {
  instructions: string | null;
  tools: unknown[];
  meta: unknown;
}

// One MCP session with one app's serve. Requests the bridge makes for itself
// carry their own ids and are answered here; everything else serve sends goes
// to `relay`.
class Upstream {
  private readonly transport: StreamableHTTPClientTransport;
  private readonly internal = new Map<
    RequestId,
    (msg: JSONRPCMessage) => void
  >();
  private nextId = 0;
  private closed = false;

  constructor(
    target: UpstreamTarget,
    private readonly relay: (msg: JSONRPCMessage) => void,
    private readonly lost: (err: unknown) => void,
  ) {
    this.transport = new StreamableHTTPClientTransport(new URL(target.url), {
      requestInit: { headers: { Authorization: `Bearer ${target.token}` } },
    });
  }

  async open(initParams: Params): Promise<OpenedApp> {
    this.transport.onmessage = (msg: JSONRPCMessage) => {
      if (!("method" in msg) && "id" in msg && msg.id !== null) {
        const answer = this.internal.get(msg.id);
        if (answer) {
          this.internal.delete(msg.id);
          answer(msg);
          return;
        }
      }
      this.relay(msg);
    };
    this.transport.onerror = (err: Error) => {
      if (!this.closed) this.lost(err);
    };
    await this.transport.start();
    const init = await this.request("initialize", initParams);
    if (typeof init.protocolVersion === "string") {
      this.transport.setProtocolVersion(init.protocolVersion);
    }
    await this.transport.send({
      jsonrpc: "2.0",
      method: "notifications/initialized",
    });
    const listed = await this.request("tools/list", {});
    return {
      instructions: typeof init.instructions === "string"
        ? init.instructions
        : null,
      tools: Array.isArray(listed.tools) ? listed.tools : [],
      meta: listed._meta,
    };
  }

  private request(method: string, params: Params): Promise<Params> {
    const id = `${INTERNAL_ID_PREFIX}${++this.nextId}`;
    return new Promise((resolveResult, reject) => {
      this.internal.set(id, (msg) => {
        if ("error" in msg) reject(new Error(msg.error.message));
        else if ("result" in msg) resolveResult(msg.result as Params);
      });
      this.transport.send({ jsonrpc: "2.0", id, method, params })
        .catch((err: unknown) => {
          this.internal.delete(id);
          reject(err);
        });
    });
  }

  send(msg: JSONRPCMessage): Promise<void> {
    return this.transport.send(msg);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.transport.terminateSession().catch(() => {});
    await this.transport.close().catch(() => {});
  }
}

/**
 * Serve `downstream` (the client, normally stdio) on a folder of apps. Resolves
 * with 0 when the client disconnects. Losing an app's serve doesn't end it: the
 * next call to that app starts serve again.
 */
export function runWorkspace(
  downstream: Transport,
  opts: WorkspaceOptions,
): Promise<number> {
  let initParams: Params | null = null;
  let app: string | null = null;
  let upstream: Upstream | null = null;
  let opened: OpenedApp | null = null;
  // Relayed requests still waiting on serve, answered with an error if the app
  // is switched or lost before serve answers them.
  const pending = new Set<RequestId>();
  // Opens run one at a time.
  let switching: Promise<unknown> = Promise.resolve();
  // What the client was last given for tools/list, to know when to tell it the
  // list changed.
  let listedNames: string | null = null;
  let finished = false;

  const send = (msg: JSONRPCMessage) =>
    downstream.send(msg).catch(() => void finish());
  const reply = (id: RequestId, result: unknown) =>
    send({ jsonrpc: "2.0", id, result: result as Params });
  const replyError = (id: RequestId, code: number, message: string) =>
    send({ jsonrpc: "2.0", id, error: { code, message } });

  function advertised(): { tools: unknown[]; meta: unknown } {
    if (opened) {
      return {
        tools: [...WORKSPACE_TOOLS, ...opened.tools],
        meta: opened.meta,
      };
    }
    if (!opts.eager) return { tools: WORKSPACE_TOOLS, meta: undefined };
    return {
      tools: [...WORKSPACE_TOOLS, ...opts.surface],
      meta: { [MCP_SURFACE_META_KEY]: mcpSurfaceMeta(opts.surface) },
    };
  }

  function names(): string {
    return advertised().tools
      .map((t) => (t as { name: string }).name)
      .join("\n");
  }

  function notifyIfListChanged(): void {
    if (listedNames === null || listedNames === names()) return;
    void send({ jsonrpc: "2.0", method: "notifications/tools/list_changed" });
  }

  // Closing ends serve's side too (its SSE stream to us), so callers that need
  // serve quiet afterwards, like a disconnect, wait for it.
  function dropUpstream(reason: string): Promise<void> {
    const old = upstream;
    upstream = null;
    for (const id of pending) void replyError(id, INTERNAL_ERROR, reason);
    pending.clear();
    return old ? old.close() : Promise.resolve();
  }

  async function connect(name: string): Promise<Result<OpenedApp>> {
    if (!initParams) {
      return {
        ok: false,
        error: { code: "NOT_INITIALIZED", message: "initialize first" },
      };
    }
    if (upstream) {
      await dropUpstream(`The open app changed to ${name}; try again.`);
    }
    const located = await opts.locate(join(opts.folder, name));
    if (!located.ok) return located;
    const next: Upstream = new Upstream(
      located.data,
      (msg) => {
        if ("id" in msg && msg.id !== null && !("method" in msg)) {
          pending.delete(msg.id);
        }
        void send(msg);
      },
      (err) => {
        if (upstream !== next) return;
        console.error(
          `  Lost the serve process for ${name}: ${errorMessage(err)}`,
        );
        void dropUpstream(`Lost the server for ${name}; try again.`);
      },
    );
    try {
      const result = await next.open(initParams);
      upstream = next;
      app = name;
      opened = result;
      return { ok: true, data: result };
    } catch (err) {
      await next.close();
      return {
        ok: false,
        error: {
          code: "APP_CONNECT_FAILED",
          message: `Couldn't connect to ${name}'s server: ${errorMessage(err)}`,
        },
      };
    }
  }

  // Open `name`, one open at a time; no-op if it's already open and connected.
  function openApp(name: string): Promise<Result<OpenedApp>> {
    const run = switching.then(async (): Promise<Result<OpenedApp>> => {
      if (app === name && upstream && opened) return { ok: true, data: opened };
      const result = await connect(name);
      if (result.ok) {
        opts.memory.write(opts.folder, name);
        notifyIfListChanged();
      }
      return result;
    });
    switching = run.catch(() => {});
    return run;
  }

  // The connection to the open app, reconnecting if serve went away. Null when
  // no app is open.
  async function currentUpstream(): Promise<Result<Upstream> | null> {
    await switching;
    if (!upstream && app) {
      const reopened = await openApp(app);
      if (!reopened.ok) return reopened;
    }
    return upstream ? { ok: true, data: upstream } : null;
  }

  function openedText(name: string, result: OpenedApp, verb: string): string {
    const path = join(opts.folder, name);
    const head =
      `${verb} ${name} (${path}). Every OpenTide tool now acts on it.`;
    return result.instructions
      ? `${head}\n\nGuide for this app:\n\n${result.instructions}`
      : head;
  }

  async function callWorkspaceTool(name: string, args: Params) {
    if (name === LIST_PROJECTS) {
      const apps = listApps(opts.folder).map((n) => ({
        name: n,
        path: join(opts.folder, n),
        open: n === app,
      }));
      return textResult(
        JSON.stringify({ folder: opts.folder, open: app, apps }, null, 2),
      );
    }
    const requested = typeof args.name === "string" ? args.name.trim() : "";
    if (!requested) return textResult("Give the app's name.", true);
    if (name === NEW_PROJECT) {
      const created = opts.create(opts.folder, requested);
      if (!created.ok) return textResult(created.error.message, true);
      const dir = basename(created.data);
      const result = await openApp(dir);
      return result.ok
        ? textResult(openedText(dir, result.data, "Created and opened"))
        : textResult(
          `Created ${created.data}, but couldn't open it: ${result.error.message}`,
          true,
        );
    }
    if (!listApps(opts.folder).includes(requested)) {
      return textResult(
        `There's no app called ${requested}. ${appsLine(opts.folder)}`,
        true,
      );
    }
    const result = await openApp(requested);
    return result.ok
      ? textResult(openedText(requested, result.data, "Opened"))
      : textResult(result.error.message, true);
  }

  async function initialize(params: Params) {
    initParams = params;
    const remembered = opts.memory.read(opts.folder);
    let instructions = noAppInstructions(opts);
    if (remembered && listApps(opts.folder).includes(remembered)) {
      const result = await openApp(remembered);
      if (result.ok) {
        instructions = [
          result.data.instructions,
          workspaceNote(opts.folder, remembered),
        ].filter(Boolean).join("\n\n");
      }
    }
    return {
      protocolVersion: negotiate(params),
      capabilities: {
        tools: { listChanged: true },
        prompts: {},
        resources: {},
      },
      serverInfo: { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION },
      instructions,
    };
  }

  async function relay(
    msg: JSONRPCMessage & { id: RequestId; method: string },
  ) {
    const target = upstream
      ? { ok: true as const, data: upstream }
      : await currentUpstream();
    if (!target || !target.ok) {
      const why = target ? target.error.message : noAppOpenText(opts.folder);
      if (msg.method === "tools/call") {
        return reply(msg.id, textResult(why, true));
      }
      if (!target && msg.method === "prompts/list") {
        return reply(msg.id, { prompts: [] });
      }
      return replyError(
        msg.id,
        target ? INTERNAL_ERROR : METHOD_NOT_FOUND,
        why,
      );
    }
    pending.add(msg.id);
    await target.data.send(msg).catch((err: unknown) => {
      pending.delete(msg.id);
      return replyError(msg.id, INTERNAL_ERROR, errorMessage(err));
    });
  }

  async function handleRequest(
    msg: JSONRPCMessage & { id: RequestId; method: string },
  ) {
    const params = ("params" in msg ? msg.params : undefined) as
      | Params
      | undefined;
    if (msg.method === "initialize") {
      return reply(msg.id, await initialize(params ?? {}));
    }
    if (!initParams) return send(preInitializeReply(msg));
    if (msg.method === "ping") return reply(msg.id, {});
    // show_app's page is static and the same for every app, so the bridge
    // serves it, open app or not.
    if (msg.method === "resources/list") {
      return reply(msg.id, { resources: [appPreviewResourceListing()] });
    }
    if (msg.method === "resources/read") {
      const uri = typeof params?.uri === "string" ? params.uri : "";
      return isAppPreviewUri(uri)
        ? reply(msg.id, appPreviewResourceContents())
        : replyError(msg.id, INVALID_PARAMS, `Unknown resource: ${uri}`);
    }
    if (msg.method === "tools/list") {
      const { tools, meta } = advertised();
      listedNames = names();
      return reply(
        msg.id,
        meta === undefined ? { tools } : {
          tools,
          _meta: meta,
        },
      );
    }
    const tool = typeof params?.name === "string" ? params.name : "";
    if (msg.method === "tools/call" && WORKSPACE_TOOL_NAMES.has(tool)) {
      const args = (params?.arguments ?? {}) as Params;
      return reply(msg.id, await callWorkspaceTool(tool, args));
    }
    return relay(msg);
  }

  function handle(msg: JSONRPCMessage): Promise<unknown> {
    if (isRequest(msg)) return handleRequest(msg);
    // The client's own initialized notification was for this bridge; serve
    // gets one from the bridge when it connects.
    if ("method" in msg && msg.method === "notifications/initialized") {
      return Promise.resolve();
    }
    // Other notifications, and answers to requests serve made of the client.
    if (!upstream) return Promise.resolve();
    return upstream.send(msg).catch(() => {});
  }

  let resolveExit: (code: number) => void = () => {};
  const exit = new Promise<number>((r) => (resolveExit = r));
  async function finish() {
    if (finished) return;
    finished = true;
    await dropUpstream("The client disconnected.");
    await downstream.close().catch(() => {});
    resolveExit(0);
  }

  downstream.onmessage = (msg: JSONRPCMessage) => {
    handle(msg).catch((err) =>
      console.error(`  MCP workspace error: ${errorMessage(err)}`)
    );
  };
  downstream.onclose = () => void finish();
  downstream.onerror = (err: Error) =>
    console.error(`  MCP bridge stdio error: ${errorMessage(err)}`);
  downstream.start().catch(() => void finish());
  return exit;
}

// `opentide mcp` on a folder that isn't a project. Logs go to stderr; stdout
// belongs to JSON-RPC.
export async function runWorkspaceBridge(
  folder: string,
  eager: boolean,
  composition: CompositionContext,
): Promise<number> {
  const dir = resolve(folder);
  console.error(
    `  ${dir} is a folder of apps: ${listApps(dir).length} found. ` +
      `Open or create one with ${OPEN_PROJECT} or ${NEW_PROJECT}.`,
  );
  return await runWorkspace(stdioTransport(), {
    folder: dir,
    eager,
    surface: projectedMcpTools(composition),
    guide: generalGuide(composition),
    locate: locateAndReport,
    create: createApp,
    memory: fileWorkspaceMemory(),
  });
}
