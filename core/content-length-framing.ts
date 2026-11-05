// Content-Length framing: a JSON body behind a `Content-Length: <n>\r\n\r\n`
// header, the LSP base protocol's framing. The LSP server (lsp/transport.ts) and
// the user-code runner's stdio channel (core/runner/transport.ts) both speak it.

const HEADER_SEPARATOR = "\r\n\r\n";
const CONTENT_LENGTH_HEADER = "content-length";
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const SEPARATOR_BYTES = encoder.encode(HEADER_SEPARATOR);

// The length is the body's UTF-8 byte count, not its character count. A
// multibyte body would otherwise be cut short.
export function encodeFrame(value: unknown): Uint8Array {
  const body = encoder.encode(JSON.stringify(value));
  const header = encoder.encode(
    `Content-Length: ${body.byteLength}${HEADER_SEPARATOR}`,
  );
  const frame = new Uint8Array(header.byteLength + body.byteLength);
  frame.set(header, 0);
  frame.set(body, header.byteLength);
  return frame;
}

// Fed arbitrary chunks, hands back each complete frame's parsed body. A chunk
// can hold zero, one or many frames, and a frame can span chunks.
export class FrameBuffer {
  private buffer = new Uint8Array(0);

  append(chunk: Uint8Array): void {
    const next = new Uint8Array(this.buffer.byteLength + chunk.byteLength);
    next.set(this.buffer, 0);
    next.set(chunk, this.buffer.byteLength);
    this.buffer = next;
  }

  // The next parsed body, or null when no complete frame is buffered yet. A
  // frame with a bad header or a body that isn't JSON is dropped and the read
  // carries on, so one bad frame neither wedges the stream nor hides the good
  // frames behind it.
  next(): unknown | null {
    for (;;) {
      const frame = this.takeFrame();
      if (frame === "incomplete") return null;
      if (frame === "malformed") continue;
      try {
        return JSON.parse(decoder.decode(frame));
      } catch {
        continue;
      }
    }
  }

  private takeFrame(): Uint8Array | "incomplete" | "malformed" {
    const headerEnd = this.indexOfSeparator();
    if (headerEnd === -1) return "incomplete";
    const length = parseContentLength(
      decoder.decode(this.buffer.subarray(0, headerEnd)),
    );
    const bodyStart = headerEnd + SEPARATOR_BYTES.byteLength;
    if (length === null) {
      this.buffer = this.buffer.subarray(bodyStart);
      return "malformed";
    }
    if (this.buffer.byteLength < bodyStart + length) return "incomplete";
    const body = this.buffer.subarray(bodyStart, bodyStart + length);
    this.buffer = this.buffer.subarray(bodyStart + length);
    return body;
  }

  private indexOfSeparator(): number {
    outer:
    for (
      let i = 0;
      i + SEPARATOR_BYTES.byteLength <= this.buffer.byteLength;
      i++
    ) {
      for (let j = 0; j < SEPARATOR_BYTES.byteLength; j++) {
        if (this.buffer[i + j] !== SEPARATOR_BYTES[j]) continue outer;
      }
      return i;
    }
    return -1;
  }
}

// The Content-Length value from a header block (header name case-insensitive),
// or null when it is missing or not a non-negative integer.
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
