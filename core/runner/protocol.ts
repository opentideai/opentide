// The wire protocol between the kernel and a project's user-code runner
// (docs: Tide's docs/plans/user-code-runner.md). JSON-RPC-shaped messages,
// Content-Length framed on stdio by ./transport.ts. Errors carry the kernel's
// semantic `Result` error shape instead of JSON-RPC's numeric codes.
//
// Every params and result payload goes through the value codec below, so a
// Date, a bigint or bytes from the DB arrive as themselves on the other side.

import type { Result } from "../types.ts";

export const RUNNER_PROTOCOL_VERSION = 1;

export const RUNNER_METHODS = {
  ping: "runner.ping",
  shutdown: "runner.shutdown",
} as const;

export const RUNNER_NOTIFICATIONS = {
  ready: "runner.ready",
} as const;

export const RUNNER_ERROR_CODES = {
  unserializable: "UNSERIALIZABLE_VALUE",
  unknownMethod: "UNKNOWN_METHOD",
  handlerFailed: "RUNNER_HANDLER_FAILED",
  timeout: "RUNNER_TIMEOUT",
  closed: "RUNNER_CLOSED",
  startFailed: "RUNNER_START_FAILED",
  protocolMismatch: "RUNNER_PROTOCOL_MISMATCH",
  invalidPath: "INVALID_RUNNER_PATH",
} as const;

export interface RunnerReady {
  protocolVersion: number;
  pid: number;
  denoVersion: string;
}

export type RpcError = { code: string; message: string; suggestion?: string };

export interface RpcRequest {
  id: number;
  method: string;
  params: unknown;
}

export interface RpcNotification {
  method: string;
  params: unknown;
}

export type RpcResponse =
  | { id: number; result: unknown }
  | { id: number; error: RpcError };

export type RpcMessage = RpcRequest | RpcNotification | RpcResponse;

export function isRequest(m: RpcMessage): m is RpcRequest {
  return "method" in m && "id" in m;
}

export function isNotification(m: RpcMessage): m is RpcNotification {
  return "method" in m && !("id" in m);
}

// A frame off the wire, checked for shape. Anything else is null and gets
// dropped: the other side is not trusted to be well-formed.
export function parseRpcMessage(raw: unknown): RpcMessage | null {
  if (!isPlainObject(raw)) return null;
  const hasId = typeof raw.id === "number" && Number.isInteger(raw.id);
  if (typeof raw.method === "string") {
    return hasId
      ? { id: raw.id as number, method: raw.method, params: raw.params }
      : { method: raw.method, params: raw.params };
  }
  if (!hasId) return null;
  if ("result" in raw) return { id: raw.id as number, result: raw.result };
  if (isRpcError(raw.error)) return { id: raw.id as number, error: raw.error };
  return null;
}

function isRpcError(value: unknown): value is RpcError {
  return isPlainObject(value) && typeof value.code === "string" &&
    typeof value.message === "string";
}

// --- Value codec ---
//
// JSON plus tagged values for what JSON drops or mangles. A tagged value is
// `{ "$rt": <tag>, "v": <payload> }`. A plain object that happens to have a
// `$rt` key is wrapped as tag "object", so decoding never misreads user data.
// Anything else that isn't plain data (functions, symbols, Maps, class
// instances, cycles) fails loudly instead of vanishing the way JSON.stringify
// drops it.

const TAG_KEY = "$rt";

type Tag = "undefined" | "date" | "bigint" | "bytes" | "number" | "object";

export function encodeValue(value: unknown): Result<unknown> {
  try {
    return { ok: true, data: encodeAt(value, "$", new Set()) };
  } catch (err) {
    if (err instanceof UnserializableValue) {
      return {
        ok: false,
        error: {
          code: RUNNER_ERROR_CODES.unserializable,
          message: err.message,
          suggestion:
            "Pass plain data: objects, arrays, strings, numbers, booleans, null, Date, bigint or Uint8Array.",
        },
      };
    }
    throw err;
  }
}

export function decodeValue(wire: unknown): unknown {
  if (Array.isArray(wire)) return wire.map(decodeValue);
  if (!isPlainObject(wire)) return wire;
  if (typeof wire[TAG_KEY] === "string" && "v" in wire) {
    return decodeTagged(wire[TAG_KEY] as Tag, wire.v);
  }
  return mapObject(wire, decodeValue);
}

class UnserializableValue extends Error {}

function encodeAt(value: unknown, path: string, seen: Set<object>): unknown {
  switch (typeof value) {
    case "string":
    case "boolean":
      return value;
    case "number":
      return Number.isFinite(value) && !Object.is(value, -0)
        ? value
        : tagged("number", Object.is(value, -0) ? "-0" : String(value));
    case "undefined":
      return tagged("undefined", null);
    case "bigint":
      return tagged("bigint", value.toString());
    case "object":
      return value === null ? null : encodeObject(value, path, seen);
    default:
      throw new UnserializableValue(`${path} is a ${typeof value}`);
  }
}

function encodeObject(value: object, path: string, seen: Set<object>): unknown {
  if (value instanceof Date) return tagged("date", value.toISOString());
  if (value instanceof Uint8Array) return tagged("bytes", toBase64(value));
  if (seen.has(value)) throw new UnserializableValue(`${path} is circular`);
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((item, i) => encodeAt(item, `${path}[${i}]`, seen));
    }
    if (!isPlainObject(value)) {
      const name = value.constructor?.name ?? "object";
      throw new UnserializableValue(`${path} is a ${name}`);
    }
    const encoded = mapObject(
      value,
      (item, key) => encodeAt(item, `${path}.${key}`, seen),
    );
    return TAG_KEY in value ? tagged("object", encoded) : encoded;
  } finally {
    seen.delete(value);
  }
}

function decodeTagged(tag: Tag, payload: unknown): unknown {
  switch (tag) {
    case "undefined":
      return undefined;
    case "date":
      return new Date(payload as string);
    case "bigint":
      return BigInt(payload as string);
    case "bytes":
      return fromBase64(payload as string);
    case "number":
      return Number(payload as string);
    case "object":
      return mapObject(payload as Record<string, unknown>, decodeValue);
    default:
      return { [TAG_KEY]: tag, v: payload };
  }
}

function tagged(tag: Tag, v: unknown): Record<string, unknown> {
  return { [TAG_KEY]: tag, v };
}

function mapObject(
  obj: Record<string, unknown>,
  fn: (value: unknown, key: string) => unknown,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) out[key] = fn(value, key);
  return out;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

// --- HTTP Request / Response over the wire ---
//
// Bodies are buffered whole. Streaming bodies (SSE) have no design yet; the
// handler-call slice has to design them or refuse them, never truncate.

export interface WireRequest {
  method: string;
  url: string;
  headers: [string, string][];
  body: Uint8Array<ArrayBuffer> | null;
}

export interface WireResponse {
  status: number;
  statusText: string;
  headers: [string, string][];
  body: Uint8Array<ArrayBuffer> | null;
}

export async function encodeRequest(req: Request): Promise<WireRequest> {
  return {
    method: req.method,
    url: req.url,
    headers: [...req.headers],
    body: req.body ? new Uint8Array(await req.arrayBuffer()) : null,
  };
}

export function decodeRequest(wire: WireRequest): Request {
  return new Request(wire.url, {
    method: wire.method,
    headers: wire.headers,
    body: wire.body,
  });
}

export async function encodeResponse(res: Response): Promise<WireResponse> {
  return {
    status: res.status,
    statusText: res.statusText,
    headers: [...res.headers],
    body: res.body ? new Uint8Array(await res.arrayBuffer()) : null,
  };
}

export function decodeResponse(wire: WireResponse): Response {
  return new Response(wire.body, {
    status: wire.status,
    statusText: wire.statusText,
    headers: wire.headers,
  });
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

function fromBase64(text: string): Uint8Array<ArrayBuffer> {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
