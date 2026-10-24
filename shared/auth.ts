// @layer shared — L0, the OpenTide *open* wire contract. Type-only; imports
// NOTHING (nothing sits below L0). Consumed by both the Deno backend (relative
// `.ts` import, re-exported from core/auth.ts for continuity) and the SvelteKit
// IDE (`$shared` alias), so the REST/WS boundary is a real shared type, not a
// hand-duplicated one on each side. See docs/opentide-separation-plan.md §5/§6
// and docs/open-core-strategy.md (shared/ is OPEN).

// The serialized user identity. This is the on-the-wire shape `/api/auth/me`
// serves ({ user: CurrentUser }) in open OpenTide mode — a plain data record
// whose fields are all JSON primitives, so the wire shape and the core identity
// seam's runtime type coincide. CurrentUser IS open (served in open mode);
// account entitlements are a Tide-product-only wire type and deliberately stay
// closed (the IDE keeps its own decl), per the D9 open/closed boundary.
export interface CurrentUser {
  id: string;
  accountId: string;
  displayName: string;
  email: string | null;
  avatarUrl: string | null;
}

export interface AuthMeResponse {
  user: CurrentUser;
  accountEntitlementsSupported?: boolean;
}
