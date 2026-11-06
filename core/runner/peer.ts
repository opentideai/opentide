// One end of a runner connection: sends requests and matches their responses,
// answers the other side's requests, and passes notifications on. The kernel
// and the runner each hold one, because requests go both ways (the runner
// calls back for DB queries).

import type { Result } from "../types.ts";
import {
  decodeValue,
  encodeValue,
  isNotification,
  isRequest,
  type RpcError,
  type RpcMessage,
  type RpcResponse,
  RUNNER_ERROR_CODES,
} from "./protocol.ts";
import type { RunnerTransport } from "./transport.ts";

export type RequestHandler = (
  params: unknown,
) => Result<unknown> | Promise<Result<unknown>>;

export interface PeerOptions {
  handlers?: Record<string, RequestHandler>;
  onNotification?: (method: string, params: unknown) => void;
}

interface Pending {
  resolve: (result: Result<unknown>) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class RpcPeer {
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private closedError: RpcError | null = null;
  // Resolves when the other side has gone and every pending call has failed.
  readonly done: Promise<void>;

  constructor(
    private readonly transport: RunnerTransport,
    private readonly options: PeerOptions = {},
  ) {
    this.done = this.readLoop();
  }

  async request<T>(
    method: string,
    params: unknown,
    timeoutMs: number,
  ): Promise<Result<T>> {
    if (this.closedError) return { ok: false, error: this.closedError };
    const encoded = encodeValue(params);
    if (!encoded.ok) return encoded;
    const id = this.nextId++;
    const result = new Promise<Result<unknown>>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve(failure(
          RUNNER_ERROR_CODES.timeout,
          `${method} got no answer in ${timeoutMs} ms`,
        ));
      }, timeoutMs);
      this.pending.set(id, { resolve, timer });
    });
    try {
      await this.transport.send({ id, method, params: encoded.data });
    } catch (err) {
      this.settle({
        id,
        error: {
          code: RUNNER_ERROR_CODES.closed,
          message: `${method} could not be sent: ${errorText(err)}`,
        },
      });
    }
    return await result as Result<T>;
  }

  async notify(method: string, params: unknown): Promise<Result<void>> {
    const encoded = encodeValue(params);
    if (!encoded.ok) return encoded;
    await this.transport.send({ method, params: encoded.data });
    return { ok: true, data: undefined };
  }

  async close(): Promise<void> {
    await this.transport.close();
    await this.done;
  }

  private async readLoop(): Promise<void> {
    try {
      for await (const message of this.transport.incoming()) {
        this.receive(message);
      }
    } finally {
      this.failPending({
        code: RUNNER_ERROR_CODES.closed,
        message: "The runner connection closed.",
      });
    }
  }

  private receive(message: RpcMessage): void {
    if (isRequest(message)) {
      void this.answer(message.id, message.method, message.params);
    } else if (isNotification(message)) {
      this.options.onNotification?.(
        message.method,
        decodeValue(message.params),
      );
    } else {
      this.settle(message);
    }
  }

  private settle(response: RpcResponse): void {
    const pending = this.pending.get(response.id);
    if (!pending) return;
    this.pending.delete(response.id);
    clearTimeout(pending.timer);
    pending.resolve(
      "error" in response
        ? { ok: false, error: response.error }
        : { ok: true, data: decodeValue(response.result) },
    );
  }

  private async answer(
    id: number,
    method: string,
    params: unknown,
  ): Promise<void> {
    const result = await this.run(method, params);
    const encoded = result.ok ? encodeValue(result.data) : result;
    await this.transport.send(
      encoded.ok ? { id, result: encoded.data } : { id, error: encoded.error },
    ).catch(() => {
      // The other side hung up mid-answer; its pending call fails on its end.
    });
  }

  private async run(method: string, params: unknown): Promise<Result<unknown>> {
    // Own keys only: the other side must not reach Object.prototype's methods.
    const handlers = this.options.handlers ?? {};
    const handler = Object.hasOwn(handlers, method)
      ? handlers[method]
      : undefined;
    if (!handler) {
      return failure(RUNNER_ERROR_CODES.unknownMethod, `No method ${method}`);
    }
    try {
      return await handler(decodeValue(params));
    } catch (err) {
      return failure(
        RUNNER_ERROR_CODES.handlerFailed,
        `${method} threw: ${errorText(err)}`,
      );
    }
  }

  private failPending(error: RpcError): void {
    this.closedError = error;
    for (const { resolve, timer } of this.pending.values()) {
      clearTimeout(timer);
      resolve({ ok: false, error });
    }
    this.pending.clear();
  }
}

export function failure(code: string, message: string): Result<never> {
  return { ok: false, error: { code, message } };
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
