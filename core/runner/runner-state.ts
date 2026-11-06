// The runner's copy of the user code and state that user code reads, kept in
// step by the kernel's mirror (./mirror.ts). It instantiates the JS it's sent
// (./instantiate.ts) and transpiles nothing.
//
// What user code is handed (`functions`, `config`, `templates`, `env`...) is
// bound once, when the code is instantiated, so those objects never change:
// a sync replaces what they read from. A request already running keeps the
// function it started with.

import { joinAppUrl } from "../config.ts";
import { stampAssetVersions } from "../asset-urls.ts";
import { DynamicSchemaRegistry } from "../db/dynamic-schema.ts";
import type {
  CompileDeps,
  CompileLog,
  DevToolFn,
  DevViewFn,
  HandlerFn,
  KernelInspectAPI,
  Result,
  TestFn,
} from "../types.ts";
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
  type MirrorRef,
  type MirrorUpsert,
  RUNNER_ERROR_CODES,
  RUNNER_METHODS,
  type StateSyncAnswer,
  type StateSyncRequest,
} from "./protocol.ts";
import { buildRunnerDb, type DbExec } from "./runner-db.ts";

type UserFunction = (...args: unknown[]) => unknown;

// Dev views get a snapshot of the kernel per call, which comes with the
// handler-call slice. Until then reaching for it fails loudly.
const NO_KERNEL_INSPECT = new Proxy({} as KernelInspectAPI, {
  get() {
    throw new Error("kernel inspection isn't available in the runner yet");
  },
});

export class RunnerState {
  private readonly handlers = new Map<string, HandlerFn>();
  private readonly functions = new Map<string, UserFunction>();
  private readonly tests = new Map<string, TestFn>();
  private readonly devViews = new Map<string, DevViewFn>();
  private readonly devTools = new Map<string, DevToolFn>();
  private readonly templates = new Map<string, string>();
  private readonly assetVersions = new Map<string, string>();
  private readonly configs = new Map<string, unknown>();
  private readonly packages = new Map<string, string>();
  private readonly schemas = new DynamicSchemaRegistry();
  private env: Record<string, string> = {};
  private app = { port: 0, origin: "" };
  // Everything held, by hash, failed entries included.
  private readonly held = new Map<string, MirrorManifestEntry>();
  readonly deps: CompileDeps;

  constructor(exec: DbExec, log: CompileLog) {
    this.deps = {
      db: buildRunnerDb(exec, this.schemas),
      functions: {
        get: (name) => this.functions.get(name),
        call: (name, ...args) => {
          const fn = this.functions.get(name);
          if (!fn) throw new Error(`Function "${name}" not found in registry`);
          return fn(...args);
        },
      },
      config: { get: (name) => this.configs.get(name) },
      templates: {
        get: (name) => {
          const content = this.templates.get(name);
          return content
            ? stampAssetVersions(content, (a) => this.assetVersions.get(a))
            : content;
        },
      },
      // Filled from the mirrored specifiers by the handler-call slice.
      packages: {},
      env: liveRecord(() => this.env),
      log,
      getAppPort: () => this.app.port,
      appUrl: (path) => joinAppUrl(this.app.origin, path),
    };
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

  apply(request: StateSyncRequest): StateSyncAnswer {
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
      const applied = this.take(upsert);
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

  private hold({ category, key, hash }: MirrorManifestEntry): void {
    this.held.set(mirrorEntryId({ category, key }), { category, key, hash });
  }

  private take(upsert: MirrorUpsert): Result<void> {
    const { key } = upsert;
    switch (upsert.category) {
      case MIRROR_CATEGORIES.handler:
        return store(
          this.handlers,
          key,
          instantiateHandler(
            key,
            upsert.payload.js,
            upsert.payload.abi,
            this.deps,
          ),
        );
      case MIRROR_CATEGORIES.function:
        return store(
          this.functions,
          key,
          instantiateFunction(key, upsert.payload.js, this.deps),
        );
      case MIRROR_CATEGORIES.test:
        return store(
          this.tests,
          key,
          instantiateTest(key, upsert.payload.js, this.deps),
        );
      case MIRROR_CATEGORIES.devView:
        return store(
          this.devViews,
          key,
          instantiateDevView(
            key,
            upsert.payload.js,
            this.deps,
            NO_KERNEL_INSPECT,
          ),
        );
      case MIRROR_CATEGORIES.devTool:
        return store(
          this.devTools,
          key,
          instantiateDevTool(
            key,
            upsert.payload.js,
            upsert.payload.args,
            this.deps,
          ),
        );
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
        this.packages.set(key, upsert.payload.specifier);
        return OK;
      case MIRROR_CATEGORIES.env:
        this.env = upsert.payload.vars;
        return OK;
      case MIRROR_CATEGORIES.app:
        this.app = upsert.payload;
        return OK;
    }
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

const OK: Result<void> = { ok: true, data: undefined };

function store<T>(map: Map<string, T>, key: string, made: Result<T>) {
  if (!made.ok) return made;
  map.set(key, made.data);
  return OK;
}

// A read-only view of whatever record `current` returns now, so code that
// captured `env` once still sees each sync's values.
function liveRecord(
  current: () => Record<string, string>,
): Record<string, string> {
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
    [RUNNER_METHODS.stateSync]: (params) => {
      if (!isSyncRequest(params)) {
        return {
          ok: false,
          error: {
            code: RUNNER_ERROR_CODES.invalidParams,
            message: "state.sync needs { removes, upserts, failed }",
          },
        };
      }
      return { ok: true, data: state.apply(params) };
    },
    [RUNNER_METHODS.stateManifest]: () => ({
      ok: true,
      data: state.manifest(),
    }),
  };
}

// Only the shape is checked: the kernel is the one sending.
function isSyncRequest(params: unknown): params is StateSyncRequest {
  if (typeof params !== "object" || params === null) return false;
  const p = params as Record<string, unknown>;
  return Array.isArray(p.removes) && Array.isArray(p.upserts) &&
    Array.isArray(p.failed);
}
