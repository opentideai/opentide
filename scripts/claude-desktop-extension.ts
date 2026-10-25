// The Claude Desktop extension, opentide.mcpb: a zip of a generated manifest,
// the Node shim in claude-desktop/server/index.js and the icon. It bundles no
// runtime; the shim runs the installed `opentide mcp` on the project folder the
// user picks in the extension's settings.
//
// scripts/package-opentide.ts builds it next to the release tarball, from the
// exported tree, so it carries OPENTIDE_VERSION. In this repo the sources live
// under mirror/, which the export copies over the public root.
import { existsSync } from "node:fs";
import { dirname, join, normalize, resolve } from "node:path";
import { OPENTIDE_VERSION } from "../core/config.ts";

export const EXTENSION_DIR = "claude-desktop";
export const EXTENSION_FILE = "opentide.mcpb";
export const SHIM_PATH = "server/index.js";
export const ICON_PATH = "icon.png";
// The settings field Desktop shows; its value is the shim's argument.
export const PROJECT_FIELD = "project";

const MANIFEST_VERSION = "0.3";
const REPO_URL = "https://github.com/opentideai/opentide";

const REPO_ROOT = normalize(
  join(dirname(new URL(import.meta.url).pathname), ".."),
);

// mirror/claude-desktop here, claude-desktop at the root of the public tree.
export function extensionSourceDir(repoRoot = REPO_ROOT): string {
  const mirror = join(repoRoot, "mirror", EXTENSION_DIR);
  return existsSync(mirror) ? mirror : join(repoRoot, EXTENSION_DIR);
}

export function renderExtensionManifest(
  version: string = OPENTIDE_VERSION,
): string {
  return JSON.stringify(
    {
      manifest_version: MANIFEST_VERSION,
      name: "opentide",
      display_name: "OpenTide",
      version,
      description:
        "Build and change a running OpenTide app from Claude: every change goes through a verified, reversible changeset.",
      long_description:
        "Point it at a folder of OpenTide apps and Claude can create, open and change them: it opens a changeset, writes handlers, schemas and tests, and lands the change only once the checks pass. A change that doesn't land rolls back.\n\nNeeds OpenTide installed (`curl -fsSL https://github.com/opentideai/opentide/releases/latest/download/install.sh | sh`).",
      author: { name: "OpenTide", url: "https://github.com/opentideai" },
      homepage: REPO_URL,
      documentation: `${REPO_URL}/blob/main/docs/mcp-connect.md`,
      support: `${REPO_URL}/issues`,
      repository: { type: "git", url: REPO_URL },
      license: "Apache-2.0",
      keywords: ["opentide", "typescript", "deno", "verification", "changeset"],
      icon: ICON_PATH,
      server: {
        type: "node",
        entry_point: SHIM_PATH,
        mcp_config: {
          command: "node",
          args: [
            `\${__dirname}/${SHIM_PATH}`,
            `\${user_config.${PROJECT_FIELD}}`,
            // The shim reports it when it stands in for a missing install.
            version,
          ],
        },
      },
      tools_generated: true,
      prompts_generated: true,
      compatibility: {
        // install.sh is a POSIX shell script; there is no Windows install.
        platforms: ["darwin", "linux"],
        runtimes: { node: ">=18.0.0" },
      },
      user_config: {
        [PROJECT_FIELD]: {
          type: "directory",
          title: "Apps folder",
          description:
            "Where your OpenTide apps live, say ~/apps. Claude lists, opens and creates apps there. One app's own folder works too.",
          required: true,
        },
      },
    },
    null,
    2,
  ) + "\n";
}

// Writes <outDir>/opentide.mcpb from the sources in sourceDir.
export async function buildExtension(
  sourceDir: string,
  outDir: string,
): Promise<string> {
  const staging = await Deno.makeTempDir({ prefix: "opentide-mcpb-" });
  try {
    await Deno.writeTextFile(
      join(staging, "manifest.json"),
      renderExtensionManifest(),
    );
    for (const path of [SHIM_PATH, ICON_PATH]) {
      await Deno.mkdir(dirname(join(staging, path)), { recursive: true });
      await Deno.copyFile(join(sourceDir, path), join(staging, path));
    }
    await Deno.mkdir(outDir, { recursive: true });
    const target = join(resolve(outDir), EXTENSION_FILE);
    await Deno.remove(target).catch((err) => {
      if (!(err instanceof Deno.errors.NotFound)) throw err;
    });
    const out = await new Deno.Command("zip", {
      args: ["-X", "-q", "-r", target, "manifest.json", SHIM_PATH, ICON_PATH],
      cwd: staging,
      stderr: "piped",
    }).output();
    if (!out.success) {
      throw new Error(
        `zip failed: ${new TextDecoder().decode(out.stderr)}`,
      );
    }
    return target;
  } finally {
    await Deno.remove(staging, { recursive: true });
  }
}
