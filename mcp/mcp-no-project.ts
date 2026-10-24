// @layer mcp — the server `opentide mcp` runs when its directory isn't a project.
//
// A client that starts the server in whatever directory it was opened in (the
// Claude Code plugin, installed per user) would otherwise show a failed server in
// every other directory. This one connects, lists no tools and no prompts, and
// tells the agent where it is in a few lines, so it costs next to nothing in
// context and reads as what it is.
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListPromptsRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { MCP_SERVER_NAME, MCP_SERVER_VERSION } from "../core/config.ts";

export function noProjectInstructions(dir: string): string {
  return `\
OpenTide is connected, but ${dir} is not an OpenTide project (no opentide.json), \
so it offers no tools here. Ignore it unless the user asks about OpenTide.

If they want an OpenTide app here, they run \`opentide scaffold <dir> <name>\`, \
then restart this client from the new project directory, or point its project \
folder setting at it.`;
}

export function createNoProjectServer(dir: string): Server {
  const server = new Server(
    { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION },
    {
      capabilities: { tools: {}, prompts: {} },
      instructions: noProjectInstructions(dir),
    },
  );
  server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: [] }));
  server.setRequestHandler(ListPromptsRequestSchema, () => ({ prompts: [] }));
  return server;
}

// Serve it over stdio until the client disconnects.
export async function serveNoProjectStdio(dir: string): Promise<void> {
  const server = createNoProjectServer(dir);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  await new Promise<void>((resolve) => {
    const serverClose = transport.onclose;
    transport.onclose = () => {
      serverClose?.();
      resolve();
    };
  });
}
