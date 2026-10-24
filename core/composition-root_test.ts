// Slice A gate (OpenTide §3.3): the core boots and serves REST with no agent and
// no API key; when a composition root supplies a chat provider via chatFactory,
// the control server adopts it. Proves the agent is an optional plug-in.
import { assert, assertEquals } from "@std/assert";
import { rmSync } from "node:fs";
import { Database } from "./db.ts";
import { Kernel } from "./registries.ts";
import { LocalAuthProvider } from "./auth-provider.ts";
import { startControlServer } from "./control-server.ts";
import { testStoreComposition } from "../verification/test-stores.ts";
import { mountVerificationRoutes } from "../verification/verification-routes.ts";
import { mountAuditRoutes } from "../verification/audit-routes.ts";
import type { RouteMounter } from "./route-mount.ts";
import type { ChatRuntime } from "./chat-contract.ts";
import type { ProjectContext } from "./project-loader.ts";
import { isolateHome } from "./test-home_test.ts";

// The control server builds the chat only when a provider key is configured,
// so this file gets a throwaway HOME with a dummy one rather than relying on
// the developer's real key (CI has none).
isolateHome({ anthropicApiKey: "sk-ant-test-not-a-real-key" });

async function makeProjectContext(): Promise<
  { ctx: ProjectContext; db: Database; dir: string }
> {
  const db = await Database.create({ driver: "pglite" });
  const kernel = new Kernel(db, { composition: testStoreComposition() });
  const dir = await Deno.makeTempDir({ prefix: "genie-composition-" });
  const now = new Date().toISOString();
  const ctx: ProjectContext = {
    entry: {
      path: dir,
      name: "composition",
      createdAt: now,
      lastOpenedAt: now,
    },
    kernel,
    db,
    appServer: { shutdown: async () => {} } as never,
    devServer: { shutdown: async () => {} } as never,
    commandRunner: { shutdown: async () => {} } as never,
    rebuild: () => {},
  };
  return { ctx, db, dir };
}

// A no-op ChatRuntime, standing in for the integrated agent.
class StubChat implements ChatRuntime {
  setOnTurnComplete(): void {}
  initialize(): Promise<void> {
    return Promise.resolve();
  }
  reloadApiKey(): Promise<void> {
    return Promise.resolve();
  }
  reloadModel(): Promise<void> {
    return Promise.resolve();
  }
  getInProgressState(): null {
    return null;
  }
  abort(): void {}
  sendMessage(): Promise<string> {
    return Promise.resolve("");
  }
  getCurrentSessionId(): string | null {
    return null;
  }
  clearCurrentSession(): void {}
  clearContext(): Promise<void> {
    return Promise.resolve();
  }
  clearSession(): Promise<{ newSessionId: string | null }> {
    return Promise.resolve({ newSessionId: null });
  }
  compactSession(): Promise<{ sessionId: string }> {
    return Promise.resolve({ sessionId: "s" });
  }
  resumeSession(): Promise<{ newSessionId: string }> {
    return Promise.resolve({ newSessionId: "s" });
  }
  close(): Promise<void> {
    return Promise.resolve();
  }
}

Deno.test({
  sanitizeResources: false,
  sanitizeOps: false,
  name: "core boots and serves REST with no agent and no API key",
  fn: async () => {
    const { ctx, db, dir } = await makeProjectContext();
    // No chatFactory, no ANTHROPIC key needed. devAccountAuth lets an
    // unauthenticated request through so we can assert the REST route serves.
    const control = await startControlServer(ctx, 0, {
      authProvider: new LocalAuthProvider(),
    });
    try {
      assertEquals(control.chat, null); // agent absent
      const base = `http://127.0.0.1:${control.server.addr.port}`;
      const res = await fetch(`${base}/api/chat/status`);
      assertEquals(res.status, 200); // REST still serves
      const body = await res.json();
      assertEquals(body.currentSessionId, null);
      assertEquals(body.inProgress, null);
    } finally {
      await control.server.shutdown();
      await db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  },
});

Deno.test({
  sanitizeResources: false,
  sanitizeOps: false,
  name: "chatFactory registers the agent provider",
  fn: async () => {
    const { ctx, db, dir } = await makeProjectContext();
    const stub = new StubChat();
    const control = await startControlServer(ctx, 0, {
      chatFactory: () => stub,
    });
    try {
      assertEquals(control.chat, stub); // provider adopted via the hook
      assert(control.chat !== null);
    } finally {
      await control.server.shutdown();
      await db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  },
});

// GET `path` against a fresh server assembled with `mounters`, returning the
// status — so a route is 404 without its mounter and 200 with it.
async function routeStatus(
  path: string,
  mounters: RouteMounter[],
): Promise<number> {
  const { ctx, db, dir } = await makeProjectContext();
  const control = await startControlServer(ctx, 0, {
    authProvider: new LocalAuthProvider(),
    mountRoutes: mounters,
  });
  try {
    const res = await fetch(
      `http://127.0.0.1:${control.server.addr.port}${path}`,
    );
    await res.body?.cancel();
    return res.status;
  } finally {
    await control.server.shutdown();
    await db.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

Deno.test({
  sanitizeResources: false,
  sanitizeOps: false,
  name: "verification routes are opt-in via the mountRoutes hook",
  fn: async () => {
    assertEquals(await routeStatus("/api/verification/overview", []), 404);
    assertEquals(
      await routeStatus("/api/verification/overview", [
        mountVerificationRoutes,
      ]),
      200,
    );
  },
});

Deno.test({
  sanitizeResources: false,
  sanitizeOps: false,
  name: "audit routes are opt-in via the mountRoutes hook",
  fn: async () => {
    assertEquals(await routeStatus("/api/audits", []), 404);
    assertEquals(await routeStatus("/api/audits", [mountAuditRoutes]), 200);
  },
});
