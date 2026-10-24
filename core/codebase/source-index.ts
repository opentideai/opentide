import { join, relative } from "node:path";
import * as ts from "typescript";
import {
  type CodeFile,
  type CodeModule,
  type CodeSymbol,
  edgeSemanticId,
  fileSemanticId,
  type SemanticContribution,
  type SemanticEdge,
  semanticId,
  type SourceLanguage,
  symbolSemanticId,
  type TestSemantic,
} from "./types.ts";
import type { TsJsProjectDiscovery } from "./discovery.ts";

export interface TsJsSourceFile {
  path: string;
  language: SourceLanguage;
  sizeBytes: number;
  content: string;
}

export interface TsJsSourceIndex {
  rootPath: string;
  files: TsJsSourceFile[];
  ignoredDirs: string[];
}

export interface TsJsSourceIndexOptions {
  maxFiles?: number;
  maxFileBytes?: number;
}

const DEFAULT_MAX_FILES = 2000;
// The per-file byte cap. Exported so the document store (core/documents.ts) reuses
// the same convention rather than forking a parallel `512 * 1024` constant
// (docs/document-store-plan.md §4/§13 — align conventions across the two file
// subsystems).
export const DEFAULT_MAX_FILE_BYTES = 512 * 1024;

const DEFAULT_IGNORED_DIRS = new Set([
  ".git",
  ".opentide",
  "node_modules",
  "dist",
  "build",
  "coverage",
  ".next",
  ".svelte-kit",
  ".turbo",
  ".cache",
  "out",
]);

const RESOLUTION_EXTENSIONS = [
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
];

export async function indexTsJsSource(
  rootPath: string,
  discovery?: TsJsProjectDiscovery,
  options: TsJsSourceIndexOptions = {},
): Promise<TsJsSourceIndex> {
  const ignoredDirs = new Set([
    ...DEFAULT_IGNORED_DIRS,
    ...(discovery?.ignoredDirs ?? []),
  ]);
  const files: TsJsSourceFile[] = [];
  const maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES;
  const maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;

  await collectSourceFiles(rootPath, rootPath, ignoredDirs, files, {
    maxFiles,
    maxFileBytes,
  });

  return {
    rootPath,
    files: files.toSorted((a, b) => a.path.localeCompare(b.path)),
    ignoredDirs: [...ignoredDirs].toSorted(),
  };
}

export function sourceIndexContribution(
  pluginId: string,
  index: TsJsSourceIndex,
): SemanticContribution {
  const files: CodeFile[] = [];
  const modules: CodeModule[] = [];
  const symbols: CodeSymbol[] = [];
  const edges: SemanticEdge[] = [];
  const symbolIdsByFile = new Map<string, Set<string>>();
  const exportedSymbolIdsByFile = new Map<string, Set<string>>();
  const filePathSet = new Set(index.files.map((file) => file.path));

  for (const file of index.files) {
    const fileId = fileSemanticId(file.path);
    const moduleId = moduleSemanticId(file.path);
    const sourceFile = ts.createSourceFile(
      file.path,
      file.content,
      ts.ScriptTarget.Latest,
      true,
      scriptKindForLanguage(file.language),
    );
    const extracted = extractFileSemantics(pluginId, file, sourceFile);

    files.push({
      id: fileId,
      kind: "file",
      name: file.path.split("/").at(-1) ?? file.path,
      path: file.path,
      language: file.language,
      sizeBytes: file.sizeBytes,
      source: {
        pluginId,
        ruleId: "source-file",
        method: "ts-language-service",
        inferred: false,
      },
      confidence: 1,
      locations: [{ file: file.path, startLine: 1, startColumn: 1 }],
    });

    const fileSymbolIds = new Set(extracted.symbols.map((symbol) => symbol.id));
    const fileExportIds = new Set(
      extracted.symbols.filter((symbol) => symbol.exported).map((symbol) =>
        symbol.id
      ),
    );
    symbolIdsByFile.set(file.path, fileSymbolIds);
    exportedSymbolIdsByFile.set(file.path, fileExportIds);
    symbols.push(...extracted.symbols);

    for (const symbol of extracted.symbols) {
      edges.push({
        id: edgeSemanticId("defines", moduleId, symbol.id),
        type: "defines",
        sourceId: moduleId,
        targetId: symbol.id,
        source: {
          pluginId,
          ruleId: "top-level-symbol",
          method: "ast",
          inferred: false,
        },
        confidence: 0.95,
        locations: symbol.locations,
      });
      if (symbol.exported) {
        edges.push({
          id: edgeSemanticId("exports", moduleId, symbol.id),
          type: "exports",
          sourceId: moduleId,
          targetId: symbol.id,
          source: {
            pluginId,
            ruleId: "exported-symbol",
            method: "ast",
            inferred: false,
          },
          confidence: 0.95,
          locations: symbol.locations,
        });
      }
    }
  }

  for (const file of index.files) {
    const sourceFile = ts.createSourceFile(
      file.path,
      file.content,
      ts.ScriptTarget.Latest,
      true,
      scriptKindForLanguage(file.language),
    );
    const moduleId = moduleSemanticId(file.path);
    const importIds = new Set<string>();
    const exportIds = exportedSymbolIdsByFile.get(file.path) ?? new Set();

    for (const specifier of extractImportSpecifiers(sourceFile)) {
      const resolved = resolveRelativeImport(file.path, specifier, filePathSet);
      if (!resolved) continue;
      const targetFileId = fileSemanticId(resolved);
      importIds.add(targetFileId);
      edges.push({
        id: edgeSemanticId("imports", moduleId, targetFileId),
        type: "imports",
        sourceId: moduleId,
        targetId: targetFileId,
        source: {
          pluginId,
          ruleId: "relative-import",
          method: "ast",
          inferred: false,
        },
        confidence: 0.9,
      });
    }

    for (const specifier of extractReExportSpecifiers(sourceFile)) {
      const resolved = resolveRelativeImport(file.path, specifier, filePathSet);
      if (!resolved) continue;
      const targetFileId = fileSemanticId(resolved);
      edges.push({
        id: edgeSemanticId("exports", moduleId, targetFileId),
        type: "exports",
        sourceId: moduleId,
        targetId: targetFileId,
        source: {
          pluginId,
          ruleId: "re-export",
          method: "ast",
          inferred: false,
        },
        confidence: 0.85,
      });
    }

    modules.push({
      id: moduleId,
      kind: "module",
      name: file.path,
      file: file.path,
      importIds: [...importIds].toSorted(),
      exportIds: [...exportIds].toSorted(),
      source: {
        pluginId,
        ruleId: "source-module",
        method: "ts-language-service",
        inferred: false,
      },
      confidence: 1,
      locations: [{ file: file.path, startLine: 1, startColumn: 1 }],
    });
  }

  const tests = extractTests(pluginId, index, modules, edges);

  return {
    pluginId,
    files,
    modules,
    symbols,
    tests,
    edges,
  };
}

// A file is a test file if its name follows a common unit-test convention
// (`*_test.*` Deno, `*.test.*`/`*.spec.*` Jest/Vitest) or it lives under a
// `__tests__` directory. Kept deliberately broad so related-test selection has
// something to walk regardless of the imported project's test runner.
export function isTestFilePath(path: string): boolean {
  const name = path.split("/").at(-1) ?? path;
  if (/(?:[._-])(?:test|spec)\.[cm]?[jt]sx?$/i.test(name)) return true;
  return path.split("/").includes("__tests__");
}

// Derives TestSemantic nodes from the source index: each test file becomes a test
// node whose `targetIds` are the (non-test) source files it imports — resolved from
// the already-computed module import graph — plus a `tested-by` edge from each
// target file to the test. This is what related-test selection walks. Pure over the
// index + already-built modules; adds tested-by edges to the shared `edges` list.
function extractTests(
  pluginId: string,
  index: TsJsSourceIndex,
  modules: CodeModule[],
  edges: SemanticEdge[],
): TestSemantic[] {
  const testFiles = index.files.filter((file) => isTestFilePath(file.path));
  if (testFiles.length === 0) return [];

  const testFileIds = new Set(
    testFiles.map((file) => fileSemanticId(file.path)),
  );
  const moduleByFile = new Map(modules.map((module) => [module.file, module]));
  const tests: TestSemantic[] = [];

  for (const file of testFiles) {
    const testId = semanticId("test", file.path);
    const module = moduleByFile.get(file.path);
    // Import target file ids the module already resolved, minus other test files
    // and any self-reference — the concrete source files this test exercises.
    const targetIds = (module?.importIds ?? [])
      .filter((id) => !testFileIds.has(id))
      .toSorted();

    for (const targetId of targetIds) {
      edges.push({
        id: edgeSemanticId("tested-by", targetId, testId),
        type: "tested-by",
        sourceId: targetId,
        targetId: testId,
        source: {
          pluginId,
          ruleId: "test-import",
          method: "ast",
          inferred: true,
        },
        confidence: 0.7,
      });
    }

    tests.push({
      id: testId,
      kind: "test",
      name: file.path.split("/").at(-1) ?? file.path,
      language: file.language,
      file: file.path,
      targetIds,
      source: {
        pluginId,
        ruleId: "test-file",
        method: "ast",
        inferred: false,
      },
      confidence: 0.9,
      locations: [{ file: file.path, startLine: 1, startColumn: 1 }],
    });
  }

  return tests.toSorted((a, b) => a.id.localeCompare(b.id));
}

function moduleSemanticId(path: string): string {
  return semanticId("module", path);
}

async function collectSourceFiles(
  rootPath: string,
  dir: string,
  ignoredDirs: Set<string>,
  files: TsJsSourceFile[],
  options: Required<TsJsSourceIndexOptions>,
): Promise<void> {
  if (files.length >= options.maxFiles) return;
  let entries: Deno.DirEntry[];
  try {
    entries = [];
    for await (const entry of Deno.readDir(dir)) entries.push(entry);
  } catch {
    return;
  }

  for (
    const entry of entries.toSorted((a, b) => a.name.localeCompare(b.name))
  ) {
    if (files.length >= options.maxFiles) return;
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory) {
      if (ignoredDirs.has(entry.name)) continue;
      await collectSourceFiles(rootPath, fullPath, ignoredDirs, files, options);
      continue;
    }
    if (!entry.isFile) continue;
    const language = languageForPath(entry.name);
    if (language === "unknown") continue;
    const stat = await Deno.stat(fullPath).catch(() => null);
    if (!stat || stat.size > options.maxFileBytes) continue;
    const content = await Deno.readTextFile(fullPath).catch(() => null);
    if (content == null) continue;
    files.push({
      path: normalizeRelativePath(relative(rootPath, fullPath)),
      language,
      sizeBytes: stat.size,
      content,
    });
  }
}

function extractFileSemantics(
  pluginId: string,
  file: TsJsSourceFile,
  sourceFile: ts.SourceFile,
): { symbols: CodeSymbol[] } {
  const symbols: CodeSymbol[] = [];
  const exportedNames = collectNamedExports(sourceFile);

  for (const statement of sourceFile.statements) {
    if (ts.isVariableStatement(statement)) {
      for (
        const symbol of variableSymbolsFromStatement(
          pluginId,
          file,
          sourceFile,
          statement,
        )
      ) {
        symbol.exported = symbol.exported || exportedNames.has(symbol.name);
        symbols.push(symbol);
      }
      continue;
    }

    const symbol = symbolFromStatement(pluginId, file, sourceFile, statement);
    if (!symbol) continue;
    symbol.exported = symbol.exported || exportedNames.has(symbol.name);
    symbols.push(symbol);
  }

  return { symbols };
}

function symbolFromStatement(
  pluginId: string,
  file: TsJsSourceFile,
  sourceFile: ts.SourceFile,
  statement: ts.Statement,
): CodeSymbol | null {
  if (ts.isFunctionDeclaration(statement) && statement.name) {
    return codeSymbol(
      pluginId,
      file,
      sourceFile,
      statement,
      statement.name.text,
      "function",
    );
  }
  if (ts.isFunctionDeclaration(statement) && hasDefaultModifier(statement)) {
    return codeSymbol(
      pluginId,
      file,
      sourceFile,
      statement,
      "default",
      "function",
      true,
    );
  }
  if (ts.isClassDeclaration(statement) && statement.name) {
    return codeSymbol(
      pluginId,
      file,
      sourceFile,
      statement,
      statement.name.text,
      "class",
    );
  }
  if (ts.isClassDeclaration(statement) && hasDefaultModifier(statement)) {
    return codeSymbol(
      pluginId,
      file,
      sourceFile,
      statement,
      "default",
      "class",
      true,
    );
  }
  if (ts.isInterfaceDeclaration(statement)) {
    return codeSymbol(
      pluginId,
      file,
      sourceFile,
      statement,
      statement.name.text,
      "interface",
    );
  }
  if (ts.isTypeAliasDeclaration(statement)) {
    return codeSymbol(
      pluginId,
      file,
      sourceFile,
      statement,
      statement.name.text,
      "type",
    );
  }
  if (ts.isEnumDeclaration(statement)) {
    return codeSymbol(
      pluginId,
      file,
      sourceFile,
      statement,
      statement.name.text,
      "enum",
    );
  }
  if (isCommonJsExportAssignment(statement)) {
    const name = commonJsExportName(statement);
    if (name) {
      return codeSymbol(
        pluginId,
        file,
        sourceFile,
        statement,
        name,
        "variable",
        true,
      );
    }
  }
  if (ts.isExportAssignment(statement)) {
    if (ts.isIdentifier(statement.expression)) return null;
    const name = defaultExportName(statement.expression);
    return codeSymbol(
      pluginId,
      file,
      sourceFile,
      statement,
      name,
      defaultExportKind(statement.expression),
      true,
    );
  }
  return null;
}

function isRequireCall(expr: ts.Expression): boolean {
  return ts.isCallExpression(expr) &&
    ts.isIdentifier(expr.expression) &&
    expr.expression.text === "require" &&
    expr.arguments.length === 1;
}

function variableSymbolsFromStatement(
  pluginId: string,
  file: TsJsSourceFile,
  sourceFile: ts.SourceFile,
  statement: ts.VariableStatement,
): CodeSymbol[] {
  const symbols: CodeSymbol[] = [];
  const forceExported = hasExportModifier(statement);
  for (const declaration of statement.declarationList.declarations) {
    if (declaration.initializer && isRequireCall(declaration.initializer)) {
      continue;
    }
    if (!ts.isIdentifier(declaration.name)) continue;
    symbols.push(
      codeSymbol(
        pluginId,
        file,
        sourceFile,
        declaration,
        declaration.name.text,
        "variable",
        forceExported,
      ),
    );
  }
  return symbols;
}

function codeSymbol(
  pluginId: string,
  file: TsJsSourceFile,
  sourceFile: ts.SourceFile,
  node: ts.Node,
  name: string,
  symbolKind: CodeSymbol["symbolKind"],
  forceExported = false,
): CodeSymbol {
  const start = sourceFile.getLineAndCharacterOfPosition(
    node.getStart(sourceFile),
  );
  const end = sourceFile.getLineAndCharacterOfPosition(node.getEnd());
  const decorators = decoratorNames(node);
  return {
    id: symbolSemanticId(file.path, name),
    kind: "symbol",
    name,
    symbolKind,
    file: file.path,
    exported: forceExported || hasExportModifier(node),
    ...(decorators ? { decorators } : {}),
    source: {
      pluginId,
      ruleId: "top-level-symbol",
      method: "ast",
      inferred: false,
    },
    confidence: 0.95,
    locations: [{
      file: file.path,
      startLine: start.line + 1,
      startColumn: start.character + 1,
      endLine: end.line + 1,
      endColumn: end.character + 1,
    }],
  };
}

/** Names of decorators applied to a node, e.g. `@Component()` → "Component". */
function decoratorNames(node: ts.Node): string[] | undefined {
  if (!ts.canHaveDecorators(node)) return undefined;
  const decorators = ts.getDecorators(node);
  if (!decorators || decorators.length === 0) return undefined;
  const names: string[] = [];
  for (const decorator of decorators) {
    const name = decoratorName(decorator.expression);
    if (name) names.push(name);
  }
  return names.length > 0 ? names : undefined;
}

function decoratorName(expr: ts.Expression): string | null {
  if (ts.isCallExpression(expr)) return decoratorName(expr.expression);
  if (ts.isIdentifier(expr)) return expr.text;
  if (ts.isPropertyAccessExpression(expr)) return expr.name.text;
  return null;
}

function collectNamedExports(sourceFile: ts.SourceFile): Set<string> {
  const names = new Set<string>();
  for (const statement of sourceFile.statements) {
    if (ts.isExportAssignment(statement)) {
      names.add(defaultExportName(statement.expression));
      continue;
    }
    if (!ts.isExportDeclaration(statement)) continue;
    const clause = statement.exportClause;
    if (!clause || !ts.isNamedExports(clause)) continue;
    for (const element of clause.elements) {
      names.add((element.propertyName ?? element.name).text);
    }
  }
  return names;
}

function extractImportSpecifiers(sourceFile: ts.SourceFile): string[] {
  const specifiers: string[] = [];
  for (const statement of sourceFile.statements) {
    if (
      ts.isImportDeclaration(statement) &&
      ts.isStringLiteral(statement.moduleSpecifier)
    ) {
      specifiers.push(statement.moduleSpecifier.text);
      continue;
    }
    if (
      ts.isExportDeclaration(statement) &&
      statement.moduleSpecifier &&
      ts.isStringLiteral(statement.moduleSpecifier)
    ) {
      specifiers.push(statement.moduleSpecifier.text);
      continue;
    }
    const requireSpecifier = requireSpecifierFromStatement(statement);
    if (requireSpecifier) specifiers.push(requireSpecifier);
  }
  collectDynamicImportSpecifiers(sourceFile, specifiers);
  return specifiers;
}

function extractReExportSpecifiers(sourceFile: ts.SourceFile): string[] {
  const specifiers: string[] = [];
  for (const statement of sourceFile.statements) {
    if (
      ts.isExportDeclaration(statement) &&
      statement.moduleSpecifier &&
      ts.isStringLiteral(statement.moduleSpecifier)
    ) {
      specifiers.push(statement.moduleSpecifier.text);
    }
  }
  return specifiers;
}

function collectDynamicImportSpecifiers(
  sourceFile: ts.SourceFile,
  specifiers: string[],
): void {
  function visit(node: ts.Node): void {
    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments.length === 1 &&
      node.arguments[0] &&
      ts.isStringLiteral(node.arguments[0])
    ) {
      specifiers.push(node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
}

function requireSpecifierFromStatement(statement: ts.Statement): string | null {
  if (!ts.isVariableStatement(statement)) return null;
  for (const declaration of statement.declarationList.declarations) {
    const init = declaration.initializer;
    const arg = init && ts.isCallExpression(init)
      ? init.arguments[0]
      : undefined;
    if (
      init &&
      ts.isCallExpression(init) &&
      ts.isIdentifier(init.expression) &&
      init.expression.text === "require" &&
      init.arguments.length === 1 &&
      arg &&
      ts.isStringLiteral(arg)
    ) {
      return arg.text;
    }
  }
  return null;
}

function resolveRelativeImport(
  fromFile: string,
  specifier: string,
  filePathSet: Set<string>,
): string | null {
  if (!specifier.startsWith(".")) return null;
  const fromDir = fromFile.split("/").slice(0, -1).join("/");
  const base = normalizeRelativePath(join(fromDir, specifier));
  const candidates = [
    base,
    ...RESOLUTION_EXTENSIONS.map((ext) => `${base}${ext}`),
    ...RESOLUTION_EXTENSIONS.map((ext) => `${base}/index${ext}`),
  ];
  return candidates.find((candidate) => filePathSet.has(candidate)) ?? null;
}

function hasExportModifier(node: ts.Node): boolean {
  return ts.canHaveModifiers(node) &&
    !!ts.getModifiers(node)?.some((modifier) =>
      modifier.kind === ts.SyntaxKind.ExportKeyword
    );
}

function hasDefaultModifier(node: ts.Node): boolean {
  return ts.canHaveModifiers(node) &&
    !!ts.getModifiers(node)?.some((modifier) =>
      modifier.kind === ts.SyntaxKind.DefaultKeyword
    );
}

function isCommonJsExportAssignment(statement: ts.Statement): boolean {
  return ts.isExpressionStatement(statement) &&
    ts.isBinaryExpression(statement.expression) &&
    statement.expression.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
    isCommonJsExportExpression(statement.expression.left);
}

function commonJsExportName(statement: ts.Statement): string | null {
  if (
    !ts.isExpressionStatement(statement) ||
    !ts.isBinaryExpression(statement.expression)
  ) {
    return null;
  }
  const left = statement.expression.left;
  if (ts.isPropertyAccessExpression(left)) {
    const text = left.getText();
    if (text === "module.exports") return "module.exports";
    return left.name.text;
  }
  return "module.exports";
}

function defaultExportName(expr: ts.Expression): string {
  if (
    (ts.isFunctionExpression(expr) || ts.isClassExpression(expr)) &&
    expr.name
  ) {
    return expr.name.text;
  }
  if (ts.isIdentifier(expr)) return expr.text;
  return "default";
}

function defaultExportKind(expr: ts.Expression): CodeSymbol["symbolKind"] {
  if (ts.isFunctionExpression(expr) || ts.isArrowFunction(expr)) {
    return "function";
  }
  if (ts.isClassExpression(expr)) return "class";
  if (ts.isIdentifier(expr)) return "variable";
  return "variable";
}

function isCommonJsExportExpression(expr: ts.Expression): boolean {
  if (ts.isPropertyAccessExpression(expr)) {
    const text = expr.getText();
    return text === "module.exports" || text.startsWith("exports.") ||
      text.startsWith("module.exports.");
  }
  return false;
}

function languageForPath(path: string): SourceLanguage {
  if (path.endsWith(".tsx")) return "tsx";
  if (path.endsWith(".jsx")) return "jsx";
  if (path.endsWith(".ts")) return "typescript";
  if (path.endsWith(".js") || path.endsWith(".mjs") || path.endsWith(".cjs")) {
    return "javascript";
  }
  return "unknown";
}

function scriptKindForLanguage(language: SourceLanguage): ts.ScriptKind {
  switch (language) {
    case "tsx":
      return ts.ScriptKind.TSX;
    case "jsx":
      return ts.ScriptKind.JSX;
    case "javascript":
      return ts.ScriptKind.JS;
    case "typescript":
      return ts.ScriptKind.TS;
    default:
      return ts.ScriptKind.Unknown;
  }
}

function normalizeRelativePath(path: string): string {
  return path.replaceAll("\\", "/").replace(/^\.\//, "");
}
