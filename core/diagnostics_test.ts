import { assert, assertEquals } from "@std/assert";
import { Kernel } from "./registries.ts";
import { Database } from "./db.ts";
import type { CompositionContext } from "./composition.ts";
import type { DiagnosticEntry } from "./language-service.ts";
import { testComposition } from "../cli/test-composition.ts";
import { getMergedDiagnostics, qcIssuesToDiagnostics } from "./diagnostics.ts";
import type { QCIssue } from "./qc.ts";
import {
  LSP_DIAGNOSTIC_SOURCE_QC,
  LSP_DIAGNOSTIC_SOURCE_TS,
  LSP_DIAGNOSTIC_SOURCE_VERIFY,
  QC_DIAGNOSTIC_DEFAULT_COLUMN,
  QC_DIAGNOSTIC_DEFAULT_LINE,
} from "./config.ts";

const testOpts = { sanitizeResources: false, sanitizeOps: false };

async function withKernel(
  fn: (kernel: Kernel) => Promise<void>,
  composition: CompositionContext = testComposition(),
): Promise<void> {
  const db = await Database.create({ driver: "pglite" });
  const kernel = new Kernel(db, { composition });
  try {
    await fn(kernel);
  } finally {
    await db.close();
  }
}

// --- the pure QC → diagnostic mapping (reused verbatim by the Stage 3 write path) ---

Deno.test("qcIssuesToDiagnostics maps level, rule, and line", testOpts, () => {
  const issues: QCIssue[] = [
    {
      level: "error",
      rule: "no-eval",
      message: "eval() is not allowed",
      line: 3,
    },
    { level: "info", rule: "no-todo", message: "Unresolved TODO", line: 5 },
  ];
  const [err, info] = qcIssuesToDiagnostics(issues);

  // severity passes through (QCIssue.level ⊂ DiagnosticEntry severity)
  assertEquals(err!.severity, "error");
  assertEquals(info!.severity, "info");
  // the rule name becomes the code
  assertEquals(err!.code, "no-eval");
  // QC has no column → anchored at column 1; the line is preserved
  assertEquals(err!.line, 3);
  assertEquals(err!.column, QC_DIAGNOSTIC_DEFAULT_COLUMN);
  // every entry is namespaced "qc"
  assertEquals(err!.source, LSP_DIAGNOSTIC_SOURCE_QC);
  assertEquals(info!.source, LSP_DIAGNOSTIC_SOURCE_QC);
});

Deno.test(
  "qcIssuesToDiagnostics anchors a line-less issue at the gutter",
  testOpts,
  () => {
    // A whole-entity finding (e.g. require-await) carries no line — it must still
    // surface, anchored at line 1, not be dropped.
    const [diag] = qcIssuesToDiagnostics([
      {
        level: "warning",
        rule: "require-await",
        message: "Async without await",
      },
    ]);
    assertEquals(diag!.line, QC_DIAGNOSTIC_DEFAULT_LINE);
    assertEquals(diag!.column, QC_DIAGNOSTIC_DEFAULT_COLUMN);
    assertEquals(diag!.severity, "warning");
    assertEquals(diag!.code, "require-await");
  },
);

// --- the merge: compiler ⊕ QC coexist in one namespaced stream ---

Deno.test(
  "getMergedDiagnostics merges tsc and qc, each namespaced",
  testOpts,
  async () => {
    await withKernel(async (kernel) => {
      kernel.handlers.register(
        "getUsers",
        "function getUsers(c) {}",
        () => new Response("[]"),
        undefined,
        "users",
      );
      // A TS error (number = string, flagged even with strict off) AND a QC
      // violation (console.log → no-console) in the same buffer.
      const content =
        'function getUsers(c) {\n  const n: number = "oops";\n  console.log(n);\n}\n';
      const merged = await getMergedDiagnostics(
        kernel,
        "handler",
        "getUsers",
        content,
      );

      const sources = new Set(merged.map((d) => d.source));
      assert(
        sources.has(LSP_DIAGNOSTIC_SOURCE_TS),
        "expected a tsc diagnostic",
      );
      assert(sources.has(LSP_DIAGNOSTIC_SOURCE_QC), "expected a qc diagnostic");

      const tsc = merged.find((d) => d.source === LSP_DIAGNOSTIC_SOURCE_TS);
      assertEquals(tsc!.severity, "error");

      const noConsole = merged.find((d) => d.code === "no-console");
      assert(noConsole, "expected the no-console QC rule");
      assertEquals(noConsole.source, LSP_DIAGNOSTIC_SOURCE_QC);
      assertEquals(noConsole.severity, "warning");
      // console.log sits on line 3 of the buffer.
      assertEquals(noConsole.line, 3);
    });
  },
);

Deno.test(
  "getMergedDiagnostics skips QC for a non-QC entity type",
  testOpts,
  async () => {
    await withKernel(async (kernel) => {
      // A `test` entity has no QCKind, so QC never runs — only the tsc stream can
      // contribute. A clean buffer therefore yields no qc-sourced entries.
      const merged = await getMergedDiagnostics(
        kernel,
        "test",
        "sample",
        "const ok = 1;\nconsole.log(ok);\n",
      );
      assertEquals(
        merged.filter((d) => d.source === LSP_DIAGNOSTIC_SOURCE_QC).length,
        0,
      );
    });
  },
);

// --- the verification seam: an injected provider flows through as "verify" ---

Deno.test(
  "getMergedDiagnostics folds in the verification provider",
  testOpts,
  async () => {
    const provider = (): DiagnosticEntry[] => [
      {
        line: 2,
        column: 1,
        message: "touches a hard-gated invariant",
        severity: "warning",
      },
    ];
    const composition: CompositionContext = {
      ...testComposition(),
      verificationDiagnostics: provider,
    };
    await withKernel(async (kernel) => {
      // No entity registered and no content, so tsc/qc contribute nothing; the merged
      // stream is exactly the verification provider's output, tagged "verify".
      const merged = await getMergedDiagnostics(
        kernel,
        "handler",
        "unregistered",
      );
      assertEquals(merged.length, 1);
      assertEquals(merged[0]!.source, LSP_DIAGNOSTIC_SOURCE_VERIFY);
      assertEquals(merged[0]!.message, "touches a hard-gated invariant");
      assertEquals(merged[0]!.line, 2);
    }, composition);
  },
);
