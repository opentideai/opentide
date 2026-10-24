import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  type LegacyContext,
  type LegacyHandlerFn,
  wrapLegacyContextHandler,
} from "./handler-abi.ts";
import {
  CONTEXT_SHIM_PATH,
  generateContextShimRuntimeSource,
} from "./export-context-shim.ts";

// The exported app carries its own copy of the legacy-context shim, because the
// generated shell no longer imports Hono and so has no Context to hand a legacy
// handler. Two copies of ~250 lines is the cost of that, and these are the gates that
// stop them drifting:
//
//   1. TEXTUAL — the emitted text contains core/handler-abi.ts's shim half verbatim.
//      Exact, so drift is impossible rather than merely detectable, and it means the
//      whole shim-vs-Hono corpus in core/handler-abi_test.ts covers the copy too.
//   2. BEHAVIOURAL — the emitted file is imported and run. Textual identity says
//      nothing about whether the template literal's escaping survived the round trip;
//      this does.

const SHIM_MARKER = "// --- The legacy compatibility shim ---";

function inRepoShimSource(): string {
  const source = Deno.readTextFileSync(
    new URL("./handler-abi.ts", import.meta.url),
  );
  const start = source.indexOf(SHIM_MARKER);
  assert(start !== -1, `core/handler-abi.ts lost its "${SHIM_MARKER}" marker`);
  return source.slice(start + SHIM_MARKER.length).trim();
}

Deno.test("the emitted shim is core/handler-abi.ts's shim, verbatim", () => {
  const emitted = generateContextShimRuntimeSource();
  assertStringIncludes(emitted, inRepoShimSource());
  // And the constants that shim half reads, which live above the detector.
  assertStringIncludes(
    emitted,
    'const TEXT_PLAIN = "text/plain; charset=UTF-8";',
  );
  assertStringIncludes(
    emitted,
    'const TEXT_HTML = "text/html; charset=UTF-8";',
  );
  assertStringIncludes(emitted, 'const APPLICATION_JSON = "application/json";');
  assertStringIncludes(emitted, "const DEFAULT_REDIRECT_STATUS = 302;");
  // `Context` is the name legacy sources annotate with, so the shim answers to it.
  assertStringIncludes(emitted, "export type Context = LegacyContext;");
  // Nothing in the emitted tree may name the framework.
  assert(!emitted.includes('from "hono"'));
});

// --- Behavioural: import the emitted file and run it ---------------------------

interface ShimCase {
  name: string;
  path: string;
  params?: Record<string, string>;
  init?: RequestInit;
  run: (c: LegacyContext) => Response | Promise<Response>;
}

// A cross-section of the response shapes, chosen for what they would catch if the
// escaping broke: both spellings of the text/plain content-type (the fresh/not-fresh
// split), the `${...}` interpolation inside the guard's error message, params,
// deferred header and status state, and a body read.
const SHIM_CASES: ShimCase[] = [
  { name: "text, fresh", path: "/x", run: (c) => c.text("hi") },
  {
    name: "text after a header, not fresh",
    path: "/x",
    run: (c) => {
      c.header("X-A", "1");
      return c.text("hi");
    },
  },
  { name: "json with status", path: "/x", run: (c) => c.json({ a: 1 }, 201) },
  { name: "html", path: "/x", run: (c) => c.html("<p>h</p>") },
  { name: "redirect", path: "/x", run: (c) => c.redirect("/z", 301) },
  { name: "notFound", path: "/x", run: (c) => c.notFound() },
  {
    name: "deferred status then body",
    path: "/x",
    run: (c) => {
      c.status(418);
      return c.body("t");
    },
  },
  {
    name: "request accessors",
    path: "/n/7?q=1&q=2",
    params: { id: "7" },
    init: { headers: { "X-Test": "v" } },
    run: (c) =>
      c.json({
        param: c.req.param("id"),
        params: c.req.param(),
        query: c.req.query(),
        queries: c.req.queries("q"),
        header: c.req.header("x-test"),
        method: c.req.method,
        path: c.req.path,
      }),
  },
  {
    name: "request body read",
    path: "/x",
    init: {
      method: "POST",
      body: JSON.stringify({ title: "t" }),
      headers: { "content-type": "application/json" },
    },
    run: async (c) => c.json(await c.req.json()),
  },
];

async function describe(res: Response) {
  return {
    status: res.status,
    headers: [...res.headers.entries()].sort(),
    body: await res.text(),
  };
}

Deno.test("the emitted shim behaves like the kernel's when imported and run", async () => {
  const dir = Deno.makeTempDirSync({ prefix: "context-shim-" });
  try {
    // A type-only import is erased before module resolution, so importing the shim
    // never loads deps.ts — but write it anyway, because the emitted tree has one and
    // a reader of this test should see the same file layout the export produces.
    Deno.writeTextFileSync(
      join(dir, "deps.ts"),
      "export interface HandlerContext {\n" +
        "  readonly params: Readonly<Record<string, string>>;\n}\n",
    );
    Deno.writeTextFileSync(
      join(dir, CONTEXT_SHIM_PATH),
      generateContextShimRuntimeSource(),
    );

    const emitted = await import(
      pathToFileURL(join(dir, CONTEXT_SHIM_PATH)).href
    ) as {
      wrapLegacyContextHandler: typeof wrapLegacyContextHandler;
    };

    for (const testCase of SHIM_CASES) {
      const url = `http://app.test${testCase.path}`;
      const ctx = { params: testCase.params ?? {} };
      const fn = testCase.run as unknown as LegacyHandlerFn;

      const fromKernel = await describe(
        await wrapLegacyContextHandler(fn)(
          new Request(url, testCase.init),
          ctx,
        ),
      );
      const fromExport = await describe(
        await emitted.wrapLegacyContextHandler(fn)(
          new Request(url, testCase.init),
          ctx,
        ),
      );
      assertEquals(fromExport, fromKernel, `case: ${testCase.name}`);
    }

    // The guard, whose message is the one place the template literal has to carry a
    // `${...}` interpolation through escaping.
    const reaching = emitted.wrapLegacyContextHandler(
      ((c: Record<string, unknown>) => {
        const fn = c.parseBody as () => Response;
        return fn();
      }) as unknown as LegacyHandlerFn,
    );
    let message = "";
    try {
      await reaching(new Request("http://app.test/x"), { params: {} });
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    assertStringIncludes(message, "c.parseBody is not available");
    assertStringIncludes(message, "await c.req.formData()");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
