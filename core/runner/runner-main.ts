// Entry point of a project's runner process. The kernel spawns it with the
// flags from ./permissions.ts and talks to it over stdin/stdout.
//
// stdout is the RPC channel, so console output from anything loaded in here
// (user code, npm packages) is sent to stderr instead, where the kernel reads
// it as the runner's log.

import { createStreamTransport } from "./transport.ts";
import { serveRunner } from "./runner.ts";

function sendConsoleToStderr(): void {
  const toStderr = console.error.bind(console);
  console.log = toStderr;
  console.info = toStderr;
  console.debug = toStderr;
  console.warn = toStderr;
}

sendConsoleToStderr();
const transport = createStreamTransport(
  Deno.stdin.readable,
  Deno.stdout.writable,
);
const { peer } = await serveRunner(transport, {
  onShutdown: () => {
    void transport.close().finally(() => Deno.exit(0));
  },
  shimGlobalFetch: true,
});
await peer.done;
// stdin closed: the kernel is gone, so the runner goes too.
Deno.exit(0);
