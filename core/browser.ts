// deno-lint-ignore-file no-explicit-any -- Playwright is an OPTIONAL dependency,
// loaded through a dynamic `import("playwright")` that is allowed to fail (see
// getBrowser below) and deliberately absent from the import map. With no types
// installed there is nothing to annotate against, and hand-rolled stubs for the
// dozen page/browser methods used here would drift from the real API and give false
// confidence. `any` at this boundary is the considered choice, not an oversight.

import { readEnv } from "./process-env.ts";
import { errorMessage } from "./util.ts";
import { appPreviewUrl, getKernelSettings } from "./config.ts";

const BROWSER_INSTALL_COMMAND = "deno task browser:install";
const BROWSER_CHECK_COMMAND = "deno task browser:check";

// A box may not be able to run Playwright's bundled Chromium (e.g. an OS
// Playwright ships no build for). Setting OPENTIDE_BROWSER_CHANNEL points launch at
// a system-installed browser channel ("chrome"/"msedge") that's managed outside
// Playwright (apt, etc.) instead. Unset everywhere else, so bundled-Chromium
// behaviour is unchanged. --no-sandbox is paired with it because headless Chrome
// under a user systemd service commonly can't open its sandbox; the channel is
// only ever set on exactly such a server.
export function systemBrowserChannel(
  raw: string | undefined = readEnv("OPENTIDE_BROWSER_CHANNEL") ?? undefined,
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

    const hasDisplay = !!(
      Deno.env.get("DISPLAY") ||
      Deno.env.get("WAYLAND_DISPLAY") ||
      Deno.build.os === "darwin" ||
      Deno.build.os === "windows"
    );

    const strategies: Array<Record<string, unknown>> = [];
    if (hasDisplay) strategies.push(browserLaunchOptions(false));
    strategies.push(browserLaunchOptions(true));

    const launchErrors: string[] = [];

    for (const opts of strategies) {
      try {
        const browser = await pw.chromium.launch(opts);
        const mode = opts.headless ? "headless" as const : "headful" as const;
        instance = { browser, mode };
        return instance;
      } catch (err) {
        launchErrors.push(`${JSON.stringify(opts)}: ${errorMessage(err)}`);
      }
    }

    throw new Error(
      "Playwright loaded, but its pinned Chromium browser could not launch. " +
        `Run ${BROWSER_INSTALL_COMMAND} as the service user that runs Tide, then ` +
        `verify with ${BROWSER_CHECK_COMMAND}. On Linux, the install task also asks ` +
        "Playwright to install required system packages with --with-deps. " +
        "If this is a systemd service, ensure HOME points at the service user's home " +
        "so ~/.cache/ms-playwright is owned by that user. Launch attempts:\n" +
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
