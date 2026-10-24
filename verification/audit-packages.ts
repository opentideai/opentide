// @layer verification — dependency/package audit.
import type {
  AuditIssue,
  AuditSeverity,
  PackageInput,
  PackageSecurityResult,
} from "../core/types.ts";
export type { PackageInput, PackageSecurityResult };
import {
  computeAuditScore,
  formatAuditSummary,
} from "../core/audit-scoring.ts";
import {
  NPM_AUDIT_BULK_TIMEOUT_MS,
  NPM_REGISTRY_FETCH_TIMEOUT_MS,
} from "../core/config.ts";
import {
  latestSatisfiesDeclaredRange as sharedLatestSatisfiesDeclaredRange,
  parseVersionParts,
} from "../core/package-versions.ts";

interface NpmAdvisory {
  id: number;
  title: string;
  severity: string;
  url: string;
  vulnerable_versions: string;
  recommendation: string;
  module_name: string;
}

interface NpmRegistryInfo {
  version: string;
  description: string;
  deprecated?: string;
}

const NPM_SEVERITY_MAP: Record<string, AuditSeverity> = {
  critical: "critical",
  high: "high",
  moderate: "medium",
  low: "low",
  info: "info",
};

export function parseVersionFromSpecifier(specifier: string): string | null {
  const match = specifier.match(/@([^@]+)$/);
  return match?.[1] ?? null;
}

export function parseNameFromSpecifier(specifier: string): string {
  const withoutNpm = specifier.replace(/^npm:/, "");
  const atIdx = withoutNpm.lastIndexOf("@");
  if (atIdx <= 0) return withoutNpm;
  return withoutNpm.slice(0, atIdx);
}

async function fetchNpmAdvisories(
  packages: Array<{ name: string; version: string }>,
): Promise<NpmAdvisory[]> {
  const body: Record<string, string[]> = {};
  for (const pkg of packages) {
    body[pkg.name] = [pkg.version];
  }

  try {
    const res = await fetch(
      "https://registry.npmjs.org/-/npm/v1/security/advisories/bulk",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(NPM_AUDIT_BULK_TIMEOUT_MS),
      },
    );

    if (!res.ok) return [];

    const data = await res.json() as Record<string, NpmAdvisory[]>;
    const advisories: NpmAdvisory[] = [];
    for (const advList of Object.values(data)) {
      if (Array.isArray(advList)) {
        advisories.push(...advList);
      }
    }
    return advisories;
  } catch {
    return [];
  }
}

async function fetchLatestVersions(
  names: string[],
): Promise<Record<string, NpmRegistryInfo | null>> {
  const results: Record<string, NpmRegistryInfo | null> = {};
  await Promise.all(names.map(async (name) => {
    try {
      const res = await fetch(
        `https://registry.npmjs.org/${encodeURIComponent(name)}/latest`,
        {
          signal: AbortSignal.timeout(NPM_REGISTRY_FETCH_TIMEOUT_MS),
        },
      );
      if (!res.ok) {
        results[name] = null;
        return;
      }
      const data = await res.json();
      results[name] = {
        version: data.version ?? "",
        description: data.description ?? "",
        deprecated: data.deprecated,
      };
    } catch {
      results[name] = null;
    }
  }));
  return results;
}

export function latestSatisfiesDeclaredRange(
  declaredRange: string,
  latestVersion: string,
): boolean {
  return sharedLatestSatisfiesDeclaredRange(declaredRange, latestVersion);
}

export async function auditPackages(
  packages: PackageInput[],
): Promise<PackageSecurityResult> {
  const issues: AuditIssue[] = [];

  if (packages.length === 0) {
    return {
      issues: [],
      summary: "No packages installed",
      score: 100,
      packageCount: 0,
      vulnerabilities: 0,
      outdated: 0,
      deprecated: 0,
    };
  }

  const parsed = packages.map((p) => ({
    name: parseNameFromSpecifier(p.specifier),
    version: parseVersionFromSpecifier(p.specifier),
    originalName: p.name,
    specifier: p.specifier,
  }));

  const withVersions = parsed.filter((p) => p.version !== null) as Array<{
    name: string;
    version: string;
    originalName: string;
    specifier: string;
  }>;

  const [advisories, latestVersions] = await Promise.all([
    fetchNpmAdvisories(withVersions),
    fetchLatestVersions(withVersions.map((p) => p.name)),
  ]);

  const seenAdvisories = new Set<number>();
  for (const advisory of advisories) {
    if (seenAdvisories.has(advisory.id)) continue;
    seenAdvisories.add(advisory.id);

    issues.push({
      severity: NPM_SEVERITY_MAP[advisory.severity] ?? "medium",
      rule: "known-vulnerability",
      message: `${advisory.title} (${advisory.module_name})`,
      entity: `package:${advisory.module_name}`,
      suggestion: advisory.recommendation ||
        `Update ${advisory.module_name} to a patched version`,
    });
  }

  for (const pkg of withVersions) {
    const latest = latestVersions[pkg.name];
    if (!latest) continue;

    if (latest.deprecated) {
      issues.push({
        severity: "high",
        rule: "deprecated-package",
        message: `${pkg.name} is deprecated: ${latest.deprecated}`,
        entity: `package:${pkg.name}`,
        suggestion: "Find an alternative package",
      });
    }

    const latestParsed = parseVersionParts(latest.version);
    if (
      !latestParsed || latestSatisfiesDeclaredRange(pkg.version, latest.version)
    ) {
      continue;
    }

    const current = parseVersionParts(pkg.version);
    if (!current) {
      issues.push({
        severity: "low",
        rule: "range-update-available",
        message:
          `${pkg.name}: ${pkg.version} → ${latest.version} (declared range no longer matches latest)`,
        entity: `package:${pkg.name}`,
        suggestion: `Review changelog before upgrading to ${latest.version}`,
      });
      continue;
    }

    if (latestParsed.major > current.major) {
      issues.push({
        severity: "medium",
        rule: "major-update-available",
        message:
          `${pkg.name}: ${pkg.version} → ${latest.version} (major version update, may contain breaking changes)`,
        entity: `package:${pkg.name}`,
        suggestion: `Review changelog before upgrading to ${latest.version}`,
      });
    } else if (latestParsed.minor > current.minor) {
      issues.push({
        severity: "low",
        rule: "minor-update-available",
        message:
          `${pkg.name}: ${pkg.version} → ${latest.version} (minor update available)`,
        entity: `package:${pkg.name}`,
        suggestion: `Update to ${latest.version} for new features and fixes`,
      });
    } else if (latestParsed.patch > current.patch) {
      issues.push({
        severity: "info",
        rule: "patch-update-available",
        message:
          `${pkg.name}: ${pkg.version} → ${latest.version} (patch update available)`,
        entity: `package:${pkg.name}`,
        suggestion: `Update to ${latest.version} for bug fixes`,
      });
    }
  }

  const vulnerabilities = advisories.length;
  const outdated = issues.filter((i) =>
    i.rule === "major-update-available" ||
    i.rule === "minor-update-available" ||
    i.rule === "patch-update-available" ||
    i.rule === "range-update-available"
  ).length;
  const deprecated =
    issues.filter((i) => i.rule === "deprecated-package").length;

  const score = computeAuditScore(issues);
  const summary = issues.length === 0
    ? "All packages are up to date and secure"
    : formatAuditSummary(issues);

  return {
    issues,
    summary,
    score,
    packageCount: packages.length,
    vulnerabilities,
    outdated,
    deprecated,
  };
}
