// @layer lsp — the `opentide://` document URI scheme, the linchpin that lets an
// entity-addressed language service (entityType + entityName) masquerade as a
// file an editor can open (docs/lsp-support-plan.md §3 "Addressing gap", Stage 0).
//
//   opentide://<runtimeId>/<entityTypePlural>/<name>.ts
//   e.g.  opentide://typescript/handlers/getUsers.ts
//
// The path segment after the runtimeId is exactly the language service's virtual
// FS layout minus the VIRTUAL_ROOT prefix, so the two cannot drift: we reuse the
// same pluralize/singularize helpers the service uses for entityPath(). The
// leading runtimeId (authority) makes the scheme multi-runtime ready from day one
// (language-adapters-architecture-plan.md) even though only "typescript" exists.
import type { Result } from "../core/types.ts";
import {
  entityPath,
  parseEntityPath,
  pluralizeEntityType,
  VIRTUAL_ROOT,
} from "../core/language-service.ts";

export const OPENTIDE_URI_SCHEME = "opentide";

// The three coordinates a `opentide://` URI encodes. `runtimeId` selects the runtime
// adapter (kernel.runtime); `entityType` is the SINGULAR form the tools/registries
// speak ("handler"), even though the URI path carries the plural folder.
export interface GenieDocumentRef {
  runtimeId: string;
  entityType: string;
  entityName: string;
}

// runtimeId and the plural folder segment are single path tokens (no slashes);
// the entity name is the remainder before `.ts` (may itself contain dots, so it
// is matched greedily — mirrors parseEntityPath in language-service.ts).
const OPENTIDE_URI_RE = new RegExp(
  `^${OPENTIDE_URI_SCHEME}://([^/]+)/(\\w+)/(.+)\\.ts$`,
);

// Build the canonical URI for an entity. Reuses entityPath() so the plural folder
// and `.ts` suffix are produced by the same code the service uses for its virtual
// FS — guaranteeing round-trip with parseGenieUri and with the service's own
// parseEntityPath.
export function entityUri(ref: GenieDocumentRef): string {
  // entityPath() yields `${VIRTUAL_ROOT}/handlers/name.ts`; swap the virtual root
  // for the `opentide://<runtimeId>` authority so a single source builds both forms.
  const virtualPath = entityPath(ref.entityType, ref.entityName);
  const relative = virtualPath.slice(VIRTUAL_ROOT.length); // "/handlers/name.ts"
  return `${OPENTIDE_URI_SCHEME}://${ref.runtimeId}${relative}`;
}

// Parse a `opentide://` URI back to its coordinates. Fallible → Result<T> (CLAUDE.md:
// Result for fallible ops, never throw). The plural→singular reduction goes
// through singularizeEntityType (via parseEntityPath) so it matches the service.
export function parseGenieUri(uri: string): Result<GenieDocumentRef> {
  const match = uri.match(OPENTIDE_URI_RE);
  if (!match) {
    return {
      ok: false,
      error: {
        code: "INVALID_ENTITY_URI",
        message: `"${uri}" is not a opentide:// document URI`,
        suggestion:
          `Expected ${OPENTIDE_URI_SCHEME}://<runtimeId>/<entityTypePlural>/<name>.ts`,
      },
    };
  }
  const runtimeId = match[1]!;
  // Reuse the service's own path parser for the plural→singular + name split, so
  // the URI and the virtual FS can never disagree on how a folder maps to a type.
  const parsed = parseEntityPath(
    `${VIRTUAL_ROOT}/${match[2]!}/${match[3]!}.ts`,
  );
  if (!parsed) {
    return {
      ok: false,
      error: {
        code: "INVALID_ENTITY_URI",
        message: `"${uri}" has an unrecognized entity path`,
      },
    };
  }
  return {
    ok: true,
    data: {
      runtimeId,
      entityType: parsed.entityType,
      entityName: parsed.entityName,
    },
  };
}

// Re-export the plural helper for callers that build URI-adjacent strings, so the
// lsp layer never re-implements the folder mapping.
export { pluralizeEntityType };
