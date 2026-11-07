import { assert, assertEquals } from "@std/assert";
import { join } from "node:path";
import { OPENTIDE_VERSION } from "../core/config.ts";
import {
  packageOpenTide,
  RUNNER_BUNDLE_PATH,
  tarballName,
} from "./package-opentide.ts";
import { EXTENSION_FILE } from "./claude-desktop-extension.ts";

async function tarList(tarball: string): Promise<string[]> {
  const out = await new Deno.Command("tar", {
    args: ["-tzf", tarball],
    stdout: "piped",
  }).output();
  return new TextDecoder().decode(out.stdout).split("\n").filter(Boolean);
}

async function trackedFiles(): Promise<string[]> {
  const out = await new Deno.Command("git", {
    args: ["ls-tree", "-r", "--name-only", "HEAD"],
    cwd: new URL("..", import.meta.url),
    stdout: "piped",
  }).output();
  return new TextDecoder().decode(out.stdout).split("\n").filter(Boolean)
    .sort();
}

// Packaging cuts from HEAD, so it needs a git checkout; an unpacked release
// tarball has none.
const inGitCheckout = new Deno.Command("git", {
  args: ["rev-parse", "--is-inside-work-tree"],
  cwd: new URL(".", import.meta.url),
  stdout: "null",
  stderr: "null",
}).outputSync().success;

Deno.test({
  name:
    "packageOpenTide: the tarball is HEAD's tracked files and the runner bundle under opentide-<version>/",
  ignore: !inGitCheckout,
}, async () => {
  const out = await Deno.makeTempDir({ prefix: "opentide-package-" });
  try {
    const { tarball, extension } = await packageOpenTide(out);
    assertEquals(extension, join(out, EXTENSION_FILE));
    assertEquals(tarball, join(out, tarballName()));
    const prefix = `opentide-${OPENTIDE_VERSION}/`;
    const entries = await tarList(tarball);
    assert(entries.every((e) => e.startsWith(prefix)));
    const files = entries.filter((e) => !e.endsWith("/"))
      .map((e) => e.slice(prefix.length)).sort();
    assertEquals(files, [...await trackedFiles(), RUNNER_BUNDLE_PATH].sort());
    const [sum, name] = (await Deno.readTextFile(`${tarball}.sha256`)).trim()
      .split(/\s+/);
    assertEquals(name, tarballName());
    assertEquals(sum!.length, 64);
  } finally {
    await Deno.remove(out, { recursive: true });
  }
});
