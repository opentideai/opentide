import { assertEquals, assertStringIncludes, assertThrows } from "@std/assert";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { GIT_STATUS_FILE_LIMIT, PROJECT_GITIGNORE } from "./config.ts";
import { tideProjectGitignore } from "./project-manager.ts";
import {
  gitAddTideGitignore,
  gitCommit,
  gitInit,
  GitProjectError,
  gitSetRemote,
  gitStatus,
} from "./git.ts";
import { TEST_TMP_DIR } from "./test-home_test.ts";

function gitAvailable(): boolean {
  try {
    return new Deno.Command("git", {
      args: ["--version"],
      stdout: "null",
      stderr: "null",
    }).outputSync().success;
  } catch {
    return false;
  }
}

function runGit(cwd: string, args: string[]): void {
  const result = new Deno.Command("git", {
    args,
    cwd,
    stdout: "null",
    stderr: "piped",
  }).outputSync();
  if (!result.success) {
    throw new Error(new TextDecoder().decode(result.stderr));
  }
}

async function withTempProject<T>(fn: (dir: string) => Promise<T> | T) {
  const dir = await Deno.makeTempDir({
    dir: TEST_TMP_DIR,
    prefix: "tideide-git-test-",
  });
  try {
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

Deno.test("git_add_tide_gitignore writes defaults only when missing", async () => {
  await withTempProject((dir) => {
    const first = gitAddTideGitignore(dir);
    assertEquals(first.added, true);
    const content = readFileSync(join(dir, ".gitignore"), "utf-8");
    assertStringIncludes(content, ".env");
    assertStringIncludes(content, "data/");
    assertStringIncludes(content, ".opentide/caches/");

    writeFileSync(join(dir, ".gitignore"), "custom\n");
    const second = gitAddTideGitignore(dir);
    assertEquals(second.added, false);
    assertEquals(readFileSync(join(dir, ".gitignore"), "utf-8"), "custom\n");
  });
});

Deno.test("git status reports missing, clean, and dirty repositories", async () => {
  if (!gitAvailable()) return;
  await withTempProject((dir) => {
    const missing = gitStatus(dir);
    assertEquals(missing.initialized, false);

    const initialized = gitInit(dir);
    assertEquals(initialized.initialized, true);
    assertEquals(initialized.clean, true);

    writeFileSync(join(dir, "opentide.json"), "{}\n");
    const dirty = gitStatus(dir);
    assertEquals(dirty.initialized, true);
    assertEquals(dirty.dirty, true);
    assertEquals(dirty.untrackedCount, 1);
  });
});

Deno.test("git commit stages all nonignored files and leaves ignored local paths untracked", async () => {
  if (!gitAvailable()) return;
  await withTempProject((dir) => {
    gitInit(dir);
    runGit(dir, ["config", "user.email", "tide-test@example.com"]);
    runGit(dir, ["config", "user.name", "Tide Test"]);
    writeFileSync(
      join(dir, ".gitignore"),
      ".env\ndata/\n.opentide/caches/\n.opentide/backups/\n",
    );
    writeFileSync(join(dir, "opentide.json"), "{}\n");
    writeFileSync(join(dir, ".env"), "SECRET=1\n");
    mkdirSync(join(dir, "data"), { recursive: true });
    writeFileSync(join(dir, "data", "local.db"), "local");
    mkdirSync(join(dir, ".opentide", "caches"), { recursive: true });
    writeFileSync(join(dir, ".opentide", "caches", "logs.json"), "[]");

    const status = gitCommit(dir, "Initial project commit");
    assertEquals(status.clean, true);

    const tracked = new Deno.Command("git", {
      args: ["ls-files"],
      cwd: dir,
      stdout: "piped",
      stderr: "piped",
    }).outputSync();
    const files = new TextDecoder().decode(tracked.stdout).split(/\r?\n/);
    assertEquals(files.includes("opentide.json"), true);
    assertEquals(files.includes(".gitignore"), true);
    assertEquals(files.includes(".env"), false);
    assertEquals(files.includes("data/local.db"), false);
    assertEquals(files.includes(".opentide/caches/logs.json"), false);
  });
});

Deno.test("git remote setup updates origin without requiring a commit", async () => {
  if (!gitAvailable()) return;
  await withTempProject((dir) => {
    gitInit(dir);
    const first = gitSetRemote(dir, "https://example.com/one.git");
    assertEquals(first.remotes[0]?.name, "origin");
    assertEquals(first.remotes[0]?.fetchUrl, "https://example.com/one.git");

    const second = gitSetRemote(dir, "https://example.com/two.git");
    assertEquals(second.remotes.length, 1);
    assertEquals(second.remotes[0]?.fetchUrl, "https://example.com/two.git");
  });
});

Deno.test("git commit reports nothing to commit", async () => {
  if (!gitAvailable()) return;
  await withTempProject((dir) => {
    gitInit(dir);
    assertThrows(
      () => gitCommit(dir, "No changes"),
      GitProjectError,
      "There are no staged changes",
    );
    assertEquals(existsSync(join(dir, ".git")), true);
  });
});

// The six machine-local `.opentide/history/` entries. Everything else under
// history/ (changelog, changesets, sessions, the verification ledger) is the
// provenance chain and must stay tracked — a clone without it has changesets
// pointing at a changelog that is not there.
const MACHINE_LOCAL_IGNORES = [
  ".opentide/history/usage/",
  ".opentide/history/model-usage.jsonl",
  ".opentide/history/survival.jsonl",
  ".opentide/history/episodes.jsonl",
  ".opentide/history/cursor.json",
  ".opentide/history/cache-composition.jsonl",
];

Deno.test("project gitignore template has one source and ignores only machine-local history", () => {
  // The template used to be two byte-identical copies that had already drifted.
  assertEquals(tideProjectGitignore(), PROJECT_GITIGNORE);
  for (const entry of MACHINE_LOCAL_IGNORES) {
    assertStringIncludes(PROJECT_GITIGNORE, entry);
  }
  // Provenance stays tracked.
  for (
    const kept of [
      ".opentide/history/changelog/",
      ".opentide/history/changesets/",
      ".opentide/history/sessions/",
      "verification-ledger.json",
    ]
  ) {
    assertEquals(PROJECT_GITIGNORE.includes(kept), false);
  }
});

Deno.test("git status splits app source from .opentide project state", async () => {
  if (!gitAvailable()) return;
  await withTempProject((dir) => {
    gitInit(dir);
    runGit(dir, ["config", "user.email", "tide-test@example.com"]);
    runGit(dir, ["config", "user.name", "Tide Test"]);
    // Commit first: the real case is *tracked* provenance files the agent
    // rewrites mid-turn, not untracked junk. (An untracked directory collapses
    // to a single porcelain entry, which would hide the thing being tested.)
    mkdirSync(join(dir, ".opentide", "history", "sessions"), {
      recursive: true,
    });
    writeFileSync(join(dir, "opentide.json"), "{}\n");
    for (let i = 0; i < 5; i++) {
      writeFileSync(
        join(dir, ".opentide", "history", "sessions", `s${i}.json`),
        "{}\n",
      );
    }
    runGit(dir, ["add", "-A"]);
    runGit(dir, ["commit", "-m", "Initial"]);

    writeFileSync(join(dir, "opentide.json"), '{"name":"app"}\n');
    for (let i = 0; i < 5; i++) {
      writeFileSync(
        join(dir, ".opentide", "history", "sessions", `s${i}.json`),
        `{"turn":${i}}\n`,
      );
    }
    writeFileSync(join(dir, "handler.ts"), "//\n");

    const status = gitStatus(dir);
    // files[] carries app source only...
    assertEquals(status.files.map((file) => file.path).sort(), [
      "handler.ts",
      "opentide.json",
    ]);
    // ...the rest is counts-only.
    assertEquals(status.projectState, { changedCount: 5, untrackedCount: 0 });
    // ...and the totals still cover both groups.
    assertEquals(status.changedCount, 6);
    assertEquals(status.untrackedCount, 1);
    assertEquals(status.dirty, true);
    assertEquals(status.truncated, undefined);
  });
});

Deno.test("git status caps app-source files and keeps the counts whole", async () => {
  if (!gitAvailable()) return;
  await withTempProject((dir) => {
    gitInit(dir);
    const overCap = GIT_STATUS_FILE_LIMIT + 7;
    for (let i = 0; i < overCap; i++) {
      writeFileSync(join(dir, `file-${String(i).padStart(4, "0")}.ts`), "//\n");
    }
    mkdirSync(join(dir, ".opentide", "history"), { recursive: true });
    writeFileSync(join(dir, ".opentide", "history", "cursor.json"), "{}\n");

    const status = gitStatus(dir);
    assertEquals(status.files.length, GIT_STATUS_FILE_LIMIT);
    assertEquals(status.truncated, true);
    // The cap never lies about how much changed.
    assertEquals(status.untrackedCount, overCap + 1);
    assertEquals(status.projectState.untrackedCount, 1);
    assertEquals(
      status.files.every((file) => !file.path.startsWith(".opentide/")),
      true,
    );
  });
});

Deno.test("git status on a clean repo reports no files and no truncation", async () => {
  if (!gitAvailable()) return;
  await withTempProject((dir) => {
    const status = gitInit(dir);
    assertEquals(status.clean, true);
    assertEquals(status.files, []);
    assertEquals(status.truncated, undefined);
    assertEquals(status.projectState, { changedCount: 0, untrackedCount: 0 });
    assertEquals(status.changedCount, 0);
    assertEquals(status.untrackedCount, 0);
  });
});

Deno.test("git status on a non-repository still carries the project-state summary", async () => {
  await withTempProject((dir) => {
    const status = gitStatus(dir);
    assertEquals(status.initialized, false);
    assertEquals(status.projectState, { changedCount: 0, untrackedCount: 0 });
    assertEquals(status.truncated, undefined);
  });
});
