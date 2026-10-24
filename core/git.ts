import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tideProjectGitignore } from "./project-manager.ts";
import { GIT_STATUS_FILE_LIMIT, TIDE_PROJECT_STATE_PREFIX } from "./config.ts";
import type {
  GitProjectStateSummary,
  GitProjectStatus,
  GitRemoteInfo,
  GitStatusFile,
} from "../shared/git.ts";

// The status shapes are the open wire contract (shared/git.ts, L0) — re-exported
// here so every existing `from "./git.ts"` import keeps working and the IDE and
// the backend can never drift apart again.
export type {
  GitProjectStateSummary,
  GitProjectStatus,
  GitRemoteInfo,
  GitStatusFile,
};

export interface GitCommandResult {
  ok: boolean;
  code: number;
  stdout: string;
  stderr: string;
}

export interface GitCommitContext {
  porcelain: string;
  nameStatus: string;
  stat: string;
  fallbackMessage: string;
}

export class GitProjectError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "GitProjectError";
  }
}

const decoder = new TextDecoder();

function runGit(
  projectDir: string,
  args: string[],
  check = true,
): GitCommandResult {
  const output = new Deno.Command("git", {
    args,
    cwd: projectDir,
    stdout: "piped",
    stderr: "piped",
  }).outputSync();
  const result = {
    ok: output.success,
    code: output.code,
    stdout: decoder.decode(output.stdout),
    stderr: decoder.decode(output.stderr),
  };
  if (check && !result.ok) {
    throw new GitProjectError(
      "GIT_COMMAND_FAILED",
      result.stderr.trim() || result.stdout.trim() ||
        `git ${args[0] ?? ""} failed`,
      { args, code: result.code },
    );
  }
  return result;
}

function isGitRepository(projectDir: string): boolean {
  if (!existsSync(join(projectDir, ".git"))) return false;
  const result = runGit(
    projectDir,
    ["rev-parse", "--is-inside-work-tree"],
    false,
  );
  return result.ok && result.stdout.trim() === "true";
}

function parseBranchLine(line: string): {
  branch: string | null;
  ahead: number;
  behind: number;
} {
  const text = line.replace(/^##\s+/, "");
  const branch = text.startsWith("HEAD ") || text === "HEAD"
    ? null
    : text.split(/[.\s]/, 1)[0] || null;
  const ahead = Number(text.match(/ahead (\d+)/)?.[1] ?? 0);
  const behind = Number(text.match(/behind (\d+)/)?.[1] ?? 0);
  return { branch, ahead, behind };
}

function parseStatus(stdout: string): {
  branch: string | null;
  ahead: number;
  behind: number;
  files: GitStatusFile[];
} {
  let branch: string | null = null;
  let ahead = 0;
  let behind = 0;
  const files: GitStatusFile[] = [];

  for (const line of stdout.split(/\r?\n/)) {
    if (!line) continue;
    if (line.startsWith("## ")) {
      const parsed = parseBranchLine(line);
      branch = parsed.branch;
      ahead = parsed.ahead;
      behind = parsed.behind;
      continue;
    }
    const index = line[0] ?? " ";
    const worktree = line[1] ?? " ";
    const path = line.slice(3);
    files.push({
      path,
      index,
      worktree,
      untracked: index === "?" && worktree === "?",
    });
  }

  return { branch, ahead, behind, files };
}

function latestCommit(
  projectDir: string,
): { hash: string; subject: string } | null {
  const hash = runGit(projectDir, ["rev-parse", "--short", "HEAD"], false);
  if (!hash.ok) return null;
  const subject = runGit(projectDir, ["log", "-1", "--pretty=%s"], false);
  return {
    hash: hash.stdout.trim(),
    subject: subject.ok ? subject.stdout.trim() : "",
  };
}

function listRemotes(projectDir: string): GitRemoteInfo[] {
  const result = runGit(projectDir, ["remote", "-v"], false);
  if (!result.ok) return [];
  const remotes = new Map<string, GitRemoteInfo>();
  for (const line of result.stdout.split(/\r?\n/)) {
    const match = line.match(/^(\S+)\s+(\S+)\s+\((fetch|push)\)$/);
    if (!match) continue;
    const name = match[1]!;
    const url = match[2]!;
    const kind = match[3]!;
    const entry = remotes.get(name) ?? { name };
    if (kind === "fetch") entry.fetchUrl = url;
    if (kind === "push") entry.pushUrl = url;
    remotes.set(name, entry);
  }
  return [...remotes.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function gitignoreExists(projectDir: string): boolean {
  return existsSync(join(projectDir, ".gitignore"));
}

function ensureRepository(projectDir: string): void {
  if (!isGitRepository(projectDir)) {
    throw new GitProjectError(
      "MISSING_REPOSITORY",
      "This project directory is not a Git repository.",
    );
  }
}

function commitAction(verb: string): string {
  switch (verb[0]) {
    case "A":
      return "Add";
    case "D":
      return "Remove";
    case "R":
      return "Rename";
    case "C":
      return "Copy";
    default:
      return "Update";
  }
}

function friendlyPath(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  const parts = normalized.split("/").filter(Boolean);
  if (parts.length <= 2) return normalized;
  return `${parts.at(-2)}/${parts.at(-1)}`;
}

function fallbackCommitMessage(nameStatus: string): string {
  const changes = nameStatus.split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [verb = "M", ...paths] = line.split(/\s+/);
      const path = paths.at(-1) ?? "project files";
      return { verb, path };
    });

  if (changes.length === 1) {
    const change = changes[0]!;
    return `${commitAction(change.verb)} ${friendlyPath(change.path)}`;
  }

  const actions = new Set(changes.map((change) => commitAction(change.verb)));
  if (actions.size === 1) {
    const action = [...actions][0]!;
    return `${action} ${changes.length} files`;
  }
  return `Update ${changes.length} files`;
}

export function prepareGitCommitContext(
  projectDir: string,
  flush?: () => void,
): GitCommitContext {
  flush?.();
  ensureRepository(projectDir);
  runGit(projectDir, ["add", "--all"]);
  const staged = runGit(projectDir, ["diff", "--cached", "--quiet"], false);
  if (staged.ok) {
    throw new GitProjectError(
      "NOTHING_TO_COMMIT",
      "There are no staged changes to commit.",
    );
  }

  const porcelain = runGit(
    projectDir,
    ["status", "--porcelain=v1"],
    false,
  ).stdout.trim();
  const nameStatus = runGit(
    projectDir,
    ["diff", "--cached", "--name-status"],
    false,
  ).stdout.trim();
  const stat = runGit(
    projectDir,
    ["diff", "--cached", "--stat"],
    false,
  ).stdout.trim();

  return {
    porcelain,
    nameStatus,
    stat,
    fallbackMessage: fallbackCommitMessage(nameStatus),
  };
}

function countBy(files: GitStatusFile[], untracked: boolean): number {
  return files.filter((file) => file.untracked === untracked).length;
}

function isProjectStatePath(path: string): boolean {
  return path.startsWith(TIDE_PROJECT_STATE_PREFIX);
}

// Split the porcelain file list into the part a caller actually wants to read —
// app source, capped — and a counts-only roll-up of everything under `.opentide/`.
// The agent writes its own ledger, transcripts and session records while the turn
// runs, so an uncapped list is mostly the agent reading back its own bookkeeping.
function splitStatusFiles(files: GitStatusFile[]): {
  files: GitStatusFile[];
  truncated: boolean;
  projectState: GitProjectStateSummary;
} {
  const source: GitStatusFile[] = [];
  const projectState: GitStatusFile[] = [];
  for (const file of files) {
    (isProjectStatePath(file.path) ? projectState : source).push(file);
  }
  return {
    files: source.slice(0, GIT_STATUS_FILE_LIMIT),
    truncated: source.length > GIT_STATUS_FILE_LIMIT,
    projectState: {
      changedCount: countBy(projectState, false),
      untrackedCount: countBy(projectState, true),
    },
  };
}

export function gitStatus(
  projectDir: string,
  flush?: () => void,
): GitProjectStatus {
  flush?.();
  if (!isGitRepository(projectDir)) {
    return {
      initialized: false,
      gitignoreExists: gitignoreExists(projectDir),
      branch: null,
      clean: true,
      dirty: false,
      changedCount: 0,
      untrackedCount: 0,
      files: [],
      projectState: { changedCount: 0, untrackedCount: 0 },
      latestCommit: null,
      remotes: [],
      hasRemote: false,
      canPush: false,
      pushReady: false,
      ahead: 0,
      behind: 0,
    };
  }

  const parsed = parseStatus(
    runGit(projectDir, ["status", "--porcelain=v1", "-b"]).stdout,
  );
  const remotes = listRemotes(projectDir);
  const commit = latestCommit(projectDir);
  const split = splitStatusFiles(parsed.files);
  const canPush = Boolean(commit && remotes.length > 0 && parsed.branch);

  return {
    initialized: true,
    gitignoreExists: gitignoreExists(projectDir),
    branch: parsed.branch,
    // clean/dirty and the counts are computed over ALL files, capped list or not.
    clean: parsed.files.length === 0,
    dirty: parsed.files.length > 0,
    changedCount: countBy(parsed.files, false),
    untrackedCount: countBy(parsed.files, true),
    files: split.files,
    ...(split.truncated ? { truncated: true as const } : {}),
    projectState: split.projectState,
    latestCommit: commit,
    remotes,
    hasRemote: remotes.length > 0,
    canPush,
    pushReady: canPush,
    ahead: parsed.ahead,
    behind: parsed.behind,
  };
}

export function gitInit(projectDir: string): GitProjectStatus {
  if (!isGitRepository(projectDir)) {
    runGit(projectDir, ["init"]);
  }
  return gitStatus(projectDir);
}

export function gitAddTideGitignore(projectDir: string): {
  added: boolean;
  path: string;
  status: GitProjectStatus;
} {
  const path = join(projectDir, ".gitignore");
  let added = false;
  if (!existsSync(path)) {
    writeFileSync(path, tideProjectGitignore());
    added = true;
  }
  return { added, path, status: gitStatus(projectDir) };
}

export function gitSetRemote(
  projectDir: string,
  url: string,
  name = "origin",
): GitProjectStatus {
  ensureRepository(projectDir);
  const remoteName = name.trim() || "origin";
  const remoteUrl = url.trim();
  if (!remoteUrl) {
    throw new GitProjectError("INVALID_REMOTE_URL", "Remote URL is required.");
  }

  const existing = listRemotes(projectDir).some((remote) =>
    remote.name === remoteName
  );
  runGit(
    projectDir,
    existing
      ? ["remote", "set-url", remoteName, remoteUrl]
      : ["remote", "add", remoteName, remoteUrl],
  );
  return gitStatus(projectDir);
}

export function gitCommit(
  projectDir: string,
  message: string,
  flush?: () => void,
): GitProjectStatus {
  const commitMessage = message.trim();
  if (!commitMessage) {
    throw new GitProjectError(
      "INVALID_COMMIT_MESSAGE",
      "Commit message is required.",
    );
  }

  prepareGitCommitContext(projectDir, flush);
  runGit(projectDir, ["commit", "-m", commitMessage]);
  return gitStatus(projectDir);
}

export function gitPush(
  projectDir: string,
  name = "origin",
  branch?: string,
  flush?: () => void,
): GitProjectStatus {
  flush?.();
  ensureRepository(projectDir);
  const remoteName = name.trim() || "origin";
  const remotes = listRemotes(projectDir);
  if (!remotes.some((remote) => remote.name === remoteName)) {
    throw new GitProjectError(
      "MISSING_REMOTE",
      `Remote "${remoteName}" is not configured.`,
    );
  }
  const status = gitStatus(projectDir);
  const branchName = branch?.trim() || status.branch;
  if (!branchName) {
    throw new GitProjectError(
      "MISSING_BRANCH",
      "Current Git branch could not be determined.",
    );
  }
  runGit(projectDir, ["push", "-u", remoteName, branchName]);
  return gitStatus(projectDir);
}
