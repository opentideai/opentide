import { assert, assertEquals } from "@std/assert";
import {
  createDashboardApp,
  type DashboardSupervisor,
  ORCHESTRATOR_ROUTE_DEFS,
  orchestratorOpenApiSpec,
  type OrchestratorProjectView,
  type RegistryReader,
} from "./dashboard-server.ts";
import type { LogLine, RunningChild } from "./supervisor.ts";
import type { OrchestratorProjectRecord } from "./state.ts";
import type { ProjectEntry } from "../project-manager.ts";
import type { Result } from "../types.ts";

// --- Fakes -------------------------------------------------------------------

// A fake supervisor driven entirely from a fixed child table + programmable
// start/stop results, so the handlers are exercised via app.request without a real
// kernel, real children, or a real Deno.serve.
class FakeSupervisor implements DashboardSupervisor {
  private readonly childMap = new Map<string, RunningChild>();
  private readonly logMap = new Map<string, LogLine[]>();
  startResult: Result<RunningChild> | null = null;
  stopResult: Result<void> = { ok: true, data: undefined };
  restartResult: Result<RunningChild> | null = null;
  forgetThrows: string | null = null;
  startCalls: string[] = [];
  stopCalls: string[] = [];
  restartCalls: string[] = [];
  forgetCalls: string[] = [];

  setChild(child: RunningChild): void {
    this.childMap.set(child.record.projectPath, child);
  }

  setLogs(projectPath: string, lines: LogLine[]): void {
    this.logMap.set(projectPath, lines);
  }

  list(): RunningChild[] {
    return [...this.childMap.values()];
  }
  get(projectPath: string): RunningChild | null {
    return this.childMap.get(projectPath) ?? null;
  }
  logs(projectPath: string): LogLine[] {
    return this.logMap.get(projectPath) ?? [];
  }
  start(projectPath: string): Promise<Result<RunningChild>> {
    this.startCalls.push(projectPath);
    return Promise.resolve(
      this.startResult ??
        {
          ok: true,
          data: this.childMap.get(projectPath) ?? runningChild(projectPath),
        },
    );
  }
  stop(projectPath: string): Promise<Result<void>> {
    this.stopCalls.push(projectPath);
    return Promise.resolve(this.stopResult);
  }
  restart(projectPath: string): Promise<Result<RunningChild>> {
    this.restartCalls.push(projectPath);
    return Promise.resolve(
      this.restartResult ??
        {
          ok: true,
          data: this.childMap.get(projectPath) ?? runningChild(projectPath),
        },
    );
  }
  forgetStoppedProject(projectPath: string): Promise<boolean> {
    this.forgetCalls.push(projectPath);
    if (this.forgetThrows) return Promise.reject(new Error(this.forgetThrows));
    const child = this.childMap.get(projectPath);
    if (
      !child ||
      child.actualState !== "stopped" ||
      child.record.desiredState === "running"
    ) {
      return Promise.resolve(false);
    }
    this.childMap.delete(projectPath);
    return Promise.resolve(true);
  }
}

function record(
  projectPath: string,
  over: Partial<OrchestratorProjectRecord> = {},
): OrchestratorProjectRecord {
  return { projectPath, desiredState: "running", ...over };
}

function runningChild(
  projectPath: string,
  over: Partial<OrchestratorProjectRecord> = {},
): RunningChild {
  return {
    record: record(projectPath, {
      controlPort: 3101,
      lastStartedAt: "2026-07-26T10:22:03.000Z",
      lastKnownAppPort: 52189,
      ...over,
    }),
    actualState: "running",
    restartCount: 0,
  };
}

function registryOf(...entries: Array<[string, string]>): RegistryReader {
  return () =>
    entries.map(([path, name]): ProjectEntry => ({
      path,
      name,
      createdAt: "2026-07-01T00:00:00.000Z",
      lastOpenedAt: "2026-07-26T00:00:00.000Z",
    }));
}

function app(supervisor: DashboardSupervisor, listProjects: RegistryReader) {
  return createDashboardApp({ supervisor, listProjects });
}

async function views(res: Response): Promise<OrchestratorProjectView[]> {
  const body = await res.json();
  return body.projects as OrchestratorProjectView[];
}

// Non-empty index helper (noUncheckedIndexedAccess makes vs[0] possibly-undefined).
function first<T>(items: T[]): T {
  assert(items.length > 0, "expected at least one item");
  return items[0]!;
}

function postJson(projectPath: unknown): RequestInit {
  return {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ projectPath }),
  };
}

// --- GET /projects : the registry ⟕ supervisor join --------------------------

Deno.test("projects: registered-but-never-started ⇒ stopped, null ports, registry name", async () => {
  const sup = new FakeSupervisor();
  const res = await app(sup, registryOf(["/tmp/proj-a", "Project A"])).request(
    "/api/orchestrator/projects",
  );
  assertEquals(res.status, 200);
  const v = first(await views(res));
  assertEquals(v.name, "Project A");
  assertEquals(v.actualState, "stopped");
  assertEquals(v.desiredState, "stopped");
  assertEquals(v.controlPort, null);
  assertEquals(v.appPort, null);
  assertEquals(v.url, null);
  assertEquals(v.lastStartedAt, null);
  assertEquals(v.lastExit, null);
});

Deno.test("projects: a running child exposes controlPort, url, appPort", async () => {
  const sup = new FakeSupervisor();
  sup.setChild(runningChild("/tmp/proj-a"));
  const res = await app(sup, registryOf(["/tmp/proj-a", "Project A"])).request(
    "/api/orchestrator/projects",
  );
  const v = first(await views(res));
  assertEquals(v.actualState, "running");
  assertEquals(v.controlPort, 3101);
  assertEquals(v.url, "http://127.0.0.1:3101/");
  // appPort is display-only, sourced from lastKnownAppPort (§3.5).
  assertEquals(v.appPort, 52189);
});

Deno.test("projects: a non-running child nulls ports/url even with a persisted controlPort", async () => {
  const sup = new FakeSupervisor();
  sup.setChild({
    record: record("/tmp/proj-a", {
      desiredState: "running",
      controlPort: 3101,
      lastKnownAppPort: 52189,
    }),
    actualState: "crashed",
    restartCount: 1,
  });
  const res = await app(sup, registryOf(["/tmp/proj-a", "Project A"])).request(
    "/api/orchestrator/projects",
  );
  const v = first(await views(res));
  assertEquals(v.actualState, "crashed");
  assertEquals(v.controlPort, null);
  assertEquals(v.url, null);
  assertEquals(v.appPort, null); // display port gated on running
});

Deno.test("projects: an unregistered supervisor child is included with name = basename", async () => {
  const sup = new FakeSupervisor();
  sup.setChild(runningChild("/tmp/ghost-project"));
  // Empty registry — the child's path isn't known to project-manager.
  const res = await app(sup, registryOf()).request(
    "/api/orchestrator/projects",
  );
  const vs = await views(res);
  assertEquals(vs.length, 1);
  assertEquals(first(vs).name, "ghost-project");
  assertEquals(first(vs).actualState, "running");
});

Deno.test("projects: union is de-duped by path and sorted by name", async () => {
  const sup = new FakeSupervisor();
  sup.setChild(runningChild("/tmp/proj-a")); // also in the registry
  const res = await app(
    sup,
    registryOf(["/tmp/proj-a", "Zeta"], ["/tmp/proj-b", "Alpha"]),
  ).request("/api/orchestrator/projects");
  const vs = await views(res);
  assertEquals(vs.map((v) => v.name), ["Alpha", "Zeta"]);
  assertEquals(vs.length, 2); // proj-a not double-counted
});

// --- GET /status -------------------------------------------------------------

Deno.test("status: returns the same projection plus an updatedAt timestamp", async () => {
  const sup = new FakeSupervisor();
  sup.setChild(runningChild("/tmp/proj-a"));
  const res = await app(sup, registryOf(["/tmp/proj-a", "Project A"])).request(
    "/api/orchestrator/status",
  );
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body.projects.length, 1);
  assert(typeof body.updatedAt === "string" && body.updatedAt.length > 0);
});

// --- POST /start : the Result → HTTP mapping ---------------------------------

Deno.test("start: known project, ok result → 200 { project }", async () => {
  const sup = new FakeSupervisor();
  sup.setChild(runningChild("/tmp/proj-a"));
  const res = await app(sup, registryOf(["/tmp/proj-a", "Project A"])).request(
    "/api/orchestrator/start",
    postJson("/tmp/proj-a"),
  );
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body.project.name, "Project A");
  assertEquals(body.project.url, "http://127.0.0.1:3101/");
  assertEquals(sup.startCalls, ["/tmp/proj-a"]);
});

Deno.test("start: unknown project (not in registry, no child) → 404", async () => {
  const sup = new FakeSupervisor();
  const res = await app(sup, registryOf()).request(
    "/api/orchestrator/start",
    postJson("/tmp/nope"),
  );
  assertEquals(res.status, 404);
  assertEquals((await res.json()).error, "Unknown project");
  assertEquals(sup.startCalls, []); // never reached the supervisor
});

Deno.test("start: NO_FREE_PORT → 409", async () => {
  const sup = new FakeSupervisor();
  sup.startResult = {
    ok: false,
    error: { code: "NO_FREE_PORT", message: "No free control port available" },
  };
  const res = await app(sup, registryOf(["/tmp/proj-a", "A"])).request(
    "/api/orchestrator/start",
    postJson("/tmp/proj-a"),
  );
  assertEquals(res.status, 409);
  assertEquals((await res.json()).error, "No free control port available");
});

Deno.test("start: START_FAILED → 409", async () => {
  const sup = new FakeSupervisor();
  sup.startResult = {
    ok: false,
    error: { code: "START_FAILED", message: "failed to start after 3 retries" },
  };
  const res = await app(sup, registryOf(["/tmp/proj-a", "A"])).request(
    "/api/orchestrator/start",
    postJson("/tmp/proj-a"),
  );
  assertEquals(res.status, 409);
});

Deno.test("start: an unmapped ok:false code → 500", async () => {
  const sup = new FakeSupervisor();
  sup.startResult = {
    ok: false,
    error: { code: "SOMETHING_ELSE", message: "boom" },
  };
  const res = await app(sup, registryOf(["/tmp/proj-a", "A"])).request(
    "/api/orchestrator/start",
    postJson("/tmp/proj-a"),
  );
  assertEquals(res.status, 500);
});

Deno.test("start: missing/invalid projectPath → 400", async () => {
  const sup = new FakeSupervisor();
  const dashboard = app(sup, registryOf());
  const missing = await dashboard.request(
    "/api/orchestrator/start",
    postJson(undefined),
  );
  assertEquals(missing.status, 400);
  const notJson = await dashboard.request("/api/orchestrator/start", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "not json",
  });
  assertEquals(notJson.status, 400);
});

// --- POST /stop --------------------------------------------------------------

Deno.test("stop: known project → 200 { project }", async () => {
  const sup = new FakeSupervisor();
  sup.setChild({
    record: record("/tmp/proj-a", { desiredState: "stopped" }),
    actualState: "stopped",
    restartCount: 0,
  });
  const res = await app(sup, registryOf(["/tmp/proj-a", "Project A"])).request(
    "/api/orchestrator/stop",
    postJson("/tmp/proj-a"),
  );
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body.project.actualState, "stopped");
  assertEquals(body.project.controlPort, null);
  assertEquals(sup.stopCalls, ["/tmp/proj-a"]);
});

Deno.test("stop: unknown project → 404", async () => {
  const sup = new FakeSupervisor();
  const res = await app(sup, registryOf()).request(
    "/api/orchestrator/stop",
    postJson("/tmp/nope"),
  );
  assertEquals(res.status, 404);
  assertEquals(sup.stopCalls, []);
});

// --- POST /restart (B4c) -----------------------------------------------------

Deno.test("restart: known project, ok result → 200 { project }; supervisor.restart called", async () => {
  const sup = new FakeSupervisor();
  sup.setChild(runningChild("/tmp/proj-a"));
  const res = await app(sup, registryOf(["/tmp/proj-a", "Project A"])).request(
    "/api/orchestrator/restart",
    postJson("/tmp/proj-a"),
  );
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body.project.name, "Project A");
  assertEquals(sup.restartCalls, ["/tmp/proj-a"]);
});

Deno.test("restart: unknown project → 404 (never reaches the supervisor)", async () => {
  const sup = new FakeSupervisor();
  const res = await app(sup, registryOf()).request(
    "/api/orchestrator/restart",
    postJson("/tmp/nope"),
  );
  assertEquals(res.status, 404);
  assertEquals(sup.restartCalls, []);
});

Deno.test("restart: NO_FREE_PORT → 409", async () => {
  const sup = new FakeSupervisor();
  sup.restartResult = {
    ok: false,
    error: { code: "NO_FREE_PORT", message: "No free control port available" },
  };
  const res = await app(sup, registryOf(["/tmp/proj-a", "A"])).request(
    "/api/orchestrator/restart",
    postJson("/tmp/proj-a"),
  );
  assertEquals(res.status, 409);
});

Deno.test("restart: missing projectPath → 400", async () => {
  const sup = new FakeSupervisor();
  const res = await app(sup, registryOf()).request(
    "/api/orchestrator/restart",
    postJson(undefined),
  );
  assertEquals(res.status, 400);
  assertEquals(sup.restartCalls, []);
});

// --- GET /open : resolve-only ------------------------------------------------

Deno.test("open: a running child resolves { url, ready: true }", async () => {
  const sup = new FakeSupervisor();
  sup.setChild(runningChild("/tmp/proj-a"));
  const res = await app(sup, registryOf(["/tmp/proj-a", "A"])).request(
    "/api/orchestrator/open?projectPath=/tmp/proj-a",
  );
  assertEquals(res.status, 200);
  assertEquals(await res.json(), {
    url: "http://127.0.0.1:3101/",
    ready: true,
  });
});

Deno.test("open: a not-running project → 409 (never starts it)", async () => {
  const sup = new FakeSupervisor();
  sup.setChild({
    record: record("/tmp/proj-a", { controlPort: 3101 }),
    actualState: "starting",
    restartCount: 0,
  });
  const res = await app(sup, registryOf(["/tmp/proj-a", "A"])).request(
    "/api/orchestrator/open?projectPath=/tmp/proj-a",
  );
  assertEquals(res.status, 409);
  assertEquals((await res.json()).error, "Project not running");
});

Deno.test("open: an unknown project → 409 (not running)", async () => {
  const sup = new FakeSupervisor();
  const res = await app(sup, registryOf()).request(
    "/api/orchestrator/open?projectPath=/tmp/nope",
  );
  assertEquals(res.status, 409);
});

Deno.test("open: missing projectPath → 400", async () => {
  const sup = new FakeSupervisor();
  const res = await app(sup, registryOf()).request("/api/orchestrator/open");
  assertEquals(res.status, 400);
});

// --- GET /logs : buffered per-child log tail (B4b) ---------------------------

Deno.test("logs: a known project returns its buffered lines with shape { stream, text, at }", async () => {
  const sup = new FakeSupervisor();
  sup.setChild(runningChild("/tmp/proj-a"));
  sup.setLogs("/tmp/proj-a", [
    {
      stream: "stdout",
      text: "Kernel running.",
      at: "2026-07-26T10:00:00.000Z",
    },
    {
      stream: "stderr",
      text: "warn: slow query",
      at: "2026-07-26T10:00:01.000Z",
    },
  ]);
  const res = await app(sup, registryOf(["/tmp/proj-a", "A"])).request(
    "/api/orchestrator/logs?projectPath=/tmp/proj-a",
  );
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body.lines.length, 2);
  assertEquals(first(body.lines as LogLine[]).stream, "stdout");
  assertEquals((body.lines as LogLine[])[1]!.stream, "stderr");
  assertEquals((body.lines as LogLine[])[1]!.text, "warn: slow query");
});

Deno.test("logs: returned even when the child is NOT running (crash tail is the point)", async () => {
  const sup = new FakeSupervisor();
  sup.setChild({
    record: record("/tmp/proj-a", { desiredState: "running" }),
    actualState: "crashed",
    restartCount: 1,
  });
  sup.setLogs("/tmp/proj-a", [
    { stream: "stderr", text: "fatal: boom", at: "2026-07-26T10:00:02.000Z" },
  ]);
  const res = await app(sup, registryOf(["/tmp/proj-a", "A"])).request(
    "/api/orchestrator/logs?projectPath=/tmp/proj-a",
  );
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body.lines.length, 1);
  assertEquals(first(body.lines as LogLine[]).text, "fatal: boom");
});

Deno.test("logs: a registered-but-never-started project returns 200 with empty lines", async () => {
  const sup = new FakeSupervisor();
  const res = await app(sup, registryOf(["/tmp/proj-a", "A"])).request(
    "/api/orchestrator/logs?projectPath=/tmp/proj-a",
  );
  assertEquals(res.status, 200);
  assertEquals((await res.json()).lines, []);
});

Deno.test("logs: an unknown project (no registry entry, no child) → 404", async () => {
  const sup = new FakeSupervisor();
  const res = await app(sup, registryOf()).request(
    "/api/orchestrator/logs?projectPath=/tmp/nope",
  );
  assertEquals(res.status, 404);
  assertEquals((await res.json()).error, "Unknown project");
});

Deno.test("logs: missing projectPath → 400", async () => {
  const sup = new FakeSupervisor();
  const res = await app(sup, registryOf()).request("/api/orchestrator/logs");
  assertEquals(res.status, 400);
});

// --- POST /projects (create) + /projects/open : the write seam (B4a) ----------

// A recording fake for the project-manager write verbs, so a unit test drives the
// register endpoints WITHOUT touching the real ~/.config/opentide/registry.json. It
// either returns a ProjectEntry or throws the message the test programs.
class FakeRegistrar {
  projects: ProjectEntry[] = [];
  createCalls: Array<[string, string]> = [];
  openCalls: string[] = [];
  duplicateCalls: string[] = [];
  renameCalls: Array<[string, { name: string; folderName: string }]> = [];
  createThrows: string | null = null;
  openThrows: string | null = null;
  duplicateThrows: string | null = null;
  renameThrows: string | null = null;

  createProject = (dirPath: string, name: string): ProjectEntry => {
    this.createCalls.push([dirPath, name]);
    if (this.createThrows) throw new Error(this.createThrows);
    const entry = entryAt(`${dirPath}/${name.toLowerCase()}`, name);
    this.projects.unshift(entry);
    return entry;
  };
  openProject = (dirPath: string): ProjectEntry => {
    this.openCalls.push(dirPath);
    if (this.openThrows) throw new Error(this.openThrows);
    const entry = entryAt(dirPath, dirPath.split("/").pop() ?? dirPath);
    this.projects.unshift(entry);
    return entry;
  };
  duplicateProject = (dirPath: string): ProjectEntry => {
    this.duplicateCalls.push(dirPath);
    if (this.duplicateThrows) throw new Error(this.duplicateThrows);
    const source = this.projects.find((p) => p.path === dirPath);
    const entry = entryAt(
      `${dirPath}-copy`,
      `${source?.name ?? "Project"} Copy 1`,
    );
    this.projects.unshift(entry);
    return entry;
  };
  renameProject = (
    dirPath: string,
    options: { name: string; folderName: string },
  ): ProjectEntry => {
    this.renameCalls.push([dirPath, options]);
    if (this.renameThrows) throw new Error(this.renameThrows);
    const parent = dirPath.slice(0, dirPath.lastIndexOf("/")) || "/";
    const entry = entryAt(`${parent}/${options.folderName}`, options.name);
    this.projects = this.projects.filter((p) => p.path !== dirPath);
    this.projects.unshift(entry);
    return entry;
  };
  listProjects = (): ProjectEntry[] => this.projects;
}

function entryAt(path: string, name: string): ProjectEntry {
  return {
    path,
    name,
    createdAt: "2026-07-26T00:00:00.000Z",
    lastOpenedAt: "2026-07-26T00:00:00.000Z",
  };
}

// Build a dashboard with the write seam injected (registry read left empty — the
// register response falls back to basename, and the real verbs are never wired).
function appWithRegistrar(reg: FakeRegistrar) {
  return createDashboardApp({
    supervisor: new FakeSupervisor(),
    listProjects: reg.listProjects,
    createProject: reg.createProject,
    openProject: reg.openProject,
    duplicateProject: reg.duplicateProject,
    renameProject: reg.renameProject,
  });
}

function postBody(body: unknown): RequestInit {
  return {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  };
}

Deno.test("create: ok → 200 { project } stopped, null ports; injected verb called; real untouched", async () => {
  const reg = new FakeRegistrar();
  const res = await appWithRegistrar(reg).request(
    "/api/orchestrator/projects",
    postBody({ name: "My App", path: "/tmp/parent" }),
  );
  assertEquals(res.status, 200);
  const body = await res.json();
  const v = body.project as OrchestratorProjectView;
  assertEquals(v.actualState, "stopped");
  assertEquals(v.desiredState, "stopped");
  assertEquals(v.controlPort, null);
  assertEquals(v.url, null);
  // The dashboard projected project-manager's verb — with the trimmed name — and
  // never the real registry (only the fake recorded a call).
  assertEquals(reg.createCalls, [["/tmp/parent", "My App"]]);
  assertEquals(reg.openCalls, []);
});

Deno.test("create: an existing project (throws 'already exists') → 409", async () => {
  const reg = new FakeRegistrar();
  reg.createThrows = "An OpenTide project already exists at /tmp/parent/my-app";
  const res = await appWithRegistrar(reg).request(
    "/api/orchestrator/projects",
    postBody({ name: "My App", path: "/tmp/parent" }),
  );
  assertEquals(res.status, 409);
  assert((await res.json()).error.includes("already exists"));
});

Deno.test("create: an unexpected throw → 500", async () => {
  const reg = new FakeRegistrar();
  reg.createThrows = "disk on fire";
  const res = await appWithRegistrar(reg).request(
    "/api/orchestrator/projects",
    postBody({ name: "My App", path: "/tmp/parent" }),
  );
  assertEquals(res.status, 500);
});

Deno.test("create: missing name or path → 400 (never reaches the registrar)", async () => {
  const reg = new FakeRegistrar();
  const dashboard = appWithRegistrar(reg);
  const noName = await dashboard.request(
    "/api/orchestrator/projects",
    postBody({ path: "/tmp/parent" }),
  );
  assertEquals(noName.status, 400);
  const noPath = await dashboard.request(
    "/api/orchestrator/projects",
    postBody({ name: "My App" }),
  );
  assertEquals(noPath.status, 400);
  const notJson = await dashboard.request("/api/orchestrator/projects", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "not json",
  });
  assertEquals(notJson.status, 400);
  assertEquals(reg.createCalls, []);
});

Deno.test("open existing: ok → 200 { project } stopped; injected verb called", async () => {
  const reg = new FakeRegistrar();
  const res = await appWithRegistrar(reg).request(
    "/api/orchestrator/projects/open",
    postBody({ path: "/tmp/existing-proj" }),
  );
  assertEquals(res.status, 200);
  const v = (await res.json()).project as OrchestratorProjectView;
  assertEquals(v.actualState, "stopped");
  assertEquals(v.controlPort, null);
  assertEquals(reg.openCalls, ["/tmp/existing-proj"]);
  assertEquals(reg.createCalls, []);
});

Deno.test("open existing: no project found → 409", async () => {
  const reg = new FakeRegistrar();
  reg.openThrows = "No OpenTide project found at /tmp/nope";
  const res = await appWithRegistrar(reg).request(
    "/api/orchestrator/projects/open",
    postBody({ path: "/tmp/nope" }),
  );
  assertEquals(res.status, 409);
});

Deno.test("open existing: corrupt manifest → 409", async () => {
  const reg = new FakeRegistrar();
  reg.openThrows = "Corrupt project manifest (opentide.json) at /tmp/bad";
  const res = await appWithRegistrar(reg).request(
    "/api/orchestrator/projects/open",
    postBody({ path: "/tmp/bad" }),
  );
  assertEquals(res.status, 409);
});

Deno.test("open existing: missing path → 400 (never reaches the registrar)", async () => {
  const reg = new FakeRegistrar();
  const res = await appWithRegistrar(reg).request(
    "/api/orchestrator/projects/open",
    postBody({}),
  );
  assertEquals(res.status, 400);
  assertEquals(reg.openCalls, []);
});

// --- POST /projects/duplicate + /projects/rename ----------------------------

function appWithProjectOps(
  reg: FakeRegistrar,
  supervisor = new FakeSupervisor(),
) {
  return createDashboardApp({
    supervisor,
    listProjects: reg.listProjects,
    createProject: reg.createProject,
    openProject: reg.openProject,
    duplicateProject: reg.duplicateProject,
    renameProject: reg.renameProject,
  });
}

Deno.test("duplicate project: ok → 200 { project } stopped; injected verb called", async () => {
  const reg = new FakeRegistrar();
  reg.projects = [entryAt("/tmp/proj-a", "Project A")];
  const res = await appWithProjectOps(reg).request(
    "/api/orchestrator/projects/duplicate",
    postBody({ projectPath: "/tmp/proj-a" }),
  );
  assertEquals(res.status, 200);
  const v = (await res.json()).project as OrchestratorProjectView;
  assertEquals(v.projectPath, "/tmp/proj-a-copy");
  assertEquals(v.name, "Project A Copy 1");
  assertEquals(v.actualState, "stopped");
  assertEquals(v.desiredState, "stopped");
  assertEquals(v.controlPort, null);
  assertEquals(reg.duplicateCalls, ["/tmp/proj-a"]);
});

Deno.test("rename project: ok → 200 { project } renamed stopped view", async () => {
  const reg = new FakeRegistrar();
  reg.projects = [entryAt("/tmp/proj-a", "Project A")];
  const res = await appWithProjectOps(reg).request(
    "/api/orchestrator/projects/rename",
    postBody({
      projectPath: "/tmp/proj-a",
      name: "Project Renamed",
      folderName: "proj-renamed",
    }),
  );
  assertEquals(res.status, 200);
  const v = (await res.json()).project as OrchestratorProjectView;
  assertEquals(v.projectPath, "/tmp/proj-renamed");
  assertEquals(v.name, "Project Renamed");
  assertEquals(v.actualState, "stopped");
  assertEquals(v.controlPort, null);
  assertEquals(reg.renameCalls, [[
    "/tmp/proj-a",
    { name: "Project Renamed", folderName: "proj-renamed" },
  ]]);
});

Deno.test("duplicate/rename project: missing or invalid bodies → 400", async () => {
  const reg = new FakeRegistrar();
  reg.projects = [entryAt("/tmp/proj-a", "Project A")];
  const dashboard = appWithProjectOps(reg);
  const duplicateMissing = await dashboard.request(
    "/api/orchestrator/projects/duplicate",
    postBody({}),
  );
  assertEquals(duplicateMissing.status, 400);
  const duplicateInvalidJson = await dashboard.request(
    "/api/orchestrator/projects/duplicate",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "not json",
    },
  );
  assertEquals(duplicateInvalidJson.status, 400);
  const renameMissingName = await dashboard.request(
    "/api/orchestrator/projects/rename",
    postBody({ projectPath: "/tmp/proj-a", folderName: "proj-renamed" }),
  );
  assertEquals(renameMissingName.status, 400);
  const renameInvalidJson = await dashboard.request(
    "/api/orchestrator/projects/rename",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "not json",
    },
  );
  assertEquals(renameInvalidJson.status, 400);
  assertEquals(reg.duplicateCalls, []);
  assertEquals(reg.renameCalls, []);
});

Deno.test("duplicate/rename project: unknown project → 404", async () => {
  const reg = new FakeRegistrar();
  const dashboard = appWithProjectOps(reg);
  const duplicate = await dashboard.request(
    "/api/orchestrator/projects/duplicate",
    postBody({ projectPath: "/tmp/nope" }),
  );
  assertEquals(duplicate.status, 404);
  const rename = await dashboard.request(
    "/api/orchestrator/projects/rename",
    postBody({ projectPath: "/tmp/nope", name: "Nope", folderName: "nope" }),
  );
  assertEquals(rename.status, 404);
  assertEquals(reg.duplicateCalls, []);
  assertEquals(reg.renameCalls, []);
});

Deno.test("duplicate/rename project: active or desired-running rows → 409", async () => {
  for (
    const [actualState, desiredState] of [
      ["running", "running"],
      ["running", "stopped"],
      ["starting", "stopped"],
      ["crashed", "stopped"],
      ["failed", "stopped"],
      ["stopped", "running"],
    ] as const
  ) {
    const reg = new FakeRegistrar();
    reg.projects = [entryAt("/tmp/proj-a", "Project A")];
    const sup = new FakeSupervisor();
    sup.setChild({
      record: record("/tmp/proj-a", { desiredState }),
      actualState,
      restartCount: 0,
    });
    const dashboard = appWithProjectOps(reg, sup);
    const duplicate = await dashboard.request(
      "/api/orchestrator/projects/duplicate",
      postBody({ projectPath: "/tmp/proj-a" }),
    );
    assertEquals(duplicate.status, 409);
    const rename = await dashboard.request(
      "/api/orchestrator/projects/rename",
      postBody({
        projectPath: "/tmp/proj-a",
        name: "Renamed",
        folderName: "renamed",
      }),
    );
    assertEquals(rename.status, 409);
    assertEquals(reg.duplicateCalls, []);
    assertEquals(reg.renameCalls, []);
  }
});

Deno.test("rename project: clears old stopped supervisor state", async () => {
  const reg = new FakeRegistrar();
  reg.projects = [entryAt("/tmp/proj-a", "Project A")];
  const sup = new FakeSupervisor();
  sup.setChild({
    record: record("/tmp/proj-a", { desiredState: "stopped" }),
    actualState: "stopped",
    restartCount: 0,
  });
  const dashboard = appWithProjectOps(reg, sup);
  const res = await dashboard.request(
    "/api/orchestrator/projects/rename",
    postBody({
      projectPath: "/tmp/proj-a",
      name: "Project B",
      folderName: "proj-b",
    }),
  );
  assertEquals(res.status, 200);
  assertEquals(sup.forgetCalls, ["/tmp/proj-a"]);

  const list = await dashboard.request("/api/orchestrator/projects");
  const projectViews = await views(list);
  assertEquals(projectViews.map((v) => v.projectPath), ["/tmp/proj-b"]);
});

Deno.test("rename project: stopped-state cleanup failure does not commit rename", async () => {
  const reg = new FakeRegistrar();
  reg.projects = [entryAt("/tmp/proj-a", "Project A")];
  const sup = new FakeSupervisor();
  sup.forgetThrows = "state write failed";
  sup.setChild({
    record: record("/tmp/proj-a", { desiredState: "stopped" }),
    actualState: "stopped",
    restartCount: 0,
  });
  const res = await appWithProjectOps(reg, sup).request(
    "/api/orchestrator/projects/rename",
    postBody({
      projectPath: "/tmp/proj-a",
      name: "Project B",
      folderName: "proj-b",
    }),
  );
  assertEquals(res.status, 500);
  assertEquals(sup.forgetCalls, ["/tmp/proj-a"]);
  assertEquals(reg.renameCalls, []);
  assertEquals(reg.projects.map((p) => p.path), ["/tmp/proj-a"]);
});

// --- /api/fs/* browse endpoints (mounted for FolderPicker, B4a) ---------------

Deno.test("fs/list: lists a HOME-scoped directory (dirs first)", async () => {
  const dir = await Deno.makeTempDir({ prefix: "orch-fs-" });
  const prev = Deno.env.get("HOME");
  Deno.env.set("HOME", dir);
  try {
    await Deno.mkdir(`${dir}/sub`);
    await Deno.writeTextFile(`${dir}/file.txt`, "x");
    const res = await app(new FakeSupervisor(), registryOf()).request(
      `/api/fs/list?path=${encodeURIComponent(dir)}`,
    );
    assertEquals(res.status, 200);
    const body = await res.json();
    assertEquals(body.entries[0], { name: "sub", isDir: true });
    assert(body.entries.some((e: { name: string }) => e.name === "file.txt"));
  } finally {
    if (prev !== undefined) Deno.env.set("HOME", prev);
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("fs/mkdir: missing path → 400", async () => {
  const res = await app(new FakeSupervisor(), registryOf()).request(
    "/api/fs/mkdir",
    postBody({}),
  );
  assertEquals(res.status, 400);
});

// --- RouteSchema attachment (structural "no schema, no route") ----------------

Deno.test("every dashboard route carries a RouteSchema, and the OpenAPI projection consumes them", () => {
  assert(ORCHESTRATOR_ROUTE_DEFS.length === 11);
  for (const def of ORCHESTRATOR_ROUTE_DEFS) {
    assert(def.schema, `${def.method} ${def.path} has no schema`);
    assert(def.schema.summary, `${def.method} ${def.path} has no summary`);
  }
  const spec = orchestratorOpenApiSpec();
  const paths = spec.paths as Record<string, unknown>;
  assert(paths["/api/orchestrator/projects"]);
  assert(paths["/api/orchestrator/projects/open"]);
  assert(paths["/api/orchestrator/projects/duplicate"]);
  assert(paths["/api/orchestrator/projects/rename"]);
  assert(paths["/api/orchestrator/open"]);
  assert(paths["/api/orchestrator/logs"]);
  assert(paths["/api/orchestrator/restart"]);
});

Deno.test("openapi endpoint serves the projected spec", async () => {
  const sup = new FakeSupervisor();
  const res = await app(sup, registryOf()).request("/api/orchestrator/openapi");
  assertEquals(res.status, 200);
  const spec = await res.json();
  assertEquals(spec.info.title, "Genie Orchestrator Dashboard");
});

// --- Static UI mount (B3b): serve the built bundle + / → /projects redirect -----

// A minimal built-IDE bundle: index.html (the SPA fallback) + projects.html (the
// prerendered dashboard route), enough to exercise the static handler + redirect.
async function fakeBundle(): Promise<string> {
  const dir = await Deno.makeTempDir({ prefix: "orch-ui-" });
  await Deno.writeTextFile(
    `${dir}/index.html`,
    "<!doctype html><title>SPA</title>",
  );
  await Deno.writeTextFile(
    `${dir}/projects.html`,
    "<!doctype html><title>Dashboard</title>",
  );
  return dir;
}

Deno.test("static: with staticUiDir, GET / redirects to /projects", async () => {
  const dir = await fakeBundle();
  try {
    const dashboard = createDashboardApp(
      { supervisor: new FakeSupervisor(), listProjects: registryOf() },
      { staticUiDir: dir },
    );
    const res = await dashboard.request("/", { redirect: "manual" });
    assertEquals(res.status, 302);
    assertEquals(res.headers.get("location"), "/projects");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("static: /projects serves the SPA fallback (index.html)", async () => {
  const dir = await fakeBundle();
  try {
    const dashboard = createDashboardApp(
      { supervisor: new FakeSupervisor(), listProjects: registryOf() },
      { staticUiDir: dir },
    );
    // Extension-less route → SPA fallback (index.html), so the SvelteKit client
    // router resolves /projects and renders the dashboard component.
    const res = await dashboard.request("/projects");
    assertEquals(res.status, 200);
    assert((await res.text()).includes("SPA"));
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("static: an /api/orchestrator/* route still wins over the catch-all", async () => {
  const dir = await fakeBundle();
  try {
    const sup = new FakeSupervisor();
    sup.setChild(runningChild("/tmp/proj-a"));
    const dashboard = createDashboardApp(
      {
        supervisor: sup,
        listProjects: registryOf(["/tmp/proj-a", "Project A"]),
      },
      { staticUiDir: dir },
    );
    // The API route resolves to JSON, NOT the static bundle.
    const res = await dashboard.request("/api/orchestrator/status");
    assertEquals(res.status, 200);
    const body = await res.json();
    assertEquals(body.projects.length, 1);
    // A reserved /api path with no matching route is NOT served the SPA fallback.
    const miss = await dashboard.request("/api/nope");
    assertEquals(miss.status, 404);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("static: without staticUiDir the app is API-only (no / redirect)", async () => {
  const dashboard = createDashboardApp({
    supervisor: new FakeSupervisor(),
    listProjects: registryOf(),
  });
  const res = await dashboard.request("/", { redirect: "manual" });
  assertEquals(res.status, 404); // no static mount, no redirect
});
