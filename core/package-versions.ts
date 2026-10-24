export interface VersionParts {
  major: number;
  minor: number;
  patch: number;
}

export function parseSpecifierRange(
  specifier: string,
  packageName: string,
): string | null {
  const withoutScheme = specifier.startsWith("npm:")
    ? specifier.slice("npm:".length)
    : specifier;
  if (!withoutScheme.startsWith(packageName)) return null;
  const rest = withoutScheme.slice(packageName.length);
  if (!rest.startsWith("@")) return null;
  const range = rest.slice(1).trim();
  return range.length > 0 ? range : null;
}

export function parseVersionParts(version: string): VersionParts | null {
  const cleaned = version.trim().replace(/^v/, "");
  const match = cleaned.match(/^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/);
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  };
}

export function compareVersions(a: VersionParts, b: VersionParts): number {
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  return a.patch - b.patch;
}

export function latestSatisfiesDeclaredRange(
  declaredRange: string | null,
  latestVersion: string,
): boolean {
  if (!declaredRange) return true;
  const range = declaredRange.trim();
  if (!range || range === "*" || range.toLowerCase() === "latest") return true;
  const latest = parseVersionParts(latestVersion);
  if (!latest) return true;

  const exact = parseVersionParts(range);
  if (exact) return compareVersions(latest, exact) <= 0;

  const major = range.match(/^(\d+)$/);
  if (major) return latest.major === Number(major[1]);

  const minor = range.match(/^(\d+)\.(\d+)$/);
  if (minor) {
    return latest.major === Number(minor[1]) &&
      latest.minor === Number(minor[2]);
  }

  const caret = range.match(/^\^(\d+)\.(\d+)\.(\d+)$/);
  if (caret) {
    const min = {
      major: Number(caret[1]),
      minor: Number(caret[2]),
      patch: Number(caret[3]),
    };
    if (compareVersions(latest, min) < 0) return false;
    if (min.major > 0) return latest.major === min.major;
    if (min.minor > 0) return latest.major === 0 && latest.minor === min.minor;
    return latest.major === 0 && latest.minor === 0 &&
      latest.patch === min.patch;
  }

  const tilde = range.match(/^~(\d+)\.(\d+)(?:\.(\d+))?$/);
  if (tilde) {
    const min = {
      major: Number(tilde[1]),
      minor: Number(tilde[2]),
      patch: Number(tilde[3] ?? "0"),
    };
    return compareVersions(latest, min) >= 0 &&
      latest.major === min.major &&
      latest.minor === min.minor;
  }

  return range === latestVersion;
}

export function isPackageOutdated(
  specifier: string,
  packageName: string,
  latestVersion: string,
): boolean {
  if (!latestVersion) return false;
  return !latestSatisfiesDeclaredRange(
    parseSpecifierRange(specifier, packageName),
    latestVersion,
  );
}
