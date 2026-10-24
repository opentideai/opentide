import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { Kernel } from "../core/registries.ts";
import { Database } from "../core/db.ts";
import { initCompiler, stopCompiler } from "../core/compiler.ts";
import type { DiagnosticEntry } from "../core/language-service.ts";
import {
  createTypeScriptRuntimeAdapter,
  type RuntimeAdapter,
} from "../core/runtime.ts";
import {
  getKernelSettings,
  LSP_CREATE_ENTITY_COMMAND,
} from "../core/config.ts";
import type {
  CompositionContext,
  SaveRiskPolicy,
} from "../core/composition.ts";
import type { ChangesetPlan } from "../core/types.ts";
import { testComposition } from "../cli/test-composition.ts";
import { dispatchTool } from "../core/tools/dispatch.ts";
import { LspServer } from "./server.ts";
import { encodeMessage, MessageBuffer, serveLspStdio } from "./transport.ts";
import {
  type ChangesetStatusParams,
  type CompletionItem,
  CompletionItemKind,
  type CreateEntityResult,
  DiagnosticSeverity,
  type DocumentChangedParams,
  ErrorCodes,
  type Hover,
  type IncomingMessage,
  type InitializeResult,
  JSONRPC_VERSION,
  type Location,
  LspMethods,
  MessageType,
  type NotificationMessage,
  type PublishDiagnosticsParams,
  type ResponseMessage,
  type ShowMessageParams,
  TextDocumentSyncKind,
  type TextDocumentSyncOptions,
  type WorkspaceEdit,
} from "./protocol.ts";

const testOpts = { sanitizeResources: false, sanitizeOps: false };
const URI = "opentide://typescript/handlers/getUsers.ts";

async function withKernel<T>(fn: (kernel: Kernel) => Promise<T>): Promise<T> {
  const db = await Database.create({ driver: "pglite" });
  const kernel = new Kernel(db, { composition: testComposition() });
  try {
    return await fn(kernel);
  } finally {
    await db.close();
  }
}

Deno.test(
  "initialize advertises serverInfo + read providers",
  testOpts,
  async () => {
    await withKernel(async (kernel) => {
      // Force read-only so this asserts the read-feature advertisement independent of
      // the write-path default (a dedicated write-advertisement test lives below).
      const server = new LspServer({ kernel, writeFeaturesEnabled: false });
      const response = await server.dispatch({
        jsonrpc: JSONRPC_VERSION,
        id: 1,
        method: LspMethods.Initialize,
        params: {},
      });
      assert(response);
      const result = response.result as InitializeResult;
      // Read-only ⇒ the bare Full sync number, no save advertised.
      assertEquals(
        result.capabilities.textDocumentSync,
        TextDocumentSyncKind.Full,
      );
      assertEquals(result.serverInfo.name, "opentide");
      // Stage 1 read providers are advertised (the runtime offers languageIntelligence).
      assertEquals(result.capabilities.completionProvider, {
        resolveProvider: false,
      });
      assertEquals(result.capabilities.hoverProvider, true);
      assertEquals(result.capabilities.definitionProvider, true);
      assertEquals(result.capabilities.referencesProvider, true);
      assertEquals(result.capabilities.documentHighlightProvider, true);
    });
  },
);

Deno.test(
  "a request before initialize is ServerNotInitialized",
  testOpts,
  async () => {
    await withKernel(async (kernel) => {
      const server = new LspServer({ kernel });
      const response = await server.dispatch({
        jsonrpc: JSONRPC_VERSION,
        id: 7,
        method: "textDocument/completion",
        params: {},
      });
      assert(response?.error);
      assertEquals(response.error.code, ErrorCodes.ServerNotInitialized);
    });
  },
);

Deno.test(
  "didOpen then didChange round-trips without error",
  testOpts,
  async () => {
    await withKernel(async (kernel) => {
      const server = new LspServer({ kernel });
      await server.dispatch({
        jsonrpc: JSONRPC_VERSION,
        id: 1,
        method: LspMethods.Initialize,
        params: {},
      });
      // Notifications return null and must not throw.
      assertEquals(
        await server.dispatch({
          jsonrpc: JSONRPC_VERSION,
          method: LspMethods.DidOpen,
          params: {
            textDocument: {
              uri: URI,
              languageId: "typescript",
              version: 1,
              text: "export default (c) => c.json({})",
            },
          },
        }),
        null,
      );
      assertEquals(
        await server.dispatch({
          jsonrpc: JSONRPC_VERSION,
          method: LspMethods.DidChange,
          params: {
            textDocument: { uri: URI, version: 2 },
            contentChanges: [{ text: "export default (c) => c.text('hi')" }],
          },
        }),
        null,
      );
    });
  },
);

Deno.test(
  "unknown request after initialize is MethodNotFound",
  testOpts,
  async () => {
    await withKernel(async (kernel) => {
      const server = new LspServer({ kernel });
      await server.dispatch({
        jsonrpc: JSONRPC_VERSION,
        id: 1,
        method: LspMethods.Initialize,
        params: {},
      });
      const response = await server.dispatch({
        jsonrpc: JSONRPC_VERSION,
        id: 2,
        method: "textDocument/foo",
        params: {},
      });
      assert(response?.error);
      assertEquals(response.error.code, ErrorCodes.MethodNotFound);
    });
  },
);

Deno.test("shutdown then exit stops the server", testOpts, async () => {
  await withKernel(async (kernel) => {
    const server = new LspServer({ kernel });
    const shutdown = await server.dispatch({
      jsonrpc: JSONRPC_VERSION,
      id: 9,
      method: LspMethods.Shutdown,
    });
    assertEquals(shutdown, { jsonrpc: JSONRPC_VERSION, id: 9, result: null });
    assert(!server.hasExited());
    await server.dispatch({
      jsonrpc: JSONRPC_VERSION,
      method: LspMethods.Exit,
    });
    assert(server.hasExited());
  });
});

// End-to-end through the stdio transport: encode a full lifecycle as
// Content-Length frames, feed them through serveLspStdio over in-memory streams,
// and decode the responses — the Stage-0 exit criterion (an editor connects,
// opens a opentide:// doc, didChange round-trips) exercised over the real framing.
Deno.test("full lifecycle over the framed transport", testOpts, async () => {
  await withKernel(async (kernel) => {
    const server = new LspServer({ kernel });

    const frame = (message: IncomingMessage): Uint8Array =>
      encodeMessage(message as unknown as ResponseMessage);
    const script: IncomingMessage[] = [
      {
        jsonrpc: JSONRPC_VERSION,
        id: 1,
        method: LspMethods.Initialize,
        params: {},
      },
      { jsonrpc: JSONRPC_VERSION, method: LspMethods.Initialized, params: {} },
      {
        jsonrpc: JSONRPC_VERSION,
        method: LspMethods.DidOpen,
        params: {
          textDocument: {
            uri: URI,
            languageId: "typescript",
            version: 1,
            text: "const a = 1",
          },
        },
      },
      {
        jsonrpc: JSONRPC_VERSION,
        method: LspMethods.DidChange,
        params: {
          textDocument: { uri: URI, version: 2 },
          contentChanges: [{ text: "const a = 2" }],
        },
      },
      { jsonrpc: JSONRPC_VERSION, id: 2, method: LspMethods.Shutdown },
      { jsonrpc: JSONRPC_VERSION, method: LspMethods.Exit },
    ];

    // One chunk carrying every frame — the buffer must split them apart.
    const allBytes = concat(script.map(frame));
    const input = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(allBytes);
        controller.close();
      },
    });
    const collected: Uint8Array[] = [];
    const output = new WritableStream<Uint8Array>({
      write(chunk) {
        collected.push(chunk);
      },
    });

    await serveLspStdio(server, { input, output });

    // Decode the responses back out of the framed output.
    const responses = decodeAll(concat(collected));
    // Exactly two requests were sent (initialize, shutdown) ⇒ two responses.
    assertEquals(responses.length, 2);
    assertEquals(responses[0]!.id, 1);
    assertEquals(
      (responses[0]!.result as InitializeResult).serverInfo.name,
      "opentide",
    );
    assertEquals(responses[1]!.id, 2);
    assertEquals(responses[1]!.result, null);
    assert(server.hasExited());
  });
});

// --- Stage 1: read-only language features against a real PGlite kernel ---

// Drive an initialized server with a registered handler open at URI. The feature
// requests pass the buffer as content, so the language service works off the live
// override (exactly the didChange path) even though the entity is also registered.
async function withOpenHandler(
  content: string,
  fn: (server: LspServer) => Promise<void>,
): Promise<void> {
  await withKernel(async (kernel) => {
    kernel.handlers.register(
      "getUsers",
      content,
      () => new Response("[]"),
      undefined,
      "users",
    );
    const server = new LspServer({ kernel });
    await server.dispatch({
      jsonrpc: JSONRPC_VERSION,
      id: 1,
      method: LspMethods.Initialize,
      params: {},
    });
    await server.dispatch({
      jsonrpc: JSONRPC_VERSION,
      method: LspMethods.DidOpen,
      params: {
        textDocument: {
          uri: URI,
          languageId: "typescript",
          version: 1,
          text: content,
        },
      },
    });
    await fn(server);
  });
}

Deno.test(
  "completion returns member items translated to LSP shape",
  testOpts,
  async () => {
    // Cursor right after `db.` — the global `db` is declared in globals.d.ts, so its
    // members complete regardless of handler-param typing.
    await withOpenHandler(
      "async function getUsers(c) {\n  db.\n}\n",
      async (server) => {
        const response = await server.dispatch({
          jsonrpc: JSONRPC_VERSION,
          id: 2,
          method: LspMethods.Completion,
          params: {
            textDocument: { uri: URI },
            position: { line: 1, character: 5 },
          },
        });
        assert(response);
        const items = response.result as CompletionItem[];
        const query = items.find((i) => i.label === "query");
        assert(query, "expected a `query` completion on db.");
        // Translated to the numeric LSP kind, not the service's string kind.
        assertEquals(query.kind, CompletionItemKind.Method);
      },
    );
  },
);

Deno.test(
  "hover returns markdown contents for a global",
  testOpts,
  async () => {
    await withOpenHandler(
      "async function getUsers(c) {\n  db.\n}\n",
      async (server) => {
        // Hover on the `d` of `db` (line 2, char 2).
        const response = await server.dispatch({
          jsonrpc: JSONRPC_VERSION,
          id: 2,
          method: LspMethods.Hover,
          params: {
            textDocument: { uri: URI },
            position: { line: 1, character: 2 },
          },
        });
        assert(response);
        const hover = response.result as Hover | null;
        assert(hover, "expected hover info for db");
        assertEquals(hover.contents.kind, "markdown");
        assert(hover.contents.value.includes("db"));
      },
    );
  },
);

Deno.test(
  "definition resolves to a opentide:// location with 0-based position",
  testOpts,
  async () => {
    // Local `x`: the usage on line 2 resolves to its declaration on line 1, in the
    // same entity file, so the location URI is this document's own opentide:// URI.
    await withOpenHandler("const x = 1\nx\n", async (server) => {
      const response = await server.dispatch({
        jsonrpc: JSONRPC_VERSION,
        id: 2,
        method: LspMethods.Definition,
        params: {
          textDocument: { uri: URI },
          position: { line: 1, character: 0 },
        },
      });
      assert(response);
      const locations = response.result as Location[];
      assert(locations.length >= 1, "expected a definition location");
      assertEquals(locations[0]!.uri, URI);
      // Declaration is on the first line ⇒ 0-based line 0.
      assertEquals(locations[0]!.range.start.line, 0);
    });
  },
);

Deno.test(
  "a feature request before initialize is ServerNotInitialized",
  testOpts,
  async () => {
    await withKernel(async (kernel) => {
      const server = new LspServer({ kernel });
      const response = await server.dispatch({
        jsonrpc: JSONRPC_VERSION,
        id: 3,
        method: LspMethods.Hover,
        params: {
          textDocument: { uri: URI },
          position: { line: 0, character: 0 },
        },
      });
      assert(response?.error);
      assertEquals(response.error.code, ErrorCodes.ServerNotInitialized);
    });
  },
);

Deno.test(
  "a feature request for a malformed URI is InvalidParams",
  testOpts,
  async () => {
    await withKernel(async (kernel) => {
      const server = new LspServer({ kernel });
      await server.dispatch({
        jsonrpc: JSONRPC_VERSION,
        id: 1,
        method: LspMethods.Initialize,
        params: {},
      });
      const response = await server.dispatch({
        jsonrpc: JSONRPC_VERSION,
        id: 2,
        method: LspMethods.Completion,
        params: {
          textDocument: { uri: "file:///nope.ts" },
          position: { line: 0, character: 0 },
        },
      });
      assert(response?.error);
      assertEquals(response.error.code, ErrorCodes.InvalidParams);
    });
  },
);

// --- Stage 1: push diagnostics ---

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Poll a predicate until it holds or the timeout elapses (diagnostics arrive on a
// debounce + async compute, so there is no single point to await).
async function waitFor(
  predicate: () => boolean,
  timeoutMs = 2000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("waitFor timed out");
    await delay(5);
  }
}

Deno.test(
  "diagnostics are pushed on didOpen with source tsc",
  testOpts,
  async () => {
    await withKernel(async (kernel) => {
      const captured: PublishDiagnosticsParams[] = [];
      const send = (n: NotificationMessage) => {
        if (n.method === LspMethods.PublishDiagnostics) {
          captured.push(n.params as PublishDiagnosticsParams);
        }
      };
      const server = new LspServer({ kernel, send, diagnosticsDebounceMs: 1 });
      await server.dispatch({
        jsonrpc: JSONRPC_VERSION,
        id: 1,
        method: LspMethods.Initialize,
        params: {},
      });
      // A type error the compiler must flag (assignment mismatch — errors even with
      // strict off).
      await server.dispatch({
        jsonrpc: JSONRPC_VERSION,
        method: LspMethods.DidOpen,
        params: {
          textDocument: {
            uri: URI,
            languageId: "typescript",
            version: 1,
            text: 'const n: number = "oops"\n',
          },
        },
      });
      await waitFor(() => captured.length > 0);
      const published = captured.at(-1)!;
      assertEquals(published.uri, URI);
      assertEquals(published.version, 1);
      assert(
        published.diagnostics.length >= 1,
        "expected at least one diagnostic",
      );
      const diag = published.diagnostics[0]!;
      assertEquals(diag.source, "tsc");
      assertEquals(diag.severity, DiagnosticSeverity.Error);
    });
  },
);

Deno.test(
  "push diagnostics merge qc alongside tsc, each namespaced",
  testOpts,
  async () => {
    await withKernel(async (kernel) => {
      // The entity must exist for the merge path to lint it; the open buffer (below)
      // is the override QC and the compiler actually run against.
      kernel.handlers.register(
        "getUsers",
        "function getUsers(c) {}",
        () => new Response("[]"),
        undefined,
        "users",
      );
      const captured: PublishDiagnosticsParams[] = [];
      const send = (n: NotificationMessage) => {
        if (n.method === LspMethods.PublishDiagnostics) {
          captured.push(n.params as PublishDiagnosticsParams);
        }
      };
      const server = new LspServer({ kernel, send, diagnosticsDebounceMs: 1 });
      await server.dispatch({
        jsonrpc: JSONRPC_VERSION,
        id: 1,
        method: LspMethods.Initialize,
        params: {},
      });
      // A TS error (number = string) AND a QC violation (console.log → no-console) in
      // the one buffer, so the merged push must carry both a tsc and a qc diagnostic.
      await server.dispatch({
        jsonrpc: JSONRPC_VERSION,
        method: LspMethods.DidOpen,
        params: {
          textDocument: {
            uri: URI,
            languageId: "typescript",
            version: 1,
            text:
              'function getUsers(c) {\n  const n: number = "oops";\n  console.log(n);\n}\n',
          },
        },
      });
      await waitFor(() => captured.length > 0);
      const published = captured.at(-1)!;
      const sources = new Set(published.diagnostics.map((d) => d.source));
      assert(sources.has("tsc"), "expected a tsc diagnostic in the push");
      assert(sources.has("qc"), "expected a qc diagnostic in the push");
      const qc = published.diagnostics.find((d) => d.source === "qc");
      assert(qc, "expected the qc-sourced diagnostic");
      assertEquals(qc.severity, DiagnosticSeverity.Warning);
      assertEquals(qc.code, "no-console");
    });
  },
);

Deno.test(
  "stale diagnostics are dropped: a superseded buffer never publishes",
  testOpts,
  async () => {
    await withKernel(async (kernel) => {
      // Gate the FIRST getDiagnostics call so its compute is in-flight when a newer
      // didChange lands; later calls resolve immediately. This forces the version
      // guard in publishDiagnostics (store version changed under an in-flight compute).
      const base = createTypeScriptRuntimeAdapter();
      let releaseFirst: (v: DiagnosticEntry[]) => void = () => {};
      const firstGate = new Promise<DiagnosticEntry[]>((r) => {
        releaseFirst = r;
      });
      let calls = 0;
      const fakeRuntime: RuntimeAdapter = {
        ...base,
        getDiagnostics: (_et, _en, _kernel, _content) => {
          calls++;
          if (calls === 1) return firstGate;
          return Promise.resolve([
            { line: 1, column: 1, message: "v2 error", severity: "error" },
          ]);
        },
      };
      (kernel as unknown as { runtime: RuntimeAdapter }).runtime = fakeRuntime;

      const captured: PublishDiagnosticsParams[] = [];
      const send = (n: NotificationMessage) => {
        if (n.method === LspMethods.PublishDiagnostics) {
          captured.push(n.params as PublishDiagnosticsParams);
        }
      };
      const server = new LspServer({ kernel, send, diagnosticsDebounceMs: 1 });
      await server.dispatch({
        jsonrpc: JSONRPC_VERSION,
        id: 1,
        method: LspMethods.Initialize,
        params: {},
      });
      // v1 open → debounce fires → compute #1 starts and blocks on firstGate.
      await server.dispatch({
        jsonrpc: JSONRPC_VERSION,
        method: LspMethods.DidOpen,
        params: {
          textDocument: {
            uri: URI,
            languageId: "typescript",
            version: 1,
            text: "const a = 1\n",
          },
        },
      });
      await waitFor(() => calls === 1);
      // v2 change lands while compute #1 is still awaiting → store is now v2.
      await server.dispatch({
        jsonrpc: JSONRPC_VERSION,
        method: LspMethods.DidChange,
        params: {
          textDocument: { uri: URI, version: 2 },
          contentChanges: [{ text: "const a = 2\n" }],
        },
      });
      // Release compute #1: it resolves for v1 but the buffer is now v2 → dropped.
      releaseFirst([{
        line: 1,
        column: 1,
        message: "v1 error",
        severity: "error",
      }]);
      // The v2 debounce fires, compute #2 resolves immediately, v2 publishes.
      await waitFor(() => captured.some((p) => p.version === 2));
      // The stale v1 result was never published.
      assertEquals(captured.filter((p) => p.version === 1).length, 0);
      assertEquals(captured.filter((p) => p.version === 2).length, 1);
    });
  },
);

// --- Stage 3: write path A — edit existing entities (didSave) ---

// A write-path harness: a real compiler + kernel, an initialized server with a
// capture sink for both server→client pushes (showMessage + publishDiagnostics),
// and the write flag as requested. `setup` seeds the registry before the server is
// built. Mirrors dispatch_test's withKernel (compiler init/stop) since didSave runs
// the same define_* compile → QC → changelog path.
interface WriteHarness {
  server: LspServer;
  kernel: Kernel;
  messages: ShowMessageParams[];
  diagnostics: PublishDiagnosticsParams[];
  changesetStatuses: ChangesetStatusParams[];
  documentChanges: DocumentChangedParams[];
}

// Stage 4 injects a fake saveRiskPolicy exactly as Stage 2 injected a fake
// verificationDiagnostics — spread onto testComposition(). Omitted ⇒ the seam is
// null and every save is low-risk (pure Stage 3), so the Stage 3 tests below keep
// exercising the unchanged path.
async function withWriteServer(
  setup: (kernel: Kernel) => void,
  fn: (h: WriteHarness) => Promise<void>,
  writeFeaturesEnabled = true,
  saveRiskPolicy?: SaveRiskPolicy,
): Promise<void> {
  await initCompiler();
  const db = await Database.create({ driver: "pglite" });
  const composition: CompositionContext = saveRiskPolicy
    ? { ...testComposition(), saveRiskPolicy }
    : testComposition();
  const kernel = new Kernel(db, { composition });
  try {
    setup(kernel);
    const messages: ShowMessageParams[] = [];
    const diagnostics: PublishDiagnosticsParams[] = [];
    const changesetStatuses: ChangesetStatusParams[] = [];
    const documentChanges: DocumentChangedParams[] = [];
    const send = (n: NotificationMessage) => {
      if (n.method === LspMethods.ShowMessage) {
        messages.push(n.params as ShowMessageParams);
      }
      if (n.method === LspMethods.PublishDiagnostics) {
        diagnostics.push(n.params as PublishDiagnosticsParams);
      }
      if (n.method === LspMethods.ChangesetStatus) {
        changesetStatuses.push(n.params as ChangesetStatusParams);
      }
      if (n.method === LspMethods.DocumentChanged) {
        documentChanges.push(n.params as DocumentChangedParams);
      }
    };
    const server = new LspServer({
      kernel,
      send,
      writeFeaturesEnabled,
      diagnosticsDebounceMs: 1,
    });
    await server.dispatch({
      jsonrpc: JSONRPC_VERSION,
      id: 1,
      method: LspMethods.Initialize,
      params: {},
    });
    await fn({
      server,
      kernel,
      messages,
      diagnostics,
      changesetStatuses,
      documentChanges,
    });
  } finally {
    await db.close();
    stopCompiler();
  }
}

// A minimal VALID changeset plan (validateChangesetPlan requires ≥1 acceptance
// criterion and ≥1 planned check) for a fake gate verdict's changeset spec.
function gatePlan(): ChangesetPlan {
  return {
    summary: "held edit under review",
    steps: [{
      id: "s1",
      description: "apply reviewed edit",
      status: "pending",
    }],
    acceptanceCriteria: [
      {
        id: "c1",
        text: "invariant preserved",
        source: "inferred",
        priority: "must",
      },
    ],
    verificationPlan: [
      {
        id: "v1",
        claimIds: ["c1"],
        kind: "invariant",
        description: "re-check invariant",
      },
    ],
  };
}

// A fake policy that gates every save (high risk, strict-style): the LSP branch,
// not the verification risk logic, is what these tests exercise.
const GATE_EVERY_SAVE: SaveRiskPolicy = () => ({
  decision: "gate",
  reason: "entity is under a hard-enforced formal spec",
  changeset: { title: "Gated edit: getUsers", plan: gatePlan() },
});

// A fake policy that allows but warns (risky entity under an advisory policy).
const ADVISORY_WARN: SaveRiskPolicy = () => ({
  decision: "allow",
  reason: "advisory: entity is under a hard-enforced formal spec",
});

// A fake policy that explicitly allows with no reason (low risk).
const ALLOW_LOW_RISK: SaveRiskPolicy = () => ({ decision: "allow" });

function registerHandler(kernel: Kernel, source: string): void {
  kernel.handlers.register(
    "getUsers",
    source,
    () => new Response("[]"),
    undefined,
    "users",
  );
}

function didSave(server: LspServer, text?: string): Promise<unknown> {
  return server.dispatch({
    jsonrpc: JSONRPC_VERSION,
    method: LspMethods.DidSave,
    params: {
      textDocument: { uri: URI },
      ...(text !== undefined ? { text } : {}),
    },
  });
}

Deno.test(
  "write-enabled server advertises save with includeText",
  testOpts,
  async () => {
    await withKernel(async (kernel) => {
      const server = new LspServer({ kernel, writeFeaturesEnabled: true });
      const response = await server.dispatch({
        jsonrpc: JSONRPC_VERSION,
        id: 1,
        method: LspMethods.Initialize,
        params: {},
      });
      const result = response!.result as InitializeResult;
      // Object form (not the bare number) so `save` can be advertised.
      const sync = result.capabilities
        .textDocumentSync as TextDocumentSyncOptions;
      assertEquals(sync.openClose, true);
      assertEquals(sync.change, TextDocumentSyncKind.Full);
      assertEquals(sync.save, { includeText: true });
    });
  },
);

Deno.test(
  "didSave persists an edit via manualEdit + records a changelog entry, no changeset",
  testOpts,
  async () => {
    await withWriteServer(
      (kernel) =>
        registerHandler(
          kernel,
          "function getUsers(c) {\n  return c.json([]);\n}\n",
        ),
      async ({ server, kernel, messages }) => {
        const edited =
          "function getUsers(c) {\n  return c.json([1, 2, 3]);\n}\n";
        await didSave(server, edited);

        // Persisted: the registry now holds the edited source.
        assertEquals(kernel.handlers.get("getUsers")?.source, edited);
        // Confirmed to the editor.
        const saved = messages.at(-1)!;
        assertEquals(saved.type, MessageType.Info);
        assert(saved.message.includes("Saved"), "expected a 'Saved' toast");

        // Changelog records the edit as an update, attributed to the manual LSP edit.
        const records = await kernel.changelog.list();
        const update = records.find(
          (r) =>
            r.category === "handler" && r.key === "getUsers" &&
            r.action === "update",
        );
        assert(update, "expected an update changelog record for getUsers");
        assertEquals(update.context?.manualEdit, true);

        // Stage 3 governance: DIRECT tool-level write — no session changeset created.
        assertEquals((await kernel.changesets.list()).length, 0);
      },
    );
  },
);

Deno.test(
  "didSave without text uses the open buffer as the source",
  testOpts,
  async () => {
    await withWriteServer(
      (kernel) =>
        registerHandler(
          kernel,
          "function getUsers(c) {\n  return c.json([]);\n}\n",
        ),
      async ({ server, kernel, messages }) => {
        const edited = "function getUsers(c) {\n  return c.text('ok');\n}\n";
        // Open with the edited buffer, then save WITHOUT includeText: the server must
        // fall back to its own open buffer.
        await server.dispatch({
          jsonrpc: JSONRPC_VERSION,
          method: LspMethods.DidOpen,
          params: {
            textDocument: {
              uri: URI,
              languageId: "typescript",
              version: 1,
              text: edited,
            },
          },
        });
        await didSave(server);
        assertEquals(kernel.handlers.get("getUsers")?.source, edited);
        assert(
          messages.some((m) =>
            m.type === MessageType.Info && m.message.includes("Saved")
          ),
        );
      },
    );
  },
);

Deno.test(
  "didSave with a QC violation is rejected and republishes qc squiggles",
  testOpts,
  async () => {
    const clean = "function getUsers(c) {\n  return c.json([]);\n}\n";
    await withWriteServer(
      (kernel) => registerHandler(kernel, clean),
      async ({ server, kernel, messages, diagnostics }) => {
        // eval() compiles but trips the no-eval QC rule (error level ⇒ QC_FAILED).
        const bad =
          "function getUsers(c) {\n  eval('1 + 1');\n  return c.json([]);\n}\n";
        await didSave(server, bad);

        // Not persisted: the registry still holds the clean source.
        assertEquals(kernel.handlers.get("getUsers")?.source, clean);
        // No changelog record was written (define_* returned before registering).
        assertEquals((await kernel.changelog.list()).length, 0);

        // The QC gate became the linter: a qc-sourced diagnostic was republished on the
        // saved buffer, and the editor was told the save was rejected.
        const published = diagnostics.at(-1)!;
        const qc = published.diagnostics.find((d) => d.source === "qc");
        assert(qc, "expected a qc-sourced diagnostic on the rejected save");
        assertEquals(qc.code, "no-eval");
        assert(
          messages.some((m) => m.type === MessageType.Warning),
          "expected a rejection toast",
        );
      },
    );
  },
);

Deno.test(
  "didSave on an unregistered URI persists nothing and points to the create flow",
  testOpts,
  async () => {
    await withWriteServer(
      () => {}, // nothing registered
      async ({ server, kernel, messages }) => {
        await didSave(
          server,
          "function getUsers(c) {\n  return c.json([]);\n}\n",
        );
        // Nothing created — edit-only scope (creation is Stage 6).
        assertEquals(kernel.handlers.get("getUsers"), undefined);
        assertEquals((await kernel.changelog.list()).length, 0);
        assertEquals((await kernel.changesets.list()).length, 0);
        const msg = messages.at(-1)!;
        assertEquals(msg.type, MessageType.Info);
        assert(
          msg.message.includes("create flow"),
          "expected a create-flow hint",
        );
      },
    );
  },
);

Deno.test(
  "didSave with the write flag off is rejected and advertises no save",
  testOpts,
  async () => {
    await withWriteServer(
      (kernel) =>
        registerHandler(
          kernel,
          "function getUsers(c) {\n  return c.json([]);\n}\n",
        ),
      async ({ server, kernel, messages, diagnostics }) => {
        // The read-only server advertised no save capability (asserted in the read-only
        // initialize test); a didSave here must persist nothing and warn.
        await didSave(
          server,
          "function getUsers(c) {\n  return c.json([9]);\n}\n",
        );
        assertEquals(
          kernel.handlers.get("getUsers")?.source,
          "function getUsers(c) {\n  return c.json([]);\n}\n",
        );
        assertEquals((await kernel.changelog.list()).length, 0);
        assertEquals(
          diagnostics.length,
          0,
          "no diagnostics on a read-only rejection",
        );
        const msg = messages.at(-1)!;
        assertEquals(msg.type, MessageType.Warning);
      },
      false, // writeFeaturesEnabled off
    );
  },
);

// --- Stage 4: write path B — risk-adaptive save ---

const HANDLER = "function getUsers(c) {\n  return c.json([]);\n}\n";
const EDIT = "function getUsers(c) {\n  return c.json([1, 2, 3]);\n}\n";

Deno.test(
  "initialize surfaces the active readinessEnforcement policy",
  testOpts,
  async () => {
    await withKernel(async (kernel) => {
      const server = new LspServer({ kernel, writeFeaturesEnabled: true });
      const response = await server.dispatch({
        jsonrpc: JSONRPC_VERSION,
        id: 1,
        method: LspMethods.Initialize,
        params: {},
      });
      const result = response!.result as InitializeResult;
      // The server advertises the same policy getKernelSettings resolves, so a client
      // can explain the risk-adaptive save behavior.
      assertEquals(
        result.capabilities.opentideReadinessEnforcement,
        getKernelSettings().readinessEnforcement,
      );
    });
  },
);

Deno.test(
  "low-risk save (allow verdict) persists transparently, no changeset",
  testOpts,
  async () => {
    await withWriteServer(
      (kernel) => registerHandler(kernel, HANDLER),
      async ({ server, kernel, messages, changesetStatuses }) => {
        await didSave(server, EDIT);
        // Indistinguishable from Stage 3: registry mutated, "Saved" toast, no changeset,
        // no changeset-status push.
        assertEquals(kernel.handlers.get("getUsers")?.source, EDIT);
        assertEquals((await kernel.changesets.list()).length, 0);
        assertEquals(changesetStatuses.length, 0);
        assert(
          messages.some((m) =>
            m.type === MessageType.Info && m.message.includes("Saved")
          ),
        );
      },
      true,
      ALLOW_LOW_RISK,
    );
  },
);

Deno.test(
  "high-risk save is held as a gated changeset, registry unchanged, status pushed",
  testOpts,
  async () => {
    await withWriteServer(
      (kernel) => registerHandler(kernel, HANDLER),
      async ({ server, kernel, messages, changesetStatuses }) => {
        await didSave(server, EDIT);

        // NOT applied: the registry still holds the pre-edit source.
        assertEquals(kernel.handlers.get("getUsers")?.source, HANDLER);
        // No tool-level write happened, so no changelog record.
        assertEquals((await kernel.changelog.list()).length, 0);

        // A gated changeset now carries the proposed edit, in its planning status.
        const changesets = await kernel.changesets.list();
        assertEquals(changesets.length, 1);
        const cs = changesets[0]!;
        assertEquals(cs.status, "planning");

        // The editor was told, both vanilla (a warning toast) and structured
        // (opentide/changesetStatus naming the changeset + how to approve).
        assert(
          messages.some((m) =>
            m.type === MessageType.Warning && m.message.includes(cs.id)
          ),
          "expected a 'held for approval' warning naming the changeset",
        );
        assertEquals(changesetStatuses.length, 1);
        const status = changesetStatuses[0]!;
        assertEquals(status.changesetId, cs.id);
        assertEquals(status.status, "planning");
        assert(status.reason.length > 0, "expected a gating reason");
        assert(status.approvalHint.length > 0, "expected an approval hint");

        // Resolution runs through the existing approve(id) flow.
        const approved = await kernel.changesets.approve(cs.id);
        assertEquals(approved.status, "approved");
      },
      true,
      GATE_EVERY_SAVE,
    );
  },
);

Deno.test(
  "advisory-risky save still applies, with only a warning",
  testOpts,
  async () => {
    await withWriteServer(
      (kernel) => registerHandler(kernel, HANDLER),
      async ({ server, kernel, messages, changesetStatuses }) => {
        await didSave(server, EDIT);
        // Applied despite the risk (advisory never blocks).
        assertEquals(kernel.handlers.get("getUsers")?.source, EDIT);
        // No changeset, no status push — it was a real save.
        assertEquals((await kernel.changesets.list()).length, 0);
        assertEquals(changesetStatuses.length, 0);
        // Both the "Saved" confirmation and the advisory warning reach the editor.
        assert(
          messages.some((m) =>
            m.type === MessageType.Info && m.message.includes("Saved")
          ),
        );
        assert(
          messages.some((m) =>
            m.type === MessageType.Warning && m.message.includes("advisory")
          ),
          "expected an advisory warning alongside the save",
        );
      },
      true,
      ADVISORY_WARN,
    );
  },
);

Deno.test(
  "a null risk seam is pure Stage 3 (persist, no changeset)",
  testOpts,
  async () => {
    await withWriteServer(
      (kernel) => registerHandler(kernel, HANDLER),
      async ({ server, kernel, changesetStatuses }) => {
        // No saveRiskPolicy passed ⇒ the seam is null ⇒ every save is low-risk.
        await didSave(server, EDIT);
        assertEquals(kernel.handlers.get("getUsers")?.source, EDIT);
        assertEquals((await kernel.changesets.list()).length, 0);
        assertEquals(changesetStatuses.length, 0);
      },
    );
  },
);

// --- Stage 5: concurrency & multi-writer ---

// Simulate an agent (MCP/chat) writing the same entity out-of-band: a DIRECT
// define_handler dispatch, manualEdit so it needs no session changeset. It bumps the
// entity revision and fires the kernel entity-change event the server subscribes to.
async function agentWrite(kernel: Kernel, source: string): Promise<void> {
  const result = await dispatchTool(
    "define_handler",
    { name: "getUsers", source },
    kernel,
    () => {},
    { manualEdit: true },
  );
  assert(result.ok, `agent write should succeed: ${result.error?.message}`);
}

function didOpen(
  server: LspServer,
  text: string,
  version = 1,
): Promise<unknown> {
  return server.dispatch({
    jsonrpc: JSONRPC_VERSION,
    method: LspMethods.DidOpen,
    params: {
      textDocument: { uri: URI, languageId: "typescript", version, text },
    },
  });
}

function didChange(
  server: LspServer,
  text: string,
  version: number,
): Promise<unknown> {
  return server.dispatch({
    jsonrpc: JSONRPC_VERSION,
    method: LspMethods.DidChange,
    params: { textDocument: { uri: URI, version }, contentChanges: [{ text }] },
  });
}

const AGENT_EDIT = "function getUsers(c) {\n  return c.json([1]);\n}\n";

Deno.test(
  "a concurrent agent write makes the later human save STALE_WRITE, not a clobber",
  testOpts,
  async () => {
    await withWriteServer(
      (kernel) => registerHandler(kernel, HANDLER),
      async ({ server, kernel, messages, documentChanges }) => {
        await didOpen(server, HANDLER); // buffer synced to revision 1
        await agentWrite(kernel, AGENT_EDIT); // registry advances to revision 2

        // The human's buffer is still based on revision 1 → the save is refused.
        await didSave(server, EDIT);

        // No silent data loss: the registry still holds the agent's edit at revision 2.
        assertEquals(kernel.handlers.get("getUsers")?.source, AGENT_EDIT);
        assertEquals(kernel.handlers.get("getUsers")?.revision, 2);
        // No changelog update from the rejected human save (only the agent's write).
        const updates = (await kernel.changelog.list()).filter(
          (r) => r.category === "handler" && r.action === "update",
        );
        assertEquals(updates.length, 1);

        // The human is warned and handed the authoritative content to reload.
        assert(
          messages.some((m) =>
            m.type === MessageType.Warning && /revision/i.test(m.message)
          ),
          "expected a stale-write warning naming the revision",
        );
        const refresh = documentChanges.at(-1)!;
        assertEquals(refresh.uri, URI);
        assertEquals(refresh.revision, 2);
        assertEquals(refresh.content, AGENT_EDIT);
      },
    );
  },
);

Deno.test(
  "a save with the matching revision is accepted and bumps the revision",
  testOpts,
  async () => {
    await withWriteServer(
      (kernel) => registerHandler(kernel, HANDLER),
      async ({ server, kernel }) => {
        await didOpen(server, HANDLER); // synced to revision 1
        await didChange(server, EDIT, 2);
        await didSave(server, EDIT); // expectedRevision 1 == current 1 → accepted

        assertEquals(kernel.handlers.get("getUsers")?.source, EDIT);
        assertEquals(kernel.handlers.get("getUsers")?.revision, 2);

        // The synced base advanced with the write, so a second save is accepted too —
        // proof the buffer tracks its revision across saves (no spurious STALE_WRITE).
        const second = "function getUsers(c) {\n  return c.json([9]);\n}\n";
        await didChange(server, second, 3);
        await didSave(server, second);
        assertEquals(kernel.handlers.get("getUsers")?.source, second);
        assertEquals(kernel.handlers.get("getUsers")?.revision, 3);
      },
    );
  },
);

Deno.test(
  "a save with no open buffer omits expectedRevision (last-writer-wins)",
  testOpts,
  async () => {
    await withWriteServer(
      (kernel) => registerHandler(kernel, HANDLER),
      async ({ server, kernel }) => {
        await agentWrite(kernel, AGENT_EDIT); // registry advances to revision 2
        // No didOpen ⇒ no synced base ⇒ no expectedRevision ⇒ the write clobbers.
        await didSave(server, EDIT);
        assertEquals(kernel.handlers.get("getUsers")?.source, EDIT);
        assertEquals(kernel.handlers.get("getUsers")?.revision, 3);
      },
    );
  },
);

Deno.test(
  "an out-of-band write to an open doc pushes a documentChanged refresh",
  testOpts,
  async () => {
    await withWriteServer(
      (kernel) => registerHandler(kernel, HANDLER),
      async ({ server, kernel, documentChanges }) => {
        await didOpen(server, HANDLER);
        await agentWrite(kernel, AGENT_EDIT);

        // The server learned of the out-of-band write and pushed the new content +
        // revision so a rich client can replace its (un-editable-by-the-server) buffer.
        const refresh = documentChanges.at(-1)!;
        assertEquals(refresh.uri, URI);
        assertEquals(refresh.revision, 2);
        assertEquals(refresh.content, AGENT_EDIT);

        // The buffer's synced base stays stale until the client re-syncs, so a save from
        // the un-reloaded buffer is still guarded (STALE_WRITE, agent edit preserved).
        await didSave(server, EDIT);
        assertEquals(kernel.handlers.get("getUsers")?.source, AGENT_EDIT);
      },
    );
  },
);

// --- Stage 6: creation & the metadata gap ---

// Invoke the opentide.createEntity command (a request → a CreateEntityResult). `args` is
// the structured metadata form passed at arguments[0], exactly as a client sends it.
function createEntity(
  server: LspServer,
  args: Record<string, unknown>,
  id = 50,
): Promise<ResponseMessage | null> {
  return server.dispatch({
    jsonrpc: JSONRPC_VERSION,
    id,
    method: LspMethods.ExecuteCommand,
    params: { command: LSP_CREATE_ENTITY_COMMAND, arguments: [args] },
  });
}

const NEW_HANDLER = "function listPosts(c) {\n  return c.json([]);\n}\n";

Deno.test(
  "create command defines a new handler: registered + changelog create + toast",
  testOpts,
  async () => {
    await withWriteServer(
      () => {}, // nothing registered — this is a create
      async ({ server, kernel, messages }) => {
        const response = await createEntity(server, {
          type: "handler",
          name: "listPosts",
          source: NEW_HANDLER,
        });
        const result = response!.result as CreateEntityResult;
        assertEquals(result.created, true);
        assertEquals(result.entityType, "handler");
        assertEquals(result.entityName, "listPosts");
        assertEquals(result.uri, "opentide://typescript/handlers/listPosts.ts");

        // Registered in the kernel with the created source.
        assertEquals(kernel.handlers.get("listPosts")?.source, NEW_HANDLER);

        // Changelog records it as a CREATE (before snapshot null), attributed to the
        // manual create command.
        const records = await kernel.changelog.list();
        const create = records.find(
          (r) =>
            r.category === "handler" && r.key === "listPosts" &&
            r.action === "create",
        );
        assert(create, "expected a create changelog record for listPosts");
        assertEquals(create.context?.manualEdit, true);

        // Success toast reached the editor.
        assert(
          messages.some((m) =>
            m.type === MessageType.Info && m.message.includes("listPosts")
          ),
          "expected a success toast naming the created entity",
        );

        // Direct tool-level create — no session changeset.
        assertEquals((await kernel.changesets.list()).length, 0);
      },
    );
  },
);

Deno.test(
  "create command preserves handler metadata (schema, module, purpose)",
  testOpts,
  async () => {
    const schema = {
      summary: "List posts",
      tags: ["posts"],
      responses: { "200": { description: "ok" } },
    };
    await withWriteServer(
      () => {},
      async ({ server, kernel }) => {
        const response = await createEntity(server, {
          type: "handler",
          name: "listPosts",
          source: NEW_HANDLER,
          module: "posts",
          purpose: "Return every post",
          schema,
        });
        assertEquals((response!.result as CreateEntityResult).created, true);
        const entry = kernel.handlers.get("listPosts");
        assert(entry, "expected the handler to be registered");
        assertEquals(entry.module, "posts");
        assertEquals(entry.purpose, "Return every post");
        assertEquals(entry.schema?.summary, "List posts");
      },
    );
  },
);

Deno.test(
  "create command binds a route atomically (handler + route in one call)",
  testOpts,
  async () => {
    await withWriteServer(
      () => {},
      async ({ server, kernel, messages }) => {
        const response = await createEntity(server, {
          type: "handler",
          name: "listPosts",
          source: NEW_HANDLER,
          route: { method: "GET", path: "/api/posts" },
        });
        const result = response!.result as CreateEntityResult;
        assertEquals(result.created, true);
        assertEquals(result.route, {
          method: "GET",
          path: "/api/posts",
          bound: true,
        });

        // Both the handler and its route are registered.
        assertEquals(kernel.handlers.get("listPosts")?.source, NEW_HANDLER);
        assertEquals(
          kernel.routes.get("GET", "/api/posts")?.handlerName,
          "listPosts",
        );

        // Changelog carries both the handler create and the route create.
        const records = await kernel.changelog.list();
        assert(
          records.some((r) =>
            r.category === "handler" && r.action === "create"
          ),
        );
        assert(
          records.some((r) => r.category === "route" && r.action === "create"),
        );
        // The route bind was confirmed to the editor.
        assert(messages.some((m) => m.message.includes("/api/posts")));
      },
    );
  },
);

Deno.test(
  "create command with a QC violation registers nothing and republishes squiggles",
  testOpts,
  async () => {
    await withWriteServer(
      () => {},
      async ({ server, kernel, messages, diagnostics }) => {
        // eval() compiles but trips the error-level no-eval QC rule ⇒ QC_FAILED.
        const bad =
          "function listPosts(c) {\n  eval('1 + 1');\n  return c.json([]);\n}\n";
        const response = await createEntity(server, {
          type: "handler",
          name: "listPosts",
          source: bad,
        });
        const result = response!.result as CreateEntityResult;
        assertEquals(result.created, false);
        assertEquals(result.code, "QC_FAILED");

        // Nothing registered, nothing recorded.
        assertEquals(kernel.handlers.get("listPosts"), undefined);
        assertEquals((await kernel.changelog.list()).length, 0);

        // The QC gate became the linter for a create too: a qc squiggle was republished.
        const published = diagnostics.at(-1)!;
        const qc = published.diagnostics.find((d) => d.source === "qc");
        assert(qc, "expected a qc-sourced diagnostic on the rejected create");
        assertEquals(qc.code, "no-eval");
        assert(
          messages.some((m) => m.type === MessageType.Warning),
          "expected a rejection toast",
        );
      },
    );
  },
);

// Two functions with the SAME implementation but names matching their entity — an
// "exact implementation match" the semantic-duplicate check blocks.
const trimmerSource = (name: string) =>
  `function ${name}(value: string): string { return value.trim(); }`;

Deno.test(
  "create command surfaces a duplicate rejection, and a justification overrides it",
  testOpts,
  async () => {
    await withWriteServer(
      () => {},
      async ({ server, kernel, diagnostics }) => {
        // First function created cleanly.
        const first = await createEntity(server, {
          type: "function",
          name: "trimmer",
          source: trimmerSource("trimmer"),
        }, 51);
        assertEquals((first!.result as CreateEntityResult).created, true);

        // A second function with the SAME implementation is a semantic duplicate.
        const dup = await createEntity(server, {
          type: "function",
          name: "trimmerTwo",
          source: trimmerSource("trimmerTwo"),
        }, 52);
        const dupResult = dup!.result as CreateEntityResult;
        assertEquals(dupResult.created, false);
        assertEquals(dupResult.code, "POSSIBLE_DUPLICATE_ENTITY");
        assertEquals(kernel.functions.getEntry("trimmerTwo"), undefined);
        // The duplicate surfaced as a gutter diagnostic (whole-entity, no line anchor).
        const published = diagnostics.at(-1)!;
        assert(
          published.diagnostics.some((d) => d.source === "qc"),
          "expected the duplicate rejection as a gutter diagnostic",
        );

        // Re-invoking with a justification overrides the block and creates the entity.
        const override = await createEntity(server, {
          type: "function",
          name: "trimmerTwo",
          source: trimmerSource("trimmerTwo"),
          duplicateJustification:
            "Distinct call-site semantics; kept separate deliberately.",
        }, 53);
        assertEquals((override!.result as CreateEntityResult).created, true);
        assertEquals(
          kernel.functions.getEntry("trimmerTwo")?.source,
          trimmerSource("trimmerTwo"),
        );
      },
    );
  },
);

Deno.test(
  "create command with malformed args is InvalidParams",
  testOpts,
  async () => {
    await withWriteServer(
      () => {},
      async ({ server }) => {
        // Missing `source`.
        const response = await createEntity(server, {
          type: "handler",
          name: "listPosts",
        });
        assert(response?.error, "expected an error response");
        assertEquals(response.error.code, ErrorCodes.InvalidParams);
      },
    );
  },
);

Deno.test(
  "executeCommandProvider is advertised only when write features are on",
  testOpts,
  async () => {
    await withKernel(async (kernel) => {
      const writeServer = new LspServer({ kernel, writeFeaturesEnabled: true });
      const on = await writeServer.dispatch({
        jsonrpc: JSONRPC_VERSION,
        id: 1,
        method: LspMethods.Initialize,
        params: {},
      });
      const onCaps = (on!.result as InitializeResult).capabilities;
      assertEquals(onCaps.executeCommandProvider, {
        commands: [LSP_CREATE_ENTITY_COMMAND],
      });
      assert(
        onCaps.workspace?.fileOperations?.didCreate,
        "expected a didCreate registration",
      );

      const readServer = new LspServer({ kernel, writeFeaturesEnabled: false });
      const off = await readServer.dispatch({
        jsonrpc: JSONRPC_VERSION,
        id: 2,
        method: LspMethods.Initialize,
        params: {},
      });
      const offCaps = (off!.result as InitializeResult).capabilities;
      assertEquals(offCaps.executeCommandProvider, undefined);
      assertEquals(offCaps.workspace, undefined);
    });
  },
);

Deno.test(
  "create command on a read-only server is refused and creates nothing",
  testOpts,
  async () => {
    await withWriteServer(
      () => {},
      async ({ server, kernel, messages }) => {
        const response = await createEntity(server, {
          type: "handler",
          name: "listPosts",
          source: NEW_HANDLER,
        });
        assert(
          response?.error,
          "expected an error response on a read-only server",
        );
        assertEquals(kernel.handlers.get("listPosts"), undefined);
        assert(
          messages.some((m) => m.type === MessageType.Warning),
          "expected a read-only warning",
        );
      },
      false, // writeFeaturesEnabled off
    );
  },
);

Deno.test(
  "didCreateFiles points at the create command and creates nothing",
  testOpts,
  async () => {
    await withWriteServer(
      () => {},
      async ({ server, kernel, messages }) => {
        await server.dispatch({
          jsonrpc: JSONRPC_VERSION,
          method: LspMethods.DidCreateFiles,
          params: {
            files: [{ uri: "opentide://typescript/handlers/listPosts.ts" }],
          },
        });
        // Nothing was defined — a bare file has no metadata to create an entity from.
        assertEquals(kernel.handlers.get("listPosts"), undefined);
        assertEquals((await kernel.changelog.list()).length, 0);
        // The user was pointed at the command.
        const msg = messages.at(-1)!;
        assertEquals(msg.type, MessageType.Info);
        assert(
          msg.message.includes(LSP_CREATE_ENTITY_COMMAND),
          "expected the didCreateFiles hint to name the create command",
        );
      },
    );
  },
);

// --- Stage 7: rename & atomic WorkspaceEdit ---

// Seed a compilable entity through the real tool path (so getRenameLocations has a valid
// source to analyze and apply_rename can recompile it). manualEdit skips the changeset gate.
async function define(
  kernel: Kernel,
  tool: "define_handler" | "define_function",
  name: string,
  source: string,
): Promise<void> {
  const r = await dispatchTool(tool, { name, source }, kernel, () => {}, {
    manualEdit: true,
  });
  assert(r.ok, `seed ${name}: ${r.error?.message}`);
}

function rename(
  server: LspServer,
  uri: string,
  position: { line: number; character: number },
  newName: string,
  id = 70,
): Promise<ResponseMessage | null> {
  return server.dispatch({
    jsonrpc: JSONRPC_VERSION,
    id,
    method: LspMethods.Rename,
    params: { textDocument: { uri }, position, newName },
  });
}

const CALC_TAX = "function calcTax(x) {\n  return x * 1.1;\n}\n";
const USERS_CALLS_CALC =
  "function getUsers(c) {\n  return c.json(calcTax(100));\n}\n";
const REPORT_CALLS_CALC =
  "function getReport(c) {\n  const total = calcTax(50);\n  return c.text('total=' + total);\n}\n";
const CALC_FN_URI = "opentide://typescript/functions/calcTax.ts";
const USERS_URI = "opentide://typescript/handlers/getUsers.ts";
const REPORT_URI = "opentide://typescript/handlers/getReport.ts";

Deno.test(
  "write-enabled server advertises renameProvider; read-only does not",
  testOpts,
  async () => {
    await withKernel(async (kernel) => {
      const writeServer = new LspServer({ kernel, writeFeaturesEnabled: true });
      const writeCaps = (await writeServer.dispatch({
        jsonrpc: JSONRPC_VERSION,
        id: 1,
        method: LspMethods.Initialize,
        params: {},
      }))!.result as InitializeResult;
      assertEquals(writeCaps.capabilities.renameProvider, true);

      const readServer = new LspServer({ kernel, writeFeaturesEnabled: false });
      const readCaps = (await readServer.dispatch({
        jsonrpc: JSONRPC_VERSION,
        id: 1,
        method: LspMethods.Initialize,
        params: {},
      }))!.result as InitializeResult;
      assertEquals(readCaps.capabilities.renameProvider, undefined);
    });
  },
);

Deno.test(
  "rename on a read-only server is refused and persists nothing",
  testOpts,
  async () => {
    await withWriteServer(
      () => {},
      async ({ server, kernel, messages }) => {
        await define(kernel, "define_function", "calcTax", CALC_TAX);
        const response = await rename(server, CALC_FN_URI, {
          line: 0,
          character: 9,
        }, "computeTax");
        assert(response?.error);
        assertEquals(response.error.code, ErrorCodes.RequestFailed);
        // Untouched: the read-only server never reached the tool layer.
        assert(kernel.functions.getEntry("calcTax"));
        assertEquals(kernel.functions.getEntry("computeTax"), undefined);
        assert(messages.some((m) => m.type === MessageType.Warning));
      },
      false, // writeFeaturesEnabled = false
    );
  },
);

// The headline exit criterion: a function used by multiple handlers, renamed, updates
// every call-site AND the definition atomically, reversible via one changelog turn.
Deno.test(
  "rename: a function used by two handlers updates all call-sites + definition atomically",
  testOpts,
  async () => {
    await withWriteServer(
      () => {},
      async ({ server, kernel, messages }) => {
        await define(kernel, "define_function", "calcTax", CALC_TAX);
        await define(kernel, "define_handler", "getUsers", USERS_CALLS_CALC);
        await define(kernel, "define_handler", "getReport", REPORT_CALLS_CALC);

        // Cursor on the calcTax definition (function calcTax → char 9 is 'c').
        const response = await rename(server, CALC_FN_URI, {
          line: 0,
          character: 9,
        }, "computeTax");
        const edit = response!.result as WorkspaceEdit;

        // The WorkspaceEdit spans every affected opentide:// doc, with 0-based ranges.
        assertEquals(
          Object.keys(edit.changes).sort(),
          [CALC_FN_URI, REPORT_URI, USERS_URI].sort(),
        );
        const defEdit = edit.changes[CALC_FN_URI]![0]!;
        assertEquals(defEdit.newText, "computeTax");
        assertEquals(defEdit.range.start, { line: 0, character: 9 }); // 0-based

        // Applied atomically through the tool layer: new key made, old retired, refs rewritten.
        assert(kernel.functions.getEntry("computeTax"));
        assertEquals(kernel.functions.getEntry("calcTax"), undefined);
        assertStringIncludes(
          kernel.handlers.get("getUsers")!.source,
          "computeTax(100)",
        );
        assertStringIncludes(
          kernel.handlers.get("getReport")!.source,
          "computeTax(50)",
        );

        // A3: ONE reversible turn — the single rename op + both handler updates
        // share a turnId. The rename is NOT a create(new)+delete(old) pair: it is
        // one action:"rename" record keyed by the new name, carrying renamedFrom.
        const all = await kernel.changelog.list();
        const renamed = all.find((r) =>
          r.category === "function" && r.key === "computeTax" &&
          r.action === "rename"
        );
        assert(renamed?.turnId, "the rename record should carry a turnId");
        assertEquals(renamed.context?.renamedFrom, "calcTax");
        const turn = all.filter((r) => r.turnId === renamed.turnId);
        assertEquals(turn.length, 3);
        assert(!turn.some((r) => r.action === "delete"));
        assert(!turn.some((r) => r.key === "computeTax" && r.action === "create"));

        // A success toast was pushed.
        assert(
          messages.some((m) =>
            m.type === MessageType.Info && /rename/i.test(m.message)
          ),
        );

        // undo_turn round-trips the whole rename.
        const undo = await dispatchTool("undo_turn", {}, kernel, () => {});
        assert(undo.ok);
        assert(kernel.functions.getEntry("calcTax"));
        assertEquals(kernel.functions.getEntry("computeTax"), undefined);
        assertStringIncludes(
          kernel.handlers.get("getUsers")!.source,
          "calcTax(100)",
        );
      },
    );
  },
);

// The pure symbol-rename path (a): a local, single-entity, no registry-key change.
Deno.test(
  "rename: a local symbol edits one entity in place, key unchanged",
  testOpts,
  async () => {
    await withWriteServer(
      () => {},
      async ({ server, kernel }) => {
        const src =
          "function getUsers(c) {\n  const rows = [1, 2];\n  return c.json(rows);\n}\n";
        await define(kernel, "define_handler", "getUsers", src);

        // Cursor on the local `rows` (line 1, char 8).
        const response = await rename(server, USERS_URI, {
          line: 1,
          character: 8,
        }, "items");
        const edit = response!.result as WorkspaceEdit;

        // Only the one document is touched (a local doesn't cross entities).
        assertEquals(Object.keys(edit.changes), [USERS_URI]);
        assertEquals(edit.changes[USERS_URI]!.length, 2); // declaration + use

        // Same registry key, rewritten source; getUsers still exists (no retire).
        const entry = kernel.handlers.get("getUsers");
        assert(entry);
        assertStringIncludes(entry.source, "const items = [1, 2]");
        assertStringIncludes(entry.source, "c.json(items)");
      },
    );
  },
);

Deno.test(
  "rename with no renameable symbol returns null, changes nothing",
  testOpts,
  async () => {
    await withWriteServer(
      () => {},
      async ({ server, kernel }) => {
        await define(kernel, "define_function", "calcTax", CALC_TAX);
        // Position on whitespace / a non-identifier — no rename locations.
        const response = await rename(server, CALC_FN_URI, {
          line: 1,
          character: 0,
        }, "computeTax");
        assertEquals(response!.result, null);
        assert(kernel.functions.getEntry("calcTax"));
        assertEquals(kernel.functions.getEntry("computeTax"), undefined);
      },
    );
  },
);

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.byteLength;
  }
  return out;
}

function decodeAll(bytes: Uint8Array): ResponseMessage[] {
  const buffer = new MessageBuffer();
  buffer.append(bytes);
  const messages: ResponseMessage[] = [];
  for (
    let message = buffer.tryReadMessage();
    message !== null;
    message = buffer.tryReadMessage()
  ) {
    messages.push(message as unknown as ResponseMessage);
  }
  return messages;
}
