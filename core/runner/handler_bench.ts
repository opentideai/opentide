// Handler latency through the app server, with user code in the kernel's
// process, in a runner served in this process (the codec and the mirror, no
// pipe), and in a runner child: a handler that answers at once, and one that
// makes three queries. Every request is a real fetch to the preview port.
//
//   deno task bench:runner

import { rmSync } from "node:fs";
import { join } from "node:path";
import { createAppServer } from "../app-server.ts";
import { initCompiler } from "../compiler.ts";
import { APP_PORT_AUTO } from "../config.ts";
import { Database } from "../db.ts";
import { Kernel } from "../registries.ts";
import { dispatchTool } from "../tools/dispatch.ts";
import { projectRunnerStart } from "./project-runner.ts";
import type { RunnerStart } from "./runner-adapter.ts";
import { RunnerHost } from "./runner-host.ts";

const scratch = await Deno.makeTempDir({ prefix: "opentide-bench-" });
// Nothing waits on an unload listener, so the cleanup is synchronous. The
// child exits on its own once its stdin closes.
globalThis.addEventListener("unload", () => {
  rmSync(scratch, { recursive: true, force: true });
});

const MODES: { name: string; runner: RunnerStart | null }[] = [
  { name: "in-process", runner: null },
  { name: "runner in this process", runner: RunnerHost.inMemory },
  {
    name: "runner child",
    runner: projectRunnerStart(
      {
        scratchDir: join(scratch, "runner"),
        bundledScript: join(scratch, "runner-main.js"),
      },
      {
        env: () => ({}),
        settings: () => ({ ok: true, data: {} }),
        warn: () => {},
      },
    ),
  },
];

const HANDLERS = [
  {
    name: "zero",
    queries: 0,
    source: `function zero() { return new Response("ok"); }`,
  },
  {
    name: "three",
    queries: 3,
    source: `async function three() {
  for (let i = 0; i < 3; i++) {
    await db.execute("SELECT name FROM items WHERE id = $1", [1]);
  }
  return new Response("ok");
}`,
  },
];

await initCompiler();

async function benchApp(runner: RunnerStart | null): Promise<string> {
  const db = await Database.create({ driver: "pglite" });
  await db.execute("CREATE TABLE items (id int PRIMARY KEY, name text)");
  await db.execute("INSERT INTO items VALUES (1, 'one')");
  const kernel = new Kernel(db, { userCodeRunner: runner });
  for (const h of HANDLERS) {
    const defined = await dispatchTool(
      "define_handler",
      { name: h.name, source: h.source },
      kernel,
      () => {},
      { manualEdit: true },
    );
    if (!defined.ok) throw new Error(defined.error?.message);
    kernel.routes.register("GET", `/${h.name}`, h.name);
  }
  const server = createAppServer(kernel, APP_PORT_AUTO);
  server.rebuild();
  kernel.appPort = server.port;
  const origin = `http://127.0.0.1:${server.port}`;
  // A runner starts on first use: not inside a measured call.
  for (const h of HANDLERS) await get(`${origin}/${h.name}`);
  return origin;
}

async function get(url: string): Promise<void> {
  const res = await fetch(url);
  const body = await res.text();
  if (res.status !== 200) throw new Error(`${url}: ${res.status} ${body}`);
}

for (const mode of MODES) {
  const origin = await benchApp(mode.runner);
  for (const h of HANDLERS) {
    Deno.bench({
      name: `${h.queries} queries, ${mode.name}`,
      group: h.name,
      baseline: mode.runner === null,
      // Deno.bench awaits only an async function, not a returned promise.
      fn: async () => await get(`${origin}/${h.name}`),
    });
  }
}
