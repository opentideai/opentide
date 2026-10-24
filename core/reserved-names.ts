// @layer core — the names an entity cannot take.
//
// A handler, function or test is compiled with the platform's own names already bound
// in its scope: as `new Function` parameters in the kernel (core/compiler.ts), and as
// imports from deps.ts in every exported module (core/export.ts wrapModule). An entity
// named after one of them declares a function that shadows the binding its own body
// reads, so it breaks in the preview and in the export alike.
//
// This is the ONLY list. The compiler builds its parameter lists from it and the
// export builds its deps.ts import line from it, so a name added to either scope is
// reserved by the same edit. The export's main.ts is deliberately NOT a source of
// reserved names: every entity binding there is `$`-prefixed (see export.ts
// entityBinding), so no generator identifier can collide with an entity name.

// In the order exported modules import them, so an export stays byte-identical to the
// ones before this list existed. The compiler binds by name; order is irrelevant there.
export const ENTITY_SCOPE_NAMES = [
  "db",
  "functions",
  "config",
  "packages",
  "env",
  "templates",
  "log",
  "assertNever",
] as const;

export type EntityScopeName = typeof ENTITY_SCOPE_NAMES[number];

// What a test gets on top of the entity scope.
export const TEST_ONLY_SCOPE_NAMES = [
  "getAppPort",
  "appUrl",
  "assert",
  "assertEquals",
  "assertNotEquals",
  "assertThrows",
  "assertRejects",
] as const;

export const TEST_SCOPE_NAMES = [
  ...ENTITY_SCOPE_NAMES,
  ...TEST_ONLY_SCOPE_NAMES,
] as const;

export type TestScopeName = typeof TEST_SCOPE_NAMES[number];

// Type names an exported module imports when its source mentions them. Ambient in the
// kernel, so the preview never notices; the export's `deno check` does.
export const EXPORT_TYPE_NAMES = ["HandlerContext", "Context"] as const;

// Strict-mode reserved words. `function delete()` is a syntax error anyway; refusing
// it by name says why instead of handing back a parser message.
export const JS_RESERVED_WORDS = [
  "arguments",
  "await",
  "break",
  "case",
  "catch",
  "class",
  "const",
  "continue",
  "debugger",
  "default",
  "delete",
  "do",
  "else",
  "enum",
  "eval",
  "export",
  "extends",
  "false",
  "finally",
  "for",
  "function",
  "if",
  "implements",
  "import",
  "in",
  "instanceof",
  "interface",
  "let",
  "new",
  "null",
  "package",
  "private",
  "protected",
  "public",
  "return",
  "static",
  "super",
  "switch",
  "this",
  "throw",
  "true",
  "try",
  "typeof",
  "var",
  "void",
  "while",
  "with",
  "yield",
] as const;

export type ReservedNameKind = "handler" | "function" | "test";

// The platform names reserved for one kind, without the JS reserved words.
export function platformReservedNames(kind: ReservedNameKind): string[] {
  return kind === "test"
    ? [...TEST_SCOPE_NAMES]
    : [...ENTITY_SCOPE_NAMES, ...EXPORT_TYPE_NAMES];
}

export function isReservedName(kind: ReservedNameKind, name: string): boolean {
  return platformReservedNames(kind).includes(name) ||
    (JS_RESERVED_WORDS as readonly string[]).includes(name);
}

export function reservedNameError(
  kind: ReservedNameKind,
  name: string,
): { code: "RESERVED_NAME"; message: string; suggestion: string } | null {
  if (!isReservedName(kind, name)) return null;
  const why = (JS_RESERVED_WORDS as readonly string[]).includes(name)
    ? `"${name}" is a JavaScript reserved word`
    : `"${name}" is already bound in every ${kind}'s scope, so a ${kind} with ` +
      "that name shadows the platform binding its own body reads";
  return {
    code: "RESERVED_NAME",
    message:
      `${why}. A ${kind} cannot be named ${
        platformReservedNames(kind).join(", ")
      }, ` +
      "or a JavaScript reserved word.",
    suggestion:
      `Pick another name. project_status lists every reserved name in reservedNames.`,
  };
}

// The shape project_status reports.
export function reservedNamesReport(): {
  handlersAndFunctions: string[];
  testsAlso: string[];
  javascriptReservedWords: string;
} {
  return {
    handlersAndFunctions: platformReservedNames("handler"),
    testsAlso: [...TEST_ONLY_SCOPE_NAMES],
    javascriptReservedWords: "also reserved, for every kind",
  };
}

// One line for the server instructions, which are capped (core/agent-guide.ts).
export const RESERVED_NAMES_RULE =
  `- Reserved names, refused by the define tools: ${
    platformReservedNames("handler").join(", ")
  }. Tests have more; project_status lists them in reservedNames.`;
