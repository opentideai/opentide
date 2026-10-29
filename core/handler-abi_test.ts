import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { Hono } from "hono";
import {
  detectHandlerAbi,
  type HandlerAbi,
  type LegacyContext,
  type LegacyHandlerFn,
  wrapLegacyContextHandler,
} from "./handler-abi.ts";

// --- Detection ---

Deno.test("detectHandlerAbi: rule 1 — an explicit Request annotation", () => {
  assertEquals(
    detectHandlerAbi(
      "async function h(req: Request) { return new Response(); }",
      "h",
    ),
    "fetch",
  );
});

Deno.test("detectHandlerAbi: rule 2 — a second parameter", () => {
  assertEquals(
    detectHandlerAbi(
      "async function h(r, ctx) { return Response.json(ctx.params); }",
      "h",
    ),
    "fetch",
  );
});

Deno.test("detectHandlerAbi: rule 3 — `.req.` is legacy and nothing else has it", () => {
  assertEquals(
    detectHandlerAbi(
      `async function listTodos(c: any) {
         const id = c.req.param("id");
         return c.json({ id });
       }`,
      "listTodos",
    ),
    "legacy-context",
  );
});

// The three cases the rule order exists to get right. Each would have been
// misclassified by a body heuristic that treated `.json(`/`.text(` as legacy
// markers, and the failure is silent: the shim's `json()` builds a Response, so
// `await req.json()` would have returned a Response instead of the parsed body.
Deno.test("detectHandlerAbi: rule 4 — `await req.json()` is a Request read, not a context response", () => {
  assertEquals(
    detectHandlerAbi(
      `async function createTodo(req) {
         const { title } = await req.json();
         return Response.json({ title }, { status: 201 });
       }`,
      "createTodo",
    ),
    "fetch",
  );
});

Deno.test("detectHandlerAbi: rule 4 — `await req.text()` under an `any` annotation", () => {
  assertEquals(
    detectHandlerAbi(
      `async function echo(req: any) {
         const body = await req.text();
         return new Response(body);
       }`,
      "echo",
    ),
    "fetch",
  );
});

Deno.test("detectHandlerAbi: rule 6 — an unawaited c.json() is a context response", () => {
  assertEquals(
    detectHandlerAbi(
      `async function ping(c: any) { return c.json({ ok: true }); }`,
      "ping",
    ),
    "legacy-context",
  );
});

Deno.test("detectHandlerAbi: rule 4 beats rule 6 — Request-only members win", () => {
  for (
    const src of [
      "async function h(r) { const f = await r.formData(); return new Response(String(f)); }",
      "async function h(r) { return new Response(r.headers.get('x')); }",
      "async function h(r) { const b = await r.arrayBuffer(); return new Response(b); }",
      "async function h(r) { return new Response(null, { status: r.bodyUsed ? 1 : 2 }); }",
    ]
  ) {
    assertEquals(detectHandlerAbi(src, "h"), "fetch", src);
  }
});

Deno.test("detectHandlerAbi: rule 5 — context members with no Request equivalent", () => {
  const cases: Array<[string, string]> = [
    ["html", "async function h(c) { return c.html('<p>x</p>'); }"],
    ["redirect", "async function h(c) { return c.redirect('/z'); }"],
    ["notFound", "async function h(c) { return c.notFound(); }"],
    ["param", "async function h(c) { return new Response(c.param('id')); }"],
  ];
  for (const [member, src] of cases) {
    assertEquals(detectHandlerAbi(src, "h"), "legacy-context", member);
  }
});

Deno.test("detectHandlerAbi: rule 7 — annotations decide only when the body is silent", () => {
  assertEquals(
    detectHandlerAbi(
      "async function h(c: Context) { return new Response('ok'); }",
      "h",
    ),
    "legacy-context",
  );
  assertEquals(
    detectHandlerAbi(
      "async function h(c: any) { return new Response('ok'); }",
      "h",
    ),
    "legacy-context",
  );
  // `(req: any)` is what the agent will plausibly emit once it is taught the new
  // ABI, given it emitted `(c: any)` in 175 of 175 handlers under the old one.
  assertEquals(
    detectHandlerAbi(
      "async function h(req: any) { return new Response('ok'); }",
      "h",
    ),
    "fetch",
  );
});

Deno.test("detectHandlerAbi: rule 8 — no evidence means the unwrapped shape", () => {
  assertEquals(
    detectHandlerAbi("async function h() { return new Response('ok'); }", "h"),
    "fetch",
  );
  assertEquals(
    detectHandlerAbi("async function h(x) { return new Response('ok'); }", "h"),
    "fetch",
  );
});

Deno.test("detectHandlerAbi: member probes do not match mid-identifier", () => {
  // `doc.json` must not read as `c.json`, and a SQL alias `c` inside a string is
  // not context access. Both showed up in the field scan as false positives.
  assertEquals(
    detectHandlerAbi(
      `async function search(c) {
         const rows = await db.query("SELECT c.id FROM docs c WHERE c.source_kind <> 'x'");
         const doc = rows[0];
         return new Response(doc.json);
       }`,
      "search",
    ),
    "fetch",
  );
});

Deno.test("detectHandlerAbi: arrow and function-expression definitions", () => {
  assertEquals(
    detectHandlerAbi("const h = async (c: any) => c.json({ ok: 1 });", "h"),
    "legacy-context",
  );
  assertEquals(
    detectHandlerAbi("const h = async (req: Request) => new Response();", "h"),
    "fetch",
  );
  assertEquals(
    detectHandlerAbi(
      "const h = async function (c) { return c.text('x'); };",
      "h",
    ),
    "legacy-context",
  );
  assertEquals(
    detectHandlerAbi("const h = (c) => c.json({});", "h"),
    "legacy-context",
  );
});

Deno.test("detectHandlerAbi: an undefinable source falls back to the new ABI", () => {
  assertEquals(detectHandlerAbi("// nothing here", "h"), "fetch");
});

// --- Shim parity with the framework it replaces ---
//
// The legacy handlers still in the field were written against a real Hono
// Context, so "what the shim must do" is not a spec question — it is whatever
// Hono actually did. Every scenario runs both ways and the responses must match
// byte for byte, down to the two different spellings of the text/plain
// content-type that Hono emits depending on whether the context is still fresh.

interface ParityCase {
  name: string;
  path: string;
  params?: Record<string, string>;
  init?: RequestInit;
  run: (c: LegacyContext) => Response | Promise<Response>;
}

const PARITY_CASES: ParityCase[] = [
  { name: "json", path: "/x", run: (c) => c.json({ a: 1 }) },
  { name: "json with status", path: "/x", run: (c) => c.json({ a: 1 }, 201) },
  { name: "json of an array", path: "/x", run: (c) => c.json([1, 2]) },
  { name: "text", path: "/x", run: (c) => c.text("hi") },
  { name: "text with status", path: "/x", run: (c) => c.text("hi", 201) },
  { name: "html", path: "/x", run: (c) => c.html("<p>h</p>") },
  { name: "redirect", path: "/x", run: (c) => c.redirect("/z") },
  {
    name: "redirect with status",
    path: "/x",
    run: (c) => c.redirect("/z", 301),
  },
  { name: "body", path: "/x", run: (c) => c.body("raw") },
  { name: "body null 204", path: "/x", run: (c) => c.body(null, 204) },
  {
    name: "body with status and headers",
    path: "/x",
    run: (c) => c.body("t", 202, { "X-C": "3" }),
  },
  {
    name: "deferred header then json",
    path: "/x",
    run: (c) => {
      c.header("X-A", "1");
      c.header("X-B", "2");
      return c.json({ ok: true });
    },
  },
  {
    // The fresh/not-fresh split: once a header is set, Hono stops handing the
    // string to the Response constructor and text/plain gains a space.
    name: "deferred header then text",
    path: "/x",
    run: (c) => {
      c.header("X-A", "1");
      return c.text("t");
    },
  },
  {
    name: "deferred header then body",
    path: "/x",
    run: (c) => {
      c.header("X-A", "1");
      return c.body("t");
    },
  },
  {
    name: "deferred header then html",
    path: "/x",
    run: (c) => {
      c.header("X-A", "1");
      return c.html("<p>h</p>");
    },
  },
  {
    name: "deferred header then redirect",
    path: "/x",
    run: (c) => {
      c.header("X-A", "1");
      return c.redirect("/z");
    },
  },
  {
    name: "deferred status",
    path: "/x",
    run: (c) => {
      c.status(418);
      return c.body("t");
    },
  },
  {
    name: "explicit status beats deferred status",
    path: "/x",
    run: (c) => {
      c.status(418);
      return c.json({ a: 1 }, 201);
    },
  },
  {
    name: "header overwrite",
    path: "/x",
    run: (c) => {
      c.header("X-A", "1");
      c.header("X-A", "2");
      return c.text("t");
    },
  },
  {
    name: "header undefined removes",
    path: "/x",
    run: (c) => {
      c.header("X-A", undefined);
      return c.text("t");
    },
  },
  {
    // The real field pattern: the markdown-download handlers set a content-type
    // and then hand bytes to c.body(). c.body() must not overwrite it.
    name: "content-type override then body",
    path: "/x",
    run: (c) => {
      c.header("Content-Type", "text/markdown; charset=utf-8");
      return c.body("md");
    },
  },
  {
    name: "request accessors",
    path: "/n/7?q=1&q=2",
    params: { id: "7" },
    init: { headers: { "X-Test": "v" } },
    run: (c) =>
      c.json({
        params: c.req.param(),
        param: c.req.param("id"),
        missingParam: c.req.param("nope") ?? null,
        query: c.req.query(),
        queryOne: c.req.query("q"),
        missingQuery: c.req.query("nope") ?? null,
        queries: c.req.queries("q"),
        missingQueries: c.req.queries("nope") ?? null,
        header: c.req.header("x-test"),
        missingHeader: c.req.header("nope") ?? null,
        method: c.req.method,
        url: c.req.url,
        path: c.req.path,
        valid: c.req.valid("json") ?? null,
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
  {
    name: "context store",
    path: "/x",
    run: (c) => {
      c.set("k", 42);
      return c.json({ k: c.get("k") });
    },
  },
];

async function describe(res: Response) {
  return {
    status: res.status,
    headers: [...res.headers.entries()].sort(),
    body: await res.text(),
  };
}

for (const testCase of PARITY_CASES) {
  Deno.test(`shim matches Hono: ${testCase.name}`, async () => {
    const url = `http://kernel.test${testCase.path}`;
    const routePath = testCase.params
      ? "/n/:id"
      : testCase.path.split("?")[0] ?? "/x";

    const app = new Hono();
    app.all(
      routePath,
      // The shim's surface is a strict subset of Hono's, so Hono's own Context
      // satisfies it structurally.
      (c) => testCase.run(c as unknown as LegacyContext),
    );
    const fromHono = await describe(
      await app.fetch(new Request(url, testCase.init)),
    );

    const wrapped = wrapLegacyContextHandler(
      testCase.run as unknown as LegacyHandlerFn,
    );
    const fromShim = await describe(
      await wrapped(new Request(url, testCase.init), {
        params: testCase.params ?? {},
      }),
    );

    assertEquals(fromShim, fromHono);
  });
}

/* notFound() is NOT in the corpus above, and it is the only member that is not.
   `c.notFound()` invokes the HOST APP's notFound handler — so what Hono answers here
   depends on the app, and the bare `new Hono()` the corpus builds answers Hono's
   plain-text default, which no host of this shim uses. Both real hosts (the live
   preview in core/app-server.ts and the exported shell) answer the documented
   envelope, so that is the standard. */
Deno.test("shim: c.notFound() answers the host's 404 envelope", async () => {
  const wrapped = wrapLegacyContextHandler(
    ((c: LegacyContext) => c.notFound()) as unknown as LegacyHandlerFn,
  );
  const res = await wrapped(
    new Request("http://kernel.test/gone?q=1"),
    { params: {} },
  );
  assertEquals(await describe(res), {
    status: 404,
    headers: [["content-type", "application/json"]],
    // The same wording core/app-server.ts and the emitted shell use, and the PATH
    // only — the query string is not part of it.
    body: JSON.stringify({
      error: true,
      code: "NOT_FOUND",
      message: "No route matches GET /gone.",
    }),
  });
});

// --- Undeclared members ---

Deno.test("shim: an undeclared context member throws by name", () => {
  const wrapped = wrapLegacyContextHandler(
    ((c: Record<string, unknown>) => {
      const fn = c.parseBody as () => Response;
      return fn();
    }) as unknown as LegacyHandlerFn,
  );
  let thrown: unknown;
  try {
    wrapped(new Request("http://kernel.test/x"), { params: {} });
  } catch (err) {
    thrown = err;
  }
  assert(thrown instanceof TypeError, "expected a TypeError");
  assertStringIncludes((thrown as TypeError).message, "c.parseBody");
  assertStringIncludes((thrown as TypeError).message, "formData");
});

Deno.test("shim: an undeclared c.req member throws by name", () => {
  const wrapped = wrapLegacyContextHandler(
    ((c: { req: Record<string, unknown> }) => {
      const fn = c.req.parseBody as () => Response;
      return fn();
    }) as unknown as LegacyHandlerFn,
  );
  let thrown: unknown;
  try {
    wrapped(new Request("http://kernel.test/x"), { params: {} });
  } catch (err) {
    thrown = err;
  }
  assert(thrown instanceof TypeError, "expected a TypeError");
  assertStringIncludes((thrown as TypeError).message, "c.req.parseBody");
});

Deno.test("shim: runtime probes pass through instead of throwing", async () => {
  // Awaiting the handler's return value probes `.then` on whatever it resolves
  // to; a Proxy that threw on every unknown name would turn that into a crash.
  const wrapped = wrapLegacyContextHandler(
    ((c: LegacyContext) => c.json({ ok: true })) as LegacyHandlerFn,
  );
  const res = await wrapped(new Request("http://kernel.test/x"), {
    params: {},
  });
  assertEquals(await res.json(), { ok: true });
});

Deno.test("shim: deferred header state does not leak between requests", async () => {
  const wrapped = wrapLegacyContextHandler(
    ((c: LegacyContext) => {
      if (c.req.query("tag")) c.header("X-Tag", "yes");
      return c.text("t");
    }) as LegacyHandlerFn,
  );

  const tagged = await wrapped(
    new Request("http://kernel.test/x?tag=1"),
    { params: {} },
  );
  assertEquals(tagged.headers.get("x-tag"), "yes");

  const plain = await wrapped(new Request("http://kernel.test/x"), {
    params: {},
  });
  assertEquals(plain.headers.get("x-tag"), null);
});

// --- The field corpus ---
//
// Synthetic cases prove the rules; only the corpus proves the rules match what the
// agent actually wrote. This is what caught the original rule ordering, where
// `await req.json()` classified as legacy. It reads the projects registered beside
// the repo, so it is skipped rather than failed when they are not there — the
// handler count is logged so a silent skip is visible.

const CORPUS_ROOT = new URL("../../genie-apps/", import.meta.url).pathname;

function corpusHandlerSources(): Array<
  { file: string; name: string; source: string }
> {
  const found: Array<{ file: string; name: string; source: string }> = [];
  const walk = (dir: string) => {
    for (const entry of Deno.readDirSync(dir)) {
      const path = `${dir}/${entry.name}`;
      if (entry.isDirectory) {
        walk(path);
      } else if (dir.endsWith("/handlers") && entry.name.endsWith(".json")) {
        try {
          const parsed = JSON.parse(Deno.readTextFileSync(path));
          if (
            typeof parsed?.source === "string" &&
            typeof parsed?.name === "string"
          ) {
            found.push({
              file: path,
              name: parsed.name,
              source: parsed.source,
            });
          }
        } catch {
          // A half-written or hand-edited state file is not this test's problem.
        }
      }
    }
  };
  walk(CORPUS_ROOT);
  return found;
}

function corpusAvailable(): boolean {
  try {
    return Deno.statSync(CORPUS_ROOT).isDirectory;
  } catch {
    return false;
  }
}

// What a handler's own source says it is, without the classifier: a legacy
// handler reaches through the context (`c.req`, `c.json`), a fetch handler
// declares `req: Request`. A handler with neither cue isn't checked.
const LEGACY_CUE = /\bc\.(req|json|text|html|body|header|redirect|status)\b/;
const FETCH_CUE = /\(\s*req\s*:\s*Request\b/;

function expectedAbi(source: string): HandlerAbi | null {
  const legacy = LEGACY_CUE.test(source);
  const fetch = FETCH_CUE.test(source);
  if (legacy === fetch) return null;
  return legacy ? "legacy-context" : "fetch";
}

Deno.test({
  name:
    "detectHandlerAbi: every handler in the field corpus reads as its source says",
  ignore: !corpusAvailable(),
  fn: () => {
    const checked = corpusHandlerSources().flatMap((h) => {
      const expected = expectedAbi(h.source);
      return expected ? [{ ...h, expected }] : [];
    });
    const misread = checked
      .filter((h) => detectHandlerAbi(h.source, h.name) !== h.expected)
      .map((h) => `${h.file} (expected ${h.expected})`);
    assertEquals(misread, [], `misclassified ${misread.length} field handlers`);
    // An empty corpus would pass vacuously.
    assert(
      checked.length > 0,
      `found no handler sources under ${CORPUS_ROOT}`,
    );
    console.log(`  checked ${checked.length} field handlers`);
  },
});
