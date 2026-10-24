import { assertEquals, assertStringIncludes } from "@std/assert";
import {
  buildWorkItemPayload,
  decodeWorkItemMessage,
  encodeWorkItemMessage,
  sanitizeWorkItemText,
  stripWorkItemMarker,
} from "./work-items.ts";
import type { ChangeRecord } from "./changelog.ts";

const CHANGE: ChangeRecord = {
  id: 12,
  category: "function",
  key: "calculateTotal",
  action: "update",
  beforeSnapshot: {
    name: "calculateTotal",
    source: "function calculateTotal() { return 1; }",
  },
  afterSnapshot: {
    name: "calculateTotal",
    source: "function calculateTotal() { return 2; }",
  },
  context: { turnId: "turn_1", toolCallId: "tool_1" },
  createdAt: "2026-06-15T10:00:00.000Z",
  undoable: true,
  turnId: "turn_1",
  changesetId: "cs_1",
  rationale: null,
  implementation: null,
  workMessageId: null,
};

Deno.test("work item payload uses supplied rationale and implementation", () => {
  const payload = buildWorkItemPayload("define_function", {
    rationale: "Totals now include discounts.",
    implementation: "Kept the existing function boundary.",
  }, CHANGE);

  assertEquals(payload.title, 'Updated function "calculateTotal"');
  assertEquals(payload.rationale.why, "Totals now include discounts.");
  assertEquals(
    payload.rationale.implementation,
    "Kept the existing function boundary.",
  );
});

Deno.test("work item payload falls back when rationale is omitted", () => {
  const payload = buildWorkItemPayload("define_function", {}, CHANGE);

  assertStringIncludes(
    payload.rationale.why,
    'Updated function "calculateTotal"',
  );
  assertStringIncludes(payload.rationale.implementation, "define_function");
});

Deno.test("work item messages round trip and strip marker", () => {
  const payload = buildWorkItemPayload("define_function", {}, CHANGE);
  const encoded = encodeWorkItemMessage(payload);

  assertEquals(decodeWorkItemMessage(encoded)?.changeId, CHANGE.id);
  assertStringIncludes(stripWorkItemMarker(encoded), "Code change:");
  assertEquals(
    stripWorkItemMarker(encoded).includes("<genie-work-item>"),
    false,
  );
});

Deno.test("work item metadata strips leaked tool parameter markup", () => {
  const leaked =
    'Extracts the real script tag.</implementation><parameter name="verification">{"claimIds":["claim_no_regression"]}';

  assertEquals(
    sanitizeWorkItemText(leaked),
    "Extracts the real script tag.",
  );

  const payload = buildWorkItemPayload("define_test", {
    rationale: "Same defect as testPagesRender.",
    implementation: leaked,
  }, CHANGE);

  assertEquals(
    payload.rationale.implementation,
    "Extracts the real script tag.",
  );
});
