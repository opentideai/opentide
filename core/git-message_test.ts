import { assertEquals, assertStringIncludes } from "@std/assert";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gitCommit, gitInit, gitStatus } from "./git.ts";
import {
  resolveGitCommitMessage,
  setGitCommitMessageModelCallForTest,
} from "./git-message.ts";
import { setRecommendedModels } from "./config.ts";
import {
  setUtilityModelCallForTest,
  setUtilityModelUsageRecorderForTest,
} from "./utility-model.ts";
import type { RecordModelUsageInput } from "./types.ts";

function seedModelCache(home: string, model: string, provider: string): void {
  const dir = join(home, ".config", "opentide");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "models-cache.json"),
    JSON.stringify({
      models: [{ id: model, label: model, provider }],
      cachedAt: new Date().toISOString(),
    }),
  );
}

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
    dir: "/private/tmp",
    prefix: "tideide-git-message-test-",
  });
  try {
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

Deno.test("empty git commit message is generated from the model when available", async () => {
  if (!gitAvailable()) return;
  await withTempProject(async (dir) => {
    gitInit(dir);
    configureGitIdentity(dir);
    writeFileSync(join(dir, "opentide.json"), "{}\n");
    const restore = setGitCommitMessageModelCallForTest(async ({ context }) => {
      assertStringIncludes(context.nameStatus, "opentide.json");
      return "Add project config";
    });

    try {
      const resolved = await resolveGitCommitMessage(dir, "");
      assertEquals(resolved, {
        message: "Add project config",
        generated: true,
        generatedBy: "model",
      });

      const status = gitCommit(dir, resolved.message);
      assertEquals(status.clean, true);
      assertEquals(gitStatus(dir).latestCommit?.subject, "Add project config");
    } finally {
      restore();
    }
  });
});

Deno.test("empty git commit message falls back when model output is invalid", async () => {
  if (!gitAvailable()) return;
  await withTempProject(async (dir) => {
    gitInit(dir);
    configureGitIdentity(dir);
    writeFileSync(join(dir, "index.html"), "<h1>Hello</h1>\n");
    const restore = setGitCommitMessageModelCallForTest(async () => "");

    try {
      const resolved = await resolveGitCommitMessage(dir, "");
      assertEquals(resolved, {
        message: "Add index.html",
        generated: true,
        generatedBy: "fallback",
      });
    } finally {
      restore();
    }
  });
});

Deno.test("default git message generation records git_message utility usage", async () => {
  if (!gitAvailable()) return;
  const home = await Deno.makeTempDir({ prefix: "genie-git-message-home-" });
  const oldHome = Deno.env.get("HOME");
  const oldAnthropic = Deno.env.get("ANTHROPIC_API_KEY");
  const oldOpenai = Deno.env.get("OPENAI_API_KEY");
  const records: RecordModelUsageInput[] = [];
  const restoreCall = setUtilityModelCallForTest((req) =>
    Promise.resolve({
      text: "Add project config",
      provider: "openai",
      model: req.model,
      usage: {
        inputTokens: 22,
        outputTokens: 5,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
      },
    })
  );
  const restoreRecorder = setUtilityModelUsageRecorderForTest((input) => {
    records.push(input);
    return Promise.resolve({
      id: "mu_git",
      sessionId: input.sessionId ?? null,
      turnId: null,
      auditResultId: null,
      changesetId: input.changesetId ?? null,
      provider: input.provider,
      model: input.model,
      role: input.role,
      caller: input.caller,
      startedAt: new Date(input.startedAt).toISOString(),
      endedAt: new Date(input.endedAt).toISOString(),
      durationMs: 0,
      inputTokens: input.usage.inputTokens,
      outputTokens: input.usage.outputTokens,
      cacheCreationInputTokens: input.usage.cacheCreationInputTokens,
      cacheReadInputTokens: input.usage.cacheReadInputTokens,
      toolCallsCount: 0,
      costUsd: 0.0001,
      pricingStatus: "priced",
      pricingProvider: input.provider,
      pricingModel: input.model,
      pricingVerifiedAt: null,
      pricingSource: null,
      metadata: input.metadata ?? {},
    });
  });
  try {
    Deno.env.set("HOME", home);
    Deno.env.delete("ANTHROPIC_API_KEY");
    Deno.env.set("OPENAI_API_KEY", "sk-openai-test");
    seedModelCache(home, "gpt-5-mini", "openai");
    setRecommendedModels({ utility: "gpt-5-mini" });
    await withTempProject(async (dir) => {
      gitInit(dir);
      configureGitIdentity(dir);
      writeFileSync(join(dir, "opentide.json"), "{}\n");

      const resolved = await resolveGitCommitMessage(dir, "", undefined, {
        sessionId: "session_git",
        changesetId: "cs_git",
      });

      assertEquals(resolved.generatedBy, "model");
      assertEquals(records.length, 1);
      assertEquals(records[0]!.role, "utility");
      assertEquals(records[0]!.caller, "git_message");
      assertEquals(records[0]!.provider, "openai");
      assertEquals(records[0]!.sessionId, "session_git");
      assertEquals(records[0]!.changesetId, "cs_git");
      assertEquals(records[0]!.usage.inputTokens, 22);
    });
  } finally {
    restoreCall();
    restoreRecorder();
    if (oldHome === undefined) Deno.env.delete("HOME");
    else Deno.env.set("HOME", oldHome);
    if (oldAnthropic === undefined) Deno.env.delete("ANTHROPIC_API_KEY");
    else Deno.env.set("ANTHROPIC_API_KEY", oldAnthropic);
    if (oldOpenai === undefined) Deno.env.delete("OPENAI_API_KEY");
    else Deno.env.set("OPENAI_API_KEY", oldOpenai);
    rmSync(home, { recursive: true, force: true });
  }
});
