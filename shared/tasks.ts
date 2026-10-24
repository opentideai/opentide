// @layer shared — L0, the wire contract for task forks (docs/opentide-task-forks-plan.md):
// the bodies of GET/POST /api/tasks, GET /api/tasks/:id/diff and
// POST /api/tasks/:id/merge. Type-only; imports NOTHING. The backend re-exports
// these from core/tasks/; the IDE reads them through `$shared`.

export type TaskStatus = "open" | "merged" | "discarded";

export interface TaskRecord {
  id: string;
  title: string;
  // The fork's project directory.
  path: string;
  status: TaskStatus;
  createdAt: string;
  // The fork's serve, while one is running.
  pid?: number;
  port?: number;
  // The main changeset the merge landed under.
  mergeChangesetId?: string;
  // When the fork was deleted. A merged task keeps status `merged` after that.
  discardedAt?: string;
  // `category:key` scopes the task expects to touch, e.g. `handler:calcTotal`.
  claims: string[];
  // The changeset that was open when the fork was cut. The fork started from its
  // start snapshot, so that is the merge base.
  baseChangesetId?: string;
}

export interface TaskOverlap {
  taskId: string;
  title: string;
  scopes: string[];
}

export interface TaskWithOverlaps extends TaskRecord {
  overlaps: TaskOverlap[];
}

export interface CreatedTask {
  task: TaskRecord;
  overlaps: TaskOverlap[];
}

export interface TaskServe {
  pid: number;
  port: number;
  mcpUrl: string;
  // Set when this call started the serve; null when one was already running.
  logPath: string | null;
  started: boolean;
}

// The body of POST /api/tasks: the task, plus its serve or why it didn't start.
export interface CreatedTaskWithServe extends CreatedTask {
  serve?: TaskServe;
  serveError?: { code: string; message: string; suggestion?: string };
}

// State categories a task diff compares. core/tasks/state-diff.ts holds them in
// apply order.
export type StateDiffCategory =
  | "types"
  | "configs"
  | "envVars"
  | "packages"
  | "functions"
  | "handlers"
  | "routes"
  | "templates"
  | "assets"
  | "devViews"
  | "devTools"
  | "tests"
  | "customAudits";

export type DiffCategory = "schema" | StateDiffCategory | "files";

export type ChangeOp =
  | "create"
  | "update"
  | "rename"
  | "delete"
  | "alter"
  | "regenerate";

export interface Change {
  category: DiffCategory;
  // The entity's name after the change; for a delete, the name it had.
  key: string;
  op: ChangeOp;
  // The fork's entry for create, update and rename. A file's entry is its text.
  entry?: unknown;
  // For a rename: the name main still has. `contentChanged` says the rename
  // also carries an edit.
  renamedFrom?: string;
  contentChanged?: boolean;
  // For schema create and alter: the fork's forward statements, in order.
  statements?: string[];
}

export interface Conflict {
  category: DiffCategory;
  key: string;
  reason: string;
}

export type NoteSeverity = "info" | "warning" | "blocking";

export type NoteKind =
  | "rows"
  | "documents"
  | "secrets"
  | "schema-drop"
  | "schema-undo"
  | "binary-file"
  | "files-no-base";

export interface Note {
  kind: NoteKind;
  severity: NoteSeverity;
  message: string;
  key?: string;
}

export interface TaskStateDiff {
  apply: Change[];
  conflicts: Conflict[];
  notMerged: Note[];
}

export interface TaskDiff extends TaskStateDiff {
  task: TaskRecord;
  // True when a conflict or a blocking note rules the merge out.
  blocked: boolean;
}

export type MergeOutcome =
  // Applied, tested on main, changeset completed.
  | "merged"
  // Applied, but main's changeset didn't pass its gate; it stays in_progress.
  | "unverified"
  // An apply failed partway; what landed stays, under an in_progress changeset.
  | "apply-failed";

export interface AppliedChange {
  category: DiffCategory;
  key: string;
  op: ChangeOp;
}

export interface MergeFailure extends AppliedChange {
  code: string;
  message: string;
}

export interface TaskMerge {
  task: TaskRecord;
  outcome: MergeOutcome;
  changesetId: string;
  applied: AppliedChange[];
  failure?: MergeFailure;
  // Main's test run, when one ran.
  tests?: { total: number; passed: number; failed: number };
  // Why main's changeset didn't complete, one line per gate failure.
  readiness?: string[];
  notMerged: Note[];
}
