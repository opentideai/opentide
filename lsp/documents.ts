// @layer lsp — the per-URI open-document store. It is the bridge between LSP's
// "the editor owns a buffer" model and the language service's stateless,
// content-override model (GenieLanguageService.sync(kernel, {path, content})).
//
// The store holds nothing the service doesn't already know how to consume: for
// each open URI it keeps the current full text + version and the entity
// coordinates parsed from the URI. When a read method runs (Stage 1), the server
// passes `content` straight to `kernel.runtime.get*` — which is exactly the
// `override` path sync() already supports. No new sync logic lives here
// (docs/lsp-support-plan.md Stage 0).
import type { Result } from "../core/types.ts";
import { type GenieDocumentRef, parseGenieUri } from "./uri.ts";

// An open document: its parsed coordinates plus the editor's current buffer state.
// `content` is the full text (Full sync), fed verbatim to the service as the
// override buffer; `version` is the LSP document version for staleness guards
// (Stage 1 debounced diagnostics will compare against it).
export interface OpenDocument {
  uri: string;
  ref: GenieDocumentRef;
  version: number;
  content: string;
  // The entity revision this buffer was seeded/last-synced against (Stage 5). Seeded
  // on didOpen from the registry, advanced after the editor's OWN accepted save, and
  // left UNCHANGED by an out-of-band write — so a save from an un-reloaded buffer
  // carries a stale expectedRevision and is caught as STALE_WRITE. `undefined` when
  // the backing entity wasn't registered at open time (nothing to guard against yet).
  syncedRevision?: number;
}

// In-memory map of URI → open document. One store per LSP connection (the server
// owns it), mirroring how each MCP session owns its own state (mcp-http.ts).
export class DocumentStore {
  private readonly documents = new Map<string, OpenDocument>();

  // didOpen: parse the URI to coordinates and seed the buffer. Fallible because a
  // client can open an arbitrary URI; a bad scheme surfaces as a Result error the
  // server turns into a JSON-RPC error rather than throwing across the transport.
  open(uri: string, version: number, content: string): Result<OpenDocument> {
    const parsed = parseGenieUri(uri);
    if (!parsed.ok) return parsed;
    const doc: OpenDocument = { uri, ref: parsed.data, version, content };
    this.documents.set(uri, doc);
    return { ok: true, data: doc };
  }

  // didChange (Full sync): replace the buffer wholesale. A change to an unopened
  // URI is a client protocol violation — report it rather than silently opening,
  // so the seam stays honest.
  change(uri: string, version: number, content: string): Result<OpenDocument> {
    const existing = this.documents.get(uri);
    if (!existing) {
      return {
        ok: false,
        error: {
          code: "DOCUMENT_NOT_OPEN",
          message: `didChange for "${uri}" which was never opened`,
        },
      };
    }
    const doc: OpenDocument = { ...existing, version, content };
    this.documents.set(uri, doc);
    return { ok: true, data: doc };
  }

  // didClose: drop the buffer. The kernel remains the source of truth; on the next
  // read the service falls back to the registered entity source (no override).
  close(uri: string): void {
    this.documents.delete(uri);
  }

  // Record the entity revision this buffer is now based on (Stage 5): the server
  // seeds it on didOpen and advances it after the editor's own accepted save. A no-op
  // if the URI isn't open. didChange preserves it (a local edit keeps the same base
  // revision), so only these explicit calls and open() move it.
  setSyncedRevision(uri: string, revision: number): void {
    const existing = this.documents.get(uri);
    if (existing) existing.syncedRevision = revision;
  }

  get(uri: string): OpenDocument | undefined {
    return this.documents.get(uri);
  }

  has(uri: string): boolean {
    return this.documents.has(uri);
  }

  list(): OpenDocument[] {
    return [...this.documents.values()];
  }
}
