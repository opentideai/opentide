// @layer lsp — the ADVERTISED capability surface: one pure builder for the
// `initialize` result's capabilities, plus the version/fingerprint contract a
// client pins against (Stage 8, docs/lsp-connect.md). The LSP analog of
// mcp-projection.ts's surface machinery: mcp fingerprints the tool names + input
// schemas; here we fingerprint the declared capabilities + the opentide/* custom
// notifications — the structural surface an editor or agent keys on.
//
// buildServerCapabilities is PURE (no kernel, no I/O) so a pinned test
// (surface_test.ts) can freeze the fingerprint for a fixed set of inputs — a
// capability added/removed/renamed then fails that test until LSP_SURFACE_VERSION
// is consciously bumped, the same anti-silent-drift discipline the MCP surface has.
import type { ReadinessEnforcement } from "../core/types.ts";
import { canonicalizeJson, hashParts } from "../core/fingerprint.ts";
import {
  LSP_CREATE_ENTITY_COMMAND,
  LSP_SURFACE_VERSION,
} from "../core/config.ts";
import {
  type GenieSurfaceMeta,
  LspMethods,
  type ServerCapabilities,
  TextDocumentSyncKind,
} from "./protocol.ts";
import { OPENTIDE_URI_SCHEME } from "./uri.ts";

// The inputs that fully determine the advertised surface — everything
// LspServer.capabilities() reads from the kernel/config, passed explicitly so the
// builder stays pure and testable. `languageIntelligence` gates the WHOLE server
// (a runtime that can't offer intelligence advertises nothing); `writeFeaturesEnabled`
// gates the write providers (save/executeCommand/didCreate/rename); `readinessEnforcement`
// is the advisory policy datum echoed for clients (excluded from the fingerprint).
export interface ServerCapabilityInputs {
  languageIntelligence: boolean;
  writeFeaturesEnabled: boolean;
  readinessEnforcement: ReadinessEnforcement;
}

// The opentide/* custom notification methods the server can emit — the part of the
// wire surface that no standard capability field implies (changesetStatus,
// documentChanged). Derived from LspMethods so it can't drift from what the server
// actually speaks; folded into the fingerprint so adding one is a surface change.
function customNotificationMethods(): string[] {
  return Object.values(LspMethods)
    .filter((m) => m.startsWith(`${OPENTIDE_URI_SCHEME}/`));
}

// The structural fingerprint of the advertised surface (Stage 8). Covers every
// capability field EXCEPT the two that aren't structural contract:
//   - opentideSurface itself (chicken-and-egg — it carries this hash), and
//   - opentideReadinessEnforcement (a runtime POLICY value; a config change must not
//     move the surface hash — mirrors MCP excluding advisory metadata).
// The opentide/* custom notification methods are folded in so they're pinned too.
// Reuses the core order-independent set hash (fingerprint.ts) whose accidental-drift
// threat model is exactly ours.
export function lspSurfaceFingerprint(
  capabilities: ServerCapabilities,
): string {
  const { opentideSurface: _s, opentideReadinessEnforcement: _r, ...structural } =
    capabilities;
  const parts = [
    `capabilities\n${JSON.stringify(canonicalizeJson(structural))}`,
    ...customNotificationMethods().map((m) => `notification\n${m}`),
  ];
  return hashParts(parts);
}

// The opentideSurface payload: the pinned contract version + the structural hash of
// the passed (pre-opentideSurface) capabilities. Attached by buildServerCapabilities.
export function lspSurfaceMeta(
  capabilities: ServerCapabilities,
): GenieSurfaceMeta {
  return {
    version: LSP_SURFACE_VERSION,
    fingerprint: lspSurfaceFingerprint(capabilities),
  };
}

// Build the capabilities advertised in the initialize result — the SINGLE source of
// the advertised surface, shared by the live server (LspServer.capabilities) and the
// pin test. A runtime with no language intelligence advertises the empty set (the
// server sends no feature requests). Otherwise: the Stage 1 read providers always,
// the Stage 3–7 write providers behind the flag, the Stage 4 readiness policy always,
// and finally the opentideSurface contract (version + fingerprint over everything above).
export function buildServerCapabilities(
  inputs: ServerCapabilityInputs,
): ServerCapabilities {
  if (!inputs.languageIntelligence) return {};

  // Full sync: each didChange carries the whole buffer. Behind the write flag we
  // widen to the object form to advertise save.includeText (the client then sends
  // the saved buffer on didSave); flag off ⇒ the bare Full number, no save.
  const textDocumentSync = inputs.writeFeaturesEnabled
    ? {
      openClose: true,
      change: TextDocumentSyncKind.Full,
      save: { includeText: true },
    }
    : TextDocumentSyncKind.Full;

  const capabilities: ServerCapabilities = {
    textDocumentSync,
    // resolveProvider is false: the service computes detail/documentation eagerly,
    // so there is nothing to lazily resolve via completionItem/resolve.
    completionProvider: { resolveProvider: false },
    hoverProvider: true,
    definitionProvider: true,
    referencesProvider: true,
    documentHighlightProvider: true,
    // Stage 4: the active readiness-enforcement policy so a client can explain the
    // risk-adaptive save behavior. A policy VALUE, not structure — excluded from the
    // fingerprint below.
    opentideReadinessEnforcement: inputs.readinessEnforcement,
  };

  // Stage 6–7 write providers, all behind the same flag that gates save.includeText:
  // creation command + file-create trigger + rename. A read-only server offers none,
  // so a client shows no write affordance.
  if (inputs.writeFeaturesEnabled) {
    capabilities.executeCommandProvider = {
      commands: [LSP_CREATE_ENTITY_COMMAND],
    };
    capabilities.workspace = {
      fileOperations: {
        didCreate: {
          filters: [{ scheme: OPENTIDE_URI_SCHEME, pattern: { glob: "**/*.ts" } }],
        },
      },
    };
    capabilities.renameProvider = true;
  }

  // Attach the surface contract LAST — the fingerprint covers every field set above
  // (minus the policy value) plus the opentide/* notifications.
  capabilities.opentideSurface = lspSurfaceMeta(capabilities);
  return capabilities;
}
