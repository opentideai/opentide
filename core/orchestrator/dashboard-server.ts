// @layer core — the orchestrator's dashboard HTTP API (Feature B / B3a).
//
// The orchestrator's FIRST HTTP surface. A standalone Hono app that projects the
// B1b Supervisor (§6.2) — joined with the project registry for the display `name`
// — onto the §9 dashboard endpoints. It is a THIN projection: no supervision
// logic lives here (spawn/handshake/reconcile all stay in supervisor.ts); the
// handlers only read list()/get() and drive start()/stop().
//
// It does NOT reuse startControlServer — that server holds a per-project `ctx` and
// loads exactly one project; the orchestrator loads NONE. This is a fresh Hono app
// bound loopback-only (DEV_SERVER_HOST) on ORCHESTRATOR_DASHBOARD_PORT: it exposes
// start/stop of arbitrary local projects and MUST never be LAN-reachable.
//
// Being internal control-plane consumed only by the first-party IDE, it uses the
// terser { error } convention (CLAUDE.md), NOT the user-app { error, code, message }.
//
// RouteSchema note: RouteSchema (core/types.ts) is consumed by the KERNEL route
// registry + OpenAPI generation; a kernel-less standalone Hono app has no registry
// to auto-validate against (the closest precedent — control-server.ts's internal
// :3003 API — attaches no RouteSchema at all). So we honor the project's
// "no schema, no route" rule STRUCTURALLY: every route is a RouteDef whose `schema`
// field is required (you cannot add a route without one), and the schemas are made
// non-decorative by GET /api/orchestrator/openapi, which projects them through the
// existing generateOpenAPISpec (core/openapi.ts). See docs/orchestrator-design.md §9.

import { basename, resolve } from "node:path";
import { type Context, Hono } from "hono";
import type { Result, RouteEntry, RouteSchema } from "../types.ts";
import { generateOpenAPISpec } from "../openapi.ts";
import { DEV_SERVER_HOST, ORCHESTRATOR_DASHBOARD_PORT } from "../config.ts";
import {
  createProject as pmCreateProject,
  duplicateProject as pmDuplicateProject,
  listProjects,
  openProject as pmOpenProject,
  type ProjectEntry,
  renameProject as pmRenameProject,
} from "../project-manager.ts";
import { serveDashboardStaticUi } from "./static-ui.ts";
import { handleFsList, handleFsMkdir } from "./fs-browse.ts";
import type {
  ActualState,
  LogLine,
  RunningChild,
  Supervisor,
} from "./supervisor.ts";
import type { ChildExit, DesiredState } from "./state.ts";

// The dashboard's own page: the orchestrator bundle's root route ("/") is the
// per-project IDE, which expects a kernel that :3100 does not have — so the root is
// redirected here, and this is where the repurposed picker (B3b) renders. Kept as a
// named constant (no magic strings, CLAUDE.md).
const DASHBOARD_HOME_PATH = "/projects";

// The §9 dashboard view of one project: the registry⟕supervisor join. Ports and
// url are non-null only while the child is running (routing key = control port,
// decision #6); appPort is display-only + non-authoritative (§3.5).
export interface OrchestratorProjectView {
  projectPath: string;
  name: string; // from the project registry (project-manager), basename if unregistered
  desiredState: DesiredState; // "running" | "stopped"
  actualState: ActualState; // "stopped"|"starting"|"running"|"crashed"|"failed"
  controlPort: number | null; // routing key when running, else null
  appPort: number | null; // display-only, non-authoritative (§3.5)
  url: string | null; // resolved child URL when running (host:controlPort), else null
  lastStartedAt: string | null;
  lastExit: ChildExit | null;
}

// The registry read side the join needs. Defaults to project-manager's listProjects
// (all known projects + their display name); injected in tests + the live seam.
export type RegistryReader = () => ProjectEntry[];

// The registry WRITE side (B4a): the two project-manager verbs the dashboard's
// New/Open forms project. `createProject(dirPath, name)` makes + registers a fresh
// project dir; `openProject(dirPath)` registers an already-existing one. Both THROW
// (not Result<T>) — createProject on an existing project, openProject on a missing
// or corrupt manifest — mapped to HTTP in handleCreate/handleOpenExisting.
export type ProjectCreator = (dirPath: string, name: string) => ProjectEntry;
export type ProjectOpener = (dirPath: string) => ProjectEntry;
export type ProjectDuplicator = (dirPath: string) => ProjectEntry;
export type ProjectRenamer = (
  dirPath: string,
  options: { name: string; folderName: string },
) => ProjectEntry;

// Only the Supervisor surface the dashboard consumes — a thin read/drive facade, so
// a test fake implements just these members.
export type DashboardSupervisor = Pick<
  Supervisor,
  | "list"
  | "get"
  | "start"
  | "stop"
  | "logs"
  | "restart"
  | "forgetStoppedProject"
>;

export interface DashboardDeps {
  supervisor: DashboardSupervisor;
  listProjects: RegistryReader;
  // The registry write seam (B4a). Injected as fakes in tests so a unit test never
  // touches the real ~/.config/opentide/registry.json; default to project-manager's
  // real verbs in createDashboardApp. Mirrors the RegistryReader read seam above.
  createProject?: ProjectCreator;
  openProject?: ProjectOpener;
  duplicateProject?: ProjectDuplicator;
  renameProject?: ProjectRenamer;
}

// DashboardDeps with the write seam resolved to its defaults, so the register
// handlers hold non-optional refs (createDashboardApp fills the defaults once).
interface ResolvedDeps extends DashboardDeps {
  createProject: ProjectCreator;
  openProject: ProjectOpener;
  duplicateProject: ProjectDuplicator;
  renameProject: ProjectRenamer;
}

// --- Result → HTTP status mapping (centralized) ------------------------------

// The handler synthesizes this code for a project absent from the registry; the
// supervisor never emits it (its start() adopts any path). Mapped to 404 below.
const UNKNOWN_PROJECT_CODE = "UNKNOWN_PROJECT";

// The supervisor's start() ok:false codes (settleFail in supervisor.ts): a fully
// occupied control-port range, or start retries exhausted. Both are "can't place
// the child right now" → 409, like a data-dir lock contention. stop() never errors.
const CONFLICT_CODES = new Set(["NO_FREE_PORT", "START_FAILED"]);

// Centralized Result<T> → HTTP status: unknown-project → 404, lock/placement
// contention → 409, any other ok:false → 500. ok:true is 200 at the call site.
// The literal union keeps c.json's ContentfulStatusCode happy.
function errorStatus(code: string): 404 | 409 | 500 {
  if (code === UNKNOWN_PROJECT_CODE) return 404;
  if (CONFLICT_CODES.has(code)) return 409;
  return 500;
}

// The { error } control-plane error envelope at the mapped status.
function errorResponse(c: Context, code: string, message: string): Response {
  return c.json({ error: message }, errorStatus(code));
}

// --- The registry ⟕ supervisor join ------------------------------------------

// Build the {absPath → name} map from the registry once per request.
function registryNames(deps: DashboardDeps): Map<string, string> {
  const map = new Map<string, string>();
  for (const p of deps.listProjects()) map.set(resolve(p.path), p.name);
  return map;
}

// Project one (path, name, child?) triple into the §9 view. A registered-but-never
// -started project (child = null) is stopped with null ports. An unregistered
// supervisor child (edge case) is included with name = basename(path).
function toView(
  projectPath: string,
  name: string,
  child: RunningChild | null,
): OrchestratorProjectView {
  if (!child) {
    return {
      projectPath,
      name,
      desiredState: "stopped",
      actualState: "stopped",
      controlPort: null,
      appPort: null,
      url: null,
      lastStartedAt: null,
      lastExit: null,
    };
  }
  const { record, actualState } = child;
  const running = actualState === "running";
  // Ports + url are meaningful only while running (decision #6: url = control port,
  // no proxy). appPort is advisory display data (§3.5) and equally gated on running.
  const controlPort = running ? record.controlPort ?? null : null;
  return {
    projectPath,
    name,
    desiredState: record.desiredState,
    actualState,
    controlPort,
    appPort: running ? record.lastKnownAppPort ?? null : null,
    url: controlPort !== null
      ? `http://${DEV_SERVER_HOST}:${controlPort}/`
      : null,
    lastStartedAt: record.lastStartedAt ?? null,
    lastExit: record.lastExit ?? null,
  };
}

// The full dashboard list: the UNION of registry projects and supervisor children,
// keyed by absolute path, each projected via toView. Sorted by name then path so
// the dashboard order is stable across polls.
function buildViews(deps: DashboardDeps): OrchestratorProjectView[] {
  const names = registryNames(deps);
  const childByPath = new Map<string, RunningChild>();
  for (const child of deps.supervisor.list()) {
    childByPath.set(resolve(child.record.projectPath), child);
  }
  const paths = new Set<string>([...names.keys(), ...childByPath.keys()]);
  const views = [...paths].map((path) =>
    toView(
      path,
      names.get(path) ?? basename(path),
      childByPath.get(path) ?? null,
    )
  );
  views.sort((a, b) =>
    a.name.localeCompare(b.name) || a.projectPath.localeCompare(b.projectPath)
  );
  return views;
}

// The view for a single project (start/stop responses): the same join, one row.
function viewFor(
  deps: DashboardDeps,
  projectPath: string,
): OrchestratorProjectView {
  const abs = resolve(projectPath);
  const name = registryNames(deps).get(abs) ?? basename(abs);
  return toView(abs, name, deps.supervisor.get(abs));
}

// A project is "known" if the registry lists it OR the supervisor already tracks a
// child for it (so an unregistered-but-live child is still addressable by stop).
function isKnownProject(deps: DashboardDeps, projectPath: string): boolean {
  const abs = resolve(projectPath);
  if (deps.supervisor.get(abs)) return true;
  return deps.listProjects().some((p) => resolve(p.path) === abs);
}

function stoppedProjectConflict(
  deps: DashboardDeps,
  projectPath: string,
): string | null {
  const child = deps.supervisor.get(projectPath);
  if (!child) return null;
  if (
    child.actualState !== "stopped" ||
    child.record.desiredState === "running"
  ) {
    return "Project must be fully stopped before duplicate or rename.";
  }
  return null;
}

// --- Request-body parsing -----------------------------------------------------

// Read + shape-check a JSON body's projectPath. Returns the string or a 400 reason
// (never throws on malformed JSON). Boundary validation (CLAUDE.md).
async function readProjectPath(c: Context): Promise<Result<string>> {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return badRequest("Request body must be JSON");
  }
  if (typeof body !== "object" || body === null) {
    return badRequest("Request body must be a JSON object");
  }
  const projectPath = (body as Record<string, unknown>).projectPath;
  if (typeof projectPath !== "string" || projectPath.length === 0) {
    return badRequest("Missing or invalid projectPath");
  }
  return { ok: true, data: projectPath };
}

function badRequest(message: string): Result<never> {
  return { ok: false, error: { code: "BAD_REQUEST", message } };
}

// Read + shape-check the New-project body { name, path }. Both are required
// non-empty strings (name → display name/slug; path → the parent dir the project
// folder is created under). Never throws on malformed JSON (boundary validation).
async function readCreateBody(
  c: Context,
): Promise<Result<{ name: string; path: string }>> {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return badRequest("Request body must be JSON");
  }
  if (typeof body !== "object" || body === null) {
    return badRequest("Request body must be a JSON object");
  }
  const rec = body as Record<string, unknown>;
  if (typeof rec.name !== "string" || rec.name.trim().length === 0) {
    return badRequest("Missing or invalid name");
  }
  if (typeof rec.path !== "string" || rec.path.length === 0) {
    return badRequest("Missing or invalid path");
  }
  return { ok: true, data: { name: rec.name.trim(), path: rec.path } };
}

// Read + shape-check the Open-folder body { path } (an existing project folder).
async function readOpenBody(c: Context): Promise<Result<{ path: string }>> {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return badRequest("Request body must be JSON");
  }
  if (typeof body !== "object" || body === null) {
    return badRequest("Request body must be a JSON object");
  }
  const path = (body as Record<string, unknown>).path;
  if (typeof path !== "string" || path.length === 0) {
    return badRequest("Missing or invalid path");
  }
  return { ok: true, data: { path } };
}

async function readRenameBody(
  c: Context,
): Promise<Result<{ projectPath: string; name: string; folderName: string }>> {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return badRequest("Request body must be JSON");
  }
  if (typeof body !== "object" || body === null) {
    return badRequest("Request body must be a JSON object");
  }
  const rec = body as Record<string, unknown>;
  if (typeof rec.projectPath !== "string" || rec.projectPath.length === 0) {
    return badRequest("Missing or invalid projectPath");
  }
  if (typeof rec.name !== "string" || rec.name.trim().length === 0) {
    return badRequest("Missing or invalid name");
  }
  if (
    typeof rec.folderName !== "string" || rec.folderName.trim().length === 0
  ) {
    return badRequest("Missing or invalid folderName");
  }
  return {
    ok: true,
    data: {
      projectPath: rec.projectPath,
      name: rec.name.trim(),
      folderName: rec.folderName.trim(),
    },
  };
}

// createProject/openProject throw plain Errors (they are not Result<T>). Map the
// known "expected conflict" messages — an existing project, a missing project, a
// corrupt manifest — to 409; anything else is an unexpected failure → 500. Matched
// on stable substrings of the messages project-manager throws.
const REGISTER_CONFLICT_PATTERNS = [
  "already exists",
  "No OpenTide project found",
  "Corrupt project manifest",
  "Destination already exists",
  "Not a directory",
];

const PROJECT_OPERATION_BAD_REQUEST_PATTERNS = [
  "Project name must not be empty",
  "Project folder name must not be empty",
  "Invalid project folder name",
  "Project folder name must be a single folder segment",
  "Project folder must stay within",
];

function registerError(c: Context, err: unknown): Response {
  const message = err instanceof Error ? err.message : String(err);
  const status: 400 | 409 | 500 =
    PROJECT_OPERATION_BAD_REQUEST_PATTERNS.some((p) => message.includes(p))
      ? 400
      : REGISTER_CONFLICT_PATTERNS.some((p) => message.includes(p))
      ? 409
      : 500;
  return c.json({ error: message }, status);
}

// --- §9 handlers --------------------------------------------------------------

// GET /api/orchestrator/projects → 200 { projects }
function handleProjects(deps: DashboardDeps, c: Context): Response {
  return c.json({ projects: buildViews(deps) });
}

// GET /api/orchestrator/status → 200 { projects, updatedAt } (cheap whole-set poll)
function handleStatus(deps: DashboardDeps, c: Context): Response {
  return c.json({
    projects: buildViews(deps),
    updatedAt: new Date().toISOString(),
  });
}

// POST /api/orchestrator/start { projectPath } → 200 { project } / 404 / 409
async function handleStart(deps: DashboardDeps, c: Context): Promise<Response> {
  const parsed = await readProjectPath(c);
  if (!parsed.ok) return c.json({ error: parsed.error.message }, 400);
  const projectPath = parsed.data;
  if (!isKnownProject(deps, projectPath)) {
    return errorResponse(c, UNKNOWN_PROJECT_CODE, "Unknown project");
  }
  const result = await deps.supervisor.start(projectPath);
  if (!result.ok) {
    return errorResponse(c, result.error.code, result.error.message);
  }
  return c.json({ project: viewFor(deps, projectPath) });
}

// POST /api/orchestrator/stop { projectPath } → 200 { project } / 404
async function handleStop(deps: DashboardDeps, c: Context): Promise<Response> {
  const parsed = await readProjectPath(c);
  if (!parsed.ok) return c.json({ error: parsed.error.message }, 400);
  const projectPath = parsed.data;
  if (!isKnownProject(deps, projectPath)) {
    return errorResponse(c, UNKNOWN_PROJECT_CODE, "Unknown project");
  }
  const result = await deps.supervisor.stop(projectPath);
  if (!result.ok) {
    return errorResponse(c, result.error.code, result.error.message);
  }
  return c.json({ project: viewFor(deps, projectPath) });
}

// POST /api/orchestrator/restart { projectPath } → 200 { project } / 404 / 409 (B4c).
// Server-side stop→start via supervisor.restart, reusing the existing verbs (no
// client race). Same Result→HTTP mapping as /start: unknown → 404, placement
// contention (NO_FREE_PORT/START_FAILED) → 409.
async function handleRestart(
  deps: DashboardDeps,
  c: Context,
): Promise<Response> {
  const parsed = await readProjectPath(c);
  if (!parsed.ok) return c.json({ error: parsed.error.message }, 400);
  const projectPath = parsed.data;
  if (!isKnownProject(deps, projectPath)) {
    return errorResponse(c, UNKNOWN_PROJECT_CODE, "Unknown project");
  }
  const result = await deps.supervisor.restart(projectPath);
  if (!result.ok) {
    return errorResponse(c, result.error.code, result.error.message);
  }
  return c.json({ project: viewFor(deps, projectPath) });
}

// GET /api/orchestrator/open?projectPath=… → 200 { url, ready } / 409 not running.
// Resolve-ONLY (§9): it never starts the child — the caller /starts first, then
// polls /status, then /opens. Anything not currently running (unknown, stopped,
// starting, crashed, failed) is 409 "Project not running".
function handleOpen(deps: DashboardDeps, c: Context): Response {
  const projectPath = c.req.query("projectPath");
  if (!projectPath) return c.json({ error: "Missing projectPath" }, 400);
  const child = deps.supervisor.get(projectPath);
  if (!child || child.actualState !== "running" || !child.record.controlPort) {
    return c.json({ error: "Project not running" }, 409);
  }
  const url = `http://${DEV_SERVER_HOST}:${child.record.controlPort}/`;
  return c.json({ url, ready: true });
}

// GET /api/orchestrator/logs?projectPath=… → 200 { lines } / 404 unknown (B4b).
// Returns the child's buffered stdout/stderr tail REGARDLESS of actualState — a
// crashed/failed/stopped child's crash tail is exactly the point. A project neither
// registered nor tracked → 404; a known-but-never-started project → 200 { lines: [] }.
function handleLogs(deps: DashboardDeps, c: Context): Response {
  const projectPath = c.req.query("projectPath");
  if (!projectPath) return c.json({ error: "Missing projectPath" }, 400);
  if (!isKnownProject(deps, projectPath)) {
    return errorResponse(c, UNKNOWN_PROJECT_CODE, "Unknown project");
  }
  const lines: LogLine[] = deps.supervisor.logs(projectPath);
  return c.json({ lines });
}

// POST /api/orchestrator/projects { name, path } → 200 { project } / 400 / 409.
// Create a NEW project dir (path/slug) and register it (project-manager.createProject).
// The new row returns stopped with null ports (register-only, §B4a decision below) so
// the UI can immediately drive the existing B3b Start/Open flow against it.
async function handleCreate(
  deps: ResolvedDeps,
  c: Context,
): Promise<Response> {
  const parsed = await readCreateBody(c);
  if (!parsed.ok) return c.json({ error: parsed.error.message }, 400);
  try {
    const entry = deps.createProject(parsed.data.path, parsed.data.name);
    return c.json({ project: viewFor(deps, entry.path) });
  } catch (err) {
    return registerError(c, err);
  }
}

// POST /api/orchestrator/projects/open { path } → 200 { project } / 400 / 409.
// Register an already-existing Genie project folder (project-manager.openProject).
// Same register-only stopped row as handleCreate.
async function handleOpenExisting(
  deps: ResolvedDeps,
  c: Context,
): Promise<Response> {
  const parsed = await readOpenBody(c);
  if (!parsed.ok) return c.json({ error: parsed.error.message }, 400);
  try {
    const entry = deps.openProject(parsed.data.path);
    return c.json({ project: viewFor(deps, entry.path) });
  } catch (err) {
    return registerError(c, err);
  }
}

async function handleDuplicateProject(
  deps: ResolvedDeps,
  c: Context,
): Promise<Response> {
  const parsed = await readProjectPath(c);
  if (!parsed.ok) return c.json({ error: parsed.error.message }, 400);
  const projectPath = parsed.data;
  if (!isKnownProject(deps, projectPath)) {
    return errorResponse(c, UNKNOWN_PROJECT_CODE, "Unknown project");
  }
  const conflict = stoppedProjectConflict(deps, projectPath);
  if (conflict) return c.json({ error: conflict }, 409);
  try {
    const entry = deps.duplicateProject(projectPath);
    return c.json({ project: viewFor(deps, entry.path) });
  } catch (err) {
    return registerError(c, err);
  }
}

async function handleRenameProject(
  deps: ResolvedDeps,
  c: Context,
): Promise<Response> {
  const parsed = await readRenameBody(c);
  if (!parsed.ok) return c.json({ error: parsed.error.message }, 400);
  const { projectPath, name, folderName } = parsed.data;
  if (!isKnownProject(deps, projectPath)) {
    return errorResponse(c, UNKNOWN_PROJECT_CODE, "Unknown project");
  }
  const conflict = stoppedProjectConflict(deps, projectPath);
  if (conflict) return c.json({ error: conflict }, 409);
  try {
    await deps.supervisor.forgetStoppedProject(projectPath);
    const entry = deps.renameProject(projectPath, { name, folderName });
    return c.json({ project: viewFor(deps, entry.path) });
  } catch (err) {
    return registerError(c, err);
  }
}

// --- Route table (schema is REQUIRED per entry: "no schema, no route") --------

interface RouteDef {
  method: "GET" | "POST";
  path: string;
  handlerName: string;
  schema: RouteSchema;
  // Handlers receive the RESOLVED deps (write seam defaulted). Read-only handlers
  // typed against DashboardDeps assign here fine (ResolvedDeps extends it).
  handler: (deps: ResolvedDeps, c: Context) => Response | Promise<Response>;
}

const PROJECT_VIEW_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    projectPath: { type: "string" },
    name: { type: "string" },
    desiredState: { type: "string", enum: ["running", "stopped"] },
    actualState: {
      type: "string",
      enum: ["stopped", "starting", "running", "crashed", "failed"],
    },
    controlPort: { type: ["integer", "null"] },
    appPort: { type: ["integer", "null"] },
    url: { type: ["string", "null"] },
    lastStartedAt: { type: ["string", "null"] },
    lastExit: { type: ["object", "null"] },
  },
};

const PROJECT_PATH_BODY = {
  type: "object" as const,
  properties: { projectPath: { type: "string" } },
  required: ["projectPath"],
};

const CREATE_PROJECT_BODY = {
  type: "object" as const,
  properties: { name: { type: "string" }, path: { type: "string" } },
  required: ["name", "path"],
};

const OPEN_PROJECT_BODY = {
  type: "object" as const,
  properties: { path: { type: "string" } },
  required: ["path"],
};

const RENAME_PROJECT_BODY = {
  type: "object" as const,
  properties: {
    projectPath: { type: "string" },
    name: { type: "string" },
    folderName: { type: "string" },
  },
  required: ["projectPath", "name", "folderName"],
};

// One captured log line (B4b): the stream it came from, the text, and when it was
// observed. Mirrors LogLine in supervisor.ts (the wire shape /logs returns).
const LOG_LINE_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    stream: { type: "string", enum: ["stdout", "stderr"] },
    text: { type: "string" },
    at: { type: "string", format: "date-time" },
  },
};

// The single source of truth for the dashboard's routes. `schema` is a required
// field, so a route literally cannot be added without one (structural "no schema,
// no route"). generateOpenAPISpec (below) reads these, making the schemas live.
export const ORCHESTRATOR_ROUTE_DEFS: readonly RouteDef[] = [
  {
    method: "GET",
    path: "/api/orchestrator/projects",
    handlerName: "orchestratorProjects",
    schema: {
      summary: "List every known project with live running/stopped state",
      tags: ["orchestrator"],
      responses: {
        "200": {
          description: "Projects",
          schema: {
            type: "object",
            properties: {
              projects: { type: "array", items: PROJECT_VIEW_SCHEMA },
            },
          },
        },
      },
    },
    handler: handleProjects,
  },
  {
    method: "GET",
    path: "/api/orchestrator/status",
    handlerName: "orchestratorStatus",
    schema: {
      summary: "Cheap whole-set snapshot poll for the dashboard",
      tags: ["orchestrator"],
      responses: {
        "200": {
          description: "Snapshot",
          schema: {
            type: "object",
            properties: {
              projects: { type: "array", items: PROJECT_VIEW_SCHEMA },
              updatedAt: { type: "string", format: "date-time" },
            },
          },
        },
      },
    },
    handler: handleStatus,
  },
  {
    method: "POST",
    path: "/api/orchestrator/start",
    handlerName: "orchestratorStart",
    schema: {
      summary: "Set desiredState=running and spawn the child (idempotent)",
      tags: ["orchestrator"],
      body: PROJECT_PATH_BODY,
      responses: {
        "200": { description: "Started", schema: PROJECT_VIEW_SCHEMA },
        "404": { description: "Unknown project" },
        "409": {
          description:
            "Could not place the child (no free port / start failed)",
        },
      },
    },
    handler: handleStart,
  },
  {
    method: "POST",
    path: "/api/orchestrator/stop",
    handlerName: "orchestratorStop",
    schema: {
      summary: "Set desiredState=stopped, SIGTERM + await exit (idempotent)",
      tags: ["orchestrator"],
      body: PROJECT_PATH_BODY,
      responses: {
        "200": { description: "Stopped", schema: PROJECT_VIEW_SCHEMA },
        "404": { description: "Unknown project" },
      },
    },
    handler: handleStop,
  },
  {
    method: "POST",
    path: "/api/orchestrator/restart",
    handlerName: "orchestratorRestart",
    schema: {
      summary:
        "Stop then start the child (server-side restart, idempotent start)",
      tags: ["orchestrator"],
      body: PROJECT_PATH_BODY,
      responses: {
        "200": { description: "Restarted", schema: PROJECT_VIEW_SCHEMA },
        "404": { description: "Unknown project" },
        "409": {
          description:
            "Could not place the child (no free port / start failed)",
        },
      },
    },
    handler: handleRestart,
  },
  {
    method: "POST",
    path: "/api/orchestrator/projects",
    handlerName: "orchestratorCreateProject",
    schema: {
      summary: "Create a new project directory and register it (stopped)",
      tags: ["orchestrator"],
      body: CREATE_PROJECT_BODY,
      responses: {
        "200": {
          description: "Created + registered",
          schema: PROJECT_VIEW_SCHEMA,
        },
        "400": { description: "Missing or invalid name/path" },
        "409": { description: "An OpenTide project already exists at that path" },
      },
    },
    handler: handleCreate,
  },
  {
    method: "POST",
    path: "/api/orchestrator/projects/open",
    handlerName: "orchestratorOpenProject",
    schema: {
      summary: "Register an already-existing Genie project folder (stopped)",
      tags: ["orchestrator"],
      body: OPEN_PROJECT_BODY,
      responses: {
        "200": { description: "Registered", schema: PROJECT_VIEW_SCHEMA },
        "400": { description: "Missing or invalid path" },
        "409": { description: "No project found / corrupt manifest" },
      },
    },
    handler: handleOpenExisting,
  },
  {
    method: "POST",
    path: "/api/orchestrator/projects/duplicate",
    handlerName: "orchestratorDuplicateProject",
    schema: {
      summary: "Duplicate a fully stopped project and register the copy",
      tags: ["orchestrator"],
      body: PROJECT_PATH_BODY,
      responses: {
        "200": {
          description: "Duplicated + registered",
          schema: PROJECT_VIEW_SCHEMA,
        },
        "400": { description: "Missing or invalid projectPath" },
        "404": { description: "Unknown project" },
        "409": {
          description: "Project is not fully stopped, or duplicate conflicts",
        },
      },
    },
    handler: handleDuplicateProject,
  },
  {
    method: "POST",
    path: "/api/orchestrator/projects/rename",
    handlerName: "orchestratorRenameProject",
    schema: {
      summary: "Rename a fully stopped project's display name and folder",
      tags: ["orchestrator"],
      body: RENAME_PROJECT_BODY,
      responses: {
        "200": { description: "Renamed", schema: PROJECT_VIEW_SCHEMA },
        "400": {
          description: "Missing or invalid projectPath/name/folderName",
        },
        "404": { description: "Unknown project" },
        "409": {
          description: "Project is not fully stopped, or rename conflicts",
        },
      },
    },
    handler: handleRenameProject,
  },
  {
    method: "GET",
    path: "/api/orchestrator/open",
    handlerName: "orchestratorOpen",
    schema: {
      summary: "Resolve the running child's URL (resolve-only; does not start)",
      tags: ["orchestrator"],
      query: {
        projectPath: {
          type: "string",
          required: true,
          description: "Absolute project path",
        },
      },
      responses: {
        "200": {
          description: "Resolved URL",
          schema: {
            type: "object",
            properties: {
              url: { type: "string" },
              ready: { type: "boolean" },
            },
          },
        },
        "409": { description: "Project not running" },
      },
    },
    handler: handleOpen,
  },
  {
    method: "GET",
    path: "/api/orchestrator/logs",
    handlerName: "orchestratorLogs",
    schema: {
      summary: "Buffered stdout/stderr tail for a child (any state, B4b)",
      tags: ["orchestrator"],
      query: {
        projectPath: {
          type: "string",
          required: true,
          description: "Absolute project path",
        },
      },
      responses: {
        "200": {
          description: "Captured log lines (oldest first)",
          schema: {
            type: "object",
            properties: { lines: { type: "array", items: LOG_LINE_SCHEMA } },
          },
        },
        "404": { description: "Unknown project" },
      },
    },
    handler: handleLogs,
  },
];

// Project the route table's schemas through the existing OpenAPI generator, so the
// RouteSchemas are genuinely CONSUMED (not decorative) — this is the standalone
// app's answer to "how does a RouteSchema attach without a kernel". Served at
// GET /api/orchestrator/openapi.
export function orchestratorOpenApiSpec(): Record<string, unknown> {
  const entries: RouteEntry[] = ORCHESTRATOR_ROUTE_DEFS.map((r) => ({
    method: r.method,
    path: r.path,
    handlerName: r.handlerName,
    registeredAt: "",
    schema: r.schema,
  }));
  return generateOpenAPISpec(entries, {
    title: "Genie Orchestrator Dashboard",
    serverUrl: `http://${DEV_SERVER_HOST}:${ORCHESTRATOR_DASHBOARD_PORT}`,
  });
}

// --- App factory + server -----------------------------------------------------

export interface CreateDashboardOptions {
  // The built IDE bundle dir to serve the dashboard UI from (B3b). When set, the
  // orchestrator serves ITS OWN dashboard on :3100 ("serves only its own dashboard
  // UI on one port", plan §B2): / → /projects redirect + a static catch-all mounted
  // AFTER the API routes, so /api/orchestrator/* always win. When omitted (B3a /
  // tests) the app is API-only, exactly as before.
  staticUiDir?: string;
}

// Build the dashboard Hono app over an injected supervisor + registry reader. Pure
// + injectable: a test builds it with a fake supervisor and drives routes via
// app.request(...) — no real Deno.serve, no real kernel. With opts.staticUiDir it
// also serves the built IDE bundle (B3b).
export function createDashboardApp(
  deps: DashboardDeps,
  opts: CreateDashboardOptions = {},
): Hono {
  const app = new Hono();
  // Fill the write seam's defaults once (real project-manager verbs) so every
  // register handler holds a non-optional ref; tests inject fakes via deps.
  const resolved: ResolvedDeps = {
    ...deps,
    createProject: deps.createProject ?? pmCreateProject,
    openProject: deps.openProject ?? pmOpenProject,
    duplicateProject: deps.duplicateProject ?? pmDuplicateProject,
    renameProject: deps.renameProject ?? pmRenameProject,
  };
  // API routes FIRST, so they always resolve ahead of the static catch-all below.
  for (const def of ORCHESTRATOR_ROUTE_DEFS) {
    const handler = (c: Context) => def.handler(resolved, c);
    if (def.method === "GET") app.get(def.path, handler);
    else app.post(def.path, handler);
  }
  app.get(
    "/api/orchestrator/openapi",
    (c) => c.json(orchestratorOpenApiSpec()),
  );
  // FolderPicker (reused by the New/Open forms, B4a) drives these ctx-free browse
  // endpoints; :3100 has no per-project control-server, so mount the replicas
  // (fs-browse.ts) here, BEFORE the static catch-all so they always win.
  app.get("/api/fs/list", (c) => handleFsList(c));
  app.post("/api/fs/mkdir", (c) => handleFsMkdir(c));

  if (opts.staticUiDir) {
    const root = opts.staticUiDir;
    // The bundle's "/" is the per-project IDE shell (it fetches /api/project, which
    // :3100 does not serve); send the browser to the dashboard page instead.
    app.get("/", (c) => c.redirect(DASHBOARD_HOME_PATH));
    // Static catch-all LAST: /api/* is already claimed above, everything else
    // (assets, /projects, SPA fallback) is served from the built bundle.
    app.get("*", (c) => serveDashboardStaticUi(c, root));
    app.on("HEAD", "*", (c) => serveDashboardStaticUi(c, root));
  }
  return app;
}

// A bound dashboard server: the port/host it listens on, a graceful shutdown, and
// the finished promise (resolves once the listener has fully closed).
export interface DashboardServer {
  port: number;
  hostname: string;
  shutdown(): Promise<void>;
  finished: Promise<void>;
}

export interface StartDashboardOptions {
  registryReader?: RegistryReader;
  port?: number;
  hostname?: string;
  onListen?: (info: { hostname: string; port: number }) => void;
  // The built IDE bundle dir to serve the dashboard UI from (B3b). Threaded from
  // the orchestrator root's resolved uiDist. Omitted → API-only (B3a).
  staticUiDir?: string;
}

// Deno.serve the dashboard app on ORCHESTRATOR_DASHBOARD_PORT, DEV_SERVER_HOST only
// (loopback — it exposes start/stop of arbitrary local projects). A thin one-liner
// around createDashboardApp so the factory is what unit tests exercise.
export function startDashboardServer(
  supervisor: Supervisor,
  opts: StartDashboardOptions = {},
): DashboardServer {
  const app = createDashboardApp({
    supervisor,
    listProjects: opts.registryReader ?? listProjects,
  }, { staticUiDir: opts.staticUiDir });
  const hostname = opts.hostname ?? DEV_SERVER_HOST;
  const port = opts.port ?? ORCHESTRATOR_DASHBOARD_PORT;
  const server = Deno.serve(
    { hostname, port, onListen: opts.onListen ?? (() => {}) },
    (req) => app.fetch(req),
  );
  return {
    port,
    hostname,
    shutdown: () => server.shutdown(),
    finished: server.finished,
  };
}
