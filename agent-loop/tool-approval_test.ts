import { assertEquals } from "@std/assert";
import type { ChatEvent } from "../core/chat-contract.ts";
import { ToolApprovals } from "./tool-approval.ts";

const CALL = {
  toolName: "mcp__fx__search",
  toolInput: {},
  mcpServer: "fx",
  mcpTool: "search",
};

Deno.test("ToolApprovals — with nobody to ask, the answer is deny", async () => {
  const approvals = new ToolApprovals();
  assertEquals(await approvals.ask(CALL), "deny");
  assertEquals(approvals.pending(), null);
});

Deno.test("ToolApprovals — the answer settles the wait once", async () => {
  const approvals = new ToolApprovals();
  const events: ChatEvent[] = [];
  const decision = approvals.ask(CALL, (e) => events.push(e));
  const id = approvals.pending()!.approvalId;

  assertEquals(approvals.answer("other", "allow"), false);
  assertEquals(approvals.answer(id, "allow"), true);
  assertEquals(await decision, "allow");
  assertEquals(approvals.answer(id, "deny"), false);
  assertEquals(approvals.pending(), null);
  assertEquals(events.map((e) => e.type), [
    "tool_approval_requested",
    "tool_approval_resolved",
  ]);
});

Deno.test("ToolApprovals — denyPending settles a waiting call as deny", async () => {
  const approvals = new ToolApprovals();
  const decision = approvals.ask(CALL, () => {});
  approvals.denyPending();
  assertEquals(await decision, "deny");
});
