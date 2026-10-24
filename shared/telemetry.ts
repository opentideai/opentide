// @layer shared — L0, the OpenTide *open* wire contract. TYPE-ONLY (no runtime
// code) and import-free; imports NOTHING (nothing sits below L0). Consumed by the
// Deno backend (core/config.ts, core/telemetry.ts) and the IDE (`$shared` alias).
//
// Stream A / A5 (privacy gate): the per-category egress opt-in a user grants at
// consent time. Passive telemetry events additionally require the `enabled` master
// switch; feedback (user-initiated) requires only its own flag. Both require
// consent at the current CONSENT_VERSION — see egressAllowed() in core/telemetry.ts.
// The CONSENT_VERSION constant itself is a runtime value and so lives in
// core/config.ts (type-only shared/ cannot hold it); the IDE learns the current
// version from the /api/config/telemetry response instead of importing it.
export interface TelemetryConsent {
  telemetry: boolean;
  feedback: boolean;
}
