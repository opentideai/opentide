---
description: "Make a change through a changeset, with the exact plan shape create_changeset expects."
argument-hint: "<goal>"
disable-model-invocation: true
---

Make this change to the app: $ARGUMENTS

Before the first edit, say in a few lines what you will change and how.

Then work through the changeset loop:

1. create_changeset({title, plan: {summary, steps, acceptanceCriteria, verificationPlan}}). Here it is approved and started automatically. If a call is later refused as outside the plan, amend_changeset_plan, then retry.
2. Make the change, marking each step with update_changeset_step status "done".
3. run_tests, then record_verification_run with evidence and claimResults keyed by your own criterion ids.
4. check_changeset_readiness, then complete_changeset. If it returns stateFlushed: false, tell the user: the work exists only in memory. Work done outside a changeset ends with flush_project_state.
- Reserved names, refused by the define tools: db, functions, config, packages, env, templates, log, assertNever, HandlerContext, Context. Tests have more; project_status lists them in reservedNames.

The plan shape create_changeset expects, exactly:
{
  "title": "...",
  "change_class": "standard",
  "plan": {
    "summary": "...",
    "steps": ["one string per step"],
    "acceptanceCriteria": [
      {"id": "claim_x", "text": "observable behavior", "priority": "should"}
    ],
    "verificationPlan": [
      {"id": "check_x", "claimIds": ["claim_x"], "kind": "e2e", "description": "how it is checked"}
    ]
  }
}
Use change_class "light" only for a copy or style tweak: it refuses routes,
schemas, SQL, secrets, env vars, packages and snapshots.
