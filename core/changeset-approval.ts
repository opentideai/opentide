// Starting a changeset that waits for approval. One path for the IDE's Approve
// button (POST /api/changesets/:id/approve), the approve_changeset tool and the
// in-process chat loop, so the three can't drift.
import { getKernelSettings } from "./config.ts";
import type { Kernel } from "./registries.ts";
import type { Changeset, Result } from "./types.ts";
import { errorMessage } from "./util.ts";

export interface ApproveChangesetOptions {
  // The light lane approves without a person: the class has to be light and
  // not escalated, and proportional verification not turned off. The changeset
  // is stamped auto-approved, so it is never mistaken for a human approval.
  lightLane?: boolean;
}

function refused(code: string, message: string): Result<Changeset> {
  return { ok: false, error: { code, message } };
}

function lightLaneRefusal(changeset: Changeset): string | null {
  if (changeset.status !== "planning") {
    return `Changeset "${changeset.id}" is ${changeset.status}; the light lane only starts a planning changeset.`;
  }
  const cls = changeset.plan.changeClass;
  if (cls?.effective !== "light" || cls.escalated) {
    return `Changeset "${changeset.id}" isn't on the light lane, so a person has to approve it.`;
  }
  if (getKernelSettings().proportionalVerification === "never") {
    return "Proportional verification is off, so every changeset needs a person's approval.";
  }
  return null;
}

// planning → approved → in_progress. An approved changeset is started; an
// in_progress one comes back as it is.
export async function approveChangeset(
  kernel: Kernel,
  id: string,
  options: ApproveChangesetOptions = {},
): Promise<Result<Changeset>> {
  const existing = await kernel.changesets.get(id);
  if (!existing) {
    return refused("CHANGESET_NOT_FOUND", `Changeset "${id}" not found.`);
  }
  if (options.lightLane) {
    const refusal = lightLaneRefusal(existing);
    if (refusal) return refused("NOT_LIGHT_LANE", refusal);
  }
  try {
    switch (existing.status) {
      case "in_progress":
        return { ok: true, data: existing };
      case "planning":
        await kernel.changesets.approve(id);
        break;
      case "approved":
        break;
      default:
        return refused(
          "INVALID_STATUS",
          `Cannot approve changeset "${id}" in status "${existing.status}".`,
        );
    }
    const started = await kernel.changesets.startWork(id);
    const cls = started.plan.changeClass;
    if (!options.lightLane || !cls) return { ok: true, data: started };
    return {
      ok: true,
      data: await kernel.changesets.recordChangeClass(id, {
        ...cls,
        autoApproved: true,
      }),
    };
  } catch (err) {
    return refused("CHANGESET_ERROR", errorMessage(err));
  }
}
