import { assert, assertEquals } from "@std/assert";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { testComposition } from "../cli/test-composition.ts";
import { testStoreComposition } from "../verification/test-stores.ts";
import { writeExportFiles } from "./build.ts";
import { initCompiler, stopCompiler } from "./compiler.ts";
import { APP_AUTH_GATE_CONFIG } from "./config.ts";
import { Database } from "./db.ts";
import { exportProject } from "./export.ts";
import { Kernel } from "./registries.ts";
import {
  ENTITY_SCOPE_NAMES,
  platformReservedNames,
  TEST_SCOPE_NAMES,
} from "./reserved-names.ts";
import { dispatchTool } from "./tools/dispatch.ts";

/* Entity names against the names the platform binds.

   Two halves. The export's main.ts must not reserve anything: every entity binding in
   it is `$`-prefixed, so an entity named after any generator identifier still boots.
   0.26.0 of speed-read crashed at boot because a handler named authGate shadowed a
   createApp local of the same name; the first test names entities after exactly those
   locals. The entity's OWN scope does reserve names, and the define tools refuse them. */

const testOpts = { sanitizeResources: false, sanitizeOps: false };
const noop = () => {};

function url(path: string): string {
  return `http://localhost${path}`;
}

// Names main.ts declares itself, in createApp or at module scope, plus a name from the
// deps import and the router import. Before the `$` prefix each of these either
// crashed at boot (the createApp locals) or failed the export's type check.
const SHELL_NAMES = [
  "handlers",
  "routeTable",
  "initialized",
  "assetFiles",
  "createApp",
  "finalize",
  "startServer",
  "match",
  "existsSync",
];

function handlerSource(name: string): string {
  return `async function ${name}(req: Request): Promise<Response> {
  return Response.json({ via: ${
    JSON.stringify(name)
  }, n: await functions.call("createFetchApp") });
}`;
}

function populate(kernel: Kernel): void {
  for (const name of SHELL_NAMES) {
    kernel.handlers.register(name, handlerSource(name), () => new Response());
    kernel.routes.register("GET", `/${name}`, name);
  }
  // A legacy-ABI handler, which main.ts adapts into a second binding.
  kernel.handlers.register(
    "errorResponse",
    `function errorResponse(c: any) { return c.json({ via: "errorResponse" }); }`,
    () => new Response(),
  );
  kernel.routes.register("GET", "/errorResponse", "errorResponse");
  // A function with a shell name, and a handler and a function sharing one name.
  kernel.functions.register(
    "createFetchApp",
    `function createFetchApp(): number { return 7; }`,
    () => 7,
  );
  kernel.functions.register(
    "handlers",
    `function handlers(): number { return 8; }`,
    () => 8,
  );
  kernel.handlers.register(
    "authGate",
    `function authGate(req: Request): Response | null { return null; }`,
    () => null as unknown as Response,
  );
  kernel.configs.set(APP_AUTH_GATE_CONFIG, "authGate");
}

Deno.test({
  ...testOpts,
  name: "entities named after the shell's own identifiers export and boot",
  fn: async () => {
    const db = await Database.create({ driver: "pglite" });
    const dir = Deno.makeTempDirSync({ prefix: "export-names-" });
    const cwd = Deno.cwd();
    try {
      const kernel = new Kernel(db, { composition: testStoreComposition() });
      populate(kernel);
      const { files } = await exportProject(kernel, {
        projectName: "Names App",
        projectVersion: "1.0.0",
      });
      writeExportFiles(dir, files);

      // Every `$` identifier in main.ts is an entity binding. The generator never
      // writes one of its own, which is the whole guarantee.
      const main = files.find((f) => f.path === "main.ts")!.content as string;
      const dollar = new Set(main.match(/\$[A-Za-z_][\w$]*/g) ?? []);
      const expected = new Set([
        ...[...SHELL_NAMES, "errorResponse", "authGate"].map((n) => `$h_${n}`),
        "$legacy_errorResponse",
        "$f_createFetchApp",
        "$f_handlers",
      ]);
      assertEquals(
        [...dollar].sort(),
        [...expected].sort(),
        "main.ts declares a $-prefixed identifier that is not an entity binding",
      );

      Deno.chdir(dir);
      const mod = await import(pathToFileURL(join(dir, "main.ts")).href) as {
        createApp: () => Promise<{ fetch(req: Request): Promise<Response> }>;
      };
      const app = await mod.createApp();
      for (const name of SHELL_NAMES) {
        const res = await app.fetch(new Request(url(`/${name}`)));
        assertEquals(
          { status: res.status, body: await res.json() },
          { status: 200, body: { via: name, n: 7 } },
          `GET /${name}`,
        );
      }
      const legacy = await app.fetch(new Request(url("/errorResponse")));
      assertEquals(await legacy.json(), { via: "errorResponse" });
    } finally {
      Deno.chdir(cwd);
      await db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  },
});

Deno.test({
  ...testOpts,
  name: "an exported module imports only reserved names from deps.ts",
  fn: async () => {
    const db = await Database.create({ driver: "pglite" });
    try {
      const kernel = new Kernel(db, { composition: testStoreComposition() });
      kernel.handlers.register(
        "typed",
        `function typed(req: Request, ctx: HandlerContext): Response {
  assertNever(undefined as never);
  return new Response();
}`,
        () => new Response(),
      );
      kernel.routes.register("GET", "/typed", "typed");
      const { files } = await exportProject(kernel);
      const mod = files.find((f) => f.path.endsWith("/typed.ts"))!
        .content as string;
      const line = mod.split("\n").find((l) => l.includes('deps.ts"'))!;
      const imported = line.slice(line.indexOf("{") + 1, line.indexOf("}"))
        .split(",").map((s) => s.trim().replace(/^type\s+/, ""));
      const reserved = platformReservedNames("handler");
      for (const name of imported) {
        assert(reserved.includes(name), `${name} is imported but not reserved`);
      }
      for (const name of ENTITY_SCOPE_NAMES) {
        assert(imported.includes(name), `${name} is reserved but not imported`);
      }
    } finally {
      await db.close();
    }
  },
});

async function withKernel(fn: (kernel: Kernel) => Promise<void>) {
  await initCompiler();
  const db = await Database.create({ driver: "pglite" });
  const kernel = new Kernel(db, { composition: testComposition() });
  try {
    await fn(kernel);
  } finally {
    await db.close();
    stopCompiler();
  }
}

Deno.test({
  ...testOpts,
  name: "the define tools refuse reserved names and accept the rest",
  fn: async () => {
    await withKernel(async (kernel) => {
      const define = (tool: string, name: string, source: string) =>
        dispatchTool(tool, { name, source }, kernel, noop, {
          manualEdit: true,
        });

      for (const name of ["db", "HandlerContext", "delete"]) {
        const res = await define(
          "define_handler",
          name,
          `function ${name}(req: Request): Response { return new Response(); }`,
        );
        assertEquals(res.error?.code, "RESERVED_NAME", `handler ${name}`);
      }
      const fn = await define(
        "define_function",
        "env",
        "function env(): number { return 1; }",
      );
      assertEquals(fn.error?.code, "RESERVED_NAME");
      for (const name of TEST_SCOPE_NAMES) {
        const res = await define(
          "define_test",
          name,
          `async function ${name}() {}`,
        );
        assertEquals(res.error?.code, "RESERVED_NAME", `test ${name}`);
      }
      assertEquals(kernel.handlers.list().length, 0);

      // Fine since the export stopped binding entities under their bare names.
      const gate = await define(
        "define_handler",
        "authGate",
        "function authGate(req: Request): Response | null { return null; }",
      );
      assertEquals(gate.ok, true, gate.error?.message);
    });
  },
});

Deno.test({
  ...testOpts,
  name: "project_status lists reserved names and flags one already in use",
  fn: async () => {
    await withKernel(async (kernel) => {
      kernel.functions.register(
        "log",
        "function log() {}",
        () => undefined,
      );
      const res = await dispatchTool("project_status", {}, kernel, noop);
      assert(res.ok);
      const data = res.data as {
        reservedNames: { handlersAndFunctions: string[]; testsAlso: string[] };
        problems: string[];
      };
      assert(data.reservedNames.handlersAndFunctions.includes("db"));
      assert(data.reservedNames.testsAlso.includes("appUrl"));
      assert(
        data.problems.some((p) =>
          p.includes("Reserved name in use: function log")
        ),
        data.problems.join("\n"),
      );
    });
  },
});
