import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// A real (symlink-free) temp root for tests that compare resolved paths:
// macOS's /tmp and $TMPDIR are symlinks into /private, Linux's /tmp is not.
export const TEST_TMP_DIR = Deno.build.os === "darwin"
  ? "/private/tmp"
  : "/tmp";

// Call once at the top of a test file that creates, opens or registers
// projects, or spawns opentide. Every test in that file then runs under a
// temp HOME, so the registry, ~/.config/opentide and backups are throwaway and
// the developer's real projects are never listed, migrated or written.
//
// HOME also locates caches and the git identity, so those are pinned to where
// they already were: the Deno module cache (a child `deno` would otherwise
// re-download everything), Playwright's browsers, and ~/.gitconfig (or a
// scaffold's first commit fails for want of user.name).
//
// `config` seeds ~/.config/opentide/config.json — a file whose tests only pass
// with a provider key configured passes a dummy one here instead of relying on
// the developer's real key.
export function isolateHome(config?: Record<string, unknown>): void {
  const pinned = ["HOME", "DENO_DIR", "PLAYWRIGHT_BROWSERS_PATH"] as const;
  const saved = new Map<string, string | undefined>();
  let tempHome: string | null = null;

  Deno.test.beforeAll(async () => {
    for (const name of [...pinned, "GIT_CONFIG_GLOBAL"]) {
      saved.set(name, Deno.env.get(name));
    }
    const realHome = Deno.env.get("HOME");
    Deno.env.set("DENO_DIR", Deno.env.get("DENO_DIR") ?? await denoDir());
    if (realHome) pinPlaywright(realHome);
    if (realHome && !Deno.env.get("GIT_CONFIG_GLOBAL")) {
      const gitconfig = join(realHome, ".gitconfig");
      if (existsSync(gitconfig)) Deno.env.set("GIT_CONFIG_GLOBAL", gitconfig);
    }
    tempHome = await Deno.makeTempDir({ prefix: "opentide-test-home-" });
    Deno.env.set("HOME", tempHome);
    if (config) {
      const dir = join(tempHome, ".config", "opentide");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "config.json"), JSON.stringify(config));
    }
  });

  Deno.test.afterAll(async () => {
    for (const [name, value] of saved) {
      if (value === undefined) Deno.env.delete(name);
      else Deno.env.set(name, value);
    }
    if (tempHome) await Deno.remove(tempHome, { recursive: true });
  });
}

async function denoDir(): Promise<string> {
  const out = await new Deno.Command(Deno.execPath(), {
    args: ["info", "--json"],
    stdout: "piped",
    stderr: "null",
  }).output();
  return (JSON.parse(new TextDecoder().decode(out.stdout)) as {
    denoDir: string;
  }).denoDir;
}

function pinPlaywright(realHome: string): void {
  if (Deno.env.get("PLAYWRIGHT_BROWSERS_PATH")) return;
  const cache = Deno.build.os === "darwin"
    ? join(realHome, "Library", "Caches", "ms-playwright")
    : join(realHome, ".cache", "ms-playwright");
  if (existsSync(cache)) Deno.env.set("PLAYWRIGHT_BROWSERS_PATH", cache);
}
