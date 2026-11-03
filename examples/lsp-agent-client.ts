// A minimal JSON-RPC client that drives the OpenTide LSP server as an EXTERNAL
// AGENT would — the §5 headline use case (docs/lsp-support-plan.md): an agent never
// "saves" through LSP, it uses LSP purely as a FEEDBACK CHANNEL. It asks for
// completions to learn a signature, then watches the pushed diagnostics to
// self-correct: send a buffer with an error, see the squiggle, fix it, see it clear.
//
// This is a standalone CLIENT, a separate process from the server. The server must
// never write non-protocol bytes to stdout (that is the JSON-RPC channel); a client
// is under no such rule and prints its narration freely to its own stdout/stderr.
//
// Framing is REUSED from the server's transport (lsp/transport.ts encodeMessage +
// MessageBuffer) rather than reinvented — the exact same Content-Length framing the
// server speaks. `runAgentRecipe` is transport-agnostic: it drives any duplex byte
// pair, so the same recipe runs against a spawned `opentide lsp` subprocess (main
// below) or an in-process server over in-memory pipes (lsp-agent-client_test.ts).
import { encodeMessage, MessageBuffer } from "../lsp/transport.ts";
import {
  type CompletionItem,
  type Diagnostic,
  DiagnosticSeverity,
  type InitializeResult,
  JSONRPC_VERSION,
  LspMethods,
  type PublishDiagnosticsParams,
  type ResponseError,
  type ShowMessageParams,
} from "../lsp/protocol.ts";
import { entityUri } from "../lsp/uri.ts";

// The virtual entity the recipe drives. An agent constructs the opentide:// URI
// directly (the addressing gap plain editors hit — docs/lsp-connect.md — simply
// doesn't apply to an agent that knows the entity coordinates). The subprocess demo
// and the in-process test both target this handler, so the test registers it under
// the same name the recipe opens.
export const DEMO_RUNTIME_ID = "typescript";
export const DEMO_ENTITY_TYPE = "handler";
export const DEMO_ENTITY_NAME = "getUsers";
export const DEMO_URI = entityUri({
  runtimeId: DEMO_RUNTIME_ID,
  entityType: DEMO_ENTITY_TYPE,
  entityName: DEMO_ENTITY_NAME,
});

// v1 — a buffer whose cursor sits right after `db.` so completion returns the
// global's members (the "learn a signature" step). `db` is declared in the service's
// auto-generated globals, so its members complete regardless of param typing.
export const DEMO_PROBE_SOURCE = "async function getUsers(c) {\n  db.\n}\n";
// The 0-based position right after the `.` in `db.` on line 2.
export const DEMO_COMPLETION_POSITION = { line: 1, character: 5 };

// v2 — a genuine type error (number = string): the compiler must flag it, so the
// pushed diagnostics carry a tsc Error. This is the "see the squiggle" step.
export const DEMO_BROKEN_SOURCE =
  'async function getUsers(c) {\n  const n: number = "oops";\n  return c.json({ n });\n}\n';
// v3 — the fix. The type error is gone, so the next push clears it: "self-correct".
export const DEMO_FIXED_SOURCE =
  "async function getUsers(c) {\n  const n: number = 42;\n  return c.json({ n });\n}\n";

// The framed byte duplex the recipe drives: what the client writes reaches the
// server's stdin; what the server writes back (responses + pushes) arrives on
// `fromServer`. A subprocess supplies child.stdin/child.stdout; the test supplies a
// pair of in-memory TransformStreams.
export interface DuplexStreams {
  toServer: WritableStream<Uint8Array>;
  fromServer: ReadableStream<Uint8Array>;
}

// What the recipe observed, returned so a caller (the test) can assert on it and the
// demo (main) can narrate it. `errorsWhenBroken` / `errorsWhenFixed` are the
// Error-severity diagnostics on the broken vs fixed buffer — the self-correction
// delta is the whole point.
export interface RecipeResult {
  serverName: string;
  serverVersion: string;
  surfaceVersion?: string;
  surfaceFingerprint?: string;
  completionLabels: string[];
  errorsWhenBroken: Diagnostic[];
  errorsWhenFixed: Diagnostic[];
}

// A decoded incoming frame is either a JSON-RPC response (has `id`, no `method`) or
// a server→client notification (has `method`). We model just the fields we read.
interface DecodedResponse {
  id: number | string;
  result?: unknown;
  error?: ResponseError;
}
interface DecodedNotification {
  method: string;
  params?: unknown;
}

function isNotification(
  msg: DecodedResponse | DecodedNotification,
): msg is DecodedNotification {
  return "method" in msg &&
    typeof (msg as DecodedNotification).method === "string";
}

// A tiny JSON-RPC client over the framed duplex: it writes requests/notifications
// and runs a read loop that DEMUXES responses (matched to their request id) from
// server→client pushes (publishDiagnostics buffered, showMessage collected). This is
// exactly the shape an agent harness embeds; it depends only on the wire types +
// framing, nothing kernel-side.
export class LspClient {
  readonly #writer: WritableStreamDefaultWriter<Uint8Array>;
  readonly #incoming = new MessageBuffer();
  #nextId = 1;
  readonly #pending = new Map<
    number | string,
    { resolve: (value: unknown) => void; reject: (reason: Error) => void }
  >();
  readonly #diagnostics = new Map<string, PublishDiagnosticsParams>();
  readonly #diagnosticsWaiters: Array<{
    predicate: (params: PublishDiagnosticsParams) => boolean;
    resolve: (params: PublishDiagnosticsParams) => void;
    reject: (reason: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }> = [];
  readonly showMessages: ShowMessageParams[] = [];
  readonly #readLoop: Promise<void>;

  constructor(streams: DuplexStreams) {
    this.#writer = streams.toServer.getWriter();
    this.#readLoop = this.#read(streams.fromServer);
  }

  async #read(from: ReadableStream<Uint8Array>): Promise<void> {
    for await (const chunk of from) {
      this.#incoming.append(chunk);
      for (
        let msg = this.#incoming.tryReadMessage();
        msg !== null;
        msg = this.#incoming.tryReadMessage()
      ) {
        this.#handle(msg as unknown as DecodedResponse | DecodedNotification);
      }
    }
    // The server closed its output (it processed `exit`): fail anything still waiting
    // rather than hang forever.
    const closed = new Error("server closed the connection");
    for (const p of this.#pending.values()) p.reject(closed);
    this.#pending.clear();
    for (const w of this.#diagnosticsWaiters.splice(0)) {
      clearTimeout(w.timer);
      w.reject(closed);
    }
  }

  #handle(msg: DecodedResponse | DecodedNotification): void {
    if (!isNotification(msg)) {
      const pending = this.#pending.get(msg.id);
      if (!pending) return;
      this.#pending.delete(msg.id);
      if (msg.error) {
        pending.reject(new Error(`[${msg.error.code}] ${msg.error.message}`));
      } else pending.resolve(msg.result);
      return;
    }
    if (msg.method === LspMethods.PublishDiagnostics) {
      const params = msg.params as PublishDiagnosticsParams;
      this.#diagnostics.set(params.uri, params);
      for (let i = this.#diagnosticsWaiters.length - 1; i >= 0; i--) {
        const waiter = this.#diagnosticsWaiters[i]!;
        if (waiter.predicate(params)) {
          this.#diagnosticsWaiters.splice(i, 1);
          clearTimeout(waiter.timer);
          waiter.resolve(params);
        }
      }
    } else if (msg.method === LspMethods.ShowMessage) {
      this.showMessages.push(msg.params as ShowMessageParams);
    }
    // opentide/changesetStatus and opentide/documentChanged are ignored by this read-only
    // recipe — an agent using LSP as a feedback channel never triggers them.
  }

  request<T>(method: string, params: unknown): Promise<T> {
    const id = this.#nextId++;
    const promise = new Promise<unknown>((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
    });
    return this.#send({ jsonrpc: JSONRPC_VERSION, id, method, params })
      .then(() => promise) as Promise<T>;
  }

  notify(method: string, params: unknown): Promise<void> {
    return this.#send({ jsonrpc: JSONRPC_VERSION, method, params });
  }

  #send(message: unknown): Promise<void> {
    return this.#writer.write(
      encodeMessage(message as Parameters<typeof encodeMessage>[0]),
    );
  }

  // Resolve with the NEXT pushed diagnostics matching `predicate`. Register it BEFORE
  // sending the edit that triggers the push, so a fast (debounced) publish can't be
  // missed. Rejects on timeout so a hung server surfaces rather than deadlocks.
  nextDiagnostics(
    predicate: (params: PublishDiagnosticsParams) => boolean,
    timeoutMs = 5000,
  ): Promise<PublishDiagnosticsParams> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = this.#diagnosticsWaiters.findIndex((w) =>
          w.timer === timer
        );
        if (idx >= 0) this.#diagnosticsWaiters.splice(idx, 1);
        reject(new Error("timed out waiting for diagnostics"));
      }, timeoutMs);
      this.#diagnosticsWaiters.push({ predicate, resolve, reject, timer });
    });
  }

  async close(): Promise<void> {
    await this.#writer.close().catch(() => {});
    await this.#readLoop;
  }
}

// Only the errors matter for the self-correction story; a Warning/Hint (e.g. a QC
// advisory) is noise here.
function errorDiagnostics(params: PublishDiagnosticsParams): Diagnostic[] {
  return params.diagnostics.filter((d) =>
    d.severity === DiagnosticSeverity.Error
  );
}

// The recipe itself: initialize → learn a signature via completion → watch
// diagnostics drive a fix. Pure over the duplex; a `log` sink lets the demo narrate
// and the test stay quiet. Returns everything it observed.
export async function runAgentRecipe(
  streams: DuplexStreams,
  log: (message: string) => void = () => {},
): Promise<RecipeResult> {
  const client = new LspClient(streams);
  try {
    // 1. Handshake. Read the identity + the Stage-8 surface contract off initialize.
    const init = await client.request<InitializeResult>(LspMethods.Initialize, {
      processId: null,
      rootUri: null,
      capabilities: {},
    });
    await client.notify(LspMethods.Initialized, {});
    const surface = init.capabilities.opentideSurface;
    log(
      `connected to ${init.serverInfo.name} v${init.serverInfo.version} ` +
        `(surface ${surface?.version ?? "?"} / ${surface?.fingerprint ?? "?"})`,
    );

    // 2. Open the entity as a opentide:// document (v1: the completion-probe buffer).
    await client.notify(LspMethods.DidOpen, {
      textDocument: {
        uri: DEMO_URI,
        languageId: DEMO_RUNTIME_ID,
        version: 1,
        text: DEMO_PROBE_SOURCE,
      },
    });

    // 3. Learn a signature: what can I call on `db.`? (completions as the agent's way
    // to discover the API without guessing.)
    const items = await client.request<CompletionItem[]>(
      LspMethods.Completion,
      {
        textDocument: { uri: DEMO_URI },
        position: DEMO_COMPLETION_POSITION,
      },
    );
    const completionLabels = items.map((i) => i.label);
    log(
      `completion after "db." → ${completionLabels.length} members ` +
        `(e.g. ${completionLabels.slice(0, 5).join(", ")})`,
    );

    // 4. Introduce a type error and WATCH the diagnostics come back (register the
    // waiter before the edit so the debounced push can't slip past).
    const brokenPushed = client.nextDiagnostics((p) =>
      p.uri === DEMO_URI && p.version === 2
    );
    await client.notify(LspMethods.DidChange, {
      textDocument: { uri: DEMO_URI, version: 2 },
      contentChanges: [{ text: DEMO_BROKEN_SOURCE }],
    });
    const errorsWhenBroken = errorDiagnostics(await brokenPushed);
    log(
      `sent a buffer with a type error → ${errorsWhenBroken.length} error ` +
        `diagnostic(s): ${errorsWhenBroken.map((d) => d.message).join("; ")}`,
    );

    // 5. Self-correct: fix the buffer, watch the squiggle clear.
    const fixedPushed = client.nextDiagnostics((p) =>
      p.uri === DEMO_URI && p.version === 3
    );
    await client.notify(LspMethods.DidChange, {
      textDocument: { uri: DEMO_URI, version: 3 },
      contentChanges: [{ text: DEMO_FIXED_SOURCE }],
    });
    const errorsWhenFixed = errorDiagnostics(await fixedPushed);
    log(
      `fixed the buffer → ${errorsWhenFixed.length} error diagnostic(s) remain ` +
        "(self-corrected)",
    );

    // 6. Clean shutdown.
    await client.request(LspMethods.Shutdown, null);
    await client.notify(LspMethods.Exit, {});

    return {
      serverName: init.serverInfo.name,
      serverVersion: init.serverInfo.version,
      surfaceVersion: surface?.version,
      surfaceFingerprint: surface?.fingerprint,
      completionLabels,
      errorsWhenBroken,
      errorsWhenFixed,
    };
  } finally {
    await client.close();
  }
}

// --- Runnable demo: spawn `opentide lsp` and drive it over stdio ---------------
//
//   deno run --allow-run --allow-read examples/lsp-agent-client.ts /abs/path/to/project
//
// Spawns the server as a subprocess (the real external-agent shape) and drives the
// recipe over its stdin/stdout. The server logs to stderr (inherited), so its noise
// and the client's narration don't collide. This block never runs under `deno test`.
async function main(): Promise<void> {
  const projectPath = Deno.args[0];
  if (!projectPath) {
    console.error(
      "usage: deno run --allow-run --allow-read " +
        "examples/lsp-agent-client.ts <project-path>",
    );
    Deno.exit(2);
  }

  // Launch from the repo root (where deno.json lives) so `deno task lsp` resolves.
  const repoRoot = new URL("../", import.meta.url);
  const child = new Deno.Command("deno", {
    args: ["task", "lsp", "--project", projectPath],
    cwd: repoRoot,
    stdin: "piped",
    stdout: "piped",
    stderr: "inherit",
  }).spawn();

  console.log(`\n=== OpenTide LSP agent recipe against "${projectPath}" ===\n`);
  let result: RecipeResult;
  try {
    result = await runAgentRecipe(
      { toServer: child.stdin, fromServer: child.stdout },
      (message) => console.log(`  · ${message}`),
    );
  } catch (error) {
    // Most commonly a bad --project path: the server logs the reason to stderr
    // (inherited above) and exits, so the handshake fails here.
    console.error(
      `\n=== FAILED: ${
        error instanceof Error ? error.message : String(error)
      } (see the server's stderr above) ===\n`,
    );
    await child.status;
    Deno.exit(1);
  }
  await child.status;

  const selfCorrected = result.errorsWhenBroken.length > 0 &&
    result.errorsWhenFixed.length === 0;
  console.log(
    `\n=== ${
      selfCorrected ? "OK" : "UNEXPECTED"
    }: completions learned (${result.completionLabels.length}), ` +
      `error introduced (${result.errorsWhenBroken.length}) then cleared ` +
      `(${result.errorsWhenFixed.length}) ===\n`,
  );
  Deno.exit(selfCorrected ? 0 : 1);
}

if (import.meta.main) await main();
