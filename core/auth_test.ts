import { assertEquals } from "@std/assert";
import { canReadUserSession, localUser } from "./auth.ts";

Deno.test("session privacy accepts legacy account-prefixed owner ids", () => {
  const user = {
    id: "acct_1",
    accountId: "acct_1",
    displayName: "Ada Lovelace",
    email: "ada@example.com",
    avatarUrl: null,
  };

  assertEquals(
    canReadUserSession(user, {
      ownerUserId: "account_acct_1",
      visibility: "private",
    }),
    true,
  );
});

Deno.test("session privacy does not expose legacy local private sessions", () => {
  const user = {
    id: "acct_1",
    accountId: "acct_1",
    displayName: "Ada Lovelace",
    email: "ada@example.com",
    avatarUrl: null,
  };

  assertEquals(
    canReadUserSession(user, {
      ownerUserId: "local_legacy",
      visibility: "private",
    }),
    false,
  );
  assertEquals(
    canReadUserSession(user, {
      ownerUserId: "local_install_1",
      visibility: "private",
    }),
    false,
  );
});

Deno.test("session privacy: the local user owns the legacy-local namespace", () => {
  // Open-mode reconciliation: the canonical local user reads pre-existing rows
  // owned by the "local_legacy" schema default or an older per-install id, so a
  // bare OpenTide sees its own history. (A cloud account user does not — asserted
  // above.)
  assertEquals(
    canReadUserSession(localUser(), {
      ownerUserId: "local_legacy",
      visibility: "private",
    }),
    true,
  );
  assertEquals(
    canReadUserSession(localUser(), {
      ownerUserId: "local_install_1",
      visibility: "private",
    }),
    true,
  );
});
