import type { ChangeRecord } from "./changelog.ts";

export interface WorkItemRationale {
  why: string;
  implementation: string;
}

export interface WorkItemPayload {
  kind: "code_change";
  changeId: number;
  title: string;
  toolName: string;
  rationale: WorkItemRationale;
  change?: ChangeRecord;
}

const MARKER_START = "<genie-work-item>";
const MARKER_END = "</genie-work-item>";

const ACTION_VERB: Record<string, string> = {
  create: "Created",
  update: "Updated",
  delete: "Deleted",
  execute: "Executed",
  restore: "Restored",
};

export function buildWorkItemPayload(
  toolName: string,
  toolInput: unknown,
  change: ChangeRecord,
): WorkItemPayload {
  const title = `${
    ACTION_VERB[change.action] ?? change.action
  } ${change.category} "${change.key}"`;
  const input = toolInput && typeof toolInput === "object"
    ? toolInput as Record<string, unknown>
    : {};
  const why = stringOrFallback(
    input.rationale,
    `${title} to satisfy the requested change.`,
  );
  const implementation = stringOrFallback(
    input.implementation,
    `Used the existing ${toolName} mutation path so validation, changelog, and rebuild behavior stay consistent.`,
  );

  return {
    kind: "code_change",
    changeId: change.id,
    title,
    toolName,
    rationale: { why, implementation },
    change,
  };
}

export function encodeWorkItemMessage(payload: WorkItemPayload): string {
  const stored = {
    kind: payload.kind,
    changeId: payload.changeId,
    title: payload.title,
    toolName: payload.toolName,
  };
  return [
    `Code change: ${payload.title}`,
    "",
    `Why: ${payload.rationale.why}`,
    `Implementation: ${payload.rationale.implementation}`,
    "",
    `${MARKER_START}${JSON.stringify(stored)}${MARKER_END}`,
  ].join("\n");
}

export function sanitizeWorkItemText(text: string): string {
  let cleaned = text.trim();
  const cutIndexes = [
    cleaned.search(/<\/\s*(?:rationale|why|implementation|parameter)\s*>/i),
    cleaned.search(/<\s*parameter\b[^>]*>/i),
  ].filter((index) => index >= 0);
  if (cutIndexes.length > 0) {
    cleaned = cleaned.slice(0, Math.min(...cutIndexes));
  }
  return cleaned
    .replace(/<\s*\/?\s*(?:rationale|why|implementation)\s*>/gi, "")
    .trim();
}

export function decodeWorkItemMessage(content: string): WorkItemPayload | null {
  const start = content.indexOf(MARKER_START);
  const end = content.indexOf(MARKER_END);
  if (start < 0 || end < 0 || end <= start) return null;
  const raw = content.slice(start + MARKER_START.length, end);
  try {
    const parsed = JSON.parse(raw) as WorkItemPayload;
    if (parsed?.kind !== "code_change") return null;
    if (typeof parsed.changeId !== "number") {
      const legacy = parsed as WorkItemPayload & { change?: ChangeRecord };
      if (!legacy.change?.id) return null;
      legacy.changeId = legacy.change.id;
      legacy.title ??= `${
        ACTION_VERB[legacy.change.action] ?? legacy.change.action
      } ${legacy.change.category} "${legacy.change.key}"`;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function stripWorkItemMarker(content: string): string {
  return content.replace(
    new RegExp(`\\n*${MARKER_START}[\\s\\S]*?${MARKER_END}\\s*`, "g"),
    "",
  ).trimEnd();
}

function stringOrFallback(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback;
  const cleaned = sanitizeWorkItemText(value);
  return cleaned ? cleaned : fallback;
}
