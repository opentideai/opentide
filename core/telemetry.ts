import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { createHash } from "node:crypto";
import { getProjectPaths } from "./project-manager.ts";
import {
  CONSENT_VERSION,
  getTelemetrySettings,
  getUserConfigDir,
  type TelemetrySettings,
} from "./config.ts";
import type { ProjectContext } from "./project-loader.ts";

// The single privacy choke point (Stream A / A5). Every egress path — the sync()
// selection, the track() event enqueue, and the submitFeedback() enqueue — routes
// through this predicate; there is no scattered boolean anywhere else. A byte
// leaves the machine ONLY when consent was granted at the current CONSENT_VERSION
// AND the per-category flag is on (events additionally need the `enabled` master
// switch). A never-consented install fails the version check and is inert.
export function egressAllowed(
  settings: Required<TelemetrySettings>,
  kind: "event" | "feedback",
): boolean {
  if ((settings.consentVersion ?? 0) < CONSENT_VERSION) return false;
  if (kind === "feedback") return settings.consent.feedback === true;
  return settings.consent.telemetry === true && settings.enabled === true;
}

export type ReleaseChannel = "dev" | "beta" | "stable";
export type TelemetryPrimitive = string | number | boolean | null;

export interface TelemetryEvent {
  schema_version: 1;
  event_id: string;
  event_name: string;
  occurred_at: string;
  installation_id: string;
  app_session_id: string;
  project_local_id?: string;
  release: {
    app_version: string;
    build_id?: string;
    release_channel: ReleaseChannel;
  };
  runtime: {
    os: string;
    arch: string;
    deno_version?: string;
    browser?: string;
  };
  properties: Record<string, TelemetryPrimitive>;
}

export interface FeedbackDiagnostics {
  app_version: string;
  build_id?: string;
  release_channel: string;
  platform: string;
  current_panel?: string;
  current_route?: string;
  recent_errors: Array<{
    timestamp: string;
    source: string;
    message: string;
  }>;
  recent_requests: Array<{
    timestamp: string;
    method: string;
    path: string;
    status: number;
    duration_ms: number;
  }>;
  project_counts?: {
    routes: number;
    handlers: number;
    functions: number;
    schemas: number;
    tests: number;
  };
  active_changeset_id?: string;
  active_session_id?: string;
}

export interface FeedbackReport {
  schema_version: 1;
  feedback_id: string;
  submitted_at: string;
  installation_id: string;
  app_session_id: string;
  project_local_id?: string;
  kind: "bug" | "feature_request" | "general";
  severity?: "low" | "medium" | "high" | "blocking";
  message: string;
  contact_email?: string;
  include_diagnostics: boolean;
  diagnostics?: FeedbackDiagnostics;
}

export interface TelemetryStatus {
  enabled: boolean;
  endpoint: string;
  releaseChannel: ReleaseChannel;
  installationId: string;
  appSessionId: string;
  includeDiagnosticsByDefault: boolean;
  pendingEvents: number;
  pendingFeedback: number;
  droppedItems: number;
  lastSyncAt: string | null;
  lastSyncStatus: "never" | "ok" | "failed" | "skipped";
  lastSyncError: string | null;
}

interface QueueRecord {
  id: string;
  kind: "event" | "feedback";
  status: "pending" | "dropped";
  queued_at: string;
  retry_after?: string;
  attempts: number;
  last_error?: string;
  payload?: TelemetryEvent | FeedbackReport;
}

interface IngestResponse {
  ok?: boolean;
  accepted_event_ids?: string[];
  accepted_feedback_ids?: string[];
  rejected?: Array<{ id: string; reason: string; retryable: boolean }>;
}

interface TelemetryManagerOptions {
  getContext?: () => ProjectContext | null;
  // The project's directory, for a process that holds no ProjectContext (the
  // agent). Falls back to getContext's.
  getProjectPath?: () => string | null;
  getCurrentSessionId?: () => string | null;
  // The queue's file name. Two processes on one project keep separate queues,
  // since a queue is rewritten whole.
  queueFile?: string;
}

const DEFAULT_QUEUE_FILE = "telemetry.jsonl";

const MAX_STRING_LENGTH = 256;
const SECRET_KEY_RE = /token|key|secret|password|authorization|cookie/i;
const SAFE_EVENT_NAME_RE = /^[a-z][a-z0-9_]{1,80}$/;

export class TelemetryManager {
  readonly appSessionId = crypto.randomUUID();
  private lastSyncAt: string | null = null;
  private lastSyncStatus: TelemetryStatus["lastSyncStatus"] = "never";
  private lastSyncError: string | null = null;

  constructor(private readonly opts: TelemetryManagerOptions) {}

  getSettings(): Required<TelemetrySettings> {
    return getTelemetrySettings();
  }

  getStatus(): TelemetryStatus {
    const settings = this.getSettings();
    const records = this.readQueue();
    return {
      enabled: settings.enabled,
      endpoint: settings.endpoint,
      releaseChannel: settings.releaseChannel,
      installationId: settings.installationId,
      appSessionId: this.appSessionId,
      includeDiagnosticsByDefault: settings.includeDiagnosticsByDefault,
      pendingEvents:
        records.filter((r) => r.status === "pending" && r.kind === "event")
          .length,
      pendingFeedback:
        records.filter((r) => r.status === "pending" && r.kind === "feedback")
          .length,
      droppedItems: records.filter((r) => r.status === "dropped").length,
      lastSyncAt: this.lastSyncAt,
      lastSyncStatus: this.lastSyncStatus,
      lastSyncError: this.lastSyncError,
    };
  }

  track(
    eventName: string,
    properties: Record<string, unknown> = {},
  ): TelemetryEvent {
    if (!SAFE_EVENT_NAME_RE.test(eventName)) {
      throw new Error(`Invalid telemetry event name: ${eventName}`);
    }
    const settings = this.getSettings();
    const event: TelemetryEvent = {
      schema_version: 1,
      event_id: crypto.randomUUID(),
      event_name: eventName,
      occurred_at: new Date().toISOString(),
      installation_id: settings.installationId,
      app_session_id: this.appSessionId,
      ...this.projectFields(),
      release: this.releaseFields(settings),
      runtime: runtimeFields(),
      properties: sanitizeProperties(properties),
    };
    if (egressAllowed(settings, "event")) {
      this.enqueue("event", event.event_id, event);
    }
    return event;
  }

  async submitFeedback(input: {
    kind: unknown;
    severity?: unknown;
    message: unknown;
    contactEmail?: unknown;
    includeDiagnostics?: unknown;
    currentPanel?: unknown;
    currentRoute?: unknown;
  }): Promise<FeedbackReport> {
    const settings = this.getSettings();
    const message = sanitizeFreeText(input.message, 4000);
    if (!message.trim()) throw new Error("Feedback message is required");

    const includeDiagnostics = typeof input.includeDiagnostics === "boolean"
      ? input.includeDiagnostics
      : settings.includeDiagnosticsByDefault;
    const report: FeedbackReport = {
      schema_version: 1,
      feedback_id: crypto.randomUUID(),
      submitted_at: new Date().toISOString(),
      installation_id: settings.installationId,
      app_session_id: this.appSessionId,
      ...this.projectFields(),
      kind: normalizeFeedbackKind(input.kind),
      ...(normalizeSeverity(input.severity)
        ? { severity: normalizeSeverity(input.severity) }
        : {}),
      message,
      ...(typeof input.contactEmail === "string" &&
          input.contactEmail.trim()
        ? { contact_email: sanitizeFreeText(input.contactEmail, 320) }
        : {}),
      include_diagnostics: includeDiagnostics,
      ...(includeDiagnostics
        ? {
          diagnostics: await this.buildDiagnostics(
            typeof input.currentPanel === "string" ? input.currentPanel : "",
            typeof input.currentRoute === "string" ? input.currentRoute : "",
          ),
        }
        : {}),
    };
    // Mirror track()'s guard: without consent for feedback, nothing is written to
    // the queue at all — so there is no pre-consent backlog that could escape the
    // moment consent is later granted. The report is still returned (sanitized) so
    // the API contract holds, but it never touches disk or the wire.
    if (egressAllowed(settings, "feedback")) {
      this.enqueue("feedback", report.feedback_id, report);
    }
    this.track("feedback_submitted", {
      kind: report.kind,
      severity: report.severity ?? null,
      include_diagnostics: report.include_diagnostics,
    });
    return report;
  }

  // Syncs in the background when an endpoint is set and some category may
  // leave the machine. Feedback consent is independent of the passive-telemetry
  // switch, so feedback-only consent still flushes; sync() filters per record.
  // Returns the sync, or null when there was nothing to do.
  syncIfAllowed(): Promise<TelemetryStatus> | null {
    const settings = this.getSettings();
    if (!settings.endpoint.trim()) return null;
    if (
      !egressAllowed(settings, "event") && !egressAllowed(settings, "feedback")
    ) {
      return null;
    }
    return this.sync();
  }

  async sync(): Promise<TelemetryStatus> {
    const settings = this.getSettings();
    if (!settings.endpoint.trim()) {
      return this.markSkipped("Telemetry endpoint not configured");
    }

    const now = Date.now();
    const records = this.readQueue();
    const pending = records.filter((r) =>
      r.status === "pending" && r.payload &&
      egressAllowed(settings, r.kind) &&
      (!r.retry_after || Date.parse(r.retry_after) <= now)
    ).slice(0, settings.maxBatchSize);

    if (pending.length === 0) {
      const consentBlocked = (settings.consentVersion ?? 0) < CONSENT_VERSION;
      return this.markSkipped(
        consentBlocked
          ? "Consent not granted"
          : settings.enabled
          ? null
          : "Passive telemetry disabled",
      );
    }

    const events = pending
      .filter((r) => r.kind === "event")
      .map((r) => r.payload as TelemetryEvent);
    const feedback = pending
      .filter((r) => r.kind === "feedback")
      .map((r) => r.payload as FeedbackReport);
    const batchId = crypto.randomUUID();

    try {
      const res = await fetch(
        settings.endpoint.replace(/\/+$/, "") + "/v1/ingest",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Genie-Client-Version": this.releaseFields(settings).app_version,
            "X-Genie-Batch-Id": batchId,
          },
          body: JSON.stringify({
            schema_version: 1,
            source: "genie_app",
            sent_at: new Date().toISOString(),
            batch_id: batchId,
            events,
            feedback,
          }),
        },
      );
      if (!res.ok) throw new Error(`Ingest failed with HTTP ${res.status}`);
      const data = await res.json().catch(() => ({})) as IngestResponse;
      this.applySyncResponse(records, pending, data);
      this.lastSyncAt = new Date().toISOString();
      this.lastSyncStatus = "ok";
      this.lastSyncError = null;
    } catch (err) {
      this.applyRetry(records, pending, errorText(err));
      this.lastSyncAt = new Date().toISOString();
      this.lastSyncStatus = "failed";
      this.lastSyncError = errorText(err);
    }

    return this.getStatus();
  }

  private markSkipped(error: string | null): TelemetryStatus {
    this.lastSyncAt = new Date().toISOString();
    this.lastSyncStatus = "skipped";
    this.lastSyncError = error;
    return this.getStatus();
  }

  private enqueue(
    kind: QueueRecord["kind"],
    id: string,
    payload: TelemetryEvent | FeedbackReport,
  ): void {
    const file = this.queuePath();
    mkdirSync(dirname(file), { recursive: true });
    const record: QueueRecord = {
      id,
      kind,
      status: "pending",
      queued_at: new Date().toISOString(),
      attempts: 0,
      payload,
    };
    appendFileSync(file, JSON.stringify(record) + "\n", { mode: 0o600 });
  }

  private readQueue(): QueueRecord[] {
    const file = this.queuePath();
    if (!existsSync(file)) return [];
    const lines = readFileSync(file, "utf-8").split(/\n+/).filter(Boolean);
    const records: QueueRecord[] = [];
    for (const line of lines) {
      try {
        const parsed = JSON.parse(line) as QueueRecord;
        if (
          typeof parsed.id === "string" &&
          (parsed.kind === "event" || parsed.kind === "feedback") &&
          (parsed.status === "pending" || parsed.status === "dropped")
        ) {
          records.push(parsed);
        }
      } catch {
        // Ignore corrupt queue lines; the queue is best-effort local cache.
      }
    }
    return records;
  }

  private writeQueue(records: QueueRecord[]): void {
    const file = this.queuePath();
    mkdirSync(dirname(file), { recursive: true });
    const tmp = file + ".tmp";
    writeFileSync(
      tmp,
      records.map((r) => JSON.stringify(r)).join("\n") +
        (records.length ? "\n" : ""),
      { mode: 0o600 },
    );
    renameSync(tmp, file);
  }

  private projectPath(): string | null {
    return this.opts.getProjectPath?.() ??
      this.opts.getContext?.()?.entry.path ?? null;
  }

  private queuePath(): string {
    const file = this.opts.queueFile ?? DEFAULT_QUEUE_FILE;
    const projectDir = this.projectPath();
    if (projectDir) return join(getProjectPaths(projectDir).cacheDir, file);
    return join(getUserConfigDir(), file);
  }

  private applySyncResponse(
    records: QueueRecord[],
    pending: QueueRecord[],
    data: IngestResponse,
  ): void {
    const accepted = new Set([
      ...(data.accepted_event_ids ?? []),
      ...(data.accepted_feedback_ids ?? []),
    ]);
    const rejected = new Map((data.rejected ?? []).map((r) => [r.id, r]));
    const pendingIds = new Set(pending.map((r) => r.id));
    const next: QueueRecord[] = [];

    for (const record of records) {
      if (!pendingIds.has(record.id)) {
        next.push(record);
        continue;
      }
      if (accepted.has(record.id)) continue;
      const rejection = rejected.get(record.id);
      if (rejection && !rejection.retryable) {
        next.push({
          id: record.id,
          kind: record.kind,
          status: "dropped",
          queued_at: record.queued_at,
          attempts: record.attempts + 1,
          last_error: rejection.reason,
        });
        continue;
      }
      next.push(
        nextRetry(record, rejection?.reason ?? "Not accepted by ingest"),
      );
    }
    this.writeQueue(next);
  }

  private applyRetry(
    records: QueueRecord[],
    pending: QueueRecord[],
    message: string,
  ): void {
    const pendingIds = new Set(pending.map((r) => r.id));
    this.writeQueue(
      records.map((r) => pendingIds.has(r.id) ? nextRetry(r, message) : r),
    );
  }

  private releaseFields(settings: Required<TelemetrySettings>) {
    const projectDir = this.projectPath() ?? undefined;
    return {
      app_version: readVersion(projectDir),
      release_channel: settings.releaseChannel,
    };
  }

  private projectFields(): { project_local_id?: string } {
    const projectDir = this.projectPath();
    return projectDir ? { project_local_id: projectLocalId(projectDir) } : {};
  }

  private async buildDiagnostics(
    currentPanel: string,
    currentRoute: string,
  ): Promise<FeedbackDiagnostics> {
    const ctx = this.opts.getContext?.() ?? null;
    const settings = this.getSettings();
    const release = this.releaseFields(settings);
    const recentErrors = ctx?.kernel.log.recent(100)
      .filter((entry) => entry.level === "error" || entry.level === "warn")
      .slice(-20)
      .map((entry) => ({
        timestamp: entry.timestamp,
        source: sanitizeFreeText(entry.source, 80),
        message: sanitizeFreeText(entry.message, 500),
      })) ?? [];
    const recentRequests = ctx?.kernel.requestLog.recent(20).map((req) => ({
      timestamp: req.timestamp,
      method: sanitizeFreeText(req.method, 12),
      path: sanitizePath(req.path),
      status: req.status,
      duration_ms: req.durationMs,
    })) ?? [];
    const schemaCount = ctx ? (await ctx.kernel.db.listSchemas()).length : 0;
    return {
      app_version: release.app_version,
      release_channel: release.release_channel,
      platform: `${Deno.build.os}/${Deno.build.arch}`,
      ...(currentPanel
        ? { current_panel: sanitizeFreeText(currentPanel, 80) }
        : {}),
      ...(currentRoute ? { current_route: sanitizePath(currentRoute) } : {}),
      recent_errors: recentErrors,
      recent_requests: recentRequests,
      ...(ctx
        ? {
          project_counts: {
            routes: ctx.kernel.routes.list().length,
            handlers: ctx.kernel.handlers.list().length,
            functions: ctx.kernel.functions.list().length,
            schemas: schemaCount,
            tests: ctx.kernel.tests.list().length,
          },
        }
        : {}),
      ...(this.opts.getCurrentSessionId?.()
        ? { active_session_id: this.opts.getCurrentSessionId?.() ?? undefined }
        : {}),
    };
  }
}

export function sanitizeProperties(
  input: Record<string, unknown>,
): Record<string, TelemetryPrimitive> {
  const out: Record<string, TelemetryPrimitive> = {};
  for (const [rawKey, value] of Object.entries(input)) {
    const key = rawKey.trim().replace(/[^a-zA-Z0-9_]/g, "_").toLowerCase();
    if (!key || SECRET_KEY_RE.test(key)) continue;
    const sanitized = sanitizePrimitive(value);
    if (sanitized !== undefined) out[key] = sanitized;
  }
  return out;
}

export function projectLocalId(projectPath: string): string {
  return createHash("sha256").update(projectPath).digest("hex").slice(0, 16);
}

function sanitizePrimitive(value: unknown): TelemetryPrimitive | undefined {
  if (value === null) return null;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") {
    return sanitizeFreeText(value, MAX_STRING_LENGTH);
  }
  return undefined;
}

function sanitizeFreeText(value: unknown, maxLength: number): string {
  const text = String(value ?? "")
    .replace(/Bearer\s+[A-Za-z0-9._~+/-]+=*/gi, "Bearer [redacted]")
    .replace(/sk-[A-Za-z0-9._-]{12,}/g, "[redacted]")
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[email]")
    .trim();
  return text.length > maxLength ? text.slice(0, maxLength) : text;
}

function sanitizePath(path: string): string {
  if (!path) return "";
  if (
    path.startsWith("/") && !path.startsWith("/Users/") &&
    !path.startsWith("/home/")
  ) {
    return sanitizeFreeText(path, 256);
  }
  return basename(path);
}

function runtimeFields(): TelemetryEvent["runtime"] {
  return {
    os: Deno.build.os,
    arch: Deno.build.arch,
    deno_version: Deno.version.deno,
  };
}

function normalizeFeedbackKind(value: unknown): FeedbackReport["kind"] {
  return value === "feature_request" || value === "general" ? value : "bug";
}

function normalizeSeverity(
  value: unknown,
): FeedbackReport["severity"] | undefined {
  return value === "low" || value === "medium" || value === "high" ||
      value === "blocking"
    ? value
    : undefined;
}

function nextRetry(record: QueueRecord, message: string): QueueRecord {
  const attempts = record.attempts + 1;
  const delayMs = Math.min(30 * 60_000, 30_000 * 2 ** Math.min(attempts, 6));
  const jitterMs = Math.floor(Math.random() * 5000);
  return {
    ...record,
    attempts,
    retry_after: new Date(Date.now() + delayMs + jitterMs).toISOString(),
    last_error: message,
  };
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function readVersion(projectDir: string | undefined): string {
  if (!projectDir) return "0.1.0";
  const path = join(projectDir, "version.json");
  if (!existsSync(path)) return "0.1.0";
  try {
    const data = JSON.parse(readFileSync(path, "utf-8")) as {
      version?: unknown;
    };
    return typeof data.version === "string" && data.version.trim()
      ? data.version.trim()
      : "0.1.0";
  } catch {
    return "0.1.0";
  }
}
