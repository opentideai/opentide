import { assert, assertEquals } from "@std/assert";
import {
  hostInterfaceAddresses,
  runnerEnv,
  runnerPermissionFlags,
} from "./permissions.ts";
import { RUNNER_ERROR_CODES } from "./protocol.ts";

const INPUT = {
  cacheDirs: ["/home/u/.cache/deno", "/home/u/.cache/deno/npm"],
  scratchDir: "/p/.opentide/caches/runner",
  configFile: "/opt/opentide/deno.json",
  interfaceAddresses: ["127.0.0.1", "100.65.1.2", "[fd7a::1]"],
};

function flags(input = INPUT): string[] {
  const result = runnerPermissionFlags(input);
  assert(result.ok);
  return result.data;
}

Deno.test("the runner gets no run, ffi, sys or blanket read/write", () => {
  const f = flags();
  for (
    const banned of [
      "--allow-run",
      "--allow-ffi",
      "--allow-sys",
      "-A",
      "--allow-all",
    ]
  ) {
    assert(!f.some((x) => x.startsWith(banned)), banned);
  }
  assert(!f.includes("--allow-read"));
  assert(!f.includes("--allow-write"));
  assert(f.includes("--no-prompt"));
});

Deno.test("read is the caches and scratch only; write is scratch only", () => {
  const f = flags();
  assertEquals(
    f.find((x) => x.startsWith("--allow-read=")),
    "--allow-read=/home/u/.cache/deno,/home/u/.cache/deno/npm,/p/.opentide/caches/runner",
  );
  assertEquals(
    f.find((x) => x.startsWith("--allow-write=")),
    "--allow-write=/p/.opentide/caches/runner",
  );
});

Deno.test("net denies every loopback spelling and every interface, once each", () => {
  const deny = flags().find((x) => x.startsWith("--deny-net="))!;
  assertEquals(
    deny,
    "--deny-net=127.0.0.1,localhost,0.0.0.0,[::1],[::],100.65.1.2,[fd7a::1]",
  );
  assert(flags().includes("--allow-net"));
});

Deno.test("the runner is pinned to OpenTide's config, and the app lock when given", () => {
  assert(flags().includes("--config=/opt/opentide/deno.json"));
  assert(!flags().some((x) => x.startsWith("--lock")));
  assert(
    flags({ ...INPUT, lockFile: "/p/deno.lock" } as typeof INPUT)
      .includes("--lock=/p/deno.lock"),
  );
});

Deno.test("a path with a comma is refused, since it would split the list", () => {
  const result = runnerPermissionFlags({ ...INPUT, scratchDir: "/a,b/runner" });
  assert(!result.ok);
  assertEquals(result.error.code, RUNNER_ERROR_CODES.invalidPath);
});

Deno.test("runnerEnv: the runtime's vars win over a project var of the same name", () => {
  assertEquals(
    runnerEnv({ API_URL: "x", DENO_DIR: "/evil", TMPDIR: "/evil" }, {
      denoDir: "/cache",
      scratchDir: "/scratch",
    }),
    { API_URL: "x", DENO_DIR: "/cache", TMPDIR: "/scratch" },
  );
});

Deno.test("interface addresses: IPv6 bracketed, zone dropped, duplicates gone", () => {
  const iface = (family: "IPv4" | "IPv6", address: string) =>
    ({
      family,
      address,
      name: "x",
      netmask: "",
      scopeid: null,
      cidr: "",
      mac: "",
    }) as Deno.NetworkInterfaceInfo;
  assertEquals(
    hostInterfaceAddresses([
      iface("IPv4", "127.0.0.1"),
      iface("IPv6", "fe80::1%eth0"),
      iface("IPv6", "fe80::1%wlan0"),
      iface("IPv4", "192.168.1.5"),
    ]),
    ["127.0.0.1", "[fe80::1]", "192.168.1.5"],
  );
});
