import { assertEquals } from "@std/assert";
import {
  createMergeableNumericId,
  createTimestampedId,
  createTimestampedShortId,
} from "./ids.ts";

Deno.test("timestamped ids include prefix, time, and random suffix", () => {
  const id = createTimestampedId("turn");
  assertEquals(/^turn_[0-9a-z]+_[0-9a-f-]{36}$/.test(id), true);
});

Deno.test("short timestamped ids include prefix, time, and random suffix", () => {
  const id = createTimestampedShortId("backup");
  assertEquals(/^backup_[0-9a-z]+_[0-9a-f]{8}$/.test(id), true);
});

Deno.test("mergeable numeric ids are timestamp based and advance past existing ids", () => {
  const id = createMergeableNumericId();
  assertEquals(id > Date.now() * 1000 - 1_000_000, true);
  assertEquals(
    createMergeableNumericId([9_000_000_000_000_000]),
    9_000_000_000_000_001,
  );
});
