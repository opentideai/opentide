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
import { rpcDbExec } from "./runner-db.ts";
import { RunnerState, stateHandlers } from "./runner-state.ts";
import type { RunnerTransport } from "./transport.ts";
import type { CompileLog } from "../types.ts";

export interface ServeRunnerOptions {
  // Called once the kernel asks it to stop, after the answer is sent.
  onShutdown: () => void;
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
  // The state's db calls back over this same peer, so it's made after the
  // peer, and its methods are added before any message has been read.
  const state = new RunnerState(rpcDbExec(peer), stderrLog());
  Object.assign(handlers, stateHandlers(state));
  const ready: RunnerReady = {
    protocolVersion: RUNNER_PROTOCOL_VERSION,
    pid: Deno.pid,
    denoVersion: Deno.version.deno,
  };
  await peer.notify(RUNNER_NOTIFICATIONS.ready, ready);
  return { peer, state };
}

// User code's log() goes to stderr, which the kernel keeps as the runner's
// log tail, until the handler-call slice forwards it into the kernel's log.
function stderrLog(): CompileLog {
  const line = (level: string) => (...args: unknown[]) =>
    console.error(`[${level}]`, ...args);
  return Object.assign(line("info"), {
    debug: line("debug"),
    info: line("info"),
    warn: line("warn"),
    error: line("error"),
  });
}
