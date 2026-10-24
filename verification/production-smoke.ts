// @layer verification — shared boot/probe/contract machinery for the production
// smoke gates. Extracted from production-build.ts once the Node-target smoke gate
// (runNodeSmokeGate) became the second consumer of the app/Deno gate's helpers:
// the generic boot/probe/version machinery and the health/OpenAPI contract are
// runtime-neutral (the orchestrator always spawns via Deno.Command, whether it
// runs `deno task start` or `node main.js`), so they live here and both gates
// import them. This is a behavior-preserving move: the constants, helpers, and
// contract are byte-for-byte what production-build.ts used before the split.
//
// It imports core/export.ts (down, L1) for the app-identity defaults so the
// health contract is asserted against the SAME defaults the generator emits, and
// nothing else — it is a sibling of production-build.ts within the verification
// layer, so that module importing it is an intra-layer import.
import {
  DEFAULT_APP_NAME,
  DEFAULT_APP_VERSION,
  type ExportProjectOptions,
  sha256Hex,
} from "../core/export.ts";
// Type-only import — RouteProbe is erased at runtime, so this does NOT form an
// initialization cycle with route-smoke-plan.ts (which imports this module's
// route/status/method constants at its own module-init). A *runtime* import from
// here into route-smoke-plan.ts would break, because its PLATFORM_ROUTES set is
// built from HEALTH_ROUTE/OPENAPI_ROUTE at module-load; keeping the constants here
// (the base module) and the value dependency one-directional avoids that.
import type { RouteProbe } from "./route-smoke-plan.ts";

// --- Shared smoke contract ----------------------------------------------------

// The generated app's health/OpenAPI surface (matches core/export.ts's
// generateMain) and the on-disk OpenAPI file name the export emits. `OPENAPI_FILE`
// is unchanged across targets — openapi.json is a static asset, not transpiled.
export const HEALTH_ROUTE = "/_health";
export const OPENAPI_ROUTE = "/openapi.json";
export const OPENAPI_FILE = "openapi.json";
export const HEALTH_OK_STATUS = 200;

// The only two safe, side-effect-free HTTP methods a route probe may auto-hit (a
// bare GET/HEAD; HEAD is body-less). They live here, the base smoke module, so
// probeRouteSmoke can classify a HEAD probe without a runtime import cycle back
// into route-smoke-plan.ts (see the type-only import note above); that module
// imports and re-exports them, so the safe-method classifier compares against the
// same constants. No magic method strings anywhere.
export const HTTP_GET = "GET";
export const HTTP_HEAD = "HEAD";

// The route-smoke contract thresholds/tokens (no magic strings). Any status at or
// above the server-error floor fails the route contract; a route whose declared
// response is JSON must answer with a content-type that contains this token.
export const HTTP_SERVER_ERROR_FLOOR = 500;
export const JSON_CONTENT_TYPE = "application/json";

// One JSON line the harness prints (app-smoke) or the probe assembles (Deno/Node
// gates), describing what it observed. `health` is the parsed /_health body (or
// null if it did not parse). The openapi fields are present only when the gate
// was asked to probe /openapi.json.
export interface SmokeOutcome {
  healthStatus: number;
  health: unknown;
  openapiStatus?: number;
  openapiJsonValid?: boolean;
}

// Apply the health (and, when expected, OpenAPI) contract to the observed outcome.
// Returns a failure message, or null when the contract holds. Shared by every
// smoke gate so the health/OpenAPI contract has a single definition.
export function checkSmokeContract(
  outcome: SmokeOutcome,
  expectOpenApi: boolean,
  opts: ExportProjectOptions | undefined,
): string | null {
  if (outcome.healthStatus !== HEALTH_OK_STATUS) {
    return `GET ${HEALTH_ROUTE} returned ${outcome.healthStatus}, expected ${HEALTH_OK_STATUS}.`;
  }
  // The contract main.ts emits: { ok, name, version } with name/version resolved
  // from the SAME export defaults the generator uses (no duplicated literals).
  const expectedHealth = {
    ok: true,
    name: opts?.projectName ?? DEFAULT_APP_NAME,
    version: opts?.projectVersion ?? DEFAULT_APP_VERSION,
  };
  if (JSON.stringify(outcome.health) !== JSON.stringify(expectedHealth)) {
    return `GET ${HEALTH_ROUTE} body ${
      JSON.stringify(outcome.health)
    } does not match the expected health contract ${
      JSON.stringify(expectedHealth)
    }.`;
  }
  if (expectOpenApi) {
    if (outcome.openapiStatus !== HEALTH_OK_STATUS) {
      return `GET ${OPENAPI_ROUTE} returned ${outcome.openapiStatus}, expected ${HEALTH_OK_STATUS}.`;
    }
    if (!outcome.openapiJsonValid) {
      return `GET ${OPENAPI_ROUTE} did not return valid JSON.`;
    }
  }
  return null;
}

// --- Shared boot/probe constants ----------------------------------------------

// The handshake main.ts prints once the socket is bound; the capture group is
// the bound base URL (host + port). Kept identical to the entrypoint's log line.
export const READY_LINE_PATTERN = /Server running on (http:\/\/[^\s]+)/;
// The bare marker (no URL) used to assert `--version` did NOT boot a server.
export const READY_LINE_MARKER = "Server running on";

// How long to wait for each phase. The version run and boot are bounded so a
// hung child can never wedge a gate; the HTTP probe polls because the socket may
// accept a beat after the ready line is logged.
export const VERSION_RUN_TIMEOUT_MS = 20_000;
export const SERVER_READY_TIMEOUT_MS = 20_000;
export const HTTP_PROBE_TIMEOUT_MS = 10_000;
export const HTTP_POLL_INTERVAL_MS = 100;
const ROUTE_BODY_SNIPPET_MAX_CHARS = 500;

// --- Shared boot/probe helpers ------------------------------------------------

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// Run a `<command> ... --version`-style sub-check to completion and confirm the
// entrypoint prints exactly `expected`, exits 0, and does NOT boot a server.
// Returns a failure message, or null when the version sub-check holds. Never
// throws. Runtime-neutral: the caller supplies the command (Deno.execPath()'s
// `deno task start -- --version`, or `node main.js --version`) and the expected
// `${projectName} ${projectVersion}` line.
export async function checkVersionCommand(opts: {
  command: string;
  args: string[];
  cwd: string;
  expected: string;
  timeoutMs: number;
}): Promise<string | null> {
  const label = `${opts.command} ${opts.args.join(" ")}`;
  let output: Deno.CommandOutput;
  try {
    const cmd = new Deno.Command(opts.command, {
      args: opts.args,
      cwd: opts.cwd,
      stdout: "piped",
      stderr: "piped",
      signal: AbortSignal.timeout(opts.timeoutMs),
    });
    output = await cmd.output();
  } catch (err) {
    return `${label} could not run: ${errorMessage(err)}`;
  }
  const stdout = new TextDecoder().decode(output.stdout).trim();
  const stderr = new TextDecoder().decode(output.stderr).trim();
  if (!output.success) {
    return `${label} exited ${output.code}.${stderr ? `\n${stderr}` : ""}`;
  }
  if (stdout !== opts.expected) {
    return `${label} printed ${JSON.stringify(stdout)}, expected ${
      JSON.stringify(opts.expected)
    }.`;
  }
  if (
    stdout.includes(READY_LINE_MARKER) || stderr.includes(READY_LINE_MARKER)
  ) {
    return `${label} unexpectedly started a server.`;
  }
  return null;
}

// Read the child's stdout until the "Server running on" line and return the
// bound base URL. Throws on timeout or if the child exits before printing it
// (a boot error) — the caller maps that to a gate failure.
export async function waitForReadyUrl(
  child: Deno.ChildProcess,
  timeoutMs: number,
): Promise<URL> {
  if (!child.stdout) throw new Error("Expected child stdout to be piped");
  const reader = child.stdout.getReader();
  const decoder = new TextDecoder();
  const deadline = Date.now() + timeoutMs;
  let output = "";
  try {
    while (Date.now() < deadline) {
      const remaining = deadline - Date.now();
      const result = await Promise.race([
        reader.read(),
        new Promise<"timeout">((resolve) =>
          setTimeout(() => resolve("timeout"), remaining)
        ),
      ]);
      if (result === "timeout") break;
      if (result.done) break;
      output += decoder.decode(result.value, { stream: true });
      const match = output.match(READY_LINE_PATTERN);
      if (match?.[1]) return new URL(match[1]);
    }
  } finally {
    reader.releaseLock();
  }
  throw new Error(
    `Timed out waiting for the server to boot. Output:\n${output}`,
  );
}

// Poll an endpoint until it answers (the socket may accept a beat after the
// ready line), returning the first Response regardless of status — the contract
// check validates the status. `init` defaults to a bare GET (the health/OpenAPI
// probes) and is set by the route probe to carry the resolved method and, for a
// body-allowing method, a JSON body (see buildRouteRequestInit). The same init is
// reused across retries. Throws on timeout.
async function pollForResponse(
  url: string,
  timeoutMs: number,
  init: RequestInit = { method: HTTP_GET },
): Promise<Response> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      return await fetch(url, init);
    } catch (err) {
      lastError = err;
      await new Promise((resolve) =>
        setTimeout(resolve, HTTP_POLL_INTERVAL_MS)
      );
    }
  }
  throw new Error(`Timed out fetching ${url}: ${errorMessage(lastError)}`);
}

// Probe the booted app over real HTTP and assemble the shared SmokeOutcome. Every
// Response body is fully consumed (json/text) so no fetch resource leaks. Already
// target-agnostic — the base URL is all it needs, so both the Deno and Node boot
// gates share it verbatim.
export async function probeSmokeOverHttp(
  base: URL,
  expectOpenApi: boolean,
): Promise<SmokeOutcome> {
  const healthRes = await pollForResponse(
    new URL(HEALTH_ROUTE, base).toString(),
    HTTP_PROBE_TIMEOUT_MS,
  );
  const health = await healthRes.json().catch(() => null);
  const outcome: SmokeOutcome = { healthStatus: healthRes.status, health };
  if (expectOpenApi) {
    const openapiRes = await pollForResponse(
      new URL(OPENAPI_ROUTE, base).toString(),
      HTTP_PROBE_TIMEOUT_MS,
    );
    const openapiText = await openapiRes.text();
    let openapiJsonValid = false;
    try {
      JSON.parse(openapiText);
      openapiJsonValid = true;
    } catch {
      openapiJsonValid = false;
    }
    outcome.openapiStatus = openapiRes.status;
    outcome.openapiJsonValid = openapiJsonValid;
  }
  return outcome;
}

// Reap a child: SIGTERM (guarded — it may already have exited) then await its
// status. Kept separate from stream cancellation so the boot-failure path can
// reap first (closing stderr) and drain stderr before the streams are cancelled.
export async function reapChild(child: Deno.ChildProcess): Promise<void> {
  try {
    child.kill("SIGTERM");
  } catch {
    // Process may already have exited.
  }
  await child.status.catch(() => undefined);
}

// Cancel a child's stdout/stderr streams so no pipe leaks. Safe to call on an
// already-drained or already-cancelled stream (errors are swallowed).
export async function cancelStreams(child: Deno.ChildProcess): Promise<void> {
  await child.stdout?.cancel().catch(() => undefined);
  await child.stderr?.cancel().catch(() => undefined);
}

// Drain a child's stderr to a string (used to surface a boot error). Assumes the
// child has already exited (stderr closed) so the read terminates.
export async function drainStderr(child: Deno.ChildProcess): Promise<string> {
  if (!child.stderr) return "";
  try {
    const reader = child.stderr.getReader();
    const decoder = new TextDecoder();
    let out = "";
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        out += decoder.decode(value, { stream: true });
      }
    } finally {
      reader.releaseLock();
    }
    return out.trim();
  } catch {
    return "";
  }
}

// --- Route-smoke execution + contract (Milestone 4, Slice 4.2) ----------------

// What one probe observed against the booted app. `actualStatus` is null and
// `error` is set when the route could not be reached at all; otherwise the status
// and (when the response declared a body) the content-type are recorded, plus
// `bodySnippet` carries a bounded response preview for actionable failure
// messages, and `jsonParsed` is set only when a JSON body was expected AND read
// (GET, expectsJson). The expected side (method/path/expectedStatus/expectsJson)
// is echoed from the probe so the pure contract check needs nothing but this
// result.
//
// `deterministicBody` is echoed from the probe (the author's Slice-4.3 opt-in),
// and `bodyHash` is the SHA-256 of the response body — captured ONLY when the
// author asserted deterministicBody AND the body was read (a non-HEAD, reachable
// route), else null. These two ride alongside the contract fields purely so the
// Slice-4.4 cross-target parity comparator (verification/route-parity.ts) can
// compare bodies across targets; checkRouteSmokeContract never reads them.
export interface RouteProbeResult {
  method: string;
  path: string;
  expectedStatus: number;
  expectsJson: boolean;
  actualStatus: number | null;
  contentType: string | null;
  bodySnippet?: string;
  jsonParsed?: boolean;
  error?: string;
  deterministicBody: boolean;
  bodyHash: string | null;
}

// Probe every route in `probes` against the booted app over real HTTP and return
// one RouteProbeResult per probe, in order. Reuses the same pollForResponse /
// HTTP_PROBE_TIMEOUT_MS machinery as probeSmokeOverHttp (a GET body is fully
// consumed so no fetch resource leaks; a HEAD is body-less). NEVER throws — a
// fetch failure is captured as a result with actualStatus=null + error, so mapping
// it to a gate failure is the caller's (checkRouteSmokeContract's) job. The caller
// passes the plan's probes already filtered to the non-platform routes: the
// health/OpenAPI pair is probed strictly by probeSmokeOverHttp/checkSmokeContract
// and must not be double-fetched.
export async function probeRouteSmoke(
  base: URL,
  probes: readonly RouteProbe[],
): Promise<RouteProbeResult[]> {
  const results: RouteProbeResult[] = [];
  for (const probe of probes) {
    results.push(await probeOneRoute(base, probe));
  }
  return results;
}

// Build the RequestInit for one probe: the resolved method, plus — only for a
// body-allowing method carrying a fixture body — a JSON content-type and the
// serialized body. GET/HEAD probes never carry a body (the plan withholds
// requestBody from them, and fetch would throw), so this is a bare method for
// them. Kept next to probeOneRoute so the request-building is one place.
function buildRouteRequestInit(probe: RouteProbe): RequestInit {
  if (
    probe.requestBody !== undefined && probe.method !== HTTP_GET &&
    probe.method !== HTTP_HEAD
  ) {
    return {
      method: probe.method,
      redirect: "manual",
      headers: { "content-type": JSON_CONTENT_TYPE },
      body: JSON.stringify(probe.requestBody),
    };
  }
  return { method: probe.method, redirect: "manual" };
}

function routeBodySnippet(text: string | null): string | undefined {
  if (text === null) return undefined;
  const compact = text.replace(/\s+/g, " ").trim();
  if (compact.length === 0) return undefined;
  if (compact.length <= ROUTE_BODY_SNIPPET_MAX_CHARS) return compact;
  return `${compact.slice(0, ROUTE_BODY_SNIPPET_MAX_CHARS)}...`;
}

function withBodySnippet(message: string, snippet: string | undefined): string {
  return snippet ? `${message} Response body: ${snippet}` : message;
}

async function probeOneRoute(
  base: URL,
  probe: RouteProbe,
): Promise<RouteProbeResult> {
  const echo = {
    method: probe.method,
    path: probe.path,
    expectedStatus: probe.expectedStatus,
    expectsJson: probe.expectsJson,
    deterministicBody: probe.deterministicBody,
  };
  let res: Response;
  try {
    res = await pollForResponse(
      new URL(probe.path, base).toString(),
      HTTP_PROBE_TIMEOUT_MS,
      buildRouteRequestInit(probe),
    );
  } catch (err) {
    return {
      ...echo,
      actualStatus: null,
      contentType: null,
      bodyHash: null,
      error: errorMessage(err),
    };
  }
  const contentType = res.headers.get("content-type");
  // HEAD is body-less: cancel any stream (no body to consume) and report status.
  // No body to fingerprint, so bodyHash stays null even under deterministicBody.
  if (probe.method === HTTP_HEAD) {
    await res.body?.cancel().catch(() => undefined);
    return { ...echo, actualStatus: res.status, contentType, bodyHash: null };
  }
  // GET: fully consume the body (no leak). Only when the route declared a JSON
  // response do we record whether that body parsed as JSON.
  const text = await res.text().catch(() => null);
  const result: RouteProbeResult = {
    ...echo,
    actualStatus: res.status,
    contentType,
    bodySnippet: routeBodySnippet(text),
    bodyHash: null,
  };
  if (probe.expectsJson) {
    try {
      JSON.parse(text ?? "");
      result.jsonParsed = true;
    } catch {
      result.jsonParsed = false;
    }
  }
  // Fingerprint the body ONLY when the author asserted determinism and the body
  // was actually read — a bare GET without the opt-in is never hashed (it may
  // legitimately return a timestamp/random id), so it is not body-compared in
  // parity. The hash reuses the export's SHA-256 helper (down import, L1).
  if (probe.deterministicBody && text !== null) {
    result.bodyHash = await sha256Hex(new TextEncoder().encode(text));
  }
  return result;
}

// Apply the route-smoke contract to the observed results, returning the FIRST
// failure message (naming the offending `METHOD /path`) or null when every probe
// holds. Pure, total, never throws — the mirror of checkSmokeContract for the
// per-route pass. Assertions, in order (Phase 7 "Default assertions"):
//   (i)   the route was reachable at all,
//   (ii)  the status is not a 5xx server error,
//   (iii) the status equals the derived expectedStatus,
//   (iv)  when the route declared a JSON response, the body parsed as JSON and the
//         content-type is sane (JSON) when the server declared one.
export function checkOneRouteSmokeContract(
  r: RouteProbeResult,
): string | null {
  const label = `${r.method} ${r.path}`;
  if (r.actualStatus === null) {
    return `${label} could not be reached${r.error ? `: ${r.error}` : ""}.`;
  }
  if (r.actualStatus >= HTTP_SERVER_ERROR_FLOOR) {
    return withBodySnippet(
      `${label} returned a server error ${r.actualStatus}.`,
      r.bodySnippet,
    );
  }
  if (r.actualStatus !== r.expectedStatus) {
    return withBodySnippet(
      `${label} returned ${r.actualStatus}, expected ${r.expectedStatus}.`,
      r.bodySnippet,
    );
  }
  if (r.expectsJson) {
    if (r.jsonParsed === false) {
      return withBodySnippet(
        `${label} declared a JSON response but the body did not parse as JSON.`,
        r.bodySnippet,
      );
    }
    if (
      r.contentType !== null && !r.contentType.includes(JSON_CONTENT_TYPE)
    ) {
      return `${label} declared a JSON response but content-type was ${
        JSON.stringify(r.contentType)
      }.`;
    }
  }
  return null;
}

export function checkRouteSmokeContract(
  results: readonly RouteProbeResult[],
): string | null {
  for (const r of results) {
    const error = checkOneRouteSmokeContract(r);
    if (error !== null) return error;
  }
  return null;
}
