// Reader for the §8 cache-composition trace (`deno task cache:report`).
//
// The trace is one JSON line per PROVIDER REQUEST — the granularity the turn-level
// model-usage ledger throws away. This prints, per turn, what each request's
// outbound context was made of, what it actually cost in cache writes, and the
// five-way rollup the §8 verdict is read off.
//
// No network, no kernel. Point it at a project: `--project <path>`, defaulting to
// the current directory. `--turn <id>` narrows to one turn.
//
// This is an entry point, so it uses console for its report — the no-console-log
// rule is about kernel code.
import { join } from "node:path";
import { readJsonLines } from "../core/history-store.ts";
import { CACHE_COMPOSITION_TRACE_FILE } from "../core/config.ts";
import type { CacheCompositionRecord } from "../core/cache-composition.ts";

function arg(name: string): string | undefined {
  const index = Deno.args.indexOf(`--${name}`);
  return index >= 0 ? Deno.args[index + 1] : undefined;
}

function n(value: number): string {
  return value.toLocaleString("en-US");
}

function pct(part: number, whole: number): string {
  return whole > 0 ? `${((part / whole) * 100).toFixed(1)}%` : "—";
}

const projectDir = arg("project") ?? Deno.cwd();
const path = join(
  projectDir,
  ".opentide",
  "history",
  CACHE_COMPOSITION_TRACE_FILE,
);
const all = readJsonLines<CacheCompositionRecord>(path);
if (all.length === 0) {
  console.error(`No trace rows at ${path}.`);
  console.error(
    "Set OPENTIDE_CACHE_TRACE=1 (or kernel.cacheCompositionTrace) and run a turn.",
  );
  Deno.exit(1);
}

const turnFilter = arg("turn");
const rows = turnFilter ? all.filter((r) => r.turnId === turnFilter) : all;
const turns = [...new Set(rows.map((r) => r.turnId))];

console.log(`Trace: ${path}`);
console.log(`Rows: ${n(rows.length)} requests across ${turns.length} turn(s)`);
console.log(`Method: ${rows[0]?.method ?? "unknown"}\n`);

for (const turnId of turns) {
  const turn = rows.filter((r) => r.turnId === turnId);
  console.log(`── turn ${turnId} — ${turn.length} request(s)`);
  console.log(
    [
      "  #".padEnd(5),
      "est ctx".padStart(10),
      "write".padStart(10),
      "read".padStart(10),
      "new".padStart(9),
      "tools".padStart(9),
      "reason".padStart(9),
      "text".padStart(8),
      "static".padStart(8),
      "ratio".padStart(7),
      "  flags",
    ].join(""),
  );
  for (const r of turn) {
    const b = r.buckets;
    console.log(
      [
        `  ${r.requestIndex}`.padEnd(5),
        n(b.estimatedTotalTokens).padStart(10),
        n(r.usage?.cacheCreationInputTokens ?? 0).padStart(10),
        n(r.usage?.cacheReadInputTokens ?? 0).padStart(10),
        n(r.delta.newTokens).padStart(9),
        n(b.toolResultTokens + b.toolCallInputTokens).padStart(9),
        n(b.reasoningTokens).padStart(9),
        n(b.visibleTextTokens).padStart(8),
        n(b.staticPrefixTokens).padStart(8),
        (r.estimateRatio?.toFixed(2) ?? "—").padStart(7),
        r.delta.prefixMutated ? "  PREFIX-MUTATED" : "",
      ].join(""),
    );
  }

  const write = turn.reduce(
    (s, r) => s + (r.usage?.cacheCreationInputTokens ?? 0),
    0,
  );
  const read = turn.reduce(
    (s, r) => s + (r.usage?.cacheReadInputTokens ?? 0),
    0,
  );
  const newTokens = turn.reduce((s, r) => s + r.delta.newTokens, 0);
  const last = turn[turn.length - 1];
  const rewrites = turn.filter((r) =>
    (r.usage?.cacheCreationInputTokens ?? 0) > r.delta.newTokens * 2
  ).length;

  console.log(
    `\n  turn totals: write ${n(write)}  read ${n(read)}  new content ${
      n(newTokens)
    }`,
  );
  console.log(
    `  writes vs new content: ${
      newTokens > 0 ? (write / newTokens).toFixed(1) : "—"
    }x  — a ratio near 1 means writes are just the delta; high means re-writes`,
  );
  console.log(
    `  requests whose write exceeded 2x their new content: ${rewrites}/${turn.length}`,
  );
  if (last) {
    const b = last.buckets;
    const total = b.estimatedTotalTokens;
    console.log(
      `  final-request composition (${n(total)} est tokens): static ${
        pct(b.staticPrefixTokens, total)
      }, tool traffic ${
        pct(b.toolResultTokens + b.toolCallInputTokens, total)
      }, reasoning ${pct(b.reasoningTokens, total)}, visible text ${
        pct(b.visibleTextTokens, total)
      }`,
    );
    console.log(
      `  breakpoints on the final request: ${
        last.breakpoints.map((p) =>
          `${p.kind}@${p.index}:${n(p.prefixTokens)}`
        )
          .join("  ") || "none"
      }`,
    );
  }
  console.log("");
}
