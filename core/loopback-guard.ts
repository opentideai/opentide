// @layer core — the loopback Host/Origin check every local control surface
// shares: the control server's WebSocket and trusted-REST routes, and the MCP
// HTTP endpoint (mounted on serve or standalone). Pure, no server state.

// Hostnames accepted in the Host and Origin headers. The server binds to loopback, but these checks defend against
// DNS-rebinding (attacker domain shows up in Host) and malicious cross-origin
// pages opening sockets (foreign Origin shows up in Origin).
const WS_ALLOWED_HOSTNAMES = ["127.0.0.1", "localhost", "::1"];

function extractHostname(hostHeader: string): string {
  // Bracketed IPv6 form, e.g. "[::1]:3001" or "[::1]".
  if (hostHeader.startsWith("[")) {
    const end = hostHeader.indexOf("]");
    if (end !== -1) return hostHeader.slice(1, end);
    return hostHeader.slice(1);
  }
  // IPv4/hostname form: strip a single trailing ":port" if present.
  const colon = hostHeader.lastIndexOf(":");
  if (colon !== -1) return hostHeader.slice(0, colon);
  return hostHeader;
}

function isAllowedOriginHostname(hostname: string): boolean {
  return WS_ALLOWED_HOSTNAMES.includes(hostname) ||
    hostname.endsWith(".localhost");
}

/**
 * Decides whether a WebSocket upgrade (or any other loopback-only request) may
 * proceed, based only on its Host and Origin headers. Pure and exported so it
 * can be unit-tested without a running server.
 */
export function isAllowedWebSocketRequest(
  originHeader: string | null | undefined,
  hostHeader: string | null | undefined,
): boolean {
  // Host check: defeats DNS-rebinding (attacker's domain surfaces in Host).
  if (!hostHeader) return false;
  const hostHostname = extractHostname(hostHeader);
  if (!WS_ALLOWED_HOSTNAMES.includes(hostHostname)) return false;

  // Origin check: non-browser clients (CLI, tests) omit Origin and are allowed.
  if (!originHeader) return true;
  let originHostname: string;
  try {
    originHostname = new URL(originHeader).hostname;
  } catch {
    return false;
  }
  return isAllowedOriginHostname(originHostname);
}

// The same check over a raw Request, for handlers that never see a Hono Context.
export function isLoopbackRequest(req: Request): boolean {
  return isAllowedWebSocketRequest(
    req.headers.get("origin"),
    req.headers.get("host"),
  );
}
