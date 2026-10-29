import { assertEquals } from "@std/assert";
import { createActivityMonitor, watchIdle } from "./idle-exit.ts";
import { startControlServer } from "./control-server.ts";

function clock(start = 1_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => void (t += ms) };
}

Deno.test("idle time counts from the last request to finish", () => {
  const c = clock();
  const monitor = createActivityMonitor(c.now);
  c.advance(500);
  assertEquals(monitor.idleFor(), 500);
  const end = monitor.begin();
  c.advance(10_000);
  assertEquals(monitor.idleFor(), 0);
  end();
  c.advance(300);
  assertEquals(monitor.idleFor(), 300);
});

Deno.test("one open request keeps the monitor busy while others finish", () => {
  const c = clock();
  const monitor = createActivityMonitor(c.now);
  const stream = monitor.begin();
  const poll = monitor.begin();
  poll();
  poll(); // a second end is a no-op, not a second decrement
  c.advance(60_000);
  assertEquals(monitor.idleFor(), 0);
  stream();
  assertEquals(monitor.idleFor(), 0);
  c.advance(1);
  assertEquals(monitor.idleFor(), 1);
});

Deno.test("watchIdle fires once, after the idle window", async () => {
  const c = clock();
  const monitor = createActivityMonitor(c.now);
  let fired = 0;
  const stop = watchIdle(monitor, {
    idleMs: 1_000,
    pollMs: 5,
    onIdle: () => fired++,
  });
  try {
    await new Promise((r) => setTimeout(r, 30));
    assertEquals(fired, 0);
    c.advance(1_000);
    await new Promise((r) => setTimeout(r, 30));
    assertEquals(fired, 1);
    c.advance(5_000);
    await new Promise((r) => setTimeout(r, 30));
    assertEquals(fired, 1);
  } finally {
    stop();
  }
});

// A connected MCP client is a standing SSE response. The server must count it
// as busy until the stream closes, not until the handler returns.
Deno.test("the control server counts a streaming response until it closes", async () => {
  const monitor = createActivityMonitor();
  let push = null as ReadableStreamDefaultController<Uint8Array> | null;
  const control = await startControlServer(null, 0, {
    activity: monitor,
    mountRoutes: [(app) => {
      app.get("/test/stream", () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              push = controller;
            },
          }),
        ));
    }],
  });
  try {
    const base = `http://127.0.0.1:${control.server.addr.port}`;
    const res = await fetch(`${base}/test/stream`);
    assertEquals(res.status, 200);
    await new Promise((r) => setTimeout(r, 20));
    assertEquals(monitor.idleFor(), 0);

    push!.close();
    await res.body?.cancel();
    await new Promise((r) => setTimeout(r, 20));
    assertEquals(monitor.idleFor() > 0, true);
  } finally {
    // Close the stream even when an assertion failed, or shutdown waits on it.
    try {
      push?.close();
    } catch { /* already closed */ }
    await control.setProject.close();
    await control.server.shutdown();
  }
});
