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
import type { Result } from "../types.ts";
import { sha256Hex } from "../util.ts";
import type { RpcPeer } from "./peer.ts";
import {
  MIRROR_CATEGORIES,
  MIRROR_SINGLETON_KEY,
  type MirrorCategory,
  mirrorEntryId,
  type MirrorFailure,
  type MirrorManifestEntry,
  type MirrorPayloads,
  type MirrorRef,
  type MirrorUpsert,
  RUNNER_METHODS,
  type StateSyncAnswer,
  type StateSyncRequest,
} from "./protocol.ts";

// The runner's two state methods, as the mirror calls them.
export interface RunnerStateChannel {
  sync(request: StateSyncRequest): Promise<Result<StateSyncAnswer>>;
  manifest(): Promise<Result<MirrorManifestEntry[]>>;
}

export function rpcStateChannel(peer: RpcPeer): RunnerStateChannel {
  return {
    sync: (request) =>
      peer.request<StateSyncAnswer>(
        RUNNER_METHODS.stateSync,
        request,
        RUNNER_REQUEST_TIMEOUT_MS,
      ),
    manifest: () =>
      peer.request<MirrorManifestEntry[]>(
        RUNNER_METHODS.stateManifest,
        null,
        RUNNER_REQUEST_TIMEOUT_MS,
      ),
  };
}

export interface SyncReport {
  sent: number;
  removed: number;
  // Entries that won't run in the runner: transpile errors from here,
  // instantiate errors from there. Each is reported by the sync that sent it,
  // and again only once its source changes.
  failures: MirrorFailure[];
}

type UserCodeCategory =
  | typeof MIRROR_CATEGORIES.handler
  | typeof MIRROR_CATEGORIES.function
  | typeof MIRROR_CATEGORIES.test
  | typeof MIRROR_CATEGORIES.devView
  | typeof MIRROR_CATEGORIES.devTool;

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

export class StateMirror {
  // What the runner holds, failed entries included. Null when that isn't
  // known (a new mirror, a respawned runner, a send that failed half-way):
  // the next sync asks the runner first.
  private confirmed: Map<string, MirrorManifestEntry> | null = null;
  private readonly hashByEntry = new WeakMap<object, string>();
  private readonly hashByText = new Map<
    string,
    { text: string; hash: string }
  >();
  // One slot per entity: its last source and what that transpiled to.
  private readonly transpiled = new Map<
    string,
    { source: string; js: Result<string> }
  >();
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly kernel: Kernel,
    private readonly runner: RunnerStateChannel,
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

  // The JS for one entity, from the cache when its source hasn't changed.
  // The define path fills it, so a sync rarely transpiles.
  async transpile(
    category: UserCodeCategory,
    key: string,
    source: string,
  ): Promise<Result<string>> {
    const id = mirrorEntryId({ category, key });
    const cached = this.transpiled.get(id);
    if (cached?.source === source) return cached.js;
    const js = await transpileUserCode(category, key, source);
    this.transpiled.set(id, { source, js });
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
      const known = this.hashByEntry.get(identity);
      if (known) return known;
      const hash = await hashText(candidate.fingerprint());
      this.hashByEntry.set(identity, hash);
      return hash;
    }
    const text = candidate.fingerprint();
    const known = this.hashByText.get(id);
    if (known?.text === text) return known.hash;
    const hash = await hashText(text);
    this.hashByText.set(id, { text, hash });
    return hash;
  }

  private dropStaleTranspiles(current: Map<string, Hashed>): void {
    for (const id of this.transpiled.keys()) {
      if (!current.has(id)) this.transpiled.delete(id);
    }
  }

  private *candidates(): Iterable<Candidate> {
    const k = this.kernel;
    for (const e of k.handlers.list()) {
      yield this.code(MIRROR_CATEGORIES.handler, e.name, e, e.source, (js) => ({
        js,
        abi: detectHandlerAbi(e.source, e.name),
      }));
    }
    for (const e of k.functions.list()) {
      yield this.code(
        MIRROR_CATEGORIES.function,
        e.name,
        e,
        e.source,
        (js) => ({ js }),
      );
    }
    for (const e of k.tests.list()) {
      yield this.code(
        MIRROR_CATEGORIES.test,
        e.name,
        e,
        e.source,
        (js) => ({ js }),
      );
    }
    for (const e of k.devViews.list()) {
      // Built-in views are kernel code and run in the kernel.
      if (e.builtIn) continue;
      yield this.code(
        MIRROR_CATEGORIES.devView,
        e.name,
        e,
        e.source,
        (js) => ({ js }),
      );
    }
    for (const e of k.devTools.list()) {
      yield this.code(
        MIRROR_CATEGORIES.devTool,
        e.name,
        e,
        e.source,
        (js) => ({ js, args: e.args }),
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
  private code<C extends UserCodeCategory>(
    category: C,
    key: string,
    identity: object,
    source: string,
    build: (js: string) => MirrorPayloads[C],
    fingerprint: () => string = () => source,
  ): Candidate<C> {
    return {
      category,
      key,
      identity,
      fingerprint,
      payload: async () => {
        const js = await this.transpile(category, key, source);
        return js.ok ? { ok: true, data: build(js.data) } : js;
      },
    };
  }
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
