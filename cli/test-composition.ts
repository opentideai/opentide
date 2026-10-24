// @layer composition — the open test composition. Tool-touching tests build
// their Kernel with `new Kernel(db, { composition: testComposition() })` to get
// working stores plus the verification tool handlers. This is the test analog of
// verificationOnlyComposition() (assembly.ts): no agent seams, so agent verbs
// (refute/criteria) are absent exactly as in an OpenTide boot. Tests of those
// verbs use tide/test-composition.ts.
import type { CompositionContext } from "../core/composition.ts";
import { testStoreComposition } from "../verification/test-stores.ts";
import { defaultVerificationToolHandlers } from "../verification/verification-tool-handlers.ts";

export function testComposition(): CompositionContext {
  return {
    ...testStoreComposition(),
    verificationTools: defaultVerificationToolHandlers,
  };
}
