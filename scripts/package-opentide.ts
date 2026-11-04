// Packages the repo at HEAD as the release tarball install.sh downloads:
//
//   deno task package:opentide [--out <dir>]
//
// writes <out>/opentide-<version>.tar.gz and its .sha256, and the Claude Desktop
// extension <out>/opentide.mcpb (default out: dist/).
// The tarball unpacks to opentide-<version>/ and holds exactly the files git
// tracks at HEAD, so commit first.
import { dirname, join, normalize } from "node:path";
import { OPENTIDE_VERSION } from "../core/config.ts";
import { buildExtension, EXTENSION_DIR } from "./claude-desktop-extension.ts";

const REPO_ROOT = normalize(
  join(dirname(new URL(import.meta.url).pathname), ".."),
);
const DEFAULT_OUT_DIR = "dist";

export function tarballName(version: string = OPENTIDE_VERSION): string {
  return `opentide-${version}.tar.gz`;
}

async function run(command: string, args: string[]): Promise<string> {
  const out = await new Deno.Command(command, {
    args,
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (!out.success) {
    throw new Error(
      `${command} ${args.join(" ")} failed: ${
        new TextDecoder().decode(out.stderr)
      }`,
    );
  }
  return new TextDecoder().decode(out.stdout);
}

// HEAD's tracked files, unpacked into dest.
async function writeHeadTree(dest: string, top: string): Promise<void> {
  const archive = join(dest, `${top}.tar`);
  await run("git", [
    "-C",
    REPO_ROOT,
    "archive",
    `--prefix=${top}/`,
    `--output=${archive}`,
    "HEAD",
  ]);
  await run("tar", ["-xf", archive, "-C", dest]);
  await Deno.remove(archive);
}

async function warnIfDirty(): Promise<void> {
  const dirty = (await run("git", ["-C", REPO_ROOT, "status", "--porcelain"]))
    .trim();
  if (dirty) {
    console.warn(`Uncommitted changes are NOT packaged (HEAD is):\n${dirty}\n`);
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

export interface ReleaseFiles {
  tarball: string;
  extension: string;
}

export async function packageOpenTide(outDir: string): Promise<ReleaseFiles> {
  const staging = await Deno.makeTempDir({ prefix: "opentide-package-" });
  try {
    const top = `opentide-${OPENTIDE_VERSION}`;
    await writeHeadTree(staging, top);
    await Deno.mkdir(outDir, { recursive: true });
    const name = tarballName();
    const tarball = join(outDir, name);
    await run("tar", ["-czf", tarball, "-C", staging, top]);
    await Deno.writeTextFile(
      `${tarball}.sha256`,
      `${await sha256Hex(tarball)}  ${name}\n`,
    );
    const extension = await buildExtension(
      join(staging, top, EXTENSION_DIR),
      outDir,
    );
    return { tarball, extension };
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
  const { tarball, extension } = await packageOpenTide(readOutDir(Deno.args));
  console.log(`${tarball}\n${tarball}.sha256\n${extension}`);
}
