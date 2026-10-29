import { assert, assertEquals } from "@std/assert";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createProject } from "./project-manager.ts";
import {
  acquireProjectLock,
  isProjectLockHeld,
  type ProjectLock,
} from "./project-lock.ts";
import { readServerToken, writeServerToken } from "./server-token.ts";
import {
  locateServe,
  opentideCwd,
  opentideInvocation,
  type SpawnedServe,
  spawnedServeArgs,
} from "./serve-process.ts";
import { getServeArgs } from "../cli/assembly.ts";
import { isolateHome } from "./test-home_test.ts";

isolateHome();

const FAST = { timeoutMs: 1_000, pollMs: 10 };

function tempProject(name: string): { dir: string; cleanup: () => void } {
  const parent = mkdtempSync(join(tmpdir(), "genie-serve-process-"));
  return {
    dir: createProject(parent, name).path,
    cleanup: () => rmSync(parent, { recursive: true, force: true }),
  };
}

function hold(dir: string): ProjectLock {
  const lock = acquireProjectLock(dir, "a test");
  if (!lock.ok) throw new Error(lock.error.message);
  return lock.data;
}

function noSpawn(): SpawnedServe {
  throw new Error("must not spawn");
}

Deno.test("isProjectLockHeld follows the OS lock, not the record", () => {
  const { dir, cleanup } = tempProject("Bridge Held");
  try {
    assertEquals(isProjectLockHeld(dir), false);
    const lock = hold(dir);
    assertEquals(isProjectLockHeld(dir), true);
    lock.release();
    // The record still names the old holder; the lock is free.
    assertEquals(isProjectLockHeld(dir), false);
  } finally {
    cleanup();
  }
});

Deno.test("locateServe attaches to a live serve holder", async () => {
  const { dir, cleanup } = tempProject("Bridge Attach");
  const lock = hold(dir);
  try {
    writeServerToken(dir, "tok");
    lock.advertise({ role: "serve", controlPort: 4321 });
    const found = await locateServe(dir, { ...FAST, spawn: noSpawn });
    assert(found.ok);
    assertEquals(found.data.url, "http://127.0.0.1:4321/mcp");
    assertEquals(found.data.token, "tok");
    assertEquals(found.data.started, null);
  } finally {
    lock.release();
    cleanup();
  }
});

Deno.test("locateServe refuses a standalone mcp holder", async () => {
  const { dir, cleanup } = tempProject("Bridge Refuse");
  const lock = hold(dir);
  try {
    lock.advertise({ role: "mcp" });
    const found = await locateServe(dir, { ...FAST, spawn: noSpawn });
    assert(!found.ok);
    assertEquals(found.error.code, "PROJECT_ALREADY_OPEN");
  } finally {
    lock.release();
    cleanup();
  }
});

Deno.test("locateServe gives up on a holder that never advertises", async () => {
  const { dir, cleanup } = tempProject("Bridge Silent");
  const lock = hold(dir);
  try {
    const found = await locateServe(dir, { ...FAST, spawn: noSpawn });
    assert(!found.ok);
    assertEquals(found.error.code, "SERVE_NOT_READY");
  } finally {
    lock.release();
    cleanup();
  }
});

Deno.test("locateServe drops a dead holder's token and starts serve", async () => {
  const { dir, cleanup } = tempProject("Bridge Stale");
  // What kill -9 leaves: a serve record and a token, nobody holding the lock.
  const dead = hold(dir);
  dead.advertise({ role: "serve", controlPort: 1 });
  writeServerToken(dir, "stale");
  dead.release();

  let lock: ProjectLock | null = null;
  let tokenAtSpawn: string | null = "unset";
  const spawn = (projectDir: string): SpawnedServe => {
    tokenAtSpawn = readServerToken(projectDir);
    lock = hold(projectDir);
    writeServerToken(projectDir, "fresh");
    lock.advertise({ role: "serve", controlPort: 5555 });
    return { pid: Deno.pid, logPath: null, exited: () => false };
  };
  try {
    const found = await locateServe(dir, { ...FAST, spawn });
    assert(found.ok);
    assertEquals(tokenAtSpawn, null);
    assertEquals(found.data.url, "http://127.0.0.1:5555/mcp");
    assertEquals(found.data.token, "fresh");
    assertEquals(found.data.started?.pid, Deno.pid);
  } finally {
    (lock as ProjectLock | null)?.release();
    cleanup();
  }
});

Deno.test("locateServe reports a serve that died on startup", async () => {
  const { dir, cleanup } = tempProject("Bridge Died");
  try {
    const found = await locateServe(dir, {
      ...FAST,
      spawn: () => ({ pid: 1, logPath: "/x/serve.log", exited: () => true }),
    });
    assert(!found.ok);
    assertEquals(found.error.code, "SERVE_START_FAILED");
    assertEquals(found.error.suggestion, "See /x/serve.log.");
  } finally {
    cleanup();
  }
});

Deno.test("opentideInvocation: a compiled binary runs itself with the subcommand", () => {
  for (const sub of ["serve", "mcp"] as const) {
    assertEquals(opentideInvocation(sub, { kind: "binary" }), {
      command: Deno.execPath(),
      args: [sub],
    });
  }
  assertEquals(opentideCwd({ kind: "binary" }), null);
});

Deno.test("opentideInvocation: an installed launcher runs itself with the subcommand", () => {
  const runtime = {
    kind: "launcher",
    path: "/home/u/.deno/bin/opentide",
  } as const;
  assertEquals(opentideInvocation("mcp", runtime), {
    command: "/home/u/.deno/bin/opentide",
    args: ["mcp"],
  });
  assertEquals(opentideCwd(runtime), null);
});

Deno.test("opentideInvocation: from a clone, serve is the opentide task plus serve", () => {
  const clone = { kind: "clone" } as const;
  const serve = opentideInvocation("serve", clone);
  assertEquals(serve.args.at(-1), "serve");
  assert(serve.args.at(-2)!.endsWith(join("cli", "cli.ts")));
  assert(
    opentideInvocation("mcp", clone).args.at(-1)!.endsWith(
      join("cli", "mcp-main.ts"),
    ),
  );
  assert(opentideCwd(clone) !== null);
});

// The bridge starts serve and nobody stops it, so it has to stop itself.
Deno.test("a serve the bridge starts exits when idle", () => {
  const parsed = getServeArgs(3003, spawnedServeArgs("/p", 4321));
  assertEquals(parsed.projectPath, "/p");
  assertEquals(parsed.port, 4321);
  assertEquals(parsed.exitWhenIdle, true);
});
