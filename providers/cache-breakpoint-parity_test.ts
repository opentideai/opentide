// Pins core/cache-composition.ts's cacheBreakpointPlan against what the real AI-SDK
// mappers actually mark. core (L1) cannot import providers/ (L2), so the plan
// MIRRORS the placement rule in ai-sdk-shared.ts rather than reading it. This test
// lives in providers/ — the only layer that can see both — so the mirror cannot
// drift silently: move a breakpoint in toSdkTools/toModelMessages and this fails.
//
// §8 depends on it: a cache-write number only means something against the
// positions the breakpoints actually landed at.

import { assertEquals } from "@std/assert";
import {
  CACHE_STABLE_PREFIX_MESSAGES,
  cacheBreakpointPlan,
} from "../core/cache-composition.ts";
import { toModelMessages, toSdkTools } from "./ai-sdk-shared.ts";
import type {
  NeutralMessage,
  NeutralTool,
  TurnRequest,
} from "../core/model-provider.ts";

const TOOLS: NeutralTool[] = [
  {
    name: "list_handlers",
    description: "list",
    inputSchema: { type: "object" },
  },
  {
    name: "write_handler",
    description: "write",
    inputSchema: { type: "object" },
  },
];

function hasBreakpoint(value: unknown): boolean {
  const options = (value as { providerOptions?: { anthropic?: unknown } })
    ?.providerOptions;
  return Boolean(options?.anthropic);
}

// The breakpoints the real mappers emit, as (kind, index) pairs in render order:
// tools first (Anthropic renders tools → system → messages), then messages.
function actualBreakpoints(
  request: Pick<TurnRequest, "system" | "messages" | "tools">,
  supportsCaching: boolean,
): Array<{ kind: string; index: number }> {
  const out: Array<{ kind: string; index: number }> = [];
  const tools = toSdkTools(request.tools, supportsCaching);
  Object.values(tools).forEach((tool, index) => {
    if (hasBreakpoint(tool)) out.push({ kind: "tools", index });
  });
  const messages = toModelMessages(
    request.messages,
    "anthropic",
    supportsCaching,
  );
  messages.forEach((message, index) => {
    const content = message.content;
    if (typeof content === "string" || content.length === 0) return;
    if (hasBreakpoint(content[content.length - 1])) {
      out.push({
        kind: index === 0 ? "first_message" : "last_message",
        index,
      });
    }
  });
  return out;
}

function request(messages: NeutralMessage[]): TurnRequest {
  return { model: "claude-opus-5", system: "system", messages, tools: TOOLS };
}

const CASES: Array<{ name: string; messages: NeutralMessage[] }> = [
  {
    name: "single message (first and last are the same message)",
    messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
  },
  {
    name: "a tool round-trip",
    messages: [
      { role: "user", content: [{ type: "text", text: "go" }] },
      {
        role: "assistant",
        content: [
          { type: "reasoning", provider: "anthropic", data: [] },
          { type: "tool_use", id: "c1", name: "list_handlers", input: {} },
        ],
      },
      {
        role: "tool",
        content: [{
          type: "tool_result",
          toolCallId: "c1",
          output: { ok: true },
        }],
      },
    ],
  },
  {
    name: "many turns",
    messages: Array.from({ length: 9 }, (_, i) => ({
      role: (i % 2 === 0 ? "user" : "assistant") as NeutralMessage["role"],
      content: [{ type: "text" as const, text: `m${i}` }],
    })),
  },
];

for (const testCase of CASES) {
  Deno.test(`breakpoint plan matches the mappers — ${testCase.name}`, () => {
    const req = request(testCase.messages);
    assertEquals(
      cacheBreakpointPlan(req, true).map((p) => ({
        kind: p.kind,
        index: p.index,
      })),
      actualBreakpoints(req, true),
    );
  });
}

Deno.test("breakpoint plan matches the mappers — caching off", () => {
  const req = request(CASES[1]!.messages);
  assertEquals(cacheBreakpointPlan(req, false), []);
  assertEquals(actualBreakpoints(req, false), []);
});

Deno.test("the caching request carries exactly three breakpoints, not two", () => {
  // §5.1 and the §8 brief disagreed about how many of Anthropic's four slots are
  // in use. The mappers are the authority: last tool + first message + last message.
  assertEquals(actualBreakpoints(request(CASES[1]!.messages), true).length, 3);
});

// The trim gate (§4.7/§4.8, agent-loop/chat.ts prefixRewriteTokens) prices a prefix
// mutation as "everything from CACHE_STABLE_PREFIX_MESSAGES to the end is rewritten".
// That is only true while there is NO breakpoint between message 0 and the last
// message — add a mid-conversation watermark (§5.1) and the gate is over-charging
// every trim by the size of the surviving segment. This is where that assumption is
// pinned, against the real mappers.
Deno.test("no breakpoint sits between the head of the array and the last message", () => {
  const messages = Array.from({ length: 12 }, (_, i) => ({
    role: (i % 2 === 0 ? "user" : "assistant") as NeutralMessage["role"],
    content: [{ type: "text" as const, text: `m${i}` }],
  }));
  const marked = actualBreakpoints(request(messages), true)
    .filter((p) => p.kind !== "tools")
    .map((p) => p.index);

  assertEquals(marked, [0, messages.length - 1]);
  assertEquals(
    marked.filter((index) =>
      index >= CACHE_STABLE_PREFIX_MESSAGES && index < messages.length - 1
    ),
    [],
    "a mutation anywhere in this range invalidates the same extent",
  );
  assertEquals(
    CACHE_STABLE_PREFIX_MESSAGES,
    1,
    "message 0 is the only message inside the surviving entry",
  );
});
