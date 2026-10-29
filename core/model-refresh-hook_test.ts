import { assert, assertEquals } from "@std/assert";
import { join } from "node:path";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import type { LogLevel, LogSource } from "./types.ts";
import type { Kernel } from "./registries.ts";

// A captured structured log line, so the tests can assert the hook logs through
// kernel.log.log — never console — on both the skip and the failure paths.
interface Captured {
  level: LogLevel;
  source: LogSource;
  message: string;
}

function kernelStub(sink: Captured[], initHooks: unknown[] = []): Kernel {
  return {
    log: {
      log: (level: LogLevel, source: LogSource, message: string) =>
        sink.push({ level, source, message }),
    },
    composition: { initHooks },
  } as unknown as Kernel;
}

// Let the detached (fire-and-forget) refresh settle: refreshModelsOnStart returns
// immediately and its work runs off a promise; a real-timer tick flushes that
// chain (keyless, so there is no network await to wait on).
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 20));
}

// One temp $HOME for the whole file. The hook imports config through a *bare*
// specifier, so config's dir is frozen at that module's first load; a single fixed
// HOME (never switched between cases) keeps the hook and the config the test drives
// pointed at the same on-disk config files. Per-case isolation comes from resetting
// that on-disk state between cases rather than from switching HOME (which would
// leave the hook's frozen config pointed at a stale dir). Mirrors config_test.ts's
// "isolate config under a temp HOME", adapted to the hook's bare config edge.
Deno.test("model auto-refresh hook (G4)", async (t) => {
  const home = await Deno.makeTempDir({ prefix: "genie-g4-" });
  const oldHome = Deno.env.get("HOME");
  const oldKey = Deno.env.get("ANTHROPIC_API_KEY");
  const oldOpenaiKey = Deno.env.get("OPENAI_API_KEY");
  Deno.env.set("HOME", home);
  // Keyless: no case touches the network. The refresh gate is now provider-aware
  // (hasAnyProviderKey), so BOTH provider env keys must be unset, not just Anthropic.
  Deno.env.delete("ANTHROPIC_API_KEY");
  Deno.env.delete("OPENAI_API_KEY");
  const configDir = join(home, ".config", "opentide");
  const bust = crypto.randomUUID();
  const config = await import(
    `./config.ts?g4=${bust}`
  ) as typeof import("./config.ts");
  const hook = await import(
    `./model-refresh-hook.ts?g4=${bust}`
  ) as typeof import("./model-refresh-hook.ts");
  const projectHooks = await import(
    `./project-hooks.ts?g4=${bust}`
  ) as typeof import("./project-hooks.ts");

  // Wipe config.json / models-cache.json between cases so each starts clean.
  const reset = () => {
    rmSync(configDir, { recursive: true, force: true });
    mkdirSync(configDir, { recursive: true });
  };
  // A models-cache.json with an explicit cachedAt drives the throttle deterministically.
  const writeCache = (cachedAtIso: string) =>
    writeFileSync(
      join(configDir, "models-cache.json"),
      JSON.stringify({
        models: [{
          id: "claude-opus-4-6",
          label: "Opus 4.6",
          family: "claude-opus",
        }],
        cachedAt: cachedAtIso,
      }),
    );

  try {
    // (a) Fresh cache within the TTL: the hook is a no-op — it neither fetches nor
    // writes recommendations, and logs a skip. A sentinel recommendedModels proves
    // it was left untouched.
    await t.step("fresh cache → skip, no recommend write", async () => {
      reset();
      writeCache(new Date().toISOString()); // just now → fresh
      config.setRecommendedModels({ agent: "sentinel-agent-model" });
      const before = config.getRecommendedModels();

      const sink: Captured[] = [];
      await hook.refreshModelsOnStart(kernelStub(sink));
      await flush(); // nothing should have been spawned; flush to be sure

      assertEquals(config.getRecommendedModels(), before); // untouched
      assertEquals(before.agent, "sentinel-agent-model");
      const skip = sink.find((e) => e.message.includes("skipped"));
      assert(skip, "expected a skip log line");
      assertEquals(skip?.source, "system");
    });

    // A fresh catalog with nothing recommended yet (serve fetched it on startup
    // or on a key change) still recommends: skipping left every role unconfigured.
    await t.step(
      "fresh cache, no recommendations → recommend runs",
      async () => {
        reset();
        writeCache(new Date().toISOString()); // just now → fresh
        assertEquals(config.getRecommendedModels(), {});

        const sink: Captured[] = [];
        await hook.refreshModelsOnStart(kernelStub(sink));
        await flush();

        assertEquals(sink.some((e) => e.message.includes("skipped")), false);
        assertEquals(config.getRecommendedModels().agent, "claude-opus-4-6");
      },
    );

    // (b) A discovered (but stale) cache: the deterministic recommend runs over the
    // cached catalog and persists a valid catalog id for every role. With the curated
    // MODELS list emptied (D7), the catalog is discovery-only, so seed one covering
    // each role's family (keyless → no network re-discovery overwrites it).
    await t.step(
      "stale cache → recommend runs, valid catalog id per role",
      async () => {
        reset();
        writeFileSync(
          join(configDir, "models-cache.json"),
          JSON.stringify({
            models: [
              { id: "claude-opus-5", label: "Opus 5", family: "claude-opus" },
              {
                id: "claude-haiku-4-5-20251001",
                label: "Haiku 4.5",
                family: "claude-haiku",
              },
              {
                id: "claude-sonnet-5",
                label: "Sonnet 5",
                family: "claude-sonnet",
              },
            ],
            cachedAt: new Date(0).toISOString(), // ancient → stale
          }),
        );
        const sink: Captured[] = [];
        await hook.runModelRefresh(kernelStub(sink));

        const availableIds = new Set(
          config.getAvailableModels().map((m) => m.id),
        );
        const recommended = config.getRecommendedModels();
        for (const role of config.MODEL_ROLES) {
          const pick = recommended[role];
          assert(pick !== undefined, `role ${role} should be recommended`);
          assert(
            availableIds.has(pick),
            `role ${role} → ${pick} is not a catalog id`,
          );
        }
        assert(
          sink.some((e) =>
            e.source === "system" && e.message.includes("auto-refresh")
          ),
          "expected an auto-refresh result log line",
        );
      },
    );

    // (b2) A PARTIAL catalog (only the opus family present) recommends the
    // Opus-backed roles and leaves utility + Sonnet-backed roles ABSENT — without
    // logging "undefined" (D9).
    await t.step(
      "partial catalog → uncovered roles stay absent, no undefined in log",
      async () => {
        reset();
        writeFileSync(
          join(configDir, "models-cache.json"),
          JSON.stringify({
            models: [
              { id: "claude-opus-5", label: "Opus 5", family: "claude-opus" },
            ],
            cachedAt: new Date(0).toISOString(), // ancient → stale
          }),
        );
        const sink: Captured[] = [];
        config.setRecommendedModels({
          agent: "claude-opus-old",
          planning: "claude-opus-old",
          import: "claude-sonnet-old",
          utility: "claude-haiku-old",
          verification: "claude-sonnet-old",
        });
        await hook.runModelRefresh(kernelStub(sink));

        const recommended = config.getRecommendedModels();
        assertEquals(recommended.agent, "claude-opus-5");
        assertEquals(recommended.planning, "claude-opus-5");
        assertEquals(recommended.import, undefined);
        assertEquals(recommended.utility, undefined);
        assertEquals(recommended.verification, undefined);
        // The result log line never prints the literal "undefined".
        const refreshLine = sink.find((e) =>
          e.source === "system" && e.message.includes("auto-refresh")
        );
        assert(refreshLine, "expected an auto-refresh result log line");
        assertEquals(refreshLine!.message.includes("undefined"), false);
      },
    );

    // (d) G5: an explicit pin is never clobbered. Pin the agent role, run the
    // refresh, and assert both the stored selection and the resolved request model
    // are unchanged — while recommendedModels still updates for the default roles.
    await t.step("G5 → a pinned role survives the refresh", async () => {
      reset();
      // Seed a catalog covering the sonnet family so the default verification role has
      // something to recommend (no seed floor remains — D9). The agent role is pinned,
      // so its recommendation is irrelevant either way.
      writeFileSync(
        join(configDir, "models-cache.json"),
        JSON.stringify({
          models: [
            {
              id: "claude-sonnet-5",
              label: "Sonnet 5",
              family: "claude-sonnet",
            },
          ],
          cachedAt: new Date(0).toISOString(),
        }),
      );
      const pin = "claude-opus-4-6";
      config.setModelForRole("agent", pin); // explicit pin, not "default"
      assertEquals(config.getModelForRole("agent"), pin);

      await hook.runModelRefresh(kernelStub([]));

      assertEquals(config.getModelForRole("agent"), pin); // pin untouched
      assertEquals(config.getModelForRoleRequest("agent"), pin); // resolves to the pin
      // The default verification role still updated (this cache covers the sonnet family).
      const verification = config.getRecommendedModels().verification;
      assert(
        verification !== undefined && verification.length > 0,
        "default role should have been recommended",
      );
    });

    // (c) A failing refresh is swallowed + logged and never propagates out of
    // runProjectInitHooks. The config write is forced to throw (config.json is a
    // directory → writeFileSync EISDIR); the hook must resolve and log a warning.
    await t.step("failure → swallowed + logged, never propagates", async () => {
      reset();
      mkdirSync(join(configDir, "config.json"), { recursive: true }); // poison the write target

      const sink: Captured[] = [];
      const kernel = kernelStub(sink, [hook.refreshModelsOnStart]);
      await projectHooks.runProjectInitHooks(kernel); // must resolve despite the doomed write
      await flush();

      assert(
        sink.some((e) => e.level === "warn" && e.message.includes("failed")),
        "expected a warn log for the swallowed failure",
      );
      rmSync(join(configDir, "config.json"), { recursive: true, force: true });
    });
  } finally {
    if (oldHome === undefined) Deno.env.delete("HOME");
    else Deno.env.set("HOME", oldHome);
    if (oldKey === undefined) Deno.env.delete("ANTHROPIC_API_KEY");
    else Deno.env.set("ANTHROPIC_API_KEY", oldKey);
    if (oldOpenaiKey === undefined) Deno.env.delete("OPENAI_API_KEY");
    else Deno.env.set("OPENAI_API_KEY", oldOpenaiKey);
    await Deno.remove(home, { recursive: true });
  }
});
