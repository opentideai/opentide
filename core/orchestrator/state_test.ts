import { assertEquals, assertStringIncludes } from "@std/assert";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  emptyOrchestratorState,
  getOrchestratorStatePath,
  ORCHESTRATOR_STATE_FILE,
  type OrchestratorState,
  readOrchestratorState,
  writeOrchestratorState,
} from "./state.ts";
import { TEST_TMP_DIR } from "../test-home_test.ts";

async function withTempDir(fn: (dir: string) => void): Promise<void> {
  const dir = await Deno.makeTempDir({
    dir: TEST_TMP_DIR,
    prefix: "orchestrator-state-",
  });
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

Deno.test("state: round-trips a full running set", async () => {
  await withTempDir((dir) => {
    const path = join(dir, ORCHESTRATOR_STATE_FILE);
    const state: OrchestratorState = {
      version: 1,
      projects: [
        {
          projectPath: "/abs/project-a",
          desiredState: "running",
          controlPort: 3101,
          pid: 48213,
          lastStartedAt: "2026-07-26T10:22:03.000Z",
          lastExit: null,
          lastKnownAppPort: 52189,
        },
        {
          projectPath: "/abs/project-b",
          desiredState: "stopped",
          lastStartedAt: "2026-07-25T18:04:11.000Z",
          lastExit: { code: 0, signal: null, at: "2026-07-25T19:40:00.000Z" },
        },
      ],
    };
    writeOrchestratorState(path, state);
    assertEquals(readOrchestratorState(path), state);
  });
});

Deno.test("state: missing file reads back as the empty running set", async () => {
  await withTempDir((dir) => {
    const path = join(dir, "nope.json");
    assertEquals(readOrchestratorState(path), emptyOrchestratorState());
    assertEquals(existsSync(`${path}.corrupt`), false);
  });
});

Deno.test("state: atomic write leaves no temp file", async () => {
  await withTempDir((dir) => {
    const path = join(dir, ORCHESTRATOR_STATE_FILE);
    writeOrchestratorState(path, {
      version: 1,
      projects: [{ projectPath: "/x", desiredState: "running" }],
    });
    assertEquals(existsSync(`${path}.tmp`), false);
    assertEquals(existsSync(path), true);
  });
});

Deno.test("state: corrupt file degrades to empty and is quarantined", async () => {
  await withTempDir((dir) => {
    const path = join(dir, ORCHESTRATOR_STATE_FILE);
    writeFileSync(path, "{ not valid json ]");
    assertEquals(readOrchestratorState(path), emptyOrchestratorState());
    assertEquals(existsSync(`${path}.corrupt`), true);
    assertEquals(existsSync(path), false);
  });
});

Deno.test("state: wrong-version file is quarantined as corrupt", async () => {
  await withTempDir((dir) => {
    const path = join(dir, ORCHESTRATOR_STATE_FILE);
    writeFileSync(path, JSON.stringify({ version: 99, projects: [] }));
    assertEquals(readOrchestratorState(path), emptyOrchestratorState());
    assertEquals(existsSync(`${path}.corrupt`), true);
  });
});

Deno.test("state: malformed individual records are dropped, valid ones kept", async () => {
  await withTempDir((dir) => {
    const path = join(dir, ORCHESTRATOR_STATE_FILE);
    // One good record, plus junk: no projectPath, bad desiredState, non-object.
    writeFileSync(
      path,
      JSON.stringify({
        version: 1,
        projects: [
          { projectPath: "/good", desiredState: "running", controlPort: 3101 },
          { desiredState: "running" },
          { projectPath: "/bad-state", desiredState: "paused" },
          "not-an-object",
        ],
      }),
    );
    const state = readOrchestratorState(path);
    assertEquals(state.projects.length, 1);
    assertEquals(state.projects[0]?.projectPath, "/good");
    assertEquals(state.projects[0]?.controlPort, 3101);
    // The file parsed (just partially) — it is not quarantined.
    assertEquals(existsSync(`${path}.corrupt`), false);
  });
});

Deno.test("state: default path is a sibling of registry.json in the tide dir", () => {
  const path = getOrchestratorStatePath();
  assertStringIncludes(path, ORCHESTRATOR_STATE_FILE);
  assertStringIncludes(path, join(".config", "opentide"));
});

Deno.test("state: optional fields absent from disk stay absent after read", async () => {
  await withTempDir((dir) => {
    const path = join(dir, ORCHESTRATOR_STATE_FILE);
    const minimal: OrchestratorState = {
      version: 1,
      projects: [{ projectPath: "/only", desiredState: "stopped" }],
    };
    writeOrchestratorState(path, minimal);
    // The on-disk JSON carries no controlPort/pid keys for a minimal record.
    const onDisk = readFileSync(path, "utf-8");
    assertEquals(onDisk.includes("controlPort"), false);
    assertEquals(readOrchestratorState(path), minimal);
  });
});
