import { assertEquals, assertFalse } from "@std/assert";
import { join } from "node:path";
import {
  egressAllowed,
  projectLocalId,
  sanitizeProperties,
} from "./telemetry.ts";
import { CONSENT_VERSION, type TelemetrySettings } from "./config.ts";

Deno.test("sanitizeProperties drops secret-shaped keys and unsupported values", () => {
  const result = sanitizeProperties({
    Count: 3,
    "Has Project": true,
    authToken: "secret",
    cookie: "session",
    nested: { value: 1 },
    list: [1, 2, 3],
  });

  assertEquals(result, {
    count: 3,
    has_project: true,
  });
});

Deno.test("sanitizeProperties truncates and redacts obvious sensitive string values", () => {
  const result = sanitizeProperties({
    message: `Bearer abcdefghijklmnopqrstuvwxyz and test@example.com ${
      "x".repeat(300)
    }`,
  });

  const message = String(result.message);
  assertFalse(message.includes("abcdefghijklmnopqrstuvwxyz"));
  assertFalse(message.includes("test@example.com"));
  assertEquals(message.length, 256);
});

Deno.test("projectLocalId is stable and does not expose raw path", () => {
  const raw = "/Users/example/Projects/customer-app";
  const id = projectLocalId(raw);

  assertEquals(projectLocalId(raw), id);
  assertEquals(id.length, 16);
  assertFalse(id.includes("customer"));
});

// --- A5 (Stream A): the egressAllowed privacy gate ---

function settings(
  overrides: Partial<Required<TelemetrySettings>>,
): Required<TelemetrySettings> {
  return {
    enabled: false,
    endpoint: "",
    releaseChannel: "dev",
    installationId: "",
    syncIntervalMs: 30_000,
    maxBatchSize: 50,
    includeDiagnosticsByDefault: false,
    consentVersion: 0,
    consentGrantedAt: "",
    consent: { telemetry: false, feedback: false },
    ...overrides,
  };
}

Deno.test("A5 egressAllowed: no consent blocks BOTH events and feedback (the feedback-bypass fix)", () => {
  // Before A5, feedback egressed with `settings.enabled || kind === 'feedback'`,
  // so feedback left the machine even with telemetry off and no consent. Now the
  // version check gates every kind: a never-consented install egresses nothing.
  const fresh = settings({ enabled: true }); // enabled but never consented
  assertFalse(egressAllowed(fresh, "event"));
  assertFalse(egressAllowed(fresh, "feedback"));
});

Deno.test("A5 egressAllowed: consent + enabled permits events; feedback needs only its own consent", () => {
  const both = settings({
    enabled: true,
    consentVersion: CONSENT_VERSION,
    consent: { telemetry: true, feedback: true },
  });
  assertEquals(egressAllowed(both, "event"), true);
  assertEquals(egressAllowed(both, "feedback"), true);

  // Passive events additionally require the `enabled` master switch...
  const consentedButPaused = settings({
    enabled: false,
    consentVersion: CONSENT_VERSION,
    consent: { telemetry: true, feedback: true },
  });
  assertFalse(egressAllowed(consentedButPaused, "event"));
  // ...while user-initiated feedback flows on its own consent even when paused.
  assertEquals(egressAllowed(consentedButPaused, "feedback"), true);
});

Deno.test("A5 egressAllowed: per-category opt-out is honored independently", () => {
  const feedbackOnly = settings({
    enabled: true,
    consentVersion: CONSENT_VERSION,
    consent: { telemetry: false, feedback: true },
  });
  assertFalse(egressAllowed(feedbackOnly, "event"));
  assertEquals(egressAllowed(feedbackOnly, "feedback"), true);
});

Deno.test("A5 egressAllowed: a consent version below current re-blocks (version bump re-prompts)", () => {
  const stale = settings({
    enabled: true,
    consentVersion: CONSENT_VERSION - 1,
    consent: { telemetry: true, feedback: true },
  });
  assertFalse(egressAllowed(stale, "event"));
  assertFalse(egressAllowed(stale, "feedback"));
});

// Integration: drive a real TelemetryManager against a temp HOME + a local ingest
// server, proving the gate end-to-end through sync()/submitFeedback().

async function withManager(
  fn: (m: {
    config: typeof import("./config.ts");
    manager: InstanceType<typeof import("./telemetry.ts").TelemetryManager>;
    queuePath: string;
    ingest: () => unknown[];
    endpoint: string;
  }) => Promise<void>,
): Promise<void> {
  const home = await Deno.makeTempDir({ prefix: "genie-a5-telemetry-" });
  const oldHome = Deno.env.get("HOME");
  Deno.env.set("HOME", home);
  const received: unknown[] = [];
  const ac = new AbortController();
  const server = Deno.serve(
    { port: 0, signal: ac.signal, onListen() {} },
    async (req) => {
      const body = await req.json().catch(() => ({}));
      received.push(body);
      const events = Array.isArray(body.events) ? body.events : [];
      const feedback = Array.isArray(body.feedback) ? body.feedback : [];
      return Response.json({
        ok: true,
        accepted_event_ids: events.map((e: { event_id: string }) => e.event_id),
        accepted_feedback_ids: feedback.map((f: { feedback_id: string }) =>
          f.feedback_id
        ),
      });
    },
  );
  const port = (server.addr as Deno.NetAddr).port;
  const endpoint = `http://localhost:${port}`;
  try {
    const bust = crypto.randomUUID();
    const config = await import(`./config.ts?b=${bust}`);
    const tele = await import(`./telemetry.ts?b=${bust}`);
    config.setTelemetrySettings({ endpoint });
    const manager = new tele.TelemetryManager({ getContext: () => null });
    const queuePath = join(home, ".config", "opentide", "telemetry.jsonl");
    await fn({ config, manager, queuePath, ingest: () => received, endpoint });
  } finally {
    ac.abort();
    await server.finished;
    if (oldHome === undefined) Deno.env.delete("HOME");
    else Deno.env.set("HOME", oldHome);
    await Deno.remove(home, { recursive: true });
  }
}

Deno.test("A5 sync: a manually-queued feedback record is NOT selected without consent", async () => {
  await withManager(async ({ manager, queuePath, ingest }) => {
    // Bypass submitFeedback's guard entirely: hand-write a pending feedback record
    // to the queue as a pre-A5 build (or a future bug) might, then prove sync()'s
    // own filter refuses to send it while consent is absent.
    Deno.mkdirSync(join(queuePath, ".."), { recursive: true });
    Deno.writeTextFileSync(
      queuePath,
      JSON.stringify({
        id: "fb-1",
        kind: "feedback",
        status: "pending",
        queued_at: new Date().toISOString(),
        attempts: 0,
        payload: {
          schema_version: 1,
          feedback_id: "fb-1",
          submitted_at: new Date().toISOString(),
          installation_id: "",
          app_session_id: "s",
          kind: "bug",
          message: "recent_errors could leak here",
          include_diagnostics: false,
        },
      }) + "\n",
    );

    const status = await manager.sync();
    assertEquals(status.lastSyncStatus, "skipped");
    assertEquals(status.lastSyncError, "Consent not granted");
    assertEquals(ingest().length, 0); // nothing left the machine
    // The record is still in the queue (held, not sent) — pendingFeedback stays 1.
    assertEquals(status.pendingFeedback, 1);
  });
});

Deno.test("A5 submitFeedback: pre-consent it enqueues nothing (no backlog to leak later)", async () => {
  await withManager(async ({ manager, ingest }) => {
    await manager.submitFeedback({ kind: "bug", message: "hello" });
    // Nothing enqueued, nothing sent, no id minted.
    assertEquals(manager.getStatus().pendingFeedback, 0);
    const status = await manager.sync();
    assertEquals(ingest().length, 0);
    assertEquals(status.installationId, "");
  });
});

Deno.test("A5 end-to-end: granting feedback consent lets submitted feedback egress", async () => {
  await withManager(async ({ config, manager, ingest }) => {
    config.setTelemetrySettings({
      consent: { telemetry: false, feedback: true },
    });
    await manager.submitFeedback({ kind: "bug", message: "please fix" });
    assertEquals(manager.getStatus().pendingFeedback, 1);

    const status = await manager.sync();
    assertEquals(status.lastSyncStatus, "ok");
    // The local ingest server received exactly one feedback item, no events.
    const batch = ingest()[0] as { events: unknown[]; feedback: unknown[] };
    assertEquals(batch.feedback.length, 1);
    assertEquals(batch.events.length, 0);
    // Queue drained after a successful send.
    assertEquals(manager.getStatus().pendingFeedback, 0);
  });
});

Deno.test("A5 end-to-end: revoke makes submitFeedback inert again", async () => {
  await withManager(async ({ config, manager, ingest }) => {
    config.setTelemetrySettings({
      consent: { telemetry: true, feedback: true },
    });
    config.setTelemetrySettings({
      consent: { telemetry: false, feedback: false },
    });
    await manager.submitFeedback({ kind: "bug", message: "should not send" });
    assertEquals(manager.getStatus().pendingFeedback, 0);
    await manager.sync();
    assertEquals(ingest().length, 0);
  });
});
