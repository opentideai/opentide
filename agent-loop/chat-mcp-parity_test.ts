// The proof for slices 4 to 6a (docs/tide-client-plan.md): the same scripted
// chat, run once with the in-process backend and once with the whole backend
// over serve's /mcp on loopback, leaves the same events, change records and
// history files.
//
// Ids, timestamps and durations differ run to run and are normalized away.
// principalId is left out on purpose: the MCP run is an attributed client,
// which is the point. The per-session turn usage file is left out too: over MCP
// a turn's usage is its ledger rows, which supersede that file everywhere usage
// is read, so the usage each session reports is compared instead.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join, relative } from "node:path";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { ChatOrchestrator } from "./chat.ts";
import { type ChatBackend, inProcessChatBackend } from "./chat-backend.ts";
import {
  connectMcp,
  type McpCaller,
  mcpChatBackend,
} from "./chat-backend-mcp.ts";
import type { ChatEvent } from "../core/chat-contract.ts";
import type { ChatIntelligence, Reviewer } from "../core/chat-intelligence.ts";
import { FakeModelProvider } from "../core/model-provider-fake.ts";
import type { ProviderEvent } from "../core/model-provider.ts";
import { Database } from "../core/db.ts";
import { MCPManager } from "../core/mcp.ts";
import { Kernel } from "../core/registries.ts";
import { initCompiler, stopCompiler } from "../core/compiler.ts";
import { MCP_HTTP_PATH, setKernelSettings } from "../core/config.ts";
import { createProject, getProjectPaths } from "../core/project-manager.ts";
import { isolateHome, TEST_TMP_DIR } from "../core/test-home_test.ts";
import type { TurnUsage } from "../core/types.ts";
import { createMcpHttpHandler, rejectBadToken } from "../mcp/mcp-http.ts";
import { testStoreComposition } from "../verification/test-stores.ts";
import { defaultVerificationToolHandlers } from "../verification/verification-tool-handlers.ts";

isolateHome();

const testOpts = { sanitizeResources: false, sanitizeOps: false };

const brain: ChatIntelligence = {
  baseSystemPrompt: () => "test system prompt",
  resolveModel: (configured) => configured,
  isApprovalMessage: (content) => content === APPROVAL,
  stepPrompt: (step) => step.description,
  handoffInstruction: () => "HANDOFF:",
  repairPrompt: (step, _ctx, diagnostics) =>
    `repair ${step.description}: ${diagnostics}`,
  finalReadinessRepairPrompt: (_changeset, readiness) =>
    `repair final readiness: ${readiness.errors.length} errors`,
};

// The one message the test brain reads as approving a plan.
const APPROVAL = "go ahead";

type Mode = "in-process" | "mcp";

interface Setup {
  kernel: Kernel;
  chat: ChatOrchestrator;
}

// Values a turn's setup hands its script, such as a changeset id that differs
// run to run.
type Vars = Record<string, string>;

interface Scenario {
  // The brain's reviewer, when the scenario runs reviews.
  reviewer?: Reviewer;
  turns: Array<{
    message: string;
    script: ProviderEvent[][] | ((vars: Vars) => ProviderEvent[][]);
    // Runs before the turn, the same way in both modes.
    before?: (setup: Setup) => Promise<Vars | void>;
    attachments?: Array<{ name: string; type: string; data: string }>;
    // Documents the message @-mentions, by the vars `before` returned.
    mentions?: (vars: Vars) => Array<{ id: string }>;
  }>;
}

interface Outcome {
  events: ChatEvent[][];
  changes: unknown[];
  usage: unknown[];
  files: Record<string, unknown>;
  // Each document with the refs that cite it, sorted by name.
  documents: unknown[];
  // The project's commit subjects, newest first.
  commits: string[];
}

const TURN_USAGE_DIR = "usage";

function usage(overrides: Partial<TurnUsage> = {}): ProviderEvent {
  return {
    type: "turn_usage",
    usage: {
      turnId: "provider-turn",
      sessionId: "provider-session",
      model: "fake-model",
      startedAt: "2026-10-28T00:00:00.000Z",
      endedAt: "2026-10-28T00:00:01.000Z",
      durationMs: 1000,
      inputTokens: 100,
      outputTokens: 20,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      toolCallsCount: 0,
      costUsd: 0,
      ...overrides,
    },
  };
}

function toolCall(
  id: string,
  name: string,
  input: Record<string, unknown>,
): ProviderEvent[] {
  return [
    usage(),
    {
      type: "tool_use_start",
      toolName: name,
      toolInput: input,
      toolCallId: id,
    },
    { type: "message_complete", stopReason: "requires_action" },
  ];
}

function reply(text: string): ProviderEvent[] {
  return [
    usage({ outputTokens: 5 }),
    { type: "text_delta", text },
    { type: "message_complete", stopReason: "end_turn" },
  ];
}

// Serves /mcp for `kernel` on a loopback port, behind a bearer token, as serve
// mounts it.
function serveMcp(kernel: Kernel): {
  url: URL;
  token: string;
  close: () => Promise<void>;
} {
  const token = crypto.randomUUID();
  const handler = createMcpHttpHandler(() => ({ kernel, rebuild: () => {} }));
  const server = Deno.serve(
    { hostname: "127.0.0.1", port: 0, onListen: () => {} },
    (req) => rejectBadToken(req, token) ?? handler.handle(req),
  );
  return {
    url: new URL(`http://127.0.0.1:${server.addr.port}${MCP_HTTP_PATH}`),
    token,
    close: async () => {
      await handler.closeAll();
      await server.shutdown();
    },
  };
}

// Everything over the connection: the agent side holds no Kernel.
function mcpBackend(client: Client, historyDir: string): ChatBackend {
  return mcpChatBackend(client as unknown as McpCaller, { historyDir });
}

function commits(dir: string): string[] {
  if (!existsSync(join(dir, ".git"))) return [];
  const log = new Deno.Command("git", {
    args: ["log", "--format=%s"],
    cwd: dir,
    stdout: "piped",
    stderr: "null",
  }).outputSync();
  return new TextDecoder().decode(log.stdout).split("\n").filter(Boolean);
}

// JSON and JSONL files parsed, so ids and timings inside them normalize like
// everything else.
function parseHistoryFile(path: string, content: string): unknown {
  if (path.endsWith(".jsonl")) {
    return content.split("\n").filter(Boolean).map((line) => JSON.parse(line));
  }
  return path.endsWith(".json") ? JSON.parse(content) : content;
}

function historyFiles(historyDir: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const walk = (dir: string) => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else {
        const rel = relative(historyDir, path);
        out[rel] = parseHistoryFile(rel, readFileSync(path, "utf-8"));
      }
    }
  };
  if (existsSync(historyDir)) walk(historyDir);
  return out;
}

async function run(mode: Mode, scenario: Scenario): Promise<Outcome> {
  // A registered project: get_session_context serves registered projects.
  const parent = await Deno.makeTempDir({
    dir: TEST_TMP_DIR,
    prefix: "parity-",
  });
  const dir = createProject(parent, `Parity ${mode}`).path;
  const db = await Database.create({ driver: "pglite" });
  const historyDir = getProjectPaths(dir).historyDir;
  const kernel = new Kernel(db, {
    composition: {
      ...testStoreComposition(),
      verificationTools: defaultVerificationToolHandlers,
    },
    historyDir,
  });
  kernel.projectDir = dir;
  const served = mode === "mcp" ? serveMcp(kernel) : null;
  const client = served
    ? await connectMcp(served.url, served.token, "tide-parity")
    : null;
  try {
    // Filled turn by turn: the provider reads the array as it goes.
    const script: ProviderEvent[][] = [];
    const provider = new FakeModelProvider(script);
    const backend = client
      ? mcpBackend(client, historyDir)
      : inProcessChatBackend(kernel, () => {});
    const chat = new ChatOrchestrator(
      backend,
      new MCPManager(),
      scenario.reviewer ? { ...brain, reviewer: scenario.reviewer } : brain,
      provider,
    );
    const events: ChatEvent[][] = [];
    for (const turn of scenario.turns) {
      const vars = await turn.before?.({ kernel, chat }) ?? {};
      script.push(
        ...(typeof turn.script === "function"
          ? turn.script(vars)
          : turn.script),
      );
      const turnEvents: ChatEvent[] = [];
      await chat.sendMessage(
        turn.message,
        (e) => turnEvents.push(e),
        turn.attachments,
        undefined,
        undefined,
        undefined,
        turn.mentions?.(vars),
      );
      events.push(turnEvents);
    }
    const changes = await kernel.changelog.list({ limit: 100 });
    const usage = [];
    for (const session of await kernel.sessions.listSessions(100)) {
      usage.push(await kernel.sessions.getSessionUsage(session.id));
    }
    const files = Object.fromEntries(
      Object.entries(historyFiles(historyDir)).filter(([path]) =>
        !path.startsWith(`${TURN_USAGE_DIR}/`)
      ),
    );
    const listed = await kernel.documents.list({ includeArchived: true });
    assert(listed.ok);
    const documents = [];
    for (const document of listed.data) {
      documents.push({
        document,
        refs: await kernel.documents.listRefs(document.id),
      });
    }
    documents.sort((a, b) => a.document.name.localeCompare(b.document.name));
    return { events, changes, usage, files, documents, commits: commits(dir) };
  } finally {
    await client?.close();
    await served?.close();
    await db.close();
    await Deno.remove(parent, { recursive: true });
  }
}

const ISO_TIME = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z/g;
const TIMESTAMPED_ID =
  /\b([a-z]+(?:_[a-z]+)*)_[0-9a-z]{8,9}_[0-9a-f-]{36}(?![0-9a-f-])/g;
const UUID =
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/g;
const TIMING_KEYS = new Set([
  "durationMs",
  "totalDurationMs",
  "elapsedMs",
  "costUsd",
  "totalCostUsd",
]);
const DROPPED_KEYS = new Set(["principalId"]);
// Documents are stored by the hash of their content, and the content holds ids
// and times, so the hash differs every run. Their order does too: same-named
// files are compared as a sorted list.
const SHARDED_HASH = /\/[0-9a-f]{2}\/([0-9a-f]{64})\b/g;
const CONTENT_HASH = /\b[0-9a-f]{64}\b/g;
// Message and change ids are timestamp-derived numbers, as values and inside
// text (work-item markers).
const MIN_TIMESTAMP_ID = 1e12;
const TIMESTAMP_NUMBER = /\b\d{13,17}\b/g;
// A file stored under its content's hash.
const SHARDED_HASH_PATH = /\/[0-9a-f]{2}\/[0-9a-f]{64}/;
// An id the normalizer named.
const NORMALIZED_ID = /<[a-z_]+#\d+>/g;

// Replaces each run's ids with stable names in order of first appearance, and
// times with a placeholder, across one run's whole outcome.
function normalizer(): (value: unknown) => unknown {
  const names = new Map<string, string>();
  const rename = (id: string, prefix: string) => {
    if (!names.has(id)) names.set(id, `<${prefix}#${names.size}>`);
    return names.get(id)!;
  };
  const text = (s: string) =>
    s.replace(SHARDED_HASH, "/$1")
      .replace(CONTENT_HASH, "<sha>")
      .replace(ISO_TIME, "<time>")
      .replace(TIMESTAMPED_ID, (id, prefix: string) => rename(id, prefix))
      .replace(UUID, (id) => rename(id, "uuid"))
      .replace(TIMESTAMP_NUMBER, (id) => rename(id, "message"));
  // JSON kept as a string (a message's tool calls) is normalized inside.
  const embedded = (s: string): unknown => {
    if (!/^[[{]/.test(s)) return undefined;
    try {
      return JSON.parse(s);
    } catch {
      return undefined;
    }
  };
  const walk = (value: unknown): unknown => {
    if (typeof value === "string") {
      const parsed = embedded(value);
      return parsed === undefined ? text(value) : JSON.stringify(walk(parsed));
    }
    if (typeof value === "number" && value >= MIN_TIMESTAMP_ID) {
      return rename(String(value), "message");
    }
    if (Array.isArray(value)) return value.map(walk);
    if (value && typeof value === "object") {
      return Object.fromEntries(
        // A key set to undefined doesn't survive JSON, so it is dropped here.
        Object.entries(value).filter(([k, v]) =>
          !DROPPED_KEYS.has(k) && v !== undefined
        ).map((
          [k, v],
        ) => [
          text(k),
          TIMING_KEYS.has(k) ? "<timing>" : walk(v),
        ]),
      );
    }
    return value;
  };
  return walk;
}

function normalize(outcome: Outcome): Outcome {
  const walk = normalizer();
  // Auto-naming runs beside the turn, so where its event lands is a race. It
  // goes last, still compared.
  const settled = outcome.events.map((turn) => [
    ...turn.filter((e) => e.type !== "session_renamed"),
    ...turn.filter((e) => e.type === "session_renamed"),
  ]);
  const events = walk(settled) as ChatEvent[][];
  const changes = walk(outcome.changes) as unknown[];
  const usage = walk(outcome.usage) as unknown[];
  const grouped = new Map<string, unknown[]>();
  // Content-addressed files go last: their names differ every run, so ids
  // are numbered from the files whose order is stable.
  const byStableOrder = Object.entries(outcome.files).sort(([a], [b]) =>
    Number(SHARDED_HASH_PATH.test(a)) - Number(SHARDED_HASH_PATH.test(b))
  );
  for (const [path, content] of byStableOrder) {
    const key = walk(path) as string;
    grouped.set(key, [...grouped.get(key) ?? [], walk(content)]);
  }
  const files: Record<string, unknown> = {};
  for (const key of [...grouped.keys()].sort()) {
    const contents = grouped.get(key)!;
    // Same-named files are walked in hash order, which differs run to run, so
    // the ids inside them are numbered differently too: compare them blanked.
    files[key] = contents.length === 1
      ? contents[0]
      : contents.map((c) => JSON.stringify(c).replace(NORMALIZED_ID, "<id>"))
        .sort();
  }
  const documents = walk(outcome.documents) as unknown[];
  return { events, changes, usage, files, documents, commits: outcome.commits };
}

async function assertParity(scenario: Scenario): Promise<Outcome> {
  const local = normalize(await run("in-process", scenario));
  const remote = normalize(await run("mcp", scenario));
  assertEquals(remote.events, local.events);
  assertEquals(remote.changes, local.changes);
  assertEquals(remote.usage, local.usage);
  assertEquals(Object.keys(remote.files), Object.keys(local.files));
  assertEquals(remote.files, local.files);
  assertEquals(remote.documents, local.documents);
  assertEquals(remote.commits, local.commits);
  return local;
}

const plan = {
  summary: "Add a hello handler.",
  steps: [{ id: "s1", description: "Define it", status: "pending" as const }],
  acceptanceCriteria: [{
    id: "c1",
    text: "hello answers.",
    source: "agent" as const,
    priority: "should" as const,
  }],
  verificationPlan: [{
    id: "v1",
    claimIds: ["c1"],
    kind: "unit" as const,
    description: "Call it.",
  }],
};

Deno.test({
  ...testOpts,
  name: "parity: a read and a reply",
  fn: async () => {
    setKernelSettings({ perStepExecution: false });
    await assertParity({
      turns: [{
        message: "what modules are there?",
        script: [
          toolCall("call_1", "list_modules", {}),
          reply("None yet."),
        ],
      }],
    });
  },
});

Deno.test({
  ...testOpts,
  name: "parity: work inside an approved changeset",
  fn: async () => {
    setKernelSettings({ perStepExecution: false });
    await initCompiler();
    try {
      await assertParity({
        turns: [
          { message: "hi", script: [reply("Hello.")] },
          {
            message: "add a hello handler",
            before: async ({ kernel, chat }) => {
              const sessionId = chat.getCurrentSessionId()!;
              const cs = await kernel.changesets.create({
                sessionId,
                title: "Hello",
                plan,
              });
              await kernel.changesets.approve(cs.id);
              await kernel.changesets.startWork(cs.id);
              return { changesetId: cs.id };
            },
            script: ({ changesetId }) => [
              toolCall("call_h", "define_handler", {
                name: "hello",
                source:
                  `async function hello(c: any) { return c.json({ hi: true }); }`,
              }),
              toolCall("call_s", "update_changeset_step", {
                changeset_id: changesetId,
                step_id: "s1",
                status: "done",
              }),
              reply("Defined."),
            ],
          },
        ],
      });
    } finally {
      stopCompiler();
    }
  },
});

Deno.test({
  ...testOpts,
  name: "parity: a new session, then back to the first, compacted",
  fn: async () => {
    setKernelSettings({ perStepExecution: false });
    let first = "";
    await assertParity({
      turns: [
        { message: "first", script: [reply("One.")] },
        {
          message: "second",
          before: async ({ chat }) => {
            first = chat.getCurrentSessionId()!;
            await chat.clearSession();
          },
          script: [reply("Two.")],
        },
        {
          message: "back again",
          before: async ({ chat }) => {
            await chat.resumeSession(first);
            await chat.compactSession("We said one.");
          },
          script: [reply("Three.")],
        },
      ],
    });
  },
});

// Refutes every claim it is shown and finds no missing criteria. No model.
const refutingReviewer: Reviewer = {
  review: (packet) =>
    Promise.resolve(
      packet.kind === "refute"
        ? {
          status: "ok",
          reviewer: "stub",
          verdict: {
            results: packet.claims.map((claim) => ({
              claimId: claim.id,
              refuted: true,
              confidence: "high",
              counterexample: "hello() with no request throws",
            })),
          },
        }
        : { status: "ok", reviewer: "stub", verdict: { criteria: [] } },
    ),
};

Deno.test({
  ...testOpts,
  name: "parity: a refuted must claim keeps the changeset from landing",
  fn: async () => {
    setKernelSettings({ perStepExecution: false });
    try {
      const outcome = await assertParity({
        reviewer: refutingReviewer,
        turns: [
          { message: "hi", script: [reply("Hello.")] },
          {
            message: "check it and finish",
            before: async ({ kernel, chat }) => {
              const sessionId = chat.getCurrentSessionId()!;
              const cs = await kernel.changesets.create({
                sessionId,
                title: "Hello",
                plan: {
                  ...plan,
                  steps: [{ ...plan.steps[0]!, status: "done" as const }],
                  acceptanceCriteria: [{
                    ...plan.acceptanceCriteria[0]!,
                    priority: "must" as const,
                  }],
                },
              });
              await kernel.changesets.approve(cs.id);
              await kernel.changesets.startWork(cs.id);
              return { changesetId: cs.id };
            },
            script: ({ changesetId }) => [
              toolCall("call_r", "refute_claims", {
                changeset_id: changesetId,
              }),
              toolCall("call_c", "complete_changeset", {
                changeset_id: changesetId,
              }),
              reply("It was refuted."),
            ],
          },
        ],
      });
      const files = JSON.stringify(outcome.files);
      assertStringIncludes(files, "INCOMPLETE_VERIFICATION");
      assertStringIncludes(files, "CLAIM_REFUTED");
      assert(
        !outcome.events.flat().some((e) => e.type === "changeset_completed"),
        "a refuted must claim must keep the changeset from landing",
      );
    } finally {
      setKernelSettings({ perStepExecution: true });
    }
  },
});

Deno.test({
  ...testOpts,
  name: "parity: a plan waits for approval, then the work is anchored to it",
  fn: async () => {
    setKernelSettings({ perStepExecution: false });
    await initCompiler();
    try {
      const outcome = await assertParity({
        turns: [
          {
            message: "add a hello handler",
            script: [
              toolCall("call_p", "create_changeset", {
                title: "Hello",
                plan: {
                  summary: plan.summary,
                  steps: ["Define it"],
                  acceptanceCriteria: plan.acceptanceCriteria,
                  verificationPlan: plan.verificationPlan,
                },
              }),
            ],
          },
          {
            message: APPROVAL,
            script: [
              toolCall("call_h", "define_handler", {
                name: "hello",
                source:
                  `async function hello(c: any) { return c.json({ hi: true }); }`,
              }),
              reply("Defined."),
            ],
          },
        ],
      });
      const [planTurn, workTurn] = outcome.events;
      assert(
        planTurn!.some((e) =>
          e.type === "changeset_created" &&
          (e.changeset as { status?: string }).status === "planning"
        ),
        "the plan should wait in planning",
      );
      assert(
        workTurn!.some((e) => e.type === "work_item_created"),
        "the approved work should become a work item",
      );
      const files = JSON.stringify(outcome.files);
      assertStringIncludes(files, '"approvalMessageId":"<message#');
    } finally {
      stopCompiler();
    }
  },
});

Deno.test({
  ...testOpts,
  name: "parity: a light-lane plan starts without a round trip",
  fn: async () => {
    setKernelSettings({ perStepExecution: false });
    await initCompiler();
    try {
      const outcome = await assertParity({
        turns: [{
          message: "tweak the greeting",
          script: [
            toolCall("call_l", "create_changeset", {
              title: "Greeting",
              change_class: "light",
              plan: { summary: "Tweak the greeting.", steps: ["Tweak it"] },
            }),
            toolCall("call_f", "define_function", {
              name: "greeting",
              source: `function greeting() { return "hi"; }`,
            }),
            reply("Tweaked."),
          ],
        }],
      });
      assertStringIncludes(
        JSON.stringify(outcome.files),
        '"autoApproved":true',
      );
    } finally {
      stopCompiler();
    }
  },
});

// An 8-byte PNG signature: enough for a document of kind image/png.
const PNG_BASE64 = "iVBORw0KGgo=";

Deno.test({
  ...testOpts,
  name: "parity: attachments, mentions and pinned documents",
  fn: async () => {
    setKernelSettings({ perStepExecution: false });
    const outcome = await assertParity({
      turns: [
        { message: "hi", script: [reply("Hello.")] },
        {
          message: "look at these",
          attachments: [{
            name: "shot.png",
            type: "image/png",
            data: PNG_BASE64,
          }],
          before: async ({ kernel, chat }) => {
            const sessionId = chat.getCurrentSessionId()!;
            const pinned = await kernel.documents.create({
              name: "Style guide",
              kind: "text/markdown",
              content: "Use short sentences.",
              scope: "session",
              sessionId,
            });
            const mentioned = await kernel.documents.create({
              name: "Spec",
              kind: "text/markdown",
              content: "The page says hello.",
              scope: "project",
            });
            assert(pinned.ok && mentioned.ok);
            await kernel.documents.setPinned(pinned.data.id, true, sessionId);
            return { mentioned: mentioned.data.id };
          },
          mentions: ({ mentioned }) => [{ id: mentioned! }],
          script: [reply("Seen.")],
        },
      ],
    });
    // The attachment's bytes are stored as a document in both runs, and the
    // message cites it and the mentioned spec.
    assertStringIncludes(JSON.stringify(outcome.files), "PNG");
    const documents = JSON.stringify(outcome.documents);
    assertStringIncludes(documents, '"role":"attachment"');
    assertStringIncludes(documents, '"role":"mention"');
    assertStringIncludes(documents, '"createdBy":"user"');
  },
});

const GIT_IDENTITY_KEYS = [
  "GIT_AUTHOR_NAME",
  "GIT_AUTHOR_EMAIL",
  "GIT_COMMITTER_NAME",
  "GIT_COMMITTER_EMAIL",
];

Deno.test({
  ...testOpts,
  name: "parity: the per-step driver runs its gates and checkpoints the step",
  fn: async () => {
    setKernelSettings({ perStepExecution: true });
    await initCompiler();
    // The isolated HOME has no git identity; the checkpoint commit needs one.
    for (const key of GIT_IDENTITY_KEYS) Deno.env.set(key, "Parity Test");
    try {
      const outcome = await assertParity({
        turns: [
          {
            message: "add a greeting",
            script: [
              toolCall("call_p", "create_changeset", {
                title: "Greeting",
                plan: {
                  summary: "Add a greeting test.",
                  steps: ["Write the greeting test", "Check it reads well"],
                  acceptanceCriteria: plan.acceptanceCriteria,
                  verificationPlan: plan.verificationPlan,
                },
              }),
            ],
          },
          {
            message: APPROVAL,
            script: [
              toolCall("call_t", "define_test", {
                name: "testGreeting",
                source:
                  `async function testGreeting() { assertEquals("hi".length, 2); }`,
              }),
              reply("Wrote the test."),
              reply("It reads well."),
              // The final readiness repairs, if the driver asks for them.
              reply("Nothing more to add."),
              reply("Nothing more to add."),
            ],
          },
        ],
      });
      const events = outcome.events.flat();
      assert(
        events.some((e) => e.type === "step_completed"),
        `the step should pass its gates: ${
          JSON.stringify(
            events.map((e) => [e.type, e.text?.slice(0, 300), e.toolName]),
          )
        }`,
      );
      const files = JSON.stringify(outcome.files);
      assertStringIncludes(files, '"kind":"typecheck"');
      assert(
        outcome.commits.some((subject) => subject.startsWith("step 1")),
        `the passing step should be checkpointed: ${outcome.commits}`,
      );
    } finally {
      for (const key of GIT_IDENTITY_KEYS) Deno.env.delete(key);
      stopCompiler();
      setKernelSettings({ perStepExecution: true });
    }
  },
});

Deno.test({
  ...testOpts,
  name: "parity: the end of a turn runs the owed reviews before it completes",
  fn: async () => {
    setKernelSettings({ perStepExecution: false });
    await initCompiler();
    try {
      const outcome = await assertParity({
        reviewer: refutingReviewer,
        turns: [
          { message: "hi", script: [reply("Hello.")] },
          {
            message: "add the hello handler",
            before: async ({ kernel, chat }) => {
              const sessionId = chat.getCurrentSessionId()!;
              const cs = await kernel.changesets.create({
                sessionId,
                title: "Hello",
                plan: {
                  ...plan,
                  acceptanceCriteria: [{
                    ...plan.acceptanceCriteria[0]!,
                    priority: "must" as const,
                  }],
                },
              });
              await kernel.changesets.approve(cs.id);
              await kernel.changesets.startWork(cs.id);
            },
            // A builder tool and no lifecycle call: the loop settles the step
            // and tries to complete the changeset itself.
            script: [
              toolCall("call_h", "define_handler", {
                name: "hello",
                source:
                  `async function hello(c: any) { return c.json({ hi: true }); }`,
              }),
              reply("Defined."),
            ],
          },
        ],
      });
      const files = JSON.stringify(outcome.files);
      assertStringIncludes(files, '"kind":"adversarial"');
      assert(
        !outcome.events.flat().some((e) => e.type === "changeset_completed"),
        "a refuted must claim must keep the changeset from landing",
      );
    } finally {
      stopCompiler();
      setKernelSettings({ perStepExecution: true });
    }
  },
});
