import * as esbuild from "esbuild";
import { checkComplexity as calcComplexity } from "./audit-complexity.ts";
import { escapeRegex } from "./util.ts";
import type { FormalSpec } from "./types.ts";
// The layer-import rule (OpenTide §3.2) lives in a dependency-light module so it
// can scan the source tree without loading the kernel's runtime graph; re-exported
// here so it remains part of the qc surface.
export {
  checkLayerImports,
  extractKernelImports,
  formatLayerIssues,
} from "./layer-check.ts";
export type { LayerCheckResult, LayerIssue } from "./layer-check.ts";

export interface QCIssue {
  level: "error" | "warning" | "info";
  rule: string;
  message: string;
  line?: number;
}

export interface QCResult {
  passed: boolean;
  issues: QCIssue[];
  summary: string;
}

export type QCKind =
  | "handler"
  | "function"
  | "template"
  | "css"
  | "js"
  | "dev_view"
  | "dev_tool";

export interface EntitySource {
  name: string;
  source: string;
  kind: "handler" | "function";
}

export async function runQC(source: string, kind: QCKind): Promise<QCResult> {
  const issues: QCIssue[] = [];

  if (kind === "template") {
    checkTemplate(source, issues);
    checkInternalArtifacts(source, issues, { html: true });
  } else if (kind === "css") {
    checkCSS(source, issues);
  } else {
    await checkEsbuild(source, issues);
    checkCodePatterns(source, issues);
    checkInternalArtifacts(source, issues);
    checkUnusedVars(source, issues);
    if (kind === "handler" || kind === "function") {
      const cc = calcComplexity(source);
      if (cc) {
        issues.push({
          level: "warning",
          rule: "high-complexity",
          message: cc.message,
        });
      }
    }
  }

  const errors = issues.filter((i) => i.level === "error");
  const warnings = issues.filter((i) => i.level === "warning");
  const passed = errors.length === 0;

  const parts: string[] = [];
  if (errors.length) {
    parts.push(`${errors.length} error${errors.length !== 1 ? "s" : ""}`);
  }
  if (warnings.length) {
    parts.push(`${warnings.length} warning${warnings.length !== 1 ? "s" : ""}`);
  }

  return {
    passed,
    issues,
    summary: parts.length ? parts.join(", ") : "All checks passed",
  };
}

export function formatIssues(issues: QCIssue[]): string {
  if (issues.length === 0) return "All checks passed.";
  return issues.map((i) => {
    const loc = i.line ? ` (line ${i.line})` : "";
    const tag = i.level === "error"
      ? "ERROR"
      : i.level === "warning"
      ? "WARN"
      : "INFO";
    return `[${tag}] ${i.rule}${loc}: ${i.message}`;
  }).join("\n");
}

async function checkEsbuild(source: string, issues: QCIssue[]): Promise<void> {
  try {
    const result = await esbuild.transform(source, {
      loader: "ts",
      target: "esnext",
    });
    for (const w of result.warnings) {
      issues.push({
        level: "warning",
        rule: "esbuild",
        message: w.text,
        line: w.location?.line,
      });
    }
  } catch (err) {
    issues.push({
      level: "error",
      rule: "esbuild",
      message: `Build error: ${
        err instanceof Error ? err.message : String(err)
      }`,
    });
  }
}

function checkCodePatterns(source: string, issues: QCIssue[]): void {
  const lines = source.split("\n");

  // Empty catch — scan the whole source (not per-line) so the common
  // multi-line form `catch (e) {\n}` is caught, and make the binding optional
  // so the ES2019 `catch {}` form is caught too. A comment between the braces
  // (`catch { /* ignore */ }`) is the intentional escape hatch and is allowed.
  const emptyCatch = /catch\s*(?:\([^)]*\))?\s*\{\s*\}/g;
  for (let m = emptyCatch.exec(source); m; m = emptyCatch.exec(source)) {
    issues.push({
      level: "warning",
      rule: "no-empty-catch",
      message: "Empty catch block silently swallows errors",
      line: source.slice(0, m.index).split("\n").length,
    });
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const num = i + 1;

    if (/\bconsole\.(log|debug|info|warn|error)\s*\(/.test(line)) {
      issues.push({
        level: "warning",
        rule: "no-console",
        message:
          "Use log() instead of console — console output is not captured by the kernel",
        line: num,
      });
    }

    if (/\beval\s*\(/.test(line) && !isInComment(line, line.indexOf("eval"))) {
      issues.push({
        level: "error",
        rule: "no-eval",
        message: "eval() is not allowed",
        line: num,
      });
    }

    if (
      /\bnew\s+Function\s*\(/.test(line) &&
      !isInComment(line, line.indexOf("new"))
    ) {
      issues.push({
        level: "error",
        rule: "no-new-function",
        message: "new Function() is not allowed",
        line: num,
      });
    }

    if (/\b(TODO|FIXME|HACK|XXX)\b/.test(line)) {
      issues.push({
        level: "info",
        rule: "no-todo",
        message: "Unresolved TODO/FIXME comment",
        line: num,
      });
    }
  }

  // Async function without await (simple single-function check)
  const asyncMatch = source.match(/^(export\s+)?async\s+function\s+\w+/m);
  if (asyncMatch && !source.includes("await")) {
    issues.push({
      level: "warning",
      rule: "require-await",
      message:
        "Async function does not use await — remove async or add awaited calls",
    });
  }
}

function checkInternalArtifacts(
  source: string,
  issues: QCIssue[],
  opts: { html?: boolean } = {},
): void {
  const searchable = opts.html
    ? stripHtmlComments(source)
    : stripCodeComments(source);
  const lines = searchable.split("\n");

  const explicitArtifacts = [
    { pattern: /\b_temp_build\b/, name: "_temp_build" },
    { pattern: /\b_genie_messages\b/, name: "_genie_messages" },
    { pattern: /\b__drizzle_migrations\b/, name: "__drizzle_migrations" },
    { pattern: /\bdist\/\.tmp-check\b|\.tmp-check\b/, name: ".tmp-check" },
  ];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const num = i + 1;

    for (const artifact of explicitArtifacts) {
      if (artifact.pattern.test(line)) {
        issues.push({
          level: "error",
          rule: "no-internal-artifacts",
          message:
            `${artifact.name} is a Tide internal artifact, not app source or app data. Use registries/assets/schemas instead.`,
          line: num,
        });
      }
    }

    if (
      /\b(?:from|join|into|update|table|truncate)\s+["']?_[a-zA-Z0-9_]+["']?/i
        .test(line)
    ) {
      issues.push({
        level: "error",
        rule: "no-internal-tables",
        message:
          "App code must not query or mutate underscore-prefixed internal tables. Use registered schemas for app data and assets/templates for source.",
        line: num,
      });
    }
  }
}

function stripHtmlComments(source: string): string {
  return source.replace(/<!--[\s\S]*?-->/g, (match) =>
    "\n".repeat(
      match.split("\n").length - 1,
    ));
}

function stripCodeComments(source: string): string {
  let out = "";
  let state:
    | "code"
    | "single"
    | "double"
    | "template"
    | "line-comment"
    | "block-comment" = "code";

  for (let i = 0; i < source.length; i++) {
    const ch = source[i]!;
    const next = source[i + 1];
    const prev = source[i - 1];

    if (state === "line-comment") {
      if (ch === "\n") {
        out += "\n";
        state = "code";
      } else {
        out += " ";
      }
      continue;
    }

    if (state === "block-comment") {
      if (ch === "*" && next === "/") {
        out += "  ";
        i++;
        state = "code";
      } else {
        out += ch === "\n" ? "\n" : " ";
      }
      continue;
    }

    if (state === "single") {
      out += ch;
      if (ch === "'" && prev !== "\\") state = "code";
      continue;
    }

    if (state === "double") {
      out += ch;
      if (ch === '"' && prev !== "\\") state = "code";
      continue;
    }

    if (state === "template") {
      out += ch;
      if (ch === "`" && prev !== "\\") state = "code";
      continue;
    }

    if (ch === "/" && next === "/") {
      out += "  ";
      i++;
      state = "line-comment";
      continue;
    }

    if (ch === "/" && next === "*") {
      out += "  ";
      i++;
      state = "block-comment";
      continue;
    }

    if (ch === "'") state = "single";
    else if (ch === '"') state = "double";
    else if (ch === "`") state = "template";
    out += ch;
  }

  return out;
}

function checkUnusedVars(source: string, issues: QCIssue[]): void {
  const declarations = [...source.matchAll(/\b(?:const|let|var)\s+(\w+)\s*=/g)];
  for (const decl of declarations) {
    const name = decl[1]!;
    if (name.startsWith("_")) continue;
    const allRefs = [
      ...source.matchAll(new RegExp(`\\b${escapeRegex(name)}\\b`, "g")),
    ];
    if (allRefs.length <= 1) {
      issues.push({
        level: "warning",
        rule: "no-unused-vars",
        message:
          `"${name}" is declared but never used — remove it or prefix with _`,
      });
    }
  }
}

function checkTemplate(source: string, issues: QCIssue[]): void {
  if (source.length > 100_000) return;
  const isFullPage = /<html/i.test(source);

  if (isFullPage && !/<\!DOCTYPE/i.test(source)) {
    issues.push({
      level: "info",
      rule: "missing-doctype",
      message: "HTML document is missing <!DOCTYPE html>",
    });
  }

  if (isFullPage && !/<meta[^>]*viewport/i.test(source)) {
    issues.push({
      level: "info",
      rule: "missing-viewport",
      message: "Missing viewport meta tag for responsive design",
    });
  }

  if (isFullPage && !/<meta[^>]*charset/i.test(source)) {
    issues.push({
      level: "info",
      rule: "missing-charset",
      message: "Missing charset meta tag",
    });
  }

  // Inline style blocks in templates (should use assets)
  const styleMatch = source.match(/<style[^>]*>([\s\S]{200,}?)<\/style>/i);
  if (styleMatch) {
    issues.push({
      level: "warning",
      rule: "no-inline-styles",
      message:
        "Large inline <style> block — extract to a CSS asset for better separation",
    });
  }

  // Inline script blocks (should use assets)
  const scriptMatch = source.match(/<script[^>]*>([\s\S]{200,}?)<\/script>/i);
  if (scriptMatch && !/src=/.test(scriptMatch[0]!)) {
    issues.push({
      level: "warning",
      rule: "no-inline-scripts",
      message:
        "Large inline <script> block — extract to a JS asset for better separation",
    });
  }

  checkAccessibility(source, issues);
}

function checkAccessibility(source: string, issues: QCIssue[]): void {
  // Images without alt
  const imgs = [...source.matchAll(/<img\b([^>]*)>/gi)];
  for (const m of imgs) {
    if (!/\balt\s*=/i.test(m[1]!)) {
      issues.push({
        level: "warning",
        rule: "a11y-img-alt",
        message: "<img> missing alt attribute — required for screen readers",
      });
    }
  }

  // Inputs without associated labels
  const inputs = [...source.matchAll(/<input\b([^>]*)>/gi)];
  for (const m of inputs) {
    const attrs = m[1]!;
    const typeMatch = attrs.match(/\btype\s*=\s*["']?(\w+)/i);
    const type = typeMatch?.[1]?.toLowerCase() ?? "text";
    if (type === "hidden" || type === "submit" || type === "button") continue;
    const hasId = /\bid\s*=/i.test(attrs);
    const hasAriaLabel = /\baria-label\s*=/i.test(attrs);
    const hasAriaLabelledBy = /\baria-labelledby\s*=/i.test(attrs);
    const hasTitle = /\btitle\s*=/i.test(attrs);
    if (!hasAriaLabel && !hasAriaLabelledBy && !hasTitle) {
      if (hasId) {
        const idMatch = attrs.match(/\bid\s*=\s*["']?([^"'\s>]+)/i);
        const id = idMatch?.[1];
        if (
          id &&
          !new RegExp(`<label[^>]*\\bfor\\s*=\\s*["']?${escapeRegex(id)}`, "i")
            .test(source)
        ) {
          issues.push({
            level: "warning",
            rule: "a11y-input-label",
            message:
              `<input id="${id}"> has no associated <label for="${id}"> or aria-label`,
          });
        }
      } else {
        issues.push({
          level: "warning",
          rule: "a11y-input-label",
          message:
            "<input> has no id, aria-label, or aria-labelledby — not accessible",
        });
      }
    }
  }

  // Buttons without accessible text
  const buttons = [
    ...source.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/gi),
  ];
  for (const m of buttons) {
    const attrs = m[1]!;
    const content = m[2]!.trim();
    const hasAriaLabel = /\baria-label\s*=/i.test(attrs);
    const hasTitle = /\btitle\s*=/i.test(attrs);
    const textContent = content.replace(/<[^>]*>/g, "").trim();
    if (!textContent && !hasAriaLabel && !hasTitle) {
      issues.push({
        level: "warning",
        rule: "a11y-button-text",
        message: "<button> has no text content or aria-label — not accessible",
      });
    }
  }

  // Links without href
  const links = [...source.matchAll(/<a\b([^>]*)>/gi)];
  for (const m of links) {
    if (!/\bhref\s*=/i.test(m[1]!)) {
      issues.push({
        level: "warning",
        rule: "a11y-anchor-href",
        message:
          "<a> without href — use a <button> for interactive elements without navigation",
      });
    }
  }

  // Missing lang attribute on html
  if (/<html\b/i.test(source) && !/<html[^>]*\blang\s*=/i.test(source)) {
    issues.push({
      level: "info",
      rule: "a11y-html-lang",
      message:
        '<html> missing lang attribute — add lang="en" (or appropriate language)',
    });
  }

  // Form without action or role
  const forms = [...source.matchAll(/<form\b([^>]*)>/gi)];
  for (const m of forms) {
    const attrs = m[1]!;
    if (
      !/\brole\s*=/i.test(attrs) && !/\baria-label\s*=/i.test(attrs) &&
      !/\baria-labelledby\s*=/i.test(attrs)
    ) {
      issues.push({
        level: "info",
        rule: "a11y-form-label",
        message:
          "<form> has no aria-label or aria-labelledby — consider labeling for screen readers",
      });
    }
  }
}

function checkCSS(source: string, issues: QCIssue[]): void {
  // Duplicate selectors
  const selectors = [...source.matchAll(/^([^{@/\n][^{]*)\{/gm)].map((m) =>
    m[1]!.trim()
  );
  const seen = new Set<string>();
  for (const sel of selectors) {
    if (seen.has(sel)) {
      issues.push({
        level: "warning",
        rule: "duplicate-selector",
        message: `Duplicate CSS selector "${sel}" — consider merging`,
      });
    }
    seen.add(sel);
  }

  // !important usage
  const importantCount = (source.match(/!important/g) || []).length;
  if (importantCount > 3) {
    issues.push({
      level: "warning",
      rule: "excessive-important",
      message:
        `${importantCount} uses of !important — indicates specificity issues`,
    });
  }
}

function isInComment(line: string, pos: number): boolean {
  const beforePos = line.slice(0, pos);
  return beforePos.includes("//") || beforePos.includes("/*");
}

// --- Cross-entity dependency checking ---

export interface DepWarning {
  entity: string;
  kind: "handler" | "function";
  reason: string;
}

export function checkDependants(
  changedName: string,
  changedKind: "handler" | "function",
  oldSource: string | null,
  newSource: string,
  allEntities: EntitySource[],
): DepWarning[] {
  if (!oldSource) return [];

  const oldExports = extractCallableNames(oldSource);
  const newExports = extractCallableNames(newSource);

  const removed = oldExports.filter((n) => !newExports.includes(n));
  const oldParams = extractParamSignature(oldSource, changedName);
  const newParams = extractParamSignature(newSource, changedName);
  const sigChanged = oldParams !== null && newParams !== null &&
    oldParams !== newParams;

  if (removed.length === 0 && !sigChanged) return [];

  const warnings: DepWarning[] = [];

  for (const entity of allEntities) {
    if (entity.name === changedName && entity.kind === changedKind) continue;

    for (const name of removed) {
      const pattern = new RegExp(`\\b${escapeRegex(name)}\\b`);
      if (pattern.test(entity.source)) {
        warnings.push({
          entity: entity.name,
          kind: entity.kind,
          reason:
            `references "${name}" which was removed from ${changedKind} "${changedName}"`,
        });
      }
    }

    if (sigChanged) {
      const callPattern = new RegExp(`\\b${escapeRegex(changedName)}\\s*\\(`);
      if (callPattern.test(entity.source)) {
        warnings.push({
          entity: entity.name,
          kind: entity.kind,
          reason:
            `calls "${changedName}" whose signature changed (${oldParams} → ${newParams})`,
        });
      }

      const registryCall = new RegExp(
        `functions\\.call\\s*\\(\\s*["']${escapeRegex(changedName)}["']`,
      );
      if (
        registryCall.test(entity.source) && !callPattern.test(entity.source)
      ) {
        warnings.push({
          entity: entity.name,
          kind: entity.kind,
          reason:
            `calls "${changedName}" via functions.call() whose signature changed (${oldParams} → ${newParams})`,
        });
      }
    }
  }

  return warnings;
}

function extractCallableNames(source: string): string[] {
  const names: string[] = [];
  const fnDecl = [...source.matchAll(/\bfunction\s+(\w+)/g)];
  for (const m of fnDecl) names.push(m[1]!);
  const constFn = [
    ...source.matchAll(
      /\b(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s+)?(?:\([^)]*\)|[^=])\s*=>/g,
    ),
  ];
  for (const m of constFn) names.push(m[1]!);
  return names;
}

function extractParamSignature(source: string, fnName: string): string | null {
  const pattern = new RegExp(
    `(?:async\\s+)?function\\s+${escapeRegex(fnName)}\\s*\\(([^)]*)\\)`,
  );
  const match = source.match(pattern);
  if (!match) return null;
  const params = match[1]!
    .split(",")
    .map((p) => p.replace(/:[^,)=]+/g, "").replace(/\s*=\s*[^,)]+/g, "").trim())
    .filter(Boolean);
  return `${params.length} param${params.length !== 1 ? "s" : ""}`;
}

// --- Unused package detection ---

export interface UnusedPackageInfo {
  name: string;
  specifier: string;
  installedAt: string;
  usedBy: string[];
}

export function findUnusedPackages(
  packageNames: string[],
  allEntities: EntitySource[],
): { used: UnusedPackageInfo[]; unused: UnusedPackageInfo[] } {
  const used: UnusedPackageInfo[] = [];
  const unused: UnusedPackageInfo[] = [];

  for (const pkgName of packageNames) {
    const pattern = packageReferencePattern(pkgName);
    const usedBy: string[] = [];
    for (const entity of allEntities) {
      if (pattern.test(entity.source)) {
        usedBy.push(`${entity.kind}:${entity.name}`);
      }
    }
    const info: UnusedPackageInfo = {
      name: pkgName,
      specifier: "",
      installedAt: "",
      usedBy,
    };
    if (usedBy.length > 0) {
      used.push(info);
    } else {
      unused.push(info);
    }
  }

  return { used, unused };
}

function packageReferencePattern(pkgName: string): RegExp {
  const quotedName = escapeRegex(pkgName);
  const bracketAccess = `packages\\s*\\[\\s*(["'\`])${quotedName}\\1\\s*\\]`;
  if (/^[A-Za-z_$][\w$]*$/.test(pkgName)) {
    return new RegExp(
      `(?:\\bpackages\\.${quotedName}\\b|${bracketAccess})`,
    );
  }
  return new RegExp(bracketAccess);
}

export function formatDepWarnings(warnings: DepWarning[]): string {
  if (warnings.length === 0) return "";
  return warnings.map((w) =>
    `[WARN] dependency: ${w.kind} "${w.entity}" ${w.reason}`
  ).join("\n");
}

// --- Formal spec markers (Tier-1 autoformalization) ---
// Confirms the type-level guard for a FormalSpec is present in the target
// entity's source. Combined with a passing `checkExportTypes` (deno check),
// a present marker means the compiler enforces the invariant. Deliberately
// syntactic — matching the paper's "lightweight, relies on the type-checker".

// Strips line and block comments so markers inside comments don't count.
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, " ");
}

const IDENTIFIER_PATH_PATTERN = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/;
const DOTTED_IDENTIFIER_PATH_PATTERN =
  /\b[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+\b/;
const DISCRIMINANT_STOPWORDS = new Set([
  "a",
  "an",
  "and",
  "by",
  "every",
  "for",
  "in",
  "of",
  "on",
  "over",
  "that",
  "the",
  "this",
]);

function isUsableDiscriminantToken(token: string): boolean {
  const trimmed = token.trim();
  return IDENTIFIER_PATH_PATTERN.test(trimmed) &&
    !DISCRIMINANT_STOPWORDS.has(trimmed.toLowerCase());
}

// Best-effort discriminant token from an explicit spec field or cautious
// statement parsing. Avoid broad prose fallback: words like "the" are valid JS
// identifiers but not meaningful discriminants.
function discriminantToken(spec: FormalSpec): string | null {
  if (
    typeof spec.discriminant === "string" &&
    isUsableDiscriminantToken(spec.discriminant)
  ) {
    return spec.discriminant.trim();
  }

  const quoted = spec.statement.match(
    /["'`]([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)["'`]/,
  );
  if (quoted && isUsableDiscriminantToken(quoted[1]!)) return quoted[1]!;

  const dotted = spec.statement.match(DOTTED_IDENTIFIER_PATH_PATTERN);
  if (dotted && isUsableDiscriminantToken(dotted[0])) return dotted[0];

  const switchBare = spec.statement.match(
    /\bswitch\s+(?:statement\s+)?(?:over|on)\s+([A-Za-z_$][\w$]*)\b/i,
  );
  if (switchBare && isUsableDiscriminantToken(switchBare[1]!)) {
    return switchBare[1]!;
  }

  return null;
}

function findMatchingDelimiter(
  source: string,
  openIndex: number,
  open: string,
  close: string,
): number {
  let depth = 0;
  let quote: "'" | '"' | "`" | null = null;
  for (let i = openIndex; i < source.length; i++) {
    const char = source[i]!;
    if (quote) {
      if (char === "\\") {
        i++;
      } else if (char === quote) {
        quote = null;
      }
      continue;
    }
    if (char === "'" || char === '"' || char === "`") {
      quote = char;
      continue;
    }
    if (char === open) depth++;
    if (char === close) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function switchBodies(code: string, discriminant: string | null): string[] {
  const bodies: string[] = [];
  const switchPattern = /\bswitch\s*\(/g;
  for (
    let match = switchPattern.exec(code);
    match;
    match = switchPattern.exec(code)
  ) {
    const parenOpen = code.indexOf("(", match.index);
    const parenClose = findMatchingDelimiter(code, parenOpen, "(", ")");
    if (parenClose === -1) continue;
    const condition = code.slice(parenOpen + 1, parenClose).trim();
    switchPattern.lastIndex = parenClose + 1;
    if (discriminant && condition !== discriminant) continue;

    const rest = code.slice(parenClose + 1);
    const braceOffset = rest.search(/\S/);
    if (braceOffset === -1) continue;
    const braceOpen = parenClose + 1 + braceOffset;
    if (code[braceOpen] !== "{") continue;
    const braceClose = findMatchingDelimiter(code, braceOpen, "{", "}");
    if (braceClose === -1) continue;
    bodies.push(code.slice(braceOpen + 1, braceClose));
    switchPattern.lastIndex = braceClose + 1;
  }
  return bodies;
}

function hasExhaustiveSwitchGuard(
  code: string,
  discriminant: string | null = null,
): boolean {
  return switchBodies(code, discriminant).some((body) =>
    /\bdefault\s*:[\s\S]*?\bassertNever\s*\(/.test(body)
  );
}

// A two-sided clamp forces a value into a bounded interval — the runtime guard
// the numeric-range technique relies on. Requires Math.min nested in Math.max
// (or vice versa), or a clamp(value, lo, hi) helper — NOT two incidental,
// unrelated min/max calls elsewhere in the entity.
function hasNumericRangeGuard(code: string): boolean {
  const nestedClamp =
    /\bMath\s*\.\s*(?:min|max)\s*\([^)]*\bMath\s*\.\s*(?:min|max)\s*\(/.test(
      code,
    );
  const clampHelper = /\bclamp\s*\([^)]*,[^)]*,[^)]*\)/.test(code);
  return nestedClamp || clampHelper;
}

// `satisfies Record<NamedUnion, V>` — a PascalCase key type (a named union or
// enum, not `string`/`number`) makes every key mandatory, so the compiler
// rejects a mapping that misses one. Distinct from the generic satisfies-guard.
function hasExhaustiveRecordGuard(code: string): boolean {
  return /\bsatisfies\s+Record\s*<\s*[A-Z][\w$]*\s*,/.test(code);
}

// A nominal brand makes a raw value unassignable where the branded type is
// required. Requires the underscore `__brand`/`_brand` convention in an
// intersection, or a `Brand<…>` TYPE ALIAS — not a plain data field named
// "brand" or a runtime `Brand<T>(x)` call.
function hasBrandedTypeGuard(code: string): boolean {
  return /&\s*\{[^}]*\b__?brand\b/.test(code) ||
    /\btype\s+[A-Za-z_$][\w$]*\s*=[^;{]*\bBrand\s*</.test(code);
}

export function verifyFormalSpecMarker(
  spec: FormalSpec,
  entitySource: string,
): { met: boolean; detail: string } {
  const code = stripComments(entitySource);
  switch (spec.technique) {
    case "exhaustive-switch": {
      if (hasExhaustiveSwitchGuard(code)) {
        return {
          met: true,
          detail: "assertNever guard present in a switch default.",
        };
      }
      return {
        met: false,
        detail:
          "Missing exhaustive-switch guard: add a `switch` over the union with `default: return assertNever(x);` so unhandled variants fail to type-check.",
      };
    }
    case "satisfies-guard": {
      if (/\bsatisfies\s+(Record\s*<|\{)/.test(code)) {
        return { met: true, detail: "`satisfies` guard present." };
      }
      return {
        met: false,
        detail:
          "Missing satisfies guard: annotate the mapping with `satisfies Record<K, V>` so missing keys fail to type-check.",
      };
    }
    case "discriminated-union": {
      const token = discriminantToken(spec);
      if (hasExhaustiveSwitchGuard(code, token)) {
        return {
          met: true,
          detail: token
            ? `exhaustive switch over "${token}" present.`
            : "exhaustive switch statement present.",
        };
      }
      return {
        met: false,
        detail: `Missing discriminated-union exhaustiveness guard${
          token ? ` over "${token}"` : ""
        }: use a \`switch\` with \`default: return assertNever(x);\` so unhandled variants fail to type-check.`,
      };
    }
    case "union-alias": {
      if (
        /\btype\s+[A-Za-z_$][\w$]*\s*=\s*(['"][^'"]*['"]\s*\|?\s*)+/.test(code)
      ) {
        return {
          met: true,
          detail: "Named string-literal union alias present.",
        };
      }
      return {
        met: false,
        detail:
          "Missing union alias: declare a named `type X = 'a' | 'b' | ...` and use it instead of raw string literals.",
      };
    }
    case "numeric-range": {
      if (hasNumericRangeGuard(code)) {
        return { met: true, detail: "Numeric range clamp/guard present." };
      }
      return {
        met: false,
        detail:
          "Missing numeric-range guard: clamp on both ends — `Math.min(hi, Math.max(lo, x))` or a `clamp(x, lo, hi)` helper — so out-of-range inputs can't flow through.",
      };
    }
    case "exhaustive-record": {
      if (hasExhaustiveRecordGuard(code)) {
        return {
          met: true,
          detail:
            "`satisfies Record<NamedUnion, V>` total-coverage guard present.",
        };
      }
      return {
        met: false,
        detail:
          "Missing exhaustive-record guard: annotate the mapping as `satisfies Record<KeyUnion, V>` with a named key union so a missing key fails to type-check.",
      };
    }
    case "branded-type": {
      if (hasBrandedTypeGuard(code)) {
        return { met: true, detail: "Nominal branded type present." };
      }
      return {
        met: false,
        detail:
          "Missing branded type: declare `type X = Base & { readonly __brand: 'X' }` with a validating constructor so a raw value can't be used where X is required.",
      };
    }
    default: {
      return { met: false, detail: `Unknown technique "${spec.technique}".` };
    }
  }
}
