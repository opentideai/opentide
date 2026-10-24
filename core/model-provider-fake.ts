// @layer core — a deterministic, network-free ModelProvider for tests
// (multi-model harness, docs/multi-model-harness-plan.md Stage 1).
//
// FakeModelProvider replays a scripted sequence of turns: each turn is a
// ProviderEvent[] that streamTurn yields in order. It records every TurnRequest
// it receives so tests can assert what the loop sent. This is the seed of the
// Stage-3 golden-sequence harness (drive the client-side loop with no network,
// then diff the emitted ChatEvent stream and the requests the loop produced).
//
// LANDS DARK: nothing imports this yet.

import type {
  ModelProvider,
  ProviderEvent,
  TurnRequest,
} from "./model-provider.ts";

// One scripted turn = the events streamTurn yields for a single provider call.
export type ScriptedTurn = ProviderEvent[];

export class FakeModelProvider implements ModelProvider {
  readonly id: string;
  readonly supportsCaching: boolean;

  readonly #script: ScriptedTurn[];
  #turnIndex = 0;
  readonly #requests: TurnRequest[] = [];

  constructor(
    script: ScriptedTurn[],
    opts: { id?: string; supportsCaching?: boolean } = {},
  ) {
    this.#script = script;
    this.id = opts.id ?? "fake";
    this.supportsCaching = opts.supportsCaching ?? false;
  }

  // The TurnRequests passed to streamTurn so far, in call order.
  get requests(): readonly TurnRequest[] {
    return this.#requests;
  }

  // How many scripted turns have not yet been consumed.
  get turnsRemaining(): number {
    return this.#script.length - this.#turnIndex;
  }

  async *streamTurn(
    req: TurnRequest,
    signal: AbortSignal,
  ): AsyncIterable<ProviderEvent> {
    this.#requests.push(req);
    const turn = this.#script[this.#turnIndex];
    if (turn === undefined) {
      throw new Error(
        `FakeModelProvider: no scripted turn at index ${this.#turnIndex} ` +
          `(script has ${this.#script.length} turn(s)); the loop called ` +
          `streamTurn more times than the test scripted.`,
      );
    }
    this.#turnIndex += 1;

    for (const event of turn) {
      // Honor cancellation: stop iterating as soon as the signal is aborted,
      // including before the first event.
      if (signal.aborted) return;
      // `await` yields to the microtask queue so an abort scheduled between
      // events is observed on the next loop iteration (matches a real stream).
      await Promise.resolve();
      if (signal.aborted) return;
      yield event;
    }
  }
}
