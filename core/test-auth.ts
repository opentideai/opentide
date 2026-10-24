// @layer core — test-support: an enforcing AuthProvider for control-server tests.
// The open control server must be exercised under a provider that can return null
// (401 for an anonymous request, per-account ownership checks), but the real one
// (CloudAuthProvider) is closed Tide code in tide/. This stub keeps an in-memory
// token → user map and accepts a token wherever the IDE carries one: the session
// cookie, a bearer header, or the WebSocket subprotocol.
import type { AuthProvider } from "./auth-provider.ts";
import type { CurrentUser } from "./auth.ts";

const TEST_SESSION_COOKIE = "genie_session";

export interface TestAccountProfile {
  accountId: string;
  displayName: string;
  email: string | null;
  avatarUrl: string | null;
}

export class TestAuthProvider implements AuthProvider {
  readonly accountEntitlementsSupported = true;
  private readonly sessions = new Map<string, CurrentUser>();

  // Sign `profile` in; the returned token authenticates it on later requests.
  createAccountSession(input: { profile: TestAccountProfile }): string {
    const token = crypto.randomUUID().replaceAll("-", "");
    const { accountId, displayName, email, avatarUrl } = input.profile;
    this.sessions.set(token, {
      id: accountId,
      accountId,
      displayName,
      email,
      avatarUrl,
    });
    return token;
  }

  sessionCookie(token: string): string {
    return `${TEST_SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax`;
  }

  // Tokens are random and unique, so finding one anywhere in the headers that
  // carry credentials identifies the session without re-parsing each format.
  resolveUser(request: Request): Promise<CurrentUser | null> {
    const carried = ["cookie", "authorization", "sec-websocket-protocol"]
      .map((name) => request.headers.get(name) ?? "")
      .join(" ");
    for (const [token, user] of this.sessions) {
      if (carried.includes(token)) return Promise.resolve(user);
    }
    return Promise.resolve(null);
  }
}
