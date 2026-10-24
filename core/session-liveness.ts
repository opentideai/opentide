// @layer core — which MCP clients are still connected, and so which changesets
// have lost their writer.
//
// A changeset belongs to the session that created it, and one writer holds the
// project at a time. An MCP client that disconnects mid-changeset (Claude Code
// after /clear, a restart, a crash) leaves its changeset in progress with nobody
// able to drive it. Matching the next client by name can't tell a reconnect
// from a second live client (Claude Code always sends `claude-code`), so the
// test is whether the owning session still has a connection, which only this
// process knows.
import { MCP_SESSION_IDLE_MS } from "./config.ts";
import type { SessionManager } from "./sessions.ts";
import type { Changeset, Session } from "./types.ts";

// Written into an MCP session's metadata when it is created, so a changeset's
// owner can be recognised as an MCP client after a restart. IDE chat sessions
// never carry it, and their changesets are never adoptable.
export const MCP_SESSION_ORIGIN = "mcp";

export function mcpSessionMetadata(): string {
  return JSON.stringify({ origin: MCP_SESSION_ORIGIN });
}

export function isMcpSession(session: Session): boolean {
  // Typed as a string, but a jsonb column hands it back parsed.
  const raw: unknown = session.metadata;
  if (raw && typeof raw === "object") {
    return (raw as { origin?: unknown }).origin === MCP_SESSION_ORIGIN;
  }
  if (typeof raw !== "string") return false;
  try {
    return (JSON.parse(raw) as { origin?: unknown }).origin ===
      MCP_SESSION_ORIGIN;
  } catch {
    return false;
  }
}

// MCP sessions with a connected client in this process, and when each last
// made a call. In memory on purpose: after a restart nothing is connected.
export class LiveSessions {
  private readonly lastSeen = new Map<string, number>();

  touch(sessionId: string, now: number = Date.now()): void {
    this.lastSeen.set(sessionId, now);
  }

  close(sessionId: string): void {
    this.lastSeen.delete(sessionId);
  }

  // Connected, and called within MCP_SESSION_IDLE_MS. The idle limit covers a
  // client killed without closing its connection, which never reports closed.
  isLive(sessionId: string, now: number = Date.now()): boolean {
    const seen = this.lastSeen.get(sessionId);
    return seen !== undefined && now - seen < MCP_SESSION_IDLE_MS;
  }
}

export type OrphanReason =
  | "session_missing"
  | "client_disconnected"
  | "client_not_connected";

// Why a changeset has no writer any more, or null while its owner can still
// drive it. Only MCP-owned changesets are ever orphaned.
export async function changesetOrphanReason(
  changeset: Changeset,
  sessions: SessionManager,
  live: LiveSessions,
  now: number = Date.now(),
): Promise<OrphanReason | null> {
  if (!changeset.sessionId) return null;
  const session = await sessions.getSession(changeset.sessionId)
    .catch(() => null);
  if (!session) return "session_missing";
  if (!isMcpSession(session)) return null;
  if (session.endedAt) return "client_disconnected";
  return live.isLive(session.id, now) ? null : "client_not_connected";
}

export function describeOrphan(reason: OrphanReason): string {
  switch (reason) {
    case "session_missing":
      return "its session no longer exists";
    case "client_disconnected":
      return "its client disconnected";
    case "client_not_connected":
      return "its client is not connected to this server (it exited, the " +
        "server restarted, or it has been idle too long)";
  }
}
