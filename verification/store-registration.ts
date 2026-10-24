// @layer verification — the concrete changeset/audit store factories (OpenTide
// §3.3). This is the one place that imports the managers into the store seam;
// the composition roots (cli/assembly.ts) carry these as the Kernel's composition
// store factories so core never imports the managers.
import { ChangesetManager } from "./changesets.ts";
import { AuditManager } from "./audit-manager.ts";
import { McpAuditManager } from "./mcp-audit.ts";
import type {
  AuditStoreFactory,
  ChangesetStoreFactory,
  McpAuditStoreFactory,
} from "../core/composition.ts";

export const defaultChangesetStoreFactory: ChangesetStoreFactory = (storage) =>
  new ChangesetManager(storage);
export const defaultAuditStoreFactory: AuditStoreFactory = (db) =>
  new AuditManager(db);
export const defaultMcpAuditStoreFactory: McpAuditStoreFactory = (db) =>
  new McpAuditManager(db);
