// Landing a changeset commits it (docs/tide-client-plan.md, decision 3).
//
// The commit holds only what OpenTide manages: the app's state, its history,
// assets, fixtures, the manifest, and the project files this changeset wrote.
// Never the user's other dirty files, and never what they have staged.
// Machine-local history is excluded by pathspec as well as by .gitignore, so a
// project whose .gitignore predates an entry still keeps it out.
import { join, relative } from "node:path";
import {
  COMMIT_ON_COMPLETE_DEFAULT,
  PRIVATE_HISTORY_DIR,
  PROJECT_GITIGNORE,
} from "./config.ts";
import { gitCommitPaths, insideWorkTree } from "./git.ts";
import { writeFileIfMissing } from "./history-store.ts";
import { hasProjectManifest } from "./project-layout.ts";
import {
  getProjectPaths,
  readProjectCommitOnComplete,
} from "./project-manager.ts";
import type { Kernel } from "./registries.ts";
import type { Changeset } from "./types.ts";
import { errorMessage } from "./util.ts";

export type LandingCommit =
  | { committed: true; sha: string }
  | { committed: false; reason: "off" | "no_project" | "nothing_to_commit" }
  | { committed: false; reason: "failed"; message: string };

const HISTORY_IGNORE_PREFIX = ".opentide/history/";
const GITIGNORE_FILE = ".gitignore";

// The machine-local entries PROJECT_GITIGNORE lists under history/, plus the
// private sessions, relative to the history dir.
function machineLocalHistory(): string[] {
  const listed = PROJECT_GITIGNORE.split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith(HISTORY_IGNORE_PREFIX))
    .map((line) => line.slice(HISTORY_IGNORE_PREFIX.length));
  return [...new Set([...listed, PRIVATE_HISTORY_DIR])]
    .map((entry) => entry.replace(/\/$/, ""));
}

export function landingPathspecs(
  projectDir: string,
  changedFiles: readonly string[],
): string[] {
  const paths = getProjectPaths(projectDir);
  const rel = (path: string) => relative(projectDir, path);
  const history = rel(paths.historyDir);
  return [
    rel(paths.stateDir),
    history,
    rel(paths.manifest),
    rel(paths.assets),
    "fixtures",
    ...changedFiles,
    ...machineLocalHistory().map((entry) => `:(exclude)${history}/${entry}`),
  ];
}

// Project files the changeset wrote through OpenTide, by path.
async function changedProjectFiles(
  kernel: Kernel,
  changesetId: string,
): Promise<string[]> {
  const records = await kernel.changelog.listByChangeset(changesetId);
  return [
    ...new Set(
      records.filter((record) => record.context?.projectFile === true)
        .map((record) => record.key),
    ),
  ];
}

export function landingCommitMessage(changeset: Changeset): string {
  return `${changeset.title}\n\nChangeset ${changeset.id}`;
}

// Commits OpenTide's paths and the files `changesetId` wrote. Returns the sha,
// or null when there was nothing to commit or the project turned commits off.
// Throws GitProjectError when git refuses.
export async function commitManagedPaths(
  kernel: Kernel,
  projectDir: string,
  message: string,
  changesetId: string | null,
): Promise<string | null> {
  // Only ever an OpenTide project's repo: a directory without a manifest may
  // sit inside someone else's.
  if (!hasProjectManifest(projectDir)) return null;
  if (readProjectCommitOnComplete(projectDir) === false) return null;
  const files = changesetId
    ? await changedProjectFiles(kernel, changesetId)
    : [];
  // A project with no repo gets one, with the .gitignore a scaffolded project
  // has, so the user's own `git add -A` later can't pick up the server token.
  if (!insideWorkTree(projectDir)) {
    writeFileIfMissing(join(projectDir, GITIGNORE_FILE), PROJECT_GITIGNORE);
    files.push(GITIGNORE_FILE);
  }
  return gitCommitPaths(
    projectDir,
    message,
    landingPathspecs(projectDir, files),
  );
}

// Commits a completed changeset. Never throws: the changeset is complete
// whether or not git cooperates, so a failure is reported, not raised.
export async function commitLandedChangeset(
  kernel: Kernel,
  changeset: Changeset,
): Promise<LandingCommit> {
  const projectDir = kernel.projectDir;
  if (!projectDir || !hasProjectManifest(projectDir)) {
    return { committed: false, reason: "no_project" };
  }
  const enabled = readProjectCommitOnComplete(projectDir) ??
    COMMIT_ON_COMPLETE_DEFAULT;
  if (!enabled) {
    return { committed: false, reason: "off" };
  }
  try {
    const sha = await commitManagedPaths(
      kernel,
      projectDir,
      landingCommitMessage(changeset),
      changeset.id,
    );
    return sha
      ? { committed: true, sha }
      : { committed: false, reason: "nothing_to_commit" };
  } catch (err) {
    const message = errorMessage(err);
    kernel.log.log("warn", "system", `Landing commit failed: ${message}`);
    return { committed: false, reason: "failed", message };
  }
}
