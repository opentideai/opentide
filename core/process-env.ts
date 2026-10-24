// OpenTide's own env vars are OPENTIDE_*. The GENIE_* spelling they had before
// the rename is still read, so existing shells, units and .env files keep working.
const ENV_PREFIX = "OPENTIDE_";
const LEGACY_ENV_PREFIX = "GENIE_";

// Deno.env.get, plus the GENIE_* fallback for an OPENTIDE_* name. Any other
// name passes straight through.
export function readEnv(name: string): string | undefined {
  const value = Deno.env.get(name);
  if (value !== undefined || !name.startsWith(ENV_PREFIX)) return value;
  return Deno.env.get(LEGACY_ENV_PREFIX + name.slice(ENV_PREFIX.length));
}
