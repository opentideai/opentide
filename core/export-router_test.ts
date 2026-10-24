import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { Hono } from "hono";
import { RegExpRouter } from "hono/router/reg-exp-router";
import { TrieRouter } from "hono/router/trie-router";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { assertExportableRoutePaths } from "./export.ts";
import { generateRouterRuntimeSource, ROUTER_PATH } from "./export-router.ts";
import {
  inRepoMatcherSource,
  MATCHER_MARKER,
} from "../scripts/generate-export-router.ts";

/* The differential gate for stage 10 of docs/framework-free-handler-abi-plan.md.

   The exported shell used to be a Hono app. It now matches routes itself, on
   URLPattern, and the only defensible standard for "correct" is: the same answer Hono
   gave, because that is what every app already exported behaves like. So this file
   registers the same route table with real Hono and compares {status, handlerName,
   params} over three corpora — the routes the field actually uses, a hand-written
   precedence corpus, and a seeded fuzz.

   It runs against the EMITTED router.ts, loaded from a temp directory, not against an
   in-repo copy. The artifact that ships is the thing under test.

   The matcher itself lives in core/route-matcher.ts and is shared with the live
   preview; the emitted copy exists because an export cannot import the kernel. The
   first test below is what makes the copy safe — it is the ORIGINAL, verbatim — and
   that is also what lets the Hono differential here stand as the gate on the shared
   module, not merely on the copy. */

// --- The copy is the original ----------------------------------------------------

Deno.test("the emitted router is core/route-matcher.ts's matcher, verbatim", () => {
  const inRepo = inRepoMatcherSource(
    Deno.readTextFileSync(new URL("./route-matcher.ts", import.meta.url)),
  );
  // Not a substring check for its own sake: an exact-containment assertion means drift
  // is impossible rather than merely detectable, and it is why the differential below
  // covers core/route-matcher.ts without importing it.
  assert(inRepo.length > 0, "core/route-matcher.ts's shared half is empty");
  assert(
    generateRouterRuntimeSource().includes(inRepo),
    "core/export-router.ts is stale \u2014 run `deno task router:generate`",
  );
  // The marker the generator slices on has to still be there, or the slice above
  // silently returns something else and this test passes vacuously.
  assertStringIncludes(
    Deno.readTextFileSync(new URL("./route-matcher.ts", import.meta.url)),
    MATCHER_MARKER,
  );
});

// --- Loading the emitted module ------------------------------------------------

interface RouteDef {
  method: string;
  path: string;
  handlerName: string;
}

interface MatchResult {
  status: number;
  route: { handlerName: string } | null;
  params: Record<string, string>;
}

interface RouterModule {
  toPatternPath(path: string): string;
  compileRoutes(routes: readonly RouteDef[]): unknown[];
  match(
    compiled: readonly unknown[],
    method: string,
    path: string,
  ): MatchResult;
  allowedMethods(compiled: readonly unknown[], path: string): string[];
}

const router: RouterModule = await (async () => {
  const dir = Deno.makeTempDirSync({ prefix: "export-router-" });
  const path = join(dir, ROUTER_PATH);
  Deno.writeTextFileSync(path, generateRouterRuntimeSource());
  const mod = await import(pathToFileURL(path).href) as RouterModule;
  // The module is in memory now; the file on disk has done its job.
  rmSync(dir, { recursive: true, force: true });
  return mod;
})();

// --- Answer comparison ---------------------------------------------------------

interface Answer {
  status: number;
  handlerName: string | null;
  params: Record<string, string>;
}

// Param KEY ORDER differs between the two (Hono fills in match order, URLPattern in
// pattern order) and is not part of the contract — c.req.param() and ctx.params are
// both read by key. Sorting makes the comparison the one that matters.
function normalize(answer: Answer): string {
  const params = Object.fromEntries(
    Object.entries(answer.params).sort(([a], [b]) => (a < b ? -1 : 1)),
  );
  return JSON.stringify({
    status: answer.status,
    handlerName: answer.handlerName,
    params,
  });
}

// The handler's identity travels in HEADERS, not the body. A HEAD response has no body
// — Hono dispatches HEAD as GET and strips it — so a body-carried identity silently
// turns every HEAD probe into "status only", which is exactly how the spike's fuzz
// missed that a route registered under HEAD is unreachable.
function buildApp(
  routes: readonly RouteDef[],
  router?: "regexp" | "trie",
): Hono {
  const app = new Hono(
    router === "regexp"
      ? { router: new RegExpRouter() }
      : router === "trie"
      ? { router: new TrieRouter() }
      : {},
  );
  for (const r of routes) {
    app.on(r.method, r.path, (c) =>
      new Response(null, {
        headers: {
          "x-handler": r.handlerName,
          // Percent-encoded: a param value can be non-ASCII, and a header value
          // cannot.
          "x-params": encodeURIComponent(JSON.stringify(c.req.param())),
        },
      }));
  }
  return app;
}

async function honoAnswer(
  app: Hono,
  method: string,
  path: string,
): Promise<Answer> {
  const res = await app.fetch(
    new Request(`http://localhost${path}`, { method }),
  );
  const handlerName = res.headers.get("x-handler");
  if (handlerName === null) {
    return { status: res.status, handlerName: null, params: {} };
  }
  return {
    status: 200,
    handlerName,
    params: JSON.parse(
      decodeURIComponent(res.headers.get("x-params") ?? "%7B%7D"),
    ) as Record<string, string>,
  };
}

// match() hands back the caller's own route entry on a hit, not a bare name — the
// preview reads a schema and a label off it. Only the handler's identity is comparable
// against Hono, so that is what this projects out.
function ourAnswer(
  compiled: readonly unknown[],
  method: string,
  path: string,
): Answer {
  const hit = router.match(compiled, method, path);
  return {
    status: hit.status,
    handlerName: hit.route?.handlerName ?? null,
    params: hit.params,
  };
}

interface Probe {
  method: string;
  path: string;
  label: string;
}

async function assertNoDivergence(
  corpus: string,
  routes: readonly RouteDef[],
  probes: readonly Probe[],
): Promise<number> {
  const app = buildApp(routes);
  const compiled = router.compileRoutes(routes);
  const divergences: string[] = [];
  for (const probe of probes) {
    // Both sides read the method off the SAME Request, because that is what the shell
    // sees: the fetch spec normalises DELETE/GET/HEAD/OPTIONS/POST/PUT and leaves
    // everything else — "patch" stays lowercase — exactly as given.
    const request = new Request(`http://localhost${probe.path}`, {
      method: probe.method,
    });
    const ours = normalize(ourAnswer(compiled, request.method, probe.path));
    const theirs = normalize(await honoAnswer(app, probe.method, probe.path));
    if (ours !== theirs) {
      divergences.push(
        `[${probe.label}] ${probe.method} ${probe.path}\n  hono: ${theirs}\n  ours: ${ours}`,
      );
    }
  }
  assertEquals(
    divergences,
    [],
    `${corpus}: ${divergences.length} of ${probes.length} probes diverge`,
  );
  return probes.length;
}

// --- Corpus 1: the routes the field actually uses -------------------------------

const REAL_ROUTES: RouteDef[] = JSON.parse(
  Deno.readTextFileSync(
    new URL("./testdata/export-real-routes.json", import.meta.url),
  ),
);

// Every way a real route can be approached: as itself, with a trailing slash, as HEAD,
// with the method's other spelling, under a method nothing registered, with an extra
// segment, and — for the shapes the field has — with awkward parameter values.
function probesForRealRoutes(routes: readonly RouteDef[]): Probe[] {
  const out: Probe[] = [];
  const concrete = (p: string) =>
    p.replace(/:\w+\{[^}]*\}/g, "42").replace(/:\w+/g, "42");

  for (const r of routes) {
    const path = concrete(r.path);
    out.push({ method: r.method, path, label: "exact" });
    if (path !== "/") {
      out.push({ method: r.method, path: `${path}/`, label: "trailing-slash" });
    }
    if (r.method.toUpperCase() === "GET") {
      out.push({ method: "HEAD", path, label: "head-from-get" });
    }
    out.push({
      method: r.method.toLowerCase(),
      path,
      label: "lowercase-method",
    });
    out.push({ method: "REPORT", path, label: "unregistered-method" });
    out.push({
      method: r.method,
      path: `${path}/extra`,
      label: "extra-segment",
    });
  }

  const regexRoute = routes.find((r) => r.path.includes("{"));
  if (regexRoute) {
    const base = regexRoute.path.replace(/:\w+\{[^}]*\}/, "");
    for (const v of ["7", "abc", "7a", "", "%2F", "-1", "0"]) {
      out.push({
        method: regexRoute.method,
        path: base + v,
        label: "regex-param",
      });
    }
  }

  const paramRoute = routes.find((r) => /:\w+$/.test(r.path));
  if (paramRoute) {
    const base = paramRoute.path.replace(/:\w+$/, "");
    for (const v of ["a%2Fb", "a.b", "a%20b", "..", ".", "a+b", "%E2%9C%93"]) {
      out.push({
        method: paramRoute.method,
        path: base + v,
        label: "encoded-param",
      });
    }
  }

  for (
    const p of ["/", "/nope", "/api", "/api/nope/deep", "//", "/api//todos"]
  ) {
    out.push({ method: "GET", path: p, label: "unmatched" });
  }
  return out;
}

Deno.test("the emitted router matches Hono over the field's own routes", async () => {
  // 123 unique method+path routes, merged from the projects on the machine this was
  // measured on. Committed as a fixture so the corpus does not evaporate.
  assert(REAL_ROUTES.length > 100, "the real-route fixture went missing");
  const count = await assertNoDivergence(
    "real routes",
    REAL_ROUTES,
    probesForRealRoutes(REAL_ROUTES),
  );
  assert(count > 600, `expected a few hundred probes, ran ${count}`);
});

// --- Corpus 2: precedence, and the shapes the field has not reached yet ----------

// The field has no static-vs-param overlaps and no wildcards, so everything here is a
// case a real app can reach and ours have not. Registration order is deliberate: the
// static /api/items/new is registered AFTER /api/items/:id and must lose to it.
const PRECEDENCE_ROUTES: RouteDef[] = [
  { method: "GET", path: "/api/items/:id", handlerName: "byId" },
  { method: "GET", path: "/api/items/new", handlerName: "staticNew" },
  { method: "GET", path: "/api/items/:id/edit", handlerName: "editById" },
  { method: "GET", path: "/api/items/:id{[0-9]+}", handlerName: "byNumericId" },
  { method: "GET", path: "/api/files/*", handlerName: "wildFiles" },
  { method: "GET", path: "/api/files/special", handlerName: "staticSpecial" },
  { method: "GET", path: "/mid/*/y", handlerName: "midWildcard" },
  { method: "GET", path: "/star/:id{[0-9]*}", handlerName: "starInsideRegex" },
  {
    method: "GET",
    path: "/two/:code{\\d{2}}/:page",
    handlerName: "nestedBraces",
  },
  { method: "POST", path: "/api/items", handlerName: "create" },
  { method: "ALL", path: "/api/any", handlerName: "anyMethod" },
  { method: "HEAD", path: "/head-only", handlerName: "headOnly" },
  { method: "GET", path: "/a/:x/b/:y", handlerName: "twoParams" },
];

const PRECEDENCE_PROBES: Probe[] = [
  ...["new", "42", "abc", "new/edit", "42/edit", "abc/edit"].map((s) => ({
    method: "GET",
    path: `/api/items/${s}`,
    label: "precedence",
  })),
  { method: "GET", path: "/api/files/special", label: "wildcard-beats-static" },
  { method: "GET", path: "/api/files/a/b/c", label: "wildcard-deep" },
  { method: "GET", path: "/api/files/", label: "wildcard-empty" },
  { method: "GET", path: "/api/files", label: "wildcard-bare-parent" },
  { method: "GET", path: "/mid/a/y", label: "mid-wildcard" },
  { method: "GET", path: "/mid/a/b/y", label: "mid-wildcard-two-segments" },
  { method: "GET", path: "/mid//y", label: "mid-wildcard-empty" },
  { method: "GET", path: "/star/123", label: "star-inside-regex" },
  { method: "GET", path: "/star/", label: "star-inside-regex-empty" },
  { method: "GET", path: "/two/12/3", label: "nested-braces" },
  { method: "GET", path: "/two/1/3", label: "nested-braces-miss" },
  { method: "POST", path: "/api/items", label: "method-specific" },
  { method: "GET", path: "/api/items", label: "method-mismatch-is-404" },
  { method: "patch", path: "/api/items", label: "lowercase-unregistered" },
  ...["GET", "POST", "DELETE", "PATCH", "HEAD"].map((m) => ({
    method: m,
    path: "/api/any",
    label: "ALL-method",
  })),
  // A route registered under HEAD is unreachable: Hono rewrites HEAD to GET before it
  // looks anything up. Both probes below must 404.
  { method: "HEAD", path: "/head-only", label: "head-only-route" },
  { method: "GET", path: "/head-only", label: "head-only-route-as-get" },
  { method: "GET", path: "/a/1/b/2", label: "two-params" },
  { method: "GET", path: "/a/1/b", label: "two-params-short" },
];

Deno.test("the emitted router matches Hono on precedence, wildcards and methods", async () => {
  await assertNoDivergence(
    "precedence",
    PRECEDENCE_ROUTES,
    PRECEDENCE_PROBES,
  );
});

// --- Corpus 3: seeded fuzz ------------------------------------------------------

// A fixed seed, so a failure replays. The generator is the spike's
// (spike/export-zero-dep/, since retired — its measurement record is the FINDINGS.md
// left behind there), which is what found the two wildcard translations
// and the nested-brace parse; the hand-written corpora above found none of them.
function makeRandom(seed: number): () => number {
  let state = seed;
  return () => {
    state = (Math.imul(state, 1103515245) + 12345) & 0x7fffffff;
    return state / 0x7fffffff;
  };
}

const STATIC_SEGMENTS = [
  "a",
  "b",
  "items",
  "new",
  "edit",
  "users",
  "x.y",
  "a-b",
  "ü",
];
const FUZZ_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "ALL"];
const PARAM_NAMES = ["id", "kind", "slug", "n"];
const CONSTRAINTS = ["[0-9]+", "[a-z]+", "\\d{2}"];
const PROBE_SEGMENTS = [
  "a",
  "b",
  "items",
  "new",
  "edit",
  "users",
  "42",
  "abc",
  "7",
  "x.y",
  "a-b",
  "ü",
  "%2F",
  "a%20b",
  "",
  "..",
  "07",
  "A",
  "a+b",
  "%E2%9C%93",
];

Deno.test("the emitted router survives a seeded fuzz, except where Hono contradicts Hono", async () => {
  const rnd = makeRandom(0x2545f491);
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)]!;
  const int = (n: number) => Math.floor(rnd() * n);

  const randomSegment = (): string => {
    const r = rnd();
    if (r < 0.5) return pick(STATIC_SEGMENTS);
    if (r < 0.75) return `:${pick(PARAM_NAMES)}`;
    if (r < 0.9) return `:${pick(PARAM_NAMES)}{${pick(CONSTRAINTS)}}`;
    return "*";
  };
  const randomPath = (): string =>
    "/" +
    Array.from({ length: 1 + int(4) }, randomSegment).join("/");
  const randomProbePath = (): string => {
    const p = "/" +
      Array.from({ length: 1 + int(5) }, () => pick(PROBE_SEGMENTS)).join("/");
    return rnd() < 0.15 ? `${p}/` : p;
  };

  let tables = 0;
  let probes = 0;
  let refusedByExport = 0;
  let honoRefused = 0;
  let ambiguous = 0;
  const divergences: string[] = [];

  for (let t = 0; t < 400; t++) {
    const routes: RouteDef[] = [];
    const seen = new Set<string>();
    for (let i = 0; i < 1 + int(8); i++) {
      const method = pick(FUZZ_METHODS);
      const path = randomPath();
      const key = `${method} ${path}`;
      if (seen.has(key)) continue; // the registry dedupes (method, path)
      seen.add(key);
      routes.push({ method, path, handlerName: `h${i}` });
    }
    if (routes.length === 0) continue;

    // Hono itself throws on some pathological patterns (two wildcards in one path).
    // The kernel could never emit such a table either, so it is not a divergence.
    let app: Hono;
    let regexpApp: Hono;
    let trieApp: Hono;
    try {
      app = buildApp(routes);
      regexpApp = buildApp(routes, "regexp");
      trieApp = buildApp(routes, "trie");
      await app.fetch(new Request("http://localhost/__warmup"));
      await regexpApp.fetch(new Request("http://localhost/__warmup"));
      await trieApp.fetch(new Request("http://localhost/__warmup"));
    } catch {
      honoRefused++;
      continue;
    }

    // A table the matcher refuses must be one the EXPORT refuses first, with a
    // diagnostic naming the route. URLPattern rejects a repeated capture-group name,
    // which is exactly the duplicate path parameter assertExportableRoutePaths exists
    // to catch — so this is the gate that ties the two halves together.
    let compiled: readonly unknown[];
    try {
      compiled = router.compileRoutes(routes);
    } catch {
      let exportRefused = false;
      try {
        assertExportableRoutePaths(
          routes.map((r) => ({ ...r, registeredAt: "t" })),
        );
      } catch {
        exportRefused = true;
      }
      assert(
        exportRefused,
        `the matcher refused a table the export accepts: ${
          JSON.stringify(routes.map((r) => `${r.method} ${r.path}`))
        }`,
      );
      refusedByExport++;
      continue;
    }

    tables++;
    for (let q = 0; q < 25; q++) {
      const method = pick(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"]);
      const path = randomProbePath();
      const request = new Request(`http://localhost${path}`, { method });
      probes++;

      // Hono's two routers disagree on a handful of multi-wildcard and empty-leading-
      // segment patterns, and SmartRouter picks between them based on what OTHER routes
      // are registered alongside — so the same pattern gives a different answer
      // depending on its siblings. There is no correct answer to match, so the probe is
      // skipped and counted rather than silently filtered.
      const fromRegexp = normalize(
        await honoAnswer(regexpApp, method, path),
      );
      const fromTrie = normalize(await honoAnswer(trieApp, method, path));
      if (fromRegexp !== fromTrie) {
        ambiguous++;
        continue;
      }

      const ours = normalize(ourAnswer(compiled, request.method, path));
      const theirs = normalize(await honoAnswer(app, method, path));
      if (ours !== theirs && divergences.length < 10) {
        divergences.push(
          `${method} ${path}\n  routes: ${
            JSON.stringify(routes.map((r) => `${r.method} ${r.path}`))
          }\n  hono: ${theirs}\n  ours: ${ours}`,
        );
      }
    }
  }

  assertEquals(
    divergences,
    [],
    `fuzz: ${tables} tables, ${probes} probes, ${ambiguous} skipped as ` +
      `Hono-contradicts-Hono, ${refusedByExport} refused by the export, ` +
      `${honoRefused} refused by Hono`,
  );
  // Guards against the fuzz quietly becoming a no-op.
  assert(tables > 50, `only ${tables} tables compiled`);
  assert(probes > 1000, `only ${probes} probes ran`);
});

// --- The path translation itself ------------------------------------------------

Deno.test("the emitted router translates the kernel path DSL as measured", () => {
  const cases: Array<[string, string]> = [
    ["/items", "/items"],
    ["/items/:id", "/items/:id"],
    ["/items/:id{[0-9]+}", "/items/:id([0-9]+)"],
    // Nested braces: a lazy `[^}]*` emits `:code(\d{2)}`, which URLPattern rejects.
    ["/d/:code{\\d{2}}/:page", "/d/:code(\\d{2})/:page"],
    // A terminal wildcard's whole tail is optional, so the bare parent matches too.
    ["/files/*", "/files{/*}?"],
    ["*", "*"],
    ["/a*", "/a*"],
    // A non-terminal wildcard is ONE segment, possibly empty.
    ["/mid/*/y", "/mid/:__w0([^/]*)/y"],
    ["/a/*/b/*", "/a/:__w0([^/]*)/b{/*}?"],
    ["/a/**", "/a/:__w0([^/]*)*"],
    // A `*` inside a regex constraint is part of the regex. A second pass over the
    // whole string — the obvious implementation — rewrites it into nonsense.
    ["/star/:id{[0-9]*}", "/star/:id([0-9]*)"],
  ];
  for (const [input, expected] of cases) {
    assertEquals(router.toPatternPath(input), expected, `path: ${input}`);
  }
});

// --- The Allow header on a 405 ---------------------------------------------------

/* Not comparable against Hono: it never answered 405, so there is nothing to
   differentiate against. The standard here is the live preview's, which lists the
   methods a path is registered under, deduped, in table order. */
Deno.test("the emitted router reports the methods a path is registered under", () => {
  const table: RouteDef[] = [
    { method: "ALL", path: "/any", handlerName: "any" },
    { method: "GET", path: "/items", handlerName: "list" },
    { method: "GET", path: "/items/:id", handlerName: "get" },
    { method: "POST", path: "/items", handlerName: "create" },
    { method: "put", path: "/items", handlerName: "replace" },
    { method: "DELETE", path: "/items/:id", handlerName: "remove" },
    { method: "GET", path: "/files/*", handlerName: "files" },
  ];
  const compiled = router.compileRoutes(table);
  const cases: Array<[string, string[]]> = [
    // Table order, not alphabetical, and a lowercase registration is normalised —
    // an Allow header naming "put" would be nonsense to a client.
    ["/items", ["GET", "POST", "PUT"]],
    ["/items/7", ["GET", "DELETE"]],
    // A request path is a request path: ":id" is just a segment value here, so it
    // matches /items/:id like any other. Same as match() does.
    ["/items/:id", ["GET", "DELETE"]],
    // A wildcard's bare parent counts, the same way it matches.
    ["/files", ["GET"]],
    ["/files/a/b", ["GET"]],
    ["/nothing", []],
    // An ALL route is never listed: match() accepts every method for one, so a path
    // carrying it never reaches the miss path that asks this question.
    ["/any", []],
  ];
  for (const [path, expected] of cases) {
    assertEquals(
      router.allowedMethods(compiled, path),
      expected,
      `path: ${path}`,
    );
  }
});
