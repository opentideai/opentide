// @layer mcp — test-support: the guidance-vs-surface consistency check, shared by
// the open guidance test (mcp/mcp-guidance_test.ts) and the Tide one
// (tide/mcp-guidance_test.ts), so each assembly is held to the same rule.
import type { CompositionContext } from "../core/composition.ts";
import { generalGuide } from "../core/agent-guide.ts";
import { projectedMcpTools } from "./mcp-projection.ts";
import { MCP_PROMPTS } from "./mcp-prompts.ts";

// Snake_case words in the guidance that are arguments or placeholders, not tools.
const NOT_TOOLS = new Set([
  "change_class",
  "changeset_id",
  "step_id",
  "claim_x",
  "check_x",
]);

// Every snake_case word the instructions and prompts render under `composition`
// that is neither an advertised tool nor a known argument — so renaming a verb,
// or assembling without one, cannot leave the guidance pointing at a tool the
// server does not offer. Empty when the guidance is consistent.
export function unadvertisedToolMentions(
  composition: CompositionContext,
): string[] {
  const advertised = new Set(
    projectedMcpTools(composition).map((t) => t.name),
  );
  const texts = [
    generalGuide(),
    ...MCP_PROMPTS.map((p) =>
      p.render({ goal: "g", changeset_id: "c" }, composition)
    ),
  ];
  const unknown = new Set<string>();
  for (const body of texts) {
    for (const [word] of body.matchAll(/\b[a-z]+(?:_[a-z]+)+\b/g)) {
      if (!advertised.has(word) && !NOT_TOOLS.has(word)) unknown.add(word);
    }
  }
  return [...unknown];
}
