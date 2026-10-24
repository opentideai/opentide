import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { Kernel } from "./registries.ts";
import { Database } from "./db.ts";
import {
  captureLogEvidenceDocument,
  createAppServer,
  isForensicLogEntry,
  type LogEvidenceEntry,
  logEvidenceKey,
  renderLogEvidenceDocument,
} from "./app-server.ts";
import { LOG_EVIDENCE_DOCUMENT_SOURCE } from "./documents.ts";
import { APP_PORT_AUTO } from "./config.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const testOpts = { sanitizeResources: false, sanitizeOps: false };

async function withProjectKernel<T>(
  fn: (kernel: Kernel, projectDir: string) => Promise<T>,
): Promise<T> {
  const db = await Database.create({ driver: "pglite" });
  const kernel = new Kernel(db);
  const projectDir = mkdtempSync(join(tmpdir(), "genie-log-evidence-"));
  kernel.projectDir = projectDir;
  try {
    return await fn(kernel, projectDir);
  } finally {
    rmSync(projectDir, { recursive: true, force: true });
    await db.close();
  }
}

// A representative forensic entry: a user-app handler crash carrying a stack — exactly the
// payload the 500-slot ring buffer loses.
function sampleForensicEntry(
  overrides: Partial<LogEvidenceEntry> = {},
): LogEvidenceEntry {
  return {
    level: "error",
    source: "handler",
    message: "TypeError: cannot read property 'x' of undefined",
    route: "GET /widgets/:id",
    stack: "Error: boom\n  at widgetHandler (widgets.ts:12:9)",
    ...overrides,
  };
}

Deno.test({
  ...testOpts,
  name:
    "isForensicLogEntry captures only error entries carrying a stack from user-code sources",
  fn: () => {
    // The one relevant shape: error + stack + user-code source.
    assert(isForensicLogEntry(sampleForensicEntry()));
    assert(isForensicLogEntry(sampleForensicEntry({ source: "script" })));
    assert(isForensicLogEntry(sampleForensicEntry({ source: "app" })));

    // Not relevant: an info with no stack (the buffer keeps enough of these).
    assertEquals(
      isForensicLogEntry({
        level: "info",
        source: "handler",
        message: "served /widgets in 3ms",
      }),
      false,
    );
    // An error with no stack is not forensic (nothing the buffer would lose).
    assertEquals(
      isForensicLogEntry(sampleForensicEntry({ stack: undefined })),
      false,
    );
    // A warn (e.g. a handler timeout) is not captured even with a stack.
    assertEquals(
      isForensicLogEntry(sampleForensicEntry({ level: "warn" })),
      false,
    );
    // A system/agent-sourced error is out of scope — this is also the recursion
    // firewall: the capture path degrades by emitting a source:"system" log.
    assertEquals(
      isForensicLogEntry(sampleForensicEntry({ source: "system" })),
      false,
    );
    assertEquals(
      isForensicLogEntry(sampleForensicEntry({ source: "lsp" })),
      false,
    );
  },
});

Deno.test({
  ...testOpts,
  name:
    "logEvidenceKey is content-stable and independent of the volatile log id",
  fn: () => {
    const a = sampleForensicEntry();
    // Same forensic payload → same key (no id/timestamp participates).
    assertEquals(logEvidenceKey(a), logEvidenceKey({ ...a }));
    // Legible composite: source:route:<hash>.
    assertStringIncludes(logEvidenceKey(a), "handler:GET /widgets/:id:");
    // A different message → a different key.
    assert(
      logEvidenceKey(a) !==
        logEvidenceKey(sampleForensicEntry({ message: "other" })),
    );
    // A different stack → a different key.
    assert(
      logEvidenceKey(a) !==
        logEvidenceKey(sampleForensicEntry({ stack: "different" })),
    );
  },
});

Deno.test({
  ...testOpts,
  name:
    "captureLogEvidenceDocument persists one agent doc + one log/evidence ref at the head",
  fn: async () => {
    await withProjectKernel(async (kernel) => {
      const session = await kernel.sessions.createSession(
        "Log Evidence Session",
      );
      const entry = sampleForensicEntry();
      const key = logEvidenceKey(entry);

      const captured = await captureLogEvidenceDocument(
        kernel.documents,
        entry,
        session.id,
      );
      assertEquals(captured.ok, true);
      if (!captured.ok) return;

      // The ref cites the composite key under the log/evidence contract and pins the head.
      assertEquals(captured.data.refType, "log");
      assertEquals(captured.data.role, "evidence");
      assertEquals(captured.data.refId, key);

      const doc = await kernel.documents.findBySource(
        LOG_EVIDENCE_DOCUMENT_SOURCE,
        key,
        { sessionId: session.id },
      );
      assert(doc, "log-evidence document should exist by origin");
      assertEquals(doc.createdBy, "agent");
      assertEquals(doc.scope, "session");
      assertEquals(doc.metadata.source, LOG_EVIDENCE_DOCUMENT_SOURCE);
      assertEquals(doc.metadata.sourceId, key);
      assertEquals(captured.data.versionHash, doc.currentVersionHash);

      // The captured bytes render the forensic fields (level/source/route/message/stack).
      const content = await kernel.documents.readContent(doc.id);
      assertEquals(content.ok, true);
      if (content.ok) {
        assertStringIncludes(content.data.content, entry.message);
        assertStringIncludes(content.data.content, entry.stack!);
        assertStringIncludes(content.data.content, entry.route!);
        assertStringIncludes(content.data.content, "**Level:** error");
      }

      // Exactly one live ref at the head.
      const refs = await kernel.documents.listRefsByTarget(
        "log",
        key,
        "evidence",
      );
      assertEquals(refs.length, 1);
      assertEquals(refs[0]?.documentId, doc.id);
      assertEquals(refs[0]?.versionHash, doc.currentVersionHash);
    });
  },
});

Deno.test({
  ...testOpts,
  name:
    "captureLogEvidenceDocument is idempotent per composite key (one live doc + one ref on re-emit)",
  fn: async () => {
    await withProjectKernel(async (kernel) => {
      const session = await kernel.sessions.createSession("Idem Log Session");
      const entry = sampleForensicEntry();
      const key = logEvidenceKey(entry);

      const first = await captureLogEvidenceDocument(
        kernel.documents,
        entry,
        session.id,
      );
      assertEquals(first.ok, true);

      // Re-emit the SAME forensic payload — a buffer-reset log id would collide, but the
      // content-addressed key keeps this a clean no-op: same doc, single ref, no duplicate.
      const second = await captureLogEvidenceDocument(
        kernel.documents,
        { ...entry },
        session.id,
      );
      assertEquals(second.ok, true);
      if (first.ok && second.ok) {
        assertEquals(first.data.documentId, second.data.documentId);
      }

      const docs = await kernel.documents.list({ sessionId: session.id });
      assertEquals(docs.ok, true);
      if (docs.ok) {
        const logDocs = docs.data.filter((d) =>
          d.metadata.source === LOG_EVIDENCE_DOCUMENT_SOURCE &&
          d.metadata.sourceId === key
        );
        assertEquals(logDocs.length, 1);
      }

      const refs = await kernel.documents.listRefsByTarget(
        "log",
        key,
        "evidence",
      );
      assertEquals(refs.length, 1);
    });
  },
});

Deno.test({
  ...testOpts,
  name:
    "captureLogEvidenceDocument degrades without a project (no throw, no doc, no ref)",
  fn: async () => {
    const db = await Database.create({ driver: "pglite" });
    const kernel = new Kernel(db);
    try {
      // No kernel.projectDir → a session-scoped document cannot be stored.
      const entry = sampleForensicEntry();
      const key = logEvidenceKey(entry);
      const captured = await captureLogEvidenceDocument(
        kernel.documents,
        entry,
        "sess_no_project",
      );
      assertEquals(captured.ok, false);
      if (!captured.ok) assertEquals(captured.error.code, "PROJECT_REQUIRED");

      const refs = await kernel.documents.listRefsByTarget(
        "log",
        key,
        "evidence",
      );
      assertEquals(refs.length, 0);
    } finally {
      await db.close();
    }
  },
});

Deno.test({
  ...testOpts,
  name:
    "renderLogEvidenceDocument omits the volatile id/timestamp so re-emits dedupe",
  fn: () => {
    const rendered = renderLogEvidenceDocument(sampleForensicEntry());
    assertStringIncludes(rendered, "# Log evidence: error (handler)");
    assertStringIncludes(rendered, "## Stack");
    // No id/timestamp bytes leak into the content-addressed snapshot.
    assertEquals(rendered.includes("timestamp"), false);
  },
});

Deno.test({
  ...testOpts,
  name:
    "a thrown handler mints a log/evidence doc and stamps its id back into the log entry",
  fn: async () => {
    await withProjectKernel(async (kernel) => {
      kernel.routes.register("GET", "/boom", "boomHandler");
      kernel.handlers.register(
        "boomHandler",
        "function boomHandler() { throw new Error('kaboom'); }",
        () => {
          throw new Error("kaboom");
        },
      );

      const server = createAppServer(kernel, APP_PORT_AUTO);
      try {
        server.rebuild();
        const resp = await fetch(`http://127.0.0.1:${server.port}/boom`);
        await resp.body?.cancel();
        assertEquals(resp.status, 500);

        // The handler-error entry was still logged normally...
        const errors = kernel.log.query({ source: "handler", level: "error" });
        const entry = errors.find((e) => e.route === "GET /boom");
        assert(entry, "the handler crash should be logged");
        const documentId = entry.metadata?.documentId;
        assertEquals(typeof documentId, "string");

        // ...and a durable log/evidence doc + single ref appear beside it, keyed by the
        // content-addressed origin key, with the entry pointing at the minted doc.
        const key = logEvidenceKey({
          level: "error",
          source: "handler",
          message: entry.message,
          route: entry.route,
          stack: entry.stack,
        });
        const refs = await kernel.documents.listRefsByTarget(
          "log",
          key,
          "evidence",
        );
        assertEquals(refs.length, 1);
        assertEquals(refs[0]?.documentId, documentId);

        const doc = await kernel.documents.findBySource(
          LOG_EVIDENCE_DOCUMENT_SOURCE,
          key,
        );
        assert(doc, "log-evidence document should exist for the crash");
        assertEquals(doc.id, documentId);
        assertEquals(doc.createdBy, "agent");
        assertEquals(refs[0]?.versionHash, doc.currentVersionHash);
      } finally {
        await server.shutdown();
      }
    });
  },
});

Deno.test({
  ...testOpts,
  name:
    "a handler-not-found error (no stack) is logged but NOT captured as evidence",
  fn: async () => {
    await withProjectKernel(async (kernel) => {
      // A route with no registered handler → app-server logs an error WITHOUT a stack,
      // which is not forensic and must not mint a document.
      kernel.routes.register("GET", "/missing", "noSuchHandler");

      const server = createAppServer(kernel, APP_PORT_AUTO);
      try {
        server.rebuild();
        const resp = await fetch(`http://127.0.0.1:${server.port}/missing`);
        await resp.body?.cancel();
        assertEquals(resp.status, 500);

        const errors = kernel.log.query({ source: "handler", level: "error" });
        const entry = errors.find((e) => e.route === "GET /missing");
        assert(entry, "the missing-handler error should be logged");
        assertEquals(entry.metadata?.documentId, undefined);

        const docs = await kernel.documents.list({});
        assertEquals(docs.ok, true);
        if (docs.ok) {
          const logDocs = docs.data.filter((d) =>
            d.metadata.source === LOG_EVIDENCE_DOCUMENT_SOURCE
          );
          assertEquals(logDocs.length, 0);
        }
      } finally {
        await server.shutdown();
      }
    });
  },
});
