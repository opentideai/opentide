// @layer core — the identity seam: who a request's user IS, and the authz that
// operates on that CurrentUser (session read visibility). This is NOT auth
// enforcement — OpenTide core has no login. The AuthProvider seam (auth-provider.ts)
// resolves the user (open LocalAuthProvider by default); the Tide product injects
// a CloudAuthProvider (tide/auth.ts) that enforces sign-in. Core stays auth-free
// and provider-agnostic: it operates on whatever CurrentUser the provider returns.

// CurrentUser is the open wire contract served by /api/auth/me: its canonical
// home is the L0 shared/ package (shared across the REST/WS boundary to the IDE).
// Re-exported here so existing core callers keep importing it from ./auth.ts
// unchanged (the Phase-2 relocate-and-re-export pattern).
export type { CurrentUser } from "../shared/auth.ts";
import type { CurrentUser } from "../shared/auth.ts";

// The canonical local user. In open mode (LocalAuthProvider) every request
// resolves to this single user, so a bare OpenTide reads and writes everything
// with no login. The cloud dev-auth escape hatch (OPENTIDE_DEV_ACCOUNT_AUTH=1)
// resolves to the same identity.
export const LOCAL_USER_ID = "acct_test_owner";

export function localUser(
  accountId = LOCAL_USER_ID,
): CurrentUser {
  return {
    id: accountId,
    accountId,
    displayName: "Test Owner",
    email: "owner@example.test",
    avatarUrl: null,
  };
}

// Legacy pre-multi-user session owner ids: the "local_legacy" schema default
// (db/schema/sessions.ts) and older per-install "local_<installId>" ids, all
// under the "local_" namespace. In open mode the single canonical local user
// owns this namespace so a bare OpenTide reads its own pre-existing sessions.
function isLegacyLocalOwner(ownerUserId?: string): boolean {
  return ownerUserId?.startsWith("local_") ?? false;
}

export function canReadUserSession(
  user: CurrentUser,
  session: { ownerUserId?: string; visibility?: "private" | "project" },
): boolean {
  if (session.visibility === "project") return true;
  if (session.ownerUserId === user.id) return true;
  if (session.ownerUserId === `account_${user.accountId}`) return true;
  // Reconcile the DB default vs the code fallback: the canonical local user
  // reads the legacy-local namespace so open-mode rows created before the
  // owner id was aligned still read as owned. Scoped strictly to the local
  // user's id — cloud account users never gain access to legacy-local rows.
  if (user.id === LOCAL_USER_ID && isLegacyLocalOwner(session.ownerUserId)) {
    return true;
  }
  return false;
}
