// The kernel's side of the runner's state: keeps the runner's copy of user
// code and the state it reads (./runner-state.ts) in step with the registries.
//
// Nothing hooks the registry mutators. Each sync reads the registries as they
// stand, hashes every entry, and sends what differs from what the runner last
// confirmed. So a registry changed by any path (a define, undo, a snapshot
// restore, a fork load, a direct call) is picked up by the next sync, and a
// path added later can't be forgotten.
//
// Every registry replaces an entry object when it changes rather than editing
// it, so each entry is hashed once, keyed by the object. The resolved env and
// the app origin are rebuilt every sync and compared as text: secrets and env
// vars are edited in place.

import { appPreviewOrigin, RUNNER_REQUEST_TIMEOUT_MS } from "../config.ts";
import { assetVersionOf } from "../asset-urls.ts";
import { transpileUserCode } from "../compiler.ts";
import { detectHandlerAbi } from "../handler-abi.ts";
import type { Kernel } from "../registries.ts";
import type { DevToolArgDef, Result } from "../types.ts";
import { sha256Hex } from "../util.ts";
import {
  MIRROR_CATEGORIES,
  MIRROR_SINGLETON_KEY,
  type MirrorCategory,
  mirrorEntryId,
  type MirrorFailure,
  type MirrorManifestEntry,
  type MirrorPayload,
  type MirrorPayloads,
  type MirrorRef,
  type MirrorUpsert,
  RUNNER_METHODS,
  type StateSyncAnswer,
  type StateSyncRequest,
} from "./protocol.ts";

// The runner's state methods, as the mirror calls them.
export interface RunnerStateChannel {
  sync(request: StateSyncRequest): Promise<Result<StateSyncAnswer>>;
  manifest(): Promise<Result<MirrorManifestEntry[]>>;
  check(entry: MirrorPayload): Promise<Result<void>>;
}

// Anything that sends requests to the runner: its RpcPeer or its RunnerHost.
export interface RunnerRequester {
  request<T>(
    method: string,
    params: unknown,
    timeoutMs: number,
  ): Promise<Result<T>>;
}

export function rpcStateChannel(runner: RunnerRequester): RunnerStateChannel {
  return {
    sync: (request) =>
      runner.request<StateSyncAnswer>(
        RUNNER_METHODS.stateSync,
        request,
        RUNNER_REQUEST_TIMEOUT_MS,
      ),
    manifest: () =>
      runner.request<MirrorManifestEntry[]>(
        RUNNER_METHODS.stateManifest,
        null,
        RUNNER_REQUEST_TIMEOUT_MS,
      ),
    check: (entry) =>
      runner.request<void>(
        RUNNER_METHODS.stateCheck,
        entry,
        RUNNER_REQUEST_TIMEOUT_MS,
      ),
  };
}

type UserCodeCategory =
  | typeof MIRROR_CATEGORIES.handler
  | typeof MIRROR_CATEGORIES.function
  | typeof MIRROR_CATEGORIES.test
  | typeof MIRROR_CATEGORIES.devView
  | typeof MIRROR_CATEGORIES.devTool;

// One piece of user code by its source, registered or about to be.
export type UserCodeSource =
  | {
    category: Exclude<UserCodeCategory, typeof MIRROR_CATEGORIES.devTool>;
    key: string;
    source: string;
  }
  | {
    category: typeof MIRROR_CATEGORIES.devTool;
    key: string;
    source: string;
    args: DevToolArgDef[];
  };

export interface SyncReport {
  sent: number;
  removed: number;
  // Entries that won't run in the runner: transpile errors from here,
  // instantiate errors from there. Each is reported by the sync that sent it,
  // and again only once its source changes.
  failures: MirrorFailure[];
}

// One entry as the kernel has it now. `identity` is the registry's entry
// object, when there is one; `fingerprint` is what the hash covers.
interface Candidate<C extends MirrorCategory = MirrorCategory> {
  category: C;
  key: string;
  identity?: object;
  fingerprint: () => string;
  payload: () => Promise<Result<MirrorPayloads[C]>>;
}

interface Hashed {
  candidate: Candidate;
  hash: string;
}

// What a mirror knows about the kernel's side alone: hashes and transpiled
// code. A respawned runner gets a new mirror and the same cache, so nothing
// unchanged is transpiled again.
export class MirrorCache {
  readonly hashByEntry = new WeakMap<object, string>();
  readonly hashByText = new Map<string, { text: string; hash: string }>();
  // One slot per entity: its last source and what that transpiled to.
  readonly transpiled = new Map<
    string,
    { source: string; js: Result<string> }
  >();
}

export class StateMirror {
  // What the runner holds, failed entries included. Null when that isn't
  // known (a new mirror, a respawned runner, a send that failed half-way):
  // the next sync asks the runner first.
  private confirmed: Map<string, MirrorManifestEntry> | null = null;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly kernel: Kernel,
    private readonly runner: RunnerStateChannel,
    private readonly cache: MirrorCache = new MirrorCache(),
  ) {}

  // Runs after any sync already under way, then diffs afresh, so two callers
  // never send the same change twice.
  sync(): Promise<Result<SyncReport>> {
    const run = this.queue.then(() => this.syncNow());
    this.queue = run.catch(() => {});
    return run;
  }

  // Forget what the runner holds (it was respawned, say): the next sync asks
  // it, then sends the difference.
  reset(): void {
    this.confirmed = null;
  }

  // What the kernel has now, by hash: what the runner should hold after a
  // sync. For tests, and to check a respawned runner against.
  async kernelManifest(): Promise<MirrorManifestEntry[]> {
    const current = await this.currentManifest();
    return [...current.values()].map(({ candidate, hash }) => ({
      category: candidate.category,
      key: candidate.key,
      hash,
    }));
  }

  // Would this code run in the runner? Transpiles it (filling the cache the
  // next sync reads) and has the runner instantiate it without keeping it.
  // The define path asks before registering, so a bad define fails there.
  async check(entity: UserCodeSource): Promise<Result<void>> {
    const entry = await this.userCodePayload(entity);
    if (!entry.ok) return entry;
    return await this.runner.check(entry.data);
  }

  // The JS for one entity, from the cache when its source hasn't changed.
  // The define path fills it, so a sync rarely transpiles.
  async transpile(
    category: UserCodeCategory,
    key: string,
    source: string,
  ): Promise<Result<string>> {
    const id = mirrorEntryId({ category, key });
    const cached = this.cache.transpiled.get(id);
    if (cached?.source === source) return cached.js;
    const js = await transpileUserCode(category, key, source);
    this.cache.transpiled.set(id, { source, js });
    return js;
  }

  private async syncNow(): Promise<Result<SyncReport>> {
    if (!this.confirmed) {
      const held = await this.askRunner();
      if (!held.ok) return held;
      this.confirmed = held.data;
    }
    const confirmed = this.confirmed;
    const current = await this.currentManifest();
    const removes: MirrorRef[] = [];
    for (const [id, held] of confirmed) {
      if (!current.has(id)) {
        removes.push({ category: held.category, key: held.key });
      }
    }
    const upserts: MirrorUpsert[] = [];
    const failed: MirrorManifestEntry[] = [];
    const failures: MirrorFailure[] = [];
    for (const [id, { candidate, hash }] of current) {
      if (confirmed.get(id)?.hash === hash) continue;
      const { category, key } = candidate;
      const payload = await candidate.payload();
      if (payload.ok) {
        upserts.push(
          { category, key, hash, payload: payload.data } as MirrorUpsert,
        );
      } else {
        failed.push({ category, key, hash });
        failures.push({ category, key, error: payload.error });
      }
    }
    this.dropStaleTranspiles(current);
    if (!removes.length && !upserts.length && !failed.length) {
      return { ok: true, data: { sent: 0, removed: 0, failures } };
    }
    const answer = await this.runner.sync({ removes, upserts, failed });
    if (!answer.ok) {
      // The runner may have applied some of it.
      this.reset();
      return answer;
    }
    for (const ref of removes) confirmed.delete(mirrorEntryId(ref));
    for (const { category, key, hash } of [...upserts, ...failed]) {
      confirmed.set(mirrorEntryId({ category, key }), {
        category,
        key,
        hash,
      });
    }
    return {
      ok: true,
      data: {
        sent: upserts.length + failed.length,
        removed: removes.length,
        failures: [...failures, ...answer.data.failures],
      },
    };
  }

  private async askRunner(): Promise<
    Result<Map<string, MirrorManifestEntry>>
  > {
    const held = await this.runner.manifest();
    if (!held.ok) return held;
    return {
      ok: true,
      data: new Map(held.data.map((e) => [mirrorEntryId(e), e])),
    };
  }

  private async currentManifest(): Promise<Map<string, Hashed>> {
    const current = new Map<string, Hashed>();
    for (const candidate of this.candidates()) {
      const id = mirrorEntryId(candidate);
      current.set(id, { candidate, hash: await this.hashOf(id, candidate) });
    }
    return current;
  }

  private async hashOf(id: string, candidate: Candidate): Promise<string> {
    const { identity } = candidate;
    if (identity) {
      const known = this.cache.hashByEntry.get(identity);
      if (known) return known;
      const hash = await hashText(candidate.fingerprint());
      this.cache.hashByEntry.set(identity, hash);
      return hash;
    }
    const text = candidate.fingerprint();
    const known = this.cache.hashByText.get(id);
    if (known?.text === text) return known.hash;
    const hash = await hashText(text);
    this.cache.hashByText.set(id, { text, hash });
    return hash;
  }

  private dropStaleTranspiles(current: Map<string, Hashed>): void {
    for (const id of this.cache.transpiled.keys()) {
      if (!current.has(id)) this.cache.transpiled.delete(id);
    }
  }

  private *candidates(): Iterable<Candidate> {
    const k = this.kernel;
    for (const e of k.handlers.list()) {
      yield this.code({ category: MIRROR_CATEGORIES.handler, ...named(e) }, e);
    }
    for (const e of k.functions.list()) {
      yield this.code({ category: MIRROR_CATEGORIES.function, ...named(e) }, e);
    }
    for (const e of k.tests.list()) {
      yield this.code({ category: MIRROR_CATEGORIES.test, ...named(e) }, e);
    }
    for (const e of k.devViews.list()) {
      // Built-in views are kernel code and run in the kernel.
      if (e.builtIn) continue;
      yield this.code({ category: MIRROR_CATEGORIES.devView, ...named(e) }, e);
    }
    for (const e of k.devTools.list()) {
      yield this.code(
        { category: MIRROR_CATEGORIES.devTool, ...named(e), args: e.args },
        e,
        () => jsonText([e.source, e.args]),
      );
    }
    for (const e of k.templates.list()) {
      yield plain(MIRROR_CATEGORIES.template, e.name, e, () => e.content, {
        content: e.content,
      });
    }
    for (const { name } of k.assets.list()) {
      const e = k.assets.get(name);
      if (!e) continue;
      yield plain(
        MIRROR_CATEGORIES.assetVersion,
        name,
        e,
        () => e.registeredAt,
        {
          version: assetVersionOf(e.registeredAt),
        },
      );
    }
    for (const { name } of k.configs.list()) {
      const e = k.configs.getEntry(name);
      if (!e) continue;
      yield plain(MIRROR_CATEGORIES.config, name, e, () => jsonText(e.value), {
        value: e.value,
      });
    }
    for (const d of k.db.schemas.listDefinitions()) {
      yield plain(
        MIRROR_CATEGORIES.schema,
        d.tableName,
        d,
        () => jsonText(d.columns),
        {
          columns: [...d.columns],
        },
      );
    }
    for (const { name } of k.packages.list()) {
      const e = k.packages.getEntry(name);
      if (!e) continue;
      yield plain(MIRROR_CATEGORIES.package, name, e, () => e.specifier, {
        specifier: e.specifier,
      });
    }
    const vars = k.envSnapshot();
    yield plain(
      MIRROR_CATEGORIES.env,
      MIRROR_SINGLETON_KEY,
      undefined,
      () => stableJson(vars),
      {
        vars,
      },
    );
    const app = { port: k.appPort, origin: appPreviewOrigin(k.appPort) };
    yield plain(
      MIRROR_CATEGORIES.app,
      MIRROR_SINGLETON_KEY,
      undefined,
      () => jsonText(app),
      app,
    );
  }

  // User code: the payload is built from its JS, transpiled only when sent.
  private code(
    entity: UserCodeSource,
    identity: object,
    fingerprint: () => string = () => entity.source,
  ): Candidate {
    return {
      category: entity.category,
      key: entity.key,
      identity,
      fingerprint,
      payload: async () => {
        const entry = await this.userCodePayload(entity);
        return entry.ok ? { ok: true, data: entry.data.payload } : entry;
      },
    };
  }

  private async userCodePayload(
    entity: UserCodeSource,
  ): Promise<Result<MirrorPayload>> {
    const { category, key, source } = entity;
    const js = await this.transpile(category, key, source);
    if (!js.ok) return js;
    switch (entity.category) {
      case MIRROR_CATEGORIES.handler:
        return payload(entity.category, key, {
          js: js.data,
          abi: detectHandlerAbi(source, key),
        });
      case MIRROR_CATEGORIES.devTool:
        return payload(entity.category, key, {
          js: js.data,
          args: entity.args,
        });
      default:
        return payload(entity.category, key, { js: js.data });
    }
  }
}

function named(e: { name: string; source: string }) {
  return { key: e.name, source: e.source };
}

function payload<C extends MirrorCategory>(
  category: C,
  key: string,
  data: MirrorPayloads[C],
): Result<MirrorPayload> {
  return {
    ok: true,
    data: { category, key, payload: data } as MirrorPayload,
  };
}

function plain<C extends MirrorCategory>(
  category: C,
  key: string,
  identity: object | undefined,
  fingerprint: () => string,
  payload: MirrorPayloads[C],
): Candidate<C> {
  return {
    category,
    key,
    ...(identity ? { identity } : {}),
    fingerprint,
    payload: () => Promise.resolve({ ok: true, data: payload }),
  };
}

function hashText(text: string): Promise<string> {
  return sha256Hex(new TextEncoder().encode(text));
}

// JSON.stringify gives undefined for undefined; a hash needs text.
function jsonText(value: unknown): string {
  return JSON.stringify(value) ?? "undefined";
}

// The same vars in a different order are the same env.
function stableJson(vars: Record<string, string>): string {
  return JSON.stringify(
    Object.entries(vars).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0),
  );
}
