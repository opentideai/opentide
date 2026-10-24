import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Kernel } from "./registries.ts";
import type { ChangesetReadinessIssue } from "./types.ts";

// AGENT.md is what an external agent reads to learn the shape of the app. It is generated
// from kernel state by generate_project_docs and never updated by anything else, so it
// drifts silently: nothing in the kernel notices that the doc and the registry disagree.
// project-doctor catches a changeset referencing a session that does not exist, but a doc
// naming 63 handlers that do not exist is invisible to it.
//
// This check reports the contradiction, not the staleness. A doc one handler behind is not
// worth a warning — every changeset that defines anything would trip it, and a warning that
// fires every time is a warning nobody reads. A doc that names entities the registry does
// not have is actively lying to whoever reads it next, and that is worth saying.

// Sections of generateAgentMd (core/export.ts) this parser understands. Each emits
// "- `<name>`" bullets, so the first backtick-quoted token on a bullet is the entity key.
const SECTION_ROUTES = "## Routes";
const SECTION_HANDLERS = "## Handlers";
const SECTION_FUNCTIONS = "## Functions";

export interface DocumentedEntities {
  routes: Set<string>;
  handlers: Set<string>;
  functions: Set<string>;
}

export interface DocsDrift {
  /** Named in AGENT.md, absent from the registry — the doc is lying. */
  staleRoutes: string[];
  staleHandlers: string[];
  staleFunctions: string[];
  /** Present in the registry, absent from AGENT.md — the doc is incomplete. */
  missingRoutes: string[];
  missingHandlers: string[];
  missingFunctions: string[];
}

function emptyDrift(): DocsDrift {
  return {
    staleRoutes: [],
    staleHandlers: [],
    staleFunctions: [],
    missingRoutes: [],
    missingHandlers: [],
    missingFunctions: [],
  };
}

export function driftIsClean(drift: DocsDrift): boolean {
  return totalStale(drift) === 0 && totalMissing(drift) === 0;
}

export function totalStale(drift: DocsDrift): number {
  return drift.staleRoutes.length + drift.staleHandlers.length +
    drift.staleFunctions.length;
}

export function totalMissing(drift: DocsDrift): number {
  return drift.missingRoutes.length + drift.missingHandlers.length +
    drift.missingFunctions.length;
}

/**
 * Pull the route/handler/function keys out of a generated AGENT.md.
 *
 * Bullets look like:
 *   - `GET /read/:id` → `serveReader` (reader)
 *   - `serveReader` (reader) — Serve the reader page for a saved article.
 *
 * Only the first backtick-quoted token is read, so a purpose string containing backticks
 * cannot be mistaken for an entity name. A heading that is not one of the three known
 * sections closes the current one, so prose between sections is never parsed as bullets.
 */
export function parseDocumentedEntities(markdown: string): DocumentedEntities {
  const found: DocumentedEntities = {
    routes: new Set<string>(),
    handlers: new Set<string>(),
    functions: new Set<string>(),
  };

  let current: keyof DocumentedEntities | null = null;
  for (const line of markdown.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("#")) {
      if (trimmed === SECTION_ROUTES) current = "routes";
      else if (trimmed === SECTION_HANDLERS) current = "handlers";
      else if (trimmed === SECTION_FUNCTIONS) current = "functions";
      else current = null;
      continue;
    }
    if (!current || !trimmed.startsWith("- ")) continue;
    const quoted = /^- `([^`]+)`/.exec(trimmed);
    if (quoted) found[current].add(quoted[1]!);
  }
  return found;
}

/** Route key as generateAgentMd writes it, so doc and registry compare like for like. */
export function routeKey(method: string, path: string): string {
  return `${method} ${path}`;
}

export function diffDocsAgainstKernel(
  documented: DocumentedEntities,
  kernel: Kernel,
): DocsDrift {
  const liveRoutes = new Set(
    [...kernel.routes.list()].map((r) => routeKey(r.method, r.path)),
  );
  const liveHandlers = new Set([...kernel.handlers.list()].map((h) => h.name));
  const liveFunctions = new Set(
    [...kernel.functions.list()].map((f) => f.name),
  );

  const absentFrom = (live: Set<string>, docs: Set<string>): string[] =>
    [...docs].filter((name) => !live.has(name)).sort();
  const undocumented = (live: Set<string>, docs: Set<string>): string[] =>
    [...live].filter((name) => !docs.has(name)).sort();

  return {
    staleRoutes: absentFrom(liveRoutes, documented.routes),
    staleHandlers: absentFrom(liveHandlers, documented.handlers),
    staleFunctions: absentFrom(liveFunctions, documented.functions),
    missingRoutes: undocumented(liveRoutes, documented.routes),
    missingHandlers: undocumented(liveHandlers, documented.handlers),
    missingFunctions: undocumented(liveFunctions, documented.functions),
  };
}

/**
 * Read AGENT.md from the project directory and diff it against the live registry.
 *
 * Deliberately reads the kernel rather than `.opentide/state/`: the state dir is only
 * written on a clean unload or an explicit flush (core/tools/dispatch.ts
 * flushKernelProjectState), so mid-session it can be hours behind the kernel and would
 * report drift that does not exist.
 *
 * Returns an empty drift when the project has no AGENT.md — not every project keeps one,
 * and its absence is not a defect.
 */
export function readDocsDrift(kernel: Kernel): DocsDrift {
  if (!kernel.projectDir) return emptyDrift();
  const docPath = join(kernel.projectDir, "AGENT.md");
  if (!existsSync(docPath)) return emptyDrift();
  let markdown: string;
  try {
    markdown = readFileSync(docPath, "utf8");
  } catch {
    // An unreadable AGENT.md is a filesystem problem, not a drift finding.
    return emptyDrift();
  }
  return diffDocsAgainstKernel(parseDocumentedEntities(markdown), kernel);
}

function sample(names: string[], limit = 3): string {
  const shown = names.slice(0, limit).join(", ");
  const rest = names.length - Math.min(limit, names.length);
  return rest > 0 ? `${shown}, +${rest} more` : shown;
}

/**
 * Advisory readiness issues for a drifted AGENT.md. Always `warning` severity: the doc is
 * not the app, and refusing to complete a changeset over a stale markdown file would block
 * work on something the agent can fix in one call. Two separate codes because they call for
 * the same remedy but mean different things — one is a doc that names things that are gone,
 * the other a doc that never mentioned things that exist.
 */
export function docsDriftIssues(drift: DocsDrift): ChangesetReadinessIssue[] {
  const issues: ChangesetReadinessIssue[] = [];
  const action =
    "Run generate_project_docs to regenerate AGENT.md from current kernel state.";

  const stale = totalStale(drift);
  if (stale > 0) {
    const parts: string[] = [];
    if (drift.staleRoutes.length > 0) {
      parts.push(`routes (${sample(drift.staleRoutes)})`);
    }
    if (drift.staleHandlers.length > 0) {
      parts.push(`handlers (${sample(drift.staleHandlers)})`);
    }
    if (drift.staleFunctions.length > 0) {
      parts.push(`functions (${sample(drift.staleFunctions)})`);
    }
    issues.push({
      code: "DOCS_STALE_ENTITIES",
      message:
        `AGENT.md documents ${stale} entit${stale === 1 ? "y" : "ies"} that ` +
        `no longer exist: ${parts.join("; ")}.`,
      action,
      severity: "warning",
    });
  }

  const missing = totalMissing(drift);
  if (missing > 0) {
    const parts: string[] = [];
    if (drift.missingRoutes.length > 0) {
      parts.push(`routes (${sample(drift.missingRoutes)})`);
    }
    if (drift.missingHandlers.length > 0) {
      parts.push(`handlers (${sample(drift.missingHandlers)})`);
    }
    if (drift.missingFunctions.length > 0) {
      parts.push(`functions (${sample(drift.missingFunctions)})`);
    }
    issues.push({
      code: "DOCS_MISSING_ENTITIES",
      message: `AGENT.md omits ${missing} registered entit${
        missing === 1 ? "y" : "ies"
      }: ${parts.join("; ")}.`,
      action,
      severity: "warning",
    });
  }

  return issues;
}
