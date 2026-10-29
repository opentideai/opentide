// @layer composition — the agent process: the chat loop on a brain, served to
// the IDE. It reaches a project only through serve's public MCP endpoint, as
// any client does. tide/agent-main.ts runs it on the tuned brain.
import { parseArgs } from "node:util";
import { ChatOrchestrator } from "../agent-loop/chat.ts";
import { DefaultChatIntelligence } from "../agent-loop/default-brain.ts";
import { createAgentServer } from "../agent-loop/agent-server.ts";
import { serveAgentHost } from "../agent-loop/agent-host.ts";
import { forwardTo } from "../agent-loop/front-door.ts";
import { managedChatTelemetry } from "../agent-loop/chat-telemetry.ts";
import { RoutingModelProvider } from "../providers/model-provider-router.ts";
import { routingUtilityModelCall } from "../providers/utility-provider.ts";
import { installUtilityModelProvider } from "../core/utility-model.ts";
import type { ChatIntelligence } from "../core/chat-intelligence.ts";
import type { AuthProvider } from "../core/auth-provider.ts";
import type { Hono } from "hono";
import { TelemetryManager } from "../core/telemetry.ts";
import {
  AGENT_DEFAULT_PORT,
  CONTROL_SERVER_PORT,
  DEV_SERVER_HOST,
} from "../core/config.ts";

// The agent's own telemetry queue; serve keeps the other.
const AGENT_TELEMETRY_QUEUE = "telemetry-agent.jsonl";

export interface AgentArgs {
  // serve's control origin.
  server: URL;
  port: number;
  // The agent is the IDE's only origin and passes the rest on to serve.
  frontDoor: boolean;
}

export function getAgentArgs(argv: string[] = Deno.args): AgentArgs {
  const { values } = parseArgs({
    args: argv,
    options: {
      server: { type: "string" },
      port: { type: "string" },
      "front-door": { type: "boolean" },
    },
    allowPositionals: true,
  });
  const parsed = values.port ? Number(values.port) : AGENT_DEFAULT_PORT;
  return {
    server: new URL(
      values.server ?? `http://${DEV_SERVER_HOST}:${CONTROL_SERVER_PORT}`,
    ),
    port: Number.isInteger(parsed) && parsed > 0 ? parsed : AGENT_DEFAULT_PORT,
    frontDoor: values["front-door"] ?? false,
  };
}

// Who is signed in, and the login surface that goes with it. Absent, everyone
// is the local user, as on serve.
export interface AgentLogin {
  auth: AuthProvider;
  mountAuthRoutes?(app: Hono): void;
}

export async function serveAgent(
  argv: string[] = Deno.args,
  brain: () => ChatIntelligence = () => new DefaultChatIntelligence(),
  login?: AgentLogin,
): Promise<void> {
  const { server, port, frontDoor } = getAgentArgs(argv);
  // Session names, summaries and the brain's own calls run here, not on serve.
  installUtilityModelProvider(routingUtilityModelCall);

  const host = serveAgentHost({
    server,
    ...login,
    chat: (backend, mcp) =>
      new ChatOrchestrator(
        backend,
        mcp,
        brain(),
        new RoutingModelProvider(),
      ),
  });
  let agent: ReturnType<typeof createAgentServer> | null = null;
  const telemetry = new TelemetryManager({
    getProjectPath: () => agent?.currentProject() ?? null,
    queueFile: AGENT_TELEMETRY_QUEUE,
  });
  agent = createAgentServer(host, {
    telemetry: managedChatTelemetry(
      telemetry,
      (message) => console.warn(`Telemetry sync failed: ${message}`),
    ),
    log: (level, message) => console.log(`  [${level}] ${message}`),
    forward: frontDoor ? forwardTo(server) : undefined,
  });
  const listener = Deno.serve(
    { hostname: DEV_SERVER_HOST, port, onListen: () => {} },
    agent.app.fetch,
  );
  console.log(`Agent listening on :${port}, serve at ${server.origin}`);

  let stopping = false;
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    await agent?.close();
    await listener.shutdown();
    Deno.exit(0);
  };
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP", "SIGQUIT"] as const) {
    Deno.addSignalListener(signal, shutdown);
  }
}

if (import.meta.main) await serveAgent();
