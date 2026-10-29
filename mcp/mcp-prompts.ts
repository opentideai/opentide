// @layer mcp — MCP prompts: workflows a human starts by name. In Claude Code they
// appear as /opentide:<name> (or /mcp__opentide__<name>), with arguments typed
// after the command.
//
// These are not how an agent learns the rules — a prompt runs only when someone
// invokes it. The rules travel in the server instructions (core/agent-guide.ts);
// the prompts reuse the same sections, so the two cannot drift apart.
import { GUIDE_FAILURE, GUIDE_WORK_LOOP } from "../core/agent-guide.ts";
import type { CompositionContext } from "../core/composition.ts";

export interface McpPromptArgument {
  name: string;
  description: string;
  required?: boolean;
}

export interface McpPromptDefinition {
  name: string;
  description: string;
  arguments?: McpPromptArgument[];
  render: (
    args: Record<string, string | undefined>,
    composition: CompositionContext,
  ) => string;
}

export interface McpPromptMessage {
  role: "user";
  content: { type: "text"; text: string };
}

const START = `\
Orient in this opentide project before changing anything.

1. Call project_status.
2. Report its verdict and every problem it lists, in plain words.
3. If the verdict is "stop", stop there and say what has to be fixed first.
4. If an active changeset is reported, say what it is and how far along.
5. Otherwise run run_tests once for a baseline and report any failures.

Change nothing in this step.`;

function change(goal: string | undefined): string {
  return `\
Make this change to the app: ${goal?.trim() || "(ask the user what to change)"}

Before the first edit, say in a few lines what you will change and how.

Then work through the changeset loop:

${GUIDE_WORK_LOOP}

The plan shape create_changeset expects, exactly:
{
  "title": "...",
  "change_class": "standard",
  "plan": {
    "summary": "...",
    "steps": ["one string per step"],
    "acceptanceCriteria": [
      {"id": "claim_x", "text": "observable behavior", "priority": "should"}
    ],
    "verificationPlan": [
      {"id": "check_x", "claimIds": ["claim_x"], "kind": "e2e", "description": "how it is checked"}
    ]
  }
}
Use change_class "light" only for a copy or style tweak: it refuses routes,
schemas, SQL, secrets, env vars, packages and snapshots.`;
}

function land(changesetId: string | undefined): string {
  const target = changesetId?.trim()
    ? `changeset ${changesetId.trim()}`
    : "the active changeset (project_status names it)";
  return `\
Finish ${target}.

1. Every step done or skipped (update_changeset_step).
2. run_tests. Fix failures; do not record a failing run as passed.
3. record_verification_run({changeset_id, status, summary, evidence, claimResults,
   residualRisks}). evidence items need summary and status; claimResults items use
   the criterion's own id as claimId. Statuses are passed, failed, partial or manual.
4. For each "must" criterion without a fresh refute review: request_review
   {kind: "refute"}, run the packet in a subagent, then submit_review.
5. check_changeset_readiness. Fix every error it lists.
6. complete_changeset. If stateFlushed is false, say so first and loudly: the work
   exists only in memory until it is flushed.`;
}

const RECOVER = `\
The project database will not open (PgliteCorruptError or similar). Walk the
user through recovery; do not improvise storage repairs.

${GUIDE_FAILURE}

The procedure, for the user to run with this server stopped:
1. Confirm nothing owns the database:
   ps -axo pid,ppid,command | grep -E 'mcp-main.ts|opentide' | grep -v grep
2. Archive the data directory before touching it:
   tar czf /tmp/<project>-data-<timestamp>.tgz data/
3. Try the bounded repair (attemptRepairDatabase). Expect it to fail; it usually does.
4. Restore from the newest backup in ~/.config/opentide/backups/<sha256 of the
   project path>, keeping the newer .opentide/state rather than the backup's.
5. Start the server again and confirm it logs that the project loaded and the
   MCP server is ready.
6. Call project_status and run_tests to confirm the restore.

Stop the server cleanly when finished: a clean shutdown flushes state, closes the
database and writes a fresh backup. Killing it is what corrupts the database.`;

export const MCP_PROMPTS: readonly McpPromptDefinition[] = [
  {
    name: "start",
    description:
      "Orient in the project: run project_status, report the verdict, take a test baseline. Changes nothing.",
    render: () => START,
  },
  {
    name: "change",
    description:
      "Make a change through a changeset, with the exact plan shape create_changeset expects.",
    arguments: [{
      name: "goal",
      description: "What to change, in plain words.",
      required: true,
    }],
    render: (args) => change(args.goal),
  },
  {
    name: "land",
    description:
      "Verify and complete a changeset: tests, verification run, readiness, complete, flush.",
    arguments: [{
      name: "changeset_id",
      description: "The changeset to finish. Defaults to the active one.",
    }],
    render: (args) => land(args.changeset_id),
  },
  {
    name: "recover",
    description:
      "The database will not open (PgliteCorruptError): the recovery procedure, step by step.",
    render: () => RECOVER,
  },
];

export function listMcpPrompts(): Array<Omit<McpPromptDefinition, "render">> {
  return MCP_PROMPTS.map(({ render: _render, ...listing }) => listing);
}

// The messages for one prompt, or null for an unknown name. Missing required
// arguments render with a placeholder rather than failing: a human typed the
// command, and an agent asking "what should I change?" is the right outcome.
export function getMcpPrompt(
  name: string,
  args: Record<string, string | undefined>,
  composition: CompositionContext,
): { description: string; messages: McpPromptMessage[] } | null {
  const prompt = MCP_PROMPTS.find((p) => p.name === name);
  if (!prompt) return null;
  return {
    description: prompt.description,
    messages: [{
      role: "user",
      content: { type: "text", text: prompt.render(args, composition) },
    }],
  };
}
