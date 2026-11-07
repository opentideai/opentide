// @layer core — runs one user test against the test timeout.
//
// When the timeout or a cancellation wins, the test may still be running. The
// runtime is told, so a user-code runner is killed instead of left running it
// (core/runner/runner-adapter.ts); in-process there's nothing to stop.

import { formatKernelTimeoutMs } from "./config.ts";
import type { Kernel } from "./registries.ts";

export async function runTestFn(
  kernel: Kernel,
  fn: () => unknown,
  timeoutMs: number,
  cancelled?: Promise<never>,
): Promise<void> {
  let settled = false;
  const ran = (async () => await fn())().finally(() => {
    settled = true;
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () =>
        reject(
          new Error(`Test timed out after ${formatKernelTimeoutMs(timeoutMs)}`),
        ),
      timeoutMs,
    );
  });
  try {
    await Promise.race([ran, timeout, ...(cancelled ? [cancelled] : [])]);
  } finally {
    clearTimeout(timer);
    if (!settled) await kernel.runtime.abandon?.("a test outran its run");
  }
}
