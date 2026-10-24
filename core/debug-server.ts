import {
  compileFunction,
  compileHandler,
  initCompiler,
  stopCompiler,
} from "./compiler.ts";
import { Kernel } from "./registries.ts";
import { Database } from "./db.ts";
import { type AppServer, createAppServer } from "./app-server.ts";
import type { CompileDeps } from "./types.ts";

const encoder = new TextEncoder();

function emit(msg: unknown): void {
  Deno.stdout.writeSync(encoder.encode(JSON.stringify(msg) + "\n"));
}

async function* readLines(
  stream: ReadableStream<Uint8Array>,
): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of stream) {
    buffer += decoder.decode(chunk, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop()!;
    for (const line of lines) {
      if (line.trim()) yield line;
    }
  }
  if (buffer.trim()) yield buffer;
}

interface InitData {
  appPort: number;
  db: { driver: "pglite"; dataDir: string } | {
    driver: "postgres";
    connectionString: string;
  };
  handlers: Array<{ name: string; source: string }>;
  functions: Array<{ name: string; source: string }>;
  routes: Array<{ method: string; path: string; handlerName: string }>;
  configs: Array<
    {
      name: string;
      value: unknown;
      description?: string;
      updatedAt: string;
      module?: string;
    }
  >;
  templates: Array<{ name: string; content: string }>;
  assets: Array<
    {
      name: string;
      contentBase64: string;
      mimeType: string;
      registeredAt: string;
      module?: string;
    }
  >;
  env: Record<string, string>;
}

const lines = readLines(Deno.stdin.readable);

const initResult = await lines.next();
if (initResult.done) {
  console.error("debug-server: no init message");
  Deno.exit(1);
}

const init: InitData = JSON.parse(initResult.value);

await initCompiler();

const db = await Database.create(init.db);
const kernel = new Kernel(db);

for (const c of init.configs) {
  kernel.configs.set(c.name, c.value, c.description, c.module);
}
for (const t of init.templates) kernel.templates.register(t.name, t.content);
kernel.assets.restore(init.assets ?? []);

const deps = await kernel.compileDeps();
deps.env = init.env;

for (const f of init.functions) {
  const result = await compileFunction(f.name, f.source, deps);
  if (result.ok) kernel.functions.register(f.name, f.source, result.data);
  else {console.error(
      `debug-server: compile function ${f.name} failed:`,
      result.error.message,
    );}
}

for (const h of init.handlers) {
  const result = await compileHandler(h.name, h.source, deps);
  if (result.ok) kernel.handlers.register(h.name, h.source, result.data);
  else {console.error(
      `debug-server: compile handler ${h.name} failed:`,
      result.error.message,
    );}
}

for (const r of init.routes) {
  kernel.routes.register(r.method, r.path, r.handlerName);
}

const appServer = createAppServer(kernel, init.appPort);
appServer.rebuild();

emit({ type: "ready" });
console.error(`debug-server: listening on :${init.appPort}`);

for await (const line of lines) {
  try {
    await handleCommand(JSON.parse(line), kernel, appServer, deps);
  } catch (err) {
    console.error("debug-server: command error:", err);
  }
}

async function handleCommand(
  msg: { type: string; [k: string]: unknown },
  kernel: Kernel,
  appServer: AppServer,
  deps: CompileDeps,
) {
  switch (msg.type) {
    case "update-handler": {
      const result = await compileHandler(
        msg.name as string,
        msg.source as string,
        deps,
      );
      if (result.ok) {
        kernel.handlers.register(
          msg.name as string,
          msg.source as string,
          result.data,
        );
        appServer.rebuild();
      }
      emit({
        type: "ack",
        command: "update-handler",
        name: msg.name,
        ok: result.ok,
      });
      break;
    }
    case "update-function": {
      const result = await compileFunction(
        msg.name as string,
        msg.source as string,
        deps,
      );
      if (result.ok) {
        kernel.functions.register(
          msg.name as string,
          msg.source as string,
          result.data,
        );
      }
      emit({
        type: "ack",
        command: "update-function",
        name: msg.name,
        ok: result.ok,
      });
      break;
    }
    case "update-config":
      kernel.configs.set(msg.name as string, msg.value);
      break;
    case "update-template":
      kernel.templates.register(msg.name as string, msg.content as string);
      break;
    case "update-route":
      kernel.routes.register(
        msg.method as string,
        msg.path as string,
        msg.handlerName as string,
      );
      appServer.rebuild();
      break;
    case "remove-handler":
      kernel.handlers.remove(msg.name as string);
      appServer.rebuild();
      break;
    case "remove-route":
      kernel.routes.unregister(msg.method as string, msg.path as string);
      appServer.rebuild();
      break;
    case "shutdown":
      await appServer.shutdown();
      db.close();
      stopCompiler();
      Deno.exit(0);
      break;
    default:
      console.error(`debug-server: unknown command type "${msg.type}"`);
  }
}
