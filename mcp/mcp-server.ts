// @layer mcp — SDK transport wiring for the outbound MCP server. Binds the
// transport-agnostic projection (mcp-projection.ts) to the official MCP SDK's
// low-level Server, using its JSON-Schema tool API (setRequestHandler) so the
// core tool definitions pass through unchanged — no zod re-encoding. Stdio is
// the first transport (§7 Phase 3); HTTP/SSE is a later slice.
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  type CallToolRequest,
  CallToolRequestSchema,
  ErrorCode,
  type GetPromptRequest,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  McpError,
  type ReadResourceRequest,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import {
  appPreviewResourceContents,
  appPreviewResourceListing,
  isAppPreviewUri,
} from "./mcp-app-preview.ts";
import { getMcpPrompt, listMcpPrompts } from "./mcp-prompts.ts";
import type { Kernel } from "../core/registries.ts";
import type { ChangeContext } from "../core/changelog.ts";
import {
  dispatchMcpTool,
  MCP_SURFACE_META_KEY,
  mcpSurfaceMeta,
  projectedMcpTools,
} from "./mcp-projection.ts";
import {
  MCP_CLIENT_NAME_MAX_CHARS,
  MCP_MAX_ARG_BYTES,
  MCP_SERVER_NAME,
  MCP_SERVER_VERSION,
  MCP_SESSION_TAG_BYTES,
} from "../core/config.ts";
import type { McpCallInput } from "../core/types.ts";
import { errorMessage } from "../core/util.ts";
import {
  flushKernelProjectState,
  isMutationTool,
  isReadOnlyTool,
} from "../core/tools/dispatch.ts";
import { buildAgentInstructions } from "../core/agent-guide.ts";
import { mcpSessionMetadata } from "../core/session-liveness.ts";
import {
  OPEN_SESSION,
  type SessionBinding,
  turnContextFrom,
} from "./mcp-history.ts";

// Whether a call needs the connection's own session, and so starts one if
// there's none yet. open_session chooses the session; a read has nothing to
// record in one; manage_sessions lists and searches, or acts on the session it
// names. Those use the bound session if there is one.
const MANAGE_SESSIONS = "manage_sessions";
const SESSION_FREE_ACTIONS: ReadonlySet<string> = new Set(["list", "search"]);

function startsSession(name: string, args: Record<string, unknown>): boolean {
  if (name === OPEN_SESSION || isReadOnlyTool(name)) return false;
  if (name !== MANAGE_SESSIONS) return true;
  return !SESSION_FREE_ACTIONS.has(String(args.action)) && !args.session_id;
}

// How work driven over MCP is labelled when the client doesn't say who it is:
// the name of the session record this server creates (so it is attributable in
// the IDE's session list) and the ChangeContext userMessage on every call. A
// client that sends clientInfo gets "<name> (MCP)" instead. The session record
// adds a random tag, "<label> #3f9a", since one client sends the same name for
// every session.
const MCP_AGENT_LABEL = "External MCP agent";
const UNNAMED_CLIENT = "unknown";

export type McpTransportKind = McpCallInput["transport"];

// Who is calling, from the client's initialize clientInfo. Self-reported and
// unauthenticated: it labels the work, it doesn't grant anything.
interface McpCaller {
  label: string;
  principalId: string;
}

function callerFrom(server: Server): McpCaller {
  const name = server.getClientVersion()?.name?.trim()
    .slice(0, MCP_CLIENT_NAME_MAX_CHARS);
  if (!name) {
    return { label: MCP_AGENT_LABEL, principalId: `local:${UNNAMED_CLIENT}` };
  }
  return { label: `${name} (MCP)`, principalId: `local:${name}` };
}

function sessionName(caller: McpCaller): string {
  const tag = Array.from(
    crypto.getRandomValues(new Uint8Array(MCP_SESSION_TAG_BYTES)),
    (b) => b.toString(16).padStart(2, "0"),
  ).join("");
  return `${caller.label} #${tag}`;
}

function argBytes(args: Record<string, unknown>): number {
  return new TextEncoder().encode(JSON.stringify(args)).length;
}

function argsTooLarge(bytes: number) {
  return {
    content: [{
      type: "text" as const,
      text: `Error [ARGS_TOO_LARGE]: the arguments are ${bytes} bytes; the ` +
        `limit is ${MCP_MAX_ARG_BYTES}. Split the work into smaller calls.`,
    }],
    isError: true,
  };
}

// What the projection needs from the assembled core: a Kernel and its rebuild
// hook. The composition root (mcp-main.ts) supplies these from a loaded project.
export interface McpServerDeps {
  kernel: Kernel;
  rebuild: () => void;
}

// Build the MCP Server with the core tool surface wired to dispatch. Split from
// the transport so tests can exercise the handlers without spawning stdio.
export function createMcpServer(
  deps: McpServerDeps,
  transport: McpTransportKind = "stdio",
): Server {
  // `instructions` is the guidance a client puts in the agent's system prompt
  // on connect (core/agent-guide.ts). Tool descriptions say what each verb does;
  // this says how the verbs fit together and what not to do between them.
  const server = new Server(
    { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION },
    {
      capabilities: { tools: {}, prompts: {}, resources: {} },
      instructions: buildAgentInstructions(deps.kernel),
    },
  );

  // One session per server instance. Stdio has a single instance; the HTTP
  // transport builds one per client connection (mcp-http.ts openSession), so
  // each connected agent gets its own. The external agent's changesets are
  // scoped to this id, so the mutation gate's getActive(sessionId) resolves the
  // in_progress changeset for THIS agent — and only this agent.
  //
  // It has to be a REAL session, not merely a unique string. Changesets and
  // changelog records carry their sessionId, and project-doctor.ts counts a
  // reference to a session that does not exist as a consistency ERROR — which
  // the completion gate refuses to look past (PROJECT_CONSISTENCY_ERRORS). A
  // synthetic id left every MCP write dangling and put complete_changeset out of
  // reach entirely, so the record is created through the same SessionManager the
  // IDE's control server uses. Passing a name matters: createSession reuses an
  // existing empty session when called without one, which would collapse two
  // instances onto a single scope.
  //
  // Created on the first call that writes, and memoized: listing tools or
  // reading must not leave an empty session behind, and the SDK's call handler
  // is the first place an await is available. By then initialize has run, so
  // the session can carry the client's name.
  //
  // The record is tagged as an MCP session and tracked in kernel.liveSessions
  // while the client is connected, so a changeset it leaves behind when it goes
  // away can be adopted by the next client (core/session-liveness.ts).
  let session: Promise<string> | null = null;
  // open_session moves the connection to another session. The one it leaves
  // stays open: it may be resumed, and only the connection is going.
  const binding: SessionBinding = {
    bind: (sessionId) => {
      const previous = session;
      session = Promise.resolve(sessionId);
      void previous?.then((id) => {
        if (id !== sessionId) deps.kernel.liveSessions.close(id);
      });
      deps.kernel.liveSessions.touch(sessionId);
    },
  };
  const sessionIdFor = (caller: McpCaller): Promise<string> =>
    session ??= deps.kernel.sessions
      // Project visibility: an MCP client's history is the project's.
      .createSession(sessionName(caller), { visibility: "project" })
      .then(async (created) => {
        await deps.kernel.sessions.updateSummaryMetadata(
          created.id,
          null,
          mcpSessionMetadata(),
        );
        return created.id;
      })
      .catch((err: unknown) => {
        // Degrade instead of failing the call: a synthetic id still scopes the
        // gate correctly, it just leaves the doctor complaining. stdout is the
        // JSON-RPC channel, so this goes to stderr.
        console.error(
          `[opentide] could not create an MCP session record: ${err}. Falling ` +
            "back to a synthetic id; completing a changeset will report " +
            "PROJECT_CONSISTENCY_ERRORS.",
        );
        return `mcp:${crypto.randomUUID()}`;
      });

  // The client is gone (HTTP session closed, or stdio ended). Its record is
  // ended so a later client can tell, even after this process restarts.
  server.onclose = () => {
    if (!session) return;
    void session.then(async (id) => {
      deps.kernel.liveSessions.close(id);
      await deps.kernel.sessions.endSession(id);
    }).catch((err: unknown) => {
      console.error(
        `[opentide] could not end the MCP session record: ${errorMessage(err)}`,
      );
    });
  };

  // Advertise the tool list plus the surface-version/fingerprint in the result
  // `_meta` (opentide/surface) — the standard, spec-loose channel for metadata
  // about the tool list, read in the same response as the tools it versions. The
  // server BUILD identity (name/version) stays at the handshake above; the tool
  // SURFACE version is distinct and lives here (F4, OpenTide §10).
  server.setRequestHandler(ListToolsRequestSchema, () => {
    const tools = projectedMcpTools(deps.kernel.composition);
    return {
      tools,
      _meta: { [MCP_SURFACE_META_KEY]: mcpSurfaceMeta(tools) },
    };
  });

  server.setRequestHandler(
    CallToolRequestSchema,
    async (request: CallToolRequest) => {
      const { name, arguments: args = {} } = request.params;
      const caller = callerFrom(server);
      // Fresh context per call: the gate pins context.changesetId to the active
      // changeset (dispatch.ts) as a side effect, so a reused object could leak
      // one changeset's id into a later call. A new object each time keeps the
      // only shared state the stable sessionId.
      const sessionId = startsSession(name, args)
        ? await sessionIdFor(caller)
        : await session ?? undefined;
      if (sessionId) deps.kernel.liveSessions.touch(sessionId);
      const context: ChangeContext = {
        ...(sessionId ? { sessionId } : {}),
        userMessage: caller.label,
        principalId: caller.principalId,
        ...turnContextFrom(request.params._meta),
      };
      const bytes = argBytes(args);
      const audit = (decision: McpCallInput["decision"], reason?: string) =>
        recordCall(deps, {
          principalId: caller.principalId,
          toolName: name,
          sessionId: context.sessionId ?? null,
          transport,
          decision,
          reason: reason ?? null,
          changesetId: context.changesetId ?? null,
          argBytes: bytes,
        });
      // Fails closed: an oversized call never reaches dispatch.
      if (bytes > MCP_MAX_ARG_BYTES) {
        await audit("deny", "args_too_large");
        return argsTooLarge(bytes);
      }
      try {
        const result = await dispatchMcpTool(
          name,
          args,
          deps.kernel,
          deps.rebuild,
          context,
          binding,
        );
        if (!result.isError) persistMutation(deps.kernel, name);
        return result;
      } finally {
        // After dispatch, so the record carries the changeset the gate pinned.
        await audit("allow");
      }
    },
  );

  // Prompts: named workflows a human starts (/opentide:start and friends).
  // Built from the same guide as the instructions; the assembly decides only
  // whether the cost rules appear.
  // The one resource: show_app's page (mcp-app-preview.ts).
  server.setRequestHandler(ListResourcesRequestSchema, () => ({
    resources: [appPreviewResourceListing()],
  }));
  server.setRequestHandler(
    ReadResourceRequestSchema,
    (request: ReadResourceRequest) => {
      if (!isAppPreviewUri(request.params.uri)) {
        throw new McpError(
          ErrorCode.InvalidParams,
          `Unknown resource: ${request.params.uri}`,
        );
      }
      return appPreviewResourceContents();
    },
  );

  server.setRequestHandler(ListPromptsRequestSchema, () => ({
    prompts: listMcpPrompts(),
  }));
  server.setRequestHandler(
    GetPromptRequestSchema,
    (request: GetPromptRequest) => {
      const prompt = getMcpPrompt(
        request.params.name,
        request.params.arguments ?? {},
        deps.kernel.composition,
      );
      if (!prompt) {
        throw new McpError(
          ErrorCode.InvalidParams,
          `Unknown prompt "${request.params.name}".`,
        );
      }
      return prompt;
    },
  );

  return server;
}

// A call the audit can't record still runs: losing an audit row is better than
// failing the agent's work over it. stdout is the JSON-RPC channel on stdio, so
// the complaint goes to stderr.
async function recordCall(
  deps: McpServerDeps,
  call: McpCallInput,
): Promise<void> {
  try {
    await deps.kernel.mcpAudit?.recordMcpCall(call);
  } catch (err) {
    console.error(
      `[opentide] could not audit MCP call ${call.toolName}: ` +
        errorMessage(err),
    );
  }
}

// Serve the outbound MCP server over stdio. Resolves when the transport closes
// (the client disconnects / stdin ends). Note: stdout is the JSON-RPC channel —
// callers MUST route all logging to stderr.
export async function serveMcpStdio(deps: McpServerDeps): Promise<void> {
  const server = createMcpServer(deps);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  await new Promise<void>((resolve) => {
    // Chained: connect() hung the Server's own close (and so server.onclose)
    // on this callback.
    const serverClose = transport.onclose;
    transport.onclose = () => {
      serverClose?.();
      resolve();
    };
  });
}

// Writes the project's state after a change lands. Serve has no turn end to
// save at; without this a client's work lived in memory until a clean exit.
// Unchanged files aren't rewritten, so a save costs the comparison.
function persistMutation(kernel: Kernel, toolName: string): void {
  if (!kernel.projectDir || !isMutationTool(toolName)) return;
  try {
    flushKernelProjectState(kernel);
  } catch (err) {
    kernel.log.log(
      "warn",
      "system",
      `Saving project state after ${toolName} failed: ${errorMessage(err)}`,
    );
  }
}
