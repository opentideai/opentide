import type { Kernel } from "./registries.ts";
import type { Database } from "./db.ts";
import { formatShellTranscript, runShellCommand } from "./shell.ts";
import { formatKernelTimeoutMs, getKernelSettings } from "./config.ts";

// ANSI color codes
const C = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  bold: "\x1b[1m",
  string: "\x1b[32m",
  number: "\x1b[33m",
  boolean: "\x1b[35m",
  null: "\x1b[2m",
  key: "\x1b[36m",
  func: "\x1b[34m",
  date: "\x1b[33m",
  error: "\x1b[91m",
  bracket: "\x1b[90m",
  header: "\x1b[1;36m",
  muted: "\x1b[90m",
  white: "\x1b[97m",
} as const;

type AgentFn = (question: string) => Promise<string>;

const STREAMED = { __streamed__: true } as const;

export class ReplSession {
  private kernel: Kernel | null = null;
  private cwd = Deno.cwd();
  private history: string[] = [];
  private agentFn: AgentFn | null = null;
  private lastResult: unknown = undefined;

  attach(kernel: Kernel): void {
    this.kernel = kernel;
  }

  setCwd(cwd: string): void {
    this.cwd = cwd;
  }

  setAgentFn(fn: AgentFn): void {
    this.agentFn = fn;
  }

  async shell(command: string): Promise<{ ok: boolean; value: string }> {
    const result = await runShellCommand(command, { cwd: this.cwd });
    return { ok: result.ok, value: formatShellTranscript(result) };
  }

  complete(
    line: string,
    pos: number,
  ): { completions: string[]; prefix: string } {
    if (!this.kernel) return { completions: [], prefix: "" };

    const before = line.slice(0, pos);

    const match = before.match(/([\w.$]+)$/);
    if (!match) return { completions: [], prefix: "" };

    const expr = match[1]!;
    const parts = expr.split(".");
    const prefix = parts.pop()!;
    const objPath = parts.join(".");

    const ctx = this.buildContext();

    let target: unknown;
    if (!objPath) {
      const keys = Object.keys(ctx);
      const matching = keys.filter((k) => k.startsWith(prefix));
      return { completions: matching, prefix };
    }

    try {
      const pathParts = objPath.split(".");
      target = ctx[pathParts[0]!];
      for (let i = 1; i < pathParts.length; i++) {
        if (target == null) return { completions: [], prefix };
        target = (target as Record<string, unknown>)[pathParts[i]!];
      }
    } catch {
      return { completions: [], prefix };
    }

    if (target == null) return { completions: [], prefix };

    const keys = new Set<string>();
    let obj: unknown = target;
    for (let depth = 0; depth < 3 && obj != null; depth++) {
      for (const key of Object.getOwnPropertyNames(obj)) {
        if (!key.startsWith("_") && key !== "constructor") keys.add(key);
      }
      obj = Object.getPrototypeOf(obj);
    }

    const lower = prefix.toLowerCase();
    const matching = [...keys]
      .filter((k) => k.toLowerCase().startsWith(lower))
      .sort();

    return { completions: matching, prefix };
  }

  private buildContext(): Record<string, unknown> {
    const k = this.kernel!;
    const agentFn = this.agentFn;
    return {
      kernel: k,
      db: k.db,
      routes: k.routes,
      handlers: k.handlers,
      functions: k.functions,
      configs: k.configs,
      templates: k.templates,
      assets: k.assets,
      schemas: k.db,
      env: k.env,
      log: k.log,
      tests: k.tests,
      devViews: k.devViews,
      devTools: k.devTools,
      packages: k.packages,
      last: this.lastResult,
      // Utility helpers
      ls: this.buildLs(k),
      dump: (val: unknown, depth?: number) => formatValue(val, 0, depth ?? 6),
      sql: buildSql(k.db),
      tables: buildTables(k.db),
      find: buildFind(k),
      get: buildGet(k),
      modules: () => listModules(k),
      source: buildSource(k),
      run: buildRun(k),
      watch: buildWatch(k),
      ask: agentFn
        ? async (q: string) => {
          await agentFn(q);
          return STREAMED;
        }
        : () => Promise.resolve(`${C.error}No agent connected${C.reset}`),
      help: () => showHelp(),
    };
  }

  private buildLs(k: Kernel): LsFn {
    const lsFn = ((filter?: string) => listAll(k, filter)) as LsFn;
    lsFn.routes = () => listRoutes(k);
    lsFn.handlers = () => listHandlers(k);
    lsFn.functions = () => listFunctions(k);
    lsFn.templates = () => listTemplates(k);
    lsFn.assets = () => listAssets(k);
    lsFn.tests = () => listTests(k);
    lsFn.configs = () => listConfigs(k);
    lsFn.types = () => listTypes(k);
    lsFn.devViews = () => listDevViews(k);
    lsFn.devTools = () => listDevTools(k);
    return lsFn;
  }

  async eval(code: string): Promise<{ ok: boolean; value: string }> {
    if (!this.kernel) {
      return { ok: false, value: "No kernel attached" };
    }

    this.history.push(code);

    const ctx = this.buildContext();

    const logs: string[] = [];
    const origLog = console.log;
    const origWarn = console.warn;
    const origError = console.error;
    const origInfo = console.info;

    const capture = (prefix: string, ansi: string) => (...args: unknown[]) => {
      const text = args.map((a) => typeof a === "string" ? a : formatValue(a))
        .join(" ");
      logs.push(`${ansi}${prefix}${text}\x1b[0m`);
    };

    console.log = capture("", "\x1b[37m");
    console.info = capture("", "\x1b[96m");
    console.warn = capture("⚠ ", "\x1b[93m");
    console.error = capture("✗ ", "\x1b[91m");

    try {
      const argNames = Object.keys(ctx);
      const argValues = Object.values(ctx);

      const body = buildEvalBody(code);

      const asyncFn = new Function(
        ...argNames,
        `"use strict"; return (async () => { ${body} })();`,
      );

      const result = await asyncFn(...argValues);
      this.lastResult = result;
      const output = logs.length > 0 ? logs.join("\n") + "\n" : "";
      return { ok: true, value: output + formatValue(result) };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const stack = err instanceof Error ? err.stack : undefined;
      const output = logs.length > 0 ? logs.join("\n") + "\n" : "";
      return { ok: false, value: output + (stack ?? msg) };
    } finally {
      console.log = origLog;
      console.warn = origWarn;
      console.error = origError;
      console.info = origInfo;
    }
  }
}

function buildEvalBody(code: string): string {
  const bareAsk = bareAskExpression(code);
  if (bareAsk) return `return await (\n${bareAsk}\n);`;

  try {
    new Function(`return (\n${code}\n);`);
    return `return (\n${code}\n);`;
  } catch {
    let body = `\n${code}\n`;
    const lastSemi = code.lastIndexOf(";");
    const lastNl = code.lastIndexOf("\n");
    const splitAt = Math.max(lastSemi, lastNl);
    if (splitAt > 0) {
      const prefix = code.slice(0, splitAt + 1);
      const last = code.slice(splitAt + 1).trim();
      if (last) {
        try {
          new Function(`return (\n${last}\n);`);
          body = `\n${prefix}\nreturn (\n${last}\n);\n`;
        } catch { /* last part isn't an expression */ }
      }
    }
    return body;
  }
}

function bareAskExpression(code: string): string | null {
  let expr = code.trim();
  if (expr.endsWith(";")) expr = expr.slice(0, -1).trimEnd();
  if (!/^ask\s*\(/.test(expr)) return null;
  try {
    new Function(`return (\n${expr}\n);`);
    return expr;
  } catch {
    return null;
  }
}

// --- ls() variants ---

interface LsFn {
  (filter?: string): string;
  routes: () => string;
  handlers: () => string;
  functions: () => string;
  templates: () => string;
  assets: () => string;
  tests: () => string;
  configs: () => string;
  types: () => string;
  devViews: () => string;
  devTools: () => string;
}

function listAll(k: Kernel, filter?: string): string {
  const sections: string[] = [];
  const r = k.routes.list();
  const h = k.handlers.list();
  const f = k.functions.list();
  const t = k.templates.list();
  const a = k.assets.list();
  const ts = k.tests.list();
  const c = k.configs.list();
  const ty = k.types.list();

  const match = (name: string) =>
    !filter || name.toLowerCase().includes(filter.toLowerCase());

  if (r.length > 0) {
    const items = r.filter((e) => match(e.path) || match(e.handlerName));
    if (items.length > 0) {
      sections.push(
        `${C.header}Routes${C.reset} ${C.muted}(${items.length})${C.reset}\n` +
          items.map((e) =>
            `  ${C.bold}${
              e.method.padEnd(7)
            }${C.reset} ${e.path} ${C.muted}→ ${e.handlerName}${C.reset}`
          ).join("\n"),
      );
    }
  }
  if (h.length > 0) {
    const items = h.filter((e) => match(e.name));
    if (items.length > 0) {
      sections.push(
        `${C.header}Handlers${C.reset} ${C.muted}(${items.length})${C.reset}\n` +
          items.map((e) =>
            `  ${C.white}${e.name}${C.reset}${
              e.module ? ` ${C.muted}[${e.module}]${C.reset}` : ""
            }`
          ).join("\n"),
      );
    }
  }
  if (f.length > 0) {
    const items = f.filter((e) => match(e.name));
    if (items.length > 0) {
      sections.push(
        `${C.header}Functions${C.reset} ${C.muted}(${items.length})${C.reset}\n` +
          items.map((e) =>
            `  ${C.func}${e.name}${C.reset}${
              e.returnType ? ` ${C.muted}→ ${e.returnType}${C.reset}` : ""
            }${e.module ? ` ${C.muted}[${e.module}]${C.reset}` : ""}`
          ).join("\n"),
      );
    }
  }
  if (t.length > 0) {
    const items = t.filter((e) => match(e.name));
    if (items.length > 0) {
      sections.push(
        `${C.header}Templates${C.reset} ${C.muted}(${items.length})${C.reset}\n` +
          items.map((e) =>
            `  ${C.white}${e.name}${C.reset}${
              e.module ? ` ${C.muted}[${e.module}]${C.reset}` : ""
            }`
          ).join("\n"),
      );
    }
  }
  if (a.length > 0) {
    const items = a.filter((e) => match(e.name));
    if (items.length > 0) {
      sections.push(
        `${C.header}Assets${C.reset} ${C.muted}(${items.length})${C.reset}\n` +
          items.map((e) =>
            `  ${C.white}${e.name}${C.reset} ${C.muted}${e.mimeType} (${
              formatBytes(e.size)
            })${C.reset}`
          ).join("\n"),
      );
    }
  }
  if (ts.length > 0) {
    const items = ts.filter((e) => match(e.name));
    if (items.length > 0) {
      sections.push(
        `${C.header}Tests${C.reset} ${C.muted}(${items.length})${C.reset}\n` +
          items.map((e) => {
            const status = e.lastResult?.passed === true
              ? `\x1b[32m✓${C.reset}`
              : e.lastResult?.passed === false
              ? `\x1b[31m✗${C.reset}`
              : `${C.muted}○${C.reset}`;
            return `  ${status} ${C.white}${e.name}${C.reset}${
              e.module ? ` ${C.muted}[${e.module}]${C.reset}` : ""
            }`;
          }).join("\n"),
      );
    }
  }
  if (c.length > 0) {
    const items = c.filter((e) => match(e.name));
    if (items.length > 0) {
      sections.push(
        `${C.header}Configs${C.reset} ${C.muted}(${items.length})${C.reset}\n` +
          items.map((e) =>
            `  ${C.key}${e.name}${C.reset} ${C.muted}(${e.type})${C.reset}`
          ).join("\n"),
      );
    }
  }
  if (ty.length > 0) {
    const items = ty.filter((e) => match(e.name));
    if (items.length > 0) {
      sections.push(
        `${C.header}Types${C.reset} ${C.muted}(${items.length})${C.reset}\n` +
          items.map((e) =>
            `  ${C.white}${e.name}${C.reset} ${C.muted}(${e.fields.length} fields)${C.reset}`
          ).join("\n"),
      );
    }
  }

  if (sections.length === 0) {
    return filter
      ? `${C.muted}No matches for "${filter}"${C.reset}`
      : `${C.muted}No entities registered${C.reset}`;
  }
  return sections.join("\n\n");
}

function listRoutes(k: Kernel): string {
  const items = k.routes.list();
  if (items.length === 0) return `${C.muted}No routes${C.reset}`;
  return items.map((e) =>
    `${C.bold}${
      e.method.padEnd(7)
    }${C.reset} ${e.path} ${C.muted}→ ${e.handlerName}${C.reset}${
      e.module ? ` ${C.muted}[${e.module}]${C.reset}` : ""
    }`
  ).join("\n");
}

function listHandlers(k: Kernel): string {
  const items = k.handlers.list();
  if (items.length === 0) return `${C.muted}No handlers${C.reset}`;
  return items.map((e) =>
    `${C.white}${e.name}${C.reset}${
      e.module ? ` ${C.muted}[${e.module}]${C.reset}` : ""
    } ${C.muted}(${e.source.length} chars)${C.reset}`
  ).join("\n");
}

function listFunctions(k: Kernel): string {
  const items = k.functions.list();
  if (items.length === 0) return `${C.muted}No functions${C.reset}`;
  return items.map((e) =>
    `${C.func}${e.name}${C.reset}${
      e.returnType ? ` ${C.muted}→ ${e.returnType}${C.reset}` : ""
    }${e.module ? ` ${C.muted}[${e.module}]${C.reset}` : ""}`
  ).join("\n");
}

function listTemplates(k: Kernel): string {
  const items = k.templates.list();
  if (items.length === 0) return `${C.muted}No templates${C.reset}`;
  return items.map((e) =>
    `${C.white}${e.name}${C.reset}${
      e.module ? ` ${C.muted}[${e.module}]${C.reset}` : ""
    } ${C.muted}(${e.content.length} chars)${C.reset}`
  ).join("\n");
}

function listAssets(k: Kernel): string {
  const items = k.assets.list();
  if (items.length === 0) return `${C.muted}No assets${C.reset}`;
  return items.map((e) =>
    `${C.white}${e.name}${C.reset} ${C.muted}${e.mimeType} (${
      formatBytes(e.size)
    })${C.reset}`
  ).join("\n");
}

function listTests(k: Kernel): string {
  const items = k.tests.list();
  if (items.length === 0) return `${C.muted}No tests${C.reset}`;
  return items.map((e) => {
    const status = e.lastResult?.passed === true
      ? `\x1b[32m✓${C.reset}`
      : e.lastResult?.passed === false
      ? `\x1b[31m✗${C.reset}`
      : `${C.muted}○${C.reset}`;
    return `${status} ${C.white}${e.name}${C.reset}${
      e.module ? ` ${C.muted}[${e.module}]${C.reset}` : ""
    }`;
  }).join("\n");
}

function listConfigs(k: Kernel): string {
  const items = k.configs.serialize();
  if (items.length === 0) return `${C.muted}No configs${C.reset}`;
  return items.map((e) =>
    `${C.key}${e.name}${C.reset} ${C.muted}= ${
      truncate(String(e.value), 60)
    }${C.reset}`
  ).join("\n");
}

function listTypes(k: Kernel): string {
  const items = k.types.list();
  if (items.length === 0) return `${C.muted}No types${C.reset}`;
  return items.map((e) => {
    const fields = e.fields.map((f) => `${f.name}: ${f.type}`).join(", ");
    return `${C.white}${e.name}${C.reset} ${C.muted}{ ${
      truncate(fields, 60)
    } }${C.reset}`;
  }).join("\n");
}

function listDevViews(k: Kernel): string {
  const items = k.devViews.list().filter((v) => !v.builtIn);
  if (items.length === 0) return `${C.muted}No custom dev views${C.reset}`;
  return items.map((e) =>
    `${C.white}${e.name}${C.reset} ${C.muted}(${e.targetType})${C.reset}${
      e.module ? ` ${C.muted}[${e.module}]${C.reset}` : ""
    }`
  ).join("\n");
}

function listDevTools(k: Kernel): string {
  const items = k.devTools.list();
  if (items.length === 0) return `${C.muted}No dev tools${C.reset}`;
  return items.map((e) =>
    `${C.white}${e.name}${C.reset} ${C.muted}${e.description}${C.reset}`
  ).join("\n");
}

function listModules(k: Kernel): string {
  const mods = k.listModules();
  if (mods.length === 0) return `${C.muted}No modules${C.reset}`;
  return `${C.header}Modules${C.reset} ${C.muted}(${mods.length})${C.reset}\n` +
    mods.map((m) => `  ${C.white}${m}${C.reset}`).join("\n");
}

// --- sql() ---

function buildSql(
  db: Database,
): (query: string, ...params: unknown[]) => Promise<string> {
  return async (query: string, ...params: unknown[]) => {
    try {
      const rows = await db.query(query, params.length > 0 ? params : []);
      if (rows.length === 0) return `${C.muted}(0 rows)${C.reset}`;
      return formatTable(rows);
    } catch (err) {
      return `${C.error}${
        err instanceof Error ? err.message : String(err)
      }${C.reset}`;
    }
  };
}

function formatTable(rows: Record<string, unknown>[]): string {
  if (rows.length === 0) return `${C.muted}(0 rows)${C.reset}`;
  const cols = Object.keys(rows[0]!);
  const widths = cols.map((c) => c.length);
  const stringRows = rows.map((row) =>
    cols.map((c, i) => {
      const s = row[c] == null ? "NULL" : String(row[c]);
      widths[i] = Math.max(widths[i]!, Math.min(s.length, 40));
      return s;
    })
  );

  const header = cols.map((c, i) =>
    `${C.bold}${c.padEnd(widths[i]!)}${C.reset}`
  ).join(`${C.muted} │ ${C.reset}`);
  const sep = widths.map((w) => "─".repeat(w!)).join(`${C.muted}─┼─${C.reset}`);
  const body = stringRows.map((row) =>
    row.map((val, i) => {
      const truncated = val.length > 40 ? val.slice(0, 37) + "..." : val;
      return val === "NULL"
        ? `${C.null}${truncated.padEnd(widths[i]!)}${C.reset}`
        : truncated.padEnd(widths[i]!);
    }).join(`${C.muted} │ ${C.reset}`)
  ).join("\n");

  return `${header}\n${C.muted}${sep}${C.reset}\n${body}\n${C.muted}(${rows.length} row${
    rows.length !== 1 ? "s" : ""
  })${C.reset}`;
}

// --- tables() ---

function buildTables(db: Database): () => Promise<string> {
  return async () => {
    try {
      const tableRows = await db.query(
        "SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename",
      );
      if (tableRows.length === 0) return `${C.muted}No tables${C.reset}`;

      const results: Array<{ table: string; rows: string }> = [];
      for (const t of tableRows) {
        const name = String(t.tablename);
        try {
          const countResult = await db.query(
            `SELECT COUNT(*)::int AS n FROM "${name}"`,
          );
          results.push({ table: name, rows: String(countResult[0]?.n ?? "?") });
        } catch {
          results.push({ table: name, rows: "?" });
        }
      }

      const maxName = Math.max(...results.map((r) => r.table.length), 5);
      const maxRows = Math.max(...results.map((r) => r.rows.length), 4);
      const header = `${C.bold}${
        "Table".padEnd(maxName)
      }${C.reset}${C.muted} │ ${C.reset}${C.bold}${
        "Rows".padStart(maxRows)
      }${C.reset}`;
      const sep = `${C.muted}${"─".repeat(maxName)}─┼─${
        "─".repeat(maxRows)
      }${C.reset}`;
      const body = results.map((r) =>
        `${C.white}${
          r.table.padEnd(maxName)
        }${C.reset}${C.muted} │ ${C.reset}${C.number}${
          r.rows.padStart(maxRows)
        }${C.reset}`
      ).join("\n");

      return `${header}\n${sep}\n${body}\n${C.muted}(${results.length} table${
        results.length !== 1 ? "s" : ""
      })${C.reset}`;
    } catch (err) {
      return `${C.error}${
        err instanceof Error ? err.message : String(err)
      }${C.reset}`;
    }
  };
}

// --- get() ---

function buildGet(k: Kernel): (name: string) => string {
  return (name: string) => {
    const sections: string[] = [];

    for (const r of k.routes.list()) {
      if (r.handlerName === name || r.path === name) {
        sections.push(
          `${C.header}Route${C.reset}\n` +
            `  ${C.key}method${C.reset}${C.muted}:${C.reset}  ${C.bold}${r.method}${C.reset}\n` +
            `  ${C.key}path${C.reset}${C.muted}:${C.reset}    ${r.path}\n` +
            `  ${C.key}handler${C.reset}${C.muted}:${C.reset} ${r.handlerName}\n` +
            (r.module
              ? `  ${C.key}module${C.reset}${C.muted}:${C.reset}  ${r.module}\n`
              : "") +
            (r.schema
              ? `  ${C.key}schema${C.reset}${C.muted}:${C.reset}  ${
                formatValue(r.schema, 1, 4)
              }`
              : ""),
        );
      }
    }

    const handler = k.handlers.list().find((h) => h.name === name);
    if (handler) {
      sections.push(
        `${C.header}Handler${C.reset} ${C.white}${handler.name}${C.reset}\n` +
          (handler.module
            ? `  ${C.key}module${C.reset}${C.muted}:${C.reset}  ${handler.module}\n`
            : "") +
          `  ${C.key}registered${C.reset}${C.muted}:${C.reset} ${handler.registeredAt}\n` +
          `  ${C.key}source${C.reset}${C.muted}:${C.reset}\n${
            highlightSource(handler.source)
          }`,
      );
    }

    const fn = k.functions.list().find((f) => f.name === name);
    if (fn) {
      sections.push(
        `${C.header}Function${C.reset} ${C.func}${fn.name}${C.reset}\n` +
          (fn.returnType
            ? `  ${C.key}returns${C.reset}${C.muted}:${C.reset} ${fn.returnType}\n`
            : "") +
          (fn.module
            ? `  ${C.key}module${C.reset}${C.muted}:${C.reset}  ${fn.module}\n`
            : "") +
          `  ${C.key}registered${C.reset}${C.muted}:${C.reset} ${fn.registeredAt}\n` +
          `  ${C.key}source${C.reset}${C.muted}:${C.reset}\n${
            highlightSource(fn.source)
          }`,
      );
    }

    const tmpl = k.templates.list().find((t) => t.name === name);
    if (tmpl) {
      sections.push(
        `${C.header}Template${C.reset} ${C.white}${tmpl.name}${C.reset}\n` +
          (tmpl.module
            ? `  ${C.key}module${C.reset}${C.muted}:${C.reset}  ${tmpl.module}\n`
            : "") +
          `  ${C.key}registered${C.reset}${C.muted}:${C.reset} ${tmpl.registeredAt}\n` +
          `  ${C.key}content${C.reset}${C.muted}:${C.reset}\n${tmpl.content}`,
      );
    }

    const test = k.tests.list().find((t) => t.name === name);
    if (test) {
      const status = test.lastResult?.passed === true
        ? `\x1b[32mpassed${C.reset}`
        : test.lastResult?.passed === false
        ? `\x1b[31mfailed${C.reset}`
        : `${C.muted}not run${C.reset}`;
      sections.push(
        `${C.header}Test${C.reset} ${C.white}${test.name}${C.reset}\n` +
          `  ${C.key}status${C.reset}${C.muted}:${C.reset} ${status}\n` +
          (test.lastResult?.durationMs != null
            ? `  ${C.key}duration${C.reset}${C.muted}:${C.reset} ${test.lastResult.durationMs}ms\n`
            : "") +
          (test.lastResult?.error
            ? `  ${C.key}error${C.reset}${C.muted}:${C.reset} ${C.error}${test.lastResult.error}${C.reset}\n`
            : "") +
          (test.module
            ? `  ${C.key}module${C.reset}${C.muted}:${C.reset}  ${test.module}\n`
            : "") +
          `  ${C.key}source${C.reset}${C.muted}:${C.reset}\n${
            highlightSource(test.source)
          }`,
      );
    }

    const config = k.configs.getEntry(name);
    if (config) {
      sections.push(
        `${C.header}Config${C.reset} ${C.key}${config.name}${C.reset}\n` +
          `  ${C.key}value${C.reset}${C.muted}:${C.reset} ${
            formatValue(config.value, 1, 4)
          }\n` +
          (config.description
            ? `  ${C.key}description${C.reset}${C.muted}:${C.reset} ${config.description}\n`
            : "") +
          (config.module
            ? `  ${C.key}module${C.reset}${C.muted}:${C.reset} ${config.module}`
            : ""),
      );
    }

    const type = k.types.get(name);
    if (type) {
      sections.push(
        `${C.header}Type${C.reset} ${C.white}${type.name}${C.reset}\n` +
          (type.description
            ? `  ${C.key}description${C.reset}${C.muted}:${C.reset} ${type.description}\n`
            : "") +
          (type.module
            ? `  ${C.key}module${C.reset}${C.muted}:${C.reset} ${type.module}\n`
            : "") +
          `  ${C.key}fields${C.reset}${C.muted}:${C.reset}\n` +
          type.fields.map((f) =>
            `    ${C.white}${f.name}${C.reset}${C.muted}:${C.reset} ${f.type}${
              f.optional ? `${C.muted} (optional)${C.reset}` : ""
            }${f.description ? ` ${C.muted}— ${f.description}${C.reset}` : ""}`
          ).join("\n"),
      );
    }

    if (sections.length === 0) {
      return `${C.error}Not found: "${name}". Try find("${name}") to search.${C.reset}`;
    }
    return sections.join("\n\n");
  };
}

// --- run() ---

function buildRun(k: Kernel): (pattern?: string) => Promise<string> {
  return async (pattern?: string) => {
    let tests = k.tests.list();
    if (pattern) {
      const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(
        /\*/g,
        ".*",
      ).replace(/\?/g, ".");
      const regex = new RegExp("^" + escaped + "$");
      tests = tests.filter((t) => regex.test(t.name));
    }
    if (tests.length === 0) {
      return pattern
        ? `${C.muted}No tests matching "${pattern}"${C.reset}`
        : `${C.muted}No tests registered${C.reset}`;
    }

    const results: string[] = [];
    let passed = 0;
    let failed = 0;
    const ranAt = new Date().toISOString();
    const testTimeoutMs = getKernelSettings().testTimeoutMs;

    for (const test of tests) {
      const start = performance.now();
      let timerId: ReturnType<typeof setTimeout>;
      try {
        await Promise.race([
          test.fn(),
          new Promise<never>((_, reject) => {
            timerId = setTimeout(
              () =>
                reject(
                  new Error(
                    `Test timed out after ${
                      formatKernelTimeoutMs(testTimeoutMs)
                    }`,
                  ),
                ),
              testTimeoutMs,
            );
          }),
        ]);
        clearTimeout(timerId!);
        const ms = Math.round(performance.now() - start);
        passed++;
        k.tests.updateResult(test.name, {
          passed: true,
          durationMs: ms,
          ranAt,
        });
        results.push(
          `  \x1b[32m✓${C.reset} ${C.white}${test.name}${C.reset} ${C.muted}(${ms}ms)${C.reset}`,
        );
      } catch (err) {
        clearTimeout(timerId!);
        const ms = Math.round(performance.now() - start);
        const msg = err instanceof Error ? err.message : String(err);
        failed++;
        k.tests.updateResult(test.name, {
          passed: false,
          error: msg,
          durationMs: ms,
          ranAt,
        });
        results.push(
          `  \x1b[31m✗${C.reset} ${C.white}${test.name}${C.reset} ${C.muted}(${ms}ms)${C.reset}\n    ${C.error}${msg}${C.reset}`,
        );
      }
    }

    const summary = failed > 0
      ? `\x1b[31m${passed}/${tests.length} passed, ${failed} failed${C.reset}`
      : `\x1b[32m${passed}/${tests.length} passed${C.reset}`;
    return results.join("\n") + `\n\n${summary}`;
  };
}

// --- watch() ---

function buildWatch(
  k: Kernel,
): (expr: string, intervalMs?: number) => { stop: () => void } {
  return (expr: string, intervalMs = 2000) => {
    const ctx = {
      kernel: k,
      db: k.db,
      routes: k.routes,
      handlers: k.handlers,
      functions: k.functions,
      configs: k.configs,
      templates: k.templates,
      assets: k.assets,
      schemas: k.db,
      env: k.env,
      log: k.log,
      tests: k.tests,
      devViews: k.devViews,
      devTools: k.devTools,
      packages: k.packages,
    };
    const argNames = Object.keys(ctx);
    const argValues = Object.values(ctx);

    let running = true;
    let lastOutput = "";

    const tick = async () => {
      if (!running) return;
      try {
        const fn = new Function(
          ...argNames,
          `"use strict"; return (async () => { return (\n${expr}\n); })();`,
        );
        const result = await fn(...argValues);
        const output = formatValue(result);
        if (output !== lastOutput) {
          lastOutput = output;
          console.log(`${C.muted}[watch]${C.reset} ${output}`);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg !== lastOutput) {
          lastOutput = msg;
          console.log(`${C.muted}[watch]${C.reset} ${C.error}${msg}${C.reset}`);
        }
      }
      if (running) setTimeout(tick, intervalMs);
    };

    tick();

    return {
      stop() {
        running = false;
      },
      toString() {
        return `${C.muted}[Watching "${expr}" every ${intervalMs}ms — call .stop() to end]${C.reset}`;
      },
    };
  };
}

// --- find() ---

function buildFind(k: Kernel): (pattern: string) => string {
  return (pattern: string) => {
    const lower = pattern.toLowerCase();
    const results: string[] = [];

    for (const r of k.routes.list()) {
      if (
        r.path.toLowerCase().includes(lower) ||
        r.handlerName.toLowerCase().includes(lower)
      ) {
        results.push(
          `${C.muted}route${C.reset}    ${C.bold}${r.method}${C.reset} ${r.path} ${C.muted}→ ${r.handlerName}${C.reset}`,
        );
      }
    }
    for (const h of k.handlers.list()) {
      if (
        h.name.toLowerCase().includes(lower) ||
        h.source.toLowerCase().includes(lower)
      ) {
        results.push(
          `${C.muted}handler${C.reset}  ${C.white}${h.name}${C.reset}`,
        );
      }
    }
    for (const f of k.functions.list()) {
      if (
        f.name.toLowerCase().includes(lower) ||
        f.source.toLowerCase().includes(lower)
      ) {
        results.push(
          `${C.muted}func${C.reset}     ${C.func}${f.name}${C.reset}`,
        );
      }
    }
    for (const t of k.templates.list()) {
      if (
        t.name.toLowerCase().includes(lower) ||
        t.content.toLowerCase().includes(lower)
      ) {
        results.push(
          `${C.muted}template${C.reset} ${C.white}${t.name}${C.reset}`,
        );
      }
    }
    for (const a of k.assets.list()) {
      if (a.name.toLowerCase().includes(lower)) {
        results.push(
          `${C.muted}asset${C.reset}    ${C.white}${a.name}${C.reset} ${C.muted}(${a.mimeType})${C.reset}`,
        );
      }
    }
    for (const t of k.tests.list()) {
      if (
        t.name.toLowerCase().includes(lower) ||
        t.source.toLowerCase().includes(lower)
      ) {
        results.push(
          `${C.muted}test${C.reset}     ${C.white}${t.name}${C.reset}`,
        );
      }
    }
    for (const c of k.configs.list()) {
      if (c.name.toLowerCase().includes(lower)) {
        results.push(
          `${C.muted}config${C.reset}   ${C.key}${c.name}${C.reset}`,
        );
      }
    }
    for (const t of k.types.list()) {
      if (t.name.toLowerCase().includes(lower)) {
        results.push(
          `${C.muted}type${C.reset}     ${C.white}${t.name}${C.reset}`,
        );
      }
    }

    if (results.length === 0) {
      return `${C.muted}No matches for "${pattern}"${C.reset}`;
    }
    return results.join("\n");
  };
}

// --- source() ---

function buildSource(k: Kernel): (name: string) => string {
  return (name: string) => {
    const handler = k.handlers.list().find((h) => h.name === name);
    if (handler) return highlightSource(handler.source);

    const fn = k.functions.list().find((f) => f.name === name);
    if (fn) return highlightSource(fn.source);

    const tmpl = k.templates.list().find((t) => t.name === name);
    if (tmpl) return tmpl.content;

    const test = k.tests.list().find((t) => t.name === name);
    if (test) return highlightSource(test.source);

    return `${C.error}Not found: "${name}". Try find("${name}") to search.${C.reset}`;
  };
}

// --- help() ---

function showHelp(): string {
  return `${C.header}REPL Helpers${C.reset}

${C.bold}Exploration${C.reset}
  ${C.white}ls()${C.reset}               List all registered entities
  ${C.white}ls("filter")${C.reset}       Filter entities by name
  ${C.white}ls.routes()${C.reset}        List routes only (also: handlers, functions, templates,
                     assets, tests, configs, types, devViews, devTools)
  ${C.white}modules()${C.reset}          List all modules
  ${C.white}find("pattern")${C.reset}    Search across all registries
  ${C.white}get("name")${C.reset}        Show full details for an entity by name
  ${C.white}source("name")${C.reset}     Show source code for a handler/function/template/test

${C.bold}Data${C.reset}
  ${C.white}await tables()${C.reset}     List all database tables with row counts
  ${C.white}await sql("...")${C.reset}   Execute SQL and display results as a table
  ${C.white}dump(value)${C.reset}        Pretty-print any value (deep)
  ${C.white}dump(value, 10)${C.reset}    Pretty-print with custom depth
  ${C.white}last${C.reset}               The result of the previous evaluation

${C.bold}Testing${C.reset}
  ${C.white}await run()${C.reset}        Run all tests
  ${C.white}await run("name")${C.reset}  Run tests matching pattern (supports * and ? globs)

${C.bold}Live${C.reset}
  ${C.white}watch(expr, ms)${C.reset}    Watch an expression, log when it changes (default 2s)
  ${C.white}w.stop()${C.reset}           Stop a watcher (w = watch(...))

${C.bold}Agent${C.reset}
  ${C.white}ask("...")${C.reset}         Ask the AI agent a question (streams response)

${C.bold}Objects${C.reset}
  ${C.white}kernel${C.reset}  ${C.white}db${C.reset}  ${C.white}routes${C.reset}  ${C.white}handlers${C.reset}  ${C.white}functions${C.reset}  ${C.white}configs${C.reset}  ${C.white}templates${C.reset}
  ${C.white}assets${C.reset}  ${C.white}env${C.reset}  ${C.white}log${C.reset}  ${C.white}tests${C.reset}  ${C.white}devViews${C.reset}  ${C.white}devTools${C.reset}  ${C.white}packages${C.reset}

${C.bold}Magic Commands${C.reset}
  ${C.white}.help${C.reset}              Show this help
  ${C.white}.clear${C.reset}             Clear the terminal
  ${C.white}.history${C.reset}           Show command history
  ${C.white}.! <cmd>${C.reset}           Run a shell command`;
}

// --- Syntax highlighting for source code ---

function highlightSource(source: string): string {
  const keywords =
    /\b(const|let|var|function|return|if|else|for|while|do|switch|case|break|continue|try|catch|finally|throw|new|delete|typeof|instanceof|in|of|class|extends|import|export|from|default|async|await|yield|this|super|void|null|undefined|true|false)\b/g;
  const strings = /(["'`])(?:(?=(\\?))\2.)*?\1/g;
  const comments = /(\/\/.*$|\/\*[\s\S]*?\*\/)/gm;
  const numbers = /\b(\d+\.?\d*)\b/g;

  const tokens: Array<{ start: number; end: number; color: string }> = [];

  for (const m of source.matchAll(comments)) {
    tokens.push({
      start: m.index!,
      end: m.index! + m[0].length,
      color: C.muted,
    });
  }
  for (const m of source.matchAll(strings)) {
    tokens.push({
      start: m.index!,
      end: m.index! + m[0].length,
      color: C.string,
    });
  }
  for (const m of source.matchAll(keywords)) {
    if (!tokens.some((t) => m.index! >= t.start && m.index! < t.end)) {
      tokens.push({
        start: m.index!,
        end: m.index! + m[0].length,
        color: "\x1b[35m",
      });
    }
  }
  for (const m of source.matchAll(numbers)) {
    if (!tokens.some((t) => m.index! >= t.start && m.index! < t.end)) {
      tokens.push({
        start: m.index!,
        end: m.index! + m[0].length,
        color: C.number,
      });
    }
  }

  tokens.sort((a, b) => a.start - b.start);

  let result = "";
  let pos = 0;
  for (const tok of tokens) {
    if (tok.start > pos) result += source.slice(pos, tok.start);
    result += tok.color + source.slice(tok.start, tok.end) + C.reset;
    pos = tok.end;
  }
  if (pos < source.length) result += source.slice(pos);
  return result;
}

// --- Formatting with syntax highlighting ---

function formatValue(value: unknown, depth = 0, maxDepth = 3): string {
  if (depth > maxDepth) return `${C.muted}[...]${C.reset}`;
  if (value === STREAMED) return "";
  if (value === undefined) return `${C.null}undefined${C.reset}`;
  if (value === null) return `${C.null}null${C.reset}`;
  if (typeof value === "string") {
    return depth === 0
      ? value
      : `${C.string}${JSON.stringify(value)}${C.reset}`;
  }
  if (typeof value === "number") return `${C.number}${value}${C.reset}`;
  if (typeof value === "boolean") return `${C.boolean}${value}${C.reset}`;
  if (typeof value === "function") {
    return `${C.func}[Function: ${value.name || "anonymous"}]${C.reset}`;
  }
  if (value instanceof Error) {
    return `${C.error}${value.stack ?? value.message}${C.reset}`;
  }
  if (value instanceof Date) return `${C.date}${value.toISOString()}${C.reset}`;
  if (value instanceof RegExp) return `${C.number}${String(value)}${C.reset}`;

  if (Array.isArray(value)) {
    if (value.length === 0) return `${C.bracket}[]${C.reset}`;
    if (value.length > 20) {
      const items = value.slice(0, 20).map((v) =>
        formatValue(v, depth + 1, maxDepth)
      );
      return `${C.bracket}[${C.reset} ${
        items.join(`${C.muted},${C.reset} `)
      }, ${C.muted}... ${
        value.length - 20
      } more${C.reset} ${C.bracket}]${C.reset}`;
    }
    const items = value.map((v) => formatValue(v, depth + 1, maxDepth));
    const oneLine = `${C.bracket}[${C.reset} ${
      items.join(`${C.muted},${C.reset} `)
    } ${C.bracket}]${C.reset}`;
    if (stripAnsi(oneLine).length < 80) return oneLine;
    const indent = "  ".repeat(depth + 1);
    return `${C.bracket}[${C.reset}\n${
      items.map((i) => indent + i).join(`${C.muted},${C.reset}\n`)
    }\n${"  ".repeat(depth)}${C.bracket}]${C.reset}`;
  }

  if (typeof value === "object") {
    try {
      const entries = Object.entries(value as Record<string, unknown>);
      if (entries.length === 0) return `${C.bracket}{}${C.reset}`;
      if (entries.length > 20) {
        const items = entries.slice(0, 20).map(([k, v]) =>
          `${C.key}${k}${C.reset}${C.muted}:${C.reset} ${
            formatValue(v, depth + 1, maxDepth)
          }`
        );
        return `${C.bracket}{${C.reset} ${
          items.join(`${C.muted},${C.reset} `)
        }, ${C.muted}... ${
          entries.length - 20
        } more${C.reset} ${C.bracket}}${C.reset}`;
      }
      const items = entries.map(([k, v]) =>
        `${C.key}${k}${C.reset}${C.muted}:${C.reset} ${
          formatValue(v, depth + 1, maxDepth)
        }`
      );
      const oneLine = `${C.bracket}{${C.reset} ${
        items.join(`${C.muted},${C.reset} `)
      } ${C.bracket}}${C.reset}`;
      if (stripAnsi(oneLine).length < 80) return oneLine;
      const indent = "  ".repeat(depth + 1);
      return `${C.bracket}{${C.reset}\n${
        items.map((i) => indent + i).join(`${C.muted},${C.reset}\n`)
      }\n${"  ".repeat(depth)}${C.bracket}}${C.reset}`;
    } catch {
      return String(value);
    }
  }

  return String(value);
}

function stripAnsi(s: string): string {
  // deno-lint-ignore no-control-regex -- \x1b IS the escape character; that is the point of stripping ANSI
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

function truncate(s: string, len: number): string {
  return s.length > len ? s.slice(0, len - 3) + "..." : s;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
