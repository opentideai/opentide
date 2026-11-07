// The runner's side of the connection: the methods it answers. Runs inside the
// sandboxed child (./runner-main.ts) or, over the memory transport, in the
// kernel's own process.

import {
  RUNNER_METHODS,
  RUNNER_NOTIFICATIONS,
  RUNNER_PROTOCOL_VERSION,
  type RunnerReady,
} from "./protocol.ts";
import { type RequestHandler, RpcPeer } from "./peer.ts";
import { appFetchShim, rpcAppForward } from "./app-fetch.ts";
import { callHandlers, forwardingLog, type LogSink } from "./runner-calls.ts";
import { rpcDbExec } from "./runner-db.ts";
import { RunnerState, stateHandlers } from "./runner-state.ts";
import type { RunnerTransport } from "./transport.ts";

export interface ServeRunnerOptions {
  // Called once the kernel asks it to stop, after the answer is sent.
  onShutdown: () => void;
  // Replace this process's global fetch so user code reaches its own app
  // through the kernel. Only in the runner's own process: in-memory, the
  // process is the kernel's.
  shimGlobalFetch?: boolean;
}

export interface ServedRunner {
  peer: RpcPeer;
  state: RunnerState;
}

export async function serveRunner(
  transport: RunnerTransport,
  options: ServeRunnerOptions,
): Promise<ServedRunner> {
  const handlers: Record<string, RequestHandler> = {
    [RUNNER_METHODS.ping]: () => ({
      ok: true,
      data: { protocolVersion: RUNNER_PROTOCOL_VERSION },
    }),
    [RUNNER_METHODS.shutdown]: () => {
      // A macrotask, so the answer is written before the channel closes.
      setTimeout(options.onShutdown, 0);
      return { ok: true, data: null };
    },
  };
  const peer = new RpcPeer(transport, { handlers });
  // The state's db and log go back over this same peer, so it's made after
  // the peer, and its methods are added before any message has been read.
  const sink: LogSink = (line) => {
    void peer.notify(RUNNER_NOTIFICATIONS.log, line);
  };
  const state = new RunnerState(
    rpcDbExec(peer),
    forwardingLog(sink),
  );
  Object.assign(handlers, stateHandlers(state), callHandlers(state, sink));
  if (options.shimGlobalFetch) {
    globalThis.fetch = appFetchShim(
      globalThis.fetch.bind(globalThis),
      () => state.appOrigin,
      rpcAppForward(peer),
    );
  }
  const ready: RunnerReady = {
    protocolVersion: RUNNER_PROTOCOL_VERSION,
    pid: Deno.pid,
    denoVersion: Deno.version.deno,
  };
  await peer.notify(RUNNER_NOTIFICATIONS.ready, ready);
  return { peer, state };
}
