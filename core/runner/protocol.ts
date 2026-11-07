// The wire protocol between the kernel and a project's user-code runner
// (docs: Tide's docs/plans/user-code-runner.md). JSON-RPC-shaped messages,
// Content-Length framed on stdio by ./transport.ts. Errors carry the kernel's
// semantic `Result` error shape instead of JSON-RPC's numeric codes.
//
// Every params and result payload goes through the value codec below, so a
// Date, a bigint or bytes from the DB arrive as themselves on the other side.

import type {
  ColumnDef,
  DevToolArgDef,
  KernelInspectAPI,
  LogLevel,
  Result,
  SchemaEntry,
} from "../types.ts";
import type { HandlerAbi } from "../handler-abi.ts";
import type { ForeignTraceEvent } from "../trace-context.ts";

export const RUNNER_PROTOCOL_VERSION = 1;

export const RUNNER_METHODS = {
  ping: "runner.ping",
  shutdown: "runner.shutdown",
  // Runner to kernel: one SQL statement, run by the kernel's database.
  dbExec: "db.exec",
  // Kernel to runner: what changed in the user code and state it mirrors.
  stateSync: "state.sync",
  // Kernel to runner: what the runner holds, by hash.
  stateManifest: "state.manifest",
  // Kernel to runner: would this code instantiate? Holds nothing.
  stateCheck: "state.check",
  // Kernel to runner: run one piece of user code.
  invokeHandler: "invoke.handler",
  invokeFunction: "invoke.function",
  invokeTest: "invoke.test",
  invokeDevTool: "invoke.dev_tool",
  invokeDevView: "invoke.dev_view",
  invokeScript: "invoke.script",
  // Runner to kernel: a fetch to the app's own origin, which the runner
  // can't reach itself.
  appFetch: "app.fetch",
} as const;

export const RUNNER_NOTIFICATIONS = {
  ready: "runner.ready",
  // Runner to kernel: a line user code logged.
  log: "runner.log",
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
  invalidParams: "INVALID_RUNNER_PARAMS",
  notLoaded: "RUNNER_ENTITY_NOT_LOADED",
  streamingUnsupported: "STREAMING_UNSUPPORTED",
} as const;

export interface RunnerReady {
  protocolVersion: number;
  pid: number;
  denoVersion: string;
}

// What a db.exec call runs. `query` and `execute` are user code's raw
// db.query/db.execute. The drizzle kinds are what pg-proxy asks for: `rows` is
// positional arrays for drizzle to map, `result` is the driver's own result for
// statements drizzle doesn't map (an insert with no returning, say).
export const DB_EXEC_KINDS = {
  query: "query",
  execute: "execute",
  drizzleRows: "drizzle.rows",
  drizzleResult: "drizzle.result",
} as const;

export type DbExecKind = typeof DB_EXEC_KINDS[keyof typeof DB_EXEC_KINDS];

export interface DbExecRequest {
  kind: DbExecKind;
  sql: string;
  params: unknown[] | undefined;
}

// The error user code would have caught in-process: its name, message and the
// driver's fields (a Postgres `code`, `constraint`, `detail`...). The class is
// lost on the way.
export interface DbErrorShape {
  name: string;
  message: string;
  fields: Record<string, string | number | boolean>;
}

// A failed statement is a normal answer, not an RPC error: the RPC error
// channel is for the connection.
export type DbExecOutcome =
  | { ok: true; value: unknown }
  | { ok: false; error: DbErrorShape };

// --- State mirror ---
//
// The runner holds a copy of the user code and state that user code reads.
// The kernel sends what changed (./mirror.ts); the runner applies it
// (./runner-state.ts). Each entry is a category, a key and a hash of what the
// kernel built the payload from.

export const MIRROR_CATEGORIES = {
  handler: "handler",
  function: "function",
  test: "test",
  devView: "dev_view",
  devTool: "dev_tool",
  template: "template",
  assetVersion: "asset_version",
  config: "config",
  schema: "schema",
  package: "package",
  env: "env",
  app: "app",
} as const;

export type MirrorCategory =
  typeof MIRROR_CATEGORIES[keyof typeof MIRROR_CATEGORIES];

export interface MirrorPayloads {
  handler: { js: string; abi: HandlerAbi };
  function: { js: string };
  test: { js: string };
  dev_view: { js: string };
  dev_tool: { js: string; args: DevToolArgDef[] };
  template: { content: string };
  asset_version: { version: string };
  config: { value: unknown };
  schema: { columns: ColumnDef[] };
  // The runner imports these itself, from the specifier.
  package: { specifier: string };
  env: { vars: Record<string, string> };
  // The runner's own environment is the project's, so it can't work out the
  // app's origin; the kernel sends it.
  app: { port: number; origin: string };
}

// The one key of a category that has a single entry (env, app).
export const MIRROR_SINGLETON_KEY = "*";

export interface MirrorRef {
  category: MirrorCategory;
  key: string;
}

export interface MirrorManifestEntry extends MirrorRef {
  hash: string;
}

// A category never contains ":", so this can't collide.
export function mirrorEntryId(ref: MirrorRef): string {
  return `${ref.category}:${ref.key}`;
}

// One entry's payload, tagged with its category so the two stay matched.
export type MirrorPayload = {
  [C in MirrorCategory]: MirrorRef & {
    category: C;
    payload: MirrorPayloads[C];
  };
}[MirrorCategory];

export type MirrorUpsert = MirrorPayload & { hash: string };

// `failed` is what the kernel couldn't build (a transpile error): the runner
// drops its copy and holds the entry as failed, under its hash.
export interface StateSyncRequest {
  removes: MirrorRef[];
  upserts: MirrorUpsert[];
  failed: MirrorManifestEntry[];
}

export interface MirrorFailure extends MirrorRef {
  error: RpcError;
}

// Entries the runner took but couldn't instantiate. It holds them as failed,
// under their hash, so the kernel doesn't send them again until they change.
export interface StateSyncAnswer {
  failures: MirrorFailure[];
}

// --- Running user code ---
//
// The kernel syncs the mirror, then asks for one call. The answer says how the
// call ended and carries the trace events the runner recorded during it, with
// times in ms since the runner took the call.

// An error user code threw, as the kernel rethrows it: the class is lost.
// No name means user code threw something that isn't an Error.
export interface ThrownError {
  name?: string;
  message: string;
  stack?: string;
}

export type InvokeOutcome =
  | { kind: "value"; value: unknown }
  | { kind: "response"; response: WireResponse }
  | { kind: "thrown"; error: ThrownError };

export interface InvokeAnswer {
  outcome: InvokeOutcome;
  events: ForeignTraceEvent[];
}

export interface HandlerInvoke {
  name: string;
  request: WireRequest;
  ctx: unknown;
}

export interface CallInvoke {
  name: string;
  args: unknown[];
}

// What a user dev view's `kernel` reads, taken when the call is made:
// KernelInspectAPI is synchronous, so the runner can't ask as it goes.
export interface KernelInspectSnapshot {
  routes: ReturnType<KernelInspectAPI["listRoutes"]>;
  handlers: ReturnType<KernelInspectAPI["listHandlers"]>;
  functions: ReturnType<KernelInspectAPI["listFunctions"]>;
  configs: ReturnType<KernelInspectAPI["listConfigs"]>;
  schemas: SchemaEntry[];
  types: ReturnType<KernelInspectAPI["listTypes"]>;
  devViews: ReturnType<KernelInspectAPI["listDevViews"]>;
  assets: Record<string, string | null>;
  devViewSources: Record<string, string>;
}

export interface DevViewInvoke {
  name: string;
  object: unknown;
  inspect: KernelInspectSnapshot;
}

export interface ScriptInvoke {
  js: string;
  timeoutMs: number;
  // Whether each line also goes to the kernel's log as it's logged.
  logToKernel: boolean;
}

export const RUNNER_LOG_SOURCES = ["app", "script"] as const;

export interface RunnerLogLine {
  source: typeof RUNNER_LOG_SOURCES[number];
  level: LogLevel;
  message: string;
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
// Bodies are buffered whole. A server-sent event stream never ends, so it
// can't be buffered: it's refused with STREAMING_UNSUPPORTED instead of
// hanging until the handler times out.

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

const EVENT_STREAM_TYPE = "text/event-stream";

export async function encodeResponse(
  res: Response,
): Promise<Result<WireResponse>> {
  const type = res.headers.get("content-type") ?? "";
  if (type.toLowerCase().startsWith(EVENT_STREAM_TYPE)) {
    await res.body?.cancel();
    return {
      ok: false,
      error: {
        code: RUNNER_ERROR_CODES.streamingUnsupported,
        message:
          `A ${EVENT_STREAM_TYPE} response can't cross the user-code runner yet: bodies are buffered whole.`,
        suggestion: "Return the whole body at once.",
      },
    };
  }
  return {
    ok: true,
    data: {
      status: res.status,
      statusText: res.statusText,
      headers: [...res.headers],
      body: res.body ? new Uint8Array(await res.arrayBuffer()) : null,
    },
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
