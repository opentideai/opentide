// @layer core — what an external agent is told about driving a project.
//
// The MCP face sends this as the server `instructions` (mcp/mcp-server.ts), which
// clients such as Claude Code put in the system prompt on connect: the one piece
// of guidance an agent cannot skip. Its prompts (mcp/mcp-prompts.ts) are built
// from the same sections so the two cannot disagree.
//
// It lives in core, not next to agent/system-prompt.ts, because the mcp layer may
// only import core — and because the IDE prompt is the wrong text anyway: it
// tells the agent to stop and wait for a human approval that this face does not
// have.
//
// Keep it short. Every line is paid for on every turn of every session, and the
// rules here are the ones that cost a session when broken — not a manual.
// Project-specific rules go in the project's own custom instructions
// (set_system_prompt), which are appended under "This project".
import type { Kernel } from "./registries.ts";
import { RESERVED_NAMES_RULE } from "./reserved-names.ts";
import type { CompositionContext } from "./composition.ts";
import { canBillUnder } from "./tool-capabilities.ts";

export const CUSTOM_INSTRUCTIONS_CONFIG = "_genie_custom_instructions";

export const GUIDE_OWNERSHIP = `\
opentide serves one app. Its code, routes, schemas, templates and tests live in \
the project database this server owns, not in source files.

- Change the app only through these tools. Never read or edit .opentide/state/** \
(a flushed copy, not source) and never hand-edit AGENT.md (generate_project_docs \
rewrites it).
- This process owns the database. Never start another opentide process or the IDE \
against the same project while it runs: a second owner corrupts it.
- Start with project_status. If its verdict is "stop", report the problems and \
change nothing.`;

export const GUIDE_WORK_LOOP = `\
1. create_changeset({title, plan: {summary, steps, acceptanceCriteria, \
verificationPlan}}). Here it is approved and started automatically. If a call is \
later refused as outside the plan, amend_changeset_plan, then retry.
2. Make the change, marking each step with update_changeset_step status "done".
3. run_tests, then record_verification_run with evidence and claimResults keyed \
by your own criterion ids.
4. check_changeset_readiness, then complete_changeset. If it returns \
stateFlushed: false, tell the user: the work exists only in memory. Work done \
outside a changeset ends with flush_project_state.
${RESERVED_NAMES_RULE}`;

export const GUIDE_COST = `\
- refute_claims, run_audit and index_codebase with classification "assist" bill \
the user's model API key. Call them only when asked.
- Give acceptance criteria priority "should". A "must" criterion makes \
complete_changeset run a billed refutation agent.`;

// The open assembly carries no audit provider and no agent, so nothing reachable
// over MCP spends the user's key and the cost section is left out entirely.
export function costGuide(composition: CompositionContext): string | null {
  return canBillUnder(composition, "refute_claims") ? GUIDE_COST : null;
}

export const GUIDE_FAILURE = `\
- PgliteCorruptError, or a database that will not open: stop and tell the user. \
Do not repair storage by hand.
- INVALID_ARGUMENTS names the argument you meant. Fix the call and retry once.`;

export function generalGuide(composition: CompositionContext): string {
  const cost = costGuide(composition);
  return [
    GUIDE_OWNERSHIP,
    "Changing the app",
    GUIDE_WORK_LOOP,
    ...(cost ? ["Cost", cost] : []),
    "When things break",
    GUIDE_FAILURE,
  ].join("\n\n");
}

// The project's own rules, set through set_system_prompt. Empty when unset.
export function projectGuide(kernel: Kernel): string {
  const custom = kernel.configs.get(CUSTOM_INSTRUCTIONS_CONFIG);
  return typeof custom === "string" ? custom.trim() : "";
}

// Claude Code cuts a server's instructions at 2,048 characters, silently
// (CLAUDE_CODE_MAX_MCP_DESCRIPTION_LENGTH raises it). Past that, the cut falls in
// the project's rules — the part that differs per project and that nobody would
// notice missing — so when they do not fit, the instructions point at
// project_status, which always returns them whole.
export const INSTRUCTIONS_MAX_CHARS = 2048;

// The full instructions for one connection: the general rules, then the
// project's. Read once at connect; a set_system_prompt mid-session reaches the
// next connection.
export function buildAgentInstructions(kernel: Kernel): string {
  const general = generalGuide(kernel.composition);
  const project = projectGuide(kernel);
  if (!project) return general;
  const inline = `${general}\n\nThis project\n\n${project}`;
  if (inline.length <= INSTRUCTIONS_MAX_CHARS) return inline;
  return `${general}\n\nThis project\n\nIt has its own rules, too long to ` +
    "repeat here. project_status returns them in `projectRules`: read them " +
    "before changing anything.";
}
