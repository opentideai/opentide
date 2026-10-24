import type { Kernel } from "./registries.ts";
import type { TestEntry } from "./types.ts";
import { escapeRegex } from "./util.ts";

export type CoverageStatus = "passing" | "failing" | "untested" | "never_run";

export interface CoverageEntry {
  name: string;
  module?: string;
  tested: boolean;
  tests: string[];
  status: CoverageStatus;
}

interface CategorySummary {
  covered: number;
  total: number;
  percent: number;
  passing: number;
  failing: number;
}

export interface CoverageReport {
  summary: {
    handlers: CategorySummary;
    functions: CategorySummary;
    routes: CategorySummary;
    templates: CategorySummary;
    schemas: CategorySummary;
    overall: CategorySummary;
  };
  handlers: CoverageEntry[];
  functions: CoverageEntry[];
  routes: Array<CoverageEntry & { method: string; path: string }>;
  templates: CoverageEntry[];
  schemas: CoverageEntry[];
  untested: string[];
  text: string;
}

interface SourceRefs {
  fetchPaths: string[];
  functionCalls: string[];
  dbTables: string[];
  templateRefs: string[];
}

const FETCH_URL_RE = /fetch\s*\(\s*[`"']https?:\/\/[^/]*?(\/[^`"'\s)]+)[`"']/g;
const FETCH_TEMPLATE_RE = /fetch\s*\(\s*`https?:\/\/[^/]*?(\/[^`]+)`/g;
const FUNCTIONS_CALL_RE = /functions\.call\s*\(\s*["'](\w+)["']/g;
const FUNCTIONS_GET_RE = /functions\.get\s*\(\s*["'](\w+)["']/g;
const DB_TABLE_RE = /(?:FROM|INTO|UPDATE|TABLE|JOIN)\s+["'`]?(\w+)["'`]?/gi;
const TEMPLATES_GET_RE = /templates\.get\s*\(\s*["']([^"']+)["']/g;

const SQL_KEYWORDS = new Set([
  "set",
  "values",
  "select",
  "where",
  "and",
  "or",
  "not",
  "null",
  "as",
  "on",
  "in",
  "is",
  "by",
  "order",
  "group",
  "limit",
  "offset",
  "having",
  "distinct",
  "count",
  "sum",
  "avg",
  "min",
  "max",
  "case",
  "when",
  "then",
  "else",
  "end",
  "like",
  "between",
  "exists",
  "create",
  "drop",
  "alter",
  "insert",
  "delete",
  "index",
  "primary",
  "key",
  "foreign",
  "references",
  "constraint",
  "default",
  "check",
]);

function extractSourceRefs(source: string): SourceRefs {
  const fetchPaths = new Set<string>();
  const functionCalls = new Set<string>();
  const dbTables = new Set<string>();
  const templateRefs = new Set<string>();

  // Strip query string / hash so a tested endpoint like `/api/users?limit=5`
  // still matches the route `/api/users` (otherwise it reads as untested).
  const stripQuery = (path: string) => path.replace(/[?#].*$/, "");
  for (const m of source.matchAll(FETCH_URL_RE)) {
    fetchPaths.add(stripQuery(m[1]!));
  }
  for (const m of source.matchAll(FETCH_TEMPLATE_RE)) {
    fetchPaths.add(stripQuery(m[1]!.replace(/\$\{[^}]+\}/g, "*")));
  }

  for (const m of source.matchAll(FUNCTIONS_CALL_RE)) functionCalls.add(m[1]!);
  for (const m of source.matchAll(FUNCTIONS_GET_RE)) functionCalls.add(m[1]!);

  for (const m of source.matchAll(DB_TABLE_RE)) {
    const table = m[1]!.toLowerCase();
    if (!SQL_KEYWORDS.has(table)) dbTables.add(table);
  }

  for (const m of source.matchAll(TEMPLATES_GET_RE)) templateRefs.add(m[1]!);

  return {
    fetchPaths: [...fetchPaths],
    functionCalls: [...functionCalls],
    dbTables: [...dbTables],
    templateRefs: [...templateRefs],
  };
}

// Walk the function call graph transitively, collecting all reachable deps
function resolveTransitiveDeps(
  startRefs: SourceRefs,
  fnSourceMap: Map<string, string>,
): SourceRefs {
  const allFunctions = new Set(startRefs.functionCalls);
  const allTables = new Set(startRefs.dbTables);
  const allTemplates = new Set(startRefs.templateRefs);
  const allFetchPaths = new Set(startRefs.fetchPaths);

  const visited = new Set<string>();
  const queue = [...startRefs.functionCalls];

  while (queue.length > 0) {
    const fnName = queue.pop()!;
    if (visited.has(fnName)) continue;
    visited.add(fnName);

    const fnSource = fnSourceMap.get(fnName);
    if (!fnSource) continue;

    const refs = extractSourceRefs(fnSource);
    for (const t of refs.dbTables) allTables.add(t);
    for (const t of refs.templateRefs) allTemplates.add(t);
    for (const fp of refs.fetchPaths) allFetchPaths.add(fp);
    for (const fn of refs.functionCalls) {
      allFunctions.add(fn);
      if (!visited.has(fn)) queue.push(fn);
    }
  }

  return {
    fetchPaths: [...allFetchPaths],
    functionCalls: [...allFunctions],
    dbTables: [...allTables],
    templateRefs: [...allTemplates],
  };
}

function pathMatchesRoute(fetchPath: string, routePath: string): boolean {
  const fetchParts = fetchPath.split("/").filter(Boolean);
  const routeParts = routePath.split("/").filter(Boolean);

  if (fetchParts.length !== routeParts.length) return false;

  return routeParts.every((rp, i) => {
    if (rp.startsWith(":") || fetchParts[i] === "*") return true;
    return rp === fetchParts[i];
  });
}

function resolveStatus(
  testNames: string[],
  testMap: Map<string, TestEntry>,
): CoverageStatus {
  if (testNames.length === 0) return "untested";
  let anyRan = false;
  let allPass = true;
  for (const name of testNames) {
    const entry = testMap.get(name);
    if (!entry?.lastResult) continue;
    anyRan = true;
    if (!entry.lastResult.passed) allPass = false;
  }
  if (!anyRan) return "never_run";
  return allPass ? "passing" : "failing";
}

function categorySummary(entries: CoverageEntry[]): CategorySummary {
  const total = entries.length;
  const covered = entries.filter((e) => e.tested).length;
  const passing = entries.filter((e) => e.status === "passing").length;
  const failing = entries.filter((e) => e.status === "failing").length;
  return {
    covered,
    total,
    percent: total === 0 ? 100 : Math.round((covered / total) * 1000) / 10,
    passing,
    failing,
  };
}

function nameInSource(name: string, source: string): boolean {
  return new RegExp(`\\b${escapeRegex(name)}\\b`).test(source);
}

function formatSummary(report: Omit<CoverageReport, "text">): string {
  const { summary, untested } = report;
  const o = summary.overall;

  const lines: string[] = [];
  lines.push(`Coverage: ${o.covered}/${o.total} entities (${o.percent}%)`);

  if (o.passing > 0 || o.failing > 0) {
    const parts: string[] = [];
    if (o.passing > 0) parts.push(`${o.passing} passing`);
    if (o.failing > 0) parts.push(`${o.failing} failing`);
    lines.push(`Status: ${parts.join(", ")}`);
  }

  lines.push("");

  const cats: Array<[string, CategorySummary]> = [
    ["Handlers", summary.handlers],
    ["Functions", summary.functions],
    ["Routes", summary.routes],
    ["Templates", summary.templates],
    ["Schemas", summary.schemas],
  ];

  for (const [label, cat] of cats) {
    if (cat.total === 0) continue;
    let line = `  ${label}: ${cat.covered}/${cat.total} (${cat.percent}%)`;
    if (cat.failing > 0) line += ` [${cat.failing} failing]`;
    lines.push(line);
  }

  if (untested.length > 0) {
    lines.push("");
    lines.push(`Untested (${untested.length}):`);
    for (const name of untested) {
      lines.push(`  - ${name}`);
    }
  }

  return lines.join("\n");
}

export async function computeCoverage(
  kernel: Kernel,
  module?: string,
): Promise<CoverageReport> {
  const tests = kernel.tests.list();
  const testMap = new Map(tests.map((t) => [t.name, t]));

  // Build source maps for transitive resolution
  const allHandlers = kernel.handlers.list();
  const allFunctions = kernel.functions.list();
  const fnSourceMap = new Map<string, string>();
  for (const f of allFunctions) fnSourceMap.set(f.name, f.source);

  // For each handler, build its full transitive deps (handler source + called functions)
  const handlerTransitiveDeps = new Map<string, SourceRefs>();
  for (const h of allHandlers) {
    const directRefs = extractSourceRefs(h.source);
    handlerTransitiveDeps.set(
      h.name,
      resolveTransitiveDeps(directRefs, fnSourceMap),
    );
  }

  // For each function, build its transitive deps
  const functionTransitiveDeps = new Map<string, SourceRefs>();
  for (const f of allFunctions) {
    const directRefs = extractSourceRefs(f.source);
    functionTransitiveDeps.set(
      f.name,
      resolveTransitiveDeps(directRefs, fnSourceMap),
    );
  }

  // Extract refs from each test, then expand with transitive deps of directly covered handlers/functions
  const testTransitiveRefs = new Map<string, SourceRefs>();
  for (const t of tests) {
    const directRefs = extractSourceRefs(t.source);
    testTransitiveRefs.set(
      t.name,
      resolveTransitiveDeps(directRefs, fnSourceMap),
    );
  }

  let handlers = allHandlers;
  let functions = allFunctions;
  let routes = kernel.routes.list();
  let templates = kernel.templates.list();
  let schemas = await kernel.db.listSchemas();

  if (module) {
    handlers = handlers.filter((h) => h.module === module);
    functions = functions.filter((f) => f.module === module);
    routes = routes.filter((r) => r.module === module);
    templates = templates.filter((t) => t.module === module);
    schemas = schemas.filter((s) => s.module === module);
  }

  // Build route-to-handler lookup for backlinks
  const allRoutes = kernel.routes.list();
  const routesByHandler = new Map<
    string,
    Array<{ method: string; path: string }>
  >();
  for (const r of allRoutes) {
    if (!routesByHandler.has(r.handlerName)) {
      routesByHandler.set(r.handlerName, []);
    }
    routesByHandler.get(r.handlerName)!.push({
      method: r.method,
      path: r.path,
    });
  }

  // Collect which tests directly cover each handler (needed for transitive propagation)
  const handlerDirectTests = new Map<string, Set<string>>();
  for (const h of handlers) {
    const matching = new Set<string>();
    for (const t of tests) {
      const refs = testTransitiveRefs.get(t.name)!;
      if (refs.functionCalls.includes(h.name)) {
        matching.add(t.name);
        continue;
      }
      if (t.name.toLowerCase().includes(h.name.toLowerCase())) {
        matching.add(t.name);
        continue;
      }
      if (nameInSource(h.name, t.source)) {
        matching.add(t.name);
        continue;
      }
      const handlerRoutes = routesByHandler.get(h.name);
      if (handlerRoutes) {
        for (const fp of refs.fetchPaths) {
          if (handlerRoutes.some((r) => pathMatchesRoute(fp, r.path))) {
            matching.add(t.name);
            break;
          }
        }
      }
    }
    handlerDirectTests.set(h.name, matching);
  }

  // --- Handler coverage ---
  const handlerCoverage: CoverageEntry[] = handlers.map((h) => {
    const testList = [...(handlerDirectTests.get(h.name) ?? [])];
    return {
      name: h.name,
      module: h.module,
      tested: testList.length > 0,
      tests: testList,
      status: resolveStatus(testList, testMap),
    };
  });

  // --- Function coverage (direct + transitive from handlers/other functions) ---
  const functionCoverage: CoverageEntry[] = functions.map((f) => {
    const matching = new Set<string>();

    // Direct: test source references this function
    for (const t of tests) {
      const refs = testTransitiveRefs.get(t.name)!;
      if (refs.functionCalls.includes(f.name)) {
        matching.add(t.name);
        continue;
      }
      if (t.name.toLowerCase().includes(f.name.toLowerCase())) {
        matching.add(t.name);
        continue;
      }
      if (nameInSource(f.name, t.source)) {
        matching.add(t.name);
        continue;
      }
    }

    // Transitive: handler that test covers calls this function
    for (const h of allHandlers) {
      const hDeps = handlerTransitiveDeps.get(h.name);
      if (!hDeps?.functionCalls.includes(f.name)) continue;
      const hTests = handlerDirectTests.get(h.name);
      if (hTests) { for (const t of hTests) matching.add(t); }
    }

    const testList = [...matching];
    return {
      name: f.name,
      module: f.module,
      tested: testList.length > 0,
      tests: testList,
      status: resolveStatus(testList, testMap),
    };
  });

  // --- Route coverage ---
  const routeCoverage = routes.map((r) => {
    const matching = new Set<string>();
    for (const t of tests) {
      const refs = testTransitiveRefs.get(t.name)!;
      for (const fp of refs.fetchPaths) {
        if (pathMatchesRoute(fp, r.path)) {
          matching.add(t.name);
          break;
        }
      }
      if (matching.has(t.name)) continue;
      const hc = handlerCoverage.find((h) => h.name === r.handlerName);
      if (hc?.tests.includes(t.name)) matching.add(t.name);
    }
    const testList = [...matching];
    return {
      name: `${r.method} ${r.path}`,
      method: r.method,
      path: r.path,
      module: r.module,
      tested: testList.length > 0,
      tests: testList,
      status: resolveStatus(testList, testMap),
    };
  });

  // --- Template coverage (direct + transitive from handlers/functions) ---
  const templateCoverage: CoverageEntry[] = templates.map((t) => {
    const matching = new Set<string>();

    for (const test of tests) {
      const refs = testTransitiveRefs.get(test.name)!;
      if (refs.templateRefs.includes(t.name)) {
        matching.add(test.name);
        continue;
      }
      if (nameInSource(t.name, test.source)) {
        matching.add(test.name);
        continue;
      }
    }

    // Transitive: handler/function that test covers references this template
    for (const h of allHandlers) {
      const hDeps = handlerTransitiveDeps.get(h.name);
      if (!hDeps?.templateRefs.includes(t.name)) continue;
      const hTests = handlerDirectTests.get(h.name);
      if (hTests) { for (const tn of hTests) matching.add(tn); }
    }

    const testList = [...matching];
    return {
      name: t.name,
      module: t.module,
      tested: testList.length > 0,
      tests: testList,
      status: resolveStatus(testList, testMap),
    };
  });

  // --- Schema coverage (direct + transitive from handlers/functions) ---
  const schemaCoverage: CoverageEntry[] = schemas.map((s) => {
    const matching = new Set<string>();
    const tableLower = s.tableName.toLowerCase();

    for (const test of tests) {
      const refs = testTransitiveRefs.get(test.name)!;
      if (refs.dbTables.includes(tableLower)) {
        matching.add(test.name);
        continue;
      }
      if (nameInSource(s.tableName, test.source)) {
        matching.add(test.name);
        continue;
      }
    }

    // Transitive: handler/function that test covers queries this table
    for (const h of allHandlers) {
      const hDeps = handlerTransitiveDeps.get(h.name);
      if (!hDeps?.dbTables.includes(tableLower)) continue;
      const hTests = handlerDirectTests.get(h.name);
      if (hTests) { for (const tn of hTests) matching.add(tn); }
    }

    const testList = [...matching];
    return {
      name: s.tableName,
      module: s.module,
      tested: testList.length > 0,
      tests: testList,
      status: resolveStatus(testList, testMap),
    };
  });

  const untested = [
    ...handlerCoverage.filter((e) => !e.tested).map((e) => `handler:${e.name}`),
    ...functionCoverage.filter((e) => !e.tested).map((e) =>
      `function:${e.name}`
    ),
    ...routeCoverage.filter((e) => !e.tested).map((e) => `route:${e.name}`),
    ...templateCoverage.filter((e) => !e.tested).map((e) =>
      `template:${e.name}`
    ),
    ...schemaCoverage.filter((e) => !e.tested).map((e) => `schema:${e.name}`),
  ];

  const allEntries = [
    ...handlerCoverage,
    ...functionCoverage,
    ...routeCoverage,
    ...templateCoverage,
    ...schemaCoverage,
  ];

  const partial = {
    summary: {
      handlers: categorySummary(handlerCoverage),
      functions: categorySummary(functionCoverage),
      routes: categorySummary(routeCoverage),
      templates: categorySummary(templateCoverage),
      schemas: categorySummary(schemaCoverage),
      overall: categorySummary(allEntries),
    },
    handlers: handlerCoverage,
    functions: functionCoverage,
    routes: routeCoverage,
    templates: templateCoverage,
    schemas: schemaCoverage,
    untested,
  };

  return { ...partial, text: formatSummary(partial) };
}
