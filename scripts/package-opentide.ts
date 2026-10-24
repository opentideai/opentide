// Packages the public OpenTide tree (scripts/export-opentide.ts) as the release
// tarball install.sh downloads:
//
//   deno task package:opentide [--out <dir>]
//
// writes <out>/opentide-<version>.tar.gz and its .sha256 (default out: dist/).
// The tarball unpacks to opentide-<version>/ and holds exactly what the public
// repo does at the same commit. It is cut from HEAD, so commit first.
import { dirname, join, normalize } from "node:path";
import { OPENTIDE_VERSION } from "../core/config.ts";
import { warnIfDirty, writeOpenTree } from "./export-opentide.ts";

const REPO_ROOT = normalize(
  join(dirname(new URL(import.meta.url).pathname), ".."),
);
const DEFAULT_OUT_DIR = "dist";

export function tarballName(version: string = OPENTIDE_VERSION): string {
  return `opentide-${version}.tar.gz`;
}

async function run(command: string, args: string[]): Promise<void> {
  const out = await new Deno.Command(command, {
    args,
    stdout: "null",
    stderr: "piped",
  }).output();
  if (!out.success) {
    throw new Error(
      `${command} ${args.join(" ")} failed: ${
        new TextDecoder().decode(out.stderr)
      }`,
    );
  }
}

async function sha256Hex(path: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    await Deno.readFile(path),
  );
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export async function packageOpenTide(outDir: string): Promise<string> {
  const staging = await Deno.makeTempDir({ prefix: "opentide-package-" });
  try {
    const top = `opentide-${OPENTIDE_VERSION}`;
    await writeOpenTree(join(staging, top));
    await Deno.mkdir(outDir, { recursive: true });
    const name = tarballName();
    const tarball = join(outDir, name);
    await run("tar", ["-czf", tarball, "-C", staging, top]);
    await Deno.writeTextFile(
      `${tarball}.sha256`,
      `${await sha256Hex(tarball)}  ${name}\n`,
    );
    return tarball;
  } finally {
    await Deno.remove(staging, { recursive: true });
  }
}

function readOutDir(args: string[]): string {
  const i = args.indexOf("--out");
  const value = i >= 0 ? args[i + 1] : undefined;
  return value ?? join(REPO_ROOT, DEFAULT_OUT_DIR);
}

if (import.meta.main) {
  await warnIfDirty();
  const tarball = await packageOpenTide(readOutDir(Deno.args));
  console.log(`${tarball}\n${tarball}.sha256`);
}
