import { browserStatus, systemBrowserChannel } from "../core/browser.ts";

export type BrowserSupportCommand = "install" | "check";

export interface BrowserStatusResult {
  available: boolean;
  mode?: string;
  error?: string;
}

export function playwrightInstallArgs(
  os: typeof Deno.build.os = Deno.build.os,
): string[] {
  const args = [
    "run",
    "--allow-all",
    "npm:playwright@1",
    "install",
  ];
  if (os === "linux") args.push("--with-deps");
  args.push("chromium");
  return args;
}

export function browserCheckResult(status: BrowserStatusResult): {
  ok: boolean;
  message: string;
} {
  if (status.available) {
    return {
      ok: true,
      message: `Browser available (${status.mode ?? "unknown"}).`,
    };
  }
  return {
    ok: false,
    message: `Browser unavailable: ${status.error ?? "unknown error"}\n\n` +
      "Install Chromium with: deno task browser:install",
  };
}

export async function installBrowser(): Promise<number> {
  // With a system browser channel (OPENTIDE_BROWSER_CHANNEL), the browser is managed
  // outside Playwright — apt-installed Chrome, etc. — so there's nothing to
  // download or install here. Exit 0 so the deploy chain proceeds on boxes with
  // no Playwright-bundled Chromium build; the actual launch is verified by the
  // `browser:check` step that follows (it has the --allow-write a launch needs;
  // this task deliberately does not).
  const channel = systemBrowserChannel();
  if (channel) {
    console.log(
      `OPENTIDE_BROWSER_CHANNEL=${channel} — using a system-managed browser; ` +
        "nothing to download. Verify with: deno task browser:check",
    );
    return 0;
  }
  const command = new Deno.Command(Deno.execPath(), {
    args: playwrightInstallArgs(),
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  const status = await command.spawn().status;
  return status.code;
}

export async function checkBrowser(
  readStatus: () => Promise<BrowserStatusResult> = browserStatus,
): Promise<number> {
  const result = browserCheckResult(await readStatus());
  const output = result.ok ? console.log : console.error;
  output(result.message);
  return result.ok ? 0 : 1;
}

function usage(): string {
  return "Usage: deno run --allow-run --allow-read --allow-write --allow-env --allow-sys scripts/browser-support.ts <install|check>";
}

export async function main(args: string[] = Deno.args): Promise<number> {
  const command = args[0] as BrowserSupportCommand | undefined;
  if (command === "install") return await installBrowser();
  if (command === "check") return await checkBrowser();
  console.error(usage());
  return 2;
}

if (import.meta.main) {
  Deno.exit(await main());
}
