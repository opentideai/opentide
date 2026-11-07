// The runner's network flags against live listeners, in real children: every
// loopback spelling measured in docs (Deno 2.9.8, Linux), in the default mode
// and with a project's `runner.net` list. And `runner.ffi`, the other opt-in.

import { assert, assertEquals } from "@std/assert";
import {
  hostInterfaceAddresses,
  runnerPermissionFlags,
} from "./permissions.ts";

const NET_PROBE = new URL("./testdata/net-probe.ts", import.meta.url).pathname;
const FFI_PROBE = new URL("./testdata/ffi-probe.ts", import.meta.url).pathname;

// Every way to write 127.0.0.1, plus the unspecified addresses and IPv6
// loopback. 127.0.0.2 is apart: Deno's deny lists take no CIDR.
const LOOPBACK_SPELLINGS = [
  "127.0.0.1",
  "127.1",
  "localhost",
  "2130706433",
  "0x7f.1",
  "[::ffff:127.0.0.1]",
  "0.0.0.0",
  "0",
  "[::1]",
  "[::]",
];
const OTHER_LOOPBACK = "127.0.0.2";

function machineAddress(): string | undefined {
  return Deno.networkInterfaces().find((i) =>
    i.family === "IPv4" && !i.address.startsWith("127.")
  )?.address;
}

// One listener bound to loopback, one to every address, as a kernel and a
// local database would be.
async function withListeners(
  fn: (ports: { loopback: number; any: number }) => Promise<void>,
) {
  const respond = () => new Response("reached");
  const loopback = Deno.serve(
    { hostname: "127.0.0.1", port: 0, onListen: () => {} },
    respond,
  );
  const any = Deno.serve(
    { hostname: "0.0.0.0", port: 0, onListen: () => {} },
    respond,
  );
  try {
    await fn({ loopback: loopback.addr.port, any: any.addr.port });
  } finally {
    await loopback.shutdown();
    await any.shutdown();
  }
}

async function runUnder(
  opts: { net?: string[]; ffi?: boolean },
  script: string,
  args: string[],
): Promise<Record<string, unknown>> {
  const scratchDir = await Deno.makeTempDir({ prefix: "runner-net-" });
  try {
    const flags = runnerPermissionFlags({
      cacheDirs: [],
      scratchDir,
      interfaceAddresses: hostInterfaceAddresses(),
      ...opts,
    });
    assert(flags.ok, JSON.stringify(flags));
    const out = await new Deno.Command(Deno.execPath(), {
      args: ["run", ...flags.data, script, ...args],
      cwd: scratchDir,
      clearEnv: true,
      stdout: "piped",
      stderr: "piped",
    }).output();
    assert(out.success, new TextDecoder().decode(out.stderr));
    return JSON.parse(new TextDecoder().decode(out.stdout));
  } finally {
    await Deno.remove(scratchDir, { recursive: true });
  }
}

const url = (host: string, port: number) => `http://${host}:${port}/`;

function expectOutcomes(
  got: Record<string, unknown>,
  want: Record<string, string>,
) {
  for (const [target, outcome] of Object.entries(want)) {
    assertEquals(got[target], outcome, target);
  }
}

Deno.test("by default, nothing on this machine is reachable but the rest of 127/8", () =>
  withListeners(async ({ loopback, any }) => {
    const machine = machineAddress();
    const want: Record<string, string> = {};
    for (const host of LOOPBACK_SPELLINGS) {
      want[url(host, loopback)] = "denied";
      want[url(host, any)] = "denied";
    }
    if (machine) want[url(machine, any)] = "denied";
    // The measured hole: a socket bound to 0.0.0.0 answers 127.0.0.2. Ours
    // bind 127.0.0.1, which doesn't.
    want[url(OTHER_LOOPBACK, any)] = "open";
    want[url(OTHER_LOOPBACK, loopback)] = "refused";
    expectOutcomes(await runUnder({}, NET_PROBE, Object.keys(want)), want);
  }));

Deno.test("a net list opens its local port in every spelling, and nothing else here", () =>
  withListeners(async ({ loopback, any }) => {
    const machine = machineAddress();
    const want: Record<string, string> = {};
    for (const host of LOOPBACK_SPELLINGS) {
      // IPv6 spellings reach no IPv4 listener, but they get past the check.
      want[url(host, any)] =
        host.startsWith("[::") && host !== "[::ffff:127.0.0.1]"
          ? "refused"
          : "open";
      want[url(host, loopback)] = "denied";
    }
    if (machine) want[url(machine, any)] = "denied";
    want[url(OTHER_LOOPBACK, any)] = "denied";
    expectOutcomes(
      await runUnder(
        { net: [`localhost:${any}`] },
        NET_PROBE,
        Object.keys(want),
      ),
      want,
    );
  }));

Deno.test("ffi is denied by default and allowed when the project turns it on", async () => {
  assertEquals(await runUnder({}, FFI_PROBE, []), { error: "NotCapable" });
  const on = await runUnder({ ffi: true }, FFI_PROBE, []);
  assertEquals(typeof on.pid, "number");
});
