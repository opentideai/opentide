import { assertEquals } from "@std/assert";
import { encodeFrame, FrameBuffer } from "./content-length-framing.ts";

const encoder = new TextEncoder();

function drain(buffer: FrameBuffer): unknown[] {
  const out: unknown[] = [];
  for (let v = buffer.next(); v !== null; v = buffer.next()) out.push(v);
  return out;
}

Deno.test("a frame split across chunks comes out whole, multibyte included", () => {
  const frame = encodeFrame({ text: "ünïcødé ✓" });
  const buffer = new FrameBuffer();
  buffer.append(frame.subarray(0, 7));
  assertEquals(buffer.next(), null);
  buffer.append(frame.subarray(7));
  assertEquals(drain(buffer), [{ text: "ünïcødé ✓" }]);
});

Deno.test("one chunk with several frames yields them all, in order", () => {
  const buffer = new FrameBuffer();
  buffer.append(new Uint8Array([...encodeFrame(1), ...encodeFrame(2)]));
  assertEquals(drain(buffer), [1, 2]);
});

Deno.test("a bad frame is skipped without hiding the good one behind it", () => {
  const buffer = new FrameBuffer();
  buffer.append(
    new Uint8Array([
      ...encoder.encode("Content-Length: nope\r\n\r\n"),
      ...encoder.encode("Content-Length: 3\r\n\r\n{x}"),
      ...encodeFrame({ ok: true }),
    ]),
  );
  assertEquals(drain(buffer), [{ ok: true }]);
});
