import { assert, assertEquals } from "@std/assert";
import { join } from "node:path";
import { OPENTIDE_VERSION } from "../core/config.ts";
import { packageOpenTide, tarballName } from "./package-opentide.ts";
import { EXTENSION_FILE } from "./claude-desktop-extension.ts";

async function tarList(tarball: string): Promise<string[]> {
  const out = await new Deno.Command("tar", {
    args: ["-tzf", tarball],
    stdout: "piped",
  }).output();
  return new TextDecoder().decode(out.stdout).split("\n").filter(Boolean);
}

// Packaging cuts from HEAD, so it needs a git checkout; the open-standalone
// gate runs the open tests in a plain copy.
const inGitCheckout = new Deno.Command("git", {
  args: ["rev-parse", "--is-inside-work-tree"],
  cwd: new URL(".", import.meta.url),
  stdout: "null",
  stderr: "null",
}).outputSync().success;

Deno.test({
  name:
    "packageOpenTide: the tarball is the open set under opentide-<version>/",
  ignore: !inGitCheckout,
}, async () => {
  const out = await Deno.makeTempDir({ prefix: "opentide-package-" });
  try {
    const { tarball, extension } = await packageOpenTide(out);
    assertEquals(extension, join(out, EXTENSION_FILE));
    assertEquals(tarball, join(out, tarballName()));
    const entries = await tarList(tarball);
    const prefix = `opentide-${OPENTIDE_VERSION}/`;
    assert(entries.every((e) => e.startsWith(prefix)));
    for (const path of ["install.sh", "deno.json", "deno.lock", "cli/cli.ts"]) {
      assert(entries.includes(prefix + path), `missing ${path}`);
    }
    for (const closed of ["agent/", "tide/", "auth/", "ide/", "desktop/"]) {
      assert(!entries.some((e) => e.startsWith(prefix + closed)), closed);
    }
    const [sum, name] = (await Deno.readTextFile(`${tarball}.sha256`)).trim()
      .split(/\s+/);
    assertEquals(name, tarballName());
    assertEquals(sum!.length, 64);
  } finally {
    await Deno.remove(out, { recursive: true });
  }
});
