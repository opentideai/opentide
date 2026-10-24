import { assert, assertEquals, assertFalse } from "@std/assert";
import { MCP_SESSION_IDLE_MS } from "./config.ts";
import {
  isMcpSession,
  LiveSessions,
  mcpSessionMetadata,
} from "./session-liveness.ts";
import type { Session } from "./types.ts";

function session(metadata: unknown): Session {
  return {
    id: "s1",
    name: "x",
    startedAt: "2026-10-24T00:00:00.000Z",
    endedAt: null,
    summary: null,
    focus: null,
    metadata: metadata as string | null,
    archived: false,
  };
}

Deno.test("isMcpSession reads the origin tag, as a string or parsed jsonb", () => {
  assert(isMcpSession(session(mcpSessionMetadata())));
  assert(isMcpSession(session({ origin: "mcp" })));
  assertFalse(isMcpSession(session(null)));
  assertFalse(isMcpSession(session('{"retry":1}')));
  assertFalse(isMcpSession(session("not json")));
});

Deno.test("LiveSessions: live until closed or idle past the limit", () => {
  const live = new LiveSessions();
  assertFalse(live.isLive("a", 0));
  live.touch("a", 1_000);
  assert(live.isLive("a", 1_000 + MCP_SESSION_IDLE_MS - 1));
  assertFalse(live.isLive("a", 1_000 + MCP_SESSION_IDLE_MS));
  live.touch("a", 5_000);
  live.close("a");
  assertEquals(live.isLive("a", 5_000), false);
});
