// @layer shared — L0, the OpenTide *open* wire contract for Git project status:
// the shape `git_status` returns to the agent and the shape the control API serves
// to the IDE's Git panel. Type-only; imports NOTHING. This lived duplicated in
// core/git.ts and ide/src/lib/git-panel.ts with no shared source — a mismatch that
// neither `deno check` nor `npm run check` could see. Consumed by the Deno backend
// (re-exported from core/git.ts) and the IDE (`$shared` alias, or a relative
// ../shared/git.ts import from Deno-tested lib modules).

export interface GitRemoteInfo {
  name: string;
  fetchUrl?: string;
  pushUrl?: string;
}

export interface GitStatusFile {
  path: string;
  index: string;
  worktree: string;
  untracked: boolean;
}

// Counts-only roll-up of the changes under `.opentide/` — the project-state and
// provenance tree (ledger, changelog, changesets, sessions, transcripts). These
// are *tracked* files, not junk and not ignored: they are the evidence chain
// behind every attestation. They are summarised rather than listed because the
// agent writes them while it runs, so a turn that asks "what did I change?" would
// otherwise be handed 500+ paths of its own bookkeeping.
export interface GitProjectStateSummary {
  changedCount: number;
  untrackedCount: number;
}

export interface GitProjectStatus {
  initialized: boolean;
  gitignoreExists: boolean;
  branch: string | null;
  clean: boolean;
  dirty: boolean;
  // Totals across BOTH groups — app source and `.opentide/` project state — so a
  // caller that only wants a number never has to learn about the split.
  changedCount: number;
  untrackedCount: number;
  // App-source paths only, capped. Everything under `.opentide/` is rolled up into
  // `projectState` instead. Never assume `files.length` is the number of changes:
  // use `changedCount` + `untrackedCount`.
  files: GitStatusFile[];
  // Present (and always `true`) only when `files` was capped. Absent otherwise.
  truncated?: boolean;
  projectState: GitProjectStateSummary;
  latestCommit: { hash: string; subject: string } | null;
  remotes: GitRemoteInfo[];
  hasRemote: boolean;
  canPush: boolean;
  pushReady: boolean;
  ahead: number;
  behind: number;
}
