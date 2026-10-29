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

export const CUSTOM_INSTRUCTIONS_CONFIG = "_genie_custom_instructions";

export const GUIDE_OWNERSHIP = `\
opentide serves one app. Its code, routes, schemas, templates and tests live in \
the database this server owns, not in source files.

- Change the app only through these tools. Never read or edit .opentide/state/** \
(a flushed copy, not source) and never hand-edit AGENT.md (generate_project_docs \
rewrites it).
- This process owns the database. Never start another opentide process or the IDE \
against the same project while it runs: a second owner corrupts it.
- Start with project_status. If its verdict is "stop", report the problems and \
change nothing.
- Read past sessions with get_session_context. After landing work, \
set_session_summary: what changed and why.`;

export const GUIDE_WORK_LOOP = `\
1. create_changeset({title, plan: {summary, steps, acceptanceCriteria, \
verificationPlan}}). It is approved and started at once. If a call is \
later refused as outside the plan, amend_changeset_plan, then retry.
2. Make the change; mark each step "done" with update_changeset_step.
3. run_tests, then record_verification_run with evidence and claimResults keyed \
by your own criterion ids. A "must" criterion wants a refute review: \
request_review, run the packet in a subagent, then submit_review.
4. check_changeset_readiness, then complete_changeset. If it returns \
stateFlushed: false, tell the user: the work exists only in memory. Work done \
outside a changeset ends with flush_project_state.
${RESERVED_NAMES_RULE}`;

export const GUIDE_FAILURE = `\
- PgliteCorruptError, or a database that will not open: stop and tell the user. \
Do not repair storage by hand.
- INVALID_ARGUMENTS names the argument you meant. Fix the call and retry once.`;

export function generalGuide(): string {
  return [
    GUIDE_OWNERSHIP,
    "Changing the app",
    GUIDE_WORK_LOOP,
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
  const general = generalGuide();
  const project = projectGuide(kernel);
  if (!project) return general;
  const inline = `${general}\n\nThis project\n\n${project}`;
  if (inline.length <= INSTRUCTIONS_MAX_CHARS) return inline;
  return `${general}\n\nThis project\n\nIts rules are too long for here. ` +
    "Read `projectRules` from project_status before changing anything.";
}
