// @layer core — ctx-free filesystem browse handlers for the orchestrator dashboard
// (Feature B / B4a).
//
// The dashboard's New/Open project forms reuse the IDE FolderPicker, which drives
// GET /api/fs/list + POST /api/fs/mkdir for folder browsing and folder creation.
// The per-project control-server already serves those two endpoints
// (core/control-server.ts ~:1124), but it holds a per-project `ctx` the orchestrator
// does not have — and B4a must not touch that server. So this is a deliberate
// ctx-free REPLICA of those two handlers (same pattern as static-ui.ts's ctx-free
// serveStaticUi copy from B3b): HOME-scoped directory listing + mkdir, mounted on
// the loopback-only dashboard so FolderPicker works on :3100.
//
// DRY note: the logic mirrors control-server's /api/fs/* handlers. It is copied
// rather than shared because the control-server versions are inline (not exported)
// and extracting them would modify the per-project control-server, which is out of
// B4a scope. If a third copy appears, extract a shared helper (CLAUDE.md).

import { resolve } from "node:path";
import type { Context } from "hono";

// The browse root: everything is scoped to $HOME (matching control-server). Falls
// back to "/" only when HOME is unset, which never happens in practice.
function homeDir(): string {
  return resolve(Deno.env.get("HOME") || "/");
}

// True when `path` is `parent` itself or nested under it. Used to keep listing
// scoped to HOME (and to allow ancestors of HOME so the picker can walk upward).
function isWithinOrEqual(path: string, parent: string): boolean {
  if (path === parent) return true;
  return path.startsWith(parent.endsWith("/") ? parent : `${parent}/`);
}

// GET /api/fs/list?path=… → { path, entries, error? }. Lists non-hidden entries of
// a HOME-scoped directory (dirs first, then name). Access outside HOME (and not an
// ancestor of HOME) is denied; unreadable dirs degrade to an error, never throw.
export function handleFsList(c: Context): Response {
  const home = homeDir();
  const raw = c.req.query("path") || home;
  const dir = resolve(raw);
  const insideHome = isWithinOrEqual(dir, home);
  const ancestorOfHome = isWithinOrEqual(home, dir);
  if (!insideHome && !ancestorOfHome) {
    return c.json({ path: dir, entries: [], error: "Access denied" });
  }
  try {
    const entries: { name: string; isDir: boolean }[] = [];
    for (const entry of Deno.readDirSync(dir)) {
      if (entry.name.startsWith(".")) continue;
      entries.push({ name: entry.name, isDir: entry.isDirectory });
    }
    entries.sort((a, b) =>
      a.isDir !== b.isDir ? (a.isDir ? -1 : 1) : a.name.localeCompare(b.name)
    );
    return c.json({ path: dir, entries });
  } catch {
    return c.json({ path: dir, entries: [], error: "Cannot read directory" });
  }
}

// POST /api/fs/mkdir { path } → { path } | { error }. Creates a HOME-scoped
// directory (recursive). Missing/invalid body → 400, outside HOME → 403, failure →
// 500. Boundary validation only (CLAUDE.md); never throws.
export async function handleFsMkdir(c: Context): Promise<Response> {
  const home = homeDir();
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Request body must be JSON" }, 400);
  }
  const path = typeof body === "object" && body !== null
    ? (body as Record<string, unknown>).path
    : undefined;
  if (typeof path !== "string" || path.length === 0) {
    return c.json({ error: "path is required" }, 400);
  }
  const dir = resolve(path);
  if (!isWithinOrEqual(dir, home)) {
    return c.json({ error: "Access denied" }, 403);
  }
  try {
    Deno.mkdirSync(dir, { recursive: true });
    return c.json({ path: dir });
  } catch {
    return c.json({ error: "Failed to create directory" }, 500);
  }
}
