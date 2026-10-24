/**
 * The platform globals a user-app entity runs against.
 *
 * The language service loads `lib.esnext.d.ts` and nothing else — deliberately no
 * DOM, because handlers are server code and `window`, `document` and `localStorage`
 * are mis-guidance in a completion list. The cost is that `Request`, `Response`,
 * `Headers`, `URL` and `fetch` come out undeclared, which was a nuisance while the
 * handler contract was a Hono `Context` and is fatal now that the fetch ABI *is* the
 * contract: `return new Response(...)` reported "Cannot find name 'Response'".
 *
 * Hand-written for that reason rather than pulling in `lib.dom.d.ts`. This is a
 * working subset, not a specification — it covers what handlers actually reach for,
 * and the way to extend it is to add the member someone tripped over.
 *
 * Everything here is reachable at runtime: the compiler injects `db`, `log`,
 * `functions` and friends as `new Function` parameters, and every other name below
 * resolves through Deno's own global scope. Nothing here is aspirational —
 * `core/docs/generated/compilation.md` has been promising `console`, `fetch`,
 * `TextEncoder` and the rest to the agent for as long as they were missing here.
 *
 * Purely LSP-facing. esbuild erases type annotations before a handler ever runs, so
 * nothing declared here affects runtime behaviour in either direction.
 */
export const PLATFORM_GLOBAL_DECLARATIONS =
  `// --- fetch standard -------------------------------------------------------

type BlobPart = string | ArrayBuffer | ArrayBufferView | Blob;
type BodyInit =
  | string
  | ArrayBuffer
  | ArrayBufferView
  | Blob
  | FormData
  | URLSearchParams
  | ReadableStream<Uint8Array>;
type HeadersInit = Headers | Record<string, string> | [string, string][];

interface Blob {
  readonly size: number;
  readonly type: string;
  arrayBuffer(): Promise<ArrayBuffer>;
  bytes(): Promise<Uint8Array>;
  text(): Promise<string>;
  slice(start?: number, end?: number, contentType?: string): Blob;
  stream(): ReadableStream<Uint8Array>;
}
declare var Blob: {
  new (parts?: BlobPart[], options?: { type?: string }): Blob;
  prototype: Blob;
};

interface File extends Blob {
  readonly name: string;
  readonly lastModified: number;
}
declare var File: {
  new (
    parts: BlobPart[],
    name: string,
    options?: { type?: string; lastModified?: number },
  ): File;
  prototype: File;
};

interface FormData {
  append(name: string, value: string | Blob, fileName?: string): void;
  delete(name: string): void;
  get(name: string): string | File | null;
  getAll(name: string): (string | File)[];
  has(name: string): boolean;
  set(name: string, value: string | Blob, fileName?: string): void;
  entries(): IterableIterator<[string, string | File]>;
  keys(): IterableIterator<string>;
  values(): IterableIterator<string | File>;
  forEach(
    callback: (value: string | File, key: string, parent: FormData) => void,
  ): void;
  [Symbol.iterator](): IterableIterator<[string, string | File]>;
}
declare var FormData: { new (): FormData; prototype: FormData };

interface ReadableStreamDefaultReader<R = any> {
  read(): Promise<{ done: false; value: R } | { done: true; value?: undefined }>;
  cancel(reason?: any): Promise<void>;
  releaseLock(): void;
}
interface ReadableStream<R = any> {
  readonly locked: boolean;
  cancel(reason?: any): Promise<void>;
  getReader(): ReadableStreamDefaultReader<R>;
  [Symbol.asyncIterator](): AsyncIterableIterator<R>;
}
declare var ReadableStream: {
  new <R = any>(underlyingSource?: {
    start?: (controller: any) => void | Promise<void>;
    pull?: (controller: any) => void | Promise<void>;
    cancel?: (reason?: any) => void | Promise<void>;
  }): ReadableStream<R>;
  prototype: ReadableStream;
};

interface AbortSignal {
  readonly aborted: boolean;
  readonly reason: any;
  throwIfAborted(): void;
  addEventListener(type: "abort", listener: () => void): void;
  removeEventListener(type: "abort", listener: () => void): void;
}
declare var AbortSignal: {
  prototype: AbortSignal;
  abort(reason?: any): AbortSignal;
  timeout(milliseconds: number): AbortSignal;
};
interface AbortController {
  readonly signal: AbortSignal;
  abort(reason?: any): void;
}
declare var AbortController: {
  new (): AbortController;
  prototype: AbortController;
};

interface Headers {
  append(name: string, value: string): void;
  delete(name: string): void;
  get(name: string): string | null;
  getSetCookie(): string[];
  has(name: string): boolean;
  set(name: string, value: string): void;
  forEach(
    callback: (value: string, key: string, parent: Headers) => void,
  ): void;
  entries(): IterableIterator<[string, string]>;
  keys(): IterableIterator<string>;
  values(): IterableIterator<string>;
  [Symbol.iterator](): IterableIterator<[string, string]>;
}
declare var Headers: { new (init?: HeadersInit): Headers; prototype: Headers };

interface URLSearchParams {
  readonly size: number;
  append(name: string, value: string): void;
  delete(name: string, value?: string): void;
  get(name: string): string | null;
  getAll(name: string): string[];
  has(name: string, value?: string): boolean;
  set(name: string, value: string): void;
  sort(): void;
  toString(): string;
  forEach(
    callback: (value: string, key: string, parent: URLSearchParams) => void,
  ): void;
  entries(): IterableIterator<[string, string]>;
  keys(): IterableIterator<string>;
  values(): IterableIterator<string>;
  [Symbol.iterator](): IterableIterator<[string, string]>;
}
declare var URLSearchParams: {
  new (
    init?:
      | string
      | Record<string, string>
      | [string, string][]
      | URLSearchParams,
  ): URLSearchParams;
  prototype: URLSearchParams;
};

interface URL {
  hash: string;
  host: string;
  hostname: string;
  href: string;
  readonly origin: string;
  password: string;
  pathname: string;
  port: string;
  protocol: string;
  search: string;
  readonly searchParams: URLSearchParams;
  username: string;
  toString(): string;
  toJSON(): string;
}
declare var URL: {
  new (url: string | URL, base?: string | URL): URL;
  prototype: URL;
  canParse(url: string | URL, base?: string): boolean;
};

interface RequestInit {
  method?: string;
  headers?: HeadersInit;
  body?: BodyInit | null;
  signal?: AbortSignal | null;
  redirect?: "follow" | "error" | "manual";
  credentials?: "omit" | "same-origin" | "include";
  cache?: string;
  integrity?: string;
  keepalive?: boolean;
  mode?: string;
  referrer?: string;
}

interface Request {
  readonly method: string;
  readonly url: string;
  readonly headers: Headers;
  readonly body: ReadableStream<Uint8Array> | null;
  readonly bodyUsed: boolean;
  readonly signal: AbortSignal;
  readonly redirect: "follow" | "error" | "manual";
  readonly integrity: string;
  readonly keepalive: boolean;
  arrayBuffer(): Promise<ArrayBuffer>;
  blob(): Promise<Blob>;
  bytes(): Promise<Uint8Array>;
  formData(): Promise<FormData>;
  json<T = any>(): Promise<T>;
  text(): Promise<string>;
  clone(): Request;
}
declare var Request: {
  new (input: string | URL | Request, init?: RequestInit): Request;
  prototype: Request;
};

interface ResponseInit {
  status?: number;
  statusText?: string;
  headers?: HeadersInit;
}

interface Response {
  readonly status: number;
  readonly statusText: string;
  readonly ok: boolean;
  readonly headers: Headers;
  readonly redirected: boolean;
  readonly type: string;
  readonly url: string;
  readonly body: ReadableStream<Uint8Array> | null;
  readonly bodyUsed: boolean;
  arrayBuffer(): Promise<ArrayBuffer>;
  blob(): Promise<Blob>;
  bytes(): Promise<Uint8Array>;
  formData(): Promise<FormData>;
  json<T = any>(): Promise<T>;
  text(): Promise<string>;
  clone(): Response;
}
declare var Response: {
  new (body?: BodyInit | null, init?: ResponseInit): Response;
  prototype: Response;
  json(data: any, init?: ResponseInit): Response;
  error(): Response;
  redirect(url: string | URL, status?: number): Response;
};

declare function fetch(
  input: string | URL | Request,
  init?: RequestInit,
): Promise<Response>;

// --- the handler contract -------------------------------------------------

/**
 * Everything the kernel knows about a request that the standard Request does not:
 * the values it matched out of the route pattern.
 */
interface HandlerContext {
  readonly params: Readonly<Record<string, string>>;
}

/** A route handler: a web-standard request in, a web-standard response out. */
type HandlerFn = (
  req: Request,
  ctx: HandlerContext,
) => Response | Promise<Response>;

// --- the rest of the runtime ----------------------------------------------
// Present at runtime, absent from lib.esnext, and already documented as available.
// Prefer the injected \`log\` over \`console\` in app code; \`console\` is declared
// because it works, not because it is the house style.

interface Console {
  log(...data: any[]): void;
  info(...data: any[]): void;
  warn(...data: any[]): void;
  error(...data: any[]): void;
  debug(...data: any[]): void;
  trace(...data: any[]): void;
  table(data: any, columns?: string[]): void;
  time(label?: string): void;
  timeEnd(label?: string): void;
  group(...data: any[]): void;
  groupEnd(): void;
  dir(item: any): void;
  assert(condition?: boolean, ...data: any[]): void;
  count(label?: string): void;
}
declare var console: Console;

declare function setTimeout(
  handler: (...args: any[]) => void,
  timeout?: number,
  ...args: any[]
): number;
declare function clearTimeout(id?: number): void;
declare function setInterval(
  handler: (...args: any[]) => void,
  timeout?: number,
  ...args: any[]
): number;
declare function clearInterval(id?: number): void;
declare function queueMicrotask(callback: () => void): void;

interface TextEncoder {
  readonly encoding: string;
  encode(input?: string): Uint8Array;
  encodeInto(
    source: string,
    destination: Uint8Array,
  ): { read: number; written: number };
}
declare var TextEncoder: { new (): TextEncoder; prototype: TextEncoder };

interface TextDecoder {
  readonly encoding: string;
  readonly fatal: boolean;
  readonly ignoreBOM: boolean;
  decode(input?: ArrayBuffer | ArrayBufferView): string;
}
declare var TextDecoder: {
  new (
    label?: string,
    options?: { fatal?: boolean; ignoreBOM?: boolean },
  ): TextDecoder;
  prototype: TextDecoder;
};

interface SubtleCrypto {
  digest(
    algorithm: string | { name: string },
    data: ArrayBuffer | ArrayBufferView,
  ): Promise<ArrayBuffer>;
  importKey(
    format: string,
    keyData: any,
    algorithm: any,
    extractable: boolean,
    keyUsages: string[],
  ): Promise<any>;
  sign(algorithm: any, key: any, data: ArrayBuffer | ArrayBufferView): Promise<
    ArrayBuffer
  >;
  verify(
    algorithm: any,
    key: any,
    signature: ArrayBuffer | ArrayBufferView,
    data: ArrayBuffer | ArrayBufferView,
  ): Promise<boolean>;
  encrypt(algorithm: any, key: any, data: ArrayBuffer | ArrayBufferView):
    Promise<ArrayBuffer>;
  decrypt(algorithm: any, key: any, data: ArrayBuffer | ArrayBufferView):
    Promise<ArrayBuffer>;
  generateKey(algorithm: any, extractable: boolean, keyUsages: string[]):
    Promise<any>;
}
declare var crypto: {
  readonly subtle: SubtleCrypto;
  randomUUID(): string;
  getRandomValues<T extends ArrayBufferView>(array: T): T;
};

declare function btoa(data: string): string;
declare function atob(data: string): string;
declare function structuredClone<T>(value: T): T;

declare var performance: {
  now(): number;
  readonly timeOrigin: number;
};
`;
