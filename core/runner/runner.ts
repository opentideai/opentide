// The runner's side of the connection: the methods it answers. Runs inside the
// sandboxed child (./runner-main.ts) or, over the memory transport, in the
// kernel's own process.

import {
  RUNNER_METHODS,
  RUNNER_NOTIFICATIONS,
  RUNNER_PROTOCOL_VERSION,
  type RunnerReady,
} from "./protocol.ts";
import { RpcPeer } from "./peer.ts";
import type { RunnerTransport } from "./transport.ts";

export interface ServeRunnerOptions {
  // Called once the kernel asks it to stop, after the answer is sent.
  onShutdown: () => void;
}

export async function serveRunner(
  transport: RunnerTransport,
  options: ServeRunnerOptions,
): Promise<RpcPeer> {
  const peer = new RpcPeer(transport, {
    handlers: {
      [RUNNER_METHODS.ping]: () => ({
        ok: true,
        data: { protocolVersion: RUNNER_PROTOCOL_VERSION },
      }),
      [RUNNER_METHODS.shutdown]: () => {
        // A macrotask, so the answer is written before the channel closes.
        setTimeout(options.onShutdown, 0);
        return { ok: true, data: null };
      },
    },
  });
  const ready: RunnerReady = {
    protocolVersion: RUNNER_PROTOCOL_VERSION,
    pid: Deno.pid,
    denoVersion: Deno.version.deno,
  };
  await peer.notify(RUNNER_NOTIFICATIONS.ready, ready);
  return peer;
}
