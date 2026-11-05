import { assert, assertEquals } from "@std/assert";
import { RpcPeer } from "./peer.ts";
import { RUNNER_ERROR_CODES } from "./protocol.ts";
import { createMemoryTransportPair } from "./transport.ts";
import type { Result } from "../types.ts";

const TIMEOUT_MS = 1_000;

function connectedPeers(
  aHandlers: Record<string, (p: unknown) => Result<unknown>> = {},
  bHandlers: Record<string, (p: unknown) => Result<unknown>> = {},
  onNotification?: (method: string, params: unknown) => void,
) {
  const [a, b] = createMemoryTransportPair();
  return {
    kernel: new RpcPeer(a, { handlers: aHandlers }),
    runner: new RpcPeer(b, { handlers: bHandlers, onNotification }),
  };
}

Deno.test("requests go both ways and Dates survive", async () => {
  const { kernel, runner } = connectedPeers(
    { "db.exec": (p) => ({ ok: true, data: { echoed: p } }) },
    { "runner.add": (p) => ({ ok: true, data: (p as number[])[0]! + 1 }) },
  );
  assertEquals(await kernel.request("runner.add", [41], TIMEOUT_MS), {
    ok: true,
    data: 42,
  });
  const at = new Date("2026-01-01T00:00:00Z");
  assertEquals(await runner.request("db.exec", at, TIMEOUT_MS), {
    ok: true,
    data: { echoed: at },
  });
  await kernel.close();
  await runner.done;
});

Deno.test("an unknown method and a throwing handler come back as errors", async () => {
  const { kernel, runner } = connectedPeers({}, {
    "runner.boom": () => {
      throw new Error("kaput");
    },
  });
  const unknown = await kernel.request("runner.nope", null, TIMEOUT_MS);
  assert(!unknown.ok);
  assertEquals(unknown.error.code, RUNNER_ERROR_CODES.unknownMethod);
  const boom = await kernel.request("runner.boom", null, TIMEOUT_MS);
  assert(!boom.ok);
  assertEquals(boom.error.code, RUNNER_ERROR_CODES.handlerFailed);
  assert(boom.error.message.includes("kaput"));
  await kernel.close();
  await runner.done;
});

Deno.test("a request nobody answers times out", async () => {
  const [a, b] = createMemoryTransportPair();
  const kernel = new RpcPeer(a);
  // The other end reads nothing back: drain it without answering.
  const silent = (async () => {
    for await (const _ of b.incoming()) { /* swallow */ }
  })();
  const result = await kernel.request("runner.ping", null, 20);
  assert(!result.ok);
  assertEquals(result.error.code, RUNNER_ERROR_CODES.timeout);
  await kernel.close();
  await silent;
});

Deno.test("closing fails pending calls, and later calls fail at once", async () => {
  const [a, b] = createMemoryTransportPair();
  const kernel = new RpcPeer(a);
  const silent = (async () => {
    for await (const _ of b.incoming()) { /* swallow */ }
  })();
  const pending = kernel.request("runner.ping", null, TIMEOUT_MS);
  await b.close();
  const result = await pending;
  assert(!result.ok);
  assertEquals(result.error.code, RUNNER_ERROR_CODES.closed);
  const later = await kernel.request("runner.ping", null, TIMEOUT_MS);
  assert(!later.ok);
  assertEquals(later.error.code, RUNNER_ERROR_CODES.closed);
  await silent;
});

Deno.test("params that can't cross are refused before sending", async () => {
  const { kernel, runner } = connectedPeers();
  const result = await kernel.request("runner.x", { f: () => 1 }, TIMEOUT_MS);
  assert(!result.ok);
  assertEquals(result.error.code, RUNNER_ERROR_CODES.unserializable);
  await kernel.close();
  await runner.done;
});

Deno.test("notifications reach the other side decoded", async () => {
  const seen: unknown[] = [];
  const { kernel, runner } = connectedPeers(
    {},
    {},
    (method, params) => seen.push([method, params]),
  );
  await kernel.notify("runner.log", { n: 5n });
  await kernel.close();
  await runner.done;
  assertEquals(seen, [["runner.log", { n: 5n }]]);
});
