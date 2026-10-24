// @layer core — the identity seam. Core resolves the current user for every
// request through an AuthProvider (OpenTide §3.3 composition seam, mirroring the
// audit-provider). It defaults to the open LocalAuthProvider — no auth, like a
// dev server — so `opentide serve` / `deno task kernel` run without login. The
// Tide product injects a CloudAuthProvider (tide/ layer) that enforces sign-in.
//
// The provider's one job is to answer "who is this request?" The core authz that
// operates on the resolved CurrentUser (canReadUserSession, redaction, session
// ownership/visibility) stays in core and is provider-agnostic.
import { type CurrentUser, localUser } from "./auth.ts";

export interface AuthProvider {
  readonly accountEntitlementsSupported?: boolean;
  // Resolve the user for a request, or null when the request is unauthenticated.
  // A provider that never returns null (LocalAuthProvider) yields open mode: no
  // 401, no login. One that can return null (CloudAuthProvider) enforces auth.
  resolveUser(request: Request): Promise<CurrentUser | null>;
}

// Open mode: every request resolves to the single local user, never null. This
// is the absent-safe default — a bare `new Kernel(db)` / `opentide serve` gets it
// and just works with no auth service configured.
export class LocalAuthProvider implements AuthProvider {
  readonly accountEntitlementsSupported = false;

  resolveUser(_request: Request): Promise<CurrentUser | null> {
    return Promise.resolve(localUser());
  }
}
