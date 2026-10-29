import { OMITTED_RESULT_KEY, TOOL_RESULT_INLINE_BYTES } from "./config.ts";

// A window onto a session's messages, newest first in what it leaves out: the
// IDE opens a conversation on its latest messages and fetches earlier ones as
// they're scrolled to. Long sessions hold megabytes of tool results.

export interface MessageWindow {
  // The newest `last` messages, or the newest `last` before message `before`.
  last?: number;
  before?: number;
  // Every message from `since` on: a reload that keeps what's already shown.
  since?: number;
}

export interface MessagePage<T> {
  messages: T[];
  // How many messages come before the page.
  earlier: number;
}

export function pageMessages<T extends { id: number }>(
  all: readonly T[],
  window: MessageWindow,
): MessagePage<T> {
  if (window.since !== undefined) {
    const start = firstIndexFrom(all, window.since);
    return { messages: all.slice(start), earlier: start };
  }
  const end = window.before === undefined
    ? all.length
    : firstIndexFrom(all, window.before);
  const start = Math.max(0, end - (window.last ?? end));
  return { messages: all.slice(start, end), earlier: start };
}

// Index of the first message with id >= `id` (ids ascend).
function firstIndexFrom<T extends { id: number }>(
  all: readonly T[],
  id: number,
): number {
  const index = all.findIndex((message) => message.id >= id);
  return index < 0 ? all.length : index;
}

// Reads the window from a request's query; null when it asks for none.
export function messageWindowFrom(
  query: (name: string) => string | undefined,
): MessageWindow | null {
  const last = positiveInt(query("last"));
  const before = positiveInt(query("before"));
  const since = positiveInt(query("since"));
  if (last === undefined && since === undefined) return null;
  return { last, before, since };
}

function positiveInt(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

// What a stub keeps of a big result: whether it worked, why not, and the
// changeset the chat draws its plan and step cards from.
const KEPT_RESULT_KEYS = ["ok", "error", "_changesetEvent", "_changeset"];

// A stored message's toolCalls JSON with every big result cut to a stub.
export function compactToolCalls(toolCalls: string | null): string | null {
  if (!toolCalls) return toolCalls;
  const calls = JSON.parse(toolCalls) as unknown;
  if (!Array.isArray(calls)) return toolCalls;
  return JSON.stringify(
    calls.map((call) =>
      isRecord(call) && "result" in call
        ? { ...call, result: compactResult(call.result) }
        : call
    ),
  );
}

export function compactResult(result: unknown): unknown {
  const bytes = JSON.stringify(result)?.length ?? 0;
  if (bytes <= TOOL_RESULT_INLINE_BYTES) return result;
  const stub: Record<string, unknown> = { [OMITTED_RESULT_KEY]: { bytes } };
  if (!isRecord(result)) return stub;
  for (const key of KEPT_RESULT_KEYS) {
    if (key in result) stub[key] = result[key];
  }
  if (isChangeset(result.data)) stub.data = result.data;
  return stub;
}

function isChangeset(value: unknown): boolean {
  return isRecord(value) && typeof value.id === "string" &&
    isRecord(value.plan);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
