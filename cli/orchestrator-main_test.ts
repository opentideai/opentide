import { assert, assertEquals } from "@std/assert";
import {
  type OrchestratorHandle,
  resolveUiDist,
  runOrchestrator,
} from "./orchestrator-main.ts";
import type {
  LogLine,
  RunningChild,
  Supervisor,
} from "../core/orchestrator/supervisor.ts";
import type { DashboardServer } from "../core/orchestrator/dashboard-server.ts";
import type { Result } from "../core/types.ts";

// A fake Supervisor: records init()/shutdownAll() calls so the composition root
// can be driven without booting a real kernel (the B1b library carries the real
// supervision coverage). Serves no HTTP, spawns nothing.
class FakeSupervisor implements Supervisor {
  initCalls = 0;
  shutdownAllCalls = 0;

  init(): Promise<void> {
    this.initCalls++;
    return Promise.resolve();
  }
  start(_p: string): Promise<Result<RunningChild>> {
    return Promise.resolve({
      ok: false,
      error: { code: "UNUSED", message: "not used in this test" },
    });
  }
  stop(_p: string): Promise<Result<void>> {
    return Promise.resolve({ ok: true, data: undefined });
  }
  list(): RunningChild[] {
    return [];
  }
  get(_p: string): RunningChild | null {
    return null;
  }
  logs(_p: string): LogLine[] {
    return [];
  }
  restart(_p: string): Promise<Result<RunningChild>> {
    return Promise.resolve({
      ok: false,
      error: { code: "UNUSED", message: "not used in this test" },
    });
  }
  forgetStoppedProject(_p: string): Promise<boolean> {
    return Promise.resolve(false);
  }
  shutdownAll(): Promise<void> {
    this.shutdownAllCalls++;
    return Promise.resolve();
  }
}

// A no-op lifecycle: no OS signal listeners (so a unit test leaves nothing
// lingering for the resource sanitizer). Returns a no-op disposer.
function noopLifecycle(_shutdown: () => Promise<void>): () => void {
  return () => {};
}

// A fake dashboard server: binds no real port (so unit tests never touch :3100)
// and records its shutdown so the idempotency test can observe it fires.
function fakeServer(): DashboardServer & { shutdownCalls: number } {
  const server = {
    port: 0,
    hostname: "127.0.0.1",
    shutdownCalls: 0,
    shutdown() {
      server.shutdownCalls++;
      return Promise.resolve();
    },
    finished: Promise.resolve(),
  };
  return server;
}

// Boot the root against a fake supervisor, capturing the uiDist the factory got.
async function bootWithFake(
  argv: string[],
): Promise<
  { handle: OrchestratorHandle; fake: FakeSupervisor; uiDist: string | null }
> {
  const fake = new FakeSupervisor();
  let captured: string | null = null;
  const handle = await runOrchestrator(argv, {
    supervisorFactory: (uiDist) => {
      captured = uiDist;
      return fake;
    },
    startServer: () => fakeServer(),
    installLifecycle: noopLifecycle,
  });
  return { handle, fake, uiDist: captured };
}

Deno.test("runOrchestrator: init() runs once on boot", async () => {
  // A non-existent --ui-dist resolves to null (child dev-server fallback), which
  // also keeps the test off the repo's real ide/build.
  const { fake } = await bootWithFake(["--ui-dist", "/no/such/dir"]);
  assertEquals(fake.initCalls, 1);
});

Deno.test("runOrchestrator: resolved uiDist is threaded into the supervisor", async () => {
  // A real existing dir survives resolveUiDist and must reach the factory AND the
  // handle unchanged.
  const real = Deno.cwd();
  const { handle, uiDist } = await bootWithFake(["--ui-dist", real]);
  assertEquals(uiDist, real);
  assertEquals(handle.uiDist, real);

  // An absent bundle threads null (not a crash) — children fall back to dev.
  const absent = await bootWithFake(["--ui-dist", "/no/such/dir"]);
  assertEquals(absent.uiDist, null);
  assertEquals(absent.handle.uiDist, null);
});

Deno.test("runOrchestrator: shutdown calls shutdownAll exactly once (idempotent)", async () => {
  const { handle, fake } = await bootWithFake(["--ui-dist", "/no/such/dir"]);
  await handle.shutdown();
  await handle.shutdown();
  await handle.shutdown();
  assertEquals(fake.shutdownAllCalls, 1);
});

Deno.test("resolveUiDist: real dir passes through, absent dir yields null", () => {
  assertEquals(resolveUiDist(Deno.cwd()), Deno.cwd());
  assertEquals(resolveUiDist("/definitely/not/a/real/dir"), null);
  // Default (no flag): falls back to the repo's ide/build when it has been
  // built, and to null where it has not (or, in the open repo, does not exist).
  const dflt = resolveUiDist(null);
  assert(dflt === null || dflt.endsWith("ide/build"));
});
