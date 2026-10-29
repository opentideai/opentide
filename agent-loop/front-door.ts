// @layer agent-loop — the agent as the IDE's one origin. Where nothing sits in
// front of the two processes (the desktop app), the IDE talks only to the
// agent, and whatever the agent doesn't serve goes on to serve unchanged: its
// REST API, the built IDE, and its /terminal and /debug sockets. In dev, Vite's
// proxy does this job and the agent never sees those requests.

export type Forward = (req: Request) => Promise<Response> | Response;

// Forwards `req` to the same path on `upstream`.
export function forwardTo(upstream: URL): Forward {
  return (req) => {
    const target = upstreamUrl(req, upstream);
    return isWebSocketUpgrade(req)
      ? relaySocket(req, target)
      : forwardHttp(req, target, upstream);
  };
}

function upstreamUrl(req: Request, upstream: URL): URL {
  const url = new URL(req.url);
  return new URL(`${url.pathname}${url.search}`, upstream);
}

function isWebSocketUpgrade(req: Request): boolean {
  return req.headers.get("upgrade")?.toLowerCase() === "websocket";
}

async function forwardHttp(
  req: Request,
  target: URL,
  upstream: URL,
): Promise<Response> {
  const headers = new Headers(req.headers);
  headers.set("host", upstream.host);
  if (headers.has("origin")) headers.set("origin", upstream.origin);
  // fetch would decode a compressed body and keep the header that says it
  // isn't; ask for it plain.
  headers.set("accept-encoding", "identity");
  const hasBody = req.method !== "GET" && req.method !== "HEAD";
  try {
    return await fetch(target, {
      method: req.method,
      headers,
      body: hasBody ? req.body : undefined,
      redirect: "manual",
    });
  } catch {
    return Response.json({ error: "serve is not reachable" }, { status: 502 });
  }
}

type SocketData = string | ArrayBufferLike | Blob | ArrayBufferView;

// The browser's socket and one to serve, each passing on what the other says.
// What the browser sends before serve's end opens is held, then sent in order.
function relaySocket(req: Request, target: URL): Response {
  const protocol = req.headers.get("sec-websocket-protocol") ?? undefined;
  const { socket: client, response } = Deno.upgradeWebSocket(req, {
    protocol: protocol?.split(",")[0]?.trim(),
  });
  target.protocol = target.protocol === "https:" ? "wss:" : "ws:";
  const server = new WebSocket(
    target,
    protocol?.split(",").map((p) => p.trim()),
  );
  const held: SocketData[] = [];

  server.onopen = () => {
    for (const data of held.splice(0)) server.send(data);
  };
  client.onmessage = (evt) => {
    if (server.readyState === WebSocket.OPEN) server.send(evt.data);
    else held.push(evt.data);
  };
  server.onmessage = (evt) => {
    if (client.readyState === WebSocket.OPEN) client.send(evt.data);
  };
  client.onclose = (evt) => closeQuietly(server, evt.code, evt.reason);
  server.onclose = (evt) => closeQuietly(client, evt.code, evt.reason);
  client.onerror = () => closeQuietly(server);
  server.onerror = () => closeQuietly(client, 1011, "serve is not reachable");
  return response;
}

// 1005 and 1006 are reported, never sent.
function closeQuietly(socket: WebSocket, code?: number, reason?: string): void {
  if (
    socket.readyState === WebSocket.CLOSING ||
    socket.readyState === WebSocket.CLOSED
  ) {
    return;
  }
  const sendable = code !== undefined && code !== 1005 && code !== 1006;
  if (sendable) socket.close(code, reason);
  else socket.close();
}
