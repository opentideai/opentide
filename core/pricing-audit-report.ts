// @layer core — the human-readable rendering of the overlay audit, split out of
// core/pricing-audit.ts so both runners (scripts/audit-pricing.ts and the
// pricing:check runner) print the same report and neither owns the formatting.
// Returns strings; the composition roots do the console I/O.
import type {
  LedgerPricingCrossCheck,
  OverlayAuditReport,
  OverlayRowAudit,
} from "./pricing-audit.ts";

function price(row: { input: number; output: number }): string {
  return `$${row.input}/$${row.output}`;
}

function window(row: OverlayRowAudit): string {
  const from = row.row.effectiveFrom;
  const through = row.row.effectiveThrough;
  if (!from && !through) return "no date window";
  return `${from ?? "-"} .. ${through ?? "-"}`;
}

// One line per row: what it says, what actually prices the model, and where that
// price came from. `resolvedSource` is read straight off the real resolver, so
// this column can never quietly disagree with what the kernel bills.
function line(row: OverlayRowAudit): string {
  const builtIn = row.builtIn
    ? `built-in ${price(row.builtIn)}`
    : "no built-in row";
  const winner = row.wins
    ? "PRICES THIS MODEL"
    : `not used (${row.resolvedSource} wins)`;
  return `  - ${row.provider}/${row.model}: ${row.row.source} ` +
    `${price(row.row)} [${window(row)}] vs ${builtIn} -> ${winner}`;
}

function section(
  title: string,
  rows: OverlayRowAudit[],
): string[] {
  if (!rows.length) return [];
  return [`\n${title}`, ...rows.map(line)];
}

export function formatOverlayAudit(report: OverlayAuditReport): string {
  const lines: string[] = [
    `Overlay pricing audit (as of ${report.asOf}) - ${report.rows.length} ` +
    `provider/model row(s) in the effective overlay.`,
  ];

  lines.push(
    ...section(
      `ACTIONABLE (${report.actionable.length}) - a snapshot price is ` +
        `outranking curated data, or an out-of-window row is still pricing:`,
      report.actionable,
    ),
  );
  lines.push(
    ...section(
      `EXPIRED (${report.expired.length}) - effectiveThrough has passed; the ` +
        `model has degraded to whatever is behind this row:`,
      report.expired,
    ),
  );
  lines.push(
    ...section(
      `EXPIRING SOON (${report.expiringSoon.length}) - refresh the source ` +
        `before these lapse:`,
      report.expiringSoon,
    ),
  );
  lines.push(
    ...section(
      `UNCORROBORATED (${report.uncorroborated.length}) - pricing real calls ` +
        `with nothing to check them against; a repeat of the 4.10 bug here ` +
        `would be undetectable:`,
      report.uncorroborated,
    ),
  );
  lines.push(
    ...section(
      `DELIBERATE OVERRIDES (${report.overrides.length}) - manual/verified ` +
        `rows intentionally disagreeing with the built-in table:`,
      report.overrides,
    ),
  );
  lines.push(
    ...section(
      `IGNORED (${report.ignored.length}) - present in the overlay, never ` +
        `consulted by the resolver:`,
      report.ignored,
    ),
  );

  if (lines.length === 1) {
    lines.push(
      "\nNothing to report: every overlay row is in-window, corroborated and " +
        "agreeing with the built-in table.",
    );
  }
  return lines.join("\n");
}

export function formatLedgerCrossCheck(
  checks: LedgerPricingCrossCheck[],
): string {
  if (!checks.length) {
    return "\nLedger: no priced model-usage rows found for this project.";
  }
  const lines = [
    `\nLedger cross-check - ${checks.length} model(s) actually billed:`,
  ];
  for (const c of checks) {
    const recorded = c.recordedSources
      .map((s) => s ?? "(pre-column)")
      .join(", ");
    const flag = c.sourceChanged ? "  <- SOURCE CHANGED" : "";
    lines.push(
      `  - ${c.provider}/${c.model}: ${c.rows} row(s) ${c.firstAt} .. ` +
        `${c.lastAt}; recorded ${recorded}; today ${c.currentSource}${flag}`,
    );
  }
  return lines.join("\n");
}
