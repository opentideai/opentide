// @layer verification — test-support: a composition carrying the real
// verification store factories, for tests that exercise kernel.changesets /
// kernel.audits. Replaces the former global side-effect registration — stores
// now travel on the Kernel's composition (Slice 3), so a test builds its Kernel
// with `new Kernel(db, { composition: testStoreComposition() })` (or threads it
// through loadProject).
import {
  type CompositionContext,
  coreOnlyComposition,
} from "../core/composition.ts";
import {
  defaultAuditStoreFactory,
  defaultChangesetStoreFactory,
  defaultMcpAuditStoreFactory,
} from "./store-registration.ts";

export function testStoreComposition(): CompositionContext {
  return {
    ...coreOnlyComposition(),
    changesetStoreFactory: defaultChangesetStoreFactory,
    auditStoreFactory: defaultAuditStoreFactory,
    mcpAuditStoreFactory: defaultMcpAuditStoreFactory,
  };
}
