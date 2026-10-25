// deno-lint-ignore-file no-explicit-any -- Playwright is an OPTIONAL dependency,
// loaded through a dynamic `import("playwright")` that is allowed to fail (see
// getBrowser below) and deliberately absent from the import map. With no types
// installed there is nothing to annotate against, and hand-rolled stubs for the
// dozen page/browser methods used here would drift from the real API and give false
// confidence. `any` at this boundary is the considered choice, not an oversight.

import { existsSync } from "node:fs";
import { readEnv } from "./process-env.ts";
import { errorMessage } from "./util.ts";
import { appPreviewUrl, getKernelSettings } from "./config.ts";

const BROWSER_INSTALL_COMMAND = "deno task browser:install";
// The same install, for an OpenTide install, which has no repo tasks.
const PLAYWRIGHT_INSTALL_COMMAND =
  "deno run -A npm:playwright@1 install chromium";
const BROWSER_CHANNEL_ENV = "OPENTIDE_BROWSER_CHANNEL";
const BROWSER_HEADFUL_ENV = "OPENTIDE_BROWSER_HEADFUL";
// Browsers Playwright can drive without downloading one, tried in order when
// its own Chromium isn't there.
export const SYSTEM_BROWSER_FALLBACKS = ["chrome", "msedge"] as const;

// A box may not be able to run Playwright's bundled Chromium (e.g. an OS
// Playwright ships no build for). Setting OPENTIDE_BROWSER_CHANNEL points launch at
// a system-installed browser channel ("chrome"/"msedge") that's managed outside
// Playwright (apt, etc.) instead. Unset everywhere else, so bundled-Chromium
// behaviour is unchanged. --no-sandbox is paired with it because headless Chrome
// under a user systemd service commonly can't open its sandbox; the channel is
// only ever set on exactly such a server.
export function systemBrowserChannel(
  raw: string | undefined = readEnv(BROWSER_CHANNEL_ENV) ?? undefined,
): string | undefined {
  const trimmed = raw?.trim();
  return trimmed ? trimmed : undefined;
}

export function browserLaunchOptions(
  headless: boolean,
  channel = systemBrowserChannel(),
): Record<string, unknown> {
  return channel ? { headless, channel, args: ["--no-sandbox"] } : { headless };
}

function hasDisplay(): boolean {
  return !!(
    Deno.env.get("DISPLAY") ||
    Deno.env.get("WAYLAND_DISPLAY") ||
    Deno.build.os === "darwin" ||
    Deno.build.os === "windows"
  );
}

// A window popping up on the user's screen mid-session is a surprise, so the
// browser runs headless unless OPENTIDE_BROWSER_HEADFUL asks to watch it.
export function browserHeadful(
  raw: string | undefined = readEnv(BROWSER_HEADFUL_ENV) ?? undefined,
  display: boolean = hasDisplay(),
): boolean {
  return display && !!raw && raw !== "0" && raw.toLowerCase() !== "false";
}

// Distro Chromium builds, which Playwright can drive by path when its own
// Chromium and Chrome aren't there (common on Linux servers).
export const SYSTEM_CHROMIUM_PATHS = [
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/snap/bin/chromium",
] as const;

export interface BrowserLaunchStrategy {
  // Playwright's Firefox is its own patched build; a stock Firefox can't be
  // driven, so Firefox is only ever Playwright's download.
  engine: "chromium" | "firefox";
  options: Record<string, unknown>;
}

// What getBrowser tries, in order. A configured channel is all it tries.
// Otherwise Playwright's own Chromium, an installed Chrome or Edge, a distro
// Chromium, and last Playwright's Firefox, so a machine that never ran the
// Playwright install still gets screenshots if it has any of them.
export function browserLaunchStrategies(
  channel: string | undefined = systemBrowserChannel(),
  headful: boolean = browserHeadful(),
  chromiumPaths: readonly string[] = SYSTEM_CHROMIUM_PATHS.filter((p) =>
    existsSync(p)
  ),
): BrowserLaunchStrategy[] {
  const modes = headful ? [false, true] : [true];
  const chromium = (options: Record<string, unknown>) => ({
    engine: "chromium" as const,
    options,
  });
  if (channel) {
    return modes.map((h) => chromium(browserLaunchOptions(h, channel)));
  }
  return [
    ...modes.map((h) => chromium(browserLaunchOptions(h, undefined))),
    ...SYSTEM_BROWSER_FALLBACKS.map((fallback) =>
      chromium({ headless: !headful, channel: fallback })
    ),
    ...chromiumPaths.map((executablePath) =>
      chromium({ headless: !headful, executablePath })
    ),
    { engine: "firefox", options: { headless: !headful } },
  ];
}

export function browserToolTimeouts(
  settings: Pick<
    ReturnType<typeof getKernelSettings>,
    "testTimeoutMs" | "browserActionTimeoutMs"
  > = getKernelSettings(),
): { navigationTimeoutMs: number; actionTimeoutMs: number } {
  return {
    navigationTimeoutMs: settings.testTimeoutMs,
    actionTimeoutMs: settings.browserActionTimeoutMs,
  };
}

interface BrowserInstance {
  browser: any;
  mode: "headful" | "headless";
}

let instance: BrowserInstance | null = null;
let initPromise: Promise<BrowserInstance> | null = null;

async function getBrowser(): Promise<BrowserInstance> {
  if (instance) {
    try {
      if (!instance.browser.isConnected()) {
        instance = null;
        initPromise = null;
      } else {
        return instance;
      }
    } catch {
      instance = null;
      initPromise = null;
    }
  }
  if (initPromise) return initPromise;

  initPromise = (async () => {
    let pw: any;
    let playwrightImportError = "";
    try {
      pw = await import("playwright");
    } catch (err) {
      playwrightImportError = errorMessage(err);
      throw new Error(
        "Playwright could not be loaded from Deno npm dependencies. " +
          "Run from the repo root with Deno available, then retry. " +
          `If dependencies need warming, run: deno cache --lock=deno.lock core/browser.ts. ` +
          `After Playwright loads, install Chromium with: ${BROWSER_INSTALL_COMMAND}. ` +
          `Original error: ${playwrightImportError}`,
      );
    }

    const strategies = browserLaunchStrategies();

    const launchErrors: string[] = [];

    for (const { engine, options } of strategies) {
      try {
        const browser = await pw[engine].launch(options);
        const mode = options.headless
          ? "headless" as const
          : "headful" as const;
        instance = { browser, mode };
        return instance;
      } catch (err) {
        launchErrors.push(
          `${engine} ${JSON.stringify(options)}: ${errorMessage(err)}`,
        );
      }
    }

    throw new Error(
      "No browser could launch for screenshots. Install Google Chrome, or " +
        `Playwright's Chromium with \`${PLAYWRIGHT_INSTALL_COMMAND}\` ` +
        `(\`${BROWSER_INSTALL_COMMAND}\` in a source checkout). On a server, run ` +
        "it as the service user, with HOME set to that user's home, so " +
        "~/.cache/ms-playwright belongs to it; on Linux add --with-deps. " +
        "Launch attempts:\n" +
        launchErrors.join("\n"),
    );
  })();

  try {
    return await initPromise;
  } catch (err) {
    initPromise = null;
    throw err;
  }
}

export async function closeBrowser(): Promise<void> {
  if (instance) {
    try {
      await instance.browser.close();
    } catch { /* ignore */ }
    instance = null;
    initPromise = null;
  }
}

export async function browserStatus(): Promise<{
  available: boolean;
  mode?: string;
  error?: string;
}> {
  try {
    const { mode } = await getBrowser();
    return { available: true, mode };
  } catch (err) {
    return { available: false, error: errorMessage(err) };
  }
}

export async function screenshotApp(
  appPort: number,
  path = "/",
  opts?: {
    selector?: string;
    width?: number;
    height?: number;
    fullPage?: boolean;
  },
): Promise<{
  png: Uint8Array;
  title: string;
  url: string;
  mode: string;
  consoleMessages: string[];
  pageErrors: string[];
}> {
  const { browser, mode } = await getBrowser();
  const page = await browser.newPage({
    viewport: {
      width: opts?.width ?? 1280,
      height: opts?.height ?? 720,
    },
  });

  const consoleMessages: string[] = [];
  const pageErrors: string[] = [];
  page.on(
    "console",
    (msg: any) => consoleMessages.push(`[${msg.type()}] ${msg.text()}`),
  );
  page.on("pageerror", (err: any) => pageErrors.push(errorMessage(err)));

  const url = appPreviewUrl(appPort, path);
  const timeouts = browserToolTimeouts();

  try {
    await page.goto(url, {
      waitUntil: "networkidle",
      timeout: timeouts.navigationTimeoutMs,
    });

    if (opts?.selector) {
      await page.waitForSelector(opts.selector, {
        timeout: timeouts.actionTimeoutMs,
      });
    }

    const title = await page.title();
    const png = await page.screenshot({
      fullPage: opts?.fullPage ?? false,
      type: "png",
    });

    return {
      png: new Uint8Array(png),
      title,
      url,
      mode,
      consoleMessages,
      pageErrors,
    };
  } finally {
    await page.close();
  }
}

export interface TestStep {
  action:
    | "click"
    | "fill"
    | "select"
    | "wait"
    | "screenshot"
    | "assert_text"
    | "assert_visible"
    | "navigate";
  selector?: string;
  value?: string;
  path?: string;
}

export interface StepResult {
  step: number;
  action: string;
  ok: boolean;
  error?: string;
  screenshotPng?: Uint8Array;
}

export async function testApp(
  appPort: number,
  path: string,
  steps: TestStep[],
  opts?: { width?: number; height?: number },
): Promise<{
  results: StepResult[];
  finalPng: Uint8Array;
  title: string;
  url: string;
  mode: string;
  consoleMessages: string[];
  pageErrors: string[];
  allPassed: boolean;
}> {
  const { browser, mode } = await getBrowser();
  const page = await browser.newPage({
    viewport: {
      width: opts?.width ?? 1280,
      height: opts?.height ?? 720,
    },
  });

  const consoleMessages: string[] = [];
  const pageErrors: string[] = [];
  page.on(
    "console",
    (msg: any) => consoleMessages.push(`[${msg.type()}] ${msg.text()}`),
  );
  page.on("pageerror", (err: any) => pageErrors.push(errorMessage(err)));

  const url = appPreviewUrl(appPort, path);
  const results: StepResult[] = [];
  const timeouts = browserToolTimeouts();

  try {
    await page.goto(url, {
      waitUntil: "networkidle",
      timeout: timeouts.navigationTimeoutMs,
    });

    for (let i = 0; i < steps.length; i++) {
      const step = steps[i]!;
      const result: StepResult = { step: i, action: step.action, ok: true };

      try {
        switch (step.action) {
          case "click":
            await page.click(step.selector!, {
              timeout: timeouts.actionTimeoutMs,
            });
            break;
          case "fill":
            await page.fill(step.selector!, step.value ?? "", {
              timeout: timeouts.actionTimeoutMs,
            });
            break;
          case "select":
            await page.selectOption(step.selector!, step.value ?? "", {
              timeout: timeouts.actionTimeoutMs,
            });
            break;
          case "wait":
            await page.waitForSelector(step.selector!, {
              timeout: timeouts.actionTimeoutMs,
            });
            break;
          case "navigate": {
            const navUrl = appPreviewUrl(appPort, step.path ?? "/");
            await page.goto(navUrl, {
              waitUntil: "networkidle",
              timeout: timeouts.navigationTimeoutMs,
            });
            break;
          }
          case "screenshot":
            result.screenshotPng = new Uint8Array(
              await page.screenshot({ type: "png" }),
            );
            break;
          case "assert_text": {
            const el = await page.waitForSelector(step.selector!, {
              timeout: timeouts.actionTimeoutMs,
            });
            const text = await el.textContent();
            if (!text?.includes(step.value ?? "")) {
              throw new Error(
                `Expected text "${step.value}" in "${step.selector}" but got "${text}"`,
              );
            }
            break;
          }
          case "assert_visible":
            await page.waitForSelector(step.selector!, {
              state: "visible",
              timeout: timeouts.actionTimeoutMs,
            });
            break;
        }
      } catch (err) {
        result.ok = false;
        result.error = errorMessage(err);
      }

      results.push(result);
      if (!result.ok) break;
    }

    const title = await page.title();
    const finalPng = new Uint8Array(await page.screenshot({ type: "png" }));
    const allPassed = results.every((r) => r.ok) && pageErrors.length === 0;

    return {
      results,
      finalPng,
      title,
      url,
      mode,
      consoleMessages,
      pageErrors,
      allPassed,
    };
  } finally {
    await page.close();
  }
}
