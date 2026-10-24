// @layer agent-loop — open prompt-composition mechanism. Given ANY base system prompt
// and the runtime PromptOpts (registered secrets, enabled skills, custom instructions),
// it appends the standard project sections. This is pure formatting, so both
// the closed TunedChatIntelligence (agent/brain.ts, base = the 690-line SYSTEM_PROMPT)
// and the open DefaultChatIntelligence (default-brain.ts, base = a generic prompt) share
// it. The intelligence is the base string each brain supplies; this just frames it.
import type { PromptOpts } from "../core/chat-intelligence.ts";

type ResidentDocument = NonNullable<PromptOpts["residentDocuments"]>[number];

const RESIDENT_DOCUMENTS_HEADING = "## Resident documents";

// Format the Tier-2 working set (docs/document-store-plan.md §5) as a prompt section,
// mirroring the ## Active Skills framing. Returns "" when there are no resident docs.
// The content is fed as SOURCE (not rendered — §12), one fenced block per document.
// Shared with agent-loop/chat.ts so the system-prompt path (composePrompt) and the
// per-turn user-message path (withLocalConversationContext) format the set identically.
export function formatResidentDocuments(docs?: ResidentDocument[]): string {
  if (!docs?.length) return "";
  let section = `${RESIDENT_DOCUMENTS_HEADING}\n\n` +
    "You pinned these documents into your working set; they stay in front of you " +
    "until you release them with `document_pin`. Treat them as source material.\n\n";
  for (const doc of docs) {
    section += `### ${doc.name}\n\n` +
      `<document name="${doc.name}" version="${doc.versionHash}">\n` +
      `${doc.content}\n</document>\n\n`;
  }
  return section.trimEnd();
}

// Append the ## Defined Secrets / ## Active Skills / ## Custom Instructions sections to
// `base`, in the order the agent has always seen them.
export function composePrompt(base: string, opts?: PromptOpts): string {
  let prompt = base;

  if (opts?.secrets?.length) {
    prompt +=
      "\n\n## Defined Secrets\n\nThe following secrets are already registered in this project:\n";
    for (const s of opts.secrets) {
      prompt += `- \`${s.key}\` — ${s.status}${
        s.description ? ` (${s.description})` : ""
      }\n`;
    }
    prompt +=
      "\nAccess them as `env.<KEY>` in handlers and functions. Do not re-define secrets that already exist.";
  }

  if (opts?.skills?.length) {
    prompt += "\n\n## Active Skills\n\n";
    for (const skill of opts.skills) {
      prompt += `### ${skill.name}\n\n${skill.prompt}\n\n`;
    }
  }

  if (opts?.customInstructions) {
    prompt += "\n\n## Custom Instructions\n\n" + opts.customInstructions;
  }

  const resident = formatResidentDocuments(opts?.residentDocuments);
  if (resident) {
    prompt += "\n\n" + resident;
  }

  return prompt;
}
