// @layer core — static-UI serving for the orchestrator dashboard (Feature B / B3b).
//
// A self-contained replica of control-server.ts's serveStaticUi mechanism
// (core/control-server.ts:377), lifted here rather than reached into: that copy is
// private to the per-project control-server (which B3b must not touch) and it is
// entangled with a per-project `ctx`. This copy is `ctx`-free — it only needs the
// bundle root — so the orchestrator can mount the SAME built IDE bundle it threads
// to children (decision #4) on its own loopback dashboard origin (:3100).
//
// DRY note: this duplicates ~50 lines of control-server's static handler. A future
// refactor could extract a single shared core/static-ui.ts consumed by BOTH roots;
// B3b keeps them separate to honor its "do not modify the per-project control
// server" scope. See docs/orchestrator-design.md §7.

import {
  extname,
  isAbsolute,
  join,
  normalize,
  relative,
  resolve,
} from "node:path";
import type { Context } from "hono";

// Path prefixes that must NEVER resolve to a static file — the dashboard's own API
// lives under /api, so those requests fall through to their real handlers (or 404)
// instead of being shadowed by the SPA fallback. Mirrors control-server's reserved
// set, trimmed to the only prefix the dashboard actually serves.
const DASHBOARD_RESERVED_PREFIXES = ["/api"];

// Content types for the asset extensions the built IDE bundle emits. Mirrors
// control-server.ts's STATIC_UI_MIME_TYPES.
const STATIC_UI_MIME_TYPES: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".gif": "image/gif",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".wasm": "application/wasm",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

function isReservedPath(pathname: string): boolean {
  return DASHBOARD_RESERVED_PREFIXES.some((prefix) =>
    pathname === prefix || pathname.startsWith(`${prefix}/`)
  );
}

// Resolve a request pathname to an absolute file under `root`, rejecting traversal
// (`..`), null bytes, and undecodable escapes. Mirrors resolveStaticUiPath.
function resolveStaticUiPath(root: string, pathname: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (decoded.includes("\0")) return null;
  const candidate = resolve(root, `.${normalize(decoded)}`);
  const rel = relative(root, candidate);
  if (rel.startsWith("..") || isAbsolute(rel)) return null;
  return candidate;
}

async function staticFileExists(path: string): Promise<boolean> {
  try {
    return (await Deno.stat(path)).isFile;
  } catch {
    return false;
  }
}

async function serveStaticFile(c: Context, path: string): Promise<Response> {
  const body = c.req.method === "HEAD" ? null : await Deno.readFile(path);
  const headers = new Headers();
  const contentType = STATIC_UI_MIME_TYPES[extname(path).toLowerCase()];
  if (contentType) headers.set("content-type", contentType);
  if (path.split(/[\\/]/).includes("immutable")) {
    headers.set("cache-control", "public, max-age=31536000, immutable");
  }
  return new Response(body, { headers });
}

// Serve `pathname` from the built IDE bundle at `root`: exact file → directory
// index → SPA fallback (index.html for extension-less routes, so the SvelteKit
// client router can resolve /projects and friends). Requests under a reserved
// prefix (/api) are never served here. Mirrors control-server.ts:377 serveStaticUi.
export async function serveDashboardStaticUi(
  c: Context,
  root: string,
): Promise<Response> {
  const pathname = new URL(c.req.url).pathname;
  if (isReservedPath(pathname)) return c.notFound();

  const filePath = resolveStaticUiPath(root, pathname);
  if (!filePath) return c.text("Not found", 404);

  if (await staticFileExists(filePath)) {
    return serveStaticFile(c, filePath);
  }

  const dirIndexPath = join(filePath, "index.html");
  if (await staticFileExists(dirIndexPath)) {
    return serveStaticFile(c, dirIndexPath);
  }

  if (!extname(pathname)) {
    const fallbackPath = join(root, "index.html");
    if (await staticFileExists(fallbackPath)) {
      return serveStaticFile(c, fallbackPath);
    }
  }

  return c.text("Not found", 404);
}
