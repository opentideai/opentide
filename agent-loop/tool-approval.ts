// @layer agent-loop — asking the user before a turn calls an external MCP tool.
//
// A turn dispatches its tool calls one at a time, so at most one call waits.
// It waits until the user answers, with no timeout: the same as a desktop
// client's permission prompt. Cancelling the turn answers deny.
import type {
  ChatEventHandler,
  ToolApprovalDecision,
  ToolApprovalRequest,
} from "../core/chat-contract.ts";

interface Waiting {
  request: ToolApprovalRequest;
  settle(decision: ToolApprovalDecision): void;
}

export class ToolApprovals {
  private waiting: Waiting | null = null;

  // Ask the user through onEvent. With no handler there's nobody to ask, and
  // the answer is deny.
  ask(
    call: Omit<ToolApprovalRequest, "approvalId">,
    onEvent?: ChatEventHandler,
  ): Promise<ToolApprovalDecision> {
    if (!onEvent) return Promise.resolve("deny");
    this.denyPending();
    const request = { approvalId: crypto.randomUUID(), ...call };
    const decision = new Promise<ToolApprovalDecision>((resolve) => {
      this.waiting = {
        request,
        settle: (answer) => {
          this.waiting = null;
          onEvent({
            type: "tool_approval_resolved",
            approvalId: request.approvalId,
            decision: answer,
          });
          resolve(answer);
        },
      };
    });
    onEvent({ type: "tool_approval_requested", ...request });
    return decision;
  }

  answer(approvalId: string, decision: ToolApprovalDecision): boolean {
    if (this.waiting?.request.approvalId !== approvalId) return false;
    this.waiting.settle(decision);
    return true;
  }

  denyPending(): void {
    this.waiting?.settle("deny");
  }

  pending(): ToolApprovalRequest | null {
    return this.waiting?.request ?? null;
  }
}
