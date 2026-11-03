import { assert, assertEquals } from "@std/assert";
import {
  browserCheckResult,
  playwrightInstallArgs,
} from "./browser-support.ts";
import {
  browserHeadful,
  browserLaunchOptions,
  browserLaunchStrategies,
  browserToolTimeouts,
  systemBrowserChannel,
} from "../core/browser.ts";

Deno.test("playwrightInstallArgs installs Chromium with Linux system dependencies", () => {
  assertEquals(playwrightInstallArgs("linux"), [
    "run",
    "--allow-all",
    "npm:playwright@1",
    "install",
    "--with-deps",
    "chromium",
  ]);
});

Deno.test("playwrightInstallArgs installs only Chromium off Linux", () => {
  assertEquals(playwrightInstallArgs("darwin"), [
    "run",
    "--allow-all",
    "npm:playwright@1",
    "install",
    "chromium",
  ]);
});

Deno.test("browserCheckResult passes with an available browser", () => {
  const result = browserCheckResult({ available: true, mode: "headless" });
  assertEquals(result.ok, true);
  assert(result.message.includes("headless"));
});

Deno.test("browserCheckResult fails loudly with install guidance", () => {
  const result = browserCheckResult({
    available: false,
    error: "No browser found",
  });
  assertEquals(result.ok, false);
  assert(result.message.includes("No browser found"));
  assert(result.message.includes("deno task browser:install"));
});

Deno.test("systemBrowserChannel trims, treats blank as unset", () => {
  assertEquals(systemBrowserChannel("chrome"), "chrome");
  assertEquals(systemBrowserChannel("  chrome  "), "chrome");
  assertEquals(systemBrowserChannel(""), undefined);
  assertEquals(systemBrowserChannel("   "), undefined);
  assertEquals(systemBrowserChannel(undefined), undefined);
});

Deno.test("browserLaunchOptions: bundled Chromium unless a channel is set", () => {
  // No channel → today's behavior: just the headless flag, no channel/args.
  assertEquals(browserLaunchOptions(true, undefined), { headless: true });
  assertEquals(browserLaunchOptions(false, undefined), { headless: false });

  // Channel set → drive the system browser, with --no-sandbox for server Chrome.
  assertEquals(browserLaunchOptions(true, "chrome"), {
    headless: true,
    channel: "chrome",
    args: ["--no-sandbox"],
  });
});

Deno.test("browserLaunchStrategies: headless Chromium, Chrome, Edge, distro Chromium, then Firefox", () => {
  const c = (options: Record<string, unknown>) => ({
    engine: "chromium",
    options,
  });
  assertEquals(browserLaunchStrategies(undefined, false, []), [
    c({ headless: true }),
    c({ headless: true, channel: "chrome" }),
    c({ headless: true, channel: "msedge" }),
    { engine: "firefox", options: { headless: true } },
  ]);
  // A distro Chromium that exists is tried after Chrome and Edge.
  assertEquals(
    browserLaunchStrategies(undefined, false, ["/usr/bin/chromium"])[3],
    c({ headless: true, executablePath: "/usr/bin/chromium" }),
  );
  // Asked to watch: headful first, headless as the fallback.
  assertEquals(browserLaunchStrategies(undefined, true, []).slice(0, 2), [
    c({ headless: false }),
    c({ headless: true }),
  ]);
  // A configured channel is the only thing tried.
  assertEquals(browserLaunchStrategies("chrome", false, []), [
    c({ headless: true, channel: "chrome", args: ["--no-sandbox"] }),
  ]);
});

Deno.test("browserHeadful: only when asked, and only with a display", () => {
  assertEquals(browserHeadful(undefined, true), false);
  assertEquals(browserHeadful("1", true), true);
  assertEquals(browserHeadful("true", true), true);
  assertEquals(browserHeadful("0", true), false);
  assertEquals(browserHeadful("false", true), false);
  assertEquals(browserHeadful("1", false), false);
});

Deno.test("browserToolTimeouts maps kernel settings to navigation and action waits", () => {
  assertEquals(
    browserToolTimeouts({
      testTimeoutMs: 60_000,
      browserActionTimeoutMs: 10_000,
    }),
    { navigationTimeoutMs: 60_000, actionTimeoutMs: 10_000 },
  );
});
