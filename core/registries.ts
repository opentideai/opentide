import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import {
  APP_SERVER_PORT,
  appPreviewUrl,
  getKernelSettings,
  LOG_PERSIST_DEBOUNCE_MS,
} from "./config.ts";
import { encodeBase64 } from "./util.ts";
import type { CodebaseGraph } from "./codebase/types.ts";
import { createTimestampedId } from "./ids.ts";
import {
  buildEpisode,
  computeSurvivalObservations,
  EpisodeLog,
  mapActionToOp,
  statusToHumanDecision,
  summarizeVerification,
} from "./episodes.ts";
import { buildKnowledgeGraph } from "./knowledge-graph.ts";
import type { ChangeRecord } from "../shared/changelog.ts";

// A2 (Stream A): mint a fresh stable entity id. Format `ent_<time><rand>` chosen
// so a future symbol identity (B1) can reuse the format (plan §S2). Used by every
// code-entity registry's mint-once-preserve rule below.
const ENTITY_UID_PREFIX = "ent";
function mintEntityUid(): string {
  return createTimestampedId(ENTITY_UID_PREFIX);
}
import type {
  AssetEntry,
  CompileDeps,
  ConfigEntry,
  ConfigRegistry,
  FunctionEntry,
  FunctionRegistry,
  HandlerEntry,
  HandlerFn,
  LogEntry,
  LogLevel,
  LogSource,
  RequestLogEntry,
  RouteEntry,
  RouteSchema,
  TemplateEntry,
  TemplateRegistry,
  TestEntry,
  TestFn,
  TestVerificationMetadata,
  TypeEntry,
  TypeFieldDef,
} from "./types.ts";
import type { Database } from "./db.ts";
import { SnapshotManager } from "./snapshots.ts";
import { Changelog } from "./changelog.ts";
import { DevViewMap } from "./dev-views.ts";
import { DevToolMap } from "./dev-tools.ts";
import { BranchManager } from "./branches.ts";
import { SessionManager } from "./sessions.ts";
import { SkillManager } from "./skills.ts";
import { DocumentStore } from "./documents.ts";
import type { AuditStore, ChangesetStore, McpAuditStore } from "./types.ts";
import { LiveSessions } from "./session-liveness.ts";
import type { DrizzleDb } from "./db/factory.ts";
import { type CompositionContext, coreOnlyComposition } from "./composition.ts";
import { PackageMap } from "./packages.ts";
import { loadEnv, saveEnv } from "./env.ts";
import { SecretsStore } from "./secrets.ts";
import { EnvVarStore } from "./env-vars.ts";
import {
  tracedDb,
  tracedFunctions,
  tracedTemplates,
  Tracer,
} from "./tracer.ts";
import { CustomAuditMap } from "./custom-audits.ts";
import { buildHandlerDb } from "./handler-db.ts";
import {
  DEFAULT_RUNTIME_ID,
  getDefaultRuntimeRegistry,
  type RuntimeAdapter,
} from "./runtime.ts";

// --- Route Registry ---

export class RouteMap {
  private routes = new Map<string, RouteEntry>();

  private key(method: string, path: string): string {
    return `${method.toUpperCase()} ${path}`;
  }

  register(
    method: string,
    path: string,
    handlerName: string,
    schema?: RouteSchema,
    module?: string,
  ): void {
    const k = this.key(method, path);
    this.routes.set(k, {
      method: method.toUpperCase(),
      path,
      handlerName,
      registeredAt: new Date().toISOString(),
      ...(schema ? { schema } : {}),
      ...(module ? { module } : {}),
    });
  }

  unregister(method: string, path: string): boolean {
    return this.routes.delete(this.key(method, path));
  }

  get(method: string, path: string): RouteEntry | undefined {
    return this.routes.get(this.key(method, path));
  }

  list(): RouteEntry[] {
    return [...this.routes.values()];
  }

  clear(): void {
    this.routes.clear();
  }

  restore(entries: RouteEntry[]): void {
    this.routes.clear();
    for (const e of entries) {
      this.routes.set(this.key(e.method, e.path), e);
    }
  }
}

// --- Handler Registry ---

export class HandlerMap {
  private handlers = new Map<string, HandlerEntry>();

  register(
    name: string,
    source: string,
    fn: HandlerFn,
    schema?: RouteSchema,
    module?: string,
    runtimeId?: string,
    language?: string,
    purpose?: string,
    revision?: number,
    entityUid?: string,
  ): void {
    this.handlers.set(name, {
      name,
      source,
      fn,
      registeredAt: new Date().toISOString(),
      // An explicit revision (persistence restore) is preserved verbatim; a live
      // define_* write omits it and bumps the prior revision, so every accepted
      // write is monotonic (docs/lsp-support-plan.md Stage 5).
      revision: revision ?? (this.handlers.get(name)?.revision ?? 0) + 1,
      // A2: mint once, then preserve. An explicit uid (persistence restore) wins;
      // else carry the prior entry's uid across the update; else this is a fresh
      // create so mint. Restore of pre-A2 state passes undefined → mints (migration).
      entityUid: entityUid ?? this.handlers.get(name)?.entityUid ??
        mintEntityUid(),
      ...(schema ? { schema } : {}),
      ...(module ? { module } : {}),
      ...(runtimeId ? { runtimeId } : {}),
      ...(language ? { language } : {}),
      ...(purpose ? { purpose } : {}),
    });
  }

  get(name: string): HandlerEntry | undefined {
    return this.handlers.get(name);
  }

  getFn(name: string): HandlerFn | undefined {
    return this.handlers.get(name)?.fn;
  }

  list(): HandlerEntry[] {
    return [...this.handlers.values()];
  }

  remove(name: string): boolean {
    return this.handlers.delete(name);
  }

  clear(): void {
    this.handlers.clear();
  }

  serialize(): Array<
    {
      name: string;
      source: string;
      registeredAt: string;
      revision: number;
      entityUid: string;
      schema?: RouteSchema;
      module?: string;
      purpose?: string;
      runtimeId?: string;
      language?: string;
    }
  > {
    return this.list().map((
      {
        name,
        source,
        registeredAt,
        revision,
        entityUid,
        schema,
        module,
        runtimeId,
        language,
        purpose,
      },
    ) => ({
      name,
      source,
      registeredAt,
      revision,
      entityUid,
      ...(schema ? { schema } : {}),
      ...(module ? { module } : {}),
      ...(purpose ? { purpose } : {}),
      ...(runtimeId ? { runtimeId } : {}),
      ...(language ? { language } : {}),
    }));
  }
}

// --- Function Registry ---

export class FunctionMap implements FunctionRegistry {
  private fns = new Map<string, FunctionEntry>();

  register(
    name: string,
    source: string,
    fn: (...args: unknown[]) => unknown,
    module?: string,
    returnType?: string,
    runtimeId?: string,
    language?: string,
    purpose?: string,
    revision?: number,
    entityUid?: string,
  ): void {
    this.fns.set(name, {
      name,
      source,
      fn,
      registeredAt: new Date().toISOString(),
      // See HandlerMap.register: explicit revision preserved on restore, else bumped.
      revision: revision ?? (this.fns.get(name)?.revision ?? 0) + 1,
      // A2: mint once, preserve across updates. See HandlerMap.register.
      entityUid: entityUid ?? this.fns.get(name)?.entityUid ?? mintEntityUid(),
      ...(returnType ? { returnType } : {}),
      ...(module ? { module } : {}),
      ...(runtimeId ? { runtimeId } : {}),
      ...(language ? { language } : {}),
      ...(purpose ? { purpose } : {}),
    });
  }

  get(name: string): ((...args: unknown[]) => unknown) | undefined {
    return this.fns.get(name)?.fn;
  }

  getEntry(name: string): FunctionEntry | undefined {
    return this.fns.get(name);
  }

  call(name: string, ...args: unknown[]): unknown {
    const fn = this.get(name);
    if (!fn) throw new Error(`Function "${name}" not found in registry`);
    return fn(...args);
  }

  list(): FunctionEntry[] {
    return [...this.fns.values()];
  }

  remove(name: string): boolean {
    return this.fns.delete(name);
  }

  clear(): void {
    this.fns.clear();
  }

  serialize(): Array<
    {
      name: string;
      source: string;
      registeredAt: string;
      revision: number;
      entityUid: string;
      returnType?: string;
      module?: string;
      purpose?: string;
      runtimeId?: string;
      language?: string;
    }
  > {
    return this.list().map((
      {
        name,
        source,
        registeredAt,
        revision,
        entityUid,
        returnType,
        module,
        runtimeId,
        language,
        purpose,
      },
    ) => ({
      name,
      source,
      registeredAt,
      revision,
      entityUid,
      ...(returnType ? { returnType } : {}),
      ...(module ? { module } : {}),
      ...(purpose ? { purpose } : {}),
      ...(runtimeId ? { runtimeId } : {}),
      ...(language ? { language } : {}),
    }));
  }
}

// --- Type Registry ---

export class TypeMap {
  private types = new Map<string, TypeEntry>();

  register(
    name: string,
    fields: TypeFieldDef[],
    description?: string,
    module?: string,
    entityUid?: string,
  ): void {
    this.types.set(name, {
      name,
      fields,
      ...(description ? { description } : {}),
      registeredAt: new Date().toISOString(),
      ...(module ? { module } : {}),
      // A2: mint once, preserve across updates. See HandlerMap.register.
      entityUid: entityUid ?? this.types.get(name)?.entityUid ??
        mintEntityUid(),
    });
  }

  get(name: string): TypeEntry | undefined {
    return this.types.get(name);
  }

  list(): TypeEntry[] {
    return [...this.types.values()];
  }

  remove(name: string): boolean {
    return this.types.delete(name);
  }

  clear(): void {
    this.types.clear();
  }

  serialize(): Array<
    {
      name: string;
      fields: TypeFieldDef[];
      description?: string;
      registeredAt: string;
      module?: string;
      entityUid: string;
    }
  > {
    return this.list().map((
      { name, fields, description, registeredAt, module, entityUid },
    ) => ({
      name,
      fields,
      ...(description ? { description } : {}),
      registeredAt,
      ...(module ? { module } : {}),
      entityUid,
    }));
  }
}

// --- Test Registry ---

export class TestMap {
  private tests = new Map<string, TestEntry>();

  register(
    name: string,
    source: string,
    fn: TestFn,
    module?: string,
    changesetId?: string,
    runtimeId?: string,
    language?: string,
    verification?: TestVerificationMetadata,
    entityUid?: string,
  ): void {
    const existing = this.tests.get(name);
    this.tests.set(name, {
      name,
      source,
      fn,
      registeredAt: new Date().toISOString(),
      // A2: mint once, preserve across updates. See HandlerMap.register.
      entityUid: entityUid ?? existing?.entityUid ?? mintEntityUid(),
      ...(module ? { module } : {}),
      ...(changesetId
        ? { changesetId }
        : existing?.changesetId
        ? { changesetId: existing.changesetId }
        : {}),
      ...(verification ?? existing?.verification
        ? { verification: verification ?? existing?.verification }
        : {}),
      lastResult: existing?.lastResult,
      ...(runtimeId ? { runtimeId } : {}),
      ...(language ? { language } : {}),
    });
  }

  updateResult(name: string, result: import("./types.ts").TestResult): void {
    const entry = this.tests.get(name);
    if (entry) entry.lastResult = result;
  }

  clearResult(name: string): void {
    const entry = this.tests.get(name);
    if (entry) delete entry.lastResult;
  }

  get(name: string): TestEntry | undefined {
    return this.tests.get(name);
  }

  list(): TestEntry[] {
    return [...this.tests.values()];
  }

  remove(name: string): boolean {
    return this.tests.delete(name);
  }

  clear(): void {
    this.tests.clear();
  }

  serialize(): Array<
    {
      name: string;
      source: string;
      registeredAt: string;
      entityUid: string;
      module?: string;
      changesetId?: string;
      verification?: TestVerificationMetadata;
      lastResult?: import("./types.ts").TestResult;
      runtimeId?: string;
      language?: string;
    }
  > {
    return this.list().map((
      {
        name,
        source,
        registeredAt,
        entityUid,
        module,
        changesetId,
        verification,
        lastResult,
        runtimeId,
        language,
      },
    ) => ({
      name,
      source,
      registeredAt,
      entityUid,
      ...(module ? { module } : {}),
      ...(changesetId ? { changesetId } : {}),
      ...(verification ? { verification } : {}),
      ...(lastResult ? { lastResult } : {}),
      ...(runtimeId ? { runtimeId } : {}),
      ...(language ? { language } : {}),
    }));
  }
}

// --- Config Registry ---

export class ConfigMap implements ConfigRegistry {
  private configs = new Map<string, ConfigEntry>();

  set(
    name: string,
    value: unknown,
    description?: string,
    module?: string,
    entityUid?: string,
  ): void {
    assertJsonSerializableConfig(value);
    const existing = this.configs.get(name);
    this.configs.set(name, {
      name,
      value,
      description: description ?? existing?.description,
      updatedAt: new Date().toISOString(),
      ...(module ?? existing?.module
        ? { module: module ?? existing?.module }
        : {}),
      // A2: mint once, preserve across updates. See HandlerMap.register.
      entityUid: entityUid ?? existing?.entityUid ?? mintEntityUid(),
    });
  }

  get(name: string): unknown {
    return this.configs.get(name)?.value;
  }

  getEntry(name: string): ConfigEntry | undefined {
    return this.configs.get(name);
  }

  delete(name: string): boolean {
    return this.configs.delete(name);
  }

  list(): Array<
    {
      name: string;
      type: string;
      description?: string;
      updatedAt: string;
      module?: string;
    }
  > {
    return [...this.configs.values()].map((e) => ({
      name: e.name,
      type: typeof e.value,
      ...(e.description ? { description: e.description } : {}),
      updatedAt: e.updatedAt,
      ...(e.module ? { module: e.module } : {}),
    }));
  }

  clear(): void {
    this.configs.clear();
  }

  serialize(): Array<
    {
      name: string;
      value: unknown;
      description?: string;
      updatedAt: string;
      module?: string;
      entityUid: string;
    }
  > {
    return [...this.configs.values()].map((
      { name, value, description, updatedAt, module, entityUid },
    ) => ({
      name,
      value,
      ...(description ? { description } : {}),
      updatedAt,
      ...(module ? { module } : {}),
      entityUid,
    }));
  }

  restore(
    entries: Array<
      {
        name: string;
        value: unknown;
        description?: string;
        updatedAt: string;
        module?: string;
        entityUid?: string;
      }
    >,
  ): void {
    this.configs.clear();
    for (const e of entries) {
      assertJsonSerializableConfig(e.value);
      this.configs.set(e.name, {
        name: e.name,
        value: e.value,
        ...(e.description ? { description: e.description } : {}),
        updatedAt: e.updatedAt,
        ...(e.module ? { module: e.module } : {}),
        // A2: preserve the persisted uid; mint if migrating pre-A2 state.
        entityUid: e.entityUid ?? mintEntityUid(),
      });
    }
  }
}

function assertJsonSerializableConfig(
  value: unknown,
  path = "value",
  seen = new Set<object>(),
): void {
  if (value === null) return;

  const type = typeof value;
  if (type === "string" || type === "boolean") return;
  if (type === "number") {
    if (!Number.isFinite(value)) {
      throw new Error(`Config ${path} must be a finite number`);
    }
    return;
  }
  if (
    type === "undefined" || type === "function" || type === "symbol" ||
    type === "bigint"
  ) {
    throw new Error(`Config ${path} must be JSON-serializable`);
  }

  if (typeof value !== "object") return;

  if (seen.has(value)) {
    throw new Error(`Config ${path} must not contain circular references`);
  }

  const withToJson = value as { toJSON?: () => unknown };
  if (typeof withToJson.toJSON === "function") {
    assertJsonSerializableConfig(withToJson.toJSON(), `${path}.toJSON()`, seen);
    return;
  }

  seen.add(value);
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      assertJsonSerializableConfig(value[i], `${path}[${i}]`, seen);
    }
  } else {
    for (
      const [key, child] of Object.entries(value as Record<string, unknown>)
    ) {
      assertJsonSerializableConfig(child, `${path}.${key}`, seen);
    }
  }
  seen.delete(value);
}

// --- Asset Registry ---

// An asset name / module becomes a single path segment in the export tree
// (`<module>/assets/<name>`) and in the `/_assets/:name` route. It must not
// contain a path separator or be a traversal token, or it could escape the
// export output directory (F-08 defense-in-depth, alongside the containment
// guard in `writeExportFiles`). Kept here next to the registry it protects.
export function isSafePathSegment(segment: string): boolean {
  return segment.length > 0 &&
    !segment.includes("/") &&
    !segment.includes("\\") &&
    !segment.includes("\0") &&
    segment !== "." &&
    segment !== "..";
}

export class AssetMap {
  private assets = new Map<string, AssetEntry>();

  register(
    name: string,
    content: Uint8Array,
    mimeType: string,
    module?: string,
    entityUid?: string,
  ): void {
    this.assets.set(name, {
      name,
      content,
      mimeType,
      size: content.byteLength,
      registeredAt: new Date().toISOString(),
      ...(module ? { module } : {}),
      // A2: mint once, preserve across updates. See HandlerMap.register.
      entityUid: entityUid ?? this.assets.get(name)?.entityUid ??
        mintEntityUid(),
    });
  }

  get(name: string): AssetEntry | undefined {
    return this.assets.get(name);
  }

  list(): Array<
    {
      name: string;
      mimeType: string;
      size: number;
      registeredAt: string;
      module?: string;
    }
  > {
    return [...this.assets.values()].map((
      { name, mimeType, size, registeredAt, module },
    ) => ({
      name,
      mimeType,
      size,
      registeredAt,
      ...(module ? { module } : {}),
    }));
  }

  remove(name: string): boolean {
    return this.assets.delete(name);
  }

  clear(): void {
    this.assets.clear();
  }

  serialize(): Array<
    {
      name: string;
      contentBase64: string;
      mimeType: string;
      registeredAt: string;
      module?: string;
      entityUid: string;
    }
  > {
    return [...this.assets.values()].map((
      { name, content, mimeType, registeredAt, module, entityUid },
    ) => ({
      name,
      contentBase64: encodeBase64(content),
      mimeType,
      registeredAt,
      ...(module ? { module } : {}),
      entityUid,
    }));
  }

  restore(
    entries: Array<
      {
        name: string;
        contentBase64: string;
        mimeType: string;
        registeredAt: string;
        module?: string;
        entityUid?: string;
      }
    >,
  ): void {
    this.assets.clear();
    for (const e of entries) {
      const binary = atob(e.contentBase64);
      const content = Uint8Array.from(binary, (c) => c.charCodeAt(0));
      this.assets.set(e.name, {
        name: e.name,
        content,
        mimeType: e.mimeType,
        size: content.byteLength,
        registeredAt: e.registeredAt,
        ...(e.module ? { module: e.module } : {}),
        // A2: preserve the persisted uid; mint if migrating pre-A2 state.
        entityUid: e.entityUid ?? mintEntityUid(),
      });
    }
  }
}

// --- Template Registry ---

export class TemplateMap implements TemplateRegistry {
  private templates = new Map<string, TemplateEntry>();

  register(
    name: string,
    content: string,
    module?: string,
    entityUid?: string,
  ): void {
    this.templates.set(name, {
      name,
      content,
      registeredAt: new Date().toISOString(),
      ...(module ? { module } : {}),
      // A2: mint once, preserve across updates. See HandlerMap.register.
      entityUid: entityUid ?? this.templates.get(name)?.entityUid ??
        mintEntityUid(),
    });
  }

  get(name: string): string | undefined {
    return this.templates.get(name)?.content;
  }

  getEntry(name: string): TemplateEntry | undefined {
    return this.templates.get(name);
  }

  list(): TemplateEntry[] {
    return [...this.templates.values()];
  }

  remove(name: string): boolean {
    return this.templates.delete(name);
  }

  clear(): void {
    this.templates.clear();
  }

  serialize(): Array<
    {
      name: string;
      content: string;
      registeredAt: string;
      module?: string;
      entityUid: string;
    }
  > {
    return this.list().map((
      { name, content, registeredAt, module, entityUid },
    ) => ({
      name,
      content,
      registeredAt,
      ...(module ? { module } : {}),
      entityUid,
    }));
  }

  restore(
    entries: Array<
      {
        name: string;
        content: string;
        registeredAt: string;
        module?: string;
        entityUid?: string;
      }
    >,
  ): void {
    this.templates.clear();
    for (const e of entries) {
      // A2: preserve the persisted uid; mint if migrating pre-A2 state.
      this.templates.set(e.name, {
        ...e,
        entityUid: e.entityUid ?? mintEntityUid(),
      });
    }
  }
}

// --- Request & Error Logs (ring buffers) ---

export class LogBuffer<T> {
  private buffer: (T | undefined)[];
  private head = 0;
  private count = 0;
  private maxSize: number;

  constructor(maxSize = 100) {
    this.maxSize = maxSize;
    this.buffer = new Array(maxSize);
  }

  get size(): number {
    return this.count;
  }

  push(entry: T): void {
    this.buffer[this.head] = entry;
    this.head = (this.head + 1) % this.maxSize;
    if (this.count < this.maxSize) this.count++;
  }

  recent(limit: number): T[] {
    const n = Math.min(limit, this.count);
    const result: T[] = [];
    for (let i = n; i > 0; i--) {
      const idx = (this.head - i + this.maxSize) % this.maxSize;
      result.push(this.buffer[idx] as T);
    }
    return result;
  }

  clear(): void {
    this.buffer = new Array(this.maxSize);
    this.head = 0;
    this.count = 0;
  }
}

// --- Unified Kernel Log ---

export interface LogQueryOptions {
  level?: string;
  source?: string;
  limit?: number;
  search?: string;
}

interface PersistedKernelLog {
  version: 1;
  nextId: number;
  entries: LogEntry[];
}

export class KernelLog {
  private buffer: LogBuffer<LogEntry>;
  private nextId = 1;
  private persistPath: string | null = null;
  private persistWritesEnabled = true;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(maxSize = 500) {
    this.buffer = new LogBuffer<LogEntry>(maxSize);
  }

  log(
    level: LogLevel,
    source: LogSource,
    message: string,
    opts?: {
      route?: string;
      stack?: string;
      metadata?: Record<string, unknown>;
    },
  ): void {
    this.buffer.push({
      id: this.nextId++,
      timestamp: new Date().toISOString(),
      level,
      source,
      message,
      route: opts?.route,
      stack: opts?.stack,
      metadata: opts?.metadata,
    });
    this.scheduleSave();
  }

  query(opts: LogQueryOptions = {}): LogEntry[] {
    const limit = opts.limit ?? 100;
    const hasFilter = !!(opts.level || opts.source || opts.search);
    const all = this.buffer.recent(hasFilter ? this.buffer.size : limit);
    let result = all;
    if (opts.level) {
      result = result.filter((e) => e.level === opts.level);
    }
    if (opts.source) {
      result = result.filter((e) => e.source === opts.source);
    }
    if (opts.search) {
      const q = opts.search.toLowerCase();
      result = result.filter((e) =>
        e.message.toLowerCase().includes(q) ||
        (e.route?.toLowerCase().includes(q) ?? false)
      );
    }
    return result.slice(-limit);
  }

  recent(limit: number): LogEntry[] {
    return this.buffer.recent(limit);
  }

  clear(): void {
    this.buffer.clear();
    this.nextId = 1;
    this.save();
  }

  serialize(): PersistedKernelLog {
    return {
      version: 1,
      nextId: this.nextId,
      entries: this.buffer.recent(this.buffer.size),
    };
  }

  restore(entries: LogEntry[], nextId?: number): void {
    this.persistWritesEnabled = false;
    try {
      this.buffer.clear();
      let maxId = 0;
      for (const entry of entries) {
        if (!isLogEntry(entry)) continue;
        this.buffer.push(entry);
        maxId = Math.max(maxId, entry.id);
      }
      this.nextId = Math.max(nextId ?? 1, maxId + 1, 1);
    } finally {
      this.persistWritesEnabled = true;
    }
    this.save();
  }

  loadFromFile(filePath: string): string[] {
    this.persistPath = filePath;
    if (!existsSync(filePath)) return [];

    try {
      const parsed = JSON.parse(readFileSync(filePath, "utf-8")) as
        | PersistedKernelLog
        | LogEntry[];
      const entries = Array.isArray(parsed) ? parsed : parsed.entries;
      const rawNextId = Array.isArray(parsed) ? undefined : parsed.nextId;
      const nextId = typeof rawNextId === "number" &&
          Number.isFinite(rawNextId)
        ? rawNextId
        : undefined;
      this.restore(Array.isArray(entries) ? entries : [], nextId);
      return [];
    } catch (err) {
      return [
        `Log cache is corrupted (${
          err instanceof Error ? err.message : String(err)
        }). Clear ${filePath} to reset persisted logs.`,
      ];
    }
  }

  // Debounce per-log() persistence. Writing the whole ring buffer on every
  // entry blocks the event loop under request volume; coalesce instead. The
  // timer is unref'd so it never keeps the process alive — clear/restore/
  // shutdown still flush synchronously via save().
  private scheduleSave(): void {
    if (!this.persistPath || !this.persistWritesEnabled) return;
    if (this.flushTimer !== null) return;
    const timer = setTimeout(() => {
      this.flushTimer = null;
      this.save();
    }, LOG_PERSIST_DEBOUNCE_MS);
    this.flushTimer = timer;
    if (typeof Deno !== "undefined" && typeof Deno.unrefTimer === "function") {
      Deno.unrefTimer(timer);
    }
  }

  save(): void {
    if (this.flushTimer !== null) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (!this.persistPath || !this.persistWritesEnabled) return;
    try {
      mkdirSync(dirname(this.persistPath), { recursive: true });
      const tmpPath = `${this.persistPath}.tmp`;
      writeFileSync(tmpPath, JSON.stringify(this.serialize(), null, 2) + "\n");
      renameSync(tmpPath, this.persistPath);
    } catch {
      // Logging must never break handler execution.
    }
  }
}

function isLogEntry(value: unknown): value is LogEntry {
  if (!value || typeof value !== "object") return false;
  const entry = value as Partial<LogEntry>;
  return typeof entry.id === "number" &&
    Number.isFinite(entry.id) &&
    typeof entry.timestamp === "string" &&
    isLogLevel(entry.level) &&
    isLogSource(entry.source) &&
    typeof entry.message === "string";
}

function isLogLevel(value: unknown): value is LogLevel {
  return value === "debug" || value === "info" || value === "warn" ||
    value === "error";
}

function isLogSource(value: unknown): value is LogSource {
  return value === "handler" || value === "system" || value === "script" ||
    value === "agent" || value === "app";
}

// --- Env Registry ---

export class EnvMap {
  private vars: Record<string, string> = {};
  private projectDir: string | null = null;

  load(projectDir: string): void {
    this.projectDir = projectDir;
    this.vars = loadEnv(projectDir);
  }

  get(name: string): string | undefined {
    return this.vars[name];
  }

  set(name: string, value: string): void {
    this.vars[name] = value;
    this.persist();
  }

  delete(name: string): boolean {
    if (!(name in this.vars)) return false;
    delete this.vars[name];
    this.persist();
    return true;
  }

  list(): Array<{ name: string; value: string }> {
    return Object.entries(this.vars).map(([name, value]) => ({ name, value }));
  }

  all(): Record<string, string> {
    return { ...this.vars };
  }

  private persist(): void {
    if (this.projectDir) saveEnv(this.projectDir, this.vars);
  }
}

// --- Kernel: combines all registries ---

const NO_STORE_FACTORY =
  "No store factory in the Kernel's composition — load the project with a " +
  "composition that assembles verification (verificationOnlyComposition in " +
  "cli/assembly.ts), or pass a test " +
  "composition, before using changesets/audits.";

// A registry entity was written (define_* accepted a create/update). Emitted by the
// tool dispatch after the registry mutation + changelog record, carrying the entity
// coordinates and its NEW revision (docs/lsp-support-plan.md Stage 5). The seam an
// out-of-band observer subscribes to: the LSP server (L2) uses it to learn an agent
// wrote an entity a human has open, so it can push a refresh — a downward dependency
// (subscribers import core), no upward import.
export interface EntityChangeEvent {
  entityType: string;
  entityName: string;
  revision: number;
}

export type EntityChangeListener = (event: EntityChangeEvent) => void;

export class Kernel {
  readonly routes = new RouteMap();
  readonly handlers = new HandlerMap();
  readonly functions = new FunctionMap();
  readonly tests = new TestMap();
  readonly configs = new ConfigMap();
  readonly templates = new TemplateMap();
  readonly assets = new AssetMap();
  readonly packages = new PackageMap();
  readonly env = new EnvMap();
  readonly secrets = new SecretsStore();
  readonly envVars: EnvVarStore;
  readonly log = new KernelLog();
  readonly requestLog = new LogBuffer<RequestLogEntry>();
  readonly devViews = new DevViewMap();
  readonly devTools = new DevToolMap();
  readonly customAudits = new CustomAuditMap();
  readonly types = new TypeMap();
  readonly snapshots = new SnapshotManager();
  readonly branches = new BranchManager();
  readonly changelog: Changelog;
  readonly sessions: SessionManager;
  // MCP clients connected to this process (core/session-liveness.ts).
  readonly liveSessions = new LiveSessions();
  // A4 (Stream A): the append-only episode + survival log. Present only when the
  // Kernel is file-backed (a real historyDir); a DB-only test kernel has no history
  // dir, so this stays null and episode emission no-ops gracefully.
  readonly episodeLog: EpisodeLog | null;
  readonly skills: SkillManager;
  // Document store (docs/document-store-plan.md). Derives its blob root from the
  // active projectDir at call time (resolver below), so it works before/after
  // loadProject; global docs live under the user config root.
  readonly documents: DocumentStore;
  readonly db: Database;
  // changesets/audits are lazy getters (below): built via the composition's
  // store factories (composition.ts) so core never imports the verification managers.
  private _changesetStorage!: DrizzleDb | string;
  private _changesets?: ChangesetStore;
  private _audits?: AuditStore;
  private _mcpAudit?: McpAuditStore;
  readonly tracer = new Tracer();
  readonly runtimeId: string;
  readonly runtime: RuntimeAdapter;
  // The assembled upper-layer seams (stores, audit provider, tool handlers,
  // init hooks). Defaults to coreOnlyComposition() so a bare Kernel boots
  // standalone; the composition root threads the full context in via loadProject.
  readonly composition: CompositionContext;
  projectDir: string | null = null;
  appPort = APP_SERVER_PORT;
  // Latest source-backed codebase index (project-import Slice 1). Populated by
  // the index_codebase tool and served read-only over GET /api/codebase. Purely
  // in-memory: re-index on demand rather than persist — lifecycle (staleness,
  // auto-refresh) is a later slice. Null until a first index runs.
  codebaseGraph: CodebaseGraph | null = null;
  // In-memory subscribers to entity writes (Stage 5 out-of-band refresh). One process
  // typically has one LSP server per Kernel; the Set makes multiple subscribers and
  // idempotent unsubscribe safe. Not persisted — purely a live-notification seam.
  private readonly entityChangeListeners = new Set<EntityChangeListener>();

  constructor(
    db: Database,
    opts?: {
      historyDir?: string;
      runtimeId?: string;
      composition?: CompositionContext;
    },
  ) {
    this.db = db;
    this.runtime = getDefaultRuntimeRegistry().resolve(
      opts?.runtimeId ?? DEFAULT_RUNTIME_ID,
    );
    this.runtimeId = this.runtime.id;
    this.composition = opts?.composition ?? coreOnlyComposition();
    this.changelog = new Changelog(opts?.historyDir ?? db.drizzle);
    this.sessions = new SessionManager(opts?.historyDir ?? db.drizzle);
    this.skills = new SkillManager(db.drizzle);
    this.documents = new DocumentStore(db.drizzle, () => this.projectDir);
    this._changesetStorage = opts?.historyDir ?? db.drizzle;
    this.envVars = new EnvVarStore(this.env);
    // A2 (Stream A): let the changelog stamp each change with its entity's stable
    // uid, resolved from the record's (category, key). One wire-up covers every
    // record() writer — no per-site edits. See docs/stream-a-data-foundation-plan.md.
    this.changelog.setEntityUidResolver((category, key) =>
      this.entityUidFor(category, key)
    );
    // A4 (Stream A): wire the immutable episode log. Only when file-backed (a real
    // historyDir) AND enabled — episodeLogEnabled defaults true (this is local, not
    // egress). The onChange hook closes over `this`, giving episode composition the
    // full kernel context (entity sources, changeset verification state) that
    // changelog.record() lacks; it fires once per uid-bearing record and no-ops for
    // records with no minted identity (routes/infra). See docs/…-plan.md §4 A4.
    this.episodeLog = typeof opts?.historyDir === "string" &&
        getKernelSettings().episodeLogEnabled
      ? new EpisodeLog(opts.historyDir)
      : null;
    if (this.episodeLog) {
      this.changelog.onChange((record) => this.emitEpisode(record));
    }
  }

  // A4: compose and append one VerificationEpisode for a just-recorded change. The
  // crux emit point (plan §4 A4.2): resolved as the facade `onChange` hook wired
  // above, NOT a wrapper around dispatch's 47 record() sites — this satisfies
  // "composed one level up with full context" while touching zero call sites. Fully
  // self-guarding: it must NEVER throw (the facade awaits it inline) so a failed
  // emit can never break or lose the recorded change.
  private async emitEpisode(record: ChangeRecord): Promise<void> {
    try {
      if (!this.episodeLog) return;
      const op = mapActionToOp(record.action);
      if (!op) return;
      // Survival-relevance filter: only uid-bearing records (skip routes/infra with
      // no minted identity). A DELETE is the exception the metric most needs (it is
      // the "death"): dispatch removes the entity BEFORE recording, so A2's resolver
      // can't stamp the uid (registries.ts entityUidFor: "already-removed entity" ⇒
      // undefined). Recover it from the entity's own prior changelog records, whose
      // create/update DID carry the uid — so a delete still threads the lifecycle.
      const entityUid = record.context?.entityUid ??
        (op === "delete" ? await this.recoverEntityUid(record) : undefined);
      if (!entityUid) return;
      // A missing origin is "unknown" — never assumed "ai" (plan §4 A1.3). The
      // non-nullable schema requires a known origin, so such a change is not emitted.
      const authorOrigin = record.context?.authorOrigin;
      if (authorOrigin !== "ai" && authorOrigin !== "human") return;

      const changeset = await this.resolveChangesetFor(record);
      this.episodeLog.record(buildEpisode({
        record,
        op,
        authorOrigin,
        entityUid,
        verification: summarizeVerification(changeset),
        humanDecision: statusToHumanDecision(changeset?.status ?? null),
        graph: this.graphMetricsFor(record.category, record.key),
      }));
    } catch (err) {
      this.log.log(
        "error",
        "system",
        `episode emit failed for ${record.category} "${record.key}": ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  // B1b: the changed entity's degrees from the AFTER knowledge graph (the current,
  // post-change registry projection), for enriching its episode. Built fresh per
  // emit — buildKnowledgeGraph is O(project) regex, cheap at these sizes (plan §2
  // S4); B1b deliberately adds NO persisted/incremental graph store. Best-effort and
  // fully isolated: any failure (or a non-graph-node category, or a delete whose
  // entity is gone from the after-graph) yields null so the three degree fields stay
  // null ("not computed"), never wrong — and never aborts the surrounding emit.
  private graphMetricsFor(
    category: string,
    name: string,
  ): { inDegree: number; outDegree: number; dependentCount: number } | null {
    try {
      return buildKnowledgeGraph(this).metricsFor(category, name);
    } catch (err) {
      this.log.log(
        "warn",
        "system",
        `graph metrics unavailable for ${category} "${name}": ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return null;
    }
  }

  // Recover a deleted entity's stable uid from its prior changelog records (the
  // create/update/rename that carried it), since the entity is gone from the
  // registry by the time a delete is recorded. Returns undefined if no prior record
  // carried a uid (e.g. an entity created before A2).
  private async recoverEntityUid(
    record: ChangeRecord,
  ): Promise<string | undefined> {
    const history = await this.changelog.entityHistory(
      record.category,
      record.key,
    );
    for (const prior of history) {
      const uid = prior.context?.entityUid;
      if (uid) return uid;
    }
    return undefined;
  }

  // Resolve the changeset backing a change's verification/decision context. Returns
  // null when the change is outside any changeset flow OR the changeset store is not
  // composed in (coreOnlyComposition — `this.changesets` would throw), so episode
  // emission works standalone.
  private async resolveChangesetFor(record: ChangeRecord) {
    if (!this.composition.changesetStoreFactory) return null;
    const changesetId = record.changesetId;
    const sessionId = record.context?.sessionId;
    if (changesetId) return await this.changesets.get(changesetId);
    if (sessionId) return await this.changesets.getActive(sessionId);
    return null;
  }

  // A4: the set of currently-live entity uids across every registry with a minted
  // identity — the `alive` input to the survival pass. Config uids ride only on the
  // serialized shape (its list() drops them), hence serialize() there.
  private liveEntityUids(): Set<string> {
    const uids = new Set<string>();
    const add = (uid: string | undefined) => {
      if (uid) uids.add(uid);
    };
    for (const e of this.handlers.list()) add(e.entityUid);
    for (const e of this.functions.list()) add(e.entityUid);
    for (const e of this.types.list()) add(e.entityUid);
    for (const e of this.tests.list()) add(e.entityUid);
    for (const e of this.templates.list()) add(e.entityUid);
    // Assets & configs strip entityUid from their list() projection, so resolve it
    // per entry (avoids serialize()'s base64/value round-trip just to read a uid).
    for (const e of this.assets.list()) add(this.assets.get(e.name)?.entityUid);
    for (const e of this.devViews.list()) add(e.entityUid);
    for (const e of this.devTools.list()) add(e.entityUid);
    for (const e of this.customAudits.list()) add(e.entityUid);
    for (const e of this.configs.list()) {
      add(this.configs.getEntry(e.name)?.entityUid);
    }
    return uids;
  }

  // A4: the boot-time (and, later, daily) survival observation pass. Walks the
  // immutable episode log grouped by entityUid, cross-references the live registry
  // for `alive`, and appends one SurvivalObservation per entity — episodes are
  // never mutated. Best-effort: guarded so a bad pass never blocks project load.
  // Also applies the episodeLogRetention cap here (boot only), mirroring the
  // verification ledger. `now` is injectable for deterministic tests.
  observeSurvival(now: number = Date.now()): void {
    if (!this.episodeLog) return;
    try {
      const retention = getKernelSettings().episodeLogRetention;
      if (retention > 0) this.episodeLog.prune(retention);
      const observations = computeSurvivalObservations(
        this.episodeLog.readEpisodes(),
        this.liveEntityUids(),
        now,
        this.survivalWeightLookup(),
      );
      for (const observation of observations) {
        this.episodeLog.observe(observation);
      }
    } catch (err) {
      this.log.log(
        "error",
        "system",
        `survival observation pass failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  // B1d (S5): the per-uid weight lookup for the survival pass — the entity's CURRENT
  // transitive dependentCount (blast-radius size), so a surviving keystone weighs more
  // than a surviving leaf. Reads the LIVE graph (importance accretes after authoring),
  // not the authoring episode's degrees. buildKnowledgeGraph is O(project) regex —
  // built ONCE per pass, cheap at these sizes; same on-demand choice as B1b, no
  // persisted graph store. Read-only: querying metricsForUid never mutates the graph
  // or any registry. Guarded so a graph failure degrades the pass to WEIGHTLESS
  // observations (undefined lookup ⇒ weight null, accrue-forward) rather than losing
  // the observations — a failed weight must never cost us the survival record.
  private survivalWeightLookup():
    | ((entityUid: string) => number | null)
    | undefined {
    try {
      const graph = buildKnowledgeGraph(this);
      return (uid) => graph.metricsForUid(uid)?.dependentCount ?? null;
    } catch (err) {
      this.log.log(
        "warn",
        "system",
        `survival weight graph unavailable, observing weightless: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return undefined;
    }
  }

  // A2 (Stream A): resolve a code entity's stable uid by its changelog coordinates
  // (category = registry type, key = entity name). Returns undefined for categories
  // with no minted identity (routes, infra like packages/secrets/env-vars, or an
  // already-removed entity) — a missing uid is left unknown, never guessed. When A3
  // re-keys history to uid, this stays the single lookup point.
  entityUidFor(category: string, key: string): string | undefined {
    switch (category) {
      case "handler":
        return this.handlers.get(key)?.entityUid;
      case "function":
        return this.functions.getEntry(key)?.entityUid;
      case "type":
        return this.types.get(key)?.entityUid;
      case "test":
        return this.tests.get(key)?.entityUid;
      case "template":
        return this.templates.getEntry(key)?.entityUid;
      case "asset":
        return this.assets.get(key)?.entityUid;
      case "dev_view":
        return this.devViews.get(key)?.entityUid;
      case "dev_tool":
        return this.devTools.get(key)?.entityUid;
      case "config":
        return this.configs.getEntry(key)?.entityUid;
      case "audit":
        return this.customAudits.get(key)?.entityUid;
      default:
        return undefined;
    }
  }

  // Verification-governed stores, built on first use via the composition's
  // store factory. With no factory (coreOnlyComposition), the getter throws —
  // core boots standalone but touching changesets/audits needs the verification
  // layer assembled into the Kernel's composition.
  get changesets(): ChangesetStore {
    const factory = this.composition.changesetStoreFactory;
    if (!factory) throw new Error(NO_STORE_FACTORY);
    return this._changesets ??= factory(this._changesetStorage);
  }

  // The open changeset a write should be stamped with, or null. Unlike the
  // getter above it never throws: a core-only kernel has no changesets to join.
  async activeChangesetId(sessionId?: string): Promise<string | null> {
    if (!this.composition.changesetStoreFactory) return null;
    const active = await this.changesets.getActive(sessionId).catch(() => null);
    return active?.id ?? null;
  }

  get audits(): AuditStore {
    const factory = this.composition.auditStoreFactory;
    if (!factory) throw new Error(NO_STORE_FACTORY);
    return this._audits ??= factory(this.db.drizzle);
  }

  // Unlike the stores above, an absent call audit is not an error: the call
  // still runs, it just isn't recorded.
  get mcpAudit(): McpAuditStore | null {
    const factory = this.composition.mcpAuditStoreFactory;
    if (!factory) return null;
    return this._mcpAudit ??= factory(this.db.drizzle);
  }

  // Subscribe to entity writes; returns an unsubscribe fn (idempotent). The
  // subscriber (e.g. the LSP server) reconciles its open documents against the new
  // registry state on each event (docs/lsp-support-plan.md Stage 5).
  onEntityChange(listener: EntityChangeListener): () => void {
    this.entityChangeListeners.add(listener);
    return () => {
      this.entityChangeListeners.delete(listener);
    };
  }

  // Fire an entity-change event to every subscriber. Called by the tool dispatch on
  // an accepted define_* write. A listener that throws must never break the write, so
  // each is isolated and its failure logged, not propagated.
  notifyEntityChange(event: EntityChangeEvent): void {
    for (const listener of this.entityChangeListeners) {
      try {
        listener(event);
      } catch (err) {
        this.log.log(
          "error",
          "system",
          `entity-change listener failed for ${event.entityType} "${event.entityName}": ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
  }

  listModules(): string[] {
    const mods = new Set<string>();
    for (const r of this.routes.list()) if (r.module) mods.add(r.module);
    for (const h of this.handlers.list()) if (h.module) mods.add(h.module);
    for (const f of this.functions.list()) if (f.module) mods.add(f.module);
    for (const t of this.tests.list()) if (t.module) mods.add(t.module);
    for (const t of this.templates.list()) if (t.module) mods.add(t.module);
    for (const a of this.assets.list()) if (a.module) mods.add(a.module);
    for (const v of this.devViews.list()) {
      if (!v.builtIn && v.module) mods.add(v.module);
    }
    for (const t of this.devTools.list()) if (t.module) mods.add(t.module);
    for (const t of this.types.list()) if (t.module) mods.add(t.module);
    for (const c of this.configs.list()) if (c.module) mods.add(c.module);
    return [...mods].sort();
  }

  async getModuleEntities(module: string): Promise<{
    routes: RouteEntry[];
    handlers: ReturnType<HandlerMap["serialize"]>;
    functions: ReturnType<FunctionMap["serialize"]>;
    tests: ReturnType<TestMap["serialize"]>;
    templates: ReturnType<TemplateMap["serialize"]>;
    assets: ReturnType<AssetMap["list"]>;
    schemas: import("./types.ts").SchemaEntry[];
    devViews: Array<
      {
        name: string;
        targetType: string;
        title: string;
        builtIn: boolean;
        registeredAt: string;
        module?: string;
      }
    >;
    devTools: Array<
      {
        name: string;
        description: string;
        args: import("./types.ts").DevToolArgDef[];
        registeredAt: string;
        module?: string;
      }
    >;
    types: ReturnType<TypeMap["serialize"]>;
    configs: ReturnType<ConfigMap["serialize"]>;
  }> {
    const schemas = await this.db.listSchemas();
    return {
      routes: this.routes.list().filter((r) => r.module === module),
      handlers: this.handlers.serialize().filter((h) => h.module === module),
      functions: this.functions.serialize().filter((f) => f.module === module),
      tests: this.tests.serialize().filter((t) => t.module === module),
      templates: this.templates.serialize().filter((t) => t.module === module),
      assets: this.assets.list().filter((a) => a.module === module),
      schemas: schemas.filter((s) => s.module === module),
      devViews: this.devViews.list().filter((v) =>
        !v.builtIn && v.module === module
      ).map((v) => ({
        name: v.name,
        targetType: v.targetType,
        title: v.title,
        builtIn: v.builtIn,
        registeredAt: v.registeredAt,
        ...(v.module ? { module: v.module } : {}),
      })),
      devTools: this.devTools.list().filter((t) => t.module === module).map(
        (t) => ({
          name: t.name,
          description: t.description,
          args: t.args,
          registeredAt: t.registeredAt,
          ...(t.module ? { module: t.module } : {}),
        }),
      ),
      types: this.types.serialize().filter((t) => t.module === module),
      configs: this.configs.serialize().filter((c) => c.module === module),
    };
  }

  async compileDeps(): Promise<CompileDeps> {
    this.envVars.refreshCache();

    const envVars = this.envVars;
    const secrets = this.secrets;
    const osEnv = this.env;

    const env: Record<string, string> = new Proxy(Object.create(null), {
      get(_, prop) {
        if (typeof prop !== "string") return undefined;
        return secrets.resolve(prop) ?? envVars.getCached(prop) ??
          osEnv.get(prop);
      },
      has(_, prop) {
        if (typeof prop !== "string") return false;
        return secrets.resolve(prop) !== undefined ||
          envVars.getCached(prop) !== undefined ||
          osEnv.get(prop) !== undefined;
      },
      ownKeys() {
        const keys = new Set<string>();
        for (const k of Object.keys(osEnv.all())) keys.add(k);
        for (const k of envVars.cachedEntries().keys()) keys.add(k);
        for (const e of secrets.list()) keys.add(e.key);
        return [...keys];
      },
      getOwnPropertyDescriptor(_, prop) {
        if (typeof prop !== "string") return undefined;
        const val = secrets.resolve(prop) ?? envVars.getCached(prop) ??
          osEnv.get(prop);
        if (val !== undefined) {
          return {
            configurable: true,
            enumerable: true,
            value: val,
            writable: false,
          };
        }
        return undefined;
      },
    });

    const kernelLog = this.log;
    const formatArgs = (...args: unknown[]) =>
      args.map((a) => typeof a === "string" ? a : JSON.stringify(a)).join(" ");
    const log = Object.assign(
      (...args: unknown[]) => {
        kernelLog.log("info", "app", formatArgs(...args));
      },
      {
        debug: (...args: unknown[]) => {
          kernelLog.log("debug", "app", formatArgs(...args));
        },
        info: (...args: unknown[]) => {
          kernelLog.log("info", "app", formatArgs(...args));
        },
        warn: (...args: unknown[]) => {
          kernelLog.log("warn", "app", formatArgs(...args));
        },
        error: (...args: unknown[]) => {
          kernelLog.log("error", "app", formatArgs(...args));
        },
      },
    );

    return {
      db: buildHandlerDb(tracedDb(this.db), this.db.drizzle, this.db.schemas),
      functions: tracedFunctions(this.functions),
      config: this.configs,
      templates: tracedTemplates(this.templates, (name) => {
        const ts = this.assets.get(name)?.registeredAt;
        return ts ? String(new Date(ts).getTime()) : undefined;
      }),
      packages: this.runtime.packageProxy?.(this) ?? this.packages.proxy(),
      env,
      log,
      getAppPort: () => this.appPort,
      appUrl: (path = "/") => appPreviewUrl(this.appPort, path),
    };
  }
}
