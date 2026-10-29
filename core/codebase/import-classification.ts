// The import classifier's answer, checked. The classifier itself runs on the
// client's model (request_review kind "imports"); the server checks what comes
// back before it touches the codebase graph, and Tide's agent uses the same
// checks on its own model's reply.
import type {
  ImportClassifierCandidateEntity,
  ImportClassifierDiagnostic,
  ImportClassifierFact,
  ImportClassifierMapping,
} from "./import-classifier.ts";

export interface ImportClassification {
  facts: ImportClassifierFact[];
  mappings: ImportClassifierMapping[];
  diagnostics: ImportClassifierDiagnostic[];
  candidateEntities: ImportClassifierCandidateEntity[];
}

// Items that don't fit are dropped, item by item. Only a root that isn't an
// object, or a field that isn't a list, rejects the whole answer.
export function parseImportClassification(
  parsed: unknown,
): { ok: true; data: ImportClassification } | { ok: false; reason: string } {
  if (!isRecord(parsed) || Array.isArray(parsed)) {
    return { ok: false, reason: "Classifier JSON root must be an object." };
  }
  const shapeError = topLevelArrayShapeError(parsed);
  if (shapeError) return { ok: false, reason: shapeError };
  return {
    ok: true,
    data: {
      facts: parseFacts(parsed.facts),
      mappings: parseMappings(parsed.mappings),
      diagnostics: parseDiagnostics(parsed.diagnostics),
      candidateEntities: parseCandidateEntities(parsed.candidateEntities),
    },
  };
}

function topLevelArrayShapeError(
  parsed: Record<string, unknown>,
): string | null {
  for (
    const field of [
      "facts",
      "mappings",
      "diagnostics",
      "candidateEntities",
    ]
  ) {
    if (Object.hasOwn(parsed, field) && !Array.isArray(parsed[field])) {
      return `Classifier field "${field}" must be an array when present.`;
    }
  }
  return null;
}

function parseFacts(value: unknown): ImportClassifierFact[] {
  if (!Array.isArray(value)) return [];
  const facts: ImportClassifierFact[] = [];
  for (const item of value) {
    if (!isRecord(item)) continue;
    const kind = stringValue(item.kind);
    if (!isFactKind(kind)) continue;
    const name = stringValue(item.name);
    if (!name) continue;
    facts.push({
      kind,
      name,
      value: item.value,
      confidence: numberValue(item.confidence, 0),
      locations: parseLocations(item.locations),
      appliesToIds: stringArray(item.appliesToIds),
    });
  }
  return facts;
}

function parseMappings(value: unknown): ImportClassifierMapping[] {
  if (!Array.isArray(value)) return [];
  const mappings: ImportClassifierMapping[] = [];
  for (const item of value) {
    if (!isRecord(item)) continue;
    const kind = stringValue(item.kind);
    const name = stringValue(item.name);
    if (!name) continue;
    const common = {
      name,
      confidence: numberValue(item.confidence, 0),
      locations: parseLocations(item.locations),
      tags: stringArray(item.tags),
      module: stringValue(item.module) || undefined,
      sourceIds: stringArray(item.sourceIds),
    };
    if (kind === "route") {
      const method = stringValue(item.method);
      const path = stringValue(item.path);
      if (!method || !path) continue;
      mappings.push({
        kind,
        ...common,
        method,
        path,
        framework: stringValue(item.framework) || undefined,
        handlerIds: stringArray(item.handlerIds),
        middlewareIds: stringArray(item.middlewareIds),
        mountPath: stringValue(item.mountPath) || undefined,
        pathSyntax: pathSyntaxValue(item.pathSyntax),
        requestSchemaId: stringValue(item.requestSchemaId) || undefined,
        responseSchemaIds: stringArray(item.responseSchemaIds),
      });
      continue;
    }
    if (kind === "handler") {
      mappings.push({
        kind,
        ...common,
        framework: stringValue(item.framework) || undefined,
        language: sourceLanguageValue(item.language),
        symbolId: stringValue(item.symbolId) || undefined,
        routeIds: stringArray(item.routeIds),
      });
      continue;
    }
    if (kind === "function") {
      mappings.push({
        kind,
        ...common,
        language: sourceLanguageValue(item.language),
        symbolId: stringValue(item.symbolId) || undefined,
        signature: stringValue(item.signature) || undefined,
        returnType: stringValue(item.returnType) || undefined,
      });
      continue;
    }
    if (kind === "schema") {
      mappings.push({
        kind,
        ...common,
        schemaKind: schemaKindValue(item.schemaKind),
        tableName: stringValue(item.tableName) || undefined,
        typeName: stringValue(item.typeName) || undefined,
        fields: parseSchemaFields(item.fields),
      });
      continue;
    }
    if (kind === "component") {
      mappings.push({
        kind,
        ...common,
        language: sourceLanguageValue(item.language),
        symbolId: stringValue(item.symbolId) || undefined,
        framework: stringValue(item.framework) || undefined,
        routeIds: stringArray(item.routeIds),
      });
    }
  }
  return mappings;
}

function parseDiagnostics(value: unknown): ImportClassifierDiagnostic[] {
  if (!Array.isArray(value)) return [];
  const diagnostics: ImportClassifierDiagnostic[] = [];
  for (const item of value) {
    if (!isRecord(item)) continue;
    const message = stringValue(item.message);
    if (!message) continue;
    diagnostics.push({
      severity: severityValue(item.severity),
      message,
      confidence: optionalNumberValue(item.confidence),
      locations: parseLocations(item.locations),
      entityIds: stringArray(item.entityIds),
    });
  }
  return diagnostics;
}

function parseCandidateEntities(
  value: unknown,
): ImportClassifierCandidateEntity[] {
  if (!Array.isArray(value)) return [];
  const candidates: ImportClassifierCandidateEntity[] = [];
  for (const item of value) {
    if (!isRecord(item)) continue;
    const entityType = entityTypeValue(item.entityType);
    const name = stringValue(item.name);
    if (!name) continue;
    candidates.push({
      entityType,
      name,
      confidence: numberValue(item.confidence, 0),
      rationale: stringValue(item.rationale) || undefined,
      sourceIds: stringArray(item.sourceIds),
      locations: parseLocations(item.locations),
      ...(stringValue(item.sourceExcerpt)
        ? { sourceExcerpt: stringValue(item.sourceExcerpt) }
        : {}),
      value: item.value,
    });
  }
  return candidates;
}

function parseLocations(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value
    .filter(isRecord)
    .map((item) => {
      const file = stringValue(item.file);
      const startLine = numberValue(item.startLine, NaN);
      const startColumn = numberValue(item.startColumn, NaN);
      if (
        !file || !Number.isFinite(startLine) || !Number.isFinite(startColumn)
      ) {
        return null;
      }
      const endLine = optionalNumberValue(item.endLine);
      const endColumn = optionalNumberValue(item.endColumn);
      return {
        file,
        startLine,
        startColumn,
        ...(endLine === undefined ? {} : { endLine }),
        ...(endColumn === undefined ? {} : { endColumn }),
      };
    })
    .filter((location): location is NonNullable<typeof location> =>
      location !== null
    );
}

function parseSchemaFields(value: unknown) {
  if (!Array.isArray(value)) return undefined;
  const fields = value
    .filter(isRecord)
    .map((item) => {
      const name = stringValue(item.name);
      if (!name) return null;
      return {
        name,
        type: stringValue(item.type) || undefined,
        optional: typeof item.optional === "boolean"
          ? item.optional
          : undefined,
        primaryKey: typeof item.primaryKey === "boolean"
          ? item.primaryKey
          : undefined,
      };
    })
    .filter((field): field is NonNullable<typeof field> => field !== null);
  return fields.length > 0 ? fields : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean);
}

function numberValue(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function optionalNumberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function isFactKind(kind: string): kind is ImportClassifierFact["kind"] {
  return kind === "framework" ||
    kind === "convention" ||
    kind === "import-strategy" ||
    kind === "mapping" ||
    kind === "unknown";
}

function severityValue(value: unknown): ImportClassifierDiagnostic["severity"] {
  return value === "error" || value === "warning" || value === "info"
    ? value
    : "warning";
}

function sourceLanguageValue(value: unknown) {
  return value === "typescript" ||
      value === "javascript" ||
      value === "tsx" ||
      value === "jsx" ||
      value === "json" ||
      value === "css" ||
      value === "html" ||
      value === "markdown" ||
      value === "unknown"
    ? value
    : undefined;
}

function pathSyntaxValue(value: unknown) {
  return value === "hono" ||
      value === "express" ||
      value === "next-file" ||
      value === "file-system" ||
      value === "unknown"
    ? value
    : undefined;
}

function schemaKindValue(value: unknown) {
  return value === "database" ||
      value === "validation" ||
      value === "type" ||
      value === "orm" ||
      value === "unknown"
    ? value
    : undefined;
}

function entityTypeValue(
  value: unknown,
): ImportClassifierCandidateEntity["entityType"] {
  return value === "route" ||
      value === "handler" ||
      value === "function" ||
      value === "schema" ||
      value === "component" ||
      value === "template" ||
      value === "asset" ||
      value === "type" ||
      value === "unknown"
    ? value
    : "unknown";
}
