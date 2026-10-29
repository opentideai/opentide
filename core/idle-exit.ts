// @layer core — knowing when nobody is using a serve process.
//
// `opentide mcp` starts serve detached so the next client can attach to it, and
// nothing used to stop it: a serve outlived its last client by days, holding
// the project lock, and every other way of opening the project was refused. A
// serve started that way now exits once it has been idle for a while.
//
// Idle means no HTTP request in flight and none finished recently. A connected
// MCP client holds a standing SSE request open for as long as it lives, and the
// IDE polls, so "nothing in flight" is "nobody connected" without the server
// having to know who its clients are.

export interface ActivityMonitor {
  // Marks a request as started. Call the returned function when it has finished,
  // streaming body included; calling it twice is a no-op.
  begin(): () => void;
  // How long nothing has been in flight, in ms. 0 while anything is.
  idleFor(): number;
}

export function createActivityMonitor(
  now: () => number = Date.now,
): ActivityMonitor {
  let inFlight = 0;
  let lastActive = now();
  return {
    begin() {
      inFlight++;
      let ended = false;
      return () => {
        if (ended) return;
        ended = true;
        inFlight--;
        lastActive = now();
      };
    },
    idleFor() {
      return inFlight > 0 ? 0 : now() - lastActive;
    },
  };
}

export interface IdleWatchOptions {
  idleMs: number;
  pollMs: number;
  onIdle: () => void;
}

// Calls onIdle once, the first time a poll finds the monitor idle for idleMs.
// Returns a stop function.
export function watchIdle(
  monitor: ActivityMonitor,
  { idleMs, pollMs, onIdle }: IdleWatchOptions,
): () => void {
  const timer = setInterval(() => {
    if (monitor.idleFor() < idleMs) return;
    clearInterval(timer);
    onIdle();
  }, pollMs);
  return () => clearInterval(timer);
}
