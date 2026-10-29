import { assert, assertEquals } from "@std/assert";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { initCompiler, stopCompiler } from "./compiler.ts";
import { startControlServer } from "./control-server.ts";
import { createProject } from "./project-manager.ts";
import { unloadProject } from "./project-loader.ts";
import { isProjectLockHeld, readLockHolder } from "./project-lock.ts";
import { takeoverCandidate, takeOverProject } from "./project-handover.ts";
import { testComposition } from "../cli/test-composition.ts";
import { isolateHome } from "./test-home_test.ts";

isolateHome();

const testOpts = { sanitizeResources: false, sanitizeOps: false };

function tempProject(name: string): { dir: string; cleanup: () => void } {
  const parent = mkdtempSync(join(tmpdir(), "genie-handover-"));
  return {
    dir: createProject(parent, name).path,
    cleanup: () => rmSync(parent, { recursive: true, force: true }),
  };
}

// A single-project serve, as `opentide serve --project` runs one.
async function serveHolding(dir: string, onRelease?: () => void) {
  const control = await startControlServer(null, 0, {
    composition: testComposition(),
    projectAppPort: 0,
    ...(onRelease ? { onRelease } : {}),
  });
  await control.setProject.open(dir);
  return control;
}

async function stop(control: Awaited<ReturnType<typeof serveHolding>>) {
  const ctx = control.setProject.current();
  if (ctx) await unloadProject(ctx);
  await control.server.shutdown();
}

async function postOpen(port: number, body: Record<string, unknown>) {
  const res = await fetch(`http://127.0.0.1:${port}/api/projects/open`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

Deno.test(
  "a serve hands its project over and says it's done",
  testOpts,
  async () => {
    await initCompiler();
    const p = tempProject("Handover");
    let released = 0;
    const holder = await serveHolding(p.dir, () => released++);
    try {
      assertEquals(readLockHolder(p.dir)?.handover, true);
      assertEquals(takeoverCandidate(p.dir)?.pid, Deno.pid);

      const taken = await takeOverProject(p.dir);
      assert(taken.ok, taken.ok ? "" : taken.error.message);
      assert(!isProjectLockHeld(p.dir));
      assertEquals(holder.setProject.current(), null);
      await new Promise((r) => setTimeout(r, 20));
      assertEquals(released, 1);
    } finally {
      await stop(holder);
      stopCompiler();
      p.cleanup();
    }
  },
);

Deno.test(
  "a serve keeps its project while a change is in progress",
  testOpts,
  async () => {
    await initCompiler();
    const p = tempProject("Handover Busy");
    let released = 0;
    const holder = await serveHolding(p.dir, () => released++);
    try {
      holder.setProject.current()!.kernel.activeChangesetId = () =>
        Promise.resolve("cs_busy");
      const taken = await takeOverProject(p.dir);
      assert(!taken.ok);
      assertEquals(taken.error.code, "CHANGESET_ACTIVE");
      assert(isProjectLockHeld(p.dir));
      assertEquals(released, 0);
    } finally {
      await stop(holder);
      stopCompiler();
      p.cleanup();
    }
  },
);

Deno.test(
  "a launcher-mode kernel isn't offered for takeover and refuses a release",
  testOpts,
  async () => {
    await initCompiler();
    const p = tempProject("Handover Launcher");
    const holder = await serveHolding(p.dir);
    try {
      assertEquals(readLockHolder(p.dir)?.handover, undefined);
      assertEquals(takeoverCandidate(p.dir), null);
      const taken = await takeOverProject(p.dir);
      assert(!taken.ok);
      assertEquals(taken.error.code, "TAKEOVER_UNSUPPORTED");

      // Asking directly doesn't work either, token or not.
      const res = await fetch(
        `http://127.0.0.1:${holder.server.addr.port}/api/projects/release`,
        { method: "POST" },
      );
      assertEquals(res.status, 409);
      await res.body?.cancel();
      assert(isProjectLockHeld(p.dir));
    } finally {
      await stop(holder);
      stopCompiler();
      p.cleanup();
    }
  },
);

Deno.test(
  "a release without the project's token is refused",
  testOpts,
  async () => {
    await initCompiler();
    const p = tempProject("Handover Token");
    const holder = await serveHolding(p.dir, () => {});
    try {
      const res = await fetch(
        `http://127.0.0.1:${holder.server.addr.port}/api/projects/release`,
        { method: "POST", headers: { Authorization: "Bearer nope" } },
      );
      assertEquals(res.status, 401);
      await res.body?.cancel();
      assert(isProjectLockHeld(p.dir));
    } finally {
      await stop(holder);
      stopCompiler();
      p.cleanup();
    }
  },
);

Deno.test(
  "opening a held project offers a takeover without closing what's open",
  testOpts,
  async () => {
    await initCompiler();
    const held = tempProject("Held");
    const mine = tempProject("Mine");
    const holder = await serveHolding(held.dir, () => {});
    const tide = await serveHolding(mine.dir);
    try {
      const refused = await postOpen(tide.server.addr.port, { path: held.dir });
      assertEquals(refused.status, 409);
      assertEquals(refused.body.code, "PROJECT_ALREADY_OPEN");
      assertEquals(refused.body.takeover.pid, Deno.pid);
      assertEquals(tide.setProject.current()?.entry.path, mine.dir);

      const taken = await postOpen(tide.server.addr.port, {
        path: held.dir,
        takeOver: true,
      });
      assertEquals(taken.status, 200);
      assertEquals(tide.setProject.current()?.entry.path, held.dir);
      assertEquals(holder.setProject.current(), null);
      assertEquals(
        readLockHolder(held.dir)?.controlPort,
        tide.server.addr.port,
      );
    } finally {
      await stop(tide);
      await stop(holder);
      stopCompiler();
      held.cleanup();
      mine.cleanup();
    }
  },
);
