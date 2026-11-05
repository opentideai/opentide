// @layer lsp — the LSP base-protocol framing over stdio. The base protocol is
// JSON-RPC bodies prefixed with `Content-Length: <n>\r\n\r\n` headers; this module
// reads that framing off a byte stream and writes it back, and nothing else. It
// is the first transport (docs/lsp-support-plan.md §11.5: stdio ahead of HTTP/WS)
// and the ONLY place that touches raw bytes — the server (server.ts) stays
// transport-agnostic, so HTTP/WS slots in later as a sibling of this file with no
// server change.
//
// The framing itself is core/content-length-framing.ts (no vscode-jsonrpc
// dependency), shared with the user-code runner's channel. stdout is the
// JSON-RPC channel, so this module writes ONLY encoded frames there; all logging
// goes through the kernel (server.ts) or stderr (the composition root).
import { encodeFrame, FrameBuffer } from "../core/content-length-framing.ts";
import type {
  IncomingMessage,
  NotificationMessage,
  ResponseMessage,
} from "./protocol.ts";
import type { LspServer } from "./server.ts";

// Both request responses and server→client notifications (Stage 1
// publishDiagnostics) ride the same framing.
export function encodeMessage(
  message: ResponseMessage | NotificationMessage,
): Uint8Array {
  return encodeFrame(message);
}

// Incremental parser over core's FrameBuffer, typed for LSP messages.
export class MessageBuffer {
  private readonly frames = new FrameBuffer();

  append(chunk: Uint8Array): void {
    this.frames.append(chunk);
  }

  // The next complete message, or null if no full frame is buffered yet.
  // Malformed frames are skipped past.
  tryReadMessage(): IncomingMessage | null {
    return this.frames.next() as IncomingMessage | null;
  }
}

// Streams the server can serve over. Defaulted to stdin/stdout by the composition
// root; overridable so tests drive the loop with in-memory streams (no subprocess).
export interface LspStdioStreams {
  input: ReadableStream<Uint8Array>;
  output: WritableStream<Uint8Array>;
}

// Serve one LSP connection: read framed messages from `input`, dispatch each
// through the server, write framed responses to `output`. Resolves when the input
// stream ends or the client sends `exit` (server.hasExited()). Never writes
// anything but encoded frames to `output`.
export async function serveLspStdio(
  server: LspServer,
  streams: LspStdioStreams = {
    input: Deno.stdin.readable,
    output: Deno.stdout.writable,
  },
): Promise<void> {
  const messages = new MessageBuffer();
  const writer = streams.output.getWriter();
  // Route the server's outbound pushes (publishDiagnostics) to the same framed
  // writer the responses use. A single writer serializes chunks in call order and
  // each frame is one atomic write, so a push fired from the debounce timer can
  // never interleave mid-frame with a response. Failures (writer closed after exit)
  // are swallowed — the loop below owns the lifecycle.
  server.bindOutput((notification) => {
    writer.write(encodeMessage(notification)).catch(() => {});
  });
  try {
    for await (const chunk of streams.input) {
      messages.append(chunk);
      // Drain every complete frame this chunk made available before reading more.
      for (
        let message = messages.tryReadMessage();
        message !== null;
        message = messages.tryReadMessage()
      ) {
        const response = await server.dispatch(message);
        if (response) await writer.write(encodeMessage(response));
        if (server.hasExited()) return;
      }
    }
  } finally {
    await writer.close().catch(() => {});
  }
}
