// @layer core — merging a task fork back into main (docs/opentide-task-forks-plan.md
// Slice 5). Runs in main's serve. The fork's serve is stopped, the 3-way diff is
// taken, and what only the fork changed is replayed onto main through dispatchTool
// under one main changeset, so QC, the gate and the changelog all see it. Main's
// own tests then decide whether that changeset completes: the fork's evidence is
// void here, because main's code is not the fork's.
import { type ChangeContext, Changelog } from "../changelog.ts";
import { getProjectPaths } from "../project-manager.ts";
import type { Kernel } from "../registries.ts";
import {
  dispatchTool,
  flushKernelProjectState,
  removeRecordedProjectFile,
  type TestRunSummary,
  type ToolResult,
} from "../tools/dispatch.ts";
import type { Result } from "../types.ts";
import { errorMessage } from "../util.ts";
import { findTask, mainDir, releaseFork, saveTask, taskError } from "./fork.ts";
import type { Change, DiffCategory, StateDiffCategory } from "./state-diff.ts";
import type { AppliedChange, TaskMerge } from "../../shared/tasks.ts";
import { diffTask, type TaskDiff } from "./task-diff.ts";
import { readTasks, type TaskRecord } from "./task-store.ts";

const APPLY_STEP_ID = "step_0";
const TEST_STEP_ID = "step_1";
const TEST_CHECK_ID = "check_main_tests";
const TEST_CLAIM_ID = "claim_0";
const TEST_EVIDENCE_ID = "evidence_main_tests";

// The changelog category each diff category records under. A config delete has
// its own verb; every other delete goes through remove_entity with this type.
const CHANGELOG_CATEGORY: Record<DiffCategory, string> = {
  schema: "schema",
  types: "type",
  configs: "config",
  envVars: "env_var",
  packages: "package",
  functions: "function",
  handlers: "handler",
  routes: "route",
  templates: "template",
  assets: "asset",
  devViews: "dev_view",
  devTools: "dev_tool",
  tests: "test",
  customAudits: "audit",
  files: "module",
};

export type {
  AppliedChange,
  MergeFailure,
  MergeOutcome,
  TaskMerge,
} from "../../shared/tasks.ts";

interface ToolCall {
  tool: string;
  input: Record<string, unknown>;
}

// One unit of the replay: a diff change and the tool calls that carry it.
interface MergeStep {
  change: AppliedChange;
  calls: ToolCall[];
  // A recorded file delete has no tool.
  removeFile?: string;
}

function defined(input: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(input).filter(([, v]) => v !== undefined),
  );
}

// `npm:marked@5.1.0` → `5.1.0`; no version → undefined.
export function packageVersion(specifier: string): string | undefined {
  const bare = specifier.replace(/^[a-z]+:/, "");
  const at = bare.lastIndexOf("@");
  return at > 0 ? bare.slice(at + 1) : undefined;
}

function defineCall(
  category: StateDiffCategory,
  entry: Record<string, unknown>,
  taskId: string,
): ToolCall {
  const e = entry;
  // The fork already answered the duplicate check for this entity.
  const duplicateJustification = `Merged from task ${taskId}.`;
  switch (category) {
    case "types":
      return {
        tool: "define_type",
        input: { name: e.name, fields: e.fields, description: e.description },
      };
    case "configs":
      return {
        tool: "set_config",
        input: { name: e.name, value: e.value, description: e.description },
      };
    case "envVars":
      return {
        tool: "define_env_var",
        input: {
          key: e.key,
          value: e.value,
          description: e.description,
          clearValue: e.value === undefined,
        },
      };
    case "packages":
      return {
        tool: "install_package",
        input: { name: e.name, version: packageVersion(String(e.specifier)) },
      };
    case "functions":
      return {
        tool: "define_function",
        input: {
          name: e.name,
          source: e.source,
          returnType: e.returnType,
          purpose: e.purpose,
          duplicateJustification,
        },
      };
    case "handlers":
      return {
        tool: "define_handler",
        input: {
          name: e.name,
          source: e.source,
          schema: e.schema,
          purpose: e.purpose,
          duplicateJustification,
        },
      };
    case "routes":
      return {
        tool: "register_route",
        input: {
          method: e.method,
          path: e.path,
          handlerName: e.handlerName,
          schema: e.schema,
        },
      };
    case "templates":
      return {
        tool: "define_template",
        input: { name: e.name, content: e.content },
      };
    case "assets":
      return {
        tool: "upload_asset",
        input: {
          name: e.name,
          contentBase64: e.contentBase64,
          mimeType: e.mimeType,
        },
      };
    case "devViews":
      return {
        tool: "define_dev_view",
        input: {
          name: e.name,
          targetType: e.targetType,
          title: e.title,
          source: e.source,
        },
      };
    case "devTools":
      return {
        tool: "define_dev_tool",
        input: {
          name: e.name,
          description: e.description,
          args: e.args,
          source: e.source,
        },
      };
    case "tests":
      return { tool: "define_test", input: { name: e.name, source: e.source } };
    case "customAudits":
      return {
        tool: "define_audit",
        input: { name: e.name, description: e.description, prompt: e.prompt },
      };
  }
}

function withModule(
  call: ToolCall,
  entry: Record<string, unknown>,
): ToolCall {
  const input = defined({ ...call.input, module: entry.module });
  return { tool: call.tool, input };
}

function removeCall(category: StateDiffCategory, key: string): ToolCall {
  return category === "configs"
    ? { tool: "delete_config", input: { name: key } }
    : {
      tool: "remove_entity",
      input: { type: CHANGELOG_CATEGORY[category], key },
    };
}

function schemaCalls(change: Change): ToolCall[] {
  const statements = change.statements ?? [];
  return statements.map((sql, i) => ({
    tool: change.op === "create" && i === 0 ? "define_schema" : "alter_schema",
    input: { tableName: change.key, sql },
  }));
}

function step(
  change: Change,
  calls: ToolCall[],
  removeFile?: string,
): MergeStep {
  const { category, key, op } = change;
  return {
    change: { category, key, op },
    calls,
    ...(removeFile ? { removeFile } : {}),
  };
}

function stateCategory(category: DiffCategory): StateDiffCategory | null {
  return category === "schema" || category === "files" ? null : category;
}

// The replay, in the diff's order. A rename defines the new name in place and
// retires the old one with the deletes, after anything that pointed at it (a
// route) has moved over.
export function planMergeSteps(apply: Change[], taskId: string): MergeStep[] {
  const steps: MergeStep[] = [];
  const retired: MergeStep[] = [];
  for (const change of apply) {
    const category = stateCategory(change.category);
    if (change.category === "schema") {
      steps.push(step(change, schemaCalls(change)));
    } else if (change.op === "regenerate") {
      steps.push(step(change, [{
        tool: "generate_project_docs",
        input: { files: [change.key] },
      }]));
    } else if (change.category === "files") {
      steps.push(
        change.op === "delete" ? step(change, [], change.key) : step(change, [{
          tool: "write_project_file",
          input: { path: change.key, content: change.entry },
        }]),
      );
    } else if (category && change.op === "delete") {
      steps.push(step(change, [removeCall(category, change.key)]));
    } else if (category) {
      const entry = change.entry as Record<string, unknown>;
      steps.push(step(change, [
        withModule(defineCall(category, entry, taskId), entry),
      ]));
      if (change.op === "rename" && change.renamedFrom) {
        retired.push({
          change: {
            category: change.category,
            key: change.renamedFrom,
            op: "delete",
          },
          calls: [removeCall(category, change.renamedFrom)],
        });
      }
    }
  }
  const firstDelete = steps.findIndex((s) => s.change.op === "delete");
  const at = firstDelete === -1 ? steps.length : firstDelete;
  return [...steps.slice(0, at), ...retired, ...steps.slice(at)];
}

// The fork's last recorded reason for touching this entity, carried onto the
// merge record.
async function forkRationale(
  forkLog: Changelog,
  change: AppliedChange,
): Promise<{ rationale: string | null; implementation: string | null }> {
  const [last] = await forkLog.entityHistory(
    CHANGELOG_CATEGORY[change.category],
    change.key,
    1,
  );
  return {
    rationale: last?.rationale ?? null,
    implementation: last?.implementation ?? null,
  };
}

interface MergeRun {
  kernel: Kernel;
  rebuild: () => void;
  task: TaskRecord;
  projectDir: string;
  sessionId: string;
  changesetId: string;
  forkLog: Changelog;
  calls: number;
}

function callContext(run: MergeRun, toolCallId?: string): ChangeContext {
  return {
    sessionId: run.sessionId,
    changesetId: run.changesetId,
    principalId: `task:${run.task.id}`,
    userMessage: `Task merge: ${run.task.title}`,
    ...(toolCallId ? { toolCallId } : {}),
  };
}

async function carryRationale(
  run: MergeRun,
  toolCallId: string,
  change: AppliedChange,
): Promise<void> {
  const why = await forkRationale(run.forkLog, change);
  const rationale = why.rationale ??
    `Merged from task ${run.task.id} ("${run.task.title}").`;
  const records = await run.kernel.changelog.listByChangeset(run.changesetId);
  for (const record of records) {
    if (record.context?.toolCallId !== toolCallId) continue;
    await run.kernel.changelog.updateWorkblockMetadata(record.id, {
      rationale,
      ...(why.implementation ? { implementation: why.implementation } : {}),
    });
  }
}

async function runStep(
  run: MergeRun,
  s: MergeStep,
): Promise<{ code: string; message: string } | null> {
  const toolCallId = `merge_${run.task.id}_${run.calls++}`;
  try {
    if (s.removeFile !== undefined) {
      await removeRecordedProjectFile(
        run.kernel,
        run.projectDir,
        s.removeFile,
        callContext(run, toolCallId),
      );
    }
    for (const call of s.calls) {
      const result: ToolResult = await dispatchTool(
        call.tool,
        call.input,
        run.kernel,
        run.rebuild,
        callContext(run, toolCallId),
      );
      if (!result.ok) {
        return result.error ??
          { code: "MERGE_APPLY_FAILED", message: `${call.tool} failed.` };
      }
    }
  } catch (err) {
    return { code: "MERGE_APPLY_FAILED", message: errorMessage(err) };
  }
  await carryRationale(run, toolCallId, s.change);
  return null;
}

async function openMergeChangeset(
  kernel: Kernel,
  rebuild: () => void,
  task: TaskRecord,
  changeCount: number,
): Promise<Result<{ sessionId: string; changesetId: string }>> {
  const session = await kernel.sessions.createSession(
    `Task merge: ${task.title}`,
  );
  const created = await dispatchTool(
    "create_changeset",
    {
      title: `Merge task: ${task.title}`,
      description: `Replays task ${task.id} from ${task.path} onto main.`,
      change_class: "standard",
      plan: {
        summary:
          `Apply the ${changeCount} change(s) only task ${task.id} made, then run main's tests.`,
        steps: [
          `Apply task ${task.id}'s changes`,
          "Run main's tests on the merged code",
        ],
        acceptanceCriteria: [
          "Main's tests pass with the task's changes applied.",
        ],
        verificationPlan: [{
          id: TEST_CHECK_ID,
          claimIds: [TEST_CLAIM_ID],
          kind: "unit",
          description: "run_tests on main after the merge.",
        }],
      },
    },
    kernel,
    rebuild,
    { sessionId: session.id, principalId: `task:${task.id}` },
  );
  if (!created.ok || !created.data) {
    const error = created.error ??
      { code: "CHANGESET_ERROR", message: "create_changeset failed." };
    return { ok: false, error };
  }
  const changesetId = (created.data as { id: string }).id;
  await kernel.changesets.approve(changesetId);
  await kernel.changesets.startWork(changesetId);
  return { ok: true, data: { sessionId: session.id, changesetId } };
}

async function markStep(run: MergeRun, stepId: string): Promise<void> {
  await dispatchTool(
    "update_changeset_step",
    { changeset_id: run.changesetId, step_id: stepId, status: "done" },
    run.kernel,
    run.rebuild,
    callContext(run),
  );
}

// Runs main's tests and records them as the changeset's verification run. With
// no tests there's no attestation to cite, so nothing is recorded and the gate
// says so.
async function verifyOnMain(
  run: MergeRun,
): Promise<TaskMerge["tests"] | undefined> {
  const result = await dispatchTool(
    "run_tests",
    {},
    run.kernel,
    run.rebuild,
    callContext(run),
  );
  await markStep(run, TEST_STEP_ID);
  const summary = result.data as TestRunSummary | undefined;
  if (!result.ok || !summary || summary.total === 0) return undefined;
  const changeset = await run.kernel.changesets.get(run.changesetId);
  const attestation = (changeset?.plan.attestations ?? [])
    .filter((a) => a.kind === "test").at(-1);
  if (!attestation) return undefined;
  const status = summary.failed === 0 ? "passed" : "failed";
  await dispatchTool(
    "record_verification_run",
    {
      changeset_id: run.changesetId,
      status,
      summary:
        `Main's tests after merging task ${run.task.id}: ${summary.summary}`,
      evidence: [{
        id: TEST_EVIDENCE_ID,
        kind: "unit",
        status,
        summary: summary.summary,
        checkId: TEST_CHECK_ID,
        attestationId: attestation.id,
      }],
      claimResults: [{
        claimId: TEST_CLAIM_ID,
        status,
        evidenceIds: [TEST_EVIDENCE_ID],
      }],
      residualRisks: [],
    },
    run.kernel,
    run.rebuild,
    callContext(run),
  );
  return {
    total: summary.total,
    passed: summary.passed,
    failed: summary.failed,
  };
}

async function completeOnMain(run: MergeRun): Promise<string[]> {
  const completed = await dispatchTool(
    "complete_changeset",
    { changeset_id: run.changesetId },
    run.kernel,
    run.rebuild,
    callContext(run),
  );
  if (completed.ok) return [];
  return (completed.error?.message ?? "complete_changeset failed.")
    .split("\n").filter((line) => line.trim() !== "");
}

// A conflict can't be fixed in the fork: its base is where main was when it
// started, so the entity reads as changed on both sides whatever the fork does.
function blockedError(task: TaskRecord, diff: TaskDiff): Result<never> {
  return taskError(
    "TASK_MERGE_BLOCKED",
    blockedMessage(task, diff),
    diff.conflicts.length > 0
      ? `Nothing was merged. Discard task ${task.id} and redo the conflicting work in a new task, which starts from main as it is now.`
      : `Nothing was merged. Fix it in the fork with \`opentide mcp --project ${task.path}\`, then merge again.`,
  );
}

function blockedMessage(task: TaskRecord, diff: TaskDiff): string {
  const lines = [
    ...diff.conflicts.map((c) =>
      `  conflict ${c.category}:${c.key}: ${c.reason}`
    ),
    ...diff.notMerged.filter((n) => n.severity === "blocking").map((n) =>
      `  ${n.kind}${n.key ? ` ${n.key}` : ""}: ${n.message}`
    ),
  ];
  return [`Task "${task.id}" can't merge:`, ...lines].join("\n");
}

async function refuseUnlessIdle(
  kernel: Kernel,
  task: TaskRecord,
): Promise<Result<void>> {
  const factory = kernel.composition.changesetStoreFactory;
  const forkActive = factory
    ? await factory(getProjectPaths(task.path).historyDir).getActive()
    : null;
  if (forkActive) {
    return taskError(
      "TASK_BUSY",
      `Task "${task.id}" has changeset "${forkActive.id}" (${forkActive.status}) open in the fork.`,
      "Complete or abandon it in the fork, then merge.",
    );
  }
  const mainActive = await kernel.activeChangesetId();
  if (mainActive) {
    return taskError(
      "CHANGESET_ACTIVE",
      `Main has changeset "${mainActive}" open.`,
      "Complete or abandon it, then merge.",
    );
  }
  return { ok: true, data: undefined };
}

function markMerged(
  tasksFile: string,
  task: TaskRecord,
  changesetId: string,
): TaskRecord {
  const { pid: _pid, port: _port, ...rest } = task;
  const merged: TaskRecord = {
    ...rest,
    status: "merged",
    mergeChangesetId: changesetId,
  };
  saveTask(tasksFile, merged);
  return merged;
}

export async function mergeTask(
  kernel: Kernel,
  id: string,
  rebuild: () => void,
): Promise<Result<TaskMerge>> {
  const dir = mainDir(kernel);
  if (!dir.ok) return dir;
  const tasksFile = getProjectPaths(dir.data).tasksFile;
  const found = findTask(readTasks(tasksFile), id);
  if (!found.ok) return found;
  const task = found.data;
  if (task.status !== "open") {
    return taskError("TASK_NOT_OPEN", `Task "${id}" is ${task.status}.`);
  }
  const idle = await refuseUnlessIdle(kernel, task);
  if (!idle.ok) return idle;
  // Refuse before stopping anything, so a blocked fork keeps its serve.
  const preview = await diffTask(kernel, id);
  if (!preview.ok) return preview;
  if (preview.data.blocked) return blockedError(task, preview.data);
  if (!(await releaseFork(task))) {
    return taskError(
      "TASK_BUSY",
      `Task "${id}" is open in another process.`,
      "Close whatever has the fork open, then merge again.",
    );
  }

  // Diffed again: the fork could have changed before its serve stopped.
  const diff = await diffTask(kernel, id);
  if (!diff.ok) return diff;
  if (diff.data.blocked) return blockedError(task, diff.data);

  const opened = await openMergeChangeset(
    kernel,
    rebuild,
    task,
    diff.data.apply.length,
  );
  if (!opened.ok) return opened;
  const run: MergeRun = {
    kernel,
    rebuild,
    task,
    projectDir: dir.data,
    ...opened.data,
    forkLog: new Changelog(getProjectPaths(task.path).historyDir),
    calls: 0,
  };
  const base = {
    changesetId: run.changesetId,
    notMerged: diff.data.notMerged,
  };

  const applied: AppliedChange[] = [];
  for (const s of planMergeSteps(diff.data.apply, task.id)) {
    const failed = await runStep(run, s);
    if (failed) {
      flushKernelProjectState(kernel);
      return {
        ok: true,
        data: {
          ...base,
          task,
          outcome: "apply-failed",
          applied,
          failure: { ...s.change, ...failed },
        },
      };
    }
    applied.push(s.change);
  }
  await markStep(run, APPLY_STEP_ID);

  const tests = await verifyOnMain(run);
  const readiness = await completeOnMain(run);
  flushKernelProjectState(kernel);
  const merged = markMerged(tasksFile, task, run.changesetId);
  return {
    ok: true,
    data: {
      ...base,
      task: merged,
      outcome: readiness.length === 0 ? "merged" : "unverified",
      applied,
      ...(tests ? { tests } : {}),
      ...(readiness.length > 0 ? { readiness } : {}),
    },
  };
}
