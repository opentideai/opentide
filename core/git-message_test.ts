import { assertEquals } from "@std/assert";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gitCommit, gitInit, gitStatus } from "./git.ts";
import { resolveGitCommitMessage } from "./git-message.ts";
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

function configureGitIdentity(dir: string): void {
  runGit(dir, ["config", "user.email", "tide-test@example.com"]);
  runGit(dir, ["config", "user.name", "Tide Test"]);
}

async function withTempProject<T>(fn: (dir: string) => Promise<T> | T) {
  const dir = await Deno.makeTempDir({
    dir: TEST_TMP_DIR,
    prefix: "tideide-git-message-test-",
  });
  try {
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

Deno.test("a typed git commit message is used as typed", async () => {
  if (!gitAvailable()) return;
  await withTempProject((dir) => {
    gitInit(dir);
    assertEquals(resolveGitCommitMessage(dir, "  Add config "), {
      message: "Add config",
      generated: false,
      generatedBy: "user",
    });
  });
});

Deno.test("an empty git commit message is built from the staged files", async () => {
  if (!gitAvailable()) return;
  await withTempProject((dir) => {
    gitInit(dir);
    configureGitIdentity(dir);
    writeFileSync(join(dir, "index.html"), "<h1>Hello</h1>\n");
    const resolved = resolveGitCommitMessage(dir, "");
    assertEquals(resolved, {
      message: "Add index.html",
      generated: true,
      generatedBy: "fallback",
    });
    const status = gitCommit(dir, resolved.message);
    assertEquals(status.clean, true);
    assertEquals(gitStatus(dir).latestCommit?.subject, "Add index.html");
  });
});
