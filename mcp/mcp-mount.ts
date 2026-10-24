// @layer mcp — the outbound MCP server mounted at /mcp on `opentide serve`.
//
// One process per project: the IDE talks to the control API, agents talk MCP,
// and both reach the same kernel. Same handler as standalone `--http`
// (mcp-http.ts), same guards, same session-per-client model. Mounted by the open
// stack's composition, so Tide inherits it.
import type { RouteMounter } from "../core/route-mount.ts";
import { MCP_HTTP_PATH } from "../core/config.ts";
import {
  createMcpHttpHandler,
  jsonRpcError,
  rejectBadToken,
  rejectForeignRequest,
} from "./mcp-http.ts";

export const mountMcpRoutes: RouteMounter = (app, core) => {
  const handler = createMcpHttpHandler(() => ({
    kernel: core.kernel(),
    rebuild: core.rebuild,
  }));
  // Every session captured the kernel it opened against. A switched-away project
  // is about to be unloaded, so those sessions end here and clients reconnect.
  core.onProjectClose(() => handler.closeAll());

  app.all(MCP_HTTP_PATH, (c) => {
    const req = c.req.raw;
    const forbidden = rejectForeignRequest(req);
    if (forbidden) return forbidden;
    const token = core.serverToken();
    if (!token) {
      return jsonRpcError(
        503,
        "No project is open on this server. Open one, then reconnect.",
        "NO_PROJECT",
      );
    }
    return rejectBadToken(req, token) ?? handler.handle(req);
  });
};
