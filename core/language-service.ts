import ts from "typescript";
import type { Kernel } from "./registries.ts";
import { PLATFORM_GLOBAL_DECLARATIONS } from "./platform-globals.ts";

interface VirtualFile {
  content: string;
  version: number;
}

export interface CompletionItem {
  label: string;
  kind: string;
  detail?: string;
  documentation?: string;
  sortText?: string;
}

export interface DiagnosticEntry {
  line: number;
  column: number;
  endLine?: number;
  endColumn?: number;
  message: string;
  severity: "error" | "warning" | "info" | "hint";
  code?: number;
}

export interface HoverResult {
  text: string;
  documentation?: string;
  range?: {
    startLine: number;
    startColumn: number;
    endLine: number;
    endColumn: number;
  };
}

export interface DefinitionResult {
  entityType: string;
  entityName: string;
  line: number;
  column: number;
}

export interface ReferenceResult {
  entityType: string;
  entityName: string;
  line: number;
  column: number;
  endLine: number;
  endColumn: number;
  lineText: string;
}

export interface HighlightRange {
  from: { line: number; column: number };
  to: { line: number; column: number };
  kind: "text" | "read" | "write";
}

export interface RenameLocation {
  entityType: string;
  entityName: string;
  line: number;
  column: number;
  endLine: number;
  endColumn: number;
}

const COMPLETION_KIND_MAP: Record<string, string> = {
  "function": "function",
  "method": "method",
  "property": "property",
  "local var": "variable",
  "var": "variable",
  "const": "constant",
  "let": "variable",
  "parameter": "parameter",
  "type": "type",
  "interface": "interface",
  "class": "class",
  "keyword": "keyword",
  "string": "text",
  "module": "module",
  "enum": "enum",
  "enum member": "enumMember",
};

// The virtual filesystem root every entity is mapped under. Exported so the LSP
// layer (lsp/uri.ts) can build/parse `opentide://` URIs against the SAME layout the
// service uses internally, instead of duplicating the path regex.
export const VIRTUAL_ROOT = "/_genie";

// Entity-type ⇄ folder-segment mapping. The virtual FS folders and the LSP URI
// path both use the plural form (`handlers`, `functions`, `tests`); the tools and
// registries speak the singular (`handler`). These two helpers are the single
// source of truth for that pluralization so the path and the URI cannot drift.
export function pluralizeEntityType(entityType: string): string {
  return entityType.endsWith("s") ? entityType : entityType + "s";
}

export function singularizeEntityType(plural: string): string {
  return plural.endsWith("s") ? plural.slice(0, -1) : plural;
}

export function entityPath(entityType: string, entityName: string): string {
  return `${VIRTUAL_ROOT}/${pluralizeEntityType(entityType)}/${entityName}.ts`;
}

export function parseEntityPath(
  path: string,
): { entityType: string; entityName: string } | null {
  const match = path.match(new RegExp(`^${VIRTUAL_ROOT}/(\\w+)/(.+)\\.ts$`));
  if (!match) return null;
  return {
    entityType: singularizeEntityType(match[1]!),
    entityName: match[2]!,
  };
}

function lineColumnToOffset(
  source: string,
  line: number,
  column: number,
): number {
  line = Math.max(1, line);
  column = Math.max(1, column);
  let offset = 0;
  const lines = source.split("\n");
  for (let i = 0; i < line - 1 && i < lines.length; i++) {
    offset += lines[i]!.length + 1;
  }
  return Math.min(offset + (column - 1), source.length);
}

function offsetToLineColumn(
  source: string,
  offset: number,
): { line: number; column: number } {
  let line = 1;
  let col = 1;
  for (let i = 0; i < offset && i < source.length; i++) {
    if (source[i] === "\n") {
      line++;
      col = 1;
    } else {
      col++;
    }
  }
  return { line, column: col };
}

export class GenieLanguageService {
  private files = new Map<string, VirtualFile>();
  private service: ts.LanguageService;
  private lastSyncVersion = -1;

  constructor() {
    const host: ts.LanguageServiceHost = {
      getScriptFileNames: () => [...this.files.keys()],
      getScriptVersion: (fileName) =>
        String(this.files.get(fileName)?.version ?? 0),
      getScriptSnapshot: (fileName) => {
        const file = this.files.get(fileName);
        if (file) return ts.ScriptSnapshot.fromString(file.content);
        if (ts.sys.fileExists(fileName)) {
          const content = ts.sys.readFile(fileName);
          if (content !== undefined) {
            return ts.ScriptSnapshot.fromString(content);
          }
        }
        return undefined;
      },
      getCurrentDirectory: () => "/",
      getCompilationSettings: () => ({
        target: ts.ScriptTarget.ESNext,
        module: ts.ModuleKind.None,
        strict: false,
        noImplicitAny: false,
        noUnusedLocals: false,
        noUnusedParameters: false,
        allowUnreachableCode: true,
        allowUnusedLabels: true,
        noEmit: true,
        skipLibCheck: true,
        lib: ["lib.esnext.d.ts"],
      }),
      getDefaultLibFileName: (options) => ts.getDefaultLibFilePath(options),
      fileExists: (fileName) =>
        this.files.has(fileName) || ts.sys.fileExists(fileName),
      readFile: (fileName) =>
        this.files.get(fileName)?.content ?? ts.sys.readFile(fileName),
      readDirectory: ts.sys.readDirectory,
      directoryExists: (dirName) => {
        if (dirName.startsWith(VIRTUAL_ROOT)) return true;
        return ts.sys.directoryExists(dirName);
      },
      getDirectories: ts.sys.getDirectories,
    };

    this.service = ts.createLanguageService(host, ts.createDocumentRegistry());
  }

  sync(kernel: Kernel, override?: { path: string; content: string }): void {
    const currentPaths = new Set<string>();

    this.updateFile(
      `${VIRTUAL_ROOT}/globals.d.ts`,
      this.generateGlobals(kernel),
    );
    currentPaths.add(`${VIRTUAL_ROOT}/globals.d.ts`);

    for (const h of kernel.handlers.list()) {
      const path = entityPath("handler", h.name);
      this.updateFile(
        path,
        override?.path === path ? override.content : h.source,
      );
      currentPaths.add(path);
    }

    for (const f of kernel.functions.list()) {
      const path = entityPath("function", f.name);
      this.updateFile(
        path,
        override?.path === path ? override.content : f.source,
      );
      currentPaths.add(path);
    }

    for (const t of kernel.tests.list()) {
      const path = entityPath("test", t.name);
      this.updateFile(
        path,
        override?.path === path ? override.content : t.source,
      );
      currentPaths.add(path);
    }

    if (override && !currentPaths.has(override.path)) {
      this.updateFile(override.path, override.content);
      currentPaths.add(override.path);
    }

    for (const [path] of this.files) {
      if (path !== `${VIRTUAL_ROOT}/globals.d.ts` && !currentPaths.has(path)) {
        this.files.delete(path);
      }
    }
  }

  private updateFile(path: string, content: string): void {
    const existing = this.files.get(path);
    if (existing && existing.content === content) return;
    this.files.set(path, {
      content,
      version: (existing?.version ?? 0) + 1,
    });
  }

  private generateGlobals(kernel: Kernel): string {
    const lines: string[] = [];

    lines.push("// Auto-generated Genie type declarations");
    lines.push("");

    // The fetch standard comes first: it is the handler ABI, and everything below
    // that mentions Request or Response depends on it being declared.
    lines.push(PLATFORM_GLOBAL_DECLARATIONS);

    // The legacy Hono context. Kept for handlers written before the fetch ABI, and
    // only for those: every handler in the measured field corpus is annotated
    // `(c: any)`, which swallows the annotation entirely, so this protects the ones
    // the scan could not see rather than the ones it could. Declaration only —
    // runtime back-compat is the shim in handler-abi.ts, not this.
    lines.push(
      "/** @deprecated Handlers take (req: Request, ctx: HandlerContext). */",
    );
    lines.push("interface Context {");
    lines.push("  req: {");
    lines.push("    method: string;");
    lines.push("    url: string;");
    lines.push("    path: string;");
    lines.push("    query(key: string): string | undefined;");
    lines.push("    queries(key: string): string[];");
    lines.push("    param(key: string): string;");
    lines.push("    header(name: string): string | undefined;");
    lines.push("    json<T = any>(): Promise<T>;");
    lines.push("    text(): Promise<string>;");
    lines.push("    arrayBuffer(): Promise<ArrayBuffer>;");
    lines.push("    raw: Request;");
    lines.push("    valid<T>(target: string): T;");
    lines.push("  };");
    lines.push("  json<T = any>(data: T, status?: number): Response;");
    lines.push("  text(text: string, status?: number): Response;");
    lines.push("  html(html: string, status?: number): Response;");
    lines.push("  redirect(url: string, status?: number): Response;");
    lines.push("  header(name: string, value: string): void;");
    lines.push("  set<T = any>(key: string, value: T): void;");
    lines.push("  get<T = any>(key: string): T;");
    lines.push("  status(code: number): void;");
    lines.push(
      "  body(data: BodyInit | null, status?: number, headers?: Record<string, string>): Response;",
    );
    lines.push("  notFound(): Response;");
    lines.push("}");
    lines.push("");

    // db
    lines.push("declare const db: {");
    lines.push(
      "  query(sql: string, params?: unknown[]): Promise<Record<string, unknown>[]>;",
    );
    lines.push(
      "  execute(sql: string, params?: unknown[]): Promise<{ changes: number }>;",
    );
    lines.push("};");
    lines.push("");

    // functions — with overloads for known functions
    lines.push("declare const functions: {");
    lines.push(
      "  get(name: string): ((...args: unknown[]) => unknown) | undefined;",
    );
    lines.push("  call(name: string, ...args: unknown[]): unknown;");
    lines.push("};");
    lines.push("");

    // config — the app's configuration values. Declared because the runtime provides
    // it to every handler, function and test (define_handler/define_test both say so),
    // but the ambient lib omitted it, so any entity that touched `config` type-checked
    // with "Cannot find name 'config'" while working perfectly at runtime.
    lines.push("declare const config: {");
    lines.push("  get(name: string): any;");
    lines.push("  set(name: string, value: any): void;");
    lines.push("  delete(name: string): boolean;");
    lines.push("};");
    lines.push("");

    // state — with overloads for known state keys
    lines.push("declare const state: {");
    lines.push("  get(name: string): unknown;");
    lines.push("  set(name: string, value: unknown): void;");
    lines.push("  delete(name: string): boolean;");
    lines.push("};");
    lines.push("");

    // templates
    lines.push("declare const templates: {");
    lines.push("  get(name: string): string | undefined;");
    lines.push("};");
    lines.push("");

    // packages — with known installed packages
    const packageNames = kernel.packages.list().map((p) => p.name);
    if (packageNames.length > 0) {
      lines.push("declare const packages: {");
      for (const name of packageNames) {
        const safeName = name.replace(/[^a-zA-Z0-9_$]/g, "_");
        lines.push(`  readonly ${safeName}: any;`);
      }
      lines.push("  [key: string]: any;");
      lines.push("};");
    } else {
      lines.push("declare const packages: Record<string, any>;");
    }
    lines.push("");

    // env
    const envKeys = kernel.env.list().map((e) => e.name);
    if (envKeys.length > 0) {
      lines.push("declare const env: {");
      for (const key of envKeys) {
        const safeKey = key.replace(/[^a-zA-Z0-9_$]/g, "_");
        lines.push(`  readonly ${safeKey}: string;`);
      }
      lines.push("  [key: string]: string;");
      lines.push("};");
    } else {
      lines.push("declare const env: Record<string, string>;");
    }
    lines.push("");

    // Test assertion helpers (available in test files)
    lines.push(
      "declare function assert(condition: unknown, message?: string): void;",
    );
    lines.push(
      "declare function assertEquals(actual: unknown, expected: unknown, message?: string): void;",
    );
    lines.push(
      "declare function assertNotEquals(actual: unknown, expected: unknown, message?: string): void;",
    );
    lines.push(
      "declare function assertThrows(fn: () => unknown, message?: string): void;",
    );
    lines.push(
      "declare function assertRejects(fn: () => Promise<unknown>, message?: string): Promise<void>;",
    );
    // The rest of the compiler's scope (core/reserved-names.ts). define_test promises
    // appUrl/getAppPort, and every entity gets assertNever; undeclared, each was TS2304.
    lines.push("declare function appUrl(path?: string): string;");
    lines.push("declare function getAppPort(): number;");
    lines.push("declare function assertNever(x: never): never;");
    lines.push("");

    // log (available in scripts)
    lines.push("declare const log: {");
    lines.push("  (...args: unknown[]): void;");
    lines.push("  debug(...args: unknown[]): void;");
    lines.push("  info(...args: unknown[]): void;");
    lines.push("  warn(...args: unknown[]): void;");
    lines.push("  error(...args: unknown[]): void;");
    lines.push("};");

    return lines.join("\n");
  }

  getCompletions(
    entityType: string,
    entityName: string,
    line: number,
    column: number,
    kernel: Kernel,
    content?: string,
  ): CompletionItem[] {
    const path = entityPath(entityType, entityName);
    this.sync(kernel, content ? { path, content } : undefined);

    const file = this.files.get(path);
    if (!file) return [];

    const offset = lineColumnToOffset(file.content, line, column);
    const info = this.service.getCompletionsAtPosition(path, offset, {
      includeCompletionsForModuleExports: false,
      includeCompletionsWithInsertText: true,
    });
    if (!info) return [];

    return info.entries.slice(0, 100).map((entry) => {
      let details: ts.CompletionEntryDetails | undefined;
      try {
        details = this.service.getCompletionEntryDetails(
          path,
          offset,
          entry.name,
          undefined,
          undefined,
          undefined,
          undefined,
        );
      } catch {
        details = undefined;
      }
      return {
        label: entry.name,
        kind: COMPLETION_KIND_MAP[entry.kind] ?? entry.kind,
        detail: details
          ? ts.displayPartsToString(details.displayParts)
          : undefined,
        documentation: details?.documentation
          ? ts.displayPartsToString(details.documentation)
          : undefined,
        sortText: entry.sortText,
      };
    });
  }

  getDiagnostics(
    entityType: string,
    entityName: string,
    kernel: Kernel,
    content?: string,
  ): DiagnosticEntry[] {
    const path = entityPath(entityType, entityName);
    this.sync(kernel, content ? { path, content } : undefined);
    if (!this.files.has(path)) return [];

    const syntactic = this.service.getSyntacticDiagnostics(path);
    const semantic = this.service.getSemanticDiagnostics(path);
    const all = [...syntactic, ...semantic];

    const source = this.files.get(path)!.content;

    return all.map((d) => {
      const start = d.start ?? 0;
      const length = d.length ?? 0;
      const startPos = offsetToLineColumn(source, start);
      const endPos = offsetToLineColumn(source, start + length);

      let severity: DiagnosticEntry["severity"];
      switch (d.category) {
        case ts.DiagnosticCategory.Error:
          severity = "error";
          break;
        case ts.DiagnosticCategory.Warning:
          severity = "warning";
          break;
        case ts.DiagnosticCategory.Suggestion:
          severity = "hint";
          break;
        default:
          severity = "info";
      }

      return {
        line: startPos.line,
        column: startPos.column,
        endLine: endPos.line,
        endColumn: endPos.column,
        message: ts.flattenDiagnosticMessageText(d.messageText, "\n"),
        severity,
        code: d.code,
      };
    });
  }

  getHoverInfo(
    entityType: string,
    entityName: string,
    line: number,
    column: number,
    kernel: Kernel,
    content?: string,
  ): HoverResult | null {
    const path = entityPath(entityType, entityName);
    this.sync(kernel, content ? { path, content } : undefined);
    const file = this.files.get(path);
    if (!file) return null;

    const offset = lineColumnToOffset(file.content, line, column);
    const info = this.service.getQuickInfoAtPosition(path, offset);
    if (!info) return null;

    const text = ts.displayPartsToString(info.displayParts);
    const documentation = info.documentation
      ? ts.displayPartsToString(info.documentation)
      : undefined;

    let range: HoverResult["range"];
    if (info.textSpan) {
      const start = offsetToLineColumn(file.content, info.textSpan.start);
      const end = offsetToLineColumn(
        file.content,
        info.textSpan.start + info.textSpan.length,
      );
      range = {
        startLine: start.line,
        startColumn: start.column,
        endLine: end.line,
        endColumn: end.column,
      };
    }

    return { text, documentation, range };
  }

  getDefinition(
    entityType: string,
    entityName: string,
    line: number,
    column: number,
    kernel: Kernel,
    content?: string,
  ): DefinitionResult[] {
    const path = entityPath(entityType, entityName);
    this.sync(kernel, content ? { path, content } : undefined);
    const file = this.files.get(path);
    if (!file) return [];

    const offset = lineColumnToOffset(file.content, line, column);
    const defs = this.service.getDefinitionAtPosition(path, offset);
    if (!defs) return [];

    const results: DefinitionResult[] = [];
    for (const def of defs) {
      const parsed = parseEntityPath(def.fileName);
      if (!parsed) continue;

      const targetFile = this.files.get(def.fileName);
      if (!targetFile) continue;

      const pos = offsetToLineColumn(targetFile.content, def.textSpan.start);
      results.push({
        entityType: parsed.entityType,
        entityName: parsed.entityName,
        line: pos.line,
        column: pos.column,
      });
    }

    return results;
  }

  getReferences(
    entityType: string,
    entityName: string,
    line: number,
    column: number,
    kernel: Kernel,
    content?: string,
  ): ReferenceResult[] {
    const path = entityPath(entityType, entityName);
    this.sync(kernel, content ? { path, content } : undefined);
    const file = this.files.get(path);
    if (!file) return [];

    const offset = lineColumnToOffset(file.content, line, column);
    const refs = this.service.getReferencesAtPosition(path, offset);
    if (!refs) return [];

    const results: ReferenceResult[] = [];
    for (const ref of refs) {
      const parsed = parseEntityPath(ref.fileName);
      if (!parsed) continue;

      const targetFile = this.files.get(ref.fileName);
      if (!targetFile) continue;

      const startPos = offsetToLineColumn(
        targetFile.content,
        ref.textSpan.start,
      );
      const endPos = offsetToLineColumn(
        targetFile.content,
        ref.textSpan.start + ref.textSpan.length,
      );
      const lines = targetFile.content.split("\n");
      const lineText = lines[startPos.line - 1] ?? "";

      results.push({
        entityType: parsed.entityType,
        entityName: parsed.entityName,
        line: startPos.line,
        column: startPos.column,
        endLine: endPos.line,
        endColumn: endPos.column,
        lineText: lineText.trim(),
      });
    }

    return results;
  }

  getDocumentHighlights(
    entityType: string,
    entityName: string,
    line: number,
    column: number,
    kernel: Kernel,
    content?: string,
  ): HighlightRange[] {
    const path = entityPath(entityType, entityName);
    this.sync(kernel, content ? { path, content } : undefined);
    const file = this.files.get(path);
    if (!file) return [];

    const offset = lineColumnToOffset(file.content, line, column);
    const highlights = this.service.getDocumentHighlights(path, offset, [path]);
    if (!highlights) return [];

    const results: HighlightRange[] = [];
    for (const group of highlights) {
      if (group.fileName !== path) continue;
      for (const span of group.highlightSpans) {
        const start = offsetToLineColumn(file.content, span.textSpan.start);
        const end = offsetToLineColumn(
          file.content,
          span.textSpan.start + span.textSpan.length,
        );
        let kind: HighlightRange["kind"] = "text";
        if (span.kind === ts.HighlightSpanKind.writtenReference) kind = "write";
        else if (span.kind === ts.HighlightSpanKind.reference) kind = "read";
        results.push({ from: start, to: end, kind });
      }
    }
    return results;
  }

  getRenameLocations(
    entityType: string,
    entityName: string,
    line: number,
    column: number,
    kernel: Kernel,
    content?: string,
  ): RenameLocation[] {
    const path = entityPath(entityType, entityName);
    this.sync(kernel, content ? { path, content } : undefined);
    const file = this.files.get(path);
    if (!file) return [];

    const offset = lineColumnToOffset(file.content, line, column);
    const locations = this.service.findRenameLocations(
      path,
      offset,
      false,
      false,
    );
    if (!locations) return [];

    const results: RenameLocation[] = [];
    for (const loc of locations) {
      const parsed = parseEntityPath(loc.fileName);
      if (!parsed) continue;
      const targetFile = this.files.get(loc.fileName);
      if (!targetFile) continue;

      const start = offsetToLineColumn(targetFile.content, loc.textSpan.start);
      const end = offsetToLineColumn(
        targetFile.content,
        loc.textSpan.start + loc.textSpan.length,
      );
      results.push({
        entityType: parsed.entityType,
        entityName: parsed.entityName,
        line: start.line,
        column: start.column,
        endLine: end.line,
        endColumn: end.column,
      });
    }
    return results;
  }

  dispose(): void {
    this.service.dispose();
  }
}

let _sharedInstance: GenieLanguageService | null = null;

export function getSharedLanguageService(): GenieLanguageService {
  if (!_sharedInstance) _sharedInstance = new GenieLanguageService();
  return _sharedInstance;
}
