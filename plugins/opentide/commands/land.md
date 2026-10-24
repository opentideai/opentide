---
description: "Verify and complete a changeset: tests, verification run, readiness, complete, flush."
argument-hint: "[changeset_id]"
disable-model-invocation: true
---

Finish the active changeset (project_status names it).

1. Every step done or skipped (update_changeset_step).
2. run_tests. Fix failures; do not record a failing run as passed.
3. record_verification_run({changeset_id, status, summary, evidence, claimResults,
   residualRisks}). evidence items need summary and status; claimResults items use
   the criterion's own id as claimId. Statuses are passed, failed, partial or manual.
4. check_changeset_readiness. Fix every error it lists.
5. complete_changeset. If stateFlushed is false, say so first and loudly: the work
   exists only in memory until it is flushed.

changeset_id, if given: $ARGUMENTS
