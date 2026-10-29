// Slice A gate (OpenTide §3.3): the core boots and serves REST with no agent and
// no API key. The chat agent is its own process (cli/agent-main.ts); serve has
// no chat socket at all.
import { assertEquals } from "@std/assert";
import { rmSync } from "node:fs";
import { Database } from "./db.ts";
import { Kernel } from "./registries.ts";
import { LocalAuthProvider } from "./auth-provider.ts";
import { startControlServer } from "./control-server.ts";
import { testStoreComposition } from "../verification/test-stores.ts";
import { mountVerificationRoutes } from "../verification/verification-routes.ts";
import { mountAuditRoutes } from "../verification/audit-routes.ts";
import type { RouteMounter } from "./route-mount.ts";
import type { ProjectContext } from "./project-loader.ts";
import { isolateHome } from "./test-home_test.ts";

// A throwaway HOME with a dummy key: a key must change nothing about what
// serve offers.
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

Deno.test({
  sanitizeResources: false,
  sanitizeOps: false,
  name: "core boots and serves REST with no agent and no API key",
  fn: async () => {
    const { ctx, db, dir } = await makeProjectContext();
    // devAccountAuth lets an unauthenticated request through so we can assert
    // the REST route serves.
    const control = await startControlServer(ctx, 0, {
      authProvider: new LocalAuthProvider(),
    });
    try {
      const base = `http://127.0.0.1:${control.server.addr.port}`;
      const res = await fetch(`${base}/api/status`);
      assertEquals(res.status, 200);
      await res.body?.cancel();
      // The chat belongs to the agent process.
      const chat = await fetch(`${base}/api/chat/status`);
      assertEquals(chat.status, 404);
      await chat.body?.cancel();
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
