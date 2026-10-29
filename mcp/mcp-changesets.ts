// @layer mcp — approve_changeset: a client starts a plan its user approved.
//
// A changeset created or amended with await_approval waits in planning, as the
// IDE chat's do. The user approves it in the IDE (REST) or tells the client,
// which calls this. It is MCP-only on purpose: the integrated agent's model
// must never approve its own plan, so the verb is not in CUSTOM_TOOLS and
// dispatchTool doesn't know it. Serve doesn't check who approved; it never
// has.
import { approveChangeset } from "../core/changeset-approval.ts";
import type { CompositionContext } from "../core/composition.ts";
import type { Kernel } from "../core/registries.ts";
import { hasVerificationTools } from "../core/tool-capabilities.ts";
import type { CustomToolDef } from "../core/tools/definitions.ts";
import type { ToolResult } from "../core/tools/dispatch.ts";

export const APPROVE_CHANGESET = "approve_changeset";

export const APPROVE_CHANGESET_TOOL: CustomToolDef = {
  type: "custom",
  name: APPROVE_CHANGESET,
  description:
    "Start a changeset waiting in 'planning' (created or amended with " +
    "await_approval). Call it only when the user has approved the plan, or " +
    "with light_lane for a light-lane changeset that needs no person. Moves " +
    "it to in_progress and returns it.",
  input_schema: {
    type: "object",
    properties: {
      changeset_id: {
        type: "string",
        description: "ID of the changeset to start.",
      },
      light_lane: {
        type: "boolean",
        description:
          "Start a light-lane changeset without a person's approval. " +
          "Refused unless its class is light and not escalated. The " +
          "changeset is stamped auto-approved.",
      },
    },
    required: ["changeset_id"],
  },
};

// The changeset verbs this face adds, for an assembly with changesets.
export function changesetFaceTools(
  composition: CompositionContext,
): CustomToolDef[] {
  return hasVerificationTools(composition) ? [APPROVE_CHANGESET_TOOL] : [];
}

export async function dispatchApproveChangeset(
  kernel: Kernel,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const approved = await approveChangeset(
    kernel,
    args.changeset_id as string,
    { lightLane: args.light_lane === true },
  );
  return approved.ok ? { ok: true, data: approved.data } : approved;
}
