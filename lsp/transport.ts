// @layer lsp — the LSP base-protocol framing over stdio. The base protocol is
// JSON-RPC bodies prefixed with `Content-Length: <n>\r\n\r\n` headers; this module
// reads that framing off a byte stream and writes it back, and nothing else. It
// is the first transport (docs/lsp-support-plan.md §11.5: stdio ahead of HTTP/WS)
// and the ONLY place that touches raw bytes — the server (server.ts) stays
// transport-agnostic, so HTTP/WS slots in later as a sibling of this file with no
// server change.
//
// Framing is hand-rolled (no vscode-jsonrpc dependency): it is ~one screen of
// well-understood code and keeps the open layer dependency-light. stdout is the
// JSON-RPC channel, so this module writes ONLY encoded frames there; all logging
// goes through the kernel (server.ts) or stderr (the composition root).
import type {
  IncomingMessage,
  NotificationMessage,
  ResponseMessage,
} from "./protocol.ts";
import type { LspServer } from "./server.ts";

const HEADER_SEPARATOR = "\r\n\r\n";
const CONTENT_LENGTH_HEADER = "content-length";
const encoder = new TextEncoder();
const decoder = new TextDecoder();

// Encode an outgoing message as a Content-Length-framed frame. Length is the UTF-8
// BYTE count of the body (not the character count) — the spec is explicit and a
// multibyte body would otherwise truncate. Both request responses and server→client
// notifications (Stage 1 publishDiagnostics) ride the same framing.
export function encodeMessage(
  message: ResponseMessage | NotificationMessage,
): Uint8Array {
  const body = encoder.encode(JSON.stringify(message));
  const header = encoder.encode(
    `Content-Length: ${body.byteLength}${HEADER_SEPARATOR}`,
  );
  const frame = new Uint8Array(header.byteLength + body.byteLength);
  frame.set(header, 0);
  frame.set(body, header.byteLength);
  return frame;
}

// Incremental parser: fed arbitrary byte chunks, it yields complete decoded
// messages as their frames arrive. A single chunk may hold zero, one, or many
// frames, and a frame may span chunks — the buffer holds the unconsumed tail.
export class MessageBuffer {
  private buffer = new Uint8Array(0);

  append(chunk: Uint8Array): void {
    const next = new Uint8Array(this.buffer.byteLength + chunk.byteLength);
    next.set(this.buffer, 0);
    next.set(chunk, this.buffer.byteLength);
    this.buffer = next;
  }

  // Pull the next complete message, or null if the buffer does not yet hold a full
  // frame (caller waits for more bytes). Malformed frames (bad JSON / missing
  // Content-Length) are skipped past so one bad frame can't wedge the stream.
  tryReadMessage(): IncomingMessage | null {
    const headerEnd = this.indexOfSeparator();
    if (headerEnd === -1) return null;

    const headerText = decoder.decode(this.buffer.subarray(0, headerEnd));
    const contentLength = parseContentLength(headerText);
    const bodyStart = headerEnd + HEADER_SEPARATOR.length;

    if (contentLength === null) {
      // Unusable header block — drop it and resync from after the separator.
      this.buffer = this.buffer.subarray(bodyStart);
      return null;
    }
    if (this.buffer.byteLength < bodyStart + contentLength) return null;

    const body = this.buffer.subarray(bodyStart, bodyStart + contentLength);
    this.buffer = this.buffer.subarray(bodyStart + contentLength);
    try {
      return JSON.parse(decoder.decode(body)) as IncomingMessage;
    } catch {
      // Body wasn't valid JSON — already consumed, so just skip it.
      return null;
    }
  }

  // Byte offset of the `\r\n\r\n` header/body separator, or -1 if not present yet.
  private indexOfSeparator(): number {
    const sep = encoder.encode(HEADER_SEPARATOR);
    outer:
    for (let i = 0; i + sep.byteLength <= this.buffer.byteLength; i++) {
      for (let j = 0; j < sep.byteLength; j++) {
        if (this.buffer[i + j] !== sep[j]) continue outer;
      }
      return i;
    }
    return -1;
  }
}

// Extract the Content-Length value from a header block (case-insensitive header
// name, per HTTP). Returns null when absent or non-numeric.
function parseContentLength(headerText: string): number | null {
  for (const line of headerText.split("\r\n")) {
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    if (line.slice(0, colon).trim().toLowerCase() !== CONTENT_LENGTH_HEADER) {
      continue;
    }
    const value = Number(line.slice(colon + 1).trim());
    return Number.isInteger(value) && value >= 0 ? value : null;
  }
  return null;
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
