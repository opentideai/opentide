import { prepareGitCommitContext } from "./git.ts";

export interface ResolvedGitCommitMessage {
  message: string;
  generated: boolean;
  generatedBy: "user" | "fallback";
}

// The caller's message, or one built from the staged files. Serve calls no
// model; the agent writes a better subject and passes it in.
export function resolveGitCommitMessage(
  projectDir: string,
  message?: string,
  flush?: () => void,
): ResolvedGitCommitMessage {
  const explicit = message?.trim() ?? "";
  if (explicit) {
    return { message: explicit, generated: false, generatedBy: "user" };
  }
  const context = prepareGitCommitContext(projectDir, flush);
  return {
    message: context.fallbackMessage,
    generated: true,
    generatedBy: "fallback",
  };
}
