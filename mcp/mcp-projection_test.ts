import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Kernel } from "../core/registries.ts";
import { Database } from "../core/db.ts";
import { initCompiler, stopCompiler } from "../core/compiler.ts";
import { createAppServer } from "../core/app-server.ts";
import type { ChangeContext } from "../core/changelog.ts";
import { AGENT_TOOLS, CUSTOM_TOOLS } from "../core/tools/definitions.ts";
import {
  isDestructiveTool,
  MODIFICATION_TOOLS,
  OPEN_WORLD_TOOLS,
  READ_ONLY_TOOLS,
} from "../core/tools/dispatch.ts";
import {
  applyDeprecation,
  dispatchMcpTool,
  MCP_DEPRECATED_META_KEY,
  MCP_DEPRECATIONS,
  MCP_ONLY_TOOLS,
  MCP_SURFACE_META_KEY,
  type McpDeprecation,
  mcpSurfaceFingerprint,
  mcpSurfaceMeta,
  type McpToolListing,
  projectedMcpTools,
} from "./mcp-projection.ts";
import { createMcpServer, type McpServerDeps } from "./mcp-server.ts";
import {
  LSP_RENAME_TOOL,
  MCP_MAX_ARG_BYTES,
  MCP_SURFACE_VERSION,
} from "../core/config.ts";
import {
  TOOL_CAPABILITY_REQUIREMENTS,
  type ToolCapability,
} from "../core/tool-capabilities.ts";
import {
  type CompositionContext,
  coreOnlyComposition,
} from "../core/composition.ts";
import { testStoreComposition } from "../verification/test-stores.ts";
import { testComposition } from "../cli/test-composition.ts";

const testOpts = { sanitizeResources: false, sanitizeOps: false };
const noop = () => {};

// The open test composition (stores + verification tool handlers, no agent) that
// most tests assemble into their Kernel — the tool handlers travel on the
// composition, so a capability-gated verb dispatches iff its handler is present.
// This is the surface `opentide mcp` publishes; the Tide assembly adds the agent
// verbs on top (tide/assembly_test.ts).
const OPEN_COMPOSITION = testComposition();

async function withKernel<T>(
  fn: (kernel: Kernel) => Promise<T>,
  composition: CompositionContext = testComposition(),
): Promise<T> {
  const db = await Database.create({ driver: "pglite" });
  const kernel = new Kernel(db, { composition });
  try {
    return await fn(kernel);
  } finally {
    await db.close();
  }
}

// A fresh ChangeContext per call, exactly as mcp-server.ts mints one — same
// stable session id, new object so the gate's changesetId pinning can't leak.
function mcpContext(sessionId: string): ChangeContext {
  return { sessionId, userMessage: "External MCP agent" };
}

async function freePort(): Promise<number> {
  const listener = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  const port = (listener.addr as Deno.NetAddr).port;
  listener.close();
  return port;
}

// Like withKernel but with the esbuild compiler up and a live app-server, so a
// route built through MCP dispatch can actually be served and fetched.
async function withServedKernel<T>(
  fn: (
    kernel: Kernel,
    rebuild: () => void,
    baseUrl: string,
  ) => Promise<T>,
): Promise<T> {
  await initCompiler();
  const db = await Database.create({ driver: "pglite" });
  const kernel = new Kernel(db, { composition: testComposition() });
  const port = await freePort();
  const appServer = createAppServer(kernel, port);
  const rebuild = () => appServer.rebuild();
  try {
    return await fn(kernel, rebuild, `http://127.0.0.1:${port}`);
  } finally {
    await appServer.shutdown();
    await db.close();
    stopCompiler();
  }
}

// A minimal valid changeset plan: one "should" acceptance criterion (not "must",
// so the completion gate's optional model-backed auto-refute never fires — the
// flow stays hermetic and needs no API key) and one planned check. No steps, so
// there is nothing left "in progress" blocking completion.
function demoPlan() {
  return {
    summary: "Add an MCP-built demo route",
    steps: [] as string[],
    acceptanceCriteria: [{
      id: "claim_serves",
      text: "GET /api/mcp-demo returns ok.",
      source: "agent",
      priority: "should",
    }],
    verificationPlan: [{
      id: "check_serves",
      claimIds: ["claim_serves"],
      kind: "e2e",
      description: "Fetch the route and assert a 200 body.",
    }],
  };
}

// A real MCP Client wired to a real createMcpServer over the SDK's in-process
// linked transport — no subprocess, no stdio. This exercises mcp-server.ts's
// actual handler wiring (session minting + fresh-per-call ChangeContext), which
// dispatchMcpTool tests bypass. dispose() tears both ends down.
async function connectMcpClient(
  deps: McpServerDeps,
): Promise<{ client: Client; dispose: () => Promise<void> }> {
  const server = createMcpServer(deps);
  const [clientTransport, serverTransport] = InMemoryTransport
    .createLinkedPair();
  const client = new Client({ name: "mcp-test-client", version: "0.0.0" });
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);
  return {
    client,
    dispose: async () => {
      await client.close();
      await server.close();
    },
  };
}

// Join the text content blocks of a callTool result.
function toolText(result: { content: unknown }): string {
  return (result.content as Array<{ type: string; text?: string }>)
    .filter((b) => b.type === "text")
    .map((b) => b.text ?? "")
    .join("\n");
}

Deno.test({
  ...testOpts,
  name:
    "projectedMcpTools reuses AGENT_TOOLS verbatim (names + schema, no rename)",
  fn: () => {
    const tools = projectedMcpTools(OPEN_COMPOSITION);
    const agentNames = new Set(AGENT_TOOLS.map((t) => t.name));
    for (const tool of tools) {
      if (MCP_ONLY_TOOLS.has(tool.name)) continue;
      assert(agentNames.has(tool.name), `${tool.name} not in AGENT_TOOLS`);
      assert(
        typeof tool.description === "string" && tool.description.length > 0,
      );
      assertEquals(tool.inputSchema.type, "object");
    }
    // Stable public contract: core build verbs are advertised unchanged.
    const names = new Set(tools.map((t) => t.name));
    for (const verb of ["define_handler", "register_route", "list_routes"]) {
      assert(names.has(verb), `expected ${verb} in MCP tool list`);
    }
  },
});

// F2: the projection gates the full capability registry, not just a spot-check.
// Advertise iff the required layer is assembled — for EVERY declared verb.
Deno.test({
  ...testOpts,
  name:
    "projection advertises a capability verb iff its layer is registered (whole registry)",
  fn: () => {
    const declared = Object.keys(TOOL_CAPABILITY_REQUIREMENTS);
    assert(
      declared.length > 0,
      "registry should declare capability-gated verbs",
    );

    // Verification assembled, agent absent (the open stack) → exactly the
    // verification verbs are advertised. The both-layers case (every declared
    // verb advertised) is the Tide stack, asserted in tide/assembly_test.ts.
    const advertised = new Set(
      projectedMcpTools(OPEN_COMPOSITION).map((t) => t.name),
    );
    for (const verb of declared) {
      assertEquals(
        advertised.has(verb),
        TOOL_CAPABILITY_REQUIREMENTS[verb] === "verification",
        `${verb} should be advertised iff its layer is assembled`,
      );
    }

    // No layers assembled (coreOnly composition) → none of them is advertised,
    // but ungated read verbs (no capability requirement) remain.
    const hidden = new Set(
      projectedMcpTools(coreOnlyComposition()).map((t) => t.name),
    );
    for (const verb of declared) {
      assert(
        !hidden.has(verb),
        `${verb} should be hidden when its layer is absent`,
      );
    }
    assert(hidden.has("list_routes"), "ungated read verb should remain");
    assert(hidden.has("list_handlers"), "ungated read verb should remain");
  },
});

// F2 drift guard: TOOL_CAPABILITY_REQUIREMENTS is the ONLY thing the MCP
// projection gates on, so it must never drift from dispatch.ts's actual getter
// call-sites — else the advertised list would diverge from the callable one.
// Rather than trust a hand-copied list, derive the truth from the dispatch
// source: attribute each verificationTools()/agentTools() call (direct, or
// routed through a getter-calling helper such as refuteChangesetClaims) to its
// enclosing `case "verb":`, then assert the registry matches that in both
// directions. A future capability-gated verb — direct or helper-routed — cannot
// silently desync.
const GETTER_CAPABILITY: ReadonlyArray<[RegExp, ToolCapability]> = [
  [/\bverificationTools\(/, "verification"],
  [/\bagentTools\(/, "agent"],
];

function dispatchGetterCallSites(): Map<string, Set<ToolCapability>> {
  const src = Deno.readTextFileSync(
    new URL("../core/tools/dispatch.ts", import.meta.url),
  );
  const lines = src.split("\n");
  const fnDef = /^(?:export\s+)?(?:async\s+)?function\s+([A-Za-z0-9_]+)\s*\(/;
  const caseDef = /^\s*case\s+"([a-z0-9_]+)"\s*:/;

  // Top-level function definitions, in source order.
  const fns: Array<{ name: string; line: number }> = [];
  lines.forEach((line, i) => {
    const m = line.match(fnDef);
    if (m?.[1]) fns.push({ name: m[1], line: i });
  });
  const dispatch = fns.find((f) => f.name === "dispatchTool");
  assert(dispatch, "dispatchTool must be a top-level function in dispatch.ts");
  const dispatchStart = dispatch.line;

  const enclosingFn = (i: number): string | null => {
    let name: string | null = null;
    for (const f of fns) {
      if (f.line <= i) name = f.name;
      else break;
    }
    return name;
  };

  // Helper functions (top-level, not dispatchTool) that call a getter directly:
  // a `case` that calls one of these transitively depends on that capability.
  const helperCapability = new Map<string, ToolCapability>();
  lines.forEach((line, i) => {
    for (const [token, cap] of GETTER_CAPABILITY) {
      if (token.test(line)) {
        const fn = enclosingFn(i);
        if (fn && fn !== "dispatchTool") helperCapability.set(fn, cap);
      }
    }
  });
  // Imported helper from project-readiness.ts; its implementation calls
  // verificationTools() before adding project-doctor consistency checks.
  helperCapability.set("checkProjectAwareReadiness", "verification");

  // Within dispatchTool's switch: the nearest preceding `case "verb":`.
  const enclosingCase = (i: number): string | null => {
    let verb: string | null = null;
    for (let j = dispatchStart; j <= i; j++) {
      const line = lines[j];
      if (line === undefined) continue;
      const m = line.match(caseDef);
      if (m?.[1]) verb = m[1];
    }
    return verb;
  };

  const reached = new Map<string, Set<ToolCapability>>();
  const add = (verb: string, cap: ToolCapability) => {
    const set = reached.get(verb) ?? new Set<ToolCapability>();
    set.add(cap);
    reached.set(verb, set);
  };

  lines.forEach((line, i) => {
    if (i < dispatchStart) return; // getter calls above the switch are helper bodies
    for (const [token, cap] of GETTER_CAPABILITY) {
      if (token.test(line)) {
        const verb = enclosingCase(i);
        if (verb) add(verb, cap);
      }
    }
    for (const [helper, cap] of helperCapability) {
      if (line.includes(`${helper}(`)) {
        const verb = enclosingCase(i);
        if (verb) add(verb, cap);
      }
    }
  });

  return reached;
}

Deno.test({
  ...testOpts,
  name:
    "TOOL_CAPABILITY_REQUIREMENTS cannot drift from dispatch getter call-sites",
  fn: () => {
    const reached = dispatchGetterCallSites();

    // Both directions: the verbs that reach a capability getter are EXACTLY the
    // registry's keys — no undeclared getter-gated verb, no stale declaration.
    assertEquals(
      new Set(reached.keys()),
      new Set(Object.keys(TOOL_CAPABILITY_REQUIREMENTS)),
      "capability registry keys must equal dispatch's getter-gated verbs",
    );

    // Each declared requirement is a capability the verb genuinely reaches in
    // dispatch (its hard dependency), so the gate never advertises a verb the
    // assembly cannot run.
    for (
      const [verb, capability] of Object.entries(TOOL_CAPABILITY_REQUIREMENTS)
    ) {
      const caps = reached.get(verb);
      assert(caps, `${verb} declares "${capability}" but reaches no getter`);
      assert(
        caps.has(capability),
        `${verb} declares "${capability}" but dispatch reaches: ${
          [...caps].join(", ")
        }`,
      );
    }
    // The loop above already exercises the transitive (helper-routed) reach: it
    // asserts refute_claims reaches "agent", which it does ONLY via the
    // refuteChangesetClaims helper (no direct agentTools() call in its case
    // body) — proving the guard catches a verb gated purely through a helper.
  },
});

Deno.test({
  ...testOpts,
  name: "projection trims IDE-only session/launcher verbs (F1)",
  fn: () => {
    const names = new Set(
      projectedMcpTools(OPEN_COMPOSITION).map((t) => t.name),
    );
    // These survive into AGENT_TOOLS but are meaningless to a headless external
    // agent, so the MCP face must not advertise them.
    for (
      const verb of [
        "summarize_session",
        "get_session_context",
        "manage_sessions",
        "list_projects",
        "get_project_context",
      ]
    ) {
      assert(!names.has(verb), `${verb} should be trimmed from the MCP list`);
      // The verb is still in the underlying catalog — this is a projection-layer
      // hide, not a removal from AGENT_TOOLS (the integrated agent keeps it).
      assert(
        AGENT_TOOLS.some((t) => t.name === verb),
        `${verb} should remain in AGENT_TOOLS`,
      );
    }
    // Project-config and build verbs that ARE meaningful headless stay advertised.
    assert(names.has("set_system_prompt"), "set_system_prompt should remain");
    assert(names.has("generate_project_docs"), "doc verb should remain");
    assert(names.has("define_handler"), "build verb should remain");
  },
});

Deno.test({
  ...testOpts,
  name: "dispatchMcpTool refuses a trimmed session/launcher verb (F1)",
  fn: async () => {
    await withKernel(async (kernel) => {
      const result = await dispatchMcpTool(
        "get_session_context",
        { session_id: "whatever" },
        kernel,
        noop,
      );
      assertEquals(result.isError, true);
      const block = result.content[0];
      assert(block?.type === "text");
      assertStringIncludes(block.text, "not exposed over MCP");
    });
  },
});

Deno.test({
  ...testOpts,
  name: "dispatchMcpTool runs a read tool through core dispatch end-to-end",
  fn: async () => {
    await withKernel(async (kernel) => {
      kernel.routes.register("GET", "/api/ping", "ping", undefined, "demo");

      const result = await dispatchMcpTool("list_routes", {}, kernel, noop);

      assertEquals(result.isError, undefined);
      assertEquals(result.content.length, 1);
      const block = result.content[0];
      assert(block?.type === "text");
      const routes = JSON.parse(block.text) as Array<{ path: string }>;
      assert(
        routes.some((r) => r.path === "/api/ping"),
        "registered route should appear in tool output",
      );
    });
  },
});

Deno.test({
  ...testOpts,
  name: "dispatchMcpTool maps a failing tool to an isError result",
  fn: async () => {
    await withKernel(async (kernel) => {
      const result = await dispatchMcpTool(
        "get_handler_source",
        { handlerName: "does_not_exist" },
        kernel,
        noop,
      );
      assertEquals(result.isError, true);
      const block = result.content[0];
      assert(block?.type === "text");
      assertStringIncludes(block.text, "NOT_FOUND");
    });
  },
});

Deno.test({
  ...testOpts,
  name:
    "dispatchMcpTool returns a clean not-available result for a hidden verb",
  fn: async () => {
    // A composition without the agent tool handlers → refute_claims (agent-gated)
    // is hidden and dispatch returns a clean not-available result, never a throw.
    await withKernel(async (kernel) => {
      const result = await dispatchMcpTool(
        "refute_claims",
        {},
        kernel,
        noop,
      );
      assertEquals(result.isError, true);
      const block = result.content[0];
      assert(block?.type === "text");
      assertStringIncludes(block.text, "not available");
    }, testStoreComposition());
  },
});

// The Slice B gate: a headless external MCP agent — no IDE, no integrated agent,
// no human/REST approver — creates a changeset, it auto-advances to in_progress,
// it builds a handler + registers a route, and the route serves in the live
// core. All through dispatchMcpTool with an MCP ChangeContext.
Deno.test({
  ...testOpts,
  name:
    "MCP mutating flow: create → auto-approved in_progress → build route serves → complete",
  fn: async () => {
    await withServedKernel(async (kernel, rebuild, baseUrl) => {
      const sessionId = "mcp:flow-session";
      let rebuilds = 0;
      const countingRebuild = () => {
        rebuilds++;
        rebuild();
      };

      // 1. Create the changeset — the projection must auto-approve + start it.
      const created = await dispatchMcpTool(
        "create_changeset",
        { title: "MCP demo", plan: demoPlan() },
        kernel,
        countingRebuild,
        mcpContext(sessionId),
      );
      assertEquals(created.isError, undefined);
      const note = created.content[0];
      assert(note?.type === "text");
      assertStringIncludes(note.text, "auto-approved and started");
      assertStringIncludes(note.text, "in_progress");
      const csBlock = created.content[1];
      assert(csBlock?.type === "text");
      const changeset = JSON.parse(csBlock.text) as {
        id: string;
        status: string;
      };
      assertEquals(changeset.status, "in_progress");

      // 2. Build a handler — the mutation gate must NOT bite now.
      const handlerResult = await dispatchMcpTool(
        "define_handler",
        {
          name: "mcp_demo",
          source:
            `async function mcp_demo(c: any) { return c.json({ ok: true, via: "mcp" }); }`,
        },
        kernel,
        countingRebuild,
        mcpContext(sessionId),
      );
      assertEquals(handlerResult.isError, undefined, "handler should compile");

      // 3. Register the route.
      const routeResult = await dispatchMcpTool(
        "register_route",
        { method: "GET", path: "/api/mcp-demo", handlerName: "mcp_demo" },
        kernel,
        countingRebuild,
        mcpContext(sessionId),
      );
      assertEquals(routeResult.isError, undefined, "route should register");
      assert(rebuilds > 0, "register_route must fire rebuild");
      assert(
        kernel.routes.get("GET", "/api/mcp-demo"),
        "route should be registered in the kernel",
      );

      // 4. The externally-built route actually serves in the live core.
      const res = await fetch(`${baseUrl}/api/mcp-demo`);
      assertEquals(res.status, 200);
      assertEquals(await res.json(), { ok: true, via: "mcp" });

      // 5. Record a passing verification run, then complete the changeset.
      const verified = await dispatchMcpTool(
        "record_verification_run",
        {
          changeset_id: changeset.id,
          status: "passed",
          summary: "Route serves as expected.",
          evidence: [{
            id: "ev_serves",
            kind: "test_result",
            summary: "GET /api/mcp-demo returned 200.",
            status: "passed",
          }],
          claimResults: [{
            claimId: "claim_serves",
            status: "passed",
            evidenceIds: ["ev_serves"],
          }],
          residualRisks: [],
        },
        kernel,
        countingRebuild,
        mcpContext(sessionId),
      );
      assertEquals(
        verified.isError,
        undefined,
        "verification run should record",
      );

      const completed = await dispatchMcpTool(
        "complete_changeset",
        { changeset_id: changeset.id },
        kernel,
        countingRebuild,
        mcpContext(sessionId),
      );
      assertEquals(completed.isError, undefined, "changeset should complete");
      const doneBlock = completed.content[0];
      assert(doneBlock?.type === "text");
      const done = JSON.parse(doneBlock.text) as { status: string };
      assertEquals(done.status, "completed");
    });
  },
});

// The gate still bites for a session with no in_progress changeset: a mutation
// verb returns a clean isError carrying CHANGESET_REQUIRED, not a crash.
Deno.test({
  ...testOpts,
  name: "MCP gate blocks a mutation when the session has no changeset",
  fn: async () => {
    await withKernel(async (kernel) => {
      const result = await dispatchMcpTool(
        "define_handler",
        {
          name: "orphan",
          source: `async function orphan(c: any) { return c.json({}); }`,
        },
        kernel,
        noop,
        mcpContext("mcp:no-changeset"),
      );
      assertEquals(result.isError, true);
      const block = result.content[0];
      assert(block?.type === "text");
      assertStringIncludes(block.text, "CHANGESET_REQUIRED");
    });
  },
});

// The completion/readiness gate — the actual moat — is untouched by
// auto-approve: completing an in_progress changeset with no verification run
// still fails with INCOMPLETE_VERIFICATION.
Deno.test({
  ...testOpts,
  name: "MCP readiness gate still blocks completion with no verification run",
  fn: async () => {
    await withKernel(async (kernel) => {
      const sessionId = "mcp:readiness-session";
      const created = await dispatchMcpTool(
        "create_changeset",
        { title: "Unverified", plan: demoPlan() },
        kernel,
        noop,
        mcpContext(sessionId),
      );
      assertEquals(created.isError, undefined);
      const csBlock = created.content[1];
      assert(csBlock?.type === "text");
      const changeset = JSON.parse(csBlock.text) as { id: string };

      const completed = await dispatchMcpTool(
        "complete_changeset",
        { changeset_id: changeset.id },
        kernel,
        noop,
        mcpContext(sessionId),
      );
      assertEquals(completed.isError, true);
      const block = completed.content[0];
      assert(block?.type === "text");
      assertStringIncludes(block.text, "INCOMPLETE_VERIFICATION");
    });
  },
});

// Session scoping: a changeset created under one MCP session is not the active
// changeset for a different session id — the gate can't be satisfied by another
// agent's in-flight work.
Deno.test({
  ...testOpts,
  name: "MCP changeset is scoped to its creating session id",
  fn: async () => {
    await withKernel(async (kernel) => {
      const created = await dispatchMcpTool(
        "create_changeset",
        { title: "Scoped", plan: demoPlan() },
        kernel,
        noop,
        mcpContext("mcp:session-a"),
      );
      assertEquals(created.isError, undefined);

      const activeForA = await kernel.changesets.getActive("mcp:session-a");
      assertEquals(activeForA?.status, "in_progress");

      const activeForB = await kernel.changesets.getActive("mcp:session-b");
      assertEquals(activeForB, null, "other session sees no active changeset");
    });
  },
});

// Server-layer wiring: drive a REAL MCP Client against createMcpServer over the
// SDK's in-process transport. This covers mcp-server.ts (session minting +
// fresh-per-call ChangeContext + SDK handler binding) that the dispatchMcpTool
// tests bypass — the whole slice through the actual protocol, ending in a live
// fetch of the externally-built route.
Deno.test({
  ...testOpts,
  name:
    "createMcpServer: real MCP client lists, auto-approves, builds a serving route",
  fn: async () => {
    await withServedKernel(async (kernel, rebuild, baseUrl) => {
      const { client, dispose } = await connectMcpClient({ kernel, rebuild });
      try {
        const { tools } = await client.listTools();
        const names = new Set(tools.map((t: { name: string }) => t.name));
        for (
          const verb of ["create_changeset", "define_handler", "register_route"]
        ) {
          assert(names.has(verb), `${verb} should be advertised`);
        }

        // The server mints its own session; create_changeset must auto-advance.
        const created = await client.callTool({
          name: "create_changeset",
          arguments: { title: "SDK demo", plan: demoPlan() },
        });
        assertEquals(created.isError, undefined);
        assertStringIncludes(toolText(created), "auto-approved and started");
        assertStringIncludes(toolText(created), "in_progress");

        // define_handler under the server's own session must clear the gate.
        const handler = await client.callTool({
          name: "define_handler",
          arguments: {
            name: "mcp_sdk",
            source:
              `async function mcp_sdk(c: any) { return c.json({ ok: true, via: "sdk" }); }`,
          },
        });
        assertEquals(
          handler.isError,
          undefined,
          `define_handler: ${toolText(handler)}`,
        );

        const route = await client.callTool({
          name: "register_route",
          arguments: {
            method: "GET",
            path: "/api/mcp-sdk",
            handlerName: "mcp_sdk",
          },
        });
        assertEquals(
          route.isError,
          undefined,
          `register_route: ${toolText(route)}`,
        );

        const res = await fetch(`${baseUrl}/api/mcp-sdk`);
        assertEquals(res.status, 200);
        assertEquals(await res.json(), { ok: true, via: "sdk" });
      } finally {
        await dispose();
      }
    });
  },
});

// Each server instance mints its OWN session: a changeset created through one
// server does not satisfy the gate for a client on a second server over the
// same kernel. This is the scoping guarantee at the layer that mints the id.
Deno.test({
  ...testOpts,
  name: "createMcpServer: sessions are isolated per server instance",
  fn: async () => {
    await withKernel(async (kernel) => {
      const a = await connectMcpClient({ kernel, rebuild: noop });
      const b = await connectMcpClient({ kernel, rebuild: noop });
      try {
        const created = await a.client.callTool({
          name: "create_changeset",
          arguments: { title: "A's work", plan: demoPlan() },
        });
        assertEquals(created.isError, undefined);

        // B has a different minted session, so A's in_progress changeset is not
        // active for it — the mutation gate must still bite.
        const blocked = await b.client.callTool({
          name: "define_handler",
          arguments: {
            name: "b_orphan",
            source: `async function b_orphan(c: any) { return c.json({}); }`,
          },
        });
        assertEquals(blocked.isError, true);
        assertStringIncludes(toolText(blocked), "CHANGESET_REQUIRED");
      } finally {
        await a.dispose();
        await b.dispose();
      }
    });
  },
});

// The id the server works under has to resolve to a REAL session record, not
// merely be unique. Changesets and changelog records store their sessionId, and
// project-doctor.ts counts a reference to a session that does not exist as a
// consistency ERROR — which the completion gate then refuses to look past
// (PROJECT_CONSISTENCY_ERRORS). While the server minted a synthetic `mcp:<uuid>`
// every MCP write left a dangling reference and complete_changeset was
// unreachable over this transport, so this pins the record's existence, not just
// the scoping.
Deno.test({
  ...testOpts,
  name:
    "createMcpServer: the session it works under is a stored session record",
  fn: async () => {
    await withKernel(async (kernel) => {
      const a = await connectMcpClient({ kernel, rebuild: noop });
      try {
        const created = await a.client.callTool({
          name: "create_changeset",
          arguments: { title: "Session-backed work", plan: demoPlan() },
        });
        assertEquals(created.isError, undefined);

        // Exactly one session was created, and it is named for the client so
        // the work is attributable in the IDE's session list, plus a tag so
        // two sessions from one client read differently.
        const sessions = await kernel.sessions.listSessions();
        const mine = sessions.filter((s) =>
          /^mcp-test-client \(MCP\) #[0-9a-f]{4}$/.test(s.name)
        );
        assertEquals(mine.length, 1);
        const sessionId = mine[0]!.id;

        // The changeset the client just created is scoped to THAT session, so the
        // id on it is the stored one rather than a synthetic string.
        const active = await kernel.changesets.getActive(sessionId);
        assert(
          active,
          "the created changeset is active for the stored session",
        );
        assertEquals(active.title, "Session-backed work");

        // And the record is readable by id — what project-doctor resolves against.
        const stored = await kernel.sessions.getSession(sessionId);
        assert(stored, "the session id resolves to a stored session");
      } finally {
        await a.dispose();
      }
    });
  },
});

// Who made the call: the client's initialize name labels its session and every
// change it drives, and every call lands in the audit, metadata only.
Deno.test({
  ...testOpts,
  name: "createMcpServer: calls carry the client's principal and are audited",
  fn: async () => {
    await withKernel(async (kernel) => {
      const a = await connectMcpClient({ kernel, rebuild: noop });
      try {
        const created = await a.client.callTool({
          name: "create_changeset",
          arguments: { title: "Attributed work", plan: demoPlan() },
        });
        assertEquals(created.isError, undefined);
        const cs = await kernel.changesets.list();
        assertEquals(cs.length, 1);

        const handler = await a.client.callTool({
          name: "define_handler",
          arguments: {
            name: "audited",
            source:
              `async function audited(c: any) { return c.json({ ok: true }); }`,
          },
        });
        assertEquals(handler.isError, undefined);

        // Newest first. A write inside the changeset records which one.
        const [write, create] = await kernel.mcpAudit!.list();
        assertEquals(create?.toolName, "create_changeset");
        assertEquals(create?.changesetId, null);
        assertEquals(write?.toolName, "define_handler");
        assertEquals(write?.changesetId, cs[0]!.id);
        for (const call of [create!, write!]) {
          assertEquals(call.principalId, "local:mcp-test-client");
          assertEquals(call.transport, "stdio");
          assertEquals(call.decision, "allow");
          assertEquals(call.reason, null);
          assertEquals(call.sessionId, cs[0]!.sessionId);
          assert(call.argBytes > 0);
        }
      } finally {
        await a.dispose();
      }
    });
  },
});

Deno.test({
  ...testOpts,
  name: "createMcpServer: oversized arguments are refused before dispatch",
  fn: async () => {
    await withKernel(async (kernel) => {
      const a = await connectMcpClient({ kernel, rebuild: noop });
      try {
        const result = await a.client.callTool({
          name: "create_changeset",
          arguments: {
            title: "x".repeat(MCP_MAX_ARG_BYTES),
            plan: demoPlan(),
          },
        });
        assertEquals(result.isError, true);
        assertStringIncludes(toolText(result), "ARGS_TOO_LARGE");
        assertEquals((await kernel.changesets.list()).length, 0);

        const [call] = await kernel.mcpAudit!.list();
        assertEquals(call?.decision, "deny");
        assertEquals(call?.reason, "args_too_large");
        assert(call!.argBytes > MCP_MAX_ARG_BYTES);
      } finally {
        await a.dispose();
      }
    });
  },
});

// A change made over MCP names the client in its changelog context and in any
// attestation it mints, beside the existing authorOrigin "ai".
Deno.test({
  ...testOpts,
  name: "dispatch stamps principalId on changelog records",
  fn: async () => {
    await withKernel(async (kernel) => {
      const session = await kernel.sessions.createSession("Principal");
      const context = {
        ...mcpContext(session.id),
        principalId: "local:codex",
      };
      const cs = await dispatchMcpTool(
        "create_changeset",
        { title: "Principal", plan: demoPlan() },
        kernel,
        noop,
        { ...context },
      );
      assertEquals(cs.isError, undefined);
      const id = (await kernel.changesets.getActive(session.id))!.id;
      const fn = await dispatchMcpTool(
        "define_handler",
        {
          name: "principal_probe",
          source:
            `async function principal_probe(c: any) { return c.json({ ok: true }); }`,
        },
        kernel,
        noop,
        { ...context },
      );
      assertEquals(fn.isError, undefined, toolText(fn));
      const records = await kernel.changelog.listByChangeset(id);
      assert(records.length > 0);
      for (const r of records) {
        assertEquals(r.context?.principalId, "local:codex");
      }
    });
  },
});

// --- F3: MCP tool annotations + description generalisation ---

const CUSTOM_TOOL_NAMES = new Set(CUSTOM_TOOLS.map((t) => t.name));

// The read-only allowlist is the safety-critical signal: it must be a set of real
// verbs, disjoint from the mutation set, and it must NOT leak an attestation-
// minting verifier (which writes proof onto the changeset and only LOOKS like a
// read). This last check is the crux of the slice — a regression here would let a
// client auto-run a state-writing verb.
Deno.test({
  ...testOpts,
  name:
    "READ_ONLY_TOOLS is a vetted allowlist, disjoint from mutations, no minting verifiers",
  fn: () => {
    for (const name of READ_ONLY_TOOLS) {
      assert(
        CUSTOM_TOOL_NAMES.has(name),
        `READ_ONLY_TOOLS has unknown verb ${name}`,
      );
      assert(
        !MODIFICATION_TOOLS.has(name),
        `${name} is both read-only and a mutation`,
      );
    }
    for (const name of OPEN_WORLD_TOOLS) {
      assert(
        CUSTOM_TOOL_NAMES.has(name),
        `OPEN_WORLD_TOOLS has unknown verb ${name}`,
      );
    }
    // These write attestations onto the active changeset, so they are writers
    // despite reading like reads — readOnlyHint must never be true for them.
    for (
      const minting of [
        "run_audit",
        "run_tests",
        "check_export_types",
        "test_coverage",
        "verify_formal_specs",
        "refute_claims",
      ]
    ) {
      assert(
        !READ_ONLY_TOOLS.has(minting),
        `${minting} mints attestations and must not be read-only`,
      );
    }
  },
});

// The exact annotation each representative verb must carry, derived by hand from
// the ratified rules — an independent oracle, so a rule change that flips a hint
// is caught rather than rubber-stamped by re-deriving with the same code.
Deno.test({
  ...testOpts,
  name: "projected tools carry correct MCP annotations per the ratified rules",
  fn: () => {
    const byName = new Map(
      projectedMcpTools(OPEN_COMPOSITION).map((t) => [t.name, t]),
    );
    const ann = (name: string) => {
      const tool = byName.get(name);
      assert(tool, `${name} should be projected`);
      assert(tool.annotations, `${name} should carry annotations`);
      return tool.annotations;
    };

    // A pure read: read-only, closed-world, no destructive/idempotent hints.
    const listRoutes = ann("list_routes");
    assertEquals(listRoutes.readOnlyHint, true);
    assertEquals(listRoutes.openWorldHint, false);
    assertEquals(listRoutes.destructiveHint, undefined);
    assertEquals(listRoutes.idempotentHint, undefined);
    assertEquals(listRoutes.title, "List Routes");

    // A create/update writer: not read-only, non-destructive, not claimed idempotent.
    const defineHandler = ann("define_handler");
    assertEquals(defineHandler.readOnlyHint, false);
    assertEquals(defineHandler.destructiveHint, false);
    assertEquals(defineHandler.idempotentHint, false);
    assertEquals(defineHandler.openWorldHint, false);

    // The consolidated removal verb in MODIFICATION_TOOLS: destructive + idempotent
    // (classified via its "remove_" name prefix, like the per-entity removals it folds).
    const removeEntity = ann("remove_entity");
    assertEquals(removeEntity.readOnlyHint, false);
    assertEquals(removeEntity.destructiveHint, true);
    assertEquals(removeEntity.idempotentHint, true);

    // A removal OUTSIDE MODIFICATION_TOOLS — the name-family rule must still catch
    // it (the ratified "all non-read verbs" scope).
    const deleteBranch = ann("delete_branch");
    assertEquals(deleteBranch.destructiveHint, true);
    assertEquals(deleteBranch.idempotentHint, true);

    // Destructive-by-effect, not by name: arbitrary DML/DDL, not idempotent.
    const executeSql = ann("execute_sql");
    assertEquals(executeSql.destructiveHint, true);
    assertEquals(executeSql.idempotentHint, false);
    assertEquals(executeSql.title, "Execute SQL");

    // Open-world reach: a package registry / advisory lookup.
    assertEquals(ann("install_package").openWorldHint, true);
    const pkgSec = ann("check_package_security");
    assertEquals(pkgSec.openWorldHint, true);
    assertEquals(pkgSec.readOnlyHint, true); // reads advisories, mints nothing

    // The crux on the wire: check_export_types LOOKS like a read but mints, so it
    // must be advertised as a writer.
    assertEquals(ann("check_export_types").readOnlyHint, false);
    assertEquals(ann("run_audit").readOnlyHint, false);

    // Git status flushes live Tide state before reading the repository; commit and
    // push are explicit user-confirmed writers, and push reaches an external remote.
    assertEquals(ann("git_status").readOnlyHint, false);
    assertEquals(ann("git_commit").readOnlyHint, false);
    assertEquals(ann("git_push").openWorldHint, true);
  },
});

// Coverage guard: every advertised verb carries well-formed annotations matching
// the rules, so a newly-added verb cannot ship un-annotated or shaped wrongly.
Deno.test({
  ...testOpts,
  name: "every projected tool is annotated per the rules (coverage guard)",
  fn: () => {
    for (const tool of projectedMcpTools(OPEN_COMPOSITION)) {
      // MCP-only verbs set their own (mcp-app-preview_test.ts checks show_app).
      if (MCP_ONLY_TOOLS.has(tool.name)) continue;
      const a = tool.annotations;
      assert(a, `${tool.name} must carry annotations`);
      assert(
        (a.title ?? "").length > 0,
        `${tool.name} needs a non-empty title`,
      );
      // Set.has returns a boolean, so these equalities also pin the field type.
      assertEquals(
        a.readOnlyHint,
        READ_ONLY_TOOLS.has(tool.name),
        `${tool.name} readOnlyHint must equal READ_ONLY_TOOLS membership`,
      );
      assertEquals(
        a.openWorldHint,
        OPEN_WORLD_TOOLS.has(tool.name),
        `${tool.name} openWorldHint must equal OPEN_WORLD_TOOLS membership`,
      );
      if (a.readOnlyHint) {
        // Not meaningful for reads — omitted.
        assertEquals(
          a.destructiveHint,
          undefined,
          `${tool.name} read: no destructiveHint`,
        );
        assertEquals(
          a.idempotentHint,
          undefined,
          `${tool.name} read: no idempotentHint`,
        );
      } else {
        assertEquals(
          typeof a.destructiveHint,
          "boolean",
          `${tool.name} writer needs a destructiveHint`,
        );
        assertEquals(
          typeof a.idempotentHint,
          "boolean",
          `${tool.name} writer needs an idempotentHint`,
        );
        // A verb we claim idempotent is a removal, hence also destructive.
        if (a.idempotentHint) {
          assert(
            a.destructiveHint,
            `${tool.name}: idempotent removal must be destructive`,
          );
        }
      }
    }
  },
});

// Axis 2: the two MCP-face description overrides are applied to the listing, and
// core CUSTOM_TOOLS is left untouched (the integrated agent keeps the original).
Deno.test({
  ...testOpts,
  name:
    "MCP description overrides apply on the projection, not core CUSTOM_TOOLS",
  fn: () => {
    const byName = new Map(
      projectedMcpTools(OPEN_COMPOSITION).map((t) => [t.name, t]),
    );
    const core = new Map(CUSTOM_TOOLS.map((t) => [t.name, t]));

    const createCs = byName.get("create_changeset");
    assert(createCs, "create_changeset should be projected");
    assertStringIncludes(
      createCs.description,
      "auto-approves it to 'in_progress'",
    );
    assert(
      !createCs.description.includes("wait for the user to approve"),
      "MCP create_changeset must not tell a headless agent to wait for approval",
    );
    // Core definition is unchanged — the IDE agent still sees the approval wording.
    assertStringIncludes(
      core.get("create_changeset")?.description ?? "",
      "Wait for the user to approve",
    );

    const exportPrj = byName.get("export_project");
    assert(exportPrj, "export_project should be projected");
    assert(
      !exportPrj.description.includes("download the archive from the UI"),
      "MCP export_project must not reference a UI download",
    );
    assertStringIncludes(
      core.get("export_project")?.description ?? "",
      "download the archive from the UI",
    );
  },
});

// Guard the DESTRUCTIVE direction the way READ_ONLY_TOOLS guards the read
// direction. The read-only risk is OVER-claiming (marking a writer safe); the
// destructive risk is UNDER-claiming — a genuinely destructive verb with no
// removal-family name, silently advertised destructiveHint:false, so a client
// that gates on destructive calls never warns. Force every mutation verb to be
// consciously triaged: either isDestructiveTool catches it (removal-named,
// snapshotted, or a destructive-by-effect extra) or it is listed here as a
// reviewed purely-additive writer. A new mutation verb then FAILS this test until
// someone decides — it cannot slip through as non-destructive by default.
const NON_DESTRUCTIVE_WRITERS: ReadonlySet<string> = new Set([
  "define_handler",
  "define_function",
  "register_route",
  "define_schema",
  "define_template",
  "define_test",
  "upload_asset",
  "upload_text_asset",
  "define_dev_view",
  "define_dev_tool",
  "define_type",
  "install_package",
  "define_secret",
  "set_secret_value",
  "set_config",
  "set_env",
  "define_env_var",
  "set_env_var_value",
  "define_audit",
  // Document authoring is purely additive: create/update write new immutable
  // versions (D2) and archive is a soft flag — no bytes are ever destroyed.
  "document_write",
  // Targeted text editing carries its delegates' classification: it re-enters
  // dispatch as define_template / upload_text_asset (both additive above), and the
  // undoable before/after snapshot is recorded by that delegate, not here.
  "edit_entity_text",
  // Regrouping is metadata: no source, row or table is touched.
  "rename_module",
  "move_to_module",
]);

Deno.test({
  ...testOpts,
  name: "every mutation verb is consciously classified destructive or additive",
  fn: () => {
    for (const name of MODIFICATION_TOOLS) {
      const destructive = isDestructiveTool(name);
      const additive = NON_DESTRUCTIVE_WRITERS.has(name);
      assert(
        destructive !== additive,
        `${name}: classify it as destructive (removal-named / snapshotted / ` +
          `DESTRUCTIVE_EXTRA) OR list it in NON_DESTRUCTIVE_WRITERS — exactly one`,
      );
    }
    // No stale entries: every listed writer is a real mutation verb the
    // classifier agrees is non-destructive.
    for (const name of NON_DESTRUCTIVE_WRITERS) {
      assert(
        MODIFICATION_TOOLS.has(name),
        `${name} in NON_DESTRUCTIVE_WRITERS is not a mutation verb`,
      );
      assert(
        !isDestructiveTool(name),
        `${name} is listed additive but the classifier says destructive`,
      );
    }
  },
});

// --- F4: surface versioning + deprecation policy (OpenTide §10) ---

// The anti-silent-drift guard. The structural fingerprint (tool names + input
// schemas) is PINNED here: any rename / added-or-removed verb / schema change
// flips it, failing this test until someone consciously updates the pin AND bumps
// MCP_SURFACE_VERSION per the documented policy. This is the mechanism that keeps
// the published contract from changing by accident (in the spirit of the F2/F3
// guards). The count is pinned in the same breath — the surface is 102 verbs
// (surface v5.1.0 added the three document-store verbs document_query /
// document_write / document_pin; the v5.0.0 consolidation had brought it to 97).
// v5.2.0 moved the fingerprint without changing the count: a formalSpecs
// property-description clarification (`discriminant?`) on create_changeset /
// update_changeset_plan / amend_changeset_plan — backward-compatible, MINOR.
// v5.3.0 moved it again without changing the count: register_route / define_handler
// gained an optional `productionTest` schema property (route-smoke fixtures,
// Milestone 4 Slice 4.3) — purely additive optional input, backward-compatible,
// MINOR.
// v5.4.0 added preview_project_file and apply_project_file for project-root
// confined safe text-file authoring — additive, backward-compatible, MINOR.
// v5.5.0 moved the fingerprint without changing the count: create_changeset /
// update_changeset_plan gained an optional `change_class` property (proportional
// verification — the light lane), and dropped acceptanceCriteria/verificationPlan
// from the plan's `required` list because the kernel authors them for a light-lane
// changeset. Both are RELAXATIONS of the input contract (a caller that still sends
// them is unaffected), so this is additive and backward-compatible — MINOR.
// v5.6.0 added edit_entity_text (102 → 103): targeted string-replace editing for
// templates and text assets, so a one-declaration change no longer re-emits the whole
// file. Purely additive — the full-content verbs it delegates to are unchanged. MINOR.
// v5.7.0 moved the fingerprint without changing the count: index_codebase gained
// optional classification mode for Tide-shaped imports. Backward-compatible, MINOR.
// v5.8.0 moved the fingerprint without changing the count: list_handlers,
// list_functions and list_types gained an optional `name` and now summarize by
// default instead of returning every entity's source. Input-contract relaxation,
// so MINOR — but note the fingerprint hashes names and inputSchema only, so the
// output-shape half of this change is pinned by nothing.
// v5.9.0 moved the fingerprint without changing the count: remove_entity's `type`
// enum gained "handler" and "function", backed by two new folded delegate verbs
// (remove_handler / remove_function). Until this, NO verb anywhere could delete a
// handler or a function — the registries have had remove() all along, it was never
// wired up — so a retired feature's handlers could only be orphaned, never removed.
// Additive enum values on an existing verb, so MINOR.
// v5.10.0 added flush_project_state (103 → 104): the registries load from the project's
// state directory, but every flush hung off the IDE (control-server REST routes, the
// agent-loop per-step checkpoint), off git (git_status / git_commit / git_push), or off a
// clean unload — so a headless MCP session could mutate the registry all session and lose
// it to an unclean exit. complete_changeset now flushes too, which is a behaviour change
// this fingerprint does not cover (it hashes names and input schemas only). Purely
// additive verb, so MINOR.
// v5.12.0 moved the fingerprint without changing the count: register_route's `schema`
// description was corrected. It claimed only body schemas were validated (params and
// query are too) and that claim was silently false for an EXPORTED app, which validated
// nothing at all until the export gained its own validators. Prose only — no property,
// type, required or enum moved — so MINOR, same call as 5.2.0. This pin moves anyway
// because mcpSurfaceFingerprint hashes the whole inputSchema, prose included.
// v5.13.0 adds project_status (104 -> 105) and gives the changeset/verification
// schemas their enums and item fields, which MCP now enforces before dispatch.
// v6.0.0 pins the OPEN surface — what `opentide mcp` serves now that it boots
// without the closed agent. refute_claims (agent-backed) is no longer on it
// (105 -> 104): a removal, so MAJOR. The Tide assembly still advertises it.
// v6.1.0 moved the fingerprint without changing the count: write_project_file,
// generate_project_docs, rename_module and move_to_module now sit behind the
// changeset gate, so each gained the optional rationale/implementation fields.
// Optional additive properties, so MINOR. Calling them without an in-progress
// changeset now fails with CHANGESET_REQUIRED, which the fingerprint can't see.
// v6.2.0 adds the task-fork verbs start_task, list_tasks, merge_task and
// discard_task (104 -> 108). Additive, so MINOR.
// v6.2.1 shortens descriptions on create_changeset, update_changeset_plan and the
// shared productionTest schema to cut tools/list size. Text only, so PATCH.
// v6.3.0 adds adopt_changeset (108 -> 109). Additive, so MINOR.
// v6.4.0 adds show_app (109 -> 110), MCP-only. Additive, so MINOR.
const PINNED_SURFACE_FINGERPRINT = "d374-7a75615a";
const PINNED_SURFACE_TOOL_COUNT = 110;

Deno.test({
  ...testOpts,
  name:
    "MCP tool-surface fingerprint is pinned (a name/schema change forces a version bump)",
  fn: () => {
    const tools = projectedMcpTools(OPEN_COMPOSITION);
    assertEquals(
      tools.length,
      PINNED_SURFACE_TOOL_COUNT,
      "projected tool count changed — update the pin and bump MCP_SURFACE_VERSION",
    );
    assertEquals(
      mcpSurfaceFingerprint(tools),
      PINNED_SURFACE_FINGERPRINT,
      "tool names/schemas changed — this is a surface-contract change: update the " +
        "pin and bump MCP_SURFACE_VERSION (major if a removal/incompatible schema)",
    );
  },
});

// Stage 7 (docs/lsp-support-plan.md Stage 7): the atomic-rename verb (apply_rename) is a
// dispatch-reachable governed primitive the LSP rename path calls — but DELIBERATELY not
// on the MCP surface: it consumes editor-computed full-entity sources, not agent-authoring
// input (an agent renames via define_*). This pins that choice — it must be absent from
// both the core tool catalog and the projected surface, which is WHY MCP_SURFACE_VERSION
// stays 1.1.0 across Stage 7. (Mirrors "approve_changeset is not exposed to the model".)
Deno.test({
  ...testOpts,
  name: "apply_rename (Stage 7) is not on the MCP surface — no version bump",
  fn: () => {
    assertEquals(
      CUSTOM_TOOLS.some((t) => t.name === LSP_RENAME_TOOL),
      false,
      "apply_rename must not be a projected CustomToolDef",
    );
    assertEquals(
      AGENT_TOOLS.some((t) => t.name === LSP_RENAME_TOOL),
      false,
      "apply_rename must not be in AGENT_TOOLS",
    );
    const projected = projectedMcpTools(OPEN_COMPOSITION);
    assertEquals(
      projected.some((t) => t.name === LSP_RENAME_TOOL),
      false,
      "apply_rename must not be advertised over MCP",
    );
  },
});

// The fingerprint is deterministic and derives from names + input schemas only —
// key-order in a schema must not move it (canonicalization), but a real schema
// change must. Descriptions/annotations are advisory (F3) and deliberately
// excluded, so they must NOT move it.
Deno.test({
  ...testOpts,
  name:
    "mcpSurfaceFingerprint is order-stable, schema-sensitive, metadata-insensitive",
  fn: () => {
    const base: McpToolListing[] = [
      {
        name: "b_verb",
        description: "second",
        inputSchema: { type: "object", properties: { x: { type: "string" } } },
      },
      {
        name: "a_verb",
        description: "first",
        inputSchema: { type: "object", properties: { y: { type: "number" } } },
      },
    ];
    const fp = mcpSurfaceFingerprint(base);
    assertEquals(mcpSurfaceFingerprint(base), fp, "must be deterministic");

    // Reordered tools + reordered schema keys → same fingerprint.
    const reordered: McpToolListing[] = [
      {
        name: "a_verb",
        description: "CHANGED wording",
        annotations: { title: "A", readOnlyHint: true },
        inputSchema: { properties: { y: { type: "number" } }, type: "object" },
      },
      {
        name: "b_verb",
        description: "also changed",
        inputSchema: { properties: { x: { type: "string" } }, type: "object" },
      },
    ];
    assertEquals(
      mcpSurfaceFingerprint(reordered),
      fp,
      "reordering + description/annotation changes must not move the fingerprint",
    );

    // A genuine schema change → different fingerprint.
    const schemaChanged: McpToolListing[] = [
      base[0]!,
      {
        ...base[1]!,
        inputSchema: {
          type: "object",
          properties: { y: { type: "number" } },
          required: ["y"],
        },
      },
    ];
    assert(
      mcpSurfaceFingerprint(schemaChanged) !== fp,
      "a schema change must move the fingerprint",
    );
  },
});

// The surface meta advertised in the tools/list result `_meta`: the human-set
// contract version, the computed fingerprint, and the tool count — all consistent
// with the projection.
Deno.test({
  ...testOpts,
  name: "mcpSurfaceMeta reports the contract version, fingerprint, and count",
  fn: () => {
    const tools = projectedMcpTools(OPEN_COMPOSITION);
    const meta = mcpSurfaceMeta(tools);
    assertEquals(meta.version, MCP_SURFACE_VERSION);
    assertEquals(meta.fingerprint, mcpSurfaceFingerprint(tools));
    assertEquals(meta.toolCount, PINNED_SURFACE_TOOL_COUNT);
  },
});

// The surface meta reaches a REAL client over the wire, in the tools/list result
// `_meta` under the namespaced key — the introspection channel a client uses to
// detect that the surface it pinned has changed.
Deno.test({
  ...testOpts,
  name:
    "createMcpServer: tools/list result carries opentide/surface _meta on the wire",
  fn: async () => {
    await withKernel(async (kernel) => {
      const { client, dispose } = await connectMcpClient({
        kernel,
        rebuild: noop,
      });
      try {
        const result = await client.listTools();
        const meta = (result._meta ?? {}) as Record<string, unknown>;
        const surface = meta[MCP_SURFACE_META_KEY] as
          | { version?: string; fingerprint?: string; toolCount?: number }
          | undefined;
        assert(surface, `tools/list _meta must carry ${MCP_SURFACE_META_KEY}`);
        assertEquals(surface.version, MCP_SURFACE_VERSION);
        assertEquals(surface.fingerprint, PINNED_SURFACE_FINGERPRINT);
        assertEquals(surface.toolCount, result.tools.length);
      } finally {
        await dispose();
      }
    });
  },
});

// Nothing is deprecated today: F4 ships the mechanism + policy, not a
// deprecation. This guards that state explicitly — no projected verb carries a
// deprecation marker, and the registry is empty. When a verb IS eventually
// deprecated this test is a conscious edit, not a silent change.
Deno.test({
  ...testOpts,
  name:
    "no verb is deprecated today (F4 ships the mechanism, not a deprecation)",
  fn: () => {
    assertEquals(
      Object.keys(MCP_DEPRECATIONS).length,
      0,
      "MCP_DEPRECATIONS should be empty until a verb is genuinely deprecated",
    );
    for (const tool of projectedMcpTools(OPEN_COMPOSITION)) {
      assertEquals(
        tool._meta?.[MCP_DEPRECATED_META_KEY],
        undefined,
        `${tool.name} unexpectedly carries a deprecation marker`,
      );
      assert(
        !tool.description.startsWith("DEPRECATED"),
        `${tool.name} unexpectedly has a deprecation banner`,
      );
    }
  },
});

// Registry integrity: every deprecation key must name a REAL projected verb, so a
// typo can't silently deprecate nothing. Vacuous today (empty registry) but
// load-bearing the moment an entry is added.
Deno.test({
  ...testOpts,
  name: "every MCP_DEPRECATIONS key is a real projected verb",
  fn: () => {
    const projected = new Set(
      projectedMcpTools(OPEN_COMPOSITION).map((t) => t.name),
    );
    for (const name of Object.keys(MCP_DEPRECATIONS)) {
      assert(
        projected.has(name),
        `MCP_DEPRECATIONS names "${name}", which is not a projected verb`,
      );
    }
  },
});

// The deprecation mechanism itself, exercised with a synthetic entry (the real
// registry is empty). Both wire signals must be produced: the human banner
// prepended to the description, and the structured _meta record — and the
// original listing content is preserved.
Deno.test({
  ...testOpts,
  name:
    "applyDeprecation produces the banner + structured _meta, preserving the listing",
  fn: () => {
    const base: McpToolListing = {
      name: "old_verb",
      description: "Does the old thing.",
      inputSchema: { type: "object", properties: {} },
      annotations: { title: "Old Verb", readOnlyHint: true },
    };
    const entry: McpDeprecation = {
      since: "1.1.0",
      removeAfter: "2.0.0",
      supersededBy: "new_verb",
      note: "Migrate to new_verb.",
    };
    const out = applyDeprecation(base, entry);

    // Human banner leads the description; the original text is kept below it.
    assert(out.description.startsWith("DEPRECATED (since v1.1.0"));
    assertStringIncludes(out.description, `use "new_verb" instead`);
    assertStringIncludes(out.description, "may be removed after v2.0.0");
    assertStringIncludes(out.description, "Migrate to new_verb.");
    assertStringIncludes(out.description, "Does the old thing.");

    // Structured machine form under the namespaced key, with no undefined leaks.
    const marker = out._meta?.[MCP_DEPRECATED_META_KEY] as Record<
      string,
      unknown
    >;
    assert(marker, "deprecated verb must carry the structured _meta record");
    assertEquals(marker, {
      since: "1.1.0",
      removeAfter: "2.0.0",
      supersededBy: "new_verb",
      note: "Migrate to new_verb.",
    });

    // Untouched fields survive the overlay.
    assertEquals(out.name, "old_verb");
    assertEquals(out.inputSchema, base.inputSchema);
    assertEquals(out.annotations, base.annotations);

    // A minimal entry omits absent optionals (clean wire payload).
    const minimal = applyDeprecation(base, { since: "1.1.0" });
    assertEquals(minimal._meta?.[MCP_DEPRECATED_META_KEY], { since: "1.1.0" });
  },
});

Deno.test({
  ...testOpts,
  name:
    "show_app: listed with its UI resource, which the server serves, and returns the live app's URL",
  fn: async () => {
    await withServedKernel(async (kernel, rebuild, baseUrl) => {
      // project-loader keeps this in step with the app server; this harness
      // doesn't.
      kernel.appPort = Number(new URL(baseUrl).port);
      const { client, dispose } = await connectMcpClient({ kernel, rebuild });
      try {
        const listed = (await client.listTools()).tools.find((
          t: { name: string },
        ) => t.name === "show_app");
        const uri = (listed?._meta as { ui?: { resourceUri?: string } })?.ui
          ?.resourceUri;
        assert(uri, "show_app carries _meta.ui.resourceUri");

        const { resources } = await client.listResources();
        assertEquals(resources.map((r: { uri: string }) => r.uri), [uri]);
        const read = await client.readResource({ uri });
        const page = read.contents[0] as { mimeType?: string; text?: string };
        assertEquals(page.mimeType, "text/html;profile=mcp-app");
        assert(page.text?.includes("ui/initialize"));

        const shown = await client.callTool({
          name: "show_app",
          arguments: { path: "/notes" },
        });
        assertEquals(shown.isError, undefined);
        assertEquals(
          (shown.structuredContent as { url: string }).url,
          `${baseUrl}/notes`,
        );
      } finally {
        await dispose();
      }
    });
  },
});
