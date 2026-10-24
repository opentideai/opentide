import type { FunctionEntry, HandlerEntry, RouteSchema } from "./types.ts";
import { escapeRegex } from "./util.ts";

export type DuplicateEntityKind = "function" | "handler";

export interface DuplicateCandidate {
  kind: DuplicateEntityKind;
  name: string;
  module?: string;
  purpose?: string;
  score: number;
  reasons: string[];
}

export interface SimilarEntityInput {
  kind: DuplicateEntityKind;
  name: string;
  purpose?: string;
  source?: string;
  module?: string;
  returnType?: string;
  schema?: RouteSchema;
}

export interface SimilarEntity {
  kind: DuplicateEntityKind;
  name: string;
  source: string;
  module?: string;
  purpose?: string;
  returnType?: string;
  schema?: RouteSchema;
}

export const DUPLICATE_BLOCK_THRESHOLD = 0.72;
export const DUPLICATE_WARNING_THRESHOLD = 0.55;

const SYNONYMS: Record<string, string> = {
  add: "create",
  append: "create",
  build: "create",
  check: "validate",
  destroy: "delete",
  fetch: "get",
  insert: "create",
  isvalid: "validate",
  load: "get",
  make: "create",
  remove: "delete",
  valid: "validate",
};

const STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "as",
  "by",
  "for",
  "from",
  "in",
  "into",
  "of",
  "on",
  "or",
  "the",
  "to",
  "with",
]);

function normalizeWord(word: string): string {
  const lower = word.toLowerCase();
  return SYNONYMS[lower] ?? lower;
}

function words(text: string | undefined): string[] {
  if (!text) return [];
  const spaced = text
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2");
  return spaced
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .map(normalizeWord)
    .filter((w) => w.length > 1 && !STOP_WORDS.has(w));
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function jaccard(a: string[], b: string[]): number {
  const left = new Set(a);
  const right = new Set(b);
  if (left.size === 0 && right.size === 0) return 0;
  let intersection = 0;
  for (const value of left) {
    if (right.has(value)) intersection++;
  }
  const union = new Set([...left, ...right]).size;
  return union === 0 ? 0 : intersection / union;
}

function leadingComments(source: string | undefined): string {
  if (!source) return "";
  const lines = source.trimStart().split("\n");
  const comments: string[] = [];
  let inBlock = false;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (inBlock) {
      comments.push(line.replace(/\*\/$/, "").replace(/^\*/, "").trim());
      if (line.includes("*/")) inBlock = false;
      continue;
    }
    if (line.startsWith("//")) {
      comments.push(line.replace(/^\/\/\s?/, ""));
      continue;
    }
    if (line.startsWith("/*")) {
      inBlock = !line.includes("*/");
      comments.push(line.replace(/^\/\*\*?/, "").replace(/\*\/$/, "").trim());
      continue;
    }
    break;
  }
  return comments.join(" ");
}

function params(source: string | undefined, name: string): string[] {
  if (!source) return [];
  const escaped = escapeRegex(name);
  const match = source.match(
    new RegExp(`(?:async\\s+)?function\\s+${escaped}\\s*\\(([^)]*)\\)`),
  ) ??
    source.match(
      new RegExp(
        `(?:const|let|var)\\s+${escaped}\\s*=\\s*(?:async\\s*)?\\(([^)]*)\\)`,
      ),
    );
  if (!match?.[1]) return [];
  return match[1]
    .split(",")
    .map((part) => part.trim().split(/[:=\s]/)[0]?.replace(/[{}[\].]/g, ""))
    .filter((part): part is string => Boolean(part));
}

function inferredReturnType(source: string | undefined, name: string): string {
  if (!source) return "";
  const escaped = escapeRegex(name);
  return source.match(
    new RegExp(`function\\s+${escaped}\\s*\\([^)]*\\)\\s*:\\s*([^\\{=>]+)`),
  )?.[1]?.trim() ?? "";
}

function schemaWords(schema: RouteSchema | undefined): string[] {
  if (!schema) return [];
  const text = [
    schema.summary,
    schema.description,
    ...(schema.tags ?? []),
    ...Object.keys(schema.params ?? {}),
    ...Object.keys(schema.query ?? {}),
    ...Object.keys(schema.body?.properties ?? {}),
    ...Object.keys(schema.responses ?? {}),
  ].filter(Boolean).join(" ");
  return words(text);
}

function referencedEntities(source: string | undefined): string[] {
  if (!source) return [];
  const refs: string[] = [];
  const patterns = [
    /functions\.(?:call|get)\(\s*["'`]([^"'`]+)["'`]/g,
    /templates\.get\(\s*["'`]([^"'`]+)["'`]/g,
    /\b(?:FROM|JOIN|INTO|UPDATE)\s+["'`]?([a-zA-Z_][a-zA-Z0-9_]*)/gi,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      if (match[1]) refs.push(match[1]);
    }
  }
  return unique(refs.map(normalizeWord));
}

function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/.*$/gm, "$1 ");
}

function extractImplementationBody(source: string | undefined): string {
  if (!source) return "";
  const text = stripComments(source);
  const start = text.indexOf("{");
  if (start < 0) return text;

  let depth = 0;
  let quote: string | null = null;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const char = text[i]!;
    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === quote) {
        quote = null;
      }
      continue;
    }
    if (char === '"' || char === "'" || char === "`") {
      quote = char;
      continue;
    }
    if (char === "{") {
      depth++;
      continue;
    }
    if (char === "}") {
      depth--;
      if (depth === 0) return text.slice(start + 1, i);
    }
  }
  return text.slice(start + 1);
}

function normalizedImplementation(source: string | undefined): string {
  return extractImplementationBody(source)
    .replace(/\s+/g, " ")
    .replace(/\s*([{}()[\].,;:+\-*/%<>=!?&|])\s*/g, "$1")
    .trim();
}

function codeTokens(source: string | undefined): string[] {
  const body = normalizedImplementation(source);
  if (!body) return [];
  return body
    .replace(/(["'`])(?:\\.|(?!\1).)*\1/g, " string ")
    .replace(/\b\d+(?:\.\d+)?\b/g, " number ")
    .split(/[^a-zA-Z0-9_$]+/)
    .map((token) => token.toLowerCase())
    .filter((token) => token.length > 1);
}

function implementationScore(
  input: SimilarEntityInput,
  existing: SimilarEntity,
): number {
  const left = normalizedImplementation(input.source);
  const right = normalizedImplementation(existing.source);
  if (!left || !right) return 0;
  if (left === right) return 1;
  return jaccard(codeTokens(input.source), codeTokens(existing.source));
}

function signatureScore(
  input: SimilarEntityInput,
  existing: SimilarEntity,
): number {
  const leftParams = params(input.source, input.name);
  const rightParams = params(existing.source, existing.name);
  const paramScore = jaccard(
    leftParams.map(normalizeWord),
    rightParams.map(normalizeWord),
  );
  if (input.kind === "function") {
    const leftReturn = input.returnType ??
      inferredReturnType(input.source, input.name);
    const rightReturn = existing.returnType ??
      inferredReturnType(existing.source, existing.name);
    const returnScore = leftReturn && rightReturn
      ? leftReturn === rightReturn
        ? 1
        : jaccard(words(leftReturn), words(rightReturn))
      : 0;
    return Math.max(paramScore, returnScore);
  }
  return Math.max(
    paramScore,
    jaccard(schemaWords(input.schema), schemaWords(existing.schema)),
  );
}

function textScore(input: SimilarEntityInput, existing: SimilarEntity): number {
  const leftText = unique([
    ...words(input.purpose),
    ...words(leadingComments(input.source)),
    ...schemaWords(input.schema),
  ]);
  const rightText = unique([
    ...words(existing.purpose),
    ...words(leadingComments(existing.source)),
    ...schemaWords(existing.schema),
  ]);
  return jaccard(leftText, rightText);
}

export function scoreSimilarEntity(
  input: SimilarEntityInput,
  existing: SimilarEntity,
): DuplicateCandidate {
  const inputName = words(input.name);
  const existingName = words(existing.name);
  const nameScore = jaccard(inputName, existingName);
  const purposeScore = textScore(input, existing);
  const sigScore = signatureScore(input, existing);
  const implScore = implementationScore(input, existing);
  const moduleScore = input.module && existing.module
    ? input.module === existing.module ? 1 : 0
    : 0.35;
  const referenceScore = jaccard(
    referencedEntities(input.source),
    referencedEntities(existing.source),
  );
  const kindScore = input.kind === existing.kind ? 1 : 0;

  const weightedScore = Math.min(
    1,
    nameScore * 0.28 +
      purposeScore * 0.18 +
      implScore * 0.27 +
      sigScore * 0.12 +
      moduleScore * 0.06 +
      referenceScore * 0.02 +
      kindScore * 0.07,
  );
  const score = implScore === 1
    ? Math.max(weightedScore, 0.92)
    : implScore >= 0.86
    ? Math.max(weightedScore, 0.78)
    : weightedScore;

  const reasons: string[] = [];
  if (nameScore >= 0.65) reasons.push("similar normalized names");
  if (purposeScore >= 0.5) reasons.push("similar purpose or leading comments");
  if (implScore === 1) reasons.push("exact implementation match");
  else if (implScore >= 0.86) reasons.push("near-exact implementation match");
  if (sigScore >= 0.6) {
    reasons.push(
      input.kind === "handler"
        ? "similar params or route schema"
        : "similar params or return type",
    );
  }
  if (input.module && existing.module && input.module === existing.module) {
    reasons.push("same module");
  }
  if (referenceScore >= 0.4) reasons.push("similar referenced app entities");

  return {
    kind: existing.kind,
    name: existing.name,
    ...(existing.module ? { module: existing.module } : {}),
    ...(existing.purpose ? { purpose: existing.purpose } : {}),
    score: Number(score.toFixed(3)),
    reasons,
  };
}

export function findSimilarEntities(
  input: SimilarEntityInput,
  existingEntities: SimilarEntity[],
  options: { excludeSameName?: boolean } = {},
): DuplicateCandidate[] {
  return existingEntities
    .filter((entity) =>
      !(options.excludeSameName && entity.kind === input.kind &&
        entity.name === input.name)
    )
    .map((entity) => scoreSimilarEntity(input, entity))
    .filter((candidate) => candidate.score >= DUPLICATE_WARNING_THRESHOLD)
    .toSorted((a, b) => b.score - a.score || a.name.localeCompare(b.name));
}

export function functionEntity(entry: FunctionEntry): SimilarEntity {
  return {
    kind: "function",
    name: entry.name,
    source: entry.source,
    ...(entry.module ? { module: entry.module } : {}),
    ...(entry.purpose ? { purpose: entry.purpose } : {}),
    ...(entry.returnType ? { returnType: entry.returnType } : {}),
  };
}

export function handlerEntity(entry: HandlerEntry): SimilarEntity {
  return {
    kind: "handler",
    name: entry.name,
    source: entry.source,
    ...(entry.module ? { module: entry.module } : {}),
    ...(entry.purpose ? { purpose: entry.purpose } : {}),
    ...(entry.schema ? { schema: entry.schema } : {}),
  };
}
