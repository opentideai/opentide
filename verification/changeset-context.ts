// @layer verification — changeset context assembly.
import type { ChangeRecord } from "../core/changelog.ts";
import type { Changeset } from "./changesets.ts";

export interface ChangesetContext {
  changeset: Changeset;
  changes: ChangeRecord[];
  context: string;
}

// How many entries of an unbounded plan collection the rendering carries before it
// summarizes the tail. Mirrors the existing touched-change cap.
const LIST_LIMIT = 10;

// One capped, self-summarizing block: nothing when the collection is empty, an
// optional heading + up to LIST_LIMIT rendered lines otherwise, and a count of what
// was dropped. Every plan collection is rendered through this so none of them can
// silently truncate.
function section<T>(
  heading: string | null,
  items: T[],
  render: (item: T) => string,
  noun: string,
): string[] {
  if (items.length === 0) return [];
  const lines = [
    ...(heading ? [heading] : []),
    ...items.slice(0, LIST_LIMIT).map(render),
  ];
  if (items.length > LIST_LIMIT) {
    lines.push(`... ${items.length - LIST_LIMIT} more ${noun}(s)`);
  }
  return lines;
}

function statusLabel(status: Changeset["status"]): string {
  switch (status) {
    case "planning":
      return "planning";
    case "approved":
      return "approved";
    case "in_progress":
      return "in progress";
    case "completed":
      return "completed";
    case "abandoned":
      return "abandoned";
    case "rejected":
      return "rejected";
  }
}

function changeSummary(changes: ChangeRecord[]): string {
  if (changes.length === 0) return "none";
  const counts = new Map<string, number>();
  for (const change of changes) {
    const key = `${change.action} ${change.category}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([key, count]) => `${count} ${key}${count === 1 ? "" : "s"}`)
    .join(", ");
}

function touchedSummary(changes: ChangeRecord[], limit = 12): string[] {
  return changes.slice(0, limit).map((change) =>
    `- ${change.action} ${change.category} "${change.key}" (#${change.id})`
  );
}

export function stripChangeSnapshots(change: ChangeRecord): ChangeRecord {
  return {
    ...change,
    beforeSnapshot: null,
    afterSnapshot: null,
  };
}

// The plan detail this rendering is the SOLE carrier of. `get_changeset_context`
// no longer returns the raw `changeset` object (docs/agent-cost-reduction.md §4.3 —
// it was the whole plan, every attestation, every evidence blob, re-sent on every
// call), so anything an agent needs to act on has to survive here: step ids (to call
// update_changeset_step), criterion ids + priority (to know what must be proven),
// planned check ids (to know what to run), and the latest run's verdict. Counts
// stand in for the bulky parts — `check_changeset_readiness` is the tool for
// attestation freshness, and it reports it properly.
function planDetailLines(plan: Changeset["plan"]): string[] {
  const runs = plan.verificationRuns ?? [];
  const latest = runs.at(-1);
  return [
    ...section(
      "acceptance criteria:",
      plan.acceptanceCriteria ?? [],
      (claim) => `- [${claim.priority}] ${claim.id}: ${claim.text}`,
      "criterion",
    ),
    ...section(
      "planned checks:",
      plan.verificationPlan ?? [],
      (check) => `- ${check.id} (${check.kind}): ${check.description}`,
      "check",
    ),
    ...section(
      "formal specs:",
      plan.formalSpecs ?? [],
      (spec) =>
        `- ${spec.id} [${spec.enforcement}] ${spec.technique} on ${spec.scope}: ${spec.statement}`,
      "spec",
    ),
    `verification runs: ${runs.length}${
      latest ? ` (latest: ${latest.status} — ${latest.summary})` : ""
    }`,
    ...section(
      "latest claim results:",
      latest?.claimResults ?? [],
      (result) => `- ${result.claimId}: ${result.status}`,
      "claim result",
    ),
    `attestations: ${(plan.attestations ?? []).length}`,
    ...(plan.changeClass
      ? [
        `change class: ${plan.changeClass.effective}${
          plan.changeClass.escalated
            ? ` (escalated from ${plan.changeClass.declared}: ${plan.changeClass.reason})`
            : ""
        }`,
      ]
      : []),
  ];
}

export function formatChangesetContext(
  changeset: Changeset,
  changes: ChangeRecord[],
): string {
  const done =
    changeset.plan.steps.filter((step) =>
      step.status === "done" || step.status === "skipped"
    ).length;
  const total = changeset.plan.steps.length;
  const lines = [
    `changeset "${changeset.title}"`,
    `id: ${changeset.id}`,
    `status: ${statusLabel(changeset.status)}`,
    `created: ${changeset.createdAt}`,
    `updated: ${changeset.updatedAt}`,
  ];

  if (changeset.completedAt) lines.push(`completed: ${changeset.completedAt}`);
  if (changeset.description) {
    lines.push(`description: ${changeset.description}`);
  }
  if (changeset.plan.summary) lines.push(`summary: ${changeset.plan.summary}`);
  lines.push(`steps: ${done}/${total} complete`);
  lines.push(
    ...section(
      null,
      changeset.plan.steps,
      (step) => `- [${step.status}] ${step.id}: ${step.description}`,
      "step",
    ),
  );

  lines.push(...planDetailLines(changeset.plan));

  lines.push(
    `changes: ${changes.length} changelog entr${
      changes.length === 1 ? "y" : "ies"
    }`,
  );
  lines.push(`change summary: ${changeSummary(changes)}`);
  const touched = touchedSummary(changes);
  if (touched.length > 0) {
    lines.push("touched:");
    lines.push(...touched);
    if (changes.length > touched.length) {
      lines.push(`... ${changes.length - touched.length} more change(s)`);
    }
  }
  // Deliberately NOT "call get_changeset_context for more" — this rendering IS
  // that tool's payload now, so the pointer has to name a tool that adds something.
  lines.push(
    "Use check_changeset_readiness for the gate verdict and attestation freshness, " +
      "search_changes for a change's before/after snapshots.",
  );

  return lines.join("\n");
}
