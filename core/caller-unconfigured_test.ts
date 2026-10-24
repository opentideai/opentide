// @layer core — D9 caller-audit: a utility-role call site must no-op / fall back
// cleanly when the model is UNCONFIGURED, never pass undefined/"" to a provider.
//
// This file deliberately statically imports NOTHING that loads config.ts, so config's
// dir is frozen to the temp HOME set below at its first (dynamic) load — the same
// bare-config-freeze discipline model-refresh-hook_test documents. Everything that
// touches config/git-message is imported cache-busted after HOME is set.
import { assert, assertEquals } from "@std/assert";
import { join } from "node:path";
import { writeFileSync } from "node:fs";
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

Deno.test("D9 caller audit: git-message falls back (no provider call) when the model is unconfigured", async () => {
  if (!gitAvailable()) return;

  const home = await Deno.makeTempDir({ prefix: "genie-unconfigured-caller-" });
  const projectDir = await Deno.makeTempDir({
    dir: TEST_TMP_DIR,
    prefix: "genie-unconfigured-git-",
  });
  const oldHome = Deno.env.get("HOME");
  const oldAnthropic = Deno.env.get("ANTHROPIC_API_KEY");
  const oldOpenai = Deno.env.get("OPENAI_API_KEY");
  try {
    // Fresh empty config dir + no provider keys → an UNCONFIGURED utility role.
    Deno.env.set("HOME", home);
    Deno.env.delete("ANTHROPIC_API_KEY");
    Deno.env.delete("OPENAI_API_KEY");

    const bust = crypto.randomUUID();
    const config = await import(
      `./config.ts?u=${bust}`
    ) as typeof import("./config.ts");
    // Precondition: with no key and no recommendation, the utility role is unconfigured.
    assertEquals(config.getUtilityModelForRequest(), undefined);

    const gitMessage = await import(
      `./git-message.ts?u=${bust}`
    ) as typeof import("./git-message.ts");

    // A real git repo with a staged change so a fallback subject can be derived.
    runGit(projectDir, ["init"]);
    runGit(projectDir, ["config", "user.email", "tide-test@example.com"]);
    runGit(projectDir, ["config", "user.name", "Tide Test"]);
    writeFileSync(join(projectDir, "index.html"), "<h1>Hi</h1>\n");

    // No testModelCall injected: the site must fall back to the deterministic message
    // rather than call a provider with no configured model (and no key).
    const resolved = await gitMessage.resolveGitCommitMessage(projectDir, "");
    assertEquals(resolved.generatedBy, "fallback");
    assert(resolved.message.length > 0, "a fallback subject is still produced");
  } finally {
    if (oldHome === undefined) Deno.env.delete("HOME");
    else Deno.env.set("HOME", oldHome);
    if (oldAnthropic === undefined) Deno.env.delete("ANTHROPIC_API_KEY");
    else Deno.env.set("ANTHROPIC_API_KEY", oldAnthropic);
    if (oldOpenai === undefined) Deno.env.delete("OPENAI_API_KEY");
    else Deno.env.set("OPENAI_API_KEY", oldOpenai);
    await Deno.remove(home, { recursive: true });
    await Deno.remove(projectDir, { recursive: true });
  }
});
