import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { eq } from "drizzle-orm";
import { testComposition } from "../cli/test-composition.ts";
import { testStoreComposition } from "../verification/test-stores.ts";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";
import {
  parseMcpServerConfigInput,
  resolveProjectFilePath,
} from "./control-helpers.ts";
import type {
  ChatEventHandler,
  InProgressDetail,
  InProgressState,
} from "./chat-contract.ts";
import {
  type BuildTargetExtras,
  type BuildTargetExtraTarget,
  type ChatRuntime,
  type ControlServer,
  isAllowedWebSocketRequest,
  resolveScreenshotArtifactPath,
  startControlServer,
} from "./control-server.ts";
import { dispatchTool } from "./tools/dispatch.ts";
import { DevServerManager } from "./dev-server.ts";
import { CommandRunner } from "./command-runner.ts";
import { createAppServer } from "./app-server.ts";
import { unloadProject } from "./project-loader.ts";
import { setGitCommitMessageModelCallForTest } from "./git-message.ts";
import { mountVerificationRoutes } from "../verification/verification-routes.ts";
import { type TestAccountProfile, TestAuthProvider } from "./test-auth.ts";
import { Database } from "./db.ts";
import {
  createProject,
  getProjectPaths,
  removeProject,
} from "./project-manager.ts";
import {
  DOCUMENT_UPLOAD_MAX_BYTES,
  DOCUMENT_WORKING_SET_MAX_TOKENS,
  getProviderModelPricingOverrides,
  setProviderModelPricing,
  setRecommendedModels,
} from "./config.ts";
import { setProviderModelPricingTableProvider } from "./usage.ts";
import { setUtilityModelCallForTest } from "./utility-model.ts";
import { __setPricingResearchForTests } from "./pricing-workflow.ts";
import {
  DOCUMENT_MAX_CONTENT_BYTES,
  EVIDENCE_DOCUMENT_SOURCE,
  PLAN_DOCUMENT_SOURCE,
} from "./documents.ts";
import { Kernel } from "./registries.ts";
import { checkChangesetReadiness } from "../verification/changesets.ts";
import {
  type BackupData,
  type BackupMetadata,
  listBackups,
  saveBackup,
} from "./backup.ts";
import { FakeModelProvider } from "./model-provider-fake.ts";
import { createRecoveryChatRuntime } from "./recovery-chat.ts";
import { BINARY_COMPILE_TARGETS, defaultBinaryCompileTarget } from "./build.ts";
import { genieChangesetsTable } from "./db/schema/index.ts";
import type { PersistedState } from "./persistence.ts";
import {
  type CodebaseGraph,
  createEmptyCodebaseGraph,
  edgeSemanticId,
  fileSemanticId,
  type ProjectCommand,
  semanticId,
} from "./codebase/types.ts";
import {
  IMPORT_CLASSIFIER_PLUGIN_ID,
  type ImportClassifierRequest,
  type ImportClassifierResult,
} from "./codebase/index.ts";
import type { ColumnDef, MigrationEntry, SchemaEntry } from "./types.ts";
import { isolateHome } from "./test-home_test.ts";

// Chat only initialises with a provider key; these tests use a fake chat.
isolateHome({ anthropicApiKey: "sk-ant-test-not-a-real-key" });

function gitAvailable(): boolean {
  try {
    return new Deno.Command("git", {
      args: ["--version"],
      stdout: "null",
      stderr: "null",
    }).outputSync().success;
  } catch {
    return false;
  }
}

function runGit(cwd: string, args: string[]): void {
  const result = new Deno.Command("git", {
    args,
    cwd,
    stdout: "null",
    stderr: "piped",
  }).outputSync();
  if (!result.success) {
    throw new Error(new TextDecoder().decode(result.stderr));
  }
}

const emptyDynamicSchemaColumns: ColumnDef[] = [];

function writeJsonFile(path: string, value: unknown): void {
  writeFileSync(path, JSON.stringify(value, null, 2) + "\n");
}

function compositionWithImportClassifier(
  runImportClassifier: (
    request: ImportClassifierRequest,
    opts?: Parameters<
      NonNullable<ReturnType<typeof testComposition>["agentTools"]>[
        "runImportClassifier"
      ]
    >[1],
  ) => Promise<ImportClassifierResult> | ImportClassifierResult,
): ReturnType<typeof testComposition> {
  const composition = testComposition();
  return {
    ...composition,
    agentTools: {
      ...composition.agentTools!,
      runImportClassifier: async (request, opts) =>
        await runImportClassifier(request, opts),
    },
  };
}

function seedModelCache(home: string, model: string, provider: string): void {
  const dir = join(home, ".config", "opentide");
  mkdirSync(dir, { recursive: true });
  writeJsonFile(join(dir, "models-cache.json"), {
    models: [{ id: model, label: model, provider }],
    cachedAt: new Date().toISOString(),
  });
}

function dynamicSchemaEntry(tableName: string, sql: string): SchemaEntry {
  return {
    tableName,
    columns: emptyDynamicSchemaColumns,
    sql,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function dynamicSchemaMigration(
  tableName: string,
  version: number,
  sql: string,
  appliedAt: string,
): MigrationEntry {
  return {
    id: version,
    tableName,
    version,
    sql,
    reverseSql: null,
    reversible: false,
    columnsBefore: emptyDynamicSchemaColumns,
    columnsAfter: emptyDynamicSchemaColumns,
    appliedAt,
    rolledBackAt: null,
    turnId: null,
  };
}

function writeDynamicSchemaRestoreFixture(projectDir: string): void {
  const paths = getProjectPaths(projectDir);
  const migrationsDir = join(paths.schemaDir, "migrations");
  mkdirSync(migrationsDir, { recursive: true });

  const documentsV1 =
    "CREATE TABLE documents (id SERIAL PRIMARY KEY, title TEXT NOT NULL)";
  const documentsV2 =
    "ALTER TABLE documents ADD COLUMN history_version_id INTEGER REFERENCES versions(id) ON DELETE SET NULL";
  const versionsV1 = `
    CREATE TABLE versions (
      id SERIAL PRIMARY KEY,
      document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
      label TEXT NOT NULL
    )
  `;
  const agentEventsV1 = `
    CREATE TABLE agent_events (
      id SERIAL PRIMARY KEY,
      document_id INTEGER REFERENCES documents(id) ON DELETE CASCADE,
      version_id INTEGER REFERENCES versions(id) ON DELETE SET NULL,
      event_type TEXT NOT NULL
    )
  `;

  writeJsonFile(
    join(paths.schemaDir, "documents.json"),
    dynamicSchemaEntry("documents", `${documentsV1};\n\n${documentsV2}`),
  );
  writeJsonFile(
    join(paths.schemaDir, "versions.json"),
    dynamicSchemaEntry("versions", versionsV1),
  );
  writeJsonFile(
    join(paths.schemaDir, "agent_events.json"),
    dynamicSchemaEntry("agent_events", agentEventsV1),
  );

  writeJsonFile(join(migrationsDir, "documents.json"), [
    dynamicSchemaMigration(
      "documents",
      1,
      documentsV1,
      "2026-01-01T00:00:00.000Z",
    ),
    dynamicSchemaMigration(
      "documents",
      2,
      documentsV2,
      "2026-01-01T00:00:03.000Z",
    ),
  ]);
  writeJsonFile(join(migrationsDir, "versions.json"), [
    dynamicSchemaMigration(
      "versions",
      1,
      versionsV1,
      "2026-01-01T00:00:01.000Z",
    ),
  ]);
  writeJsonFile(join(migrationsDir, "agent_events.json"), [
    dynamicSchemaMigration(
      "agent_events",
      1,
      agentEventsV1,
      "2026-01-01T00:00:02.000Z",
    ),
  ]);
}

class SessionRecordingChat implements ChatRuntime {
  readonly sentMessages: string[] = [];
  readonly sentSessionIds: Array<string | null> = [];
  readonly resumedSessionIds: string[] = [];
  readonly compactSummaries: string[] = [];
  clearContextCount = 0;
  clearCurrentSessionCount = 0;
  abortCount = 0;
  closeCount = 0;
  rejectSendOnAbort = false;
  sendMessageBlocker: Promise<void> | null = null;
  readonly events: string[] = [];
  private rejectAbortableSend: ((reason?: unknown) => void) | null = null;
  inProgressState: InProgressState | null = null;
  inProgressFullState: InProgressState | null = null;
  readonly sentDocumentRefs: Array<
    Array<{ id: string; versionHash?: string }> | undefined
  > = [];

  constructor(
    private readonly kernel: Kernel,
    private currentSessionId: string,
  ) {}

  setOnTurnComplete(_cb: () => void): void {}
  async initialize(): Promise<void> {}
  async reloadApiKey(): Promise<void> {}
  async reloadModel(): Promise<void> {}
  getInProgressState(
    detail: InProgressDetail = "compact",
  ): InProgressState | null {
    return detail === "full"
      ? this.inProgressFullState ?? this.inProgressState
      : this.inProgressState;
  }
  abort(): void {
    this.abortCount++;
    this.events.push("chat.abort");
    if (this.rejectSendOnAbort) {
      this.rejectAbortableSend?.(new Error("send rejected after abort"));
      this.rejectAbortableSend = null;
    }
  }
  async clearContext(): Promise<void> {
    this.clearContextCount++;
  }
  clearCurrentSession(): void {
    this.clearCurrentSessionCount++;
    this.currentSessionId = "";
  }
  getCurrentSessionId(): string | null {
    return this.currentSessionId || null;
  }
  async clearSession(): Promise<{ newSessionId: string }> {
    const session = await this.kernel.sessions.createSession();
    this.currentSessionId = session.id;
    return { newSessionId: session.id };
  }
  async compactSession(summary: string): Promise<{ sessionId: string }> {
    this.compactSummaries.push(summary);
    return { sessionId: this.currentSessionId };
  }
  async resumeSession(
    targetSessionId: string,
  ): Promise<{ newSessionId: string }> {
    await this.kernel.sessions.reopenSession(targetSessionId);
    this.currentSessionId = targetSessionId;
    this.resumedSessionIds.push(targetSessionId);
    return { newSessionId: targetSessionId };
  }
  async close(): Promise<void> {
    this.closeCount++;
    this.events.push("chat.close");
  }

  async sendMessage(
    content: string,
    onEvent?: ChatEventHandler,
    _attachments?: Array<{ name: string; type: string; data: string }>,
    _storedContent?: string,
    _changesetId?: string,
    _user?: unknown,
    documentRefs?: Array<{ id: string; versionHash?: string }>,
  ): Promise<string> {
    this.events.push("send.start");
    this.sentMessages.push(content);
    this.sentSessionIds.push(this.getCurrentSessionId());
    this.sentDocumentRefs.push(documentRefs);
    if (this.rejectSendOnAbort) {
      await new Promise<void>((_, reject) => {
        this.rejectAbortableSend = reject;
      });
    }
    if (this.sendMessageBlocker) await this.sendMessageBlocker;
    onEvent?.({ type: "message_complete" });
    this.events.push("send.complete");
    return "";
  }
}

function deferred<T = void>(): {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function accountSession(
  id: string,
  name = id,
): { profile: TestAccountProfile } {
  const accountId = id.startsWith("account_") || id.startsWith("acct_")
    ? id
    : `account_${id}`;
  return {
    profile: {
      accountId,
      displayName: name,
      email: `${id}@example.com`,
      avatarUrl: null,
    },
  };
}

function cookieFor(
  auth: TestAuthProvider,
  session: { profile: TestAccountProfile },
): string {
  return auth.sessionCookie(auth.createAccountSession(session));
}

function authHeaders(auth: TestAuthProvider, id = "owner"): HeadersInit {
  return { Cookie: cookieFor(auth, accountSession(id, id)) };
}

function jsonAuthHeaders(auth: TestAuthProvider, id = "owner"): HeadersInit {
  return {
    "Content-Type": "application/json",
    ...authHeaders(auth, id),
  };
}

Deno.test("resolveProjectFilePath decodes nested paths", () => {
  const root = "/tmp/genie-project";
  assertEquals(
    resolveProjectFilePath(root, encodeURIComponent("src/routes/page.ts")),
    {
      fullPath: "/tmp/genie-project/src/routes/page.ts",
      relativePath: "src/routes/page.ts",
    },
  );
});

Deno.test("resolveProjectFilePath blocks traversal after decode", () => {
  const root = "/tmp/genie-project";
  assertEquals(
    resolveProjectFilePath(root, encodeURIComponent("../secret.txt")),
    null,
  );
  assertEquals(resolveProjectFilePath(root, "%2e%2e%2fsecret.txt"), null);
});

Deno.test("isAllowedWebSocketRequest allows loopback host with no origin", () => {
  assertEquals(isAllowedWebSocketRequest(undefined, "localhost:3001"), true);
});

Deno.test("isAllowedWebSocketRequest allows dev UI cross-origin", () => {
  assertEquals(
    isAllowedWebSocketRequest("http://localhost:5173", "127.0.0.1:3001"),
    true,
  );
});

Deno.test("isAllowedWebSocketRequest allows loopback ip origin", () => {
  assertEquals(
    isAllowedWebSocketRequest("http://127.0.0.1:3001", "localhost:3001"),
    true,
  );
});

Deno.test("isAllowedWebSocketRequest allows tauri-style .localhost origin", () => {
  assertEquals(
    isAllowedWebSocketRequest("http://app.localhost", "localhost:3001"),
    true,
  );
});

Deno.test("isAllowedWebSocketRequest rejects foreign origin", () => {
  assertEquals(
    isAllowedWebSocketRequest("https://evil.com", "localhost:3001"),
    false,
  );
});

Deno.test("isAllowedWebSocketRequest rejects non-loopback host (DNS rebinding)", () => {
  assertEquals(isAllowedWebSocketRequest(undefined, "evil.com:3001"), false);
});

Deno.test("isAllowedWebSocketRequest rejects unparseable origin", () => {
  assertEquals(isAllowedWebSocketRequest("not a url", "localhost:3001"), false);
});

Deno.test("POST /api/language/ai-completions records inline_completion usage", async () => {
  const projectDir = await Deno.makeTempDir({
    dir: "/private/tmp",
    prefix: "tideide-inline-completion-",
  });
  const home = await Deno.makeTempDir({ prefix: "genie-inline-home-" });
  const oldHome = Deno.env.get("HOME");
  const oldAnthropic = Deno.env.get("ANTHROPIC_API_KEY");
  const oldOpenai = Deno.env.get("OPENAI_API_KEY");
  const db = await Database.create({ driver: "pglite" });
  const kernel = new Kernel(db);
  kernel.projectDir = projectDir;
  const restoreCall = setUtilityModelCallForTest((req) =>
    Promise.resolve({
      text: JSON.stringify(["return value;"]),
      provider: "openai",
      model: req.model,
      usage: {
        inputTokens: 14,
        outputTokens: 6,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
      },
    })
  );
  try {
    Deno.env.set("HOME", home);
    Deno.env.delete("ANTHROPIC_API_KEY");
    Deno.env.set("OPENAI_API_KEY", "sk-openai-test");
    seedModelCache(home, "gpt-5-mini", "openai");
    setRecommendedModels({ utility: "gpt-5-mini" });
    const control = await startControlServer(
      {
        entry: {
          path: projectDir,
          name: "inline-completion",
          createdAt: new Date().toISOString(),
          lastOpenedAt: new Date().toISOString(),
        },
        kernel,
        db,
        appServer: { shutdown: async () => {} } as never,
        devServer: { shutdown: async () => {} } as never,
        commandRunner: { shutdown: async () => {} } as never,
        rebuild: () => {},
      },
      0,
    );
    try {
      const base = `http://127.0.0.1:${control.server.addr.port}`;
      const res = await fetch(`${base}/api/language/ai-completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          entityType: "handler",
          entityName: "saveThing",
          content: "function saveThing() {\n  ",
          line: 2,
          column: 3,
          language: "typescript",
        }),
      });

      assertEquals(res.status, 200);
      assertEquals((await res.json()).suggestions, ["return value;"]);
      const usage = await kernel.sessions.getProjectUsage();
      assertEquals(usage.unpricedCalls, 1);
      assertEquals(usage.unpricedInputTokens, 14);
      assertEquals(usage.unpricedOutputTokens, 6);
    } finally {
      await control.server.shutdown();
    }
  } finally {
    restoreCall();
    await db.close();
    if (oldHome === undefined) Deno.env.delete("HOME");
    else Deno.env.set("HOME", oldHome);
    if (oldAnthropic === undefined) Deno.env.delete("ANTHROPIC_API_KEY");
    else Deno.env.set("ANTHROPIC_API_KEY", oldAnthropic);
    if (oldOpenai === undefined) Deno.env.delete("OPENAI_API_KEY");
    else Deno.env.set("OPENAI_API_KEY", oldOpenai);
    rmSync(projectDir, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

Deno.test("GET /api/config/models/pricing/status reports provider-aware pricing", async () => {
  const home = await Deno.makeTempDir({ prefix: "genie-pricing-status-api-" });
  const oldHome = Deno.env.get("HOME");
  try {
    Deno.env.set("HOME", home);
    setProviderModelPricingTableProvider(getProviderModelPricingOverrides);
    seedModelCache(home, "claude-sonnet-5", "anthropic");
    const dir = join(home, ".config", "opentide");
    writeJsonFile(join(dir, "models-cache.json"), {
      models: [
        {
          id: "claude-sonnet-5",
          label: "claude-sonnet-5",
          provider: "anthropic",
        },
        { id: "gpt-5", label: "gpt-5", provider: "openai" },
        { id: "gpt-5-mini", label: "gpt-5-mini", provider: "openai" },
      ],
      cachedAt: new Date().toISOString(),
    });
    setProviderModelPricing({
      provider: "openai",
      model: "gpt-5",
      input: 1,
      output: 8,
      unit: "MTok",
      currency: "USD",
      source: "manual",
      verifiedAt: "2026-09-10T00:00:00.000Z",
    });
    const control = await startControlServer(null, 0);
    try {
      const base = `http://127.0.0.1:${control.server.addr.port}`;
      const res = await fetch(`${base}/api/config/models/pricing/status`);
      assertEquals(res.status, 200);
      const body = await res.json();
      assertEquals(body.counts.priced, 2);
      assertEquals(body.counts.unpriced, 1);
      assertEquals(body.counts.byProvider.openai.priced, 1);
      assertEquals(body.counts.byProvider.openai.unpriced, 1);
      assertEquals(
        body.models.find((row: { model: string }) => row.model === "gpt-5")
          ?.source,
        "manual",
      );
      assertEquals(
        body.models.find((row: { model: string }) => row.model === "gpt-5-mini")
          ?.priced,
        false,
      );
    } finally {
      await control.server.shutdown();
    }
  } finally {
    setProviderModelPricingTableProvider(() => []);
    if (oldHome === undefined) Deno.env.delete("HOME");
    else Deno.env.set("HOME", oldHome);
    rmSync(home, { recursive: true, force: true });
  }
});

Deno.test("GET and PUT /api/config/models expose planning and import roles", async () => {
  const home = await Deno.makeTempDir({ prefix: "genie-model-roles-api-" });
  const oldHome = Deno.env.get("HOME");
  try {
    Deno.env.set("HOME", home);
    const control = await startControlServer(null, 0);
    try {
      const base = `http://127.0.0.1:${control.server.addr.port}`;
      const initial = await fetch(`${base}/api/config/models`);
      assertEquals(initial.status, 200);
      const initialBody = await initial.json();
      assertEquals(Object.keys(initialBody.roles), [
        "agent",
        "planning",
        "import",
        "utility",
        "verification",
      ]);
      assertEquals(Object.keys(initialBody.resolved), [
        "agent",
        "planning",
        "import",
        "utility",
        "verification",
      ]);
      assertEquals(initialBody.roles, {
        agent: "default",
        planning: "default",
        import: "default",
        utility: "default",
        verification: "default",
      });
      assertEquals(initialBody.resolved, {
        agent: "unconfigured",
        planning: "unconfigured",
        import: "unconfigured",
        utility: "unconfigured",
        verification: "unconfigured",
      });
      assertEquals(initialBody.agentModel, "default");
      assertEquals(initialBody.codeModel, "default");

      const save = await fetch(`${base}/api/config/models`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          planningModel: "claude-opus-5",
          importModel: "claude-sonnet-5",
          codeModel: "claude-haiku-legacy",
        }),
      });
      assertEquals(save.status, 200);
      assertEquals((await save.json()).roles, {
        agent: "default",
        planning: "claude-opus-5",
        import: "claude-sonnet-5",
        utility: "claude-haiku-legacy",
        verification: "default",
      });

      const saveUtilityWins = await fetch(`${base}/api/config/models`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          codeModel: "claude-haiku-legacy-2",
          utilityModel: "claude-haiku-explicit",
        }),
      });
      assertEquals(saveUtilityWins.status, 200);
      assertEquals(
        (await saveUtilityWins.json()).roles.utility,
        "claude-haiku-explicit",
      );

      const after = await fetch(`${base}/api/config/models`);
      assertEquals(after.status, 200);
      const afterBody = await after.json();
      assertEquals(afterBody.roles.planning, "claude-opus-5");
      assertEquals(afterBody.roles.import, "claude-sonnet-5");
      assertEquals(afterBody.roles.utility, "claude-haiku-explicit");
      assertEquals(afterBody.resolved.planning, "claude-opus-5");
      assertEquals(afterBody.resolved.import, "claude-sonnet-5");
      assertEquals(afterBody.codeModel, "claude-haiku-explicit");
    } finally {
      await control.server.shutdown();
    }
  } finally {
    if (oldHome === undefined) Deno.env.delete("HOME");
    else Deno.env.set("HOME", oldHome);
    rmSync(home, { recursive: true, force: true });
  }
});

Deno.test("POST /api/config/models/pricing/refresh defaults to report-only", async () => {
  const home = await Deno.makeTempDir({ prefix: "genie-pricing-refresh-api-" });
  const oldHome = Deno.env.get("HOME");
  const calls: Array<{ provider?: string; recordUsage: boolean }> = [];
  const restoreResearch = __setPricingResearchForTests((opts = {}) => {
    calls.push({
      provider: opts.provider,
      recordUsage: typeof opts.recordUsage === "function",
    });
    return Promise.resolve({
      ok: true,
      data: {
        candidates: [],
        attempts: [[{
          apiId: "gpt-5-mini",
          provider: "openai",
          model: "gpt-5-mini",
          input: 1,
          output: 8,
          currency: "USD",
          unit: "MTok",
          source: "https://example.test/pricing",
        }]],
        sourceUrl: "https://example.test/pricing",
        extractedAt: "2026-09-11T00:00:00.000Z",
        model: "gpt-5-mini",
        costUsd: 0,
        pricingStatus: "unpriced",
        unmapped: [],
      },
    });
  });
  try {
    Deno.env.set("HOME", home);
    seedModelCache(home, "gpt-5-mini", "openai");
    const control = await startControlServer(null, 0);
    try {
      const base = `http://127.0.0.1:${control.server.addr.port}`;
      const res = await fetch(`${base}/api/config/models/pricing/refresh`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ provider: "openai" }),
      });
      assertEquals(res.status, 200);
      const body = await res.json();
      assertEquals(body.apply, false);
      assertEquals(body.applied, false);
      assertEquals(body.written, []);
      assertEquals(body.rejected.length, 1);
      assertEquals(calls, [{ provider: "openai", recordUsage: false }]);
    } finally {
      await control.server.shutdown();
    }
  } finally {
    restoreResearch();
    if (oldHome === undefined) Deno.env.delete("HOME");
    else Deno.env.set("HOME", oldHome);
    rmSync(home, { recursive: true, force: true });
  }
});

Deno.test("POST /api/config/models/pricing/refresh records pricing usage when project ledger is available", async () => {
  const projectDir = await Deno.makeTempDir({
    dir: "/private/tmp",
    prefix: "genie-pricing-refresh-project-",
  });
  const home = await Deno.makeTempDir({
    prefix: "genie-pricing-refresh-home-",
  });
  const oldHome = Deno.env.get("HOME");
  const db = await Database.create({ driver: "pglite" });
  const kernel = new Kernel(db);
  kernel.projectDir = projectDir;
  const restoreResearch = __setPricingResearchForTests(async (opts = {}) => {
    await opts.recordUsage?.({
      provider: "openai",
      model: "gpt-5-mini",
      role: "pricing",
      caller: "pricing_research",
      startedAt: new Date("2026-09-11T00:00:00.000Z"),
      endedAt: new Date("2026-09-11T00:00:01.000Z"),
      usage: {
        inputTokens: 10,
        outputTokens: 5,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
      },
      metadata: { sourceUrl: "https://example.test/pricing" },
    });
    return {
      ok: true,
      data: {
        candidates: [],
        attempts: [],
        sourceUrl: "https://example.test/pricing",
        extractedAt: "2026-09-11T00:00:01.000Z",
        model: "gpt-5-mini",
        costUsd: 0,
        pricingStatus: "unpriced",
        unmapped: [],
      },
    };
  });
  try {
    Deno.env.set("HOME", home);
    seedModelCache(home, "gpt-5-mini", "openai");
    const control = await startControlServer(
      {
        entry: {
          path: projectDir,
          name: "pricing-refresh",
          createdAt: new Date().toISOString(),
          lastOpenedAt: new Date().toISOString(),
        },
        kernel,
        db,
        appServer: { shutdown: async () => {} } as never,
        devServer: { shutdown: async () => {} } as never,
        commandRunner: { shutdown: async () => {} } as never,
        rebuild: () => {},
      },
      0,
    );
    try {
      const base = `http://127.0.0.1:${control.server.addr.port}`;
      const res = await fetch(`${base}/api/config/models/pricing/refresh`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ provider: "openai" }),
      });
      assertEquals(res.status, 200);
      const usage = await kernel.sessions.getProjectUsage();
      assertEquals(usage.unpricedCalls, 1);
      assertEquals(usage.unpricedInputTokens, 10);
      assertEquals(usage.unpricedOutputTokens, 5);
      const pricingLog = kernel.log.recent(10).find((entry) =>
        entry.source === "system" && entry.message.includes("Pricing check")
      );
      assert(pricingLog);
      assertEquals(pricingLog.level, "warn");
      assertEquals(pricingLog.metadata?.pricing, true);
      assertEquals(
        (pricingLog.metadata?.counts as { missing?: number } | undefined)
          ?.missing,
        1,
      );
      assertEquals(
        (pricingLog.metadata?.missing as Array<{ model: string }> | undefined)
          ?.[0]?.model,
        "gpt-5-mini",
      );
    } finally {
      await control.server.shutdown();
    }
  } finally {
    restoreResearch();
    await db.close();
    if (oldHome === undefined) Deno.env.delete("HOME");
    else Deno.env.set("HOME", oldHome);
    rmSync(projectDir, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

Deno.test({
  sanitizeResources: false,
  sanitizeOps: false,
  name:
    "changeset detail enriches legacy token usage with cache fields from model usage",
  fn: async () => {
    const db = await Database.create({ driver: "pglite" });
    const kernel = new Kernel(db, { composition: testStoreComposition() });
    const cs = await kernel.changesets.create({
      title: "Legacy usage",
      plan: {
        summary: "Explain old usage snapshots.",
        steps: [{ id: "step_0", description: "Do work", status: "pending" }],
        acceptanceCriteria: [{
          id: "claim_usage",
          text: "The detail endpoint reports cache usage.",
          source: "agent",
          priority: "must",
        }],
        verificationPlan: [{
          id: "check_usage",
          claimIds: ["claim_usage"],
          kind: "integration",
          description: "Fetch the changeset detail endpoint.",
        }],
      },
    });
    await kernel.sessions.recordModelUsage({
      id: "mu_changeset_cache",
      sessionId: null,
      turnId: null,
      changesetId: cs.id,
      provider: "anthropic",
      model: "claude-haiku-4-5-20251001",
      role: "verification",
      caller: "refute_claims",
      startedAt: "2026-01-01T00:00:00.000Z",
      endedAt: "2026-01-01T00:00:01.000Z",
      usage: {
        inputTokens: 10,
        cacheCreationInputTokens: 20,
        cacheReadInputTokens: 300,
        outputTokens: 5,
      },
    });
    const legacyUsage = {
      inputTokens: 10,
      outputTokens: 5,
      costUsd: 0.001,
      pricingStatus: "priced" as const,
      unpricedCalls: 0,
      unpricedInputTokens: 0,
      unpricedOutputTokens: 0,
      durationMs: 1000,
    };
    await db.drizzle
      .update(genieChangesetsTable)
      .set({ tokenUsage: legacyUsage })
      .where(eq(genieChangesetsTable.id, cs.id));

    const now = new Date().toISOString();
    const control = await startControlServer(
      {
        entry: {
          path: "/tmp/genie-control-server-legacy-usage-test",
          name: "control-server-legacy-usage-test",
          createdAt: now,
          lastOpenedAt: now,
        },
        kernel,
        db,
        appServer: { shutdown: async () => {} } as never,
        devServer: { shutdown: async () => {} } as never,
        commandRunner: { shutdown: async () => {} } as never,
        rebuild: () => {},
      },
      0,
    );

    try {
      const port = control.server.addr.port;
      const res = await fetch(
        `http://127.0.0.1:${port}/api/changesets/${cs.id}`,
      );
      const body = await res.json();

      assertEquals(res.status, 200);
      assertEquals(body.tokenUsage.cacheCreationInputTokens, 20);
      assertEquals(body.tokenUsage.cacheReadInputTokens, 300);
      const stored = await kernel.changesets.get(cs.id);
      assertEquals(stored?.tokenUsage, legacyUsage);
    } finally {
      await control.server.shutdown();
      await db.close();
    }
  },
});

Deno.test({
  sanitizeResources: false,
  sanitizeOps: false,
  name:
    "project usage endpoint excludes history inherited before project creation",
  fn: async () => {
    const db = await Database.create({ driver: "pglite" });
    const kernel = new Kernel(db, { composition: testStoreComposition() });
    const projectDir = await Deno.makeTempDir({
      dir: "/private/tmp",
      prefix: "genie-usage-created-at-",
    });
    const createdAt = "2026-09-05T16:25:15.663Z";
    const session = await kernel.sessions.createSession("Usage");
    await kernel.sessions.recordTurnUsage({
      turnId: "inherited",
      sessionId: session.id,
      model: "claude-opus-4-8",
      startedAt: "2026-08-08T12:21:20.894Z",
      endedAt: "2026-08-08T12:21:21.894Z",
      durationMs: 1000,
      inputTokens: 1_000_000,
      outputTokens: 1,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      toolCallsCount: 0,
      costUsd: 99,
    });
    await kernel.sessions.recordTurnUsage({
      turnId: "current",
      sessionId: session.id,
      model: "claude-opus-4-8",
      startedAt: "2026-09-05T17:00:00.000Z",
      endedAt: "2026-09-05T17:00:01.000Z",
      durationMs: 1000,
      inputTokens: 10,
      outputTokens: 20,
      cacheCreationInputTokens: 30,
      cacheReadInputTokens: 40,
      toolCallsCount: 2,
      costUsd: 0.12,
    });

    const control = await startControlServer(
      {
        entry: {
          path: projectDir,
          name: "usage-created-at",
          createdAt,
          lastOpenedAt: createdAt,
        },
        kernel,
        db,
        appServer: { shutdown: async () => {} } as never,
        devServer: { shutdown: async () => {} } as never,
        commandRunner: { shutdown: async () => {} } as never,
        rebuild: () => {},
      },
      0,
    );

    try {
      const base = `http://127.0.0.1:${control.server.addr.port}`;
      const res = await fetch(`${base}/api/usage`);
      assertEquals(res.status, 200);
      const usage = await res.json();
      assertEquals(usage.turns, 1);
      assertEquals(usage.totalInputTokens, 10);
      assertEquals(usage.totalOutputTokens, 20);
      assertEquals(usage.totalCostUsd, 0.12);
    } finally {
      await control.server.shutdown();
      await db.close();
      rmSync(projectDir, { recursive: true, force: true });
    }
  },
});

Deno.test({
  sanitizeResources: false,
  sanitizeOps: false,
  name: "GET /api/codebase serves the assisted classification merged graph",
  fn: async () => {
    const projectDir = await Deno.makeTempDir({
      dir: "/private/tmp",
      prefix: "genie-control-codebase-assist-",
    });
    const paths = getProjectPaths(projectDir);
    const now = new Date().toISOString();
    mkdirSync(join(projectDir, ".opentide"), { recursive: true });
    writeFileSync(
      paths.manifest,
      JSON.stringify({ name: "codebase-assist", createdAt: now }, null, 2),
    );
    mkdirSync(join(projectDir, "src"), { recursive: true });
    writeFileSync(
      join(projectDir, "package.json"),
      JSON.stringify({ scripts: { test: "vitest" } }),
    );
    writeFileSync(join(projectDir, "src", "index.ts"), "export const x = 1;");

    const db = await Database.create({ driver: "pglite" });
    const kernel = new Kernel(db, {
      historyDir: paths.historyDir,
      composition: compositionWithImportClassifier(() => ({
        status: "completed",
        model: "claude-import-test",
        facts: [{
          kind: "import-strategy",
          name: "api served overlay",
          value: { mode: "source-backed-overlay" },
          confidence: 0.91,
        }],
        mappings: [],
        diagnostics: [],
        candidateEntities: [],
      })),
    });
    kernel.projectDir = projectDir;

    const auth = new TestAuthProvider();
    const control = await startControlServer(
      {
        entry: {
          path: projectDir,
          name: "codebase-assist",
          createdAt: now,
          lastOpenedAt: now,
        },
        kernel,
        db,
        appServer: { shutdown: async () => {} } as never,
        devServer: { shutdown: async () => {} } as never,
        commandRunner: { shutdown: async () => {} } as never,
        rebuild: () => {},
      },
      0,
      { authProvider: auth, mountRoutes: [mountVerificationRoutes] },
    );

    try {
      const base = `http://127.0.0.1:${control.server.addr.port}`;
      const run = await dispatchTool(
        "index_codebase",
        { classification: "assist" },
        kernel,
        () => {},
      );
      assertEquals(run.ok, true);
      assertEquals(
        (run.data as { classification: { status: string } }).classification
          .status,
        "completed",
      );

      const served = await (await fetch(`${base}/api/codebase`, {
        headers: authHeaders(auth),
      })).json();
      assert(served.graph !== null);
      assertEquals(
        served.graph.facts.some((fact: {
          name: string;
          source: { pluginId: string; method: string };
        }) =>
          fact.name === "api served overlay" &&
          fact.source.pluginId === IMPORT_CLASSIFIER_PLUGIN_ID &&
          fact.source.method === "agent"
        ),
        true,
      );
    } finally {
      await control.server.shutdown();
      await db.close();
      rmSync(projectDir, { recursive: true, force: true });
    }
  },
});

Deno.test({
  sanitizeResources: false,
  sanitizeOps: false,
  name: "chat shell endpoint rejects cross-origin local requests",
  fn: async () => {
    const db = await Database.create({ driver: "pglite" });
    const kernel = new Kernel(db, { composition: testStoreComposition() });
    const session = await kernel.sessions.createSession("Shell");
    const fakeChat = new SessionRecordingChat(kernel, session.id);
    const projectDir = await Deno.makeTempDir({
      prefix: "genie-shell-origin-",
    });
    const now = new Date().toISOString();
    const auth = new TestAuthProvider();
    const cookie = cookieFor(auth, accountSession("owner", "Owner"));
    const control = await startControlServer(
      {
        entry: {
          path: projectDir,
          name: "shell-origin",
          createdAt: now,
          lastOpenedAt: now,
        },
        kernel,
        db,
        appServer: { shutdown: async () => {} } as never,
        devServer: { shutdown: async () => {} } as never,
        commandRunner: { shutdown: async () => {} } as never,
        rebuild: () => {},
      },
      0,
      {
        authProvider: auth,
        chatFactory: () => fakeChat,
      },
    );

    try {
      const base = `http://127.0.0.1:${control.server.addr.port}`;
      const res = await fetch(`${base}/api/chat/shell`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: cookie,
          Origin: "https://evil.example",
        },
        body: JSON.stringify({ command: "echo hacked > csrf.txt" }),
      });

      assertEquals(res.status, 403);
      assertEquals(existsSync(join(projectDir, "csrf.txt")), false);
    } finally {
      await control.server.shutdown();
      await db.close();
      rmSync(projectDir, { recursive: true, force: true });
    }
  },
});

Deno.test("control server serves static UI fallback without intercepting API", async () => {
  const uiDir = await Deno.makeTempDir({
    prefix: "genie-static-ui-",
  });
  mkdirSync(join(uiDir, "_app", "immutable"), { recursive: true });
  writeFileSync(join(uiDir, "index.html"), "<!doctype html><h1>Tide</h1>");
  writeFileSync(
    join(uiDir, "_app", "immutable", "entry.js"),
    "console.log('tide');",
  );

  const auth = new TestAuthProvider();
  const control = await startControlServer(null, 0, {
    staticUiDir: uiDir,
    authProvider: auth,
  });
  try {
    const base = `http://127.0.0.1:${control.server.addr.port}`;
    const page = await fetch(`${base}/projects`);
    const asset = await fetch(`${base}/_app/immutable/entry.js`);
    const apiMiss = await fetch(`${base}/api/does-not-exist`, {
      headers: authHeaders(auth),
    });

    assertEquals(page.status, 200);
    assertStringIncludes(await page.text(), "<h1>Tide</h1>");
    assertEquals(
      asset.headers.get("content-type"),
      "text/javascript; charset=utf-8",
    );
    assertEquals(
      asset.headers.get("cache-control"),
      "public, max-age=31536000, immutable",
    );
    assertEquals(apiMiss.status, 404);
  } finally {
    await control.server.shutdown();
    rmSync(uiDir, { recursive: true, force: true });
  }
});

Deno.test("projects close: launcher mode returns a clear error", async () => {
  const control = await startControlServer(null, 0);
  try {
    const base = `http://127.0.0.1:${control.server.addr.port}`;
    const res = await fetch(`${base}/api/projects/close`, { method: "POST" });
    assertEquals(res.status, 400);
    assertEquals((await res.json()).error, "No project is open");
    assertEquals(control.setProject.current(), null);
  } finally {
    await control.server.shutdown();
  }
});

async function withProjectManagementServer(
  currentProjectPath: string | null,
  fn: (base: string) => Promise<void>,
): Promise<void> {
  if (!currentProjectPath) {
    const control = await startControlServer(null, 0);
    try {
      await fn(`http://127.0.0.1:${control.server.addr.port}`);
    } finally {
      await control.server.shutdown();
    }
    return;
  }

  const db = await Database.create({ driver: "pglite" });
  const kernel = new Kernel(db, { composition: testStoreComposition() });
  const now = new Date().toISOString();
  const control = await startControlServer(
    {
      entry: {
        path: currentProjectPath,
        name: "current-project",
        createdAt: now,
        lastOpenedAt: now,
      },
      kernel,
      db,
      appServer: { shutdown: async () => {} } as never,
      devServer: { shutdown: async () => {} } as never,
      commandRunner: { shutdown: async () => {} } as never,
      rebuild: () => {},
    },
    0,
  );
  try {
    await fn(`http://127.0.0.1:${control.server.addr.port}`);
  } finally {
    if (control.setProject.current()) {
      await unloadProject(control.setProject.current()!);
    }
    await control.server.shutdown();
  }
}

function jsonPost(body: unknown): RequestInit {
  return {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  };
}

function emptyPersistedState(): PersistedState {
  return {
    version: 1,
    routes: [],
    handlers: [],
    functions: [],
    configs: [],
    templates: [],
    assets: [],
    packages: [],
    devViews: [],
    devTools: [],
    tests: [],
    customAudits: [],
    types: [],
    branches: [],
  };
}

function backupFixture(
  id: string,
  createdAt: string,
  rows: Array<{ id: number; name: string }>,
): BackupData {
  const metadata: BackupMetadata = {
    id,
    createdAt,
    trigger: "manual",
    tableCount: 1,
    rowCount: rows.length,
    branchSnapshotCount: 0,
    includesProjectState: true,
  };
  return {
    metadata,
    kernelState: emptyPersistedState(),
    tables: [
      {
        tableName: "widgets",
        sql:
          "CREATE TABLE widgets (id INTEGER PRIMARY KEY, name TEXT NOT NULL)",
        rows,
      },
    ],
  };
}

function brokenBackupFixture(id: string): BackupData {
  return {
    metadata: {
      id,
      createdAt: "2026-01-03T00:00:00.000Z",
      trigger: "manual",
      tableCount: 1,
      rowCount: 0,
      branchSnapshotCount: 0,
      includesProjectState: true,
    },
    kernelState: emptyPersistedState(),
    tables: [
      {
        tableName: "bad_table",
        sql: "CREATE INDEX bad_table_idx ON missing_table (id)",
        rows: [],
      },
    ],
  };
}

function cumulativeSchemaBackupFixture(id: string): BackupData {
  const documentsV1 =
    "CREATE TABLE documents (id INTEGER PRIMARY KEY, title TEXT NOT NULL, active_skill_ids TEXT DEFAULT '')";
  const documentsAddSource = "ALTER TABLE documents ADD COLUMN source_url TEXT";
  const documentsAddHistory =
    "ALTER TABLE documents ADD COLUMN history_version_id INTEGER REFERENCES versions(id) ON DELETE SET NULL";
  const documentsDropHistory =
    "ALTER TABLE documents DROP COLUMN history_version_id";
  const documentsDropLegacy =
    "ALTER TABLE documents DROP COLUMN active_skill_ids";
  const blocksV1 =
    "CREATE TABLE blocks (id INTEGER PRIMARY KEY, document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE, content TEXT NOT NULL)";
  return {
    metadata: {
      id,
      createdAt: "2026-01-04T00:00:00.000Z",
      trigger: "periodic",
      tableCount: 2,
      rowCount: 3,
      branchSnapshotCount: 0,
      includesProjectState: true,
    },
    kernelState: emptyPersistedState(),
    tables: [
      {
        tableName: "blocks",
        sql: blocksV1,
        rows: [
          { id: 1, document_id: 1, content: "first" },
          { id: 2, document_id: 1, content: "second" },
        ],
      },
      {
        tableName: "documents",
        sql: [
          documentsV1,
          documentsAddSource,
          documentsAddHistory,
          documentsDropHistory,
          documentsDropLegacy,
        ].join(";\n\n"),
        rows: [{ id: 1, title: "Plan", source_url: "https://example.com" }],
      },
    ],
  };
}

async function withResetDbProject(
  name: string,
  fn: (
    base: string,
    projectPath: string,
    control: ControlServer,
  ) => Promise<void>,
): Promise<void> {
  const prevHome = Deno.env.get("HOME");
  const home = await Deno.makeTempDir({
    dir: "/private/tmp",
    prefix: "genie-reset-db-home-",
  });
  const baseDir = await Deno.makeTempDir({
    dir: "/private/tmp",
    prefix: "genie-reset-db-project-",
  });
  let projectPath = "";
  let control: ControlServer | null = null;
  try {
    Deno.env.set("HOME", home);
    const project = createProject(baseDir, name);
    projectPath = project.path;
    control = await startControlServer(null, 0, {
      projectAppPort: 0,
      composition: testStoreComposition(),
    });
    await fn(
      `http://127.0.0.1:${control.server.addr.port}`,
      projectPath,
      control,
    );
  } finally {
    if (control?.setProject.current()) {
      await unloadProject(control.setProject.current()!);
    }
    await control?.server.shutdown();
    if (projectPath) removeProject(projectPath);
    rmSync(baseDir, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
    if (prevHome === undefined) Deno.env.delete("HOME");
    else Deno.env.set("HOME", prevHome);
  }
}

Deno.test({
  sanitizeResources: false,
  sanitizeOps: false,
  name: "projects reset-db restores latest backup when backupId is omitted",
  fn: async () => {
    await withResetDbProject(
      "Latest Backup Restore App",
      async (base, path, control) => {
        const paths = getProjectPaths(path);
        saveBackup(
          backupFixture("backup_old", "2026-01-01T00:00:00.000Z", [
            { id: 1, name: "old" },
          ]),
          paths.backups,
          10,
        );
        saveBackup(
          backupFixture("backup_new", "2026-01-02T00:00:00.000Z", [
            { id: 2, name: "new" },
            { id: 3, name: "latest" },
          ]),
          paths.backups,
          10,
        );

        const res = await fetch(
          `${base}/api/projects/reset-db`,
          jsonPost({ path }),
        );
        assertEquals(res.status, 200);
        const body = await res.json();
        assertEquals(body.restoredFrom, "backup_new");
        assertEquals(body.restoredTableCount, 1);
        assertEquals(body.restoredRowCount, 2);

        const rows = await control.setProject.current()!.db.query(
          "SELECT name FROM widgets ORDER BY id",
        );
        assertEquals(rows.map((row) => row.name), ["new", "latest"]);
      },
    );
  },
});

Deno.test({
  sanitizeResources: false,
  sanitizeOps: false,
  name: "projects reset-db can explicitly reset empty even when backups exist",
  fn: async () => {
    await withResetDbProject(
      "Explicit Empty Reset App",
      async (base, path) => {
        const paths = getProjectPaths(path);
        saveBackup(
          backupFixture("backup_new", "2026-01-02T00:00:00.000Z", [
            { id: 2, name: "new" },
          ]),
          paths.backups,
          10,
        );

        const res = await fetch(
          `${base}/api/projects/reset-db`,
          jsonPost({ path, empty: true }),
        );
        assertEquals(res.status, 200);
        const body = await res.json();
        assertEquals(body.restoredFrom, null);
        assertEquals(body.restoredTableCount, 0);
        assertEquals(body.restoredRowCount, 0);
      },
    );
  },
});

Deno.test({
  sanitizeResources: false,
  sanitizeOps: false,
  name: "projects open reports dynamic schema replay failures as recoverable",
  fn: async () => {
    await withResetDbProject(
      "Recoverable Dynamic Schema Open App",
      async (base, path, control) => {
        const paths = getProjectPaths(path);
        const documentsV1 =
          "CREATE TABLE documents (id INTEGER PRIMARY KEY, title TEXT NOT NULL)";
        const documentsV2 =
          "ALTER TABLE documents ADD COLUMN history_version_id INTEGER REFERENCES versions(id) ON DELETE SET NULL";
        mkdirSync(join(paths.schemaDir, "migrations"), { recursive: true });
        writeJsonFile(
          join(paths.schemaDir, "documents.json"),
          dynamicSchemaEntry("documents", `${documentsV1};\n\n${documentsV2}`),
        );
        writeJsonFile(join(paths.schemaDir, "migrations", "documents.json"), [
          dynamicSchemaMigration(
            "documents",
            1,
            documentsV1,
            "2026-01-01T00:00:00.000Z",
          ),
          dynamicSchemaMigration(
            "documents",
            7,
            documentsV2,
            "2026-01-01T00:00:01.000Z",
          ),
        ]);

        const res = await fetch(
          `${base}/api/projects/open`,
          jsonPost({ path }),
        );
        assertEquals(res.status, 500);
        const body = await res.json();
        assertEquals(body.code, "DB_CORRUPT");
        assertStringIncludes(body.error, "Dynamic schema restore failed");
        assertStringIncludes(body.error, 'relation "versions" does not exist');
        assertEquals(control.setProject.current(), null);
      },
    );
  },
});

Deno.test({
  sanitizeResources: false,
  sanitizeOps: false,
  name: "projects reset-db restores selected backup when backupId is provided",
  fn: async () => {
    await withResetDbProject(
      "Selected Backup Restore App",
      async (base, path, control) => {
        const paths = getProjectPaths(path);
        saveBackup(
          backupFixture("backup_old", "2026-01-01T00:00:00.000Z", [
            { id: 1, name: "old" },
          ]),
          paths.backups,
          10,
        );
        saveBackup(
          backupFixture("backup_new", "2026-01-02T00:00:00.000Z", [
            { id: 2, name: "new" },
          ]),
          paths.backups,
          10,
        );

        const res = await fetch(
          `${base}/api/projects/reset-db`,
          jsonPost({ path, backupId: "backup_old" }),
        );
        assertEquals(res.status, 200);
        const body = await res.json();
        assertEquals(body.restoredFrom, "backup_old");
        assertEquals(body.restoredTableCount, 1);
        assertEquals(body.restoredRowCount, 1);

        const rows = await control.setProject.current()!.db.query(
          "SELECT name FROM widgets ORDER BY id",
        );
        assertEquals(rows.map((row) => row.name), ["old"]);
      },
    );
  },
});

Deno.test({
  sanitizeResources: false,
  sanitizeOps: false,
  name:
    "recovery chat works without an open project while normal chat remains project-gated",
  fn: async () => {
    const projectDir = await Deno.makeTempDir({
      dir: "/private/tmp",
      prefix: "genie-recovery-ws-",
    });
    writeFileSync(
      join(projectDir, "opentide.json"),
      JSON.stringify({ name: "Recovery Socket" }),
    );
    const provider = new FakeModelProvider([[
      { type: "text_delta", text: "Try repair first." },
      { type: "message_complete", stopReason: "end_turn" },
    ]]);
    const control = await startControlServer(null, 0, {
      recoveryChatFactory: () => createRecoveryChatRuntime(provider),
    });
    const port = control.server.addr.port;
    let recoveryWs: WebSocket | null = null;
    let normalWs: WebSocket | null = null;
    try {
      const recoveryEvents: Array<Record<string, unknown>> = [];
      recoveryWs = new WebSocket(
        `ws://127.0.0.1:${port}/api/projects/recovery/chat`,
      );
      recoveryWs.onmessage = (event) => {
        recoveryEvents.push(JSON.parse(String(event.data)));
      };
      await waitForSocketOpen(recoveryWs);
      recoveryWs.send(JSON.stringify({
        projectPath: projectDir,
        text: "what should I do?",
      }));
      await waitFor(() =>
        recoveryEvents.some((event) => event.type === "message_complete")
      );
      assertEquals(
        recoveryEvents.some((event) =>
          event.type === "text_delta" && event.text === "Try repair first."
        ),
        true,
      );
      assertEquals(provider.requests.length, 1);
      assertEquals(
        provider.requests[0]?.tools[0]?.name,
        "inspect_project_manifest",
      );

      const normalEvents: Array<Record<string, unknown>> = [];
      normalWs = new WebSocket(`ws://127.0.0.1:${port}/chat`);
      normalWs.onmessage = (event) => {
        normalEvents.push(JSON.parse(String(event.data)));
      };
      await waitForSocketOpen(normalWs);
      normalWs.send(JSON.stringify({
        type: "user_message",
        content: "hello",
      }));
      await waitFor(() => normalEvents.some((event) => event.type === "error"));
      assertEquals(normalEvents[0]?.text, "No project open");
    } finally {
      recoveryWs?.close();
      normalWs?.close();
      await control.server.shutdown();
      rmSync(projectDir, { recursive: true, force: true });
    }
  },
});

Deno.test({
  sanitizeResources: false,
  sanitizeOps: false,
  name: "projects reset-db returns 404 for unknown backupId",
  fn: async () => {
    await withResetDbProject(
      "Missing Backup Restore App",
      async (base, path, control) => {
        const res = await fetch(
          `${base}/api/projects/reset-db`,
          jsonPost({ path, backupId: "backup_missing" }),
        );
        assertEquals(res.status, 404);
        assertEquals(await res.json(), { error: "Backup not found" });
        assertEquals(control.setProject.current(), null);
      },
    );
  },
});

Deno.test({
  sanitizeResources: false,
  sanitizeOps: false,
  name:
    "projects reset-db returns structured error and does not back up partial restore",
  fn: async () => {
    await withResetDbProject(
      "Broken Backup Restore App",
      async (base, path, control) => {
        const paths = getProjectPaths(path);
        saveBackup(brokenBackupFixture("backup_broken"), paths.backups, 10);

        const res = await fetch(
          `${base}/api/projects/reset-db`,
          jsonPost({ path, backupId: "backup_broken" }),
        );
        assertEquals(res.status, 500);
        const body = await res.json();
        assertEquals(body.code, "BACKUP_RESTORE_FAILED");
        assertEquals(body.restoredFrom, "backup_broken");
        assertEquals(body.restoredTableCount, 0);
        assertEquals(body.restoredRowCount, 0);
        assertStringIncludes(body.error, "Backup restore failed");
        assertStringIncludes(
          body.errors[0],
          "SQL must be a CREATE TABLE statement",
        );

        const partialCtx = control.setProject.current();
        if (partialCtx) await unloadProject(partialCtx);
        const backups = listBackups(paths.backups);
        assertEquals(backups.map((backup) => backup.id), ["backup_broken"]);
      },
    );
  },
});

Deno.test({
  sanitizeResources: false,
  sanitizeOps: false,
  name:
    "projects reset-db ignores stale dynamic schema metadata and restores cumulative backup schema",
  fn: async () => {
    await withResetDbProject(
      "Cumulative Backup Restore App",
      async (base, path, control) => {
        const paths = getProjectPaths(path);
        const documentsV1 =
          "CREATE TABLE documents (id INTEGER PRIMARY KEY, title TEXT NOT NULL)";
        const documentsV2 =
          "ALTER TABLE documents ADD COLUMN history_version_id INTEGER REFERENCES versions(id) ON DELETE SET NULL";
        mkdirSync(join(paths.schemaDir, "migrations"), { recursive: true });
        writeJsonFile(
          join(paths.schemaDir, "documents.json"),
          dynamicSchemaEntry("documents", `${documentsV1};\n\n${documentsV2}`),
        );
        writeJsonFile(join(paths.schemaDir, "migrations", "documents.json"), [
          dynamicSchemaMigration(
            "documents",
            1,
            documentsV1,
            "2026-01-01T00:00:00.000Z",
          ),
          dynamicSchemaMigration(
            "documents",
            2,
            documentsV2,
            "2026-01-01T00:00:01.000Z",
          ),
        ]);
        saveBackup(
          cumulativeSchemaBackupFixture("backup_cumulative"),
          paths.backups,
          10,
        );

        const res = await fetch(
          `${base}/api/projects/reset-db`,
          jsonPost({ path, backupId: "backup_cumulative" }),
        );
        const text = await res.text();
        assertEquals(res.status, 200, text);
        const body = JSON.parse(text);
        assertEquals(body.restoredFrom, "backup_cumulative");
        assertEquals(body.restoredTableCount, 2);
        assertEquals(body.restoredRowCount, 3);

        const rows = await control.setProject.current()!.db.query(
          "SELECT d.title, b.content FROM documents d JOIN blocks b ON b.document_id = d.id ORDER BY b.id",
        );
        assertEquals(rows, [
          { title: "Plan", content: "first" },
          { title: "Plan", content: "second" },
        ]);
      },
    );
  },
});

Deno.test({
  sanitizeResources: false,
  sanitizeOps: false,
  name: "projects duplicate: current project returns 409",
  fn: async () => {
    const baseDir = await Deno.makeTempDir({
      dir: "/private/tmp",
      prefix: "genie-project-duplicate-current-",
    });
    const current = createProject(baseDir, "Current Duplicate App");
    try {
      await withProjectManagementServer(current.path, async (base) => {
        const res = await fetch(
          `${base}/api/projects/duplicate`,
          jsonPost({
            path: current.path,
          }),
        );
        assertEquals(res.status, 409);
        assertStringIncludes(
          (await res.json()).error,
          "Close the current project",
        );
      });
    } finally {
      removeProject(current.path);
      rmSync(baseDir, { recursive: true, force: true });
    }
  },
});

Deno.test({
  sanitizeResources: false,
  sanitizeOps: false,
  name: "projects rename: current project returns 409",
  fn: async () => {
    const baseDir = await Deno.makeTempDir({
      dir: "/private/tmp",
      prefix: "genie-project-rename-current-",
    });
    const current = createProject(baseDir, "Current Rename App");
    try {
      await withProjectManagementServer(current.path, async (base) => {
        const res = await fetch(
          `${base}/api/projects/rename`,
          jsonPost({
            path: current.path,
            name: "Renamed Current",
            folderName: "renamed-current",
          }),
        );
        assertEquals(res.status, 409);
        assertStringIncludes(
          (await res.json()).error,
          "Close the current project",
        );
      });
    } finally {
      removeProject(current.path);
      rmSync(baseDir, { recursive: true, force: true });
    }
  },
});

Deno.test({
  sanitizeResources: false,
  sanitizeOps: false,
  name: "projects duplicate: non-current project returns 201 and path/name",
  fn: async () => {
    const baseDir = await Deno.makeTempDir({
      dir: "/private/tmp",
      prefix: "genie-project-duplicate-route-",
    });
    const current = createProject(baseDir, "Current Route App");
    const source = createProject(baseDir, "Stopped Duplicate App");
    let duplicatePath = "";
    try {
      await withProjectManagementServer(current.path, async (base) => {
        const res = await fetch(
          `${base}/api/projects/duplicate`,
          jsonPost({
            path: source.path,
          }),
        );
        assertEquals(res.status, 201);
        const body = await res.json();
        duplicatePath = body.project.path;
        assertEquals(body.project.name, "Stopped Duplicate App Copy 1");
        assertEquals(
          body.project.path,
          join(baseDir, "stopped-duplicate-app-copy-1"),
        );
      });
    } finally {
      if (duplicatePath) removeProject(duplicatePath);
      removeProject(source.path);
      removeProject(current.path);
      rmSync(baseDir, { recursive: true, force: true });
    }
  },
});

Deno.test({
  sanitizeResources: false,
  sanitizeOps: false,
  name: "projects rename: non-current project returns 200 and path/name",
  fn: async () => {
    const baseDir = await Deno.makeTempDir({
      dir: "/private/tmp",
      prefix: "genie-project-rename-route-",
    });
    const current = createProject(baseDir, "Current Route Rename App");
    const source = createProject(baseDir, "Stopped Rename App");
    let renamedPath = "";
    try {
      await withProjectManagementServer(current.path, async (base) => {
        const res = await fetch(
          `${base}/api/projects/rename`,
          jsonPost({
            path: source.path,
            name: "Stopped Renamed App",
            folderName: "stopped-renamed-app",
          }),
        );
        assertEquals(res.status, 200);
        const body = await res.json();
        renamedPath = body.project.path;
        assertEquals(body.project.name, "Stopped Renamed App");
        assertEquals(body.project.path, join(baseDir, "stopped-renamed-app"));
      });
    } finally {
      if (renamedPath) removeProject(renamedPath);
      removeProject(source.path);
      removeProject(current.path);
      rmSync(baseDir, { recursive: true, force: true });
    }
  },
});

Deno.test("projects duplicate/rename: missing fields return 400", async () => {
  await withProjectManagementServer(null, async (base) => {
    const duplicate = await fetch(
      `${base}/api/projects/duplicate`,
      jsonPost({}),
    );
    assertEquals(duplicate.status, 400);
    const rename = await fetch(
      `${base}/api/projects/rename`,
      jsonPost({ path: "/tmp/example", name: "Name" }),
    );
    assertEquals(rename.status, 400);
    const invalidJson = await fetch(`${base}/api/projects/duplicate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "not json",
    });
    assertEquals(invalidJson.status, 400);
  });
});

Deno.test({
  sanitizeResources: false,
  sanitizeOps: false,
  name:
    "projects duplicate/rename: missing project or destination collision returns 409",
  fn: async () => {
    const baseDir = await Deno.makeTempDir({
      dir: "/private/tmp",
      prefix: "genie-project-route-conflict-",
    });
    const source = createProject(baseDir, "Conflict Source App");
    const destination = createProject(baseDir, "Conflict Destination App");
    try {
      await withProjectManagementServer(null, async (base) => {
        const missing = await fetch(
          `${base}/api/projects/duplicate`,
          jsonPost({ path: join(baseDir, "missing-project") }),
        );
        assertEquals(missing.status, 409);

        const collision = await fetch(
          `${base}/api/projects/rename`,
          jsonPost({
            path: source.path,
            name: "Collision",
            folderName: basename(destination.path),
          }),
        );
        assertEquals(collision.status, 409);
      });
    } finally {
      removeProject(source.path);
      removeProject(destination.path);
      rmSync(baseDir, { recursive: true, force: true });
    }
  },
});

Deno.test({
  sanitizeResources: false,
  sanitizeOps: false,
  name: "projects close: unloads current project and leaves launcher mode",
  fn: async () => {
    const projectDir = await Deno.makeTempDir({
      prefix: "genie-project-close-",
    });
    const db = await Database.create({ driver: "pglite" });
    const kernel = new Kernel(db, { composition: testStoreComposition() });
    const session = await kernel.sessions.createSession("Close");
    const fakeChat = new SessionRecordingChat(kernel, session.id);
    const now = new Date().toISOString();
    const control = await startControlServer(
      {
        entry: {
          path: projectDir,
          name: "project-close-test",
          createdAt: now,
          lastOpenedAt: now,
        },
        kernel,
        db,
        appServer: { shutdown: async () => {} } as never,
        devServer: { shutdown: async () => {} } as never,
        commandRunner: { shutdown: async () => {} } as never,
        rebuild: () => {},
      },
      0,
      { chatFactory: () => fakeChat },
    );

    try {
      const base = `http://127.0.0.1:${control.server.addr.port}`;
      const projectBefore = await (await fetch(`${base}/api/project`)).json();
      assertEquals(projectBefore.project.orchestrated, false);
      assertEquals(projectBefore.project.orchestratorDashboardUrl, null);

      const res = await fetch(`${base}/api/projects/close`, { method: "POST" });
      assertEquals(res.status, 200);
      assertEquals(await res.json(), { ok: true });
      assertEquals(control.setProject.current(), null);
      assertEquals(fakeChat.closeCount, 1);

      const projectAfter = await (await fetch(`${base}/api/project`)).json();
      assertEquals(projectAfter, { project: null });
    } finally {
      if (control.setProject.current()) {
        await unloadProject(control.setProject.current()!);
      }
      await control.server.shutdown();
      rmSync(projectDir, { recursive: true, force: true });
    }
  },
});

Deno.test({
  sanitizeResources: false,
  sanitizeOps: false,
  name:
    "projects close: aborts and waits for an active chat turn before unloading",
  fn: async () => {
    const projectDir = await Deno.makeTempDir({
      prefix: "genie-project-close-busy-",
    });
    const db = await Database.create({ driver: "pglite" });
    const kernel = new Kernel(db, { composition: testStoreComposition() });
    const session = await kernel.sessions.createSession("Busy Close");
    const blocker = deferred();
    const fakeChat = new SessionRecordingChat(kernel, session.id);
    fakeChat.sendMessageBlocker = blocker.promise;
    const events = fakeChat.events;
    const now = new Date().toISOString();
    const control = await startControlServer(
      {
        entry: {
          path: projectDir,
          name: "project-close-busy-test",
          createdAt: now,
          lastOpenedAt: now,
        },
        kernel,
        db,
        appServer: {
          shutdown: async () => {
            events.push("app.shutdown");
          },
        } as never,
        devServer: { shutdown: async () => {} } as never,
        commandRunner: { shutdown: async () => {} } as never,
        rebuild: () => {},
      },
      0,
      { chatFactory: () => fakeChat },
    );

    let ws: WebSocket | null = null;
    try {
      const port = control.server.addr.port;
      const base = `http://127.0.0.1:${port}`;
      ws = new WebSocket(`ws://127.0.0.1:${port}/chat`);
      await waitForSocketOpen(ws);
      ws.send(JSON.stringify({
        type: "user_message",
        sessionId: session.id,
        content: "keep working",
      }));
      await waitFor(() => fakeChat.sentMessages.length === 1);

      const closePromise = fetch(`${base}/api/projects/close`, {
        method: "POST",
      });
      await waitFor(() => fakeChat.abortCount === 1);
      const closedEarly = await Promise.race([
        closePromise.then(() => true),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 50)),
      ]);
      assertEquals(closedEarly, false);
      assertEquals(fakeChat.closeCount, 0);
      assertEquals(events.includes("app.shutdown"), false);
      assert(control.setProject.current());

      blocker.resolve();
      const res = await closePromise;
      assertEquals(res.status, 200);
      assertEquals(fakeChat.abortCount, 1);
      assertEquals(fakeChat.closeCount, 1);
      assertEquals(control.setProject.current(), null);
      assertEquals(events, [
        "send.start",
        "chat.abort",
        "send.complete",
        "chat.close",
        "app.shutdown",
      ]);
    } finally {
      blocker.resolve();
      ws?.close();
      if (control.setProject.current()) {
        await unloadProject(control.setProject.current()!);
      }
      await control.server.shutdown();
      rmSync(projectDir, { recursive: true, force: true });
    }
  },
});

Deno.test({
  sanitizeResources: false,
  sanitizeOps: false,
  name:
    "projects close: aborts and waits for an active terminal agent turn before unloading",
  fn: async () => {
    const projectDir = await Deno.makeTempDir({
      prefix: "genie-project-close-terminal-busy-",
    });
    const db = await Database.create({ driver: "pglite" });
    const kernel = new Kernel(db, { composition: testStoreComposition() });
    const session = await kernel.sessions.createSession("Terminal Busy Close");
    const blocker = deferred();
    const fakeChat = new SessionRecordingChat(kernel, session.id);
    fakeChat.sendMessageBlocker = blocker.promise;
    const events = fakeChat.events;
    const now = new Date().toISOString();
    const control = await startControlServer(
      {
        entry: {
          path: projectDir,
          name: "project-close-terminal-busy-test",
          createdAt: now,
          lastOpenedAt: now,
        },
        kernel,
        db,
        appServer: {
          shutdown: async () => {
            events.push("app.shutdown");
          },
        } as never,
        devServer: { shutdown: async () => {} } as never,
        commandRunner: { shutdown: async () => {} } as never,
        rebuild: () => {},
      },
      0,
      { chatFactory: () => fakeChat },
    );

    let ws: WebSocket | null = null;
    try {
      const port = control.server.addr.port;
      const base = `http://127.0.0.1:${port}`;
      ws = new WebSocket(`ws://127.0.0.1:${port}/terminal`);
      await waitForSocketOpen(ws);
      ws.send(JSON.stringify({
        type: "eval",
        code: 'ask("keep working from terminal")',
      }));
      await waitFor(() => fakeChat.sentMessages.length === 1);

      const closePromise = fetch(`${base}/api/projects/close`, {
        method: "POST",
      });
      await waitFor(() => fakeChat.abortCount === 1);
      const closedEarly = await Promise.race([
        closePromise.then(() => true),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 50)),
      ]);
      assertEquals(closedEarly, false);
      assertEquals(fakeChat.closeCount, 0);
      assertEquals(events.includes("app.shutdown"), false);
      assert(control.setProject.current());

      blocker.resolve();
      const res = await closePromise;
      assertEquals(res.status, 200);
      assertEquals(fakeChat.abortCount, 1);
      assertEquals(fakeChat.closeCount, 1);
      assertEquals(control.setProject.current(), null);
      assertEquals(events, [
        "send.start",
        "chat.abort",
        "send.complete",
        "chat.close",
        "app.shutdown",
      ]);
    } finally {
      blocker.resolve();
      ws?.close();
      if (control.setProject.current()) {
        await unloadProject(control.setProject.current()!);
      }
      await control.server.shutdown();
      rmSync(projectDir, { recursive: true, force: true });
    }
  },
});

Deno.test({
  sanitizeResources: false,
  sanitizeOps: false,
  name:
    "projects close: active turn rejection after abort settles before ctx is nulled",
  fn: async () => {
    const projectDir = await Deno.makeTempDir({
      prefix: "genie-project-close-reject-",
    });
    const db = await Database.create({ driver: "pglite" });
    const kernel = new Kernel(db, { composition: testStoreComposition() });
    const session = await kernel.sessions.createSession("Rejecting Close");
    const fakeChat = new SessionRecordingChat(kernel, session.id);
    fakeChat.rejectSendOnAbort = true;
    const now = new Date().toISOString();
    const control = await startControlServer(
      {
        entry: {
          path: projectDir,
          name: "project-close-reject-test",
          createdAt: now,
          lastOpenedAt: now,
        },
        kernel,
        db,
        appServer: { shutdown: async () => {} } as never,
        devServer: { shutdown: async () => {} } as never,
        commandRunner: { shutdown: async () => {} } as never,
        rebuild: () => {},
      },
      0,
      { chatFactory: () => fakeChat },
    );

    let ws: WebSocket | null = null;
    try {
      const port = control.server.addr.port;
      const base = `http://127.0.0.1:${port}`;
      ws = new WebSocket(`ws://127.0.0.1:${port}/chat`);
      await waitForSocketOpen(ws);
      ws.send(JSON.stringify({
        type: "user_message",
        sessionId: session.id,
        content: "abort me",
      }));
      await waitFor(() => fakeChat.sentMessages.length === 1);

      const res = await fetch(`${base}/api/projects/close`, { method: "POST" });
      assertEquals(res.status, 200);
      assertEquals(await res.json(), { ok: true });
      assertEquals(fakeChat.abortCount, 1);
      assertEquals(fakeChat.closeCount, 1);
      assertEquals(control.setProject.current(), null);
      assertEquals(await (await fetch(`${base}/api/project`)).json(), {
        project: null,
      });
    } finally {
      ws?.close();
      if (control.setProject.current()) {
        await unloadProject(control.setProject.current()!);
      }
      await control.server.shutdown();
      rmSync(projectDir, { recursive: true, force: true });
    }
  },
});

Deno.test({
  sanitizeResources: false,
  sanitizeOps: false,
  name:
    "chat status returns compact in-progress state by default and full detail on request",
  fn: async () => {
    const db = await Database.create({ driver: "pglite" });
    const kernel = new Kernel(db, { composition: testStoreComposition() });
    const session = await kernel.sessions.createSession("Busy Status");
    const blocker = deferred();
    const fakeChat = new SessionRecordingChat(kernel, session.id);
    fakeChat.sendMessageBlocker = blocker.promise;
    const fullResult = {
      output: "x".repeat(10_000),
      metadata: { path: "big.log" },
    };
    fakeChat.inProgressState = {
      text: "visible text",
      toolCalls: [{
        name: "read_file",
        input: { path: "big.log" },
        result: {
          omitted: true,
          type: "object",
          keys: ["output", "metadata"],
          keyCount: 2,
        },
      }],
      segmentText: "visible segment",
      segmentToolCalls: [{
        name: "read_file",
        input: { path: "big.log" },
        result: {
          omitted: true,
          type: "object",
          keys: ["output", "metadata"],
          keyCount: 2,
        },
      }],
    };
    fakeChat.inProgressFullState = {
      text: "visible text",
      toolCalls: [{
        name: "read_file",
        input: { path: "big.log" },
        result: fullResult,
      }],
      segmentText: "visible segment",
      segmentToolCalls: [{
        name: "read_file",
        input: { path: "big.log" },
        result: fullResult,
      }],
    };
    const now = new Date().toISOString();
    const control = await startControlServer(
      {
        entry: {
          path: "/tmp/genie-control-server-chat-status-detail-test",
          name: "control-server-chat-status-detail-test",
          createdAt: now,
          lastOpenedAt: now,
        },
        kernel,
        db,
        appServer: { shutdown: async () => {} } as never,
        devServer: { shutdown: async () => {} } as never,
        commandRunner: { shutdown: async () => {} } as never,
        rebuild: () => {},
      },
      0,
      { chatFactory: () => fakeChat },
    );

    let ws: WebSocket | null = null;
    try {
      const port = control.server.addr.port;
      const base = `http://127.0.0.1:${port}`;
      ws = new WebSocket(`ws://127.0.0.1:${port}/chat`);
      await waitForSocketOpen(ws);
      ws.send(JSON.stringify({
        type: "user_message",
        sessionId: session.id,
        content: "inspect a large file",
      }));
      await waitFor(() => fakeChat.sentMessages.length === 1);

      const compact = await (await fetch(`${base}/api/chat/status`)).json();
      assertEquals(compact.busy, true);
      assertEquals(compact.inProgress.toolCalls[0].result.omitted, true);
      assertEquals(compact.inProgress.toolCalls[0].result.keys, [
        "output",
        "metadata",
      ]);

      const full = await (await fetch(`${base}/api/chat/status?detail=full`))
        .json();
      assertEquals(full.busy, true);
      assertEquals(full.inProgress.toolCalls[0].result, fullResult);
    } finally {
      blocker.resolve();
      ws?.close();
      await control.server.shutdown();
      await db.close();
    }
  },
});

Deno.test({
  sanitizeResources: false,
  sanitizeOps: false,
  name: "chat websocket reconnect sends compact in-progress state",
  fn: async () => {
    const db = await Database.create({ driver: "pglite" });
    const kernel = new Kernel(db, { composition: testStoreComposition() });
    const session = await kernel.sessions.createSession("Busy Reconnect");
    const blocker = deferred();
    const fakeChat = new SessionRecordingChat(kernel, session.id);
    fakeChat.sendMessageBlocker = blocker.promise;
    fakeChat.inProgressState = {
      text: "visible text",
      toolCalls: [{
        name: "read_file",
        input: { path: "big.log" },
        result: {
          omitted: true,
          type: "object",
          keys: ["output"],
          keyCount: 1,
        },
      }],
      segmentText: "visible segment",
      segmentToolCalls: [{
        name: "read_file",
        input: { path: "big.log" },
        result: {
          omitted: true,
          type: "object",
          keys: ["output"],
          keyCount: 1,
        },
      }],
    };
    fakeChat.inProgressFullState = {
      text: "visible text",
      toolCalls: [{
        name: "read_file",
        input: { path: "big.log" },
        result: { output: "x".repeat(10_000) },
      }],
      segmentText: "visible segment",
      segmentToolCalls: [{
        name: "read_file",
        input: { path: "big.log" },
        result: { output: "x".repeat(10_000) },
      }],
    };
    const now = new Date().toISOString();
    const control = await startControlServer(
      {
        entry: {
          path: "/tmp/genie-control-server-chat-reconnect-detail-test",
          name: "control-server-chat-reconnect-detail-test",
          createdAt: now,
          lastOpenedAt: now,
        },
        kernel,
        db,
        appServer: { shutdown: async () => {} } as never,
        devServer: { shutdown: async () => {} } as never,
        commandRunner: { shutdown: async () => {} } as never,
        rebuild: () => {},
      },
      0,
      { chatFactory: () => fakeChat },
    );

    let firstWs: WebSocket | null = null;
    let reconnectWs: WebSocket | null = null;
    try {
      const port = control.server.addr.port;
      firstWs = new WebSocket(`ws://127.0.0.1:${port}/chat`);
      await waitForSocketOpen(firstWs);
      firstWs.send(JSON.stringify({
        type: "user_message",
        sessionId: session.id,
        content: "inspect a large file",
      }));
      await waitFor(() => fakeChat.sentMessages.length === 1);

      reconnectWs = new WebSocket(`ws://127.0.0.1:${port}/chat`);
      const reconnectMessage = new Promise<Record<string, unknown>>(
        (resolve) => {
          reconnectWs!.onmessage = (evt) => resolve(JSON.parse(evt.data));
        },
      );
      await waitForSocketOpen(reconnectWs);
      const status = await reconnectMessage;

      assertEquals(status.type, "agent_status");
      assertEquals(status.busy, true);
      const toolCalls = status.toolCalls as Array<{ result?: unknown }>;
      assertEquals(toolCalls[0]?.result, {
        omitted: true,
        type: "object",
        keys: ["output"],
        keyCount: 1,
      });
    } finally {
      blocker.resolve();
      firstWs?.close();
      reconnectWs?.close();
      await control.server.shutdown();
      await db.close();
    }
  },
});

Deno.test({
  sanitizeResources: false,
  sanitizeOps: false,
  name:
    "project import restores committed dynamic schemas when data directory is absent",
  fn: async () => {
    const parentDir = await Deno.makeTempDir({
      dir: "/private/tmp",
      prefix: "tideide-import-schema-restore-",
    });
    const projectDir = join(parentDir, "cloned-docs-app");
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(
      join(projectDir, "package.json"),
      JSON.stringify({
        name: "cloned-docs-app",
        scripts: { test: "deno test" },
      }),
    );
    mkdirSync(join(projectDir, "src"), { recursive: true });
    writeFileSync(
      join(projectDir, "src", "main.ts"),
      "export const app = true;\n",
    );
    writeFileSync(join(projectDir, ".gitignore"), "data/\n");
    writeDynamicSchemaRestoreFixture(projectDir);

    const paths = getProjectPaths(projectDir);
    assertEquals(existsSync(paths.dataDir), false);

    const auth = new TestAuthProvider();
    const control = await startControlServer(null, 0, {
      authProvider: auth,
      composition: testStoreComposition(),
    });

    try {
      const base = `http://127.0.0.1:${control.server.addr.port}`;
      const res = await fetch(`${base}/api/projects/import`, {
        method: "POST",
        headers: jsonAuthHeaders(auth),
        body: JSON.stringify({ path: projectDir, name: "Cloned Docs App" }),
      });
      const text = await res.text();

      assertEquals(text.includes('relation "documents" does not exist'), false);
      assertEquals(res.status, 201, text);

      const body = JSON.parse(text) as {
        project: { path: string; name: string };
      };
      assertEquals(body.project.path, projectDir);
      assertEquals(body.project.name, "Cloned Docs App");

      const ctx = control.setProject.current();
      assert(ctx);
      const tables = await ctx.db.query(`
        SELECT table_name
        FROM information_schema.tables
        WHERE table_schema = 'public'
          AND table_name IN ('agent_events', 'documents', 'versions')
        ORDER BY table_name
      `);
      assertEquals(
        tables.map((row) => row.table_name),
        ["agent_events", "documents", "versions"],
      );

      const rowCounts = await ctx.db.query(`
        SELECT 'agent_events' AS table_name, COUNT(*)::integer AS count FROM agent_events
        UNION ALL
        SELECT 'documents' AS table_name, COUNT(*)::integer AS count FROM documents
        UNION ALL
        SELECT 'versions' AS table_name, COUNT(*)::integer AS count FROM versions
        ORDER BY table_name
      `);
      assertEquals(rowCounts, [
        { table_name: "agent_events", count: 0 },
        { table_name: "documents", count: 0 },
        { table_name: "versions", count: 0 },
      ]);

      const schemas = await ctx.db.listSchemas();
      assertEquals(
        schemas.map((schema) => schema.tableName).sort(),
        ["agent_events", "documents", "versions"],
      );
      assert(ctx.db.schemas.get("documents"));
      assert(ctx.db.schemas.get("versions"));
      assert(ctx.db.schemas.get("agent_events"));
      assertEquals(readdirSync(paths.dataDir).length > 0, true);
    } finally {
      const ctx = control.setProject.current();
      if (ctx) await unloadProject(ctx);
      await control.server.shutdown();
      removeProject(projectDir);
      rmSync(parentDir, { recursive: true, force: true });
    }
  },
});

Deno.test("resolveScreenshotArtifactPath allows only persisted PNG basenames", () => {
  const projectDir = "/tmp/genie-control-screenshot-artifact";
  assertEquals(
    resolveScreenshotArtifactPath(projectDir, "proof.png"),
    join(
      projectDir,
      ".opentide",
      "history",
      "artifacts",
      "screenshots",
      "proof.png",
    ),
  );
  assertEquals(resolveScreenshotArtifactPath(projectDir, "../proof.png"), null);
  assertEquals(resolveScreenshotArtifactPath(projectDir, "proof.jpg"), null);
});

Deno.test("parseMcpServerConfigInput rejects non-string stdio args", () => {
  const result = parseMcpServerConfigInput({
    name: "local",
    transport: "stdio",
    command: "tool",
    args: ["ok", 123],
  });
  assertEquals(result.ok, false);
  if (result.ok) throw new Error("unreachable");
  assertEquals(result.error, "args must be an array of strings");
});

Deno.test("parseMcpServerConfigInput rejects non-string stdio env values", () => {
  const result = parseMcpServerConfigInput({
    name: "local",
    transport: "stdio",
    command: "tool",
    env: { GOOD: "yes", BAD: false },
  });
  assertEquals(result.ok, false);
  if (result.ok) throw new Error("unreachable");
  assertEquals(result.error, "env must be an object of string values");
});

Deno.test({
  sanitizeResources: false,
  sanitizeOps: false,
  name:
    "preview-port endpoints expose boot fallback, persist prefs, and probe availability",
  fn: async () => {
    const projectDir = await Deno.makeTempDir({
      dir: "/private/tmp",
      prefix: "genie-control-preview-port-",
    });
    const paths = getProjectPaths(projectDir);
    const now = new Date().toISOString();
    // Persisted fixed pin of :3001 while the server actually bound elsewhere —
    // exactly the boot-time collision-fallback state A5 must surface.
    writeFileSync(
      paths.manifest,
      JSON.stringify(
        { name: "preview-port-test", createdAt: now, previewPort: 3001 },
        null,
        2,
      ),
    );

    const db = await Database.create({ driver: "pglite" });
    const kernel = new Kernel(db, {
      historyDir: paths.historyDir,
      composition: testStoreComposition(),
    });

    // Stub app server: mutable bound port + a rebind that reports back whatever
    // rebindResult decides (honored vs fallen-back).
    let boundPort = 52000;
    const rebindCalls: number[] = [];
    let rebindResult = (n: number) => n;
    const appServer = {
      get port() {
        return boundPort;
      },
      get listening() {
        return true;
      },
      rebind: (n: number) => {
        rebindCalls.push(n);
        boundPort = rebindResult(n);
        return Promise.resolve(boundPort);
      },
      shutdown: () => Promise.resolve(),
    } as never;

    const auth = new TestAuthProvider();
    const control = await startControlServer(
      {
        entry: {
          path: projectDir,
          name: "preview-port-test",
          createdAt: now,
          lastOpenedAt: now,
        },
        kernel,
        db,
        appServer,
        devServer: { shutdown: async () => {} } as never,
        commandRunner: { shutdown: async () => {} } as never,
        rebuild: () => {},
      },
      0,
      { authProvider: auth, mountRoutes: [mountVerificationRoutes] },
    );

    try {
      const base = `http://127.0.0.1:${control.server.addr.port}`;

      // GET surfaces the boot fallback: pref stays :3001, actual is :52000.
      const got = await (await fetch(`${base}/api/project/preview-port`, {
        headers: authHeaders(auth),
      })).json();
      assertEquals(got, {
        mode: "fixed",
        requestedPort: 3001,
        actualPort: 52000,
        listening: true,
      });

      // PUT fixed onto a taken port → manifest persists the pref, response
      // reports fellBack because rebind returned a different port.
      rebindResult = () => 52999;
      const putFallback = await (await fetch(
        `${base}/api/project/preview-port`,
        {
          method: "PUT",
          headers: jsonAuthHeaders(auth),
          body: JSON.stringify({ mode: "fixed", port: 4000 }),
        },
      )).json();
      assertEquals(putFallback, { actualPort: 52999, fellBack: true });
      assertEquals(rebindCalls.at(-1), 4000);
      assertEquals(
        JSON.parse(readFileSync(paths.manifest, "utf-8")).previewPort,
        4000,
      );

      // PUT fixed onto a free port → honored, no fallback.
      rebindResult = (n) => n;
      const putHonored = await (await fetch(
        `${base}/api/project/preview-port`,
        {
          method: "PUT",
          headers: jsonAuthHeaders(auth),
          body: JSON.stringify({ mode: "fixed", port: 4100 }),
        },
      )).json();
      assertEquals(putHonored, { actualPort: 4100, fellBack: false });

      // PUT auto → manifest becomes "auto", rebind asked for the auto sentinel.
      const putAuto = await (await fetch(`${base}/api/project/preview-port`, {
        method: "PUT",
        headers: jsonAuthHeaders(auth),
        body: JSON.stringify({ mode: "auto" }),
      })).json();
      assertEquals(putAuto.fellBack, false);
      assertEquals(rebindCalls.at(-1), 0);
      assertEquals(
        JSON.parse(readFileSync(paths.manifest, "utf-8")).previewPort,
        "auto",
      );

      // Invalid mode is rejected.
      assertEquals(
        (await fetch(`${base}/api/project/preview-port`, {
          method: "PUT",
          headers: jsonAuthHeaders(auth),
          body: JSON.stringify({ mode: "nonsense" }),
        })).status,
        400,
      );

      // check probes a live port: occupied → false, then freed → true.
      const occupied = Deno.listen({ hostname: "127.0.0.1", port: 0 });
      const busyPort = (occupied.addr as Deno.NetAddr).port;
      const busy = await (await fetch(
        `${base}/api/project/preview-port/check?port=${busyPort}`,
        { headers: authHeaders(auth) },
      )).json();
      assertEquals(busy, { available: false });
      occupied.close();
      const free = await (await fetch(
        `${base}/api/project/preview-port/check?port=${busyPort}`,
        { headers: authHeaders(auth) },
      )).json();
      assertEquals(free, { available: true });

      // Non-numeric port is rejected.
      assertEquals(
        (await fetch(`${base}/api/project/preview-port/check?port=abc`, {
          headers: authHeaders(auth),
        })).status,
        400,
      );
    } finally {
      await control.server.shutdown();
      await db.close();
      rmSync(projectDir, { recursive: true, force: true });
    }
  },
});

Deno.test({
  sanitizeResources: false,
  sanitizeOps: false,
  name:
    "GET /api/codebase serves null before indexing and the cached graph after",
  fn: async () => {
    const projectDir = await Deno.makeTempDir({
      dir: "/private/tmp",
      prefix: "genie-control-codebase-",
    });
    const paths = getProjectPaths(projectDir);
    const now = new Date().toISOString();
    mkdirSync(join(projectDir, ".opentide"), { recursive: true });
    writeFileSync(
      paths.manifest,
      JSON.stringify({ name: "codebase-test", createdAt: now }, null, 2),
    );
    // A tiny source project for index_codebase to walk.
    mkdirSync(join(projectDir, "src"), { recursive: true });
    writeFileSync(
      join(projectDir, "package.json"),
      JSON.stringify({ scripts: { test: "vitest" } }),
    );
    writeFileSync(join(projectDir, "src", "index.ts"), "export const x = 1;");

    const db = await Database.create({ driver: "pglite" });
    const kernel = new Kernel(db, {
      historyDir: paths.historyDir,
      composition: testStoreComposition(),
    });
    kernel.projectDir = projectDir;

    const auth = new TestAuthProvider();
    const control = await startControlServer(
      {
        entry: {
          path: projectDir,
          name: "codebase-test",
          createdAt: now,
          lastOpenedAt: now,
        },
        kernel,
        db,
        appServer: { shutdown: async () => {} } as never,
        devServer: { shutdown: async () => {} } as never,
        commandRunner: { shutdown: async () => {} } as never,
        rebuild: () => {},
      },
      0,
      { authProvider: auth, mountRoutes: [mountVerificationRoutes] },
    );

    try {
      const base = `http://127.0.0.1:${control.server.addr.port}`;

      // Before indexing: endpoint responds with an explicit null graph.
      const empty = await (await fetch(`${base}/api/codebase`, {
        headers: authHeaders(auth),
      })).json();
      assertEquals(empty, { graph: null });

      // Index via the tool (defaults rootPath to the loaded project dir). The
      // tool caches the graph on the kernel, which the endpoint then serves.
      const run = await dispatchTool("index_codebase", {}, kernel, () => {});
      assertEquals(run.ok, true);
      assertEquals(
        (run.data as { counts: { files: number } }).counts.files,
        1,
      );

      // After indexing: the cached graph is served.
      const served = await (await fetch(`${base}/api/codebase`, {
        headers: authHeaders(auth),
      })).json();
      assert(served.graph !== null);
      assertEquals(served.graph.projectId, projectDir);
      assertEquals(
        served.graph.files.map((f: { path: string }) => f.path),
        ["src/index.ts"],
      );
    } finally {
      await control.server.shutdown();
      await db.close();
      rmSync(projectDir, { recursive: true, force: true });
    }
  },
});

Deno.test({
  sanitizeResources: false,
  sanitizeOps: false,
  name:
    "GET /api/documents surfaces the read-only document store (list, detail, refs, content)",
  fn: async () => {
    const projectDir = await Deno.makeTempDir({
      dir: "/private/tmp",
      prefix: "genie-control-documents-",
    });
    const paths = getProjectPaths(projectDir);
    const now = new Date().toISOString();
    mkdirSync(join(projectDir, ".opentide"), { recursive: true });
    writeFileSync(
      paths.manifest,
      JSON.stringify({ name: "documents-test", createdAt: now }, null, 2),
    );

    const db = await Database.create({ driver: "pglite" });
    const kernel = new Kernel(db, {
      historyDir: paths.historyDir,
      composition: testStoreComposition(),
    });
    kernel.projectDir = projectDir;

    const sessionId = "sess_docs_1";

    // A session-scoped markdown doc (with a source origin), pinned resident and
    // cited by a changeset/plan ref.
    const planDoc = await kernel.documents.create({
      name: "plan.md",
      kind: "text/markdown",
      content: "# Plan\n\nStep one.\n",
      scope: "session",
      sessionId,
      createdBy: "agent",
      metadata: { source: PLAN_DOCUMENT_SOURCE, sourceId: "cs_docs_1" },
    });
    assertEquals(planDoc.ok, true);
    if (!planDoc.ok) return;

    const evidenceDoc = await kernel.documents.create({
      name: "attestation.md",
      kind: "text/markdown",
      content: "# Attestation\n\nPassed.\n",
      scope: "session",
      sessionId,
      createdBy: "agent",
      metadata: { source: EVIDENCE_DOCUMENT_SOURCE, sourceId: "att_docs_1" },
    });
    assertEquals(evidenceDoc.ok, true);
    if (!evidenceDoc.ok) return;

    // A project-scoped doc (different scope) and an archived one (filter check).
    const projectDoc = await kernel.documents.create({
      name: "notes.md",
      kind: "text/markdown",
      content: "project note",
      scope: "project",
      createdBy: "user",
    });
    assertEquals(projectDoc.ok, true);
    const archivedDoc = await kernel.documents.create({
      name: "old.md",
      kind: "text/markdown",
      content: "archived",
      scope: "project",
      createdBy: "user",
    });
    assertEquals(archivedDoc.ok, true);
    if (!projectDoc.ok || !archivedDoc.ok) return;
    await kernel.documents.archive(archivedDoc.data.id);

    // A session-scoped binary (image) doc — the content endpoint returns a
    // placeholder for this, never decoded bytes.
    const imageDoc = await kernel.documents.create({
      name: "shot.png",
      kind: "image/png",
      content: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      scope: "session",
      sessionId,
      createdBy: "agent",
    });
    assertEquals(imageDoc.ok, true);
    if (!imageDoc.ok) return;

    // A session doc belonging to a DIFFERENT session — must never surface in the
    // session_id view (visibility is project/global + this session only).
    const otherSessionDoc = await kernel.documents.create({
      name: "other.md",
      kind: "text/markdown",
      content: "belongs to another session",
      scope: "session",
      sessionId: "sess_docs_other",
      createdBy: "agent",
    });
    assertEquals(otherSessionDoc.ok, true);
    if (!otherSessionDoc.ok) return;

    // Record a changeset/plan backlink and pin the plan doc resident.
    const ref = await kernel.documents.recordRef({
      documentId: planDoc.data.id,
      refType: "changeset",
      refId: "cs_docs_1",
      role: "plan",
      versionHash: planDoc.data.currentVersionHash,
      sessionId,
    });
    assertEquals(ref.ok, true);
    const pin = await kernel.documents.setPinned(
      planDoc.data.id,
      true,
      sessionId,
    );
    assertEquals(pin.ok, true);

    const auth = new TestAuthProvider();
    const control = await startControlServer(
      {
        entry: {
          path: projectDir,
          name: "documents-test",
          createdAt: now,
          lastOpenedAt: now,
        },
        kernel,
        db,
        appServer: { shutdown: async () => {} } as never,
        devServer: { shutdown: async () => {} } as never,
        commandRunner: { shutdown: async () => {} } as never,
        rebuild: () => {},
      },
      0,
      { authProvider: auth, mountRoutes: [mountVerificationRoutes] },
    );

    try {
      const base = `http://127.0.0.1:${control.server.addr.port}`;
      const get = (path: string) =>
        fetch(`${base}${path}`, { headers: authHeaders(auth) });

      // List (no filter) — user/context docs only; internal provenance and
      // archived docs are excluded.
      const all = await (await get("/api/documents")).json();
      const allIds = (all as Array<{ id: string }>).map((d) => d.id);
      assert(!allIds.includes(planDoc.data.id));
      assert(!allIds.includes(evidenceDoc.data.id));
      assert(allIds.includes(projectDoc.data.id));
      assert(allIds.includes(imageDoc.data.id));
      assert(!allIds.includes(archivedDoc.data.id));

      // Diagnostic/internal escape hatch restores the legacy all-doc listing.
      const allInternal = await (await get(
        "/api/documents?include_internal=1",
      )).json() as Array<{ id: string }>;
      const allInternalIds = allInternal.map((d) => d.id);
      assert(allInternalIds.includes(planDoc.data.id));
      assert(allInternalIds.includes(evidenceDoc.data.id));
      assert(allInternalIds.includes(projectDoc.data.id));

      // session_id scopes to docs VISIBLE from the session after default
      // provenance filtering: this session's visible image PLUS the shared project
      // doc, never hidden provenance or another session's session docs. Resident
      // flags are computed over these visible rows only, so the pinned hidden plan
      // doc does not leak into the response.
      const bySession = await (await get(
        `/api/documents?session_id=${sessionId}`,
      )).json() as Array<{ id: string; resident: boolean }>;
      assertEquals(
        new Set(bySession.map((d) => d.id)),
        new Set([imageDoc.data.id, projectDoc.data.id]),
      );
      assert(!bySession.some((d) => d.id === planDoc.data.id));
      assert(!bySession.some((d) => d.id === evidenceDoc.data.id));
      assert(!bySession.some((d) => d.id === otherSessionDoc.data.id));
      assertEquals(
        bySession.find((d) => d.id === imageDoc.data.id)?.resident,
        false,
      );
      assertEquals(
        bySession.find((d) => d.id === projectDoc.data.id)?.resident,
        false,
      );

      const bySessionInternal = await (await get(
        `/api/documents?session_id=${sessionId}&include_internal=1`,
      )).json() as Array<{ id: string; resident: boolean }>;
      assertEquals(
        bySessionInternal.find((d) => d.id === planDoc.data.id)?.resident,
        true,
      );
      assert(
        bySessionInternal.some((d) => d.id === evidenceDoc.data.id),
      );

      // scope filter.
      const byScope = await (await get("/api/documents?scope=project")).json();
      assertEquals(
        (byScope as Array<{ id: string }>).map((d) => d.id),
        [projectDoc.data.id],
      );

      // include_archived surfaces the archived project doc.
      const withArchived = await (await get(
        "/api/documents?scope=project&include_archived=1",
      )).json() as Array<{ id: string }>;
      assertEquals(
        new Set(withArchived.map((d) => d.id)),
        new Set([projectDoc.data.id, archivedDoc.data.id]),
      );

      // Detail: metadata + versions, and 404 on an unknown id.
      const detail = await (await get(
        `/api/documents/${planDoc.data.id}`,
      )).json();
      assertEquals(detail.document.id, planDoc.data.id);
      assertEquals(detail.document.metadata.source, PLAN_DOCUMENT_SOURCE);
      assertEquals(detail.versions.length, 1);
      assertEquals(
        detail.versions[0].versionHash,
        planDoc.data.currentVersionHash,
      );
      const missing = await get("/api/documents/doc_nope");
      assertEquals(missing.status, 404);
      assertEquals(await missing.json(), { error: "Not found" });

      // Refs: the recorded changeset/plan backlink plus the working_set/resident ref
      // written by the pin above — listRefs returns every backlink; the panel groups
      // them by ref_type.
      const refs = await (await get(
        `/api/documents/${planDoc.data.id}/refs`,
      )).json() as Array<Record<string, unknown>>;
      assertEquals(
        new Set(refs.map((r) => r.refType)),
        new Set(["changeset", "working_set"]),
      );
      const planRef = refs.find((r) => r.refType === "changeset")!;
      assertEquals(planRef.role, "plan");
      assertEquals(planRef.refId, "cs_docs_1");
      assertEquals(planRef.versionHash, planDoc.data.currentVersionHash);

      // Content: text inline for a text kind.
      const textContent = await (await get(
        `/api/documents/${planDoc.data.id}/content`,
      )).json();
      assertEquals(textContent.kind, "text/markdown");
      assertEquals(textContent.versionHash, planDoc.data.currentVersionHash);
      assertEquals(textContent.content, "# Plan\n\nStep one.\n");

      const rawPlan = await get(`/api/documents/${planDoc.data.id}/raw`);
      assertEquals(rawPlan.status, 200);
      assertEquals(await rawPlan.text(), "# Plan\n\nStep one.\n");

      // Content: binary placeholder for an image kind — no bytes.
      const binaryContent = await (await get(
        `/api/documents/${imageDoc.data.id}/content`,
      )).json();
      assertEquals(binaryContent.binary, true);
      assertEquals(binaryContent.kind, "image/png");
      assertEquals(binaryContent.size, 8);
      assertEquals(binaryContent.content, undefined);
    } finally {
      await control.server.shutdown();
      await db.close();
      rmSync(projectDir, { recursive: true, force: true });
    }
  },
});

Deno.test({
  sanitizeResources: false,
  sanitizeOps: false,
  name:
    "POST /api/documents/:id/pin toggles Tier-2 residency and validates its inputs",
  fn: async () => {
    const projectDir = await Deno.makeTempDir({
      dir: "/private/tmp",
      prefix: "genie-control-documents-pin-",
    });
    const paths = getProjectPaths(projectDir);
    const now = new Date().toISOString();
    mkdirSync(join(projectDir, ".opentide"), { recursive: true });
    writeFileSync(
      paths.manifest,
      JSON.stringify({ name: "documents-pin-test", createdAt: now }, null, 2),
    );

    const db = await Database.create({ driver: "pglite" });
    const kernel = new Kernel(db, {
      historyDir: paths.historyDir,
      composition: testStoreComposition(),
    });
    kernel.projectDir = projectDir;

    const sessionId = "sess_pin_1";

    const doc = await kernel.documents.create({
      name: "pinnable.md",
      kind: "text/markdown",
      content: "# Pin me\n\nA small session document.\n",
      scope: "session",
      sessionId,
      createdBy: "user",
    });
    assertEquals(doc.ok, true);
    if (!doc.ok) return;

    // A doc large enough that pinning it would blow the working-set token budget.
    const bigContent = "x".repeat(DOCUMENT_WORKING_SET_MAX_TOKENS * 8);
    const bigDoc = await kernel.documents.create({
      name: "huge.md",
      kind: "text/markdown",
      content: bigContent,
      scope: "session",
      sessionId,
      createdBy: "user",
    });
    assertEquals(bigDoc.ok, true);
    if (!bigDoc.ok) return;

    const auth = new TestAuthProvider();
    const control = await startControlServer(
      {
        entry: {
          path: projectDir,
          name: "documents-pin-test",
          createdAt: now,
          lastOpenedAt: now,
        },
        kernel,
        db,
        appServer: { shutdown: async () => {} } as never,
        devServer: { shutdown: async () => {} } as never,
        commandRunner: { shutdown: async () => {} } as never,
        rebuild: () => {},
      },
      0,
      { authProvider: auth, mountRoutes: [mountVerificationRoutes] },
    );

    try {
      const base = `http://127.0.0.1:${control.server.addr.port}`;
      const get = (path: string) =>
        fetch(`${base}${path}`, { headers: authHeaders(auth) });
      const pin = (id: string, body: unknown) =>
        fetch(`${base}/api/documents/${id}/pin`, {
          method: "POST",
          headers: { ...authHeaders(auth), "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });

      const residentOf = async (id: string) => {
        const rows = await (await get(
          `/api/documents?session_id=${sessionId}`,
        )).json() as Array<{ id: string; resident: boolean }>;
        return rows.find((d) => d.id === id)?.resident;
      };

      // Not resident to start.
      assertEquals(await residentOf(doc.data.id), false);

      // Pin → 200 { id, pinned: true }; the list now flags it resident.
      const pinned = await pin(doc.data.id, {
        pinned: true,
        session_id: sessionId,
      });
      assertEquals(pinned.status, 200);
      assertEquals(await pinned.json(), { id: doc.data.id, pinned: true });
      assertEquals(await residentOf(doc.data.id), true);

      // Unpin → 200 { id, pinned: false }; residency clears.
      const unpinned = await pin(doc.data.id, {
        pinned: false,
        session_id: sessionId,
      });
      assertEquals(unpinned.status, 200);
      assertEquals(await unpinned.json(), { id: doc.data.id, pinned: false });
      assertEquals(await residentOf(doc.data.id), false);

      // Unknown id → 404 { error: "Not found" }.
      const missing = await pin("doc_nope", {
        pinned: true,
        session_id: sessionId,
      });
      assertEquals(missing.status, 404);
      assertEquals(await missing.json(), { error: "Not found" });

      // Missing session_id → 400.
      const noSession = await pin(doc.data.id, { pinned: true });
      assertEquals(noSession.status, 400);

      // Non-boolean pinned → 400.
      const badPinned = await pin(doc.data.id, {
        pinned: "yes",
        session_id: sessionId,
      });
      assertEquals(badPinned.status, 400);

      // Over-budget pin → 409, surfacing the budget message + release-first suggestion.
      const overBudget = await pin(bigDoc.data.id, {
        pinned: true,
        session_id: sessionId,
      });
      assertEquals(overBudget.status, 409);
      const overBudgetBody = await overBudget.json() as { error: string };
      assertStringIncludes(overBudgetBody.error, "past the");
      assertStringIncludes(overBudgetBody.error, "Release a resident document");
      // The rejected doc stays non-resident.
      assertEquals(await residentOf(bigDoc.data.id), false);
    } finally {
      await control.server.shutdown();
      await db.close();
      rmSync(projectDir, { recursive: true, force: true });
    }
  },
});

Deno.test({
  sanitizeResources: false,
  sanitizeOps: false,
  name:
    "POST /api/documents creates a text document (user path) and validates its inputs",
  fn: async () => {
    const projectDir = await Deno.makeTempDir({
      dir: "/private/tmp",
      prefix: "genie-control-documents-create-",
    });
    const paths = getProjectPaths(projectDir);
    const now = new Date().toISOString();
    mkdirSync(join(projectDir, ".opentide"), { recursive: true });
    writeFileSync(
      paths.manifest,
      JSON.stringify(
        { name: "documents-create-test", createdAt: now },
        null,
        2,
      ),
    );

    const db = await Database.create({ driver: "pglite" });
    const kernel = new Kernel(db, {
      historyDir: paths.historyDir,
      composition: testStoreComposition(),
    });
    kernel.projectDir = projectDir;

    const auth = new TestAuthProvider();
    const control = await startControlServer(
      {
        entry: {
          path: projectDir,
          name: "documents-create-test",
          createdAt: now,
          lastOpenedAt: now,
        },
        kernel,
        db,
        appServer: { shutdown: async () => {} } as never,
        devServer: { shutdown: async () => {} } as never,
        commandRunner: { shutdown: async () => {} } as never,
        rebuild: () => {},
      },
      0,
      { authProvider: auth, mountRoutes: [mountVerificationRoutes] },
    );

    try {
      const base = `http://127.0.0.1:${control.server.addr.port}`;
      const get = (path: string) =>
        fetch(`${base}${path}`, { headers: authHeaders(auth) });
      const create = (body: unknown) =>
        fetch(`${base}/api/documents`, {
          method: "POST",
          headers: { ...authHeaders(auth), "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });

      // Project-scoped markdown doc → 201, record carries scope + createdBy: "user".
      const projText = "# Notes\n\nA project-scoped document.\n";
      const created = await create({
        name: "project-notes.md",
        kind: "text/markdown",
        scope: "project",
        content: projText,
      });
      assertEquals(created.status, 201);
      const record = await created.json() as {
        id: string;
        scope: string;
        createdBy: string;
      };
      assertEquals(record.scope, "project");
      assertEquals(record.createdBy, "user");

      // It now shows up in the project list, and its content round-trips byte-exact.
      const projList = await (await get("/api/documents?scope=project"))
        .json() as Array<{ id: string }>;
      assert(projList.some((d) => d.id === record.id));
      const projContent = await (await get(
        `/api/documents/${record.id}/content`,
      )).json();
      assertEquals(projContent.content, projText);

      // Session-scoped doc with a session_id → 201, visible in that session's list.
      const sessionId = "sess_create_1";
      const sessCreated = await create({
        name: "session-notes.txt",
        kind: "text/plain",
        scope: "session",
        content: "session body",
        session_id: sessionId,
      });
      assertEquals(sessCreated.status, 201);
      const sessRecord = await sessCreated.json() as { id: string };
      const sessList = await (await get(
        `/api/documents?session_id=${sessionId}`,
      )).json() as Array<{ id: string }>;
      assert(sessList.some((d) => d.id === sessRecord.id));

      // Empty name → 400.
      assertEquals(
        (await create({
          name: "  ",
          kind: "text/markdown",
          scope: "project",
          content: "x",
        })).status,
        400,
      );

      // Missing / non-string content → 400.
      assertEquals(
        (await create({
          name: "n.md",
          kind: "text/markdown",
          scope: "project",
        })).status,
        400,
      );
      assertEquals(
        (await create({
          name: "n.md",
          kind: "text/markdown",
          scope: "project",
          content: 123,
        })).status,
        400,
      );

      // Bad scope → 400.
      assertEquals(
        (await create({
          name: "n.md",
          kind: "text/markdown",
          scope: "nope",
          content: "x",
        })).status,
        400,
      );

      // Non-text kind → 400 (this slice writes text only).
      assertEquals(
        (await create({
          name: "n.png",
          kind: "image/png",
          scope: "project",
          content: "x",
        })).status,
        400,
      );

      // Session scope without a session_id → 400.
      assertEquals(
        (await create({
          name: "n.md",
          kind: "text/markdown",
          scope: "session",
          content: "x",
        })).status,
        400,
      );

      // Content past the cap → 400 (CONTENT_TOO_LARGE mapped to a boundary error).
      const overCap = await create({
        name: "huge.md",
        kind: "text/markdown",
        scope: "project",
        content: "x".repeat(DOCUMENT_MAX_CONTENT_BYTES + 1),
      });
      assertEquals(overCap.status, 400);
    } finally {
      await control.server.shutdown();
      await db.close();
      rmSync(projectDir, { recursive: true, force: true });
    }
  },
});

Deno.test({
  sanitizeResources: false,
  sanitizeOps: false,
  name:
    "PUT /api/documents/:id writes a new immutable version (idempotent) and validates its inputs",
  fn: async () => {
    const projectDir = await Deno.makeTempDir({
      dir: "/private/tmp",
      prefix: "genie-control-documents-update-",
    });
    const paths = getProjectPaths(projectDir);
    const now = new Date().toISOString();
    mkdirSync(join(projectDir, ".opentide"), { recursive: true });
    writeFileSync(
      paths.manifest,
      JSON.stringify(
        { name: "documents-update-test", createdAt: now },
        null,
        2,
      ),
    );

    const db = await Database.create({ driver: "pglite" });
    const kernel = new Kernel(db, {
      historyDir: paths.historyDir,
      composition: testStoreComposition(),
    });
    kernel.projectDir = projectDir;

    const auth = new TestAuthProvider();
    const control = await startControlServer(
      {
        entry: {
          path: projectDir,
          name: "documents-update-test",
          createdAt: now,
          lastOpenedAt: now,
        },
        kernel,
        db,
        appServer: { shutdown: async () => {} } as never,
        devServer: { shutdown: async () => {} } as never,
        commandRunner: { shutdown: async () => {} } as never,
        rebuild: () => {},
      },
      0,
      { authProvider: auth, mountRoutes: [mountVerificationRoutes] },
    );

    try {
      const base = `http://127.0.0.1:${control.server.addr.port}`;
      const get = (path: string) =>
        fetch(`${base}${path}`, { headers: authHeaders(auth) });
      const put = (id: string, body: unknown) =>
        fetch(`${base}/api/documents/${id}`, {
          method: "PUT",
          headers: { ...authHeaders(auth), "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });

      // Seed a project-scoped markdown doc via the engine (the create route's own path
      // is covered by the sibling test; here we exercise the update route).
      const seeded = await kernel.documents.create({
        name: "editable.md",
        kind: "text/markdown",
        content: "# v1\n",
        scope: "project",
        createdBy: "user",
      });
      assert(seeded.ok);
      const id = seeded.data.id;
      const originalHash = seeded.data.currentVersionHash;

      // PUT new content → 200; the head moves to a new version.
      const v2Body = "# v2\n\nUpdated body.\n";
      const updated = await put(id, { content: v2Body });
      assertEquals(updated.status, 200);
      const updatedRecord = await updated.json() as {
        currentVersionHash: string;
      };
      assert(updatedRecord.currentVersionHash !== originalHash);

      // GET :id now lists 2 versions (newest-first) with the new head; content matches.
      const detail = await (await get(`/api/documents/${id}`)).json() as {
        document: { currentVersionHash: string };
        versions: Array<{ versionHash: string }>;
      };
      assertEquals(detail.versions.length, 2);
      assertEquals(
        detail.document.currentVersionHash,
        updatedRecord.currentVersionHash,
      );
      assertEquals(
        detail.versions[0]!.versionHash,
        updatedRecord.currentVersionHash,
      );
      const content = await (await get(`/api/documents/${id}/content`)).json();
      assertEquals(content.content, v2Body);

      // Idempotency: re-PUT the same content → 200 and still 2 versions (byte-dedupe).
      const again = await put(id, { content: v2Body });
      assertEquals(again.status, 200);
      const detail2 = await (await get(`/api/documents/${id}`)).json() as {
        versions: Array<{ versionHash: string }>;
      };
      assertEquals(detail2.versions.length, 2);

      // Non-string content → 400.
      assertEquals((await put(id, { content: 123 })).status, 400);
      assertEquals((await put(id, {})).status, 400);

      // Unknown id → 404.
      assertEquals((await put("doc_nope", { content: "x" })).status, 404);

      // A non-text doc rejects a text update → 400 (binary editing is a later slice).
      const image = await kernel.documents.create({
        name: "logo.png",
        kind: "image/png",
        content: new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
        scope: "project",
        createdBy: "user",
      });
      assert(image.ok);
      assertEquals((await put(image.data.id, { content: "x" })).status, 400);

      // An archived doc can't take a new version → 409.
      const archivable = await kernel.documents.create({
        name: "gone.md",
        kind: "text/markdown",
        content: "# soon archived\n",
        scope: "project",
        createdBy: "user",
      });
      assert(archivable.ok);
      await kernel.documents.archive(archivable.data.id);
      assertEquals(
        (await put(archivable.data.id, { content: "y" })).status,
        409,
      );
    } finally {
      await control.server.shutdown();
      await db.close();
      rmSync(projectDir, { recursive: true, force: true });
    }
  },
});

Deno.test({
  sanitizeResources: false,
  sanitizeOps: false,
  name:
    "DELETE /api/documents/:id archives (soft-deletes) a document — idempotent tombstone, versions preserved",
  fn: async () => {
    const projectDir = await Deno.makeTempDir({
      dir: "/private/tmp",
      prefix: "genie-control-documents-archive-",
    });
    const paths = getProjectPaths(projectDir);
    const now = new Date().toISOString();
    mkdirSync(join(projectDir, ".opentide"), { recursive: true });
    writeFileSync(
      paths.manifest,
      JSON.stringify(
        { name: "documents-archive-test", createdAt: now },
        null,
        2,
      ),
    );

    const db = await Database.create({ driver: "pglite" });
    const kernel = new Kernel(db, {
      historyDir: paths.historyDir,
      composition: testStoreComposition(),
    });
    kernel.projectDir = projectDir;

    const auth = new TestAuthProvider();
    const control = await startControlServer(
      {
        entry: {
          path: projectDir,
          name: "documents-archive-test",
          createdAt: now,
          lastOpenedAt: now,
        },
        kernel,
        db,
        appServer: { shutdown: async () => {} } as never,
        devServer: { shutdown: async () => {} } as never,
        commandRunner: { shutdown: async () => {} } as never,
        rebuild: () => {},
      },
      0,
      { authProvider: auth, mountRoutes: [mountVerificationRoutes] },
    );

    try {
      const base = `http://127.0.0.1:${control.server.addr.port}`;
      const get = (path: string) =>
        fetch(`${base}${path}`, { headers: authHeaders(auth) });
      const del = (id: string) =>
        fetch(`${base}/api/documents/${id}`, {
          method: "DELETE",
          headers: authHeaders(auth),
        });
      const put = (id: string, body: unknown) =>
        fetch(`${base}/api/documents/${id}`, {
          method: "PUT",
          headers: { ...authHeaders(auth), "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });

      // Seed a project-scoped markdown doc, then edit it so it carries >1 version — the
      // tombstone must preserve all of them.
      const seeded = await kernel.documents.create({
        name: "archive-me.md",
        kind: "text/markdown",
        content: "# v1\n",
        scope: "project",
        createdBy: "user",
      });
      assert(seeded.ok);
      const id = seeded.data.id;
      const edited = await put(id, { content: "# v2\n" });
      assertEquals(edited.status, 200);

      // Pre-condition: the doc is in the default list.
      const before = await (await get("/api/documents")).json() as Array<
        { id: string }
      >;
      assert(before.some((d) => d.id === id));

      // DELETE → 200; the returned record is tombstoned.
      const archived = await del(id);
      assertEquals(archived.status, 200);
      const archivedRecord = await archived.json() as { archived: boolean };
      assertEquals(archivedRecord.archived, true);

      // The default list omits it; include_archived=1 restores it.
      const defaultList = await (await get("/api/documents")).json() as Array<
        { id: string }
      >;
      assert(!defaultList.some((d) => d.id === id));
      const withArchived =
        await (await get("/api/documents?include_archived=1")).json() as Array<
          { id: string }
        >;
      assert(withArchived.some((d) => d.id === id));

      // The detail GET is not filtered — it still returns the doc with versions intact.
      const detail = await (await get(`/api/documents/${id}`)).json() as {
        document: { archived: boolean };
        versions: Array<{ versionHash: string }>;
      };
      assertEquals(detail.document.archived, true);
      assertEquals(detail.versions.length, 2);

      // Idempotency: re-DELETE the same id → still 200, still archived (no error).
      const again = await del(id);
      assertEquals(again.status, 200);
      const againRecord = await again.json() as { archived: boolean };
      assertEquals(againRecord.archived, true);

      // The tombstone holds: an archived doc still rejects a PUT with 409 (Slice 5 guard).
      assertEquals((await put(id, { content: "# v3\n" })).status, 409);

      // Unknown id → 404.
      assertEquals((await del("doc_nope")).status, 404);
    } finally {
      await control.server.shutdown();
      await db.close();
      rmSync(projectDir, { recursive: true, force: true });
    }
  },
});

Deno.test({
  sanitizeResources: false,
  sanitizeOps: false,
  name:
    "POST /api/documents/:id/scope promotes session→project (metadata-only), idempotent, rejects demotion/tombstone",
  fn: async () => {
    const projectDir = await Deno.makeTempDir({
      dir: "/private/tmp",
      prefix: "genie-control-documents-promote-",
    });
    const paths = getProjectPaths(projectDir);
    const now = new Date().toISOString();
    mkdirSync(join(projectDir, ".opentide"), { recursive: true });
    writeFileSync(
      paths.manifest,
      JSON.stringify(
        { name: "documents-promote-test", createdAt: now },
        null,
        2,
      ),
    );

    const db = await Database.create({ driver: "pglite" });
    const kernel = new Kernel(db, {
      historyDir: paths.historyDir,
      composition: testStoreComposition(),
    });
    kernel.projectDir = projectDir;

    const auth = new TestAuthProvider();
    const control = await startControlServer(
      {
        entry: {
          path: projectDir,
          name: "documents-promote-test",
          createdAt: now,
          lastOpenedAt: now,
        },
        kernel,
        db,
        appServer: { shutdown: async () => {} } as never,
        devServer: { shutdown: async () => {} } as never,
        commandRunner: { shutdown: async () => {} } as never,
        rebuild: () => {},
      },
      0,
      { authProvider: auth, mountRoutes: [mountVerificationRoutes] },
    );

    try {
      const base = `http://127.0.0.1:${control.server.addr.port}`;
      const get = (path: string) =>
        fetch(`${base}${path}`, { headers: authHeaders(auth) });
      const promote = (id: string, body: unknown) =>
        fetch(`${base}/api/documents/${id}/scope`, {
          method: "POST",
          headers: { ...authHeaders(auth), "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });

      // The real Kernel here has NO globalRootOverride, so a successful →global promotion
      // would write to the real ~/.config/opentide. This test therefore stays within the
      // project root (session→project is metadata-only, same on-disk root) — the →global
      // blob-copy path is covered by the engine unit test in documents_test.ts.
      const seeded = await kernel.documents.create({
        name: "promote-me.md",
        kind: "text/markdown",
        content: "# session content\n",
        scope: "session",
        sessionId: "sess_promote",
        createdBy: "user",
      });
      assert(seeded.ok);
      const id = seeded.data.id;

      // session→project → 200; the returned record widened scope and cleared sessionId.
      const promoted = await promote(id, { scope: "project" });
      assertEquals(promoted.status, 200);
      const promotedRecord = await promoted.json() as {
        scope: string;
        sessionId: string | null;
      };
      assertEquals(promotedRecord.scope, "project");
      assertEquals(promotedRecord.sessionId, null);

      // Content still resolves (same on-disk root — no copy).
      const content = await (await get(`/api/documents/${id}/content`))
        .json() as {
          content?: string;
        };
      assertEquals(content.content, "# session content\n");

      // Idempotency: re-promoting to the current scope → 200, still project.
      const again = await promote(id, { scope: "project" });
      assertEquals(again.status, 200);
      assertEquals((await again.json() as { scope: string }).scope, "project");

      // Demotion (project→session) is rejected → 400.
      assertEquals((await promote(id, { scope: "session" })).status, 400);

      // `session` is never a valid promotion target (rejected before the engine) → 400.
      const freshSession = await kernel.documents.create({
        name: "still-session.md",
        kind: "text/markdown",
        content: "s\n",
        scope: "session",
        sessionId: "sess_promote",
        createdBy: "user",
      });
      assert(freshSession.ok);
      assertEquals(
        (await promote(freshSession.data.id, { scope: "session" })).status,
        400,
      );

      // Missing/invalid target scope → 400.
      assertEquals((await promote(id, { scope: "nonsense" })).status, 400);
      assertEquals((await promote(id, {})).status, 400);

      // An archived doc isn't promotable → 409 (cross-check with the tombstone).
      await kernel.documents.archive(id);
      assertEquals((await promote(id, { scope: "global" })).status, 409);

      // Unknown id → 404.
      assertEquals(
        (await promote("doc_nope", { scope: "project" })).status,
        404,
      );
    } finally {
      await control.server.shutdown();
      await db.close();
      rmSync(projectDir, { recursive: true, force: true });
    }
  },
});

Deno.test({
  sanitizeResources: false,
  sanitizeOps: false,
  name:
    "GET /api/documents/:id/raw streams bytes inline for images, downloads unsafe kinds, pins versions",
  fn: async () => {
    const projectDir = await Deno.makeTempDir({
      dir: "/private/tmp",
      prefix: "genie-control-documents-raw-",
    });
    const paths = getProjectPaths(projectDir);
    const now = new Date().toISOString();
    mkdirSync(join(projectDir, ".opentide"), { recursive: true });
    writeFileSync(
      paths.manifest,
      JSON.stringify({ name: "documents-raw-test", createdAt: now }, null, 2),
    );

    const db = await Database.create({ driver: "pglite" });
    const kernel = new Kernel(db, {
      historyDir: paths.historyDir,
      composition: testStoreComposition(),
    });
    kernel.projectDir = projectDir;

    const auth = new TestAuthProvider();
    const control = await startControlServer(
      {
        entry: {
          path: projectDir,
          name: "documents-raw-test",
          createdAt: now,
          lastOpenedAt: now,
        },
        kernel,
        db,
        appServer: { shutdown: async () => {} } as never,
        devServer: { shutdown: async () => {} } as never,
        commandRunner: { shutdown: async () => {} } as never,
        rebuild: () => {},
      },
      0,
      { authProvider: auth, mountRoutes: [mountVerificationRoutes] },
    );

    try {
      const base = `http://127.0.0.1:${control.server.addr.port}`;
      const get = (path: string) =>
        fetch(`${base}${path}`, { headers: authHeaders(auth) });

      // The real Kernel here has NO globalRootOverride, so everything is seeded
      // project-scoped — it stays in the project root (no global ~/.config writes).
      const imgV1 = new Uint8Array([
        0x89,
        0x50,
        0x4e,
        0x47,
        0x0d,
        0x0a,
        0x1a,
        0x0a,
      ]);
      const seededImage = await kernel.documents.create({
        name: "pixel.png",
        kind: "image/png",
        content: imgV1,
        scope: "project",
        createdBy: "user",
      });
      assert(seededImage.ok);
      const imageId = seededImage.data.id;
      const oldHash = seededImage.data.currentVersionHash;

      // Inline image: real Content-Type, nosniff, inline disposition, byte-exact body.
      const rawImg = await get(`/api/documents/${imageId}/raw`);
      assertEquals(rawImg.status, 200);
      assertEquals(rawImg.headers.get("Content-Type"), "image/png");
      assertEquals(rawImg.headers.get("X-Content-Type-Options"), "nosniff");
      assert(
        (rawImg.headers.get("Content-Disposition") ?? "").includes("inline"),
      );
      assertEquals(new Uint8Array(await rawImg.arrayBuffer()), imgV1);

      // XSS guard: a text/html document must never be served as active content —
      // it comes back as application/octet-stream + attachment, not text/html.
      const htmlDoc = await kernel.documents.create({
        name: "evil.html",
        kind: "text/html",
        content: "<script>alert(1)</script>",
        scope: "project",
        createdBy: "user",
      });
      assert(htmlDoc.ok);
      const rawHtml = await get(`/api/documents/${htmlDoc.data.id}/raw`);
      assertEquals(rawHtml.status, 200);
      assertEquals(
        rawHtml.headers.get("Content-Type"),
        "application/octet-stream",
      );
      assert(
        (rawHtml.headers.get("Content-Disposition") ?? "").includes(
          "attachment",
        ),
      );
      // Drain the body so the response isn't left dangling.
      await rawHtml.arrayBuffer();

      // Version pinning: update the image (2 versions). ?version=<oldHash> returns the
      // ORIGINAL bytes while no-version returns the new head.
      const imgV2 = new Uint8Array([
        0x89,
        0x50,
        0x4e,
        0x47,
        0xff,
        0xfe,
        0xfd,
        0xfc,
      ]);
      const updated = await kernel.documents.update(imageId, {
        content: imgV2,
        createdBy: "user",
      });
      assert(updated.ok);
      assert(updated.data.currentVersionHash !== oldHash);

      const rawHead = await get(`/api/documents/${imageId}/raw`);
      assertEquals(new Uint8Array(await rawHead.arrayBuffer()), imgV2);

      const rawPinned = await get(
        `/api/documents/${imageId}/raw?version=${oldHash}`,
      );
      assertEquals(rawPinned.status, 200);
      assertEquals(new Uint8Array(await rawPinned.arrayBuffer()), imgV1);

      // Unknown id → 404.
      const missing = await get("/api/documents/doc_nope/raw");
      assertEquals(missing.status, 404);
      await missing.body?.cancel();

      // Unknown version → 404.
      const badVersion = await get(
        `/api/documents/${imageId}/raw?version=deadbeef`,
      );
      assertEquals(badVersion.status, 404);
      await badVersion.body?.cancel();
    } finally {
      await control.server.shutdown();
      await db.close();
      rmSync(projectDir, { recursive: true, force: true });
    }
  },
});

Deno.test({
  sanitizeResources: false,
  sanitizeOps: false,
  name:
    "POST /api/documents (multipart) uploads a binary doc, closing the Slice-8 read loop, and validates it (Slice 9)",
  fn: async () => {
    const projectDir = await Deno.makeTempDir({
      dir: "/private/tmp",
      prefix: "genie-control-documents-upload-",
    });
    const paths = getProjectPaths(projectDir);
    const now = new Date().toISOString();
    mkdirSync(join(projectDir, ".opentide"), { recursive: true });
    writeFileSync(
      paths.manifest,
      JSON.stringify(
        { name: "documents-upload-test", createdAt: now },
        null,
        2,
      ),
    );

    const db = await Database.create({ driver: "pglite" });
    const kernel = new Kernel(db, {
      historyDir: paths.historyDir,
      composition: testStoreComposition(),
    });
    kernel.projectDir = projectDir;

    const auth = new TestAuthProvider();
    const control = await startControlServer(
      {
        entry: {
          path: projectDir,
          name: "documents-upload-test",
          createdAt: now,
          lastOpenedAt: now,
        },
        kernel,
        db,
        appServer: { shutdown: async () => {} } as never,
        devServer: { shutdown: async () => {} } as never,
        commandRunner: { shutdown: async () => {} } as never,
        rebuild: () => {},
      },
      0,
      { authProvider: auth, mountRoutes: [mountVerificationRoutes] },
    );

    try {
      const base = `http://127.0.0.1:${control.server.addr.port}`;
      const get = (path: string) =>
        fetch(`${base}${path}`, { headers: authHeaders(auth) });
      // A multipart upload: the browser sets the boundary, so we pass the FormData
      // directly and never set Content-Type ourselves (mirrors the store's uploadFile).
      const upload = (form: FormData) =>
        fetch(`${base}/api/documents`, {
          method: "POST",
          headers: authHeaders(auth),
          body: form,
        });
      // Bytes that begin with the PNG magic signature (89 50 4E 47) so the route's
      // magic-byte sniff accepts them as an image/png.
      const pngBytes = (tail: number[]) =>
        new Uint8Array([
          0x89,
          0x50,
          0x4e,
          0x47,
          0x0d,
          0x0a,
          0x1a,
          0x0a,
          ...tail,
        ]);

      // (1) Upload a PNG → 201; the record carries the file kind + createdBy: "user".
      const imgBytes = pngBytes([0x01, 0x02, 0x03, 0x04]);
      const okForm = new FormData();
      okForm.append(
        "file",
        new File([imgBytes], "pixel.png", { type: "image/png" }),
      );
      okForm.append("scope", "project");
      const created = await upload(okForm);
      assertEquals(created.status, 201);
      const record = await created.json() as {
        id: string;
        name: string;
        kind: string;
        createdBy: string;
        scope: string;
      };
      assertEquals(record.kind, "image/png");
      assertEquals(record.createdBy, "user");
      assertEquals(record.scope, "project");
      // Name defaults to the uploaded filename when no name field is sent.
      assertEquals(record.name, "pixel.png");

      // The Slice-8 read loop closes over an UPLOADED doc: /raw returns the byte-exact
      // bytes, inline, as image/png with nosniff.
      const raw = await get(`/api/documents/${record.id}/raw`);
      assertEquals(raw.status, 200);
      assertEquals(raw.headers.get("Content-Type"), "image/png");
      assertEquals(raw.headers.get("X-Content-Type-Options"), "nosniff");
      assert((raw.headers.get("Content-Disposition") ?? "").includes("inline"));
      assertEquals(new Uint8Array(await raw.arrayBuffer()), imgBytes);

      // (2) Text upload: an HTML file is stored as text (editable/readable through
      // /content) but /raw still forces attachment so it cannot execute same-origin.
      const htmlForm = new FormData();
      htmlForm.append(
        "file",
        new File(["<b>hi</b>"], "note.html", { type: "text/html" }),
      );
      htmlForm.append("scope", "project");
      const htmlRes = await upload(htmlForm);
      assertEquals(htmlRes.status, 201);
      const htmlRecord = await htmlRes.json() as {
        id: string;
        name: string;
        kind: string;
      };
      assertEquals(htmlRecord.name, "note.html");
      assertEquals(htmlRecord.kind, "text/html");
      const htmlContent = await (await get(
        `/api/documents/${htmlRecord.id}/content`,
      )).json() as { kind: string; content: string };
      assertEquals(htmlContent.kind, "text/html");
      assertEquals(htmlContent.content, "<b>hi</b>");
      const rawHtml = await get(`/api/documents/${htmlRecord.id}/raw`);
      assertEquals(rawHtml.status, 200);
      assertEquals(
        rawHtml.headers.get("Content-Type"),
        "application/octet-stream",
      );
      assert(
        (rawHtml.headers.get("Content-Disposition") ?? "").includes(
          "attachment",
        ),
      );
      await rawHtml.body?.cancel();

      // (3) Magic-byte mismatch: declare image/png but send non-PNG bytes → 400.
      const mismatchForm = new FormData();
      mismatchForm.append(
        "file",
        new File([new Uint8Array([0x00, 0x01, 0x02, 0x03])], "fake.png", {
          type: "image/png",
        }),
      );
      mismatchForm.append("scope", "project");
      const mismatchRes = await upload(mismatchForm);
      assertEquals(mismatchRes.status, 400);
      await mismatchRes.body?.cancel();

      // (4a) Cap: a PNG between the text cap and the binary cap SUCCEEDS (proving the
      // raised binary cap — a text doc this size would be rejected).
      const midSize = DOCUMENT_MAX_CONTENT_BYTES + 64 * 1024;
      assert(midSize < DOCUMENT_UPLOAD_MAX_BYTES);
      const midBytes = pngBytes(Array(midSize).fill(0x41));
      const midForm = new FormData();
      midForm.append(
        "file",
        new File([midBytes], "big.png", { type: "image/png" }),
      );
      midForm.append("scope", "project");
      const midRes = await upload(midForm);
      assertEquals(midRes.status, 201);
      await midRes.body?.cancel();

      // (4b) Cap: a PNG past the binary cap → 400 CONTENT_TOO_LARGE.
      const hugeBytes = pngBytes(
        Array(DOCUMENT_UPLOAD_MAX_BYTES + 1).fill(0x41),
      );
      const hugeForm = new FormData();
      hugeForm.append(
        "file",
        new File([hugeBytes], "huge.png", { type: "image/png" }),
      );
      hugeForm.append("scope", "project");
      const hugeRes = await upload(hugeForm);
      assertEquals(hugeRes.status, 400);
      const hugeBody = await hugeRes.json() as { error: string };
      assertStringIncludes(hugeBody.error, String(DOCUMENT_UPLOAD_MAX_BYTES));

      // (5) Text regression: the JSON/text create path is untouched → still 201.
      const textRes = await fetch(`${base}/api/documents`, {
        method: "POST",
        headers: { ...authHeaders(auth), "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "notes.md",
          kind: "text/markdown",
          scope: "project",
          content: "# still text\n",
        }),
      });
      assertEquals(textRes.status, 201);
      await textRes.body?.cancel();
    } finally {
      await control.server.shutdown();
      await db.close();
      rmSync(projectDir, { recursive: true, force: true });
    }
  },
});

Deno.test({
  sanitizeResources: false,
  sanitizeOps: false,
  name:
    "dev-server control: status is idle and start is refused for a registry-native project",
  fn: async () => {
    const projectDir = await Deno.makeTempDir({
      dir: "/private/tmp",
      prefix: "genie-control-devserver-",
    });
    const paths = getProjectPaths(projectDir);
    const now = new Date().toISOString();
    mkdirSync(join(projectDir, ".opentide"), { recursive: true });
    // No `mode` key ⇒ registry-native (the default). A dev command is present, but
    // mode gating must still refuse to spawn it.
    writeFileSync(
      paths.manifest,
      JSON.stringify({ name: "devserver-test", createdAt: now }, null, 2),
    );
    writeFileSync(
      join(projectDir, "package.json"),
      JSON.stringify({ scripts: { dev: "vite" } }),
    );

    const db = await Database.create({ driver: "pglite" });
    const kernel = new Kernel(db, {
      historyDir: paths.historyDir,
      composition: testStoreComposition(),
    });
    kernel.projectDir = projectDir;
    const stubAppServer = {
      setProxy() {},
      clearProxy() {},
      shutdown: async () => {},
    } as never;
    const devServer = new DevServerManager(kernel, stubAppServer, projectDir);

    const auth = new TestAuthProvider();
    const control = await startControlServer(
      {
        entry: {
          path: projectDir,
          name: "devserver-test",
          createdAt: now,
          lastOpenedAt: now,
        },
        kernel,
        db,
        appServer: { shutdown: async () => {} } as never,
        devServer,
        commandRunner: new CommandRunner(kernel, projectDir),
        rebuild: () => {},
      },
      0,
      { authProvider: auth, mountRoutes: [mountVerificationRoutes] },
    );

    try {
      const base = `http://127.0.0.1:${control.server.addr.port}`;

      // Idle status before any start.
      const status = await (await fetch(
        `${base}/api/preview/dev-server/status`,
        { headers: authHeaders(auth) },
      )).json();
      assertEquals(status.running, false);
      assertEquals(status.detectedPort, null);
      assertEquals(status.proxied, false);

      // Start is refused (400) because the project is registry-native — it never
      // spawns, so the manager stays idle.
      const startRes = await fetch(`${base}/api/preview/dev-server/start`, {
        method: "POST",
        headers: { ...authHeaders(auth), "content-type": "application/json" },
        body: "{}",
      });
      assertEquals(startRes.status, 400);
      const startBody = await startRes.json();
      assertStringIncludes(startBody.error, "source-backed");
      assertEquals(devServer.running, false);
    } finally {
      await devServer.shutdown();
      await control.server.shutdown();
      await db.close();
      rmSync(projectDir, { recursive: true, force: true });
    }
  },
});

Deno.test({
  sanitizeResources: false,
  sanitizeOps: false,
  name:
    "dev-server control: start spawns a source-backed dev server the app preview proxies to, then stop clears it",
  fn: async () => {
    const projectDir = await Deno.makeTempDir({
      dir: "/private/tmp",
      prefix: "genie-control-devserver-e2e-",
    });
    const paths = getProjectPaths(projectDir);
    const now = new Date().toISOString();
    mkdirSync(join(projectDir, ".opentide"), { recursive: true });
    // Source-backed project so the dev server is allowed to spawn.
    writeFileSync(
      paths.manifest,
      JSON.stringify(
        { name: "devserver-e2e", createdAt: now, mode: "source-backed" },
        null,
        2,
      ),
    );
    // A trivial dev server: binds the hinted PORT and returns a marker body.
    writeFileSync(
      join(projectDir, "dev.ts"),
      `const port = Number(Deno.env.get("PORT"));
Deno.serve({ port, onListen: () => {} }, () => new Response("PROXIED DEV BODY"));
`,
    );

    const db = await Database.create({ driver: "pglite" });
    const kernel = new Kernel(db, {
      historyDir: paths.historyDir,
      composition: testStoreComposition(),
    });
    kernel.projectDir = projectDir;
    // A REAL app-preview server so we exercise the actual setProxy plumbing.
    const appServer = createAppServer(kernel, 0);
    const devServer = new DevServerManager(kernel, appServer, projectDir);

    const auth = new TestAuthProvider();
    const control = await startControlServer(
      {
        entry: {
          path: projectDir,
          name: "devserver-e2e",
          createdAt: now,
          lastOpenedAt: now,
        },
        kernel,
        db,
        appServer,
        devServer,
        commandRunner: new CommandRunner(kernel, projectDir),
        rebuild: () => appServer.rebuild(),
      },
      0,
      { authProvider: auth, mountRoutes: [mountVerificationRoutes] },
    );

    try {
      const base = `http://127.0.0.1:${control.server.addr.port}`;

      // Start with an explicit (user-confirmed) command — a source-backed project.
      const startRes = await fetch(`${base}/api/preview/dev-server/start`, {
        method: "POST",
        headers: { ...authHeaders(auth), "content-type": "application/json" },
        body: JSON.stringify({
          command: `deno run --allow-net --allow-env ${
            join(projectDir, "dev.ts")
          }`,
        }),
      });
      assertEquals(startRes.status, 200);
      const startBody = await startRes.json();
      assertEquals(startBody.running, true);
      assert(startBody.detectedPort > 0, "a child port should be detected");

      // The app-preview listener now transparently proxies to the child.
      const previewPort = appServer.port;
      assert(previewPort > 0, "the app preview should be bound");
      const proxied = await fetch(`http://127.0.0.1:${previewPort}/`);
      assertEquals(await proxied.text(), "PROXIED DEV BODY");

      // Status reflects the running, proxied child.
      const status = await (await fetch(
        `${base}/api/preview/dev-server/status`,
        { headers: authHeaders(auth) },
      )).json();
      assertEquals(status.running, true);
      assertEquals(status.proxied, true);
      assertEquals(status.detectedPort, startBody.detectedPort);
      const childPid = status.pid as number;

      // The resolved run config was persisted to the manifest.
      const manifest = JSON.parse(readFileSync(paths.manifest, "utf-8"));
      assertStringIncludes(manifest.sourceRun.command, "dev.ts");

      // Stop clears the proxy and kills the child.
      const stopRes = await fetch(`${base}/api/preview/dev-server/stop`, {
        method: "POST",
        headers: authHeaders(auth),
      });
      assertEquals(stopRes.status, 200);
      assertEquals(devServer.running, false);

      // The preview port no longer serves the proxied body (proxy cleared → the
      // built empty app answers with its JSON 404 envelope instead).
      const afterStop = await fetch(`http://127.0.0.1:${previewPort}/`);
      const afterBody = await afterStop.text();
      assertEquals(afterBody.includes("PROXIED DEV BODY"), false);

      // No child survives stop.
      let childAlive = true;
      try {
        Deno.kill(childPid, "SIGCONT");
      } catch {
        childAlive = false;
      }
      assertEquals(childAlive, false);
    } finally {
      await devServer.shutdown();
      await appServer.shutdown();
      await control.server.shutdown();
      await db.close();
      rmSync(projectDir, { recursive: true, force: true });
    }
  },
});

Deno.test({
  sanitizeResources: false,
  sanitizeOps: false,
  name:
    "source-edit control: apply writes disk + re-indexes the graph; undo restores bytes; registry-native is refused",
  fn: async () => {
    const projectDir = await Deno.makeTempDir({
      dir: "/private/tmp",
      prefix: "genie-control-source-edit-",
    });
    const paths = getProjectPaths(projectDir);
    const now = new Date().toISOString();
    mkdirSync(join(projectDir, ".opentide"), { recursive: true });
    writeFileSync(
      paths.manifest,
      JSON.stringify(
        { name: "source-edit-e2e", createdAt: now, mode: "source-backed" },
        null,
        2,
      ),
    );
    // A tiny Hono app so re-indexing exercises the framework overlay too.
    writeFileSync(
      join(projectDir, "package.json"),
      JSON.stringify({ name: "app", dependencies: { hono: "^4" } }),
    );
    mkdirSync(join(projectDir, "src"), { recursive: true });
    const original =
      `import { Hono } from "hono";\nconst app = new Hono();\napp.get("/hello", (c) => c.text("hi"));\nexport default app;\n`;
    writeFileSync(join(projectDir, "src", "index.ts"), original);

    const db = await Database.create({ driver: "pglite" });
    const kernel = new Kernel(db, {
      historyDir: paths.historyDir,
      composition: testStoreComposition(),
    });
    kernel.projectDir = projectDir;
    const devServer = new DevServerManager(
      kernel,
      { setProxy() {}, clearProxy() {}, shutdown: async () => {} } as never,
      projectDir,
    );

    const auth = new TestAuthProvider();
    const control = await startControlServer(
      {
        entry: {
          path: projectDir,
          name: "source-edit-e2e",
          createdAt: now,
          lastOpenedAt: now,
        },
        kernel,
        db,
        appServer: { shutdown: async () => {} } as never,
        devServer,
        commandRunner: new CommandRunner(kernel, projectDir),
        rebuild: () => {},
      },
      0,
      { authProvider: auth, mountRoutes: [mountVerificationRoutes] },
    );

    try {
      const base = `http://127.0.0.1:${control.server.addr.port}`;
      const jsonHeaders = jsonAuthHeaders(auth);

      // Preview an edit that changes the route path — no write, but a diff.
      const edited = original.replace("/hello", "/hi");
      const previewRes = await fetch(`${base}/api/files/preview`, {
        method: "POST",
        headers: jsonHeaders,
        body: JSON.stringify({ path: "src/index.ts", content: edited }),
      });
      assertEquals(previewRes.status, 200);
      const preview = await previewRes.json();
      assertEquals(preview.action, "update");
      assertEquals(preview.key, "src/index.ts");
      assertEquals(preview.after.content, edited);
      // Preview must not have touched disk.
      assertEquals(
        readFileSync(join(projectDir, "src", "index.ts"), "utf8"),
        original,
      );

      // Apply writes the bytes and re-indexes.
      const applyRes = await fetch(`${base}/api/files/apply`, {
        method: "POST",
        headers: jsonHeaders,
        body: JSON.stringify({
          path: "src/index.ts",
          content: edited,
          baseFingerprint: preview.baseFingerprint,
        }),
      });
      assertEquals(applyRes.status, 200);
      const applied = await applyRes.json();
      assertEquals(applied.change.category, "module");
      assertEquals(applied.change.context.sourceBacked, true);
      assertEquals(
        readFileSync(join(projectDir, "src", "index.ts"), "utf8"),
        edited,
      );

      // GET /api/codebase reflects the edit: the Hono overlay now has /hi, not /hello.
      const graphBody = await (await fetch(`${base}/api/codebase`, {
        headers: authHeaders(auth),
      })).json();
      const paths1: string[] = graphBody.graph.routes.map((
        r: { path: string },
      ) => r.path);
      assert(
        paths1.includes("/hi"),
        `expected /hi in ${JSON.stringify(paths1)}`,
      );
      assert(!paths1.includes("/hello"));

      // Undo (existing endpoint) restores the prior bytes AND re-indexes.
      const undoRes = await fetch(`${base}/api/undo`, {
        method: "POST",
        headers: authHeaders(auth),
      });
      assertEquals(undoRes.status, 200);
      assertEquals(
        readFileSync(join(projectDir, "src", "index.ts"), "utf8"),
        original,
      );
      const graphBody2 = await (await fetch(`${base}/api/codebase`, {
        headers: authHeaders(auth),
      })).json();
      const paths2: string[] = graphBody2.graph.routes.map((
        r: { path: string },
      ) => r.path);
      assert(
        paths2.includes("/hello"),
        `expected /hello after undo in ${JSON.stringify(paths2)}`,
      );

      // A stale base fingerprint (external write between preview and apply) → 409.
      writeFileSync(
        join(projectDir, "src", "index.ts"),
        original + "// touched\n",
      );
      const conflictRes = await fetch(`${base}/api/files/apply`, {
        method: "POST",
        headers: jsonHeaders,
        body: JSON.stringify({
          path: "src/index.ts",
          content: edited,
          baseFingerprint: preview.baseFingerprint,
        }),
      });
      assertEquals(conflictRes.status, 409);
    } finally {
      await control.server.shutdown();
      await db.close();
      rmSync(projectDir, { recursive: true, force: true });
    }
  },
});

Deno.test({
  sanitizeResources: false,
  sanitizeOps: false,
  name: "source-edit control: a registry-native project refuses file edits",
  fn: async () => {
    const projectDir = await Deno.makeTempDir({
      dir: "/private/tmp",
      prefix: "genie-control-source-edit-native-",
    });
    const paths = getProjectPaths(projectDir);
    const now = new Date().toISOString();
    mkdirSync(join(projectDir, ".opentide"), { recursive: true });
    // No `mode` key ⇒ registry-native.
    writeFileSync(
      paths.manifest,
      JSON.stringify({ name: "native", createdAt: now }, null, 2),
    );
    mkdirSync(join(projectDir, "src"), { recursive: true });
    writeFileSync(join(projectDir, "src", "index.ts"), "export const x = 1;\n");

    const db = await Database.create({ driver: "pglite" });
    const kernel = new Kernel(db, {
      historyDir: paths.historyDir,
      composition: testStoreComposition(),
    });
    kernel.projectDir = projectDir;
    const devServer = new DevServerManager(
      kernel,
      { setProxy() {}, clearProxy() {}, shutdown: async () => {} } as never,
      projectDir,
    );
    const auth = new TestAuthProvider();
    const control = await startControlServer(
      {
        entry: {
          path: projectDir,
          name: "native",
          createdAt: now,
          lastOpenedAt: now,
        },
        kernel,
        db,
        appServer: { shutdown: async () => {} } as never,
        devServer,
        commandRunner: new CommandRunner(kernel, projectDir),
        rebuild: () => {},
      },
      0,
      { authProvider: auth, mountRoutes: [mountVerificationRoutes] },
    );

    try {
      const base = `http://127.0.0.1:${control.server.addr.port}`;
      const res = await fetch(`${base}/api/files/apply`, {
        method: "POST",
        headers: jsonAuthHeaders(auth),
        body: JSON.stringify({ path: "src/index.ts", content: "x" }),
      });
      assertEquals(res.status, 400);
      const body = await res.json();
      assertStringIncludes(body.error, "source-backed");
      // Untouched.
      assertEquals(
        readFileSync(join(projectDir, "src", "index.ts"), "utf8"),
        "export const x = 1;\n",
      );
    } finally {
      await control.server.shutdown();
      await db.close();
      rmSync(projectDir, { recursive: true, force: true });
    }
  },
});

Deno.test({
  sanitizeResources: false,
  sanitizeOps: false,
  name:
    "project-files control: registry-native project previews and applies text files",
  fn: async () => {
    const projectDir = await Deno.makeTempDir({
      dir: "/private/tmp",
      prefix: "genie-control-project-files-native-",
    });
    const paths = getProjectPaths(projectDir);
    const now = new Date().toISOString();
    mkdirSync(join(projectDir, ".opentide"), { recursive: true });
    writeFileSync(
      paths.manifest,
      JSON.stringify({ name: "native", createdAt: now }, null, 2),
    );

    const db = await Database.create({ driver: "pglite" });
    const kernel = new Kernel(db, {
      historyDir: paths.historyDir,
      composition: testStoreComposition(),
    });
    kernel.projectDir = projectDir;
    const devServer = new DevServerManager(
      kernel,
      { setProxy() {}, clearProxy() {}, shutdown: async () => {} } as never,
      projectDir,
    );
    const auth = new TestAuthProvider();
    const control = await startControlServer(
      {
        entry: {
          path: projectDir,
          name: "native",
          createdAt: now,
          lastOpenedAt: now,
        },
        kernel,
        db,
        appServer: { shutdown: async () => {} } as never,
        devServer,
        commandRunner: new CommandRunner(kernel, projectDir),
        rebuild: () => {},
      },
      0,
      { authProvider: auth, mountRoutes: [mountVerificationRoutes] },
    );

    try {
      const base = `http://127.0.0.1:${control.server.addr.port}`;
      const jsonHeaders = jsonAuthHeaders(auth);
      const content = "# Plan\n\nCreate project notes from the agent.\n";

      const previewRes = await fetch(`${base}/api/project-files/preview`, {
        method: "POST",
        headers: jsonHeaders,
        body: JSON.stringify({ path: "docs/agent-plan.md", content }),
      });
      assertEquals(previewRes.status, 200);
      const preview = await previewRes.json();
      assertEquals(preview.action, "create");
      assertEquals(preview.baseFingerprint, null);
      assertEquals(
        existsSync(join(projectDir, "docs", "agent-plan.md")),
        false,
      );

      const applyRes = await fetch(`${base}/api/project-files/apply`, {
        method: "POST",
        headers: jsonHeaders,
        body: JSON.stringify({
          path: "docs/agent-plan.md",
          content,
          baseFingerprint: preview.baseFingerprint,
        }),
      });
      assertEquals(applyRes.status, 200);
      const applied = await applyRes.json();
      assertEquals(applied.change.category, "module");
      assertEquals(applied.change.context.sourceBacked, true);
      assertEquals(applied.change.context.projectFile, true);
      assertEquals(applied.summary, null);
      assertEquals(
        readFileSync(join(projectDir, "docs", "agent-plan.md"), "utf8"),
        content,
      );
    } finally {
      await control.server.shutdown();
      await db.close();
      rmSync(projectDir, { recursive: true, force: true });
    }
  },
});

Deno.test({
  sanitizeResources: false,
  sanitizeOps: false,
  name:
    "UI metadata endpoints write local state and preserve legacy history meta",
  fn: async () => {
    const projectDir = await Deno.makeTempDir({
      dir: "/private/tmp",
      prefix: "genie-control-ui-state-",
    });
    const paths = getProjectPaths(projectDir);
    const db = await Database.create({ driver: "pglite" });
    const kernel = new Kernel(db, {
      historyDir: paths.historyDir,
      composition: testStoreComposition(),
    });
    const now = new Date().toISOString();
    const legacyNav = { entries: [null, "handler:legacy"], cursor: 1 };
    await kernel.changelog.setMeta("nav_history", JSON.stringify(legacyNav));
    const legacyMeta = readFileSync(
      join(paths.historyDir, "meta.json"),
      "utf-8",
    );
    const auth = new TestAuthProvider();
    const control = await startControlServer(
      {
        entry: {
          path: projectDir,
          name: "control-server-ui-state-test",
          createdAt: now,
          lastOpenedAt: now,
        },
        kernel,
        db,
        appServer: { shutdown: async () => {} } as never,
        devServer: { shutdown: async () => {} } as never,
        commandRunner: { shutdown: async () => {} } as never,
        rebuild: () => {},
      },
      0,
      { authProvider: auth, mountRoutes: [mountVerificationRoutes] },
    );

    try {
      const base = `http://127.0.0.1:${control.server.addr.port}`;
      const fallback = await fetch(`${base}/api/nav-history`, {
        headers: authHeaders(auth),
      });
      assertEquals(await fallback.json(), legacyNav);

      const positions = { "handler:hello": { line: 12, column: 4 } };
      const nav = { entries: [null, "route:/"], cursor: 1 };
      const drafts = { "handler:hello": "draft source" };

      assertEquals(
        (await fetch(`${base}/api/editor-positions`, {
          method: "PUT",
          headers: jsonAuthHeaders(auth),
          body: JSON.stringify(positions),
        })).status,
        200,
      );
      assertEquals(
        (await fetch(`${base}/api/nav-history`, {
          method: "PUT",
          headers: jsonAuthHeaders(auth),
          body: JSON.stringify(nav),
        })).status,
        200,
      );
      assertEquals(
        (await fetch(`${base}/api/editor-drafts`, {
          method: "PUT",
          headers: jsonAuthHeaders(auth),
          body: JSON.stringify(drafts),
        })).status,
        200,
      );

      const localState = JSON.parse(readFileSync(paths.localState, "utf-8"));
      assertEquals(localState.editor_positions, positions);
      assertEquals(localState.nav_history, nav);
      assertEquals(localState.editor_drafts, drafts);
      assertEquals(
        readFileSync(join(paths.historyDir, "meta.json"), "utf-8"),
        legacyMeta,
      );
      assertEquals(existsSync(paths.localState), true);
    } finally {
      await control.server.shutdown();
      await db.close();
      rmSync(projectDir, { recursive: true, force: true });
    }
  },
});

Deno.test({
  sanitizeResources: false,
  sanitizeOps: false,
  name: "chat draft endpoints persist per-session local state",
  fn: async () => {
    const projectDir = await Deno.makeTempDir({
      dir: "/private/tmp",
      prefix: "genie-control-chat-drafts-",
    });
    const paths = getProjectPaths(projectDir);
    const db = await Database.create({ driver: "pglite" });
    const kernel = new Kernel(db, {
      historyDir: paths.historyDir,
      composition: testStoreComposition(),
    });
    const session = await kernel.sessions.createSession("Drafts", {
      ownerUserId: "account_owner",
      visibility: "private",
    });
    const otherSession = await kernel.sessions.createSession("Other Drafts", {
      ownerUserId: "account_owner",
      visibility: "private",
    });
    const blockedSession = await kernel.sessions.createSession(
      "Blocked Drafts",
      {
        ownerUserId: "account_other",
        visibility: "private",
      },
    );
    const now = new Date().toISOString();
    const auth = new TestAuthProvider();
    const control = await startControlServer(
      {
        entry: {
          path: projectDir,
          name: "control-server-chat-drafts-test",
          createdAt: now,
          lastOpenedAt: now,
        },
        kernel,
        db,
        appServer: { shutdown: async () => {} } as never,
        devServer: { shutdown: async () => {} } as never,
        commandRunner: { shutdown: async () => {} } as never,
        rebuild: () => {},
      },
      0,
      { authProvider: auth, mountRoutes: [mountVerificationRoutes] },
    );

    try {
      const base = `http://127.0.0.1:${control.server.addr.port}`;
      const url = `${base}/api/chat-drafts/${session.id}`;
      const otherUrl = `${base}/api/chat-drafts/${otherSession.id}`;
      const blockedUrl = `${base}/api/chat-drafts/${blockedSession.id}`;

      assertEquals(
        (await fetch(blockedUrl, { headers: authHeaders(auth) })).status,
        403,
      );

      let res = await fetch(url, { headers: authHeaders(auth) });
      assertEquals(res.status, 200);
      assertEquals(await res.json(), { text: "" });

      res = await fetch(url, {
        method: "PUT",
        headers: jsonAuthHeaders(auth),
        body: JSON.stringify({ text: "  hello draft  " }),
      });
      assertEquals(res.status, 200);
      assertEquals(JSON.parse(readFileSync(paths.localState, "utf-8")), {
        chat_drafts: { [session.id]: "  hello draft  " },
      });

      res = await fetch(otherUrl, {
        method: "PUT",
        headers: jsonAuthHeaders(auth),
        body: JSON.stringify({ text: "other draft" }),
      });
      assertEquals(res.status, 200);

      res = await fetch(url, {
        method: "PUT",
        headers: jsonAuthHeaders(auth),
        body: JSON.stringify({ text: "updated draft" }),
      });
      assertEquals(res.status, 200);
      res = await fetch(url, { headers: authHeaders(auth) });
      assertEquals(await res.json(), { text: "updated draft" });

      res = await fetch(url, { method: "DELETE", headers: authHeaders(auth) });
      assertEquals(res.status, 200);
      assertEquals(JSON.parse(readFileSync(paths.localState, "utf-8")), {
        chat_drafts: { [otherSession.id]: "other draft" },
      });

      res = await fetch(otherUrl, {
        method: "PUT",
        headers: jsonAuthHeaders(auth),
        body: JSON.stringify({ text: "   \n\t  " }),
      });
      assertEquals(res.status, 200);
      assertEquals(existsSync(paths.localState), false);
    } finally {
      await control.server.shutdown();
      await db.close();
      rmSync(projectDir, { recursive: true, force: true });
    }
  },
});

Deno.test({
  sanitizeResources: false,
  sanitizeOps: false,
  name: "chat drafts preserve unrelated local-state keys and cap stored text",
  fn: async () => {
    const projectDir = await Deno.makeTempDir({
      dir: "/private/tmp",
      prefix: "genie-control-chat-draft-state-",
    });
    const paths = getProjectPaths(projectDir);
    const db = await Database.create({ driver: "pglite" });
    const kernel = new Kernel(db, {
      historyDir: paths.historyDir,
      composition: testStoreComposition(),
    });
    const session = await kernel.sessions.createSession("Draft State", {
      ownerUserId: "account_owner",
      visibility: "private",
    });
    const now = new Date().toISOString();
    const auth = new TestAuthProvider();
    const control = await startControlServer(
      {
        entry: {
          path: projectDir,
          name: "control-server-chat-draft-state-test",
          createdAt: now,
          lastOpenedAt: now,
        },
        kernel,
        db,
        appServer: { shutdown: async () => {} } as never,
        devServer: { shutdown: async () => {} } as never,
        commandRunner: { shutdown: async () => {} } as never,
        rebuild: () => {},
      },
      0,
      { authProvider: auth, mountRoutes: [mountVerificationRoutes] },
    );

    try {
      const base = `http://127.0.0.1:${control.server.addr.port}`;
      const positions = { "handler:hello": { line: 12, column: 4 } };
      const nav = { entries: [null, "route:/"], cursor: 1 };
      const editorDrafts = { "handler:hello": "draft source" };
      const longText = "x".repeat(100_005);

      assertEquals(
        (await fetch(`${base}/api/editor-positions`, {
          method: "PUT",
          headers: jsonAuthHeaders(auth),
          body: JSON.stringify(positions),
        })).status,
        200,
      );
      assertEquals(
        (await fetch(`${base}/api/nav-history`, {
          method: "PUT",
          headers: jsonAuthHeaders(auth),
          body: JSON.stringify(nav),
        })).status,
        200,
      );
      assertEquals(
        (await fetch(`${base}/api/editor-drafts`, {
          method: "PUT",
          headers: jsonAuthHeaders(auth),
          body: JSON.stringify(editorDrafts),
        })).status,
        200,
      );
      assertEquals(
        (await fetch(`${base}/api/chat-drafts/${session.id}`, {
          method: "PUT",
          headers: jsonAuthHeaders(auth),
          body: JSON.stringify({ text: longText }),
        })).status,
        200,
      );

      let localState = JSON.parse(readFileSync(paths.localState, "utf-8"));
      assertEquals(localState.editor_positions, positions);
      assertEquals(localState.nav_history, nav);
      assertEquals(localState.editor_drafts, editorDrafts);
      assertEquals(localState.chat_drafts[session.id].length, 100_000);

      assertEquals(
        (await fetch(`${base}/api/chat-drafts/${session.id}`, {
          method: "DELETE",
          headers: authHeaders(auth),
        })).status,
        200,
      );
      localState = JSON.parse(readFileSync(paths.localState, "utf-8"));
      assertEquals(localState.chat_drafts, undefined);
      assertEquals(localState.editor_positions, positions);
      assertEquals(localState.nav_history, nav);
      assertEquals(localState.editor_drafts, editorDrafts);
    } finally {
      await control.server.shutdown();
      await db.close();
      rmSync(projectDir, { recursive: true, force: true });
    }
  },
});

Deno.test({
  sanitizeResources: false,
  sanitizeOps: false,
  name: "inspect exposes runtime metadata",
  fn: async () => {
    const db = await Database.create({ driver: "pglite" });
    const kernel = new Kernel(db, { composition: testStoreComposition() });
    const now = new Date().toISOString();
    const auth = new TestAuthProvider();
    const control = await startControlServer(
      {
        entry: {
          path: "/tmp/genie-control-server-runtime-test",
          name: "control-server-runtime-test",
          createdAt: now,
          lastOpenedAt: now,
        },
        kernel,
        db,
        appServer: { shutdown: async () => {} } as never,
        devServer: { shutdown: async () => {} } as never,
        commandRunner: { shutdown: async () => {} } as never,
        rebuild: () => {},
      },
      0,
      { authProvider: auth, mountRoutes: [mountVerificationRoutes] },
    );

    try {
      const port = control.server.addr.port;
      const res = await fetch(`http://127.0.0.1:${port}/api/inspect`, {
        headers: authHeaders(auth),
      });
      const body = await res.json();

      assertEquals(res.status, 200);
      assertEquals(body.runtime.id, "typescript");
      assertEquals(body.runtime.defaultLanguage, "typescript");
      assertEquals(body.runtime.capabilities.executionMode, "in-process");
      assertEquals(
        body.runtimeDependencies.map((dependency: { name: string }) =>
          dependency.name
        ),
        ["hono", "@electric-sql/pglite", "@hono/node-server"],
      );
      assertEquals(
        body.runtimeDependencies.every((
          dependency: { appImportable: boolean },
        ) => dependency.appImportable === false),
        true,
      );
      assertEquals(
        body.runtimeDependencies.some((
          dependency: { name: string },
        ) => dependency.name === "ai" || dependency.name === "typescript"),
        false,
      );
    } finally {
      await control.server.shutdown();
      await db.close();
    }
  },
});

// B1c: register the canonical knowledge-graph fixture — route GET /x → handler h →
// fnA → fnB, with fnA reading config "flag". Mirrors core/knowledge-graph_test.ts so
// the API answers agree with the graph module.
function registerBlastFixture(kernel: Kernel): void {
  kernel.functions.register("fnB", "function fnB(){ return 1; }", () => 1);
  kernel.functions.register(
    "fnA",
    'function fnA(){ return functions.call("fnB") + config.get("flag"); }',
    () => 1,
  );
  kernel.handlers.register(
    "h",
    'async function h(c){ return functions.call("fnA"); }',
    () => Promise.resolve(new Response()),
    undefined,
    "m",
  );
  kernel.routes.register("GET", "/x", "h", undefined, "m");
}

Deno.test({
  sanitizeResources: false,
  sanitizeOps: false,
  name:
    "blast-radius API reports dependents; zero/unknown is a 200 with empty arrays",
  fn: async () => {
    const db = await Database.create({ driver: "pglite" });
    const kernel = new Kernel(db, { composition: testStoreComposition() });
    registerBlastFixture(kernel);
    const now = new Date().toISOString();
    const auth = new TestAuthProvider();
    const control = await startControlServer(
      {
        entry: {
          path: "/tmp/genie-control-server-blast-radius-test",
          name: "control-server-blast-radius-test",
          createdAt: now,
          lastOpenedAt: now,
        },
        kernel,
        db,
        appServer: { shutdown: async () => {} } as never,
        devServer: { shutdown: async () => {} } as never,
        commandRunner: { shutdown: async () => {} } as never,
        rebuild: () => {},
      },
      0,
      { authProvider: auth },
    );

    try {
      const base = `http://127.0.0.1:${control.server.addr.port}`;
      const get = (path: string) =>
        fetch(`${base}${path}`, { headers: authHeaders(auth) });

      // fnB's transitive dependents: fnA, handler h, route GET /x → 3. Direct = fnA.
      const shared = await get("/api/analysis/blast-radius/function/fnB");
      assertEquals(shared.status, 200);
      const sharedBody = await shared.json();
      assertEquals(sharedBody.counts, { direct: 1, transitive: 3 });
      assertEquals(sharedBody.direct.map((r: { name: string }) => r.name), [
        "fnA",
      ]);
      assertEquals(
        sharedBody.transitive
          .map((r: { category: string; name: string }) =>
            `${r.category}:${r.name}`
          )
          .sort(),
        ["function:fnA", "handler:h", "route:GET /x"],
      );

      // A leaf nothing depends on: empty arrays, zero counts, HTTP 200 — not an error.
      const leaf = await get("/api/analysis/blast-radius/route/GET%20%2Fx");
      assertEquals(leaf.status, 200);
      assertEquals(await leaf.json(), {
        direct: [],
        transitive: [],
        counts: { direct: 0, transitive: 0 },
      });

      // An unknown name is empty + 200, never a 404.
      const unknown = await get("/api/analysis/blast-radius/function/ghost");
      assertEquals(unknown.status, 200);
      assertEquals(await unknown.json(), {
        direct: [],
        transitive: [],
        counts: { direct: 0, transitive: 0 },
      });

      // Read-only invariant: querying does not mutate registry state.
      assertEquals(kernel.functions.list().length, 2);
    } finally {
      await control.server.shutdown();
      await db.close();
    }
  },
});

Deno.test({
  sanitizeResources: false,
  sanitizeOps: false,
  name:
    "archiving or soft-deleting the current session clears active chat state",
  fn: async () => {
    const db = await Database.create({ driver: "pglite" });
    const kernel = new Kernel(db, { composition: testStoreComposition() });
    const auth = new TestAuthProvider();
    const sessionToken = cookieFor(
      auth,
      accountSession("acct_test_owner", "Test Owner"),
    )
      .replace(/^genie_session=/, "")
      .split(";")[0];
    const headers = {
      Cookie: `genie_session=${sessionToken}`,
    };
    const softDeleted = await kernel.sessions.createSession("Soft Delete", {
      ownerUserId: "acct_test_owner",
    });
    await kernel.sessions.addMessage({
      sessionId: softDeleted.id,
      role: "user",
      content: "keep this history",
    });
    const archived = await kernel.sessions.createSession("Archive", {
      ownerUserId: "acct_test_owner",
    });
    const fakeChat = new SessionRecordingChat(kernel, softDeleted.id);
    const now = new Date().toISOString();
    const control = await startControlServer(
      {
        entry: {
          path: "/tmp/genie-control-server-chat-archive-test",
          name: "control-server-chat-archive-test",
          createdAt: now,
          lastOpenedAt: now,
        },
        kernel,
        db,
        appServer: { shutdown: async () => {} } as never,
        devServer: { shutdown: async () => {} } as never,
        commandRunner: { shutdown: async () => {} } as never,
        rebuild: () => {},
      },
      0,
      {
        authProvider: auth,
        chatFactory: () => fakeChat,
      },
    );

    try {
      const base = `http://127.0.0.1:${control.server.addr.port}`;
      const deletedRes = await fetch(
        `${base}/api/sessions/${softDeleted.id}`,
        { method: "DELETE", headers },
      );
      assertEquals(deletedRes.status, 200);
      assertEquals(await deletedRes.json(), {
        ok: true,
        archived: true,
        deleted: false,
      });
      assertEquals(fakeChat.getCurrentSessionId(), null);
      assertEquals(fakeChat.clearCurrentSessionCount, 1);
      assertEquals(fakeChat.clearContextCount, 1);
      assertEquals(
        (await kernel.sessions.getSession(softDeleted.id))?.archived,
        true,
      );
      assert((await kernel.sessions.getSession(softDeleted.id))?.endedAt);
      assertEquals(
        (await fetch(`${base}/api/sessions/current`, { headers })).status,
        404,
      );

      await fakeChat.resumeSession(archived.id);
      const archiveRes = await fetch(
        `${base}/api/sessions/${archived.id}/archive`,
        { method: "POST", headers },
      );
      assertEquals(archiveRes.status, 200);
      assertEquals(fakeChat.getCurrentSessionId(), null);
      assertEquals(fakeChat.clearCurrentSessionCount, 2);
      assertEquals(fakeChat.clearContextCount, 2);
      assertEquals(
        (await kernel.sessions.getSession(archived.id))?.archived,
        true,
      );
      assert((await kernel.sessions.getSession(archived.id))?.endedAt);
      assertEquals(
        (await fetch(`${base}/api/sessions/current`, { headers })).status,
        404,
      );
    } finally {
      await control.server.shutdown();
      await db.close();
    }
  },
});

Deno.test({
  sanitizeResources: false,
  sanitizeOps: false,
  name: "chat websocket realigns to message session before send",
  fn: async () => {
    const db = await Database.create({ driver: "pglite" });
    const kernel = new Kernel(db, { composition: testStoreComposition() });
    const visibleSession = await kernel.sessions.createSession(
      "Visible Session",
    );
    const freshSession = await kernel.sessions.createSession("Fresh Session");
    const fakeChat = new SessionRecordingChat(kernel, freshSession.id);
    const auth = new TestAuthProvider();
    const sessionToken = cookieFor(
      auth,
      accountSession("acct_test_owner", "Test Owner"),
    )
      .replace(/^genie_session=/, "")
      .split(";")[0];
    const now = new Date().toISOString();
    const control = await startControlServer(
      {
        entry: {
          path: "/tmp/genie-control-server-chat-session-test",
          name: "control-server-chat-session-test",
          createdAt: now,
          lastOpenedAt: now,
        },
        kernel,
        db,
        appServer: { shutdown: async () => {} } as never,
        devServer: { shutdown: async () => {} } as never,
        commandRunner: { shutdown: async () => {} } as never,
        rebuild: () => {},
      },
      0,
      {
        authProvider: auth,
        chatFactory: () => fakeChat,
      },
    );

    let ws: WebSocket | null = null;
    try {
      const port = control.server.addr.port;
      ws = new WebSocket(`ws://127.0.0.1:${port}/chat`, [
        `genie-session.${sessionToken}`,
      ]);
      await waitForSocketOpen(ws);
      ws.send(JSON.stringify({
        type: "user_message",
        sessionId: visibleSession.id,
        content: "yes",
      }));

      await waitFor(() => fakeChat.sentMessages.length === 1);
      assertEquals(fakeChat.resumedSessionIds, [visibleSession.id]);
      assertEquals(fakeChat.sentSessionIds, [visibleSession.id]);
      assertEquals(fakeChat.sentMessages, ["yes"]);
    } finally {
      ws?.close();
      await control.server.shutdown();
      await db.close();
    }
  },
});

Deno.test({
  sanitizeResources: false,
  sanitizeOps: false,
  name:
    "deferred session compaction queues while chat is busy and flushes after turn",
  fn: async () => {
    const db = await Database.create({ driver: "pglite" });
    const kernel = new Kernel(db, { composition: testStoreComposition() });
    const session = await kernel.sessions.createSession("Busy Session", {
      ownerUserId: "acct_test_owner",
    });
    await kernel.sessions.addMessage({
      sessionId: session.id,
      role: "user",
      content: "keep the active build context",
    });
    const blocker = deferred();
    const fakeChat = new SessionRecordingChat(kernel, session.id);
    fakeChat.sendMessageBlocker = blocker.promise;
    const auth = new TestAuthProvider();
    const sessionToken = cookieFor(
      auth,
      accountSession("acct_test_owner", "Test Owner"),
    )
      .replace(/^genie_session=/, "")
      .split(";")[0];
    const now = new Date().toISOString();
    const control = await startControlServer(
      {
        entry: {
          path: "/tmp/genie-control-server-deferred-compact-test",
          name: "control-server-deferred-compact-test",
          createdAt: now,
          lastOpenedAt: now,
        },
        kernel,
        db,
        appServer: { shutdown: async () => {} } as never,
        devServer: { shutdown: async () => {} } as never,
        commandRunner: { shutdown: async () => {} } as never,
        rebuild: () => {},
      },
      0,
      {
        authProvider: auth,
        chatFactory: () => fakeChat,
      },
    );

    let ws: WebSocket | null = null;
    try {
      const port = control.server.addr.port;
      const base = `http://127.0.0.1:${port}`;
      ws = new WebSocket(`ws://127.0.0.1:${port}/chat`, [
        `genie-session.${sessionToken}`,
      ]);
      await waitForSocketOpen(ws);
      ws.send(JSON.stringify({
        type: "user_message",
        sessionId: session.id,
        content: "continue building",
      }));

      await waitFor(() => fakeChat.sentMessages.length === 1);
      const compactRes = await fetch(`${base}/api/sessions/compact`, {
        method: "POST",
        headers: jsonAuthHeaders(auth, "acct_test_owner"),
        body: JSON.stringify({ defer: true }),
      });
      assertEquals(compactRes.status, 202);
      const queued = await compactRes.json();
      assertEquals(queued.queued, true);
      assertEquals(queued.coalesced, false);
      assertEquals(queued.sessionId, session.id);
      assertEquals(fakeChat.abortCount, 0);
      assertEquals(fakeChat.compactSummaries.length, 0);

      blocker.resolve();
      await waitFor(() => fakeChat.compactSummaries.length === 1);
      assertStringIncludes(
        fakeChat.compactSummaries[0]!,
        "keep the active build context",
      );
      const status = await (await fetch(`${base}/api/chat/status`, {
        headers: authHeaders(auth, "acct_test_owner"),
      })).json();
      assertEquals(status.busy, false);
    } finally {
      ws?.close();
      await control.server.shutdown();
      await db.close();
    }
  },
});

Deno.test({
  sanitizeResources: false,
  sanitizeOps: false,
  name: "deferred session compaction coalesces duplicate requests",
  fn: async () => {
    const db = await Database.create({ driver: "pglite" });
    const kernel = new Kernel(db, { composition: testStoreComposition() });
    const session = await kernel.sessions.createSession("Busy Session", {
      ownerUserId: "acct_test_owner",
    });
    await kernel.sessions.addMessage({
      sessionId: session.id,
      role: "user",
      content: "compact this once",
    });
    const blocker = deferred();
    const fakeChat = new SessionRecordingChat(kernel, session.id);
    fakeChat.sendMessageBlocker = blocker.promise;
    const auth = new TestAuthProvider();
    const sessionToken = cookieFor(
      auth,
      accountSession("acct_test_owner", "Test Owner"),
    )
      .replace(/^genie_session=/, "")
      .split(";")[0];
    const now = new Date().toISOString();
    const control = await startControlServer(
      {
        entry: {
          path: "/tmp/genie-control-server-deferred-compact-coalesce-test",
          name: "control-server-deferred-compact-coalesce-test",
          createdAt: now,
          lastOpenedAt: now,
        },
        kernel,
        db,
        appServer: { shutdown: async () => {} } as never,
        devServer: { shutdown: async () => {} } as never,
        commandRunner: { shutdown: async () => {} } as never,
        rebuild: () => {},
      },
      0,
      {
        authProvider: auth,
        chatFactory: () => fakeChat,
      },
    );

    let ws: WebSocket | null = null;
    try {
      const port = control.server.addr.port;
      const base = `http://127.0.0.1:${port}`;
      ws = new WebSocket(`ws://127.0.0.1:${port}/chat`, [
        `genie-session.${sessionToken}`,
      ]);
      await waitForSocketOpen(ws);
      ws.send(JSON.stringify({
        type: "user_message",
        sessionId: session.id,
        content: "continue building",
      }));

      await waitFor(() => fakeChat.sentMessages.length === 1);
      const first = await fetch(`${base}/api/sessions/compact`, {
        method: "POST",
        headers: jsonAuthHeaders(auth, "acct_test_owner"),
        body: JSON.stringify({ defer: true }),
      });
      const second = await fetch(`${base}/api/sessions/compact`, {
        method: "POST",
        headers: jsonAuthHeaders(auth, "acct_test_owner"),
        body: JSON.stringify({ defer: true }),
      });
      assertEquals(first.status, 202);
      assertEquals(second.status, 202);
      assertEquals((await first.json()).coalesced, false);
      assertEquals((await second.json()).coalesced, true);

      blocker.resolve();
      await waitFor(() => fakeChat.compactSummaries.length === 1);
    } finally {
      ws?.close();
      await control.server.shutdown();
      await db.close();
    }
  },
});

Deno.test({
  sanitizeResources: false,
  sanitizeOps: false,
  name: "chat websocket clears archived implicit active session before send",
  fn: async () => {
    const db = await Database.create({ driver: "pglite" });
    const kernel = new Kernel(db, { composition: testStoreComposition() });
    const session = await kernel.sessions.createSession("Archived Active", {
      ownerUserId: "acct_test_owner",
    });
    await kernel.sessions.archiveSession(session.id);
    const fakeChat = new SessionRecordingChat(kernel, session.id);
    const auth = new TestAuthProvider();
    const sessionToken = cookieFor(
      auth,
      accountSession("acct_test_owner", "Test Owner"),
    )
      .replace(/^genie_session=/, "")
      .split(";")[0];
    const now = new Date().toISOString();
    const control = await startControlServer(
      {
        entry: {
          path: "/tmp/genie-control-server-chat-implicit-archive-test",
          name: "control-server-chat-implicit-archive-test",
          createdAt: now,
          lastOpenedAt: now,
        },
        kernel,
        db,
        appServer: { shutdown: async () => {} } as never,
        devServer: { shutdown: async () => {} } as never,
        commandRunner: { shutdown: async () => {} } as never,
        rebuild: () => {},
      },
      0,
      {
        authProvider: auth,
        chatFactory: () => fakeChat,
      },
    );

    let ws: WebSocket | null = null;
    try {
      const port = control.server.addr.port;
      ws = new WebSocket(`ws://127.0.0.1:${port}/chat`, [
        `genie-session.${sessionToken}`,
      ]);
      await waitForSocketOpen(ws);
      ws.send(JSON.stringify({
        type: "user_message",
        sessionId: null,
        content: "new thread",
      }));

      await waitFor(() => fakeChat.sentMessages.length === 1);
      assertEquals(fakeChat.clearCurrentSessionCount, 1);
      assertEquals(fakeChat.clearContextCount, 1);
      assertEquals(fakeChat.sentSessionIds, [null]);
      assertEquals(fakeChat.sentMessages, ["new thread"]);
      assert((await kernel.sessions.getSession(session.id))?.endedAt);
    } finally {
      ws?.close();
      await control.server.shutdown();
      await db.close();
    }
  },
});

Deno.test({
  sanitizeResources: false,
  sanitizeOps: false,
  name: "chat websocket rejects explicit archived session before send",
  fn: async () => {
    const db = await Database.create({ driver: "pglite" });
    const kernel = new Kernel(db, { composition: testStoreComposition() });
    const session = await kernel.sessions.createSession("Archived Target", {
      ownerUserId: "acct_test_owner",
    });
    await kernel.sessions.archiveSession(session.id);
    const fakeChat = new SessionRecordingChat(kernel, session.id);
    const auth = new TestAuthProvider();
    const sessionToken = cookieFor(
      auth,
      accountSession("acct_test_owner", "Test Owner"),
    )
      .replace(/^genie_session=/, "")
      .split(";")[0];
    const now = new Date().toISOString();
    const control = await startControlServer(
      {
        entry: {
          path: "/tmp/genie-control-server-chat-explicit-archive-test",
          name: "control-server-chat-explicit-archive-test",
          createdAt: now,
          lastOpenedAt: now,
        },
        kernel,
        db,
        appServer: { shutdown: async () => {} } as never,
        devServer: { shutdown: async () => {} } as never,
        commandRunner: { shutdown: async () => {} } as never,
        rebuild: () => {},
      },
      0,
      {
        authProvider: auth,
        chatFactory: () => fakeChat,
      },
    );

    let ws: WebSocket | null = null;
    try {
      const port = control.server.addr.port;
      ws = new WebSocket(`ws://127.0.0.1:${port}/chat`, [
        `genie-session.${sessionToken}`,
      ]);
      const errorMessage = new Promise<string>((resolve) => {
        ws!.onmessage = (evt) => {
          const event = JSON.parse(String(evt.data)) as {
            type?: string;
            text?: string;
          };
          if (event.type === "error") resolve(event.text ?? "");
        };
      });
      await waitForSocketOpen(ws);
      ws.send(JSON.stringify({
        type: "user_message",
        sessionId: session.id,
        content: "should not write",
      }));

      assertStringIncludes(
        await errorMessage,
        "Archived sessions must be unarchived",
      );
      assertEquals(fakeChat.sentMessages, []);
    } finally {
      ws?.close();
      await control.server.shutdown();
      await db.close();
    }
  },
});

Deno.test({
  sanitizeResources: false,
  sanitizeOps: false,
  name: "chat websocket forwards document refs to the chat runtime",
  fn: async () => {
    const db = await Database.create({ driver: "pglite" });
    const kernel = new Kernel(db, { composition: testStoreComposition() });
    const session = await kernel.sessions.createSession("Docs Session");
    const fakeChat = new SessionRecordingChat(kernel, session.id);
    const auth = new TestAuthProvider();
    const sessionToken = cookieFor(
      auth,
      accountSession("acct_test_owner", "Test Owner"),
    )
      .replace(/^genie_session=/, "")
      .split(";")[0];
    const now = new Date().toISOString();
    const control = await startControlServer(
      {
        entry: {
          path: "/tmp/genie-control-server-chat-docrefs-test",
          name: "control-server-chat-docrefs-test",
          createdAt: now,
          lastOpenedAt: now,
        },
        kernel,
        db,
        appServer: { shutdown: async () => {} } as never,
        devServer: { shutdown: async () => {} } as never,
        commandRunner: { shutdown: async () => {} } as never,
        rebuild: () => {},
      },
      0,
      {
        authProvider: auth,
        chatFactory: () => fakeChat,
      },
    );

    let ws: WebSocket | null = null;
    try {
      const port = control.server.addr.port;
      ws = new WebSocket(`ws://127.0.0.1:${port}/chat`, [
        `genie-session.${sessionToken}`,
      ]);
      await waitForSocketOpen(ws);
      ws.send(JSON.stringify({
        type: "user_message",
        sessionId: session.id,
        content: "see @[document:doc_1]",
        documentRefs: [{ id: "doc_1" }],
      }));

      await waitFor(() => fakeChat.sentMessages.length === 1);
      // The parsed frame's documentRefs must reach sendMessage as the 7th arg.
      assertEquals(fakeChat.sentDocumentRefs, [[{ id: "doc_1" }]]);
    } finally {
      ws?.close();
      await control.server.shutdown();
      await db.close();
    }
  },
});

Deno.test({
  sanitizeResources: false,
  sanitizeOps: false,
  name: "cloud mode rejects unsigned API requests",
  fn: async () => {
    const db = await Database.create({ driver: "pglite" });
    const kernel = new Kernel(db, { composition: testStoreComposition() });
    const auth = new TestAuthProvider();
    const now = new Date().toISOString();
    const control = await startControlServer(
      {
        entry: {
          path: "/tmp/genie-control-auth-cloud-test",
          name: "control-auth-cloud-test",
          createdAt: now,
          lastOpenedAt: now,
        },
        kernel,
        db,
        appServer: { shutdown: async () => {} } as never,
        devServer: { shutdown: async () => {} } as never,
        commandRunner: { shutdown: async () => {} } as never,
        rebuild: () => {},
      },
      0,
      { authProvider: auth },
    );

    try {
      const res = await fetch(
        `http://127.0.0.1:${control.server.addr.port}/api/inspect`,
      );
      assertEquals(res.status, 401);
    } finally {
      await control.server.shutdown();
      await db.close();
    }
  },
});

Deno.test({
  sanitizeResources: false,
  sanitizeOps: false,
  name: "auth me defaults to local user",
  fn: async () => {
    const control = await startControlServer(null, 0);
    try {
      const res = await fetch(
        `http://127.0.0.1:${control.server.addr.port}/api/auth/me`,
      );
      const body = await res.json();
      assertEquals(res.status, 200);
      assertEquals(body.user.id, "acct_test_owner");
      assertEquals(body.accountEntitlementsSupported, false);
    } finally {
      await control.server.shutdown();
    }
  },
});

Deno.test({
  sanitizeResources: false,
  sanitizeOps: false,
  name: "auth me rejects unsigned users",
  fn: async () => {
    const auth = new TestAuthProvider();
    const control = await startControlServer(null, 0, { authProvider: auth });
    try {
      const res = await fetch(
        `http://127.0.0.1:${control.server.addr.port}/api/auth/me`,
      );
      const body = await res.json();
      assertEquals(res.status, 401);
      assertEquals(body.error, "Unauthorized");
    } finally {
      await control.server.shutdown();
    }
  },
});

Deno.test({
  sanitizeResources: false,
  sanitizeOps: false,
  name: "private sessions are owner-only and project sessions are visible",
  fn: async () => {
    const db = await Database.create({ driver: "pglite" });
    const kernel = new Kernel(db, { composition: testStoreComposition() });
    const owner = accountSession("owner", "Owner");
    const other = accountSession("other", "Other");
    const privateSession = await kernel.sessions.createSession("Private", {
      ownerUserId: "account_owner",
      visibility: "private",
    });
    await kernel.sessions.addMessage({
      sessionId: privateSession.id,
      role: "user",
      content: "secret transcript",
      authorUserId: "account_owner",
    });
    for (let i = 0; i < 105; i++) {
      await kernel.sessions.addMessage({
        sessionId: privateSession.id,
        role: "assistant",
        content: `restored message ${i}`,
        authorUserId: "account_owner",
      });
    }
    const projectSession = await kernel.sessions.createSession("Project", {
      ownerUserId: "account_owner",
      visibility: "project",
    });
    const auth = new TestAuthProvider();
    const ownerCookie = cookieFor(auth, owner);
    const otherCookie = cookieFor(auth, other);
    const now = new Date().toISOString();
    const projectPath = "/tmp/genie-control-privacy-test";
    const control = await startControlServer(
      {
        entry: {
          path: projectPath,
          name: "control-privacy-test",
          createdAt: now,
          lastOpenedAt: now,
        },
        kernel,
        db,
        appServer: { shutdown: async () => {} } as never,
        devServer: { shutdown: async () => {} } as never,
        commandRunner: { shutdown: async () => {} } as never,
        rebuild: () => {},
      },
      0,
      { authProvider: auth },
    );

    try {
      const base = `http://127.0.0.1:${control.server.addr.port}`;
      const ownerRead = await fetch(
        `${base}/api/sessions/${privateSession.id}/messages`,
        { headers: { Cookie: ownerCookie } },
      );
      assertEquals(ownerRead.status, 200);
      const defaultMessages = await ownerRead.json();
      assertEquals(defaultMessages.length, 100);
      assertEquals(defaultMessages[0].content, "secret transcript");

      const ownerReadAll = await fetch(
        `${base}/api/sessions/${privateSession.id}/messages?limit=all`,
        { headers: { Cookie: ownerCookie } },
      );
      assertEquals(ownerReadAll.status, 200);
      const allMessages = await ownerReadAll.json();
      assertEquals(allMessages.length, 106);
      assertEquals(allMessages.at(-1).content, "restored message 104");

      const otherRead = await fetch(
        `${base}/api/sessions/${privateSession.id}/messages`,
        { headers: { Cookie: otherCookie } },
      );
      assertEquals(otherRead.status, 403);

      const listed = await fetch(`${base}/api/sessions`, {
        headers: { Cookie: otherCookie },
      });
      const sessions = await listed.json();
      assertEquals(
        sessions.map((s: { id: string }) => s.id).includes(privateSession.id),
        false,
      );
      assertEquals(
        sessions.map((s: { id: string }) => s.id).includes(projectSession.id),
        true,
      );

      const search = await fetch(`${base}/api/messages/search?q=secret`, {
        headers: { Cookie: otherCookie },
      });
      assertEquals(await search.json(), []);

      const contextRead = await fetch(`${base}/api/context/session`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: otherCookie,
        },
        body: JSON.stringify({
          projectPath,
          sessionId: privateSession.id,
        }),
      });
      assertEquals(contextRead.status, 403);

      const projectContext = await fetch(`${base}/api/context/project`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: otherCookie,
        },
        body: JSON.stringify({ projectPath }),
      });
      const projectContextBody = await projectContext.json();
      assertEquals(projectContext.status, 200);
      assertEquals(
        projectContextBody.project.sessions.map((s: { id: string }) => s.id)
          .includes(privateSession.id),
        false,
      );
      assertEquals(
        projectContextBody.project.sessions.map((s: { id: string }) => s.id)
          .includes(projectSession.id),
        true,
      );
    } finally {
      await control.server.shutdown();
      await db.close();
    }
  },
});

Deno.test({
  sanitizeResources: false,
  sanitizeOps: false,
  name: "session list filters readable sessions before pagination",
  fn: async () => {
    const db = await Database.create({ driver: "pglite" });
    const kernel = new Kernel(db, { composition: testStoreComposition() });
    const accessible = await kernel.sessions.createSession("Accessible", {
      ownerUserId: "account_other",
      visibility: "private",
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    const privateSession = await kernel.sessions.createSession("Private", {
      ownerUserId: "account_owner",
      visibility: "private",
    });
    const auth = new TestAuthProvider();
    const otherCookie = cookieFor(auth, accountSession("other", "Other"));
    const now = new Date().toISOString();
    const control = await startControlServer(
      {
        entry: {
          path: "/tmp/genie-control-pagination-privacy-test",
          name: "control-pagination-privacy-test",
          createdAt: now,
          lastOpenedAt: now,
        },
        kernel,
        db,
        appServer: { shutdown: async () => {} } as never,
        devServer: { shutdown: async () => {} } as never,
        commandRunner: { shutdown: async () => {} } as never,
        rebuild: () => {},
      },
      0,
      { authProvider: auth },
    );

    try {
      const base = `http://127.0.0.1:${control.server.addr.port}`;
      const res = await fetch(`${base}/api/sessions?limit=1&offset=0`, {
        headers: { Cookie: otherCookie },
      });
      const sessions = await res.json();
      assertEquals(res.status, 200);
      assertEquals(sessions.map((s: { id: string }) => s.id), [accessible.id]);
      assertEquals(
        sessions.map((s: { id: string }) => s.id).includes(privateSession.id),
        false,
      );
    } finally {
      await control.server.shutdown();
      await db.close();
    }
  },
});

Deno.test({
  sanitizeResources: false,
  sanitizeOps: false,
  name: "session list includes verification summaries for open changesets",
  fn: async () => {
    const db = await Database.create({ driver: "pglite" });
    const kernel = new Kernel(db, { composition: testComposition() });
    const attentionSession = await kernel.sessions.createSession("Attention");
    const pendingSession = await kernel.sessions.createSession("Pending");
    const verifiedSession = await kernel.sessions.createSession("Verified");
    const now = new Date().toISOString();
    const plan = (stepStatus: "pending" | "done" = "done") => ({
      summary: "Plan",
      steps: [{
        id: "step_1",
        description: "Implement",
        status: stepStatus,
      }],
      acceptanceCriteria: [{
        id: "claim_1",
        text: "works",
        source: "user" as const,
        priority: "must" as const,
      }],
      verificationPlan: [{
        id: "check_1",
        claimIds: ["claim_1"],
        kind: "unit" as const,
        description: "Run tests",
      }],
      verificationRuns: [],
      attestations: [],
    });

    const attention = await kernel.changesets.create({
      sessionId: attentionSession.id,
      title: "Needs attention",
      plan: plan("pending"),
    });
    await kernel.changesets.approve(attention.id);
    await kernel.changesets.startWork(attention.id);
    // One writer per project: create() refuses while another session holds an
    // open changeset. Park each one so the next can be made, then reopen all
    // three, as a project carrying them from before that rule would look.
    const park = (id: string, status: "abandoned" | "in_progress") =>
      db.drizzle.update(genieChangesetsTable).set({ status })
        .where(eq(genieChangesetsTable.id, id));
    await park(attention.id, "abandoned");

    const pending = await kernel.changesets.create({
      sessionId: pendingSession.id,
      title: "Needs verification",
      plan: plan("done"),
    });
    await kernel.changesets.approve(pending.id);
    await kernel.changesets.startWork(pending.id);
    await park(pending.id, "abandoned");

    const verified = await kernel.changesets.create({
      sessionId: verifiedSession.id,
      title: "Verified",
      plan: plan("done"),
    });
    await kernel.changesets.approve(verified.id);
    await kernel.changesets.startWork(verified.id);
    await kernel.changesets.recordVerificationRun(verified.id, {
      status: "passed",
      summary: "Verification passed",
      evidence: [{
        id: "evidence_1",
        kind: "unit",
        summary: "Tests passed",
        status: "passed",
        checkId: "check_1",
        createdAt: now,
      }],
      claimResults: [{
        claimId: "claim_1",
        status: "passed",
        evidenceIds: ["evidence_1"],
      }],
      residualRisks: [],
    });
    await park(attention.id, "in_progress");
    await park(pending.id, "in_progress");

    const control = await startControlServer(
      {
        entry: {
          path: "/tmp/genie-control-session-verification-test",
          name: "control-session-verification-test",
          createdAt: now,
          lastOpenedAt: now,
        },
        kernel,
        db,
        appServer: { shutdown: async () => {} } as never,
        devServer: { shutdown: async () => {} } as never,
        commandRunner: { shutdown: async () => {} } as never,
        rebuild: () => {},
      },
      0,
    );

    try {
      const base = `http://127.0.0.1:${control.server.addr.port}`;
      const res = await fetch(`${base}/api/sessions?limit=20&offset=0`);
      const sessions = await res.json();
      assertEquals(res.status, 200);
      type SessionListRow = {
        id: string;
        verification?: { status: string | null; changesetId?: string };
      };
      const byId = new Map<string, SessionListRow["verification"]>(
        (sessions as SessionListRow[]).map((session) => [
          session.id,
          session.verification,
        ]),
      );
      assertEquals(byId.get(attentionSession.id)?.status, "needs_attention");
      assertEquals(byId.get(attentionSession.id)?.changesetId, attention.id);
      assertEquals(byId.get(pendingSession.id)?.status, "needs_verification");
      assertEquals(byId.get(verifiedSession.id)?.status, "verified");
    } finally {
      await control.server.shutdown();
      await db.close();
    }
  },
});

Deno.test({
  sanitizeResources: false,
  sanitizeOps: false,
  name: "making a session private clears project pins",
  fn: async () => {
    const db = await Database.create({ driver: "pglite" });
    const kernel = new Kernel(db, { composition: testStoreComposition() });
    const owner = accountSession("owner", "Owner");
    const session = await kernel.sessions.createSession("Shared", {
      ownerUserId: "account_owner",
      visibility: "project",
    });
    const message = await kernel.sessions.addMessage({
      sessionId: session.id,
      role: "user",
      content: "project visible note",
      authorUserId: "account_owner",
    });
    await kernel.sessions.pinMessage(message.id, "project");
    const auth = new TestAuthProvider();
    const now = new Date().toISOString();
    const control = await startControlServer(
      {
        entry: {
          path: "/tmp/genie-control-pin-privacy-test",
          name: "control-pin-privacy-test",
          createdAt: now,
          lastOpenedAt: now,
        },
        kernel,
        db,
        appServer: { shutdown: async () => {} } as never,
        devServer: { shutdown: async () => {} } as never,
        commandRunner: { shutdown: async () => {} } as never,
        rebuild: () => {},
      },
      0,
      { authProvider: auth },
    );

    try {
      const base = `http://127.0.0.1:${control.server.addr.port}`;
      const res = await fetch(`${base}/api/sessions/${session.id}/privacy`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Cookie: cookieFor(auth, owner),
        },
        body: JSON.stringify({ visibility: "private" }),
      });

      assertEquals(res.status, 200);
      assertEquals(await kernel.sessions.getProjectPinnedMessages(), []);
    } finally {
      await control.server.shutdown();
      await db.close();
    }
  },
});

Deno.test({
  sanitizeResources: false,
  sanitizeOps: false,
  name: "session list caps client requested limit",
  fn: async () => {
    const db = await Database.create({ driver: "pglite" });
    const kernel = new Kernel(db, { composition: testStoreComposition() });
    for (let i = 0; i < 101; i++) {
      await kernel.sessions.createSession(`Visible ${i}`, {
        ownerUserId: "account_other",
        visibility: "private",
      });
    }
    const auth = new TestAuthProvider();
    const otherCookie = cookieFor(auth, accountSession("other", "Other"));
    const now = new Date().toISOString();
    const control = await startControlServer(
      {
        entry: {
          path: "/tmp/genie-control-session-limit-test",
          name: "control-session-limit-test",
          createdAt: now,
          lastOpenedAt: now,
        },
        kernel,
        db,
        appServer: { shutdown: async () => {} } as never,
        devServer: { shutdown: async () => {} } as never,
        commandRunner: { shutdown: async () => {} } as never,
        rebuild: () => {},
      },
      0,
      { authProvider: auth },
    );

    try {
      const base = `http://127.0.0.1:${control.server.addr.port}`;
      const res = await fetch(`${base}/api/sessions?limit=999&offset=0`, {
        headers: { Cookie: otherCookie },
      });
      const sessions = await res.json();
      assertEquals(res.status, 200);
      assertEquals(sessions.length, 100);
    } finally {
      await control.server.shutdown();
      await db.close();
    }
  },
});

Deno.test({
  sanitizeResources: false,
  sanitizeOps: false,
  name: "chat websocket clears unreadable active session before send",
  fn: async () => {
    const db = await Database.create({ driver: "pglite" });
    const kernel = new Kernel(db, { composition: testStoreComposition() });
    const privateSession = await kernel.sessions.createSession("Private", {
      ownerUserId: "account_owner",
      visibility: "private",
    });
    const fakeChat = new SessionRecordingChat(kernel, privateSession.id);
    const auth = new TestAuthProvider();
    const cookie = cookieFor(auth, accountSession("other", "Other"));
    const now = new Date().toISOString();
    const control = await startControlServer(
      {
        entry: {
          path: "/tmp/genie-control-chat-owner-test",
          name: "control-chat-owner-test",
          createdAt: now,
          lastOpenedAt: now,
        },
        kernel,
        db,
        appServer: { shutdown: async () => {} } as never,
        devServer: { shutdown: async () => {} } as never,
        commandRunner: { shutdown: async () => {} } as never,
        rebuild: () => {},
      },
      0,
      { authProvider: auth, chatFactory: () => fakeChat },
    );

    let ws: WebSocket | null = null;
    try {
      const port = control.server.addr.port;
      const sessionToken = cookie.replace(/^genie_session=/, "").split(";")[0];
      ws = new WebSocket(`ws://127.0.0.1:${port}/chat`, [
        `genie-session.${sessionToken}`,
      ]);
      await waitForSocketOpen(ws);
      ws.send(JSON.stringify({
        type: "user_message",
        content: "new user's message",
      }));

      await waitFor(() => fakeChat.sentMessages.length === 1);
      assertEquals(fakeChat.sentSessionIds, [null]);
      assertEquals(fakeChat.sentMessages, ["new user's message"]);
    } finally {
      ws?.close();
      await control.server.shutdown();
      await db.close();
    }
  },
});

Deno.test({
  sanitizeResources: false,
  sanitizeOps: false,
  name: "private-session changelog previews are redacted for other users",
  fn: async () => {
    const db = await Database.create({ driver: "pglite" });
    const kernel = new Kernel(db, { composition: testStoreComposition() });
    const privateSession = await kernel.sessions.createSession("Private", {
      ownerUserId: "account_owner",
      visibility: "private",
    });
    await kernel.changelog.record({
      category: "handler",
      key: "hello",
      action: "create",
      beforeSnapshot: null,
      afterSnapshot: { source: "function hello() {}" },
      context: {
        sessionId: privateSession.id,
        turnId: "turn_private",
        userMessage: "build the secret thing",
      },
    });
    const auth = new TestAuthProvider();
    const otherCookie = cookieFor(auth, accountSession("other", "Other"));
    const now = new Date().toISOString();
    const control = await startControlServer(
      {
        entry: {
          path: "/tmp/genie-control-redaction-test",
          name: "control-redaction-test",
          createdAt: now,
          lastOpenedAt: now,
        },
        kernel,
        db,
        appServer: { shutdown: async () => {} } as never,
        devServer: { shutdown: async () => {} } as never,
        commandRunner: { shutdown: async () => {} } as never,
        rebuild: () => {},
      },
      0,
      { authProvider: auth },
    );

    try {
      const res = await fetch(
        `http://127.0.0.1:${control.server.addr.port}/api/changelog/turns`,
        { headers: { Cookie: otherCookie } },
      );
      const turns = await res.json();
      assertEquals(res.status, 200);
      assertEquals(turns[0].userMessage, "Private request.");
      assertEquals(turns[0].changes[0].context.userMessage, "Private request.");
    } finally {
      await control.server.shutdown();
      await db.close();
    }
  },
});

Deno.test({
  sanitizeResources: false,
  sanitizeOps: false,
  name: "missing dev view render logs actionable warning",
  fn: async () => {
    const db = await Database.create({ driver: "pglite" });
    const kernel = new Kernel(db, { composition: testStoreComposition() });
    const now = new Date().toISOString();
    const auth = new TestAuthProvider();
    const control = await startControlServer(
      {
        entry: {
          path: "/tmp/genie-control-server-missing-dev-view-test",
          name: "control-server-missing-dev-view-test",
          createdAt: now,
          lastOpenedAt: now,
        },
        kernel,
        db,
        appServer: { shutdown: async () => {} } as never,
        devServer: { shutdown: async () => {} } as never,
        commandRunner: { shutdown: async () => {} } as never,
        rebuild: () => {},
      },
      0,
      { authProvider: auth, mountRoutes: [mountVerificationRoutes] },
    );

    try {
      const port = control.server.addr.port;
      const res = await fetch(
        `http://127.0.0.1:${port}/api/dev-views/GhostView/render`,
        {
          method: "POST",
          headers: jsonAuthHeaders(auth),
          body: JSON.stringify({ object: {} }),
        },
      );
      const body = await res.json();

      assertEquals(res.status, 404);
      assertEquals(body.code, "DEV_VIEW_NOT_FOUND");
      assertStringIncludes(body.error, 'Dev view "GhostView" not found');
      assertEquals(body.viewName, "GhostView");

      const warnings = kernel.log.query({ level: "warn", limit: 1 });
      assertEquals(warnings.length, 1);
      assertStringIncludes(
        warnings[0]!.message,
        'Dev view "GhostView" not found',
      );
      assertEquals(warnings[0]!.metadata?.viewName, "GhostView");
    } finally {
      await control.server.shutdown();
      await db.close();
    }
  },
});

Deno.test({
  sanitizeResources: false,
  sanitizeOps: false,
  name: "built-in tools endpoint includes project doctor",
  fn: async () => {
    const auth = new TestAuthProvider();
    const control = await startControlServer(null, 0, { authProvider: auth });

    try {
      const base = `http://127.0.0.1:${control.server.addr.port}`;
      const res = await fetch(`${base}/api/tools/builtin`, {
        headers: authHeaders(auth),
      });
      const tools = await res.json() as Array<{ name: string }>;

      assertEquals(res.status, 200);
      assert(
        tools.some((tool) => tool.name === "doctor_project"),
        "expected doctor_project to be listed as a built-in UI tool",
      );
    } finally {
      await control.server.shutdown();
    }
  },
});

Deno.test({
  sanitizeResources: false,
  sanitizeOps: false,
  name: "project doctor and data fixture endpoints expose project workflow",
  fn: async () => {
    const projectDir = await Deno.makeTempDir({
      dir: "/private/tmp",
      prefix: "tideide-control-project-",
    });
    mkdirSync(join(projectDir, ".opentide"), { recursive: true });
    writeFileSync(
      join(projectDir, "opentide.json"),
      JSON.stringify({
        name: "control-project-test",
        createdAt: new Date().toISOString(),
      }) + "\n",
    );

    const db = await Database.create({
      driver: "pglite",
      dataDir: join(projectDir, "data"),
      schemaDir: join(projectDir, ".opentide", "state", "schemas"),
    });
    const kernel = new Kernel(db, {
      historyDir: join(projectDir, ".opentide", "history"),
    });
    kernel.projectDir = projectDir;
    const schema = await db.defineSchema(
      "items",
      "CREATE TABLE items (id SERIAL PRIMARY KEY, name TEXT NOT NULL)",
    );
    if (!schema.ok) throw new Error(schema.error.message);
    await db.execute("INSERT INTO items (name) VALUES ($1)", ["seed"]);

    const now = new Date().toISOString();
    const auth = new TestAuthProvider();
    const control = await startControlServer(
      {
        entry: {
          path: projectDir,
          name: "control-project-test",
          createdAt: now,
          lastOpenedAt: now,
        },
        kernel,
        db,
        appServer: { shutdown: async () => {} } as never,
        devServer: { shutdown: async () => {} } as never,
        commandRunner: { shutdown: async () => {} } as never,
        rebuild: () => {},
      },
      0,
      { authProvider: auth, mountRoutes: [mountVerificationRoutes] },
    );

    try {
      const base = `http://127.0.0.1:${control.server.addr.port}`;
      const doctor = await fetch(`${base}/api/project/doctor`, {
        headers: authHeaders(auth),
      });
      const doctorBody = await doctor.json();
      assertEquals(doctor.status, 200);
      assertEquals(doctorBody.ok, true);
      assertEquals(doctorBody.counts.schemas, 1);

      const consistencyCheck = await fetch(
        `${base}/api/project/consistency-check`,
        {
          headers: authHeaders(auth),
        },
      );
      const consistencyCheckBody = await consistencyCheck.json();
      assertEquals(consistencyCheck.status, 200);
      assertEquals(consistencyCheckBody.ok, true);
      assertEquals(consistencyCheckBody.counts.schemas, 1);

      const exported = await fetch(`${base}/api/project/data/export`, {
        method: "POST",
        headers: jsonAuthHeaders(auth),
        body: JSON.stringify({ name: "seed" }),
      });
      const exportedBody = await exported.json();
      assertEquals(exported.status, 200);
      assertEquals(exportedBody.manifest.tables[0].rowCount, 1);

      const fixtures = await fetch(`${base}/api/project/data/fixtures`, {
        headers: authHeaders(auth),
      });
      const fixturesBody = await fixtures.json();
      assertEquals(fixtures.status, 200);
      assertEquals(fixturesBody.fixtures[0].name, "seed");
      assertEquals(fixturesBody.fixtures[0].rowCount, 1);
      assertEquals(fixturesBody.fixtures[0].tables, 1);
      assertEquals(fixturesBody.fixtures[0].path, "fixtures/seed");
      assertEquals(typeof fixturesBody.fixtures[0].modifiedAt, "string");

      const reset = await fetch(`${base}/api/project/data/reset`, {
        method: "POST",
        headers: jsonAuthHeaders(auth),
        body: JSON.stringify({}),
      });
      assertEquals(reset.status, 200);
      assertEquals(
        Number(
          (await db.query("SELECT COUNT(*) AS count FROM items"))[0]!.count,
        ),
        0,
      );

      const imported = await fetch(`${base}/api/project/data/import`, {
        method: "POST",
        headers: jsonAuthHeaders(auth),
        body: JSON.stringify({ name: "seed" }),
      });
      const importedBody = await imported.json();
      assertEquals(imported.status, 200);
      assertEquals(importedBody.imported, 1);
      assertEquals(
        Number(
          (await db.query("SELECT COUNT(*) AS count FROM items"))[0]!.count,
        ),
        1,
      );

      const missingDelete = await fetch(
        `${base}/api/project/data/fixtures/missing`,
        {
          method: "DELETE",
          headers: authHeaders(auth),
        },
      );
      assertEquals(missingDelete.status, 400);

      const deleted = await fetch(`${base}/api/project/data/fixtures/seed`, {
        method: "DELETE",
        headers: authHeaders(auth),
      });
      const deletedBody = await deleted.json();
      assertEquals(deleted.status, 200);
      assertEquals(deletedBody.deleted, true);
      assertEquals(existsSync(join(projectDir, "fixtures", "seed")), false);

      const fixturesAfterDelete = await fetch(
        `${base}/api/project/data/fixtures`,
        {
          headers: authHeaders(auth),
        },
      );
      const fixturesAfterDeleteBody = await fixturesAfterDelete.json();
      assertEquals(fixturesAfterDelete.status, 200);
      assertEquals(fixturesAfterDeleteBody.fixtures, []);
    } finally {
      await control.server.shutdown();
      await db.close();
      rmSync(projectDir, { recursive: true, force: true });
    }
  },
});

Deno.test({
  sanitizeResources: false,
  sanitizeOps: false,
  name:
    "git endpoints cover missing repo, commit, remote setup, and push failure",
  fn: async () => {
    if (!gitAvailable()) return;
    const projectDir = await Deno.makeTempDir({
      dir: "/private/tmp",
      prefix: "tideide-control-git-",
    });
    mkdirSync(join(projectDir, ".opentide"), { recursive: true });
    writeFileSync(
      join(projectDir, "opentide.json"),
      JSON.stringify({
        name: "control-git-test",
        createdAt: new Date().toISOString(),
      }) + "\n",
    );

    const db = await Database.create({
      driver: "pglite",
      dataDir: join(projectDir, "data"),
      schemaDir: join(projectDir, ".opentide", "state", "schemas"),
    });
    const kernel = new Kernel(db, {
      historyDir: join(projectDir, ".opentide", "history"),
    });
    kernel.projectDir = projectDir;
    const now = new Date().toISOString();
    const auth = new TestAuthProvider();
    const control = await startControlServer(
      {
        entry: {
          path: projectDir,
          name: "control-git-test",
          createdAt: now,
          lastOpenedAt: now,
        },
        kernel,
        db,
        appServer: { shutdown: async () => {} } as never,
        devServer: { shutdown: async () => {} } as never,
        commandRunner: { shutdown: async () => {} } as never,
        rebuild: () => {},
      },
      0,
      { authProvider: auth },
    );

    try {
      const base = `http://127.0.0.1:${control.server.addr.port}`;
      const missing = await fetch(`${base}/api/git/status`, {
        headers: authHeaders(auth),
      });
      const missingBody = await missing.json();
      assertEquals(missing.status, 200);
      assertEquals(missingBody.status.initialized, false);

      const init = await fetch(`${base}/api/git/init`, {
        method: "POST",
        headers: authHeaders(auth),
      });
      assertEquals(init.status, 200);
      runGit(projectDir, ["config", "user.email", "tide-test@example.com"]);
      runGit(projectDir, ["config", "user.name", "Tide Test"]);

      rmSync(join(projectDir, ".gitignore"), { force: true });
      const gitignore = await fetch(`${base}/api/git/gitignore`, {
        method: "POST",
        headers: authHeaders(auth),
      });
      const gitignoreBody = await gitignore.json();
      assertEquals(gitignore.status, 200);
      assertEquals(gitignoreBody.added, true);
      assertStringIncludes(
        readFileSync(join(projectDir, ".gitignore"), "utf-8"),
        ".opentide/caches/",
      );

      writeFileSync(join(projectDir, "README.md"), "# Git test\n");
      const dirty = await fetch(`${base}/api/git/status`, {
        headers: authHeaders(auth),
      });
      const dirtyBody = await dirty.json();
      assertEquals(dirtyBody.status.dirty, true);

      const noRemotePush = await fetch(`${base}/api/git/push`, {
        method: "POST",
        headers: jsonAuthHeaders(auth),
        body: JSON.stringify({}),
      });
      const noRemotePushBody = await noRemotePush.json();
      assertEquals(noRemotePush.status, 400);
      assertEquals(noRemotePushBody.code, "MISSING_REMOTE");

      const commit = await fetch(`${base}/api/git/commit`, {
        method: "POST",
        headers: jsonAuthHeaders(auth),
        body: JSON.stringify({ message: "Initial project commit" }),
      });
      const commitBody = await commit.json();
      assertEquals(commit.status, 200);
      assertEquals(commitBody.status.clean, true);
      assertEquals(
        commitBody.status.latestCommit.subject,
        "Initial project commit",
      );

      writeFileSync(join(projectDir, "CHANGELOG.md"), "# Changes\n");
      const restoreMessageModel = setGitCommitMessageModelCallForTest(
        async () => "Add changelog",
      );
      try {
        const generatedCommit = await fetch(`${base}/api/git/commit`, {
          method: "POST",
          headers: jsonAuthHeaders(auth),
          body: JSON.stringify({}),
        });
        const generatedCommitBody = await generatedCommit.json();
        assertEquals(generatedCommit.status, 200);
        assertEquals(generatedCommitBody.status.clean, true);
        assertEquals(generatedCommitBody.message, "Add changelog");
        assertEquals(generatedCommitBody.messageGenerated, true);
        assertEquals(generatedCommitBody.messageGeneratedBy, "model");
        assertEquals(
          generatedCommitBody.status.latestCommit.subject,
          "Add changelog",
        );
      } finally {
        restoreMessageModel();
      }

      const remote = await fetch(`${base}/api/git/remote`, {
        method: "POST",
        headers: jsonAuthHeaders(auth),
        body: JSON.stringify({
          name: "origin",
          url: join(projectDir, "missing-remote.git"),
        }),
      });
      const remoteBody = await remote.json();
      assertEquals(remote.status, 200);
      assertEquals(remoteBody.status.hasRemote, true);

      const push = await fetch(`${base}/api/git/push`, {
        method: "POST",
        headers: jsonAuthHeaders(auth),
        body: JSON.stringify({ name: "origin" }),
      });
      const pushBody = await push.json();
      assertEquals(push.status, 400);
      assertEquals(pushBody.code, "GIT_COMMAND_FAILED");
    } finally {
      await control.server.shutdown();
      await db.close();
      rmSync(projectDir, { recursive: true, force: true });
    }
  },
});

Deno.test({
  sanitizeResources: false,
  sanitizeOps: false,
  name: "run-progress streams test events as NDJSON",
  fn: async () => {
    const db = await Database.create({ driver: "pglite" });
    const kernel = new Kernel(db, { composition: testStoreComposition() });
    kernel.tests.register(
      "test_stream",
      "async function test_stream() {}",
      async () => {},
    );
    const now = new Date().toISOString();
    const auth = new TestAuthProvider();
    const control = await startControlServer(
      {
        entry: {
          path: "/tmp/genie-control-server-test",
          name: "control-server-test",
          createdAt: now,
          lastOpenedAt: now,
        },
        kernel,
        db,
        appServer: { shutdown: async () => {} } as never,
        devServer: { shutdown: async () => {} } as never,
        commandRunner: { shutdown: async () => {} } as never,
        rebuild: () => {},
      },
      0,
      { authProvider: auth, mountRoutes: [mountVerificationRoutes] },
    );

    try {
      const port = control.server.addr.port;
      const res = await fetch(
        `http://127.0.0.1:${port}/api/tests/run-progress`,
        {
          method: "POST",
          headers: jsonAuthHeaders(auth),
          body: JSON.stringify({ pattern: "test_stream" }),
        },
      );

      assertEquals(res.status, 200);
      assertEquals(res.headers.get("Content-Type"), "application/x-ndjson");

      const events = (await res.text())
        .trim()
        .split("\n")
        .map((line) =>
          JSON.parse(line) as {
            type: string;
            name?: string;
            result?: { name: string };
          }
        );

      assertEquals(events.map((event) => event.type), [
        "cleared",
        "started",
        "result",
        "summary",
      ]);
      assertEquals(events[1]?.name, "test_stream");
      assertEquals(events[2]?.result?.name, "test_stream");
    } finally {
      await control.server.shutdown();
      await db.close();
    }
  },
});

Deno.test({
  sanitizeResources: false,
  sanitizeOps: false,
  name: "changeset context endpoint returns compact current-project context",
  fn: async () => {
    const db = await Database.create({ driver: "pglite" });
    const kernel = new Kernel(db, { composition: testStoreComposition() });
    const cs = await kernel.changesets.create({
      title: "Mention changesets",
      description: "Expose changesets through @ mentions.",
      plan: {
        summary: "Let users ask the agent about a changeset.",
        steps: [
          { id: "step_0", description: "Add mention", status: "pending" },
          {
            id: "step_1",
            description: "Add context endpoint",
            status: "pending",
          },
        ],
        acceptanceCriteria: [{
          id: "claim_changeset_context",
          text: "The context endpoint returns changeset details.",
          source: "agent",
          priority: "must",
        }],
        verificationPlan: [{
          id: "check_changeset_context",
          claimIds: ["claim_changeset_context"],
          kind: "integration",
          description: "Fetch the changeset context endpoint.",
        }],
      },
    });
    await kernel.changelog.record({
      category: "handler",
      key: "sendMessage",
      action: "update",
      beforeSnapshot: { name: "sendMessage", source: "before" },
      afterSnapshot: { name: "sendMessage", source: "after" },
      context: { changesetId: cs.id },
    });
    const now = new Date().toISOString();
    const auth = new TestAuthProvider();
    const control = await startControlServer(
      {
        entry: {
          path: "/tmp/genie-control-server-test",
          name: "control-server-test",
          createdAt: now,
          lastOpenedAt: now,
        },
        kernel,
        db,
        appServer: { shutdown: async () => {} } as never,
        devServer: { shutdown: async () => {} } as never,
        commandRunner: { shutdown: async () => {} } as never,
        rebuild: () => {},
      },
      0,
      { authProvider: auth, mountRoutes: [mountVerificationRoutes] },
    );

    try {
      const port = control.server.addr.port;
      const res = await fetch(
        `http://127.0.0.1:${port}/api/context/changeset`,
        {
          method: "POST",
          headers: jsonAuthHeaders(auth),
          body: JSON.stringify({ changesetId: cs.id }),
        },
      );
      const body = await res.json();

      assertEquals(res.status, 200);
      assertEquals(body.changeset.id, cs.id);
      assertEquals(body.changes.length, 1);
      assertStringIncludes(body.context, 'changeset "Mention changesets"');
      assertStringIncludes(body.context, 'update handler "sendMessage"');
    } finally {
      await control.server.shutdown();
      await db.close();
    }
  },
});

Deno.test({
  sanitizeResources: false,
  sanitizeOps: false,
  name: "changeset approval endpoint is idempotent while work is active",
  fn: async () => {
    const db = await Database.create({ driver: "pglite" });
    const kernel = new Kernel(db, { composition: testStoreComposition() });
    const session = await kernel.sessions.createSession("Approval Test");
    const cs = await kernel.changesets.create({
      sessionId: session.id,
      title: "Approval flow",
      plan: {
        summary: "Approve once and tolerate retries.",
        steps: [{ id: "step_0", description: "Do work", status: "pending" }],
        acceptanceCriteria: [{
          id: "claim_idempotent_approval",
          text: "Approval can be retried while work is active.",
          source: "agent",
          priority: "must",
        }],
        verificationPlan: [{
          id: "check_idempotent_approval",
          claimIds: ["claim_idempotent_approval"],
          kind: "integration",
          description: "POST to the approval endpoint twice.",
        }],
      },
    });
    const now = new Date().toISOString();
    const auth = new TestAuthProvider();
    const control = await startControlServer(
      {
        entry: {
          path: "/tmp/genie-control-server-approval-test",
          name: "control-server-approval-test",
          createdAt: now,
          lastOpenedAt: now,
        },
        kernel,
        db,
        appServer: { shutdown: async () => {} } as never,
        devServer: { shutdown: async () => {} } as never,
        commandRunner: { shutdown: async () => {} } as never,
        rebuild: () => {},
      },
      0,
      { authProvider: auth, mountRoutes: [mountVerificationRoutes] },
    );

    try {
      const port = control.server.addr.port;
      const url = `http://127.0.0.1:${port}/api/changesets/${cs.id}/approve`;
      const first = await fetch(url, {
        method: "POST",
        headers: authHeaders(auth, "acct_test_owner"),
      });
      const firstBody = await first.json();
      const second = await fetch(url, {
        method: "POST",
        headers: authHeaders(auth, "acct_test_owner"),
      });
      const secondBody = await second.json();

      assertEquals(first.status, 200);
      assertEquals(firstBody.status, "in_progress");
      assertEquals(second.status, 200);
      assertEquals(secondBody.status, "in_progress");
      assertEquals(secondBody.id, cs.id);

      const approvalMessage = await kernel.sessions.addMessage({
        sessionId: session.id,
        role: "user",
        content: "Approved. Go ahead with the plan.",
      });
      const linked = await fetch(
        `http://127.0.0.1:${port}/api/changesets/${cs.id}/approval-message`,
        {
          method: "POST",
          headers: jsonAuthHeaders(auth, "acct_test_owner"),
          body: JSON.stringify({ messageId: approvalMessage.id }),
        },
      );
      const linkedBody = await linked.json();

      assertEquals(linked.status, 200);
      assertEquals(linkedBody.approvalMessageId, approvalMessage.id);
    } finally {
      await control.server.shutdown();
      await db.close();
    }
  },
});

Deno.test({
  sanitizeResources: false,
  sanitizeOps: false,
  name:
    "changeset reject endpoint rejects a planning changeset without rollback changes",
  fn: async () => {
    const db = await Database.create({ driver: "pglite" });
    const kernel = new Kernel(db, { composition: testStoreComposition() });
    const session = await kernel.sessions.createSession("Reject Test");
    const cs = await kernel.changesets.create({
      sessionId: session.id,
      title: "Rejected plan",
      plan: {
        summary: "Reject before any work exists.",
        steps: [{
          id: "step_0",
          description: "Do not do work",
          status: "pending",
        }],
        acceptanceCriteria: [{
          id: "claim_reject_planning",
          text:
            "A planning changeset can be rejected without rollback changes.",
          source: "agent",
          priority: "must",
        }],
        verificationPlan: [{
          id: "check_reject_planning",
          claimIds: ["claim_reject_planning"],
          kind: "integration",
          description: "POST to the reject endpoint for a planning changeset.",
        }],
      },
    });
    const now = new Date().toISOString();
    const auth = new TestAuthProvider();
    const control = await startControlServer(
      {
        entry: {
          path: "/tmp/genie-control-server-reject-test",
          name: "control-server-reject-test",
          createdAt: now,
          lastOpenedAt: now,
        },
        kernel,
        db,
        appServer: { shutdown: async () => {} } as never,
        devServer: { shutdown: async () => {} } as never,
        commandRunner: { shutdown: async () => {} } as never,
        rebuild: () => {},
      },
      0,
      { authProvider: auth, mountRoutes: [mountVerificationRoutes] },
    );

    try {
      const port = control.server.addr.port;
      const res = await fetch(
        `http://127.0.0.1:${port}/api/changesets/${cs.id}/reject`,
        { method: "POST", headers: authHeaders(auth, "acct_test_owner") },
      );
      const body = await res.json();
      const stored = await kernel.changesets.get(cs.id);

      assertEquals(res.status, 200);
      assertEquals(body.status, "rejected");
      assertEquals(stored?.status, "rejected");
    } finally {
      await control.server.shutdown();
      await db.close();
    }
  },
});

Deno.test({
  sanitizeResources: false,
  sanitizeOps: false,
  name:
    "changeset abandon endpoint frees a project held by another session's changeset",
  fn: async () => {
    const db = await Database.create({ driver: "pglite" });
    const kernel = new Kernel(db, { composition: testStoreComposition() });
    const holder = await kernel.sessions.createSession("Dead client");
    const plan = {
      summary: "Held by a client that went away.",
      steps: [{
        id: "step_0",
        description: "Work",
        status: "pending" as const,
      }],
      acceptanceCriteria: [{
        id: "claim_held",
        text: "The project is held.",
        source: "agent" as const,
        priority: "must" as const,
      }],
      verificationPlan: [{
        id: "check_held",
        claimIds: ["claim_held"],
        kind: "integration" as const,
        description: "Abandon frees it.",
      }],
    };
    const cs = await kernel.changesets.create({
      sessionId: holder.id,
      title: "Held",
      plan,
    });
    await kernel.changesets.approve(cs.id);
    await kernel.changesets.startWork(cs.id);
    const now = new Date().toISOString();
    const auth = new TestAuthProvider();
    const control = await startControlServer(
      {
        entry: {
          path: "/tmp/genie-control-server-abandon-test",
          name: "control-server-abandon-test",
          createdAt: now,
          lastOpenedAt: now,
        },
        kernel,
        db,
        appServer: { shutdown: async () => {} } as never,
        devServer: { shutdown: async () => {} } as never,
        commandRunner: { shutdown: async () => {} } as never,
        rebuild: () => {},
      },
      0,
      { authProvider: auth, mountRoutes: [mountVerificationRoutes] },
    );

    try {
      const port = control.server.addr.port;
      const abandon = (id: string) =>
        fetch(`http://127.0.0.1:${port}/api/changesets/${id}/abandon`, {
          method: "POST",
          headers: authHeaders(auth, "acct_test_owner"),
        });

      const res = await abandon(cs.id);
      const body = await res.json();
      assertEquals(res.status, 200);
      assertEquals(body.status, "abandoned");

      // The project is free: another session can start.
      const next = await kernel.changesets.create({
        sessionId: "another-session",
        title: "Next",
        plan,
      });
      assertEquals(next.status, "planning");

      // A planning changeset frees the same way; abandoning twice is a no-op.
      const planning = await abandon(next.id);
      assertEquals(planning.status, 200);
      await planning.body?.cancel();
      const again = await abandon(next.id);
      assertEquals(again.status, 200);
      await again.body?.cancel();
      const missing = await abandon("cs_missing");
      assertEquals(missing.status, 404);
      await missing.body?.cancel();
    } finally {
      await control.server.shutdown();
      await db.close();
    }
  },
});

async function waitForSocketOpen(ws: WebSocket): Promise<void> {
  if (ws.readyState === WebSocket.OPEN) return;
  await new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve();
    ws.onerror = () => reject(new Error("WebSocket failed to open"));
  });
}

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Timed out waiting for condition");
}

Deno.test({
  sanitizeResources: false,
  sanitizeOps: false,
  name: "verification overview endpoint returns an aggregated shape",
  fn: async () => {
    const db = await Database.create({ driver: "pglite" });
    const kernel = new Kernel(db, { composition: testStoreComposition() });
    kernel.handlers.register(
      "target",
      "export default () => new Response();",
      () => new Response(),
    );
    const now = new Date().toISOString();
    const auth = new TestAuthProvider();
    const control = await startControlServer(
      {
        entry: {
          path: "/tmp/genie-control-server-verification-test",
          name: "control-server-verification-test",
          createdAt: now,
          lastOpenedAt: now,
        },
        kernel,
        db,
        appServer: { shutdown: async () => {} } as never,
        devServer: { shutdown: async () => {} } as never,
        commandRunner: { shutdown: async () => {} } as never,
        rebuild: () => {},
      },
      0,
      { authProvider: auth, mountRoutes: [mountVerificationRoutes] },
    );

    try {
      const port = control.server.addr.port;
      const res = await fetch(
        `http://127.0.0.1:${port}/api/verification/overview`,
        { headers: authHeaders(auth) },
      );
      const body = await res.json();

      assertEquals(res.status, 200);
      assertEquals(Array.isArray(body.entities), true);
      assertEquals(Array.isArray(body.ledger), true);
      assertEquals(Array.isArray(body.claims), true);
      assertEquals(typeof body.totals.attestations, "number");
      assertEquals(typeof body.project.fingerprint, "string");
      assertEquals(typeof body.generatedAt, "string");
      assertEquals(
        body.entities.some((e: { scope: string }) =>
          e.scope === "handler:target"
        ),
        true,
      );
    } finally {
      await control.server.shutdown();
      await db.close();
    }
  },
});

Deno.test({
  sanitizeResources: false,
  sanitizeOps: false,
  name: "verification ledger endpoint returns filtered entries",
  fn: async () => {
    const db = await Database.create({ driver: "pglite" });
    const kernel = new Kernel(db, { composition: testStoreComposition() });
    await kernel.changesets.recordLedgerEntry({
      id: "att_e",
      kind: "invariant",
      status: "passed",
      fingerprint: "fp",
      scope: "handler:target",
      checkId: "spec_0",
      summary: "ok",
      createdAt: "2026-01-01T00:00:00.000Z",
      changesetId: "cs_1",
      changesetTitle: "T",
    });
    const now = new Date().toISOString();
    const auth = new TestAuthProvider();
    const control = await startControlServer(
      {
        entry: {
          path: "/tmp/genie-control-server-ledger-test",
          name: "control-server-ledger-test",
          createdAt: now,
          lastOpenedAt: now,
        },
        kernel,
        db,
        appServer: { shutdown: async () => {} } as never,
        devServer: { shutdown: async () => {} } as never,
        commandRunner: { shutdown: async () => {} } as never,
        rebuild: () => {},
      },
      0,
      { authProvider: auth, mountRoutes: [mountVerificationRoutes] },
    );

    try {
      const port = control.server.addr.port;
      const res = await fetch(
        `http://127.0.0.1:${port}/api/verification/ledger?kind=invariant`,
        { headers: authHeaders(auth) },
      );
      const body = await res.json();
      assertEquals(res.status, 200);
      assertEquals(Array.isArray(body.entries), true);
      assertEquals(body.count, 1);
      assertEquals(body.entries[0].id, "att_e");
      assertEquals(typeof body.generatedAt, "string");

      // A non-matching filter returns an empty page.
      const miss = await fetch(
        `http://127.0.0.1:${port}/api/verification/ledger?kind=audit`,
        { headers: authHeaders(auth) },
      );
      assertEquals((await miss.json()).count, 0);
    } finally {
      await control.server.shutdown();
      await db.close();
    }
  },
});

Deno.test({
  sanitizeResources: false,
  sanitizeOps: false,
  name: "changeset readiness endpoint mirrors the completion gate",
  fn: async () => {
    const db = await Database.create({ driver: "pglite" });
    const kernel = new Kernel(db, { composition: testStoreComposition() });
    const session = await kernel.sessions.createSession("Readiness Test");
    const cs = await kernel.changesets.create({
      sessionId: session.id,
      title: "Readiness",
      plan: {
        summary: "Verdict preview mirrors completion.",
        steps: [],
        acceptanceCriteria: [{
          id: "claim_ready",
          text: "The feature behaves.",
          source: "agent",
          priority: "should",
        }],
        verificationPlan: [{
          id: "check_ready",
          claimIds: ["claim_ready"],
          kind: "unit",
          description: "Run the unit test.",
        }],
      },
    });
    await kernel.changesets.approve(cs.id);
    await kernel.changesets.startWork(cs.id);

    const now = new Date().toISOString();
    const auth = new TestAuthProvider();
    const control = await startControlServer(
      {
        entry: {
          path: "/tmp/genie-control-server-readiness-test",
          name: "control-server-readiness-test",
          createdAt: now,
          lastOpenedAt: now,
        },
        kernel,
        db,
        appServer: { shutdown: async () => {} } as never,
        devServer: { shutdown: async () => {} } as never,
        commandRunner: { shutdown: async () => {} } as never,
        rebuild: () => {},
      },
      0,
      { authProvider: auth, mountRoutes: [mountVerificationRoutes] },
    );

    try {
      const port = control.server.addr.port;
      const readinessUrl =
        `http://127.0.0.1:${port}/api/changesets/${cs.id}/readiness`;

      // Blocked: no verification run recorded yet — the gate reports why.
      const blocked = await fetch(readinessUrl, { headers: authHeaders(auth) });
      const blockedBody = await blocked.json();
      assertEquals(blocked.status, 200);
      assertEquals(blockedBody.passed, false);
      assertEquals(blockedBody.changesetId, cs.id);
      assert(Array.isArray(blockedBody.errors));
      assert(
        blockedBody.errors.some(
          (e: { code: string }) => e.code === "MISSING_VERIFICATION_RUN",
        ),
        "expected MISSING_VERIFICATION_RUN before any run is recorded",
      );
      assertEquals(blockedBody.checks.verificationRuns, 0);

      // Record a passing run covering the claim → the gate opens.
      await kernel.changesets.recordVerificationRun(cs.id, {
        status: "passed",
        summary: "unit test passed",
        evidence: [{
          id: "ev_ready",
          kind: "test_result",
          summary: "unit test green",
          status: "passed",
          createdAt: "2026-01-01T00:00:00.000Z",
        }],
        claimResults: [{
          claimId: "claim_ready",
          status: "passed",
          evidenceIds: ["ev_ready"],
        }],
        residualRisks: [],
      });

      const ready = await fetch(readinessUrl, { headers: authHeaders(auth) });
      const readyBody = await ready.json();
      assertEquals(ready.status, 200);
      assertEquals(readyBody.passed, true);
      assertEquals(readyBody.checks.latestVerificationStatus, "passed");
      assertEquals(readyBody.checks.verificationRuns, 1);

      // Unknown changeset → 404.
      const missing = await fetch(
        `http://127.0.0.1:${port}/api/changesets/does_not_exist/readiness`,
        { headers: authHeaders(auth) },
      );
      assertEquals(missing.status, 404);
    } finally {
      await control.server.shutdown();
      await db.close();
    }
  },
});

Deno.test({
  sanitizeResources: false,
  sanitizeOps: false,
  name: "changeset complete endpoint deterministically enforces readiness",
  fn: async () => {
    const db = await Database.create({ driver: "pglite" });
    const kernel = new Kernel(db, { composition: testComposition() });
    const session = await kernel.sessions.createSession("Complete Test");
    const cs = await kernel.changesets.create({
      sessionId: session.id,
      title: "Complete from verification panel",
      plan: {
        summary: "Complete through the deterministic endpoint.",
        steps: [],
        acceptanceCriteria: [{
          id: "claim_complete",
          text: "The verified changeset can complete.",
          source: "agent",
          priority: "should",
        }],
        verificationPlan: [{
          id: "check_complete",
          claimIds: ["claim_complete"],
          kind: "unit",
          description: "Run the unit test.",
        }],
      },
    });
    await kernel.changesets.approve(cs.id);
    await kernel.changesets.startWork(cs.id);

    const now = new Date().toISOString();
    const auth = new TestAuthProvider();
    const chat = new SessionRecordingChat(kernel, session.id);
    const control = await startControlServer(
      {
        entry: {
          path: "/tmp/genie-control-server-complete-test",
          name: "control-server-complete-test",
          createdAt: now,
          lastOpenedAt: now,
        },
        kernel,
        db,
        appServer: { shutdown: async () => {} } as never,
        devServer: { shutdown: async () => {} } as never,
        commandRunner: { shutdown: async () => {} } as never,
        rebuild: () => {},
      },
      0,
      {
        authProvider: auth,
        chatFactory: () => chat,
        mountRoutes: [mountVerificationRoutes],
      },
    );

    try {
      const port = control.server.addr.port;
      const completeUrl =
        `http://127.0.0.1:${port}/api/changesets/${cs.id}/complete`;

      const blocked = await fetch(completeUrl, {
        method: "POST",
        headers: authHeaders(auth),
      });
      const blockedBody = await blocked.json();
      assertEquals(blocked.status, 400);
      assertStringIncludes(blockedBody.error, "Changeset is not ready");

      await kernel.changesets.recordVerificationRun(cs.id, {
        status: "passed",
        summary: "unit test passed",
        evidence: [{
          id: "ev_complete",
          kind: "test_result",
          summary: "unit test green",
          status: "passed",
          createdAt: "2026-01-01T00:00:00.000Z",
        }],
        claimResults: [{
          claimId: "claim_complete",
          status: "passed",
          evidenceIds: ["ev_complete"],
        }],
        residualRisks: [],
      });

      const completed = await fetch(completeUrl, {
        method: "POST",
        headers: authHeaders(auth),
      });
      const completedBody = await completed.json();
      const stored = await kernel.changesets.get(cs.id);

      assertEquals(completed.status, 200);
      assertEquals(completedBody.status, "completed");
      assertEquals(stored?.status, "completed");
      assertEquals(chat.sentMessages.length, 0);
    } finally {
      await control.server.shutdown();
      await db.close();
    }
  },
});

// --- Project-import Slice 6: source-backed command + related-test surface ---

function sourceBackedCommandGraph(
  rootPath: string,
  testCmd: string,
): CodebaseGraph {
  const graph = createEmptyCodebaseGraph(rootPath, rootPath);
  graph.commands.push({
    id: "command:test:test",
    kind: "command",
    name: "test",
    commandKind: "test",
    command: testCmd,
    cwd: rootPath,
    packageManager: "npm",
    source: { pluginId: "generic-tsjs", method: "manifest", inferred: false },
    confidence: 0.95,
    locations: [{ file: "package.json", startLine: 1, startColumn: 1 }],
  });
  // math.ts tested-by math_test.ts, so GET /api/tests/related has data to walk.
  const mathTestId = semanticId("test", "src/math_test.ts");
  graph.files.push({
    id: fileSemanticId("src/math.ts"),
    kind: "file",
    name: "math.ts",
    path: "src/math.ts",
    language: "typescript",
    source: {
      pluginId: "generic-tsjs",
      method: "ts-language-service",
      inferred: false,
    },
    confidence: 1,
    locations: [{ file: "src/math.ts", startLine: 1, startColumn: 1 }],
  });
  graph.tests.push({
    id: mathTestId,
    kind: "test",
    name: "math_test.ts",
    language: "typescript",
    file: "src/math_test.ts",
    targetIds: [fileSemanticId("src/math.ts")],
    source: { pluginId: "generic-tsjs", method: "ast", inferred: false },
    confidence: 0.9,
    locations: [{ file: "src/math_test.ts", startLine: 1, startColumn: 1 }],
  });
  graph.edges.push({
    id: edgeSemanticId("tested-by", fileSemanticId("src/math.ts"), mathTestId),
    type: "tested-by",
    sourceId: fileSemanticId("src/math.ts"),
    targetId: mathTestId,
    source: { pluginId: "generic-tsjs", method: "ast", inferred: true },
    confidence: 0.7,
  });
  return graph;
}

Deno.test({
  sanitizeResources: false,
  sanitizeOps: false,
  name:
    "commands control: list and run are refused for a registry-native project",
  fn: async () => {
    const projectDir = await Deno.makeTempDir({
      dir: "/private/tmp",
      prefix: "genie-control-commands-gate-",
    });
    const paths = getProjectPaths(projectDir);
    const now = new Date().toISOString();
    mkdirSync(join(projectDir, ".opentide"), { recursive: true });
    // No `mode` key ⇒ registry-native (default).
    writeFileSync(
      paths.manifest,
      JSON.stringify({ name: "commands-gate", createdAt: now }, null, 2),
    );

    const db = await Database.create({ driver: "pglite" });
    const kernel = new Kernel(db, {
      historyDir: paths.historyDir,
      composition: testStoreComposition(),
    });
    kernel.projectDir = projectDir;
    kernel.codebaseGraph = sourceBackedCommandGraph(projectDir, "echo hi");

    const auth = new TestAuthProvider();
    const control = await startControlServer(
      {
        entry: {
          path: projectDir,
          name: "commands-gate",
          createdAt: now,
          lastOpenedAt: now,
        },
        kernel,
        db,
        appServer: { shutdown: async () => {} } as never,
        devServer: { shutdown: async () => {} } as never,
        commandRunner: new CommandRunner(kernel, projectDir),
        rebuild: () => {},
      },
      0,
      { authProvider: auth, mountRoutes: [mountVerificationRoutes] },
    );
    try {
      const base = `http://127.0.0.1:${control.server.addr.port}`;
      const list = await fetch(`${base}/api/commands`, {
        headers: authHeaders(auth),
      });
      assertEquals(list.status, 400);
      assertStringIncludes((await list.json()).error, "source-backed");

      const run = await fetch(`${base}/api/commands/run`, {
        method: "POST",
        headers: jsonAuthHeaders(auth),
        body: JSON.stringify({ kind: "test" }),
      });
      assertEquals(run.status, 400);
      assertStringIncludes((await run.json()).error, "source-backed");
    } finally {
      await control.server.shutdown();
      await db.close();
      rmSync(projectDir, { recursive: true, force: true });
    }
  },
});

Deno.test({
  sanitizeResources: false,
  sanitizeOps: false,
  name:
    "commands control: source-backed lists, runs, records verification, selects related tests, cancels",
  fn: async () => {
    const projectDir = await Deno.makeTempDir({
      dir: "/private/tmp",
      prefix: "genie-control-commands-e2e-",
    });
    const paths = getProjectPaths(projectDir);
    const now = new Date().toISOString();
    mkdirSync(join(projectDir, ".opentide"), { recursive: true });
    writeFileSync(
      paths.manifest,
      JSON.stringify(
        { name: "commands-e2e", createdAt: now, mode: "source-backed" },
        null,
        2,
      ),
    );

    const db = await Database.create({ driver: "pglite" });
    const kernel = new Kernel(db, {
      historyDir: paths.historyDir,
      composition: testStoreComposition(),
    });
    kernel.projectDir = projectDir;
    kernel.codebaseGraph = sourceBackedCommandGraph(projectDir, "echo TEST_OK");
    const commandRunner = new CommandRunner(kernel, projectDir);

    const auth = new TestAuthProvider();
    const control = await startControlServer(
      {
        entry: {
          path: projectDir,
          name: "commands-e2e",
          createdAt: now,
          lastOpenedAt: now,
        },
        kernel,
        db,
        appServer: { shutdown: async () => {} } as never,
        devServer: { shutdown: async () => {} } as never,
        commandRunner,
        rebuild: () => {},
      },
      0,
      { authProvider: auth, mountRoutes: [mountVerificationRoutes] },
    );
    try {
      const base = `http://127.0.0.1:${control.server.addr.port}`;

      // 1) GET /api/commands lists the discovered test command.
      const list = await (await fetch(`${base}/api/commands`, {
        headers: authHeaders(auth),
      })).json();
      assertEquals(
        (list.commands as ProjectCommand[]).map((c) => c.commandKind),
        ["test"],
      );

      // 2) POST /api/commands/run runs it and returns exit code + output.
      const run = await (await fetch(`${base}/api/commands/run`, {
        method: "POST",
        headers: jsonAuthHeaders(auth),
        body: JSON.stringify({ kind: "test" }),
      })).json();
      assertEquals(run.result.ok, true);
      assertEquals(run.result.exitCode, 0);
      assertStringIncludes(run.result.stdout, "TEST_OK");
      assertEquals(run.verification.recorded, false); // not requested

      // 3) A test run with recordVerification attaches self-reported evidence to
      //    the active changeset that checkChangesetReadiness accepts (not grounded).
      const cs = await kernel.changesets.create({
        title: "Source edit",
        plan: {
          summary: "s",
          steps: [{ id: "s1", description: "d", status: "done" }],
          acceptanceCriteria: [
            {
              id: "claim_0",
              text: "holds",
              source: "agent",
              priority: "should",
            },
          ],
          verificationPlan: [
            {
              id: "check_0",
              claimIds: ["claim_0"],
              kind: "unit",
              description: "run tests",
            },
          ],
        },
      });
      await kernel.changesets.approve(cs.id);
      await kernel.changesets.startWork(cs.id);

      const recordedRun = await (await fetch(`${base}/api/commands/run`, {
        method: "POST",
        headers: jsonAuthHeaders(auth),
        body: JSON.stringify({ kind: "test", recordVerification: true }),
      })).json();
      assertEquals(recordedRun.verification.recorded, true);
      assertEquals(recordedRun.verification.changesetId, cs.id);

      const updated = await kernel.changesets.get(cs.id);
      assert(updated, "changeset should exist");
      const readiness = checkChangesetReadiness(updated!);
      assertEquals(readiness.checks.evidence, 1);
      // Self-reported (manual) evidence — NOT flagged as unattested/non-passing.
      assertEquals(
        readiness.errors.some((e) => e.code === "UNATTESTED_EVIDENCE"),
        false,
      );
      assertEquals(
        readiness.errors.some((e) =>
          e.code === "VERIFICATION_EVIDENCE_NOT_PASSING"
        ),
        false,
      );

      // 4) GET /api/tests/related walks the graph to the changed file's test.
      const related = await (await fetch(
        `${base}/api/tests/related?path=src/math.ts`,
        { headers: authHeaders(auth) },
      )).json();
      assertEquals(
        (related.tests as Array<{ file: string }>).map((t) => t.file),
        ["src/math_test.ts"],
      );
      assertEquals(related.command.command, "echo TEST_OK");

      // 5) POST /api/commands/cancel stops a long-running command with no orphan.
      kernel.codebaseGraph = sourceBackedCommandGraph(projectDir, "sleep 30");
      const longRun = fetch(`${base}/api/commands/run`, {
        method: "POST",
        headers: jsonAuthHeaders(auth),
        body: JSON.stringify({ kind: "test" }),
      });
      await new Promise((r) => setTimeout(r, 300));
      const cancelRes = await fetch(`${base}/api/commands/cancel`, {
        method: "POST",
        headers: authHeaders(auth),
      });
      assertEquals(cancelRes.status, 200);
      const longBody = await (await longRun).json();
      assertEquals(longBody.result.canceled, true);
      assertEquals(longBody.result.ok, false);

      const status = await (await fetch(`${base}/api/commands/status`, {
        headers: authHeaders(auth),
      })).json();
      assertEquals(status.running, false);
    } finally {
      await commandRunner.shutdown();
      await control.server.shutdown();
      await db.close();
      rmSync(projectDir, { recursive: true, force: true });
    }
  },
});

// --- Per-provider API-key routes (Stage 6 slice 2) -------------------------------
//
// Stand up a bare control server with a fake chat and a HOME pointed at a throwaway
// dir so every config write lands in an isolated config.json (never the real one).
// The provider-key routes carry no auth guard (like the legacy /api/config/api-key),
// so no cookie is needed.
async function withConfigTestServer(
  prefix: string,
  fn: (base: string, home: string) => Promise<void>,
): Promise<void> {
  const prevHome = Deno.env.get("HOME");
  const prevAnthropic = Deno.env.get("ANTHROPIC_API_KEY");
  const prevOpenai = Deno.env.get("OPENAI_API_KEY");
  const home = await Deno.makeTempDir({ prefix });
  const projectDir = await Deno.makeTempDir({ prefix: `${prefix}proj-` });
  const db = await Database.create({ driver: "pglite" });
  const kernel = new Kernel(db, { composition: testStoreComposition() });
  const session = await kernel.sessions.createSession("Config");
  const fakeChat = new SessionRecordingChat(kernel, session.id);
  const now = new Date().toISOString();
  Deno.env.set("HOME", home);
  // Isolate from any ambient provider keys so `set` starts false everywhere.
  Deno.env.delete("ANTHROPIC_API_KEY");
  Deno.env.delete("OPENAI_API_KEY");
  const control = await startControlServer(
    {
      entry: {
        path: projectDir,
        name: "config-test",
        createdAt: now,
        lastOpenedAt: now,
      },
      kernel,
      db,
      appServer: { shutdown: async () => {} } as never,
      devServer: { shutdown: async () => {} } as never,
      commandRunner: { shutdown: async () => {} } as never,
      rebuild: () => {},
    },
    0,
    { chatFactory: () => fakeChat },
  );
  try {
    await fn(`http://127.0.0.1:${control.server.addr.port}`, home);
  } finally {
    await control.server.shutdown();
    await db.close();
    rmSync(projectDir, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
    if (prevHome === undefined) Deno.env.delete("HOME");
    else Deno.env.set("HOME", prevHome);
    if (prevAnthropic === undefined) Deno.env.delete("ANTHROPIC_API_KEY");
    else Deno.env.set("ANTHROPIC_API_KEY", prevAnthropic);
    if (prevOpenai === undefined) Deno.env.delete("OPENAI_API_KEY");
    else Deno.env.set("OPENAI_API_KEY", prevOpenai);
  }
}

Deno.test({
  sanitizeResources: false,
  sanitizeOps: false,
  name:
    "/api/config/api-key/:provider GET/PUT/DELETE round-trips for each provider",
  fn: async () => {
    await withConfigTestServer("genie-cfg-key-", async (base) => {
      for (const provider of ["anthropic", "openai"] as const) {
        const url = `${base}/api/config/api-key/${provider}`;
        // Unset initially.
        const before = await (await fetch(url)).json();
        assertEquals(before, { set: false, display: null });

        // PUT stores + obfuscates (never echoes the raw key).
        const rawKey = `sk-${provider}-abcdefghijklmnop1234567`;
        const putRes = await fetch(url, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ key: rawKey }),
        });
        assertEquals(putRes.status, 200);
        const put = await putRes.json();
        assertEquals(put.set, true);
        assert(typeof put.display === "string");
        assert(put.display !== rawKey);
        assertStringIncludes(put.display, "*");

        // GET now reflects the set/obfuscated state.
        const after = await (await fetch(url)).json();
        assertEquals(after.set, true);
        assertEquals(after.display, put.display);

        // DELETE clears it.
        const delRes = await fetch(url, { method: "DELETE" });
        assertEquals(delRes.status, 200);
        assertEquals(await delRes.json(), { set: false, display: null });
        const cleared = await (await fetch(url)).json();
        assertEquals(cleared, { set: false, display: null });
      }
    });
  },
});

Deno.test({
  sanitizeResources: false,
  sanitizeOps: false,
  name: "/api/config/api-key/:provider rejects an unknown provider with 400",
  fn: async () => {
    await withConfigTestServer("genie-cfg-key-bad-", async (base) => {
      const url = `${base}/api/config/api-key/gemini`;
      assertEquals((await fetch(url)).status, 400);
      assertEquals(
        (await fetch(url, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ key: "sk-whatever" }),
        })).status,
        400,
      );
      assertEquals((await fetch(url, { method: "DELETE" })).status, 400);
    });
  },
});

Deno.test({
  sanitizeResources: false,
  sanitizeOps: false,
  name: "/api/config/providers lists one status row per provider",
  fn: async () => {
    await withConfigTestServer("genie-cfg-providers-", async (base) => {
      const empty = await (await fetch(`${base}/api/config/providers`)).json();
      assertEquals(empty.providers.map((p: { id: string }) => p.id), [
        "anthropic",
        "openai",
      ]);
      for (const p of empty.providers) {
        assertEquals(p.set, false);
        assertEquals(p.display, null);
      }

      // Set the OpenAI key and confirm only its row flips.
      await fetch(`${base}/api/config/api-key/openai`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: "sk-openai-abcdefghijklmnop1234567" }),
      });
      const after = await (await fetch(`${base}/api/config/providers`)).json();
      const byId = new Map(
        after.providers.map((p: { id: string }) => [p.id, p]),
      );
      assertEquals(
        (byId.get("openai") as { set: boolean }).set,
        true,
      );
      assertEquals(
        (byId.get("anthropic") as { set: boolean }).set,
        false,
      );
    });
  },
});

Deno.test({
  sanitizeResources: false,
  sanitizeOps: false,
  name:
    "legacy /api/config/api-key alias still writes the Anthropic provider key",
  fn: async () => {
    await withConfigTestServer("genie-cfg-legacy-", async (base) => {
      const rawKey = "sk-ant-legacyaliasabcdefghijk1234567";
      const put = await (await fetch(`${base}/api/config/api-key`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: rawKey }),
      })).json();
      assertEquals(put.set, true);
      assert(put.display !== rawKey);

      // The write is visible through BOTH the legacy GET and the per-provider GET.
      const legacyGet = await (await fetch(`${base}/api/config/api-key`))
        .json();
      assertEquals(legacyGet.set, true);
      const perProvider =
        await (await fetch(`${base}/api/config/api-key/anthropic`)).json();
      assertEquals(perProvider.set, true);
      assertEquals(perProvider.display, put.display);

      // And the legacy DELETE clears that same provider key.
      await fetch(`${base}/api/config/api-key`, { method: "DELETE" });
      const cleared =
        await (await fetch(`${base}/api/config/api-key/anthropic`)).json();
      assertEquals(cleared, { set: false, display: null });
    });
  },
});

Deno.test({
  sanitizeResources: false,
  sanitizeOps: false,
  name: "/api/config/openai-base-url GET/PUT/DELETE round-trips",
  fn: async () => {
    const prevBaseUrl = Deno.env.get("OPENAI_BASE_URL");
    try {
      Deno.env.delete("OPENAI_BASE_URL");
      await withConfigTestServer("genie-cfg-base-url-", async (base) => {
        const url = `${base}/api/config/openai-base-url`;
        // Unset initially ⇒ null (the api.openai.com default is applied downstream).
        assertEquals(await (await fetch(url)).json(), { baseUrl: null });

        // PUT stores it and echoes it back.
        const target = "https://openrouter.ai/api/v1";
        const putRes = await fetch(url, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ baseUrl: target }),
        });
        assertEquals(putRes.status, 200);
        assertEquals(await putRes.json(), { baseUrl: target });

        // GET reflects the stored value.
        assertEquals(await (await fetch(url)).json(), { baseUrl: target });

        // DELETE resets back to the default (null).
        const delRes = await fetch(url, { method: "DELETE" });
        assertEquals(delRes.status, 200);
        assertEquals(await delRes.json(), { baseUrl: null });
        assertEquals(await (await fetch(url)).json(), { baseUrl: null });
      });
    } finally {
      if (prevBaseUrl === undefined) Deno.env.delete("OPENAI_BASE_URL");
      else Deno.env.set("OPENAI_BASE_URL", prevBaseUrl);
    }
  },
});

Deno.test({
  sanitizeResources: false,
  sanitizeOps: false,
  name: "/api/config/openai-base-url rejects a non-http(s) URL with 400",
  fn: async () => {
    const prevBaseUrl = Deno.env.get("OPENAI_BASE_URL");
    try {
      Deno.env.delete("OPENAI_BASE_URL");
      await withConfigTestServer("genie-cfg-base-url-bad-", async (base) => {
        const url = `${base}/api/config/openai-base-url`;
        for (const bad of ["not-a-url", "ftp://example.com/v1", ""]) {
          const res = await fetch(url, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ baseUrl: bad }),
          });
          assertEquals(res.status, 400);
        }
        // A rejected write never persists anything.
        assertEquals(await (await fetch(url)).json(), { baseUrl: null });
      });
    } finally {
      if (prevBaseUrl === undefined) Deno.env.delete("OPENAI_BASE_URL");
      else Deno.env.set("OPENAI_BASE_URL", prevBaseUrl);
    }
  },
});

async function withBuildExtrasServer(
  extras: BuildTargetExtras,
  fn: (base: string, projectDir: string) => Promise<void>,
): Promise<void> {
  const projectDir = await Deno.makeTempDir({ prefix: "genie-build-extras-" });
  const db = await Database.create({ driver: "pglite" });
  const kernel = new Kernel(db, { composition: testStoreComposition() });
  const now = new Date().toISOString();
  const control = await startControlServer(
    {
      entry: {
        path: projectDir,
        name: "build-extra-test",
        createdAt: now,
        lastOpenedAt: now,
      },
      kernel,
      db,
      appServer: { shutdown: async () => {} } as never,
      devServer: { shutdown: async () => {} } as never,
      commandRunner: { shutdown: async () => {} } as never,
      rebuild: () => {},
    },
    0,
    { buildTargetExtras: extras },
  );
  try {
    await fn(`http://127.0.0.1:${control.server.addr.port}`, projectDir);
  } finally {
    await control.server.shutdown();
    await db.close();
    rmSync(projectDir, { recursive: true, force: true });
  }
}

Deno.test({
  sanitizeResources: false,
  sanitizeOps: false,
  name: "build endpoints route target-level refresh and smoke options",
  fn: async () => {
    const calls: string[] = [];
    await withBuildExtrasServer(
      {
        refreshLocksBeforeBuild: async (_ctx, targets, options) => {
          calls.push(
            `refresh:${targets.join(",")}:manifest=${
              String(options.buildOptions.includeManifest)
            }:seed=${String(options.buildOptions.includeSeedData)}`,
          );
          return { ok: true, detail: "refresh ok" };
        },
        runSmokeTest: async (_ctx, target, options) => {
          calls.push(
            `smoke:${target}:manifest=${
              String(options.buildOptions.includeManifest)
            }:seed=${String(options.buildOptions.includeSeedData)}`,
          );
          return { ok: true, detail: "smoke ok" };
        },
      },
      async (base) => {
        const res = await fetch(`${base}/api/build/deno`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            includeManifest: true,
            refreshLocksBeforeBuild: true,
            runSmokeTest: true,
          }),
        });
        assertEquals(res.status, 200);
        const seedRes = await fetch(`${base}/api/build/deno`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            includeSeedData: true,
            refreshLocksBeforeBuild: true,
            runSmokeTest: true,
          }),
        });
        assertEquals(seedRes.status, 200);
      },
    );
    assertEquals(calls, [
      "refresh:deno-source:manifest=true:seed=false",
      "smoke:deno:manifest=true:seed=false",
      "refresh:deno-source:manifest=false:seed=true",
      "smoke:deno:manifest=false:seed=true",
    ]);
  },
});

Deno.test({
  sanitizeResources: false,
  sanitizeOps: false,
  name: "download build GET rejects state-changing build options",
  fn: async () => {
    const calls: string[] = [];
    await withBuildExtrasServer(
      {
        refreshLocksBeforeBuild: async (_ctx, targets) => {
          calls.push(`refresh:${targets.join(",")}`);
          return { ok: true, detail: "refresh ok" };
        },
        runSmokeTest: async (_ctx, target) => {
          calls.push(`smoke:${target}`);
          return { ok: true, detail: "smoke ok" };
        },
      },
      async (base) => {
        for (
          const endpoint of [
            "/api/build/zip",
            "/api/build/node/zip",
            "/api/build/docker/zip",
          ]
        ) {
          const res = await fetch(
            `${base}${endpoint}?refreshLocksBeforeBuild=true&runSmokeTest=true`,
          );
          assertEquals(res.status, 405);
          const body = await res.json();
          assertStringIncludes(body.error, "POST build download request");
        }
      },
    );
    assertEquals(calls, []);
  },
});

Deno.test({
  sanitizeResources: false,
  sanitizeOps: false,
  name:
    "download build POST routes refresh and smoke options before returning zip",
  fn: async () => {
    const calls: string[] = [];
    await withBuildExtrasServer(
      {
        refreshLocksBeforeBuild: async (_ctx, targets) => {
          calls.push(`refresh:${targets.join(",")}`);
          return { ok: true, detail: "refresh ok" };
        },
        runSmokeTest: async (_ctx, target) => {
          calls.push(`smoke:${target}`);
          return { ok: true, detail: "smoke ok" };
        },
      },
      async (base) => {
        const res = await fetch(`${base}/api/build/zip`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            refreshLocksBeforeBuild: true,
            runSmokeTest: true,
          }),
        });
        assertEquals(res.status, 200);
        assertEquals(res.headers.get("Content-Type"), "application/zip");
        assertStringIncludes(
          res.headers.get("Content-Disposition") ?? "",
          ".zip",
        );
      },
    );
    assertEquals(calls, ["refresh:deno-source", "smoke:deno"]);
  },
});

Deno.test({
  sanitizeResources: false,
  sanitizeOps: false,
  name: "download build POST supports Node and Docker target options",
  fn: async () => {
    const calls: string[] = [];
    await withBuildExtrasServer(
      {
        refreshLocksBeforeBuild: async (_ctx, targets) => {
          calls.push(`refresh:${targets.join(",")}`);
          return { ok: true, detail: "refresh ok" };
        },
        runSmokeTest: async (_ctx, target) => {
          calls.push(`smoke:${target}`);
          return { ok: true, detail: "smoke ok" };
        },
      },
      async (base) => {
        const nodeRes = await fetch(`${base}/api/build/node/zip`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            refreshLocksBeforeBuild: true,
            runSmokeTest: true,
          }),
        });
        assertEquals(nodeRes.status, 200);
        assertEquals(nodeRes.headers.get("Content-Type"), "application/zip");

        const dockerRes = await fetch(`${base}/api/build/docker/zip`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            refreshLocksBeforeBuild: true,
            includeCompose: true,
          }),
        });
        assertEquals(dockerRes.status, 200);
        assertEquals(dockerRes.headers.get("Content-Type"), "application/zip");
      },
    );
    assertEquals(calls, [
      "refresh:node",
      "smoke:node",
      "refresh:deno-source",
    ]);
  },
});

Deno.test({
  sanitizeResources: false,
  sanitizeOps: false,
  name: "Docker build endpoints reject unsupported smoke tests",
  fn: async () => {
    const calls: string[] = [];
    await withBuildExtrasServer(
      {
        runSmokeTest: async (_ctx, target) => {
          calls.push(`smoke:${target}`);
          return { ok: true, detail: "smoke ok" };
        },
      },
      async (base) => {
        for (const endpoint of ["/api/build/docker", "/api/build/docker/zip"]) {
          const res = await fetch(`${base}${endpoint}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ runSmokeTest: true }),
          });
          assertEquals(res.status, 400);
          const body = await res.json();
          assertStringIncludes(body.error, "Docker smoke testing");
        }
      },
    );
    assertEquals(calls, []);
  },
});

Deno.test({
  sanitizeResources: false,
  sanitizeOps: false,
  name: "target smoke failure blocks a Deno build success",
  fn: async () => {
    await withBuildExtrasServer(
      {
        runSmokeTest: async (_ctx, target: BuildTargetExtraTarget) => ({
          ok: false,
          detail: `${target} failed`,
        }),
      },
      async (base, projectDir) => {
        const res = await fetch(`${base}/api/build/deno`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ runSmokeTest: true }),
        });
        assertEquals(res.status, 500);
        const body = await res.json();
        assertEquals(body.error, "deno failed");
        assertEquals(existsSync(join(projectDir, "dist", "v0.1.0")), false);
      },
    );
  },
});

Deno.test({
  sanitizeResources: false,
  sanitizeOps: false,
  name: "binary smoke rejects selected targets that cannot run on this host",
  fn: async () => {
    const hostTarget = defaultBinaryCompileTarget();
    const nonHostTarget = BINARY_COMPILE_TARGETS.find((target) =>
      target.id !== hostTarget
    )?.id;
    assert(nonHostTarget);
    const calls: BuildTargetExtraTarget[] = [];
    await withBuildExtrasServer(
      {
        runSmokeTest: async (_ctx, target) => {
          calls.push(target);
          return { ok: true, detail: "smoke ok" };
        },
      },
      async (base) => {
        const res = await fetch(`${base}/api/build/binary`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            targets: [nonHostTarget],
            runSmokeTest: true,
          }),
        });
        assertEquals(res.status, 400);
        const body = await res.json();
        assertStringIncludes(body.error, hostTarget);
      },
    );
    assertEquals(calls, []);
  },
});
