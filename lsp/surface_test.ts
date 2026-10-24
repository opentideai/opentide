import { assert, assertEquals } from "@std/assert";
import {
  LSP_CREATE_ENTITY_COMMAND,
  LSP_SURFACE_VERSION,
} from "../core/config.ts";
import { TextDocumentSyncKind } from "./protocol.ts";
import { buildServerCapabilities, lspSurfaceFingerprint } from "./surface.ts";

const testOpts = { sanitizeResources: false, sanitizeOps: false };

// The full write-enabled surface — the default deployment (LSP_WRITE_FEATURES_ENABLED)
// and what a client actually talks to. Built once with fixed inputs so the pins below
// are deterministic.
const FULL = buildServerCapabilities({
  languageIntelligence: true,
  writeFeaturesEnabled: true,
  readinessEnforcement: "advisory",
});

// The anti-silent-drift pin (mirrors mcp-projection_test.ts's fingerprint pin): the
// exact advertised capability keys AND the structural fingerprint are frozen here. A
// provider/command/notification added, removed, or renamed flips one of these, failing
// this test until someone consciously updates the pin AND bumps LSP_SURFACE_VERSION per
// the documented policy (docs/lsp-connect.md).
const PINNED_CAPABILITY_KEYS = [
  "completionProvider",
  "definitionProvider",
  "documentHighlightProvider",
  "executeCommandProvider",
  "hoverProvider",
  "opentideReadinessEnforcement",
  "opentideSurface",
  "referencesProvider",
  "renameProvider",
  "textDocumentSync",
  "workspace",
];
const PINNED_SURFACE_FINGERPRINT = "208-805b3b7e";

Deno.test({
  ...testOpts,
  name:
    "buildServerCapabilities advertises the full write surface + opentideSurface",
  fn: () => {
    // Read providers (Stage 1).
    assertEquals(FULL.completionProvider, { resolveProvider: false });
    assertEquals(FULL.hoverProvider, true);
    assertEquals(FULL.definitionProvider, true);
    assertEquals(FULL.referencesProvider, true);
    assertEquals(FULL.documentHighlightProvider, true);
    // Write providers (Stages 3–7) — behind the write flag, present here.
    assertEquals(FULL.textDocumentSync, {
      openClose: true,
      change: TextDocumentSyncKind.Full,
      save: { includeText: true },
    });
    assertEquals(FULL.executeCommandProvider, {
      commands: [LSP_CREATE_ENTITY_COMMAND],
    });
    assertEquals(FULL.renameProvider, true);
    assert(FULL.workspace?.fileOperations?.didCreate, "didCreate advertised");
    // Stage 4 policy value echoed.
    assertEquals(FULL.opentideReadinessEnforcement, "advisory");
    // Stage 8 surface contract.
    assertEquals(FULL.opentideSurface?.version, LSP_SURFACE_VERSION);
    assertEquals(FULL.opentideSurface?.fingerprint, PINNED_SURFACE_FINGERPRINT);
  },
});

Deno.test({
  ...testOpts,
  name:
    "LSP surface is pinned (a capability/method change forces a version bump)",
  fn: () => {
    assertEquals(
      Object.keys(FULL).sort(),
      PINNED_CAPABILITY_KEYS,
      "advertised capability keys changed — update the pin and bump LSP_SURFACE_VERSION",
    );
    // The fingerprint recomputed over the pre-opentideSurface structure must equal the
    // value opentideSurface carries (self-consistency) and the frozen pin.
    assertEquals(
      lspSurfaceFingerprint(FULL),
      PINNED_SURFACE_FINGERPRINT,
      "capability/notification surface changed — this is a contract change: update " +
        "the pin and bump LSP_SURFACE_VERSION (major if a removal/rename)",
    );
    assertEquals(FULL.opentideSurface?.fingerprint, lspSurfaceFingerprint(FULL));
  },
});

Deno.test({
  ...testOpts,
  name:
    "read-only surface omits write providers and has a distinct fingerprint",
  fn: () => {
    const ro = buildServerCapabilities({
      languageIntelligence: true,
      writeFeaturesEnabled: false,
      readinessEnforcement: "advisory",
    });
    // Bare Full number, no save advertised; no write providers.
    assertEquals(ro.textDocumentSync, TextDocumentSyncKind.Full);
    assertEquals(ro.executeCommandProvider, undefined);
    assertEquals(ro.renameProvider, undefined);
    assertEquals(ro.workspace, undefined);
    // The read providers remain.
    assertEquals(ro.hoverProvider, true);
    // A strictly smaller surface ⇒ a different fingerprint (the write surface can't
    // masquerade as the read-only one).
    assert(
      ro.opentideSurface?.fingerprint !== FULL.opentideSurface?.fingerprint,
      "read-only and write surfaces must fingerprint differently",
    );
  },
});

Deno.test({
  ...testOpts,
  name: "the readiness policy value does not move the fingerprint (advisory)",
  fn: () => {
    // opentideReadinessEnforcement is a runtime POLICY value, not structural contract:
    // changing it must echo through the capability but NOT move the surface hash —
    // mirrors MCP excluding descriptions/annotations from its fingerprint.
    const strict = buildServerCapabilities({
      languageIntelligence: true,
      writeFeaturesEnabled: true,
      readinessEnforcement: "strict",
    });
    assertEquals(strict.opentideReadinessEnforcement, "strict");
    assertEquals(
      strict.opentideSurface?.fingerprint,
      FULL.opentideSurface?.fingerprint,
      "a policy-value change must not move the surface fingerprint",
    );
  },
});

Deno.test({
  ...testOpts,
  name: "no language intelligence advertises the empty surface",
  fn: () => {
    const none = buildServerCapabilities({
      languageIntelligence: false,
      writeFeaturesEnabled: true,
      readinessEnforcement: "advisory",
    });
    assertEquals(none, {});
  },
});
