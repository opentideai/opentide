// Run one shard of the test suite, so CI can spread it over parallel jobs.
//
//   deno task test:shard <index> <count>      (index is 1-based)
//
// Files go to shards by how long they took (scripts/test-timings.json, seconds
// per file from a CI run): longest first, each to the shard with the least time
// so far. A file with no recorded time counts as the median. Every test file
// lands in exactly one shard, so the shards together run what `deno task test`
// runs.
//
// To refresh the timings, rerun a full `deno task test` with timestamps (a CI
// log has them) and record, per file, the gap between its "running N tests
// from" line and the next one.
import { join, relative } from "node:path";

const TEST_FILE = /(^|[_.])test\.(ts|tsx|mts|js|mjs|jsx)$/;
const SKIPPED_DIRS = new Set([".git", "node_modules", "dist"]);
const TIMINGS_FILE = "scripts/test-timings.json";
// The permissions `deno task test` runs with.
const TEST_PERMISSIONS = [
  "--allow-net",
  "--allow-read",
  "--allow-write",
  "--allow-env",
  "--allow-ffi",
  "--allow-run",
  "--allow-sys",
];

// deno.json's top-level `exclude`, which `deno test` also skips.
function configExcludes(root: string): string[] {
  try {
    const config = JSON.parse(Deno.readTextFileSync(join(root, "deno.json")));
    return Array.isArray(config.exclude) ? config.exclude : [];
  } catch {
    return [];
  }
}

// Every test file under `root`, relative and sorted.
export function listTestFiles(root: string): string[] {
  const excluded = configExcludes(root).map((p) => p.replace(/\/$/, ""));
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const entry of Deno.readDirSync(dir)) {
      const path = join(dir, entry.name);
      const rel = relative(root, path);
      if (excluded.some((e) => rel === e || rel.startsWith(`${e}/`))) continue;
      if (entry.isDirectory && !SKIPPED_DIRS.has(entry.name)) walk(path);
      else if (entry.isFile && TEST_FILE.test(entry.name)) files.push(rel);
    }
  };
  walk(root);
  return files.sort();
}

function median(values: number[]): number {
  if (values.length === 0) return 1;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)]!;
}

// Split `files` into `count` shards of roughly equal recorded time.
export function assignShards(
  files: string[],
  timings: Record<string, number>,
  count: number,
): string[][] {
  const fallback = median(Object.values(timings));
  const weight = (f: string) => timings[f] ?? fallback;
  const shards = Array.from({ length: count }, () => ({
    files: [] as string[],
    total: 0,
  }));
  const ordered = [...files].sort((a, b) =>
    weight(b) - weight(a) || a.localeCompare(b)
  );
  for (const file of ordered) {
    const lightest = shards.reduce((min, s) => s.total < min.total ? s : min);
    lightest.files.push(file);
    lightest.total += weight(file);
  }
  return shards.map((s) => s.files.sort());
}

function readTimings(root: string): Record<string, number> {
  try {
    return JSON.parse(Deno.readTextFileSync(join(root, TIMINGS_FILE)));
  } catch {
    return {};
  }
}

if (import.meta.main) {
  const [index, count] = Deno.args.map(Number);
  if (!index || !count || index < 1 || index > count) {
    console.error("usage: deno task test:shard <index> <count>  (1-based)");
    Deno.exit(2);
  }
  const root = Deno.cwd();
  const files = listTestFiles(root);
  const shard = assignShards(files, readTimings(root), count)[index - 1]!;
  console.error(
    `Shard ${index}/${count}: ${shard.length} of ${files.length} test files.`,
  );
  const { code } = await new Deno.Command(Deno.execPath(), {
    args: ["test", ...TEST_PERMISSIONS, ...shard],
    stdout: "inherit",
    stderr: "inherit",
  }).output();
  Deno.exit(code);
}
