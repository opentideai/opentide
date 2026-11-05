// How RPC messages move between the kernel and a runner. The stdio transport
// frames them on a child process's pipes; the memory pair connects a runner
// served in the same process, for tests and for kernels with no project dir.
// A remote or microVM runner would be another implementation of this.

import { encodeFrame, FrameBuffer } from "../content-length-framing.ts";
import { parseRpcMessage, type RpcMessage } from "./protocol.ts";

export interface RunnerTransport {
  send(message: RpcMessage): Promise<void>;
  // Read once, by one consumer. Ends when the other side closes.
  incoming(): AsyncIterable<RpcMessage>;
  close(): Promise<void>;
}

export function createStreamTransport(
  readable: ReadableStream<Uint8Array>,
  writable: WritableStream<Uint8Array>,
): RunnerTransport {
  // One writer, one write per frame: frames never interleave.
  const writer = writable.getWriter();
  let closed = false;
  return {
    async send(message) {
      if (closed) return;
      await writer.write(encodeFrame(message));
    },
    async *incoming() {
      const frames = new FrameBuffer();
      for await (const chunk of readable) {
        frames.append(chunk);
        for (let raw = frames.next(); raw !== null; raw = frames.next()) {
          const message = parseRpcMessage(raw);
          if (message) yield message;
        }
      }
    },
    async close() {
      if (closed) return;
      closed = true;
      await writer.close().catch(() => {
        // The other side is already gone; nothing left to flush.
      });
    },
  };
}

// Two connected ends. Messages go through JSON on the way, so a test on the
// memory pair sees exactly what the stdio wire would carry.
export function createMemoryTransportPair(): [
  RunnerTransport,
  RunnerTransport,
] {
  const aToB = new MessageQueue();
  const bToA = new MessageQueue();
  return [memoryEnd(aToB, bToA), memoryEnd(bToA, aToB)];
}

function memoryEnd(out: MessageQueue, inbox: MessageQueue): RunnerTransport {
  return {
    send(message) {
      const raw = parseRpcMessage(JSON.parse(JSON.stringify(message)));
      if (raw) out.push(raw);
      return Promise.resolve();
    },
    incoming: () => inbox,
    close() {
      out.end();
      inbox.end();
      return Promise.resolve();
    },
  };
}

class MessageQueue implements AsyncIterable<RpcMessage> {
  private readonly items: RpcMessage[] = [];
  private waiting: ((result: IteratorResult<RpcMessage>) => void) | null = null;
  private ended = false;

  push(message: RpcMessage): void {
    if (this.ended) return;
    if (this.waiting) {
      const wake = this.waiting;
      this.waiting = null;
      wake({ value: message, done: false });
    } else {
      this.items.push(message);
    }
  }

  end(): void {
    this.ended = true;
    if (this.waiting) {
      const wake = this.waiting;
      this.waiting = null;
      wake({ value: undefined, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<RpcMessage> {
    return {
      next: () => {
        const item = this.items.shift();
        if (item) return Promise.resolve({ value: item, done: false });
        if (this.ended) {
          return Promise.resolve({ value: undefined, done: true });
        }
        return new Promise((resolve) => (this.waiting = resolve));
      },
    };
  }
}
