import { assert } from "@std/assert";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

// Every server OpenTide starts binds loopback, or the app host for the app
// preview. The user-code runner can't deny a CIDR, so anything bound to
// 0.0.0.0 answers it on 127.0.0.2 (docs/plans/user-code-runner.md, "Measured").

const REPO = new URL("..", import.meta.url).pathname;
const ROOTS = ["core", "cli", "mcp", "lsp", "agent-loop", "providers"];
// The exported app's own server, which binds what its user asks for.
const USER_APP_SERVERS = new Set(["core/export.ts", "core/build.ts"]);
const LISTEN_CALL = /Deno\.(serve|listen)\(/g;
// DEV_SERVER_HOST is 127.0.0.1; `host` is the app server's getAppServerHost().
const ALLOWED_HOST = /^\s*\{[^}]*\bhostname:\s*(DEV_SERVER_HOST|host)\b/;

function shippedSources(dir: string): string[] {
  return readdirSync(join(REPO, dir), { recursive: true, encoding: "utf-8" })
    .filter((f) =>
      f.endsWith(".ts") && !f.endsWith("_test.ts") && !f.includes("testdata")
    )
    .map((f) => join(dir, f));
}

Deno.test("every server OpenTide starts binds loopback or the app host", () => {
  const offenders: string[] = [];
  let calls = 0;
  for (const root of ROOTS) {
    for (const file of shippedSources(root)) {
      if (USER_APP_SERVERS.has(file)) continue;
      const source = readFileSync(join(REPO, file), "utf-8");
      for (const match of source.matchAll(LISTEN_CALL)) {
        calls++;
        const args = source.slice(match.index + match[0].length);
        if (!ALLOWED_HOST.test(args)) {
          const line = source.slice(0, match.index).split("\n").length;
          offenders.push(`${relative(REPO, join(REPO, file))}:${line}`);
        }
      }
    }
  }
  assert(calls > 0, "found no servers to check");
  assert(
    offenders.length === 0,
    `not bound to loopback: ${offenders.join(", ")}`,
  );
});
