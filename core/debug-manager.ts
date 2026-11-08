import { readEnv } from "./process-env.ts";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CDPClient } from "./cdp-client.ts";
import type { Kernel } from "./registries.ts";
import { type AppServer, createAppServer } from "./app-server.ts";
import { Database } from "./db.ts";
import type { DbConfig } from "./db/factory.ts";
import { DEV_SERVER_HOST, OPENTIDE_DB_URL_ENV } from "./config.ts";
import { createDebugKernel, type DebugKernel } from "./debug-kernel.ts";
import { debugUserCodeRunner } from "./runner/project-runner.ts";

function decodeVLQ(encoded: string): number[] {
  const CHARS =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const values: number[] = [];
  let shift = 0, value = 0;
  for (const ch of encoded) {
    const digit = CHARS.indexOf(ch);
    if (digit === -1) break;
    value += (digit & 31) << shift;
    if (digit & 32) {
      shift += 5;
      continue;
    }
    values.push(value & 1 ? -(value >> 1) : value >> 1);
    shift = 0;
    value = 0;
  }
  return values;
}

interface SourceMapSegment {
  generatedColumn: number;
  originalLine: number;
  originalColumn: number;
}

interface GeneratedLocation {
  lineNumber: number;
  columnNumber: number;
}

interface SourceMapIndex {
  generatedToOriginal: Map<number, SourceMapSegment[]>;
  originalToGenerated: Map<number, GeneratedLocation>;
}

function buildSourceMapIndex(dataUrl: string): SourceMapIndex {
  const generatedToOriginal = new Map<number, SourceMapSegment[]>();
  const originalToGenerated = new Map<number, GeneratedLocation>();
  try {
    const b64 = dataUrl.replace(/^data:[^,]+,/, "");
    const json = JSON.parse(atob(b64));
    const lines = (json.mappings as string).split(";");
    let sourceIndex = 0, origLine = 0, origColumn = 0, nameIndex = 0;
    for (let genLine = 0; genLine < lines.length; genLine++) {
      const line = lines[genLine]!;
      if (!line) continue;
      let genColumn = 0;
      for (const encoded of line.split(",")) {
        const fields = decodeVLQ(encoded);
        if (fields.length === 0) continue;
        genColumn += fields[0]!;
        if (fields.length < 4) continue;

        sourceIndex += fields[1]!;
        origLine += fields[2]!;
        origColumn += fields[3]!;
        if (fields.length >= 5) nameIndex += fields[4]!;

        // Genie compiles one virtual source per script, so sourceIndex only
        // matters for keeping the VLQ deltas correct.
        void sourceIndex;
        void nameIndex;

        const segment: SourceMapSegment = {
          generatedColumn: genColumn,
          originalLine: origLine + 1,
          originalColumn: origColumn,
        };
        const segments = generatedToOriginal.get(genLine);
        if (segments) segments.push(segment);
        else generatedToOriginal.set(genLine, [segment]);

        const existing = originalToGenerated.get(segment.originalLine);
        if (
          !existing ||
          genLine < existing.lineNumber ||
          (genLine === existing.lineNumber && genColumn < existing.columnNumber)
        ) {
          originalToGenerated.set(segment.originalLine, {
            lineNumber: genLine,
            columnNumber: genColumn,
          });
        }
      }
    }
  } catch { /* corrupt source map — skip */ }
  return { generatedToOriginal, originalToGenerated };
}

function breakpointLocationKey(
  bp: Pick<BreakpointInfo, "entityType" | "entityName" | "line">,
): string {
  return `${bp.entityType}:${bp.entityName}:${bp.line}`;
}

// The debugger wire shapes now live in the L0 shared/ package (open). Imported for
// internal use by DebugManager and re-exported so existing callers import them from
// ./debug-manager.ts unchanged.
import type {
  BreakpointInfo,
  CallFrame,
  LogpointOutput,
  PauseState,
  Variable,
} from "../shared/debug.ts";
export type {
  BreakpointInfo,
  CallFrame,
  LogpointOutput,
  PauseState,
  Variable,
} from "../shared/debug.ts";

const INSPECTOR_URL_RE = /Debugger listening on (ws:\/\/\S+)/;
const INSPECTOR_EXIT_WAIT_RE = /Waiting for the debugger to disconnect/;

type DebugEventType =
  | "paused"
  | "resumed"
  | "started"
  | "stopped"
  | "error"
  | "logpoint";

// The CDP payload fields DebugManager actually reads — deliberately narrower than the
// protocol. `cdp.on` hands over `unknown`, so the cast at each `on(...)` call below is
// the single narrowing point for a wire payload from the debug runner's inspector.
// Every field is optional: V8 omits some depending on the pause site.
interface CdpCallFrame {
  callFrameId?: string;
  functionName?: string;
  url?: string;
  location?: { scriptId?: string; lineNumber?: number; columnNumber?: number };
  scopeChain?: unknown[];
}

interface CdpPausedParams {
  reason?: string;
  callFrames?: CdpCallFrame[];
}

interface CdpConsoleArg {
  value?: unknown;
  description?: string;
}

interface CdpConsoleParams {
  type?: string;
  args?: CdpConsoleArg[];
}

// A debug session: the preview proxied to a debug kernel (./debug-kernel.ts) on
// its own port, over a copy of the database, whose user code runs in a runner
// under the inspector. This class drives that inspector over CDP.
interface DebugSession {
  debug: DebugKernel;
  db: Database;
  appServer: AppServer;
}

export class DebugManager {
  private session: DebugSession | null = null;
  private cdp: CDPClient | null = null;
  private breakpoints = new Map<string, BreakpointInfo>();
  private _pauseState: PauseState | null = null;
  private _appPort = 0;
  private eventCallbacks = new Map<
    DebugEventType,
    Array<(data?: unknown) => void>
  >();
  private inspectorWsUrl: string | null = null;
  private inspectorUrlPromise: { resolve: (url: string) => void } | null = null;
  private scriptMap = new Map<string, string>();
  private sourceMaps = new Map<string, SourceMapIndex>();
  private breakpointsPath: string;
  private watchesPath: string;
  private _watches: string[] = [];
  private _debugDbTempDir: string | null = null;

  constructor(
    private kernel: Kernel,
    private appServer: AppServer,
    private projectDir: string,
  ) {
    this.breakpointsPath = join(projectDir, "breakpoints.json");
    this.watchesPath = join(projectDir, "watches.json");
    this.loadBreakpoints();
    this.loadWatches();
  }

  get active(): boolean {
    return this.session !== null;
  }
  get paused(): boolean {
    return this._pauseState !== null;
  }
  get pauseState(): PauseState | null {
    return this._pauseState;
  }
  get debugAppPort(): number {
    return this._appPort;
  }

  on(event: DebugEventType, callback: (data?: unknown) => void): void {
    const arr = this.eventCallbacks.get(event);
    if (arr) arr.push(callback);
    else this.eventCallbacks.set(event, [callback]);
  }

  private notify(event: DebugEventType, data?: unknown): void {
    this.eventCallbacks.get(event)?.forEach((fn) => fn(data));
  }

  async start(): Promise<void> {
    if (this.session) throw new Error("Debug session already active");

    this.clearCDPBreakpointIds();
    this._appPort = await findFreePort();

    const db = await Database.create(await this.buildDebugDbConfig());
    const runner = debugUserCodeRunner(
      this.projectDir,
      () => this.kernel,
      (text) => this.onRunnerStderr(text),
    );
    const built = await createDebugKernel(
      this.kernel,
      db,
      runner,
      this._appPort,
    );
    if (!built.ok) {
      await db.close();
      this.removeDbTempDir();
      throw new Error(built.error.message);
    }
    for (const error of built.data.errors) {
      this.kernel.log.log("warn", "system", `Debug: ${error}`);
    }
    const appServer = createAppServer(built.data.kernel, this._appPort);
    appServer.rebuild();
    const session: DebugSession = { debug: built.data, db, appServer };
    this.session = session;

    try {
      // Every entity instantiated in the runner before the inspector is
      // attached: Debugger.enable then reports each script.
      const mirror = await session.debug.bridge.mirror();
      if (!mirror.ok) throw new Error(mirror.error.message);
      const synced = await mirror.data.sync();
      if (!synced.ok) throw new Error(synced.error.message);
      void session.debug.bridge.host?.exited.then(() => {
        if (this.session !== session) return;
        void this.teardown();
        this.notify("error", "The debug session's runner exited unexpectedly");
        this.notify("stopped");
      });
      const wsUrl = await this.discoverInspectorUrl();
      this.cdp = new CDPClient(wsUrl);
      await this.cdp.connect();
    } catch (err) {
      await this.teardown();
      throw err;
    }

    // deno-lint-ignore no-explicit-any
    this.cdp.on("Debugger.scriptParsed", (params: any) => {
      const url = params.url || "";
      if (url?.startsWith("opentide://") && params.scriptId) {
        this.scriptMap.set(params.scriptId, url);
        if (params.sourceMapURL) {
          this.sourceMaps.set(url, buildSourceMapIndex(params.sourceMapURL));
        }
      }
    });
    this.cdp.on(
      "Debugger.paused",
      (params) => this.onPaused(params as CdpPausedParams),
    );
    this.cdp.on("Debugger.resumed", () => this.onResumed());
    this.cdp.on(
      "Runtime.consoleAPICalled",
      (params) => this.onConsoleAPI(params as CdpConsoleParams),
    );

    await this.cdp.send("Debugger.enable");
    await this.cdp.send("Runtime.enable");

    this.appServer.setProxy(this._appPort);

    // Warm up so V8 fully compiles handler/function bodies.
    // Without this, V8's lazy compilation prevents breakpoints from resolving.
    const base = `http://127.0.0.1:${this._appPort}`;
    const seen = new Set<string>();
    for (const r of this.kernel.routes.list()) {
      const key = `${r.method} ${r.path}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const path = r.path.replace(/:[^/]+/g, "__warmup__");
      try {
        await fetch(`${base}${path}`, { method: r.method }).then((res) =>
          res.body?.cancel()
        );
      } catch { /* best effort */ }
    }
    // Force V8 to fully parse all opentide:// scripts (handlers + functions)
    for (const [scriptId, url] of this.scriptMap) {
      if (!url.startsWith("opentide://")) continue;
      try {
        await this.cdp!.send("Debugger.getPossibleBreakpoints", {
          start: { scriptId, lineNumber: 0, columnNumber: 0 },
        });
      } catch { /* best effort */ }
    }

    // Apply breakpoints only after warmup. Applying them earlier can pause the
    // internal warmup request and stall debug session startup.
    for (const bp of this.breakpoints.values()) {
      if (!bp.enabled) continue;
      try {
        await this.applyCDPBreakpoint(bp);
      } catch (err) {
        const msg = err instanceof Error
          ? err.message
          : typeof err === "object"
          ? JSON.stringify(err)
          : String(err);
        this.kernel.log.log(
          "warn",
          "system",
          `Debug: failed to apply breakpoint ${bp.entityName}:${bp.line}: ${msg}`,
        );
      }
    }

    this.notify("started");
  }

  async stop(): Promise<void> {
    if (!this.session) return;
    await this.teardown();
    this.notify("stopped");
  }

  // --- Breakpoints ---

  async setBreakpoint(
    entityType: string,
    entityName: string,
    line: number,
    condition?: string,
    logMessage?: string,
  ): Promise<string> {
    const id = crypto.randomUUID();
    for (const existing of this.breakpoints.values()) {
      if (
        existing.entityType === entityType &&
        existing.entityName === entityName && existing.line === line
      ) {
        return existing.id;
      }
    }
    const bp: BreakpointInfo = {
      id,
      entityType,
      entityName,
      line,
      condition,
      logMessage,
      enabled: true,
    };
    this.breakpoints.set(id, bp);
    this.saveBreakpoints();

    if (this.cdp?.isConnected) {
      await this.applyCDPBreakpoint(bp);
    }
    return id;
  }

  async removeBreakpoint(id: string): Promise<void> {
    const bp = this.breakpoints.get(id);
    if (!bp) return;
    if (this.cdp?.isConnected && bp.cdpBreakpointId) {
      await this.cdp.send("Debugger.removeBreakpoint", {
        breakpointId: bp.cdpBreakpointId,
      });
    }
    this.breakpoints.delete(id);
    this.saveBreakpoints();
  }

  async toggleBreakpoint(id: string): Promise<void> {
    const bp = this.breakpoints.get(id);
    if (!bp) return;
    bp.enabled = !bp.enabled;
    this.saveBreakpoints();
    if (this.cdp?.isConnected) {
      if (!bp.enabled && bp.cdpBreakpointId) {
        await this.cdp.send("Debugger.removeBreakpoint", {
          breakpointId: bp.cdpBreakpointId,
        });
        bp.cdpBreakpointId = undefined;
      } else if (bp.enabled) {
        await this.applyCDPBreakpoint(bp);
      }
    }
  }

  listBreakpoints(): BreakpointInfo[] {
    return [...this.breakpoints.values()];
  }

  async removeAllBreakpoints(): Promise<void> {
    for (const bp of this.breakpoints.values()) {
      if (this.cdp?.isConnected && bp.cdpBreakpointId) {
        await this.cdp.send("Debugger.removeBreakpoint", {
          breakpointId: bp.cdpBreakpointId,
        });
      }
    }
    this.breakpoints.clear();
    this.saveBreakpoints();
  }

  async enableAllBreakpoints(enabled: boolean): Promise<void> {
    for (const bp of this.breakpoints.values()) {
      if (bp.enabled === enabled) continue;
      bp.enabled = enabled;
      if (this.cdp?.isConnected) {
        if (!enabled && bp.cdpBreakpointId) {
          await this.cdp.send("Debugger.removeBreakpoint", {
            breakpointId: bp.cdpBreakpointId,
          });
          bp.cdpBreakpointId = undefined;
        } else if (enabled) {
          await this.applyCDPBreakpoint(bp);
        }
      }
    }
    this.saveBreakpoints();
  }

  // --- Watch Expressions ---

  listWatches(): string[] {
    return [...this._watches];
  }

  addWatch(expression: string): void {
    if (!expression.trim() || this._watches.includes(expression)) return;
    this._watches.push(expression);
    this.saveWatches();
  }

  removeWatch(expression: string): void {
    this._watches = this._watches.filter((w) => w !== expression);
    this.saveWatches();
  }

  // --- Execution Control ---

  async resume(): Promise<void> {
    await this.cdp?.send("Debugger.resume");
  }

  async stepOver(): Promise<void> {
    await this.cdp?.send("Debugger.stepOver");
  }

  async stepInto(): Promise<void> {
    await this.cdp?.send("Debugger.stepInto");
  }

  async stepOut(): Promise<void> {
    await this.cdp?.send("Debugger.stepOut");
  }

  async pause(): Promise<void> {
    await this.cdp?.send("Debugger.pause");
  }

  // --- Variable Inspection ---

  async getVariables(callFrameId: string): Promise<Variable[]> {
    if (!this.cdp) return [];

    const frame = this._pauseState?.callFrames.find((f) =>
      f.callFrameId === callFrameId
    );
    if (!frame) return [];

    const variables: Variable[] = [];
    for (
      const scope of frame.scopeChain as Array<
        { type: string; object: { objectId: string } }
      >
    ) {
      if (scope.type === "global") continue;
      try {
        const result = await this.cdp.send("Runtime.getProperties", {
          objectId: scope.object.objectId,
          ownProperties: true,
        });
        variables.push(...mapCDPProperties(result.result));
      } catch { /* scope may not be expandable */ }
    }
    return variables;
  }

  async evaluate(
    expression: string,
    callFrameId?: string,
  ): Promise<
    { value: string; type: string; objectId?: string; error?: string }
  > {
    if (!this.cdp) throw new Error("No active debug session");

    const params: Record<string, unknown> = {
      expression,
      generatePreview: true,
    };
    const result = callFrameId
      ? await this.cdp.send("Debugger.evaluateOnCallFrame", {
        callFrameId,
        ...params,
      })
      : await this.cdp.send("Runtime.evaluate", params);

    if (result.exceptionDetails) {
      const desc = result.exceptionDetails.exception?.description ??
        result.exceptionDetails.text ??
        "Evaluation error";
      return { value: String(desc), type: "error", error: String(desc) };
    }
    const remote = result.result;
    return {
      value: remote?.description ?? String(remote?.value ?? "undefined"),
      type: remote?.type ?? "unknown",
      objectId: remote?.objectId,
    };
  }

  async expandObject(objectId: string): Promise<Variable[]> {
    if (!this.cdp) return [];
    const result = await this.cdp.send("Runtime.getProperties", {
      objectId,
      ownProperties: true,
    });
    return mapCDPProperties(result.result);
  }

  // --- Status ---

  status(): {
    active: boolean;
    paused: boolean;
    pauseState: PauseState | null;
    appPort: number;
    breakpoints: BreakpointInfo[];
    watches: string[];
  } {
    return {
      active: this.active,
      paused: this.paused,
      pauseState: this._pauseState,
      appPort: this._appPort,
      breakpoints: this.listBreakpoints(),
      watches: this.listWatches(),
    };
  }

  // --- Persistence ---

  private loadBreakpoints(): void {
    try {
      if (!existsSync(this.breakpointsPath)) return;
      const raw = JSON.parse(
        readFileSync(this.breakpointsPath, "utf-8"),
      ) as SerializedBreakpoint[];
      const seen = new Set<string>();
      let changed = false;
      for (const bp of raw) {
        const key = breakpointLocationKey(bp);
        if (seen.has(key)) {
          changed = true;
          continue;
        }
        seen.add(key);
        this.breakpoints.set(bp.id, { ...bp, cdpBreakpointId: undefined });
      }
      if (changed) this.saveBreakpoints();
    } catch { /* corrupt or missing file — start fresh */ }
  }

  private saveBreakpoints(): void {
    try {
      const data: SerializedBreakpoint[] = [...this.breakpoints.values()].map(
        ({ cdpBreakpointId: _, ...rest }) => rest,
      );
      writeFileSync(this.breakpointsPath, JSON.stringify(data, null, 2));
    } catch { /* best-effort — don't crash debug session */ }
  }

  private loadWatches(): void {
    try {
      if (!existsSync(this.watchesPath)) return;
      const raw = JSON.parse(readFileSync(this.watchesPath, "utf-8"));
      if (Array.isArray(raw)) {
        this._watches = raw.filter((w): w is string => typeof w === "string");
      }
    } catch { /* corrupt or missing file — start fresh */ }
  }

  private saveWatches(): void {
    try {
      writeFileSync(this.watchesPath, JSON.stringify(this._watches, null, 2));
    } catch { /* best-effort */ }
  }

  // --- Internals ---

  private async applyCDPBreakpoint(bp: BreakpointInfo): Promise<void> {
    if (bp.cdpBreakpointId) return;
    const url = `opentide://${bp.entityType}s/${bp.entityName}.ts`;
    const location = this.tsLineToV8Location(url, bp.line);
    if (
      !location && (bp.entityType === "handler" || bp.entityType === "function")
    ) {
      throw new Error(`Source map not loaded for ${url}`);
    }
    const resolved = location
      ? await this.resolveGeneratedBreakpointLocation(url, location)
      : null;
    const params: Record<string, unknown> = {
      url,
      lineNumber: resolved?.lineNumber ?? location?.lineNumber ?? bp.line - 1,
      columnNumber: resolved?.columnNumber ?? location?.columnNumber ?? 0,
    };
    if (bp.logMessage) {
      params.condition = buildLogpointCondition(
        bp.logMessage,
        bp.entityType,
        bp.entityName,
        bp.line,
      );
    } else if (bp.condition) {
      params.condition = bp.condition;
    }
    const result = await this.cdp!.send("Debugger.setBreakpointByUrl", params);
    bp.cdpBreakpointId = result.breakpointId;
  }

  private clearCDPBreakpointIds(): void {
    for (const bp of this.breakpoints.values()) {
      bp.cdpBreakpointId = undefined;
    }
  }

  private tsLineToV8Location(
    url: string,
    tsLine: number,
  ): GeneratedLocation | null {
    const smap = this.sourceMaps.get(url);
    if (!smap) return null;
    const exact = smap.originalToGenerated.get(tsLine);
    if (exact) return exact;

    for (let line = tsLine + 1; line <= tsLine + 20; line++) {
      const next = smap.originalToGenerated.get(line);
      if (next) return next;
    }
    return null;
  }

  private scriptIdForUrl(url: string): string | null {
    for (const [scriptId, scriptUrl] of this.scriptMap) {
      if (scriptUrl === url) return scriptId;
    }
    return null;
  }

  private async resolveGeneratedBreakpointLocation(
    url: string,
    location: GeneratedLocation,
  ): Promise<GeneratedLocation | null> {
    const scriptId = this.scriptIdForUrl(url);
    if (!scriptId || !this.cdp?.isConnected) return null;
    try {
      const result = await this.cdp.send("Debugger.getPossibleBreakpoints", {
        start: {
          scriptId,
          lineNumber: location.lineNumber,
          columnNumber: location.columnNumber,
        },
        end: { scriptId, lineNumber: location.lineNumber + 1, columnNumber: 0 },
      });
      const first = result.locations?.[0];
      if (
        typeof first?.lineNumber === "number" &&
        typeof first?.columnNumber === "number"
      ) {
        return {
          lineNumber: first.lineNumber,
          columnNumber: first.columnNumber,
        };
      }
    } catch { /* best-effort: fall back to source-map location */ }
    return null;
  }

  private v8LineToTsLine(url: string, v8Line: number, v8Column = 0): number {
    const smap = this.sourceMaps.get(url);
    if (smap) {
      const segments = smap.generatedToOriginal.get(v8Line);
      if (segments?.length) {
        let best = segments[0]!;
        for (const segment of segments) {
          if (segment.generatedColumn <= v8Column) best = segment;
          else break;
        }
        return best.originalLine;
      }
      // Find the nearest mapped line above
      for (let l = v8Line - 1; l >= 0; l--) {
        const nearest = smap.generatedToOriginal.get(l);
        if (nearest?.length) return nearest[nearest.length - 1]!.originalLine;
      }
    }
    return v8Line + 1; // fallback: 0-indexed → 1-indexed
  }

  private onPaused(params: CdpPausedParams): void {
    const callFrames: CallFrame[] = (params.callFrames ?? []).map(
      (f) => {
        const url = f.url ||
          (f.location?.scriptId
            ? this.scriptMap.get(f.location.scriptId)
            : undefined) ||
          "";
        const v8Line: number = f.location?.lineNumber ?? 0;
        const v8Column: number = f.location?.columnNumber ?? 0;
        return {
          callFrameId: f.callFrameId ?? "",
          functionName: f.functionName ?? "",
          url,
          entityType: resolveEntityType(url),
          entityName: resolveEntityName(url),
          line: url.startsWith("opentide://")
            ? this.v8LineToTsLine(url, v8Line, v8Column)
            : v8Line + 1,
          column: v8Column,
          scopeChain: f.scopeChain ?? [],
        };
      },
    );

    const userFrames = callFrames.filter((f) => f.entityType !== null);
    const top = userFrames[0] ?? callFrames[0];

    this._pauseState = {
      reason: params.reason ?? "breakpoint",
      callFrames,
      entityType: top?.entityType ?? null,
      entityName: top?.entityName ?? null,
      line: top?.line ?? 0,
    };

    this.notify("paused", this._pauseState);
  }

  private onResumed(): void {
    this._pauseState = null;
    this.notify("resumed");
  }

  private onConsoleAPI(params: CdpConsoleParams): void {
    if (params.type !== "log") return;
    const args = params.args ?? [];
    const prefix = args[0]?.value;
    if (typeof prefix !== "string" || !prefix.startsWith("[logpoint]")) return;

    const meta = prefix.match(/^\[logpoint\] (\w+):(.+):(\d+) /);
    if (!meta?.[1] || !meta[2] || !meta[3]) return;

    const message = args.map((a) => a.description ?? String(a.value ?? ""))
      .join(" ").replace(prefix, "").trim();

    const output: LogpointOutput = {
      entityType: meta[1],
      entityName: meta[2],
      line: Number(meta[3]),
      message: message || prefix.replace(/^\[logpoint\] \w+:.+:\d+ /, ""),
      timestamp: new Date().toISOString(),
    };
    this.notify("logpoint", output);
  }

  // A debug session gets its own copy of the database, so breakpointed code
  // cannot mutate the live one.
  //
  // This used to cpSync the data directory. That does not work: PGlite is
  // Postgres, the kernel has it OPEN, and Postgres writes those files while the
  // copy reads them — so the result is a torn snapshot that fails to open with
  // PgliteCorruptError. The failure is intermittent, which is why it read as
  // flakiness rather than as the bug it is: a small idle database usually
  // survives the race, a busy one does not.
  //
  // dumpDataDir is Postgres taking the snapshot itself, consistently, without
  // closing. Restoring it into a directory and closing that leaves an ordinary
  // data dir, which the debug kernel opens.
  private async buildDebugDbConfig(): Promise<DbConfig> {
    const pgUrl = readEnv(OPENTIDE_DB_URL_ENV);
    if (pgUrl) {
      return { driver: "postgres", connectionString: pgUrl };
    }
    this._debugDbTempDir = mkdtempSync(join(tmpdir(), "genie-debug-db-"));
    const snapshot = await this.kernel.db.snapshot();
    if (!snapshot) {
      throw new Error(
        "This database cannot produce a snapshot, so a debug session would have " +
          "to share the live one. Refusing rather than risk the project's data.",
      );
    }
    const { PGlite } = await import("@electric-sql/pglite");
    const restored = await PGlite.create({
      loadDataDir: snapshot,
      dataDir: this._debugDbTempDir,
    });
    await restored.close();
    return { driver: "pglite", dataDir: this._debugDbTempDir };
  }

  private async discoverInspectorUrl(): Promise<string> {
    if (this.inspectorWsUrl) return this.inspectorWsUrl;
    return new Promise<string>((resolve, reject) => {
      this.inspectorUrlPromise = { resolve };
      setTimeout(
        () =>
          reject(new Error("Could not discover V8 inspector WebSocket URL")),
        10_000,
      );
    });
  }

  // The runner's stderr, as it arrives. The inspector prints its address
  // there, and says when the runner is exiting: Deno then waits for the
  // debugger to detach before it goes (measured, Deno 2.9.8), so detach.
  private onRunnerStderr(text: string): void {
    if (INSPECTOR_EXIT_WAIT_RE.test(text)) {
      this.cdp?.close();
      this.cdp = null;
    }
    const m = text.match(INSPECTOR_URL_RE);
    if (!m) return;
    this.inspectorWsUrl = m[1]!;
    this.inspectorUrlPromise?.resolve(m[1]!);
    this.inspectorUrlPromise = null;
  }

  // Ends the session: the preview back on the live kernel, the inspector
  // detached, the runner stopped, the database copy closed and removed.
  private async teardown(): Promise<void> {
    const session = this.session;
    this.session = null;
    this.appServer.clearProxy();
    this.cdp?.close();
    this.cdp = null;
    this._pauseState = null;
    this.inspectorWsUrl = null;
    this.scriptMap.clear();
    this.sourceMaps.clear();
    this.clearCDPBreakpointIds();
    if (session) {
      await session.appServer.shutdown();
      await session.debug.kernel.runtime.dispose?.();
      await session.db.close();
    }
    this.removeDbTempDir();
  }

  // Remove the per-session PGlite copy, once it's closed. Idempotent.
  private removeDbTempDir(): void {
    if (!this._debugDbTempDir) return;
    try {
      rmSync(this._debugDbTempDir, { recursive: true });
    } catch { /* best effort */ }
    this._debugDbTempDir = null;
  }
}

type SerializedBreakpoint = Omit<BreakpointInfo, "cdpBreakpointId">;

type CDPProperty = {
  name: string;
  value?: {
    type: string;
    description?: string;
    value?: unknown;
    objectId?: string;
  };
};

function mapCDPProperties(props: unknown): Variable[] {
  return ((props ?? []) as CDPProperty[])
    .filter((p) => p.value)
    .map((p) => ({
      name: p.name,
      value: p.value!.description ?? String(p.value!.value ?? "undefined"),
      type: p.value!.type,
      objectId: p.value!.objectId,
    }));
}

function resolveEntityType(url: string): string | null {
  const m = url?.match(/^opentide:\/\/(\w+)\//);
  return m?.[1]?.replace(/s$/, "") ?? null;
}

function resolveEntityName(url: string): string | null {
  const m = url?.match(/^opentide:\/\/\w+\/(.+)\.ts$/);
  return m?.[1] ?? null;
}

function buildLogpointCondition(
  logMessage: string,
  entityType: string,
  entityName: string,
  line: number,
): string {
  const prefix = `[logpoint] ${entityType}:${entityName}:${line} `;
  const parts: string[] = [JSON.stringify(prefix)];
  let last = 0;
  const re = /\{([^}]+)\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(logMessage)) !== null) {
    if (m.index > last) {
      parts.push(JSON.stringify(logMessage.slice(last, m.index)));
    }
    parts.push(`(${m[1]})`);
    last = m.index + m[0].length;
  }
  if (last < logMessage.length) {
    parts.push(JSON.stringify(logMessage.slice(last)));
  }
  if (parts.length === 1) parts.push(JSON.stringify(logMessage));
  return `(console.log(${parts.join(", ")}), false)`;
}

async function findFreePort(): Promise<number> {
  const listener = Deno.listen({ hostname: DEV_SERVER_HOST, port: 0 });
  const port = (listener.addr as Deno.NetAddr).port;
  listener.close();
  return port;
}
