// The runner's copy of the user code and state that user code reads, kept in
// step by the kernel's mirror (./mirror.ts). It instantiates the JS it's sent
// (./instantiate.ts) and transpiles nothing.
//
// What user code is handed (`functions`, `config`, `templates`, `env`...) is
// bound once, when the code is instantiated, so those objects never change:
// a sync replaces what they read from. A request already running keeps the
// function it started with.

import { joinAppUrl } from "../config.ts";
import { DynamicSchemaRegistry } from "../db/dynamic-schema.ts";
import { tracedFunctions, tracedTemplates } from "../trace-context.ts";
import type {
  CompileDeps,
  CompileLog,
  DevToolFn,
  DevViewFn,
  HandlerFn,
  Result,
  TestFn,
} from "../types.ts";
import { errorMessage } from "../util.ts";
import { callInspect } from "./call-context.ts";
import {
  instantiateDevTool,
  instantiateDevView,
  instantiateFunction,
  instantiateHandler,
  instantiateTest,
} from "./instantiate.ts";
import type { RequestHandler } from "./peer.ts";
import {
  MIRROR_CATEGORIES,
  mirrorEntryId,
  type MirrorFailure,
  type MirrorManifestEntry,
  type MirrorPayload,
  type MirrorRef,
  type MirrorUpsert,
  RUNNER_ERROR_CODES,
  RUNNER_METHODS,
  type StateSyncAnswer,
  type StateSyncRequest,
} from "./protocol.ts";
import { buildRunnerDb, type DbExec } from "./runner-db.ts";

type UserFunction = (...args: unknown[]) => unknown;

export class RunnerState {
  private readonly handlers = new Map<string, HandlerFn>();
  private readonly functions = new Map<string, UserFunction>();
  private readonly tests = new Map<string, TestFn>();
  private readonly devViews = new Map<string, DevViewFn>();
  private readonly devTools = new Map<string, DevToolFn>();
  private readonly templates = new Map<string, string>();
  private readonly assetVersions = new Map<string, string>();
  private readonly configs = new Map<string, unknown>();
  // Each package's module, imported here from its specifier.
  private readonly packages = new Map<string, Record<string, unknown>>();
  private readonly schemas = new DynamicSchemaRegistry();
  private env: Record<string, string> = {};
  private app = { port: 0, origin: "" };
  // Everything held, by hash, failed entries included.
  private readonly held = new Map<string, MirrorManifestEntry>();
  readonly deps: CompileDeps;

  constructor(exec: DbExec, log: CompileLog) {
    this.deps = {
      db: buildRunnerDb(exec, this.schemas),
      functions: tracedFunctions({
        get: (name) => this.functions.get(name),
        call: (name, ...args) => {
          const fn = this.functions.get(name);
          if (!fn) throw new Error(`Function "${name}" not found in registry`);
          return fn(...args);
        },
      }),
      config: { get: (name) => this.configs.get(name) },
      templates: tracedTemplates(
        { get: (name) => this.templates.get(name) },
        (asset) => this.assetVersions.get(asset),
      ),
      packages: liveRecord(() => Object.fromEntries(this.packages)),
      env: liveRecord(() => this.env),
      log,
      getAppPort: () => this.app.port,
      appUrl: (path) => joinAppUrl(this.app.origin, path),
    };
  }

  get appOrigin(): string {
    return this.app.origin;
  }

  handler(name: string): HandlerFn | undefined {
    return this.handlers.get(name);
  }

  function(name: string): UserFunction | undefined {
    return this.functions.get(name);
  }

  test(name: string): TestFn | undefined {
    return this.tests.get(name);
  }

  devView(name: string): DevViewFn | undefined {
    return this.devViews.get(name);
  }

  devTool(name: string): DevToolFn | undefined {
    return this.devTools.get(name);
  }

  manifest(): MirrorManifestEntry[] {
    return [...this.held.values()];
  }

  async apply(request: StateSyncRequest): Promise<StateSyncAnswer> {
    for (const ref of request.removes) {
      this.drop(ref);
      this.held.delete(mirrorEntryId(ref));
    }
    for (const entry of request.failed) {
      this.drop(entry);
      this.hold(entry);
    }
    const failures: MirrorFailure[] = [];
    for (const upsert of request.upserts) {
      const applied = await this.take(upsert);
      if (!applied.ok) {
        this.drop(upsert);
        failures.push({
          category: upsert.category,
          key: upsert.key,
          error: applied.error,
        });
      }
      this.hold(upsert);
    }
    return { failures };
  }

  // Would this code instantiate? Nothing is kept: the kernel asks at define
  // time, so a bad define fails the define, as it does in-process.
  check(entry: MirrorPayload): Result<void> {
    const made = this.instantiate(entry);
    return made && !made.ok ? made : OK;
  }

  private hold({ category, key, hash }: MirrorManifestEntry): void {
    this.held.set(mirrorEntryId({ category, key }), { category, key, hash });
  }

  private async take(upsert: MirrorUpsert): Promise<Result<void>> {
    const { key } = upsert;
    switch (upsert.category) {
      case MIRROR_CATEGORIES.handler:
        return store(this.handlers, key, this.instantiateHandler(upsert));
      case MIRROR_CATEGORIES.function:
        return store(this.functions, key, this.instantiateFunction(upsert));
      case MIRROR_CATEGORIES.test:
        return store(this.tests, key, this.instantiateTest(upsert));
      case MIRROR_CATEGORIES.devView:
        return store(this.devViews, key, this.instantiateDevView(upsert));
      case MIRROR_CATEGORIES.devTool:
        return store(this.devTools, key, this.instantiateDevTool(upsert));
      case MIRROR_CATEGORIES.template:
        this.templates.set(key, upsert.payload.content);
        return OK;
      case MIRROR_CATEGORIES.assetVersion:
        this.assetVersions.set(key, upsert.payload.version);
        return OK;
      case MIRROR_CATEGORIES.config:
        this.configs.set(key, upsert.payload.value);
        return OK;
      case MIRROR_CATEGORIES.schema:
        this.schemas.register(key, upsert.payload.columns);
        return OK;
      case MIRROR_CATEGORIES.package:
        return store(
          this.packages,
          key,
          await importPackage(key, upsert.payload.specifier),
        );
      case MIRROR_CATEGORIES.env:
        this.env = upsert.payload.vars;
        return OK;
      case MIRROR_CATEGORIES.app:
        this.app = upsert.payload;
        return OK;
    }
  }

  // User code made live, or null for anything that isn't code.
  private instantiate(entry: MirrorPayload): Result<unknown> | null {
    switch (entry.category) {
      case MIRROR_CATEGORIES.handler:
        return this.instantiateHandler(entry);
      case MIRROR_CATEGORIES.function:
        return this.instantiateFunction(entry);
      case MIRROR_CATEGORIES.test:
        return this.instantiateTest(entry);
      case MIRROR_CATEGORIES.devView:
        return this.instantiateDevView(entry);
      case MIRROR_CATEGORIES.devTool:
        return this.instantiateDevTool(entry);
      default:
        return null;
    }
  }

  private instantiateHandler(e: PayloadOf<"handler">): Result<HandlerFn> {
    return instantiateHandler(e.key, e.payload.js, e.payload.abi, this.deps);
  }

  private instantiateFunction(e: PayloadOf<"function">) {
    return instantiateFunction(e.key, e.payload.js, this.deps);
  }

  private instantiateTest(e: PayloadOf<"test">): Result<TestFn> {
    return instantiateTest(e.key, e.payload.js, this.deps);
  }

  private instantiateDevView(e: PayloadOf<"dev_view">): Result<DevViewFn> {
    return instantiateDevView(e.key, e.payload.js, this.deps, callInspect);
  }

  private instantiateDevTool(e: PayloadOf<"dev_tool">): Result<DevToolFn> {
    return instantiateDevTool(
      e.key,
      e.payload.js,
      e.payload.args,
      this.deps,
    );
  }

  private drop({ category, key }: MirrorRef): void {
    switch (category) {
      case MIRROR_CATEGORIES.handler:
        this.handlers.delete(key);
        return;
      case MIRROR_CATEGORIES.function:
        this.functions.delete(key);
        return;
      case MIRROR_CATEGORIES.test:
        this.tests.delete(key);
        return;
      case MIRROR_CATEGORIES.devView:
        this.devViews.delete(key);
        return;
      case MIRROR_CATEGORIES.devTool:
        this.devTools.delete(key);
        return;
      case MIRROR_CATEGORIES.template:
        this.templates.delete(key);
        return;
      case MIRROR_CATEGORIES.assetVersion:
        this.assetVersions.delete(key);
        return;
      case MIRROR_CATEGORIES.config:
        this.configs.delete(key);
        return;
      case MIRROR_CATEGORIES.schema:
        this.schemas.remove(key);
        return;
      case MIRROR_CATEGORIES.package:
        this.packages.delete(key);
        return;
      case MIRROR_CATEGORIES.env:
        this.env = {};
        return;
      case MIRROR_CATEGORIES.app:
        this.app = { port: 0, origin: "" };
        return;
    }
  }
}

type PayloadOf<C extends MirrorPayload["category"]> = Extract<
  MirrorPayload,
  { category: C }
>;

const OK: Result<void> = { ok: true, data: undefined };

async function importPackage(
  name: string,
  specifier: string,
): Promise<Result<Record<string, unknown>>> {
  try {
    return {
      ok: true,
      data: await import(specifier) as Record<string, unknown>,
    };
  } catch (err) {
    return {
      ok: false,
      error: {
        code: RUNNER_ERROR_CODES.notLoaded,
        message: `Failed to import package "${name}" (${specifier}): ${
          errorMessage(err)
        }`,
      },
    };
  }
}

function store<T>(map: Map<string, T>, key: string, made: Result<T>) {
  if (!made.ok) return made;
  map.set(key, made.data);
  return OK;
}

// A read-only view of whatever record `current` returns now, so code that
// captured `env` or `packages` once still sees each sync's values.
function liveRecord<T>(current: () => Record<string, T>): Record<string, T> {
  return new Proxy(Object.create(null), {
    get: (_, prop) => typeof prop === "string" ? current()[prop] : undefined,
    has: (_, prop) =>
      typeof prop === "string" && Object.hasOwn(current(), prop),
    ownKeys: () => Object.keys(current()),
    getOwnPropertyDescriptor: (_, prop) => {
      if (typeof prop !== "string" || !Object.hasOwn(current(), prop)) {
        return undefined;
      }
      return {
        configurable: true,
        enumerable: true,
        value: current()[prop],
        writable: false,
      };
    },
  });
}

// The runner's answers to state.sync and state.manifest.
export function stateHandlers(
  state: RunnerState,
): Record<string, RequestHandler> {
  return {
    [RUNNER_METHODS.stateSync]: async (params) => {
      if (!isSyncRequest(params)) {
        return {
          ok: false,
          error: {
            code: RUNNER_ERROR_CODES.invalidParams,
            message: "state.sync needs { removes, upserts, failed }",
          },
        };
      }
      return { ok: true, data: await state.apply(params) };
    },
    [RUNNER_METHODS.stateManifest]: () => ({
      ok: true,
      data: state.manifest(),
    }),
    [RUNNER_METHODS.stateCheck]: (params) => {
      if (!isPayload(params)) {
        return {
          ok: false,
          error: {
            code: RUNNER_ERROR_CODES.invalidParams,
            message: "state.check needs { category, key, payload }",
          },
        };
      }
      return state.check(params);
    },
  };
}

// Only the shape is checked: the kernel is the one sending.
function isSyncRequest(params: unknown): params is StateSyncRequest {
  if (typeof params !== "object" || params === null) return false;
  const p = params as Record<string, unknown>;
  return Array.isArray(p.removes) && Array.isArray(p.upserts) &&
    Array.isArray(p.failed);
}

function isPayload(params: unknown): params is MirrorPayload {
  if (typeof params !== "object" || params === null) return false;
  const p = params as Record<string, unknown>;
  return typeof p.category === "string" && typeof p.key === "string" &&
    typeof p.payload === "object" && p.payload !== null;
}
