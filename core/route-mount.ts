// @layer core — the route-mount hook (OpenTide §3.3).
//
// Upper layers (verification, later others) contribute their own HTTP routes to
// the core app instead of the control server importing their logic. The core
// builds a CoreRouteContext and hands it, with the Hono app, to each registered
// mounter; a composition root supplies the mounters via
// ControlServerOptions.mountRoutes. Hono is passed directly — TideStack commits
// to it (§1.1), so there is no framework abstraction here. Scope: this is the
// CONTROL plane. The user-app handler contract is framework-free as of the
// 2026-09 amendment to D5; that says nothing about how we mount our own routes.
import type { Context, Hono } from "hono";
import type { Kernel } from "./registries.ts";

export interface CoreRouteContext {
  // The standard "is a project open?" guard: returns a 400 response to short-
  // circuit the handler, or null when a project is open.
  requireKernel(c: Context): Response | null;
  // The current project's registry identity. Only valid after requireKernel
  // returns null.
  project(): { path: string; name: string };
  // The current project's kernel. Only valid after requireKernel returns null.
  kernel(): Kernel;
  // Rebuild the current project's app server. Only valid after requireKernel
  // returns null.
  rebuild(): void;
  // The bearer token for the current project, minted when it opened and written
  // to `.opentide/kernel.token`. Null exactly when no project is open.
  serverToken(): string | null;
  // Runs before the current project unloads (switch or close), so a mounter can
  // drop state that captured the old kernel.
  onProjectClose(listener: () => Promise<void>): void;
  // Fire-and-forget telemetry (records the event and best-effort syncs it).
  track(event: string, properties?: Record<string, unknown>): void;
}

export type RouteMounter = (app: Hono, core: CoreRouteContext) => void;
