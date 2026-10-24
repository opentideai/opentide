import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  DENO_TOOLCHAIN_UNAVAILABLE,
  denoToolchainFailure,
  type DenoToolchainProbe,
  resolveDenoToolchain,
} from "./deno-toolchain.ts";

// A probe with no real process underneath: every seam supplied, so these tests
// exercise the compiled-binary shape on a machine running from source.
function probe(over: Partial<DenoToolchainProbe> = {}): DenoToolchainProbe {
  return {
    standalone: false,
    execPath: () => "/usr/bin/deno",
    pathVar: "",
    pathDelimiter: ":",
    binaryName: "deno",
    isFile: () => false,
    ...over,
  };
}

Deno.test("running under deno uses the running executable", () => {
  const result = resolveDenoToolchain(probe());
  assert(result.ok);
  assertEquals(result.data, "/usr/bin/deno");
});

Deno.test("a compiled binary never spawns itself as deno", () => {
  // The bug this module exists for: Deno.execPath() inside a `deno compile`
  // binary is the binary, and spawning it with deno's arguments booted a second
  // kernel instead of failing.
  const result = resolveDenoToolchain(
    probe({
      standalone: true,
      execPath: () => "/Applications/Tide.app/tide-kernel",
    }),
  );
  assert(!result.ok);
  assertEquals(result.error.code, DENO_TOOLCHAIN_UNAVAILABLE);
  assertStringIncludes(result.error.message, "compiled binary");
});

Deno.test("a compiled binary falls back to a deno on PATH", () => {
  const result = resolveDenoToolchain(probe({
    standalone: true,
    execPath: () => "/Applications/Tide.app/tide-kernel",
    pathVar: "/empty:/opt/homebrew/bin",
    isFile: (p) => p === "/opt/homebrew/bin/deno",
  }));
  assert(result.ok);
  assertEquals(result.data, "/opt/homebrew/bin/deno");
});

Deno.test("a deleted running binary falls through to PATH", () => {
  // Linux reports " (deleted)" when the running executable was replaced; that
  // string is not a spawnable path.
  const result = resolveDenoToolchain(probe({
    execPath: () => "/usr/bin/deno (deleted)",
    pathVar: "/usr/local/bin",
    isFile: (p) => p === "/usr/local/bin/deno",
  }));
  assert(result.ok);
  assertEquals(result.data, "/usr/local/bin/deno");
});

Deno.test("a deleted running binary with no PATH deno is unavailable", () => {
  const result = resolveDenoToolchain(probe({
    execPath: () => "  ",
    pathVar: "/usr/local/bin",
  }));
  assert(!result.ok);
  assertEquals(result.error.code, DENO_TOOLCHAIN_UNAVAILABLE);
  // Not the compiled-binary wording: this process IS running under deno.
  assertStringIncludes(result.error.message, "no `deno` executable is on PATH");
});

Deno.test("an empty PATH is not a match for an empty directory entry", () => {
  // join("", "deno") is the bare relative "deno", which would be spawned against
  // the current working directory. isFile is scoped to exactly that candidate so
  // this asserts the empty-entry skip and nothing else — a blanket `() => true`
  // would also satisfy the beside-the-executable lookup and pass for the wrong
  // reason.
  const result = resolveDenoToolchain(probe({
    standalone: true,
    pathVar: "::",
    isFile: (p) => p === "deno",
  }));
  assert(!result.ok);
});

Deno.test("the windows binary name is honoured", () => {
  const result = resolveDenoToolchain(probe({
    standalone: true,
    pathVar: "C:\\tools",
    pathDelimiter: ";",
    binaryName: "deno.exe",
    isFile: (p) => p.endsWith("deno.exe"),
  }));
  assert(result.ok);
  assertStringIncludes(result.data, "deno.exe");
});

Deno.test("the real process resolves without throwing", () => {
  // No assertion on the outcome — the test suite runs under `deno test`, so this
  // only proves the default probe reads the real process safely.
  const result = resolveDenoToolchain();
  assert(result.ok);
});

Deno.test("denoToolchainFailure names the feature before the reason", () => {
  const message = denoToolchainFailure("Binary export needs a Deno toolchain", {
    message: "No Deno toolchain found.",
    suggestion: "Install Deno.",
  });
  assertEquals(
    message,
    "Binary export needs a Deno toolchain: No Deno toolchain found. Install Deno.",
  );
});

Deno.test("denoToolchainFailure omits an absent suggestion", () => {
  assertEquals(
    denoToolchainFailure("Nope", { message: "Reason." }),
    "Nope: Reason.",
  );
});

// --- the deno bundled beside the sidecar ------------------------------------
// The desktop bundle ships its own toolchain (Tauri externalBin), landing next
// to the sidecar executable. Without it the four shell-out features are simply
// unavailable to a desktop user, who has no deno on PATH.

Deno.test("a compiled binary prefers the deno bundled beside it", () => {
  const result = resolveDenoToolchain(probe({
    standalone: true,
    execPath: () => "/Applications/Tide.app/Contents/MacOS/tide-kernel",
    isFile: (p) => p === "/Applications/Tide.app/Contents/MacOS/deno",
  }));
  assert(result.ok);
  assertEquals(result.data, "/Applications/Tide.app/Contents/MacOS/deno");
});

Deno.test("the bundled deno wins over one on PATH", () => {
  // Deliberate: the bundled binary is the version this kernel was compiled
  // against. Silently preferring a developer's newer install would make the
  // packaged app behave differently on their machine than on a user's.
  const result = resolveDenoToolchain(probe({
    standalone: true,
    execPath: () => "/Applications/Tide.app/Contents/MacOS/tide-kernel",
    pathVar: "/opt/homebrew/bin",
    isFile: (p) =>
      p === "/Applications/Tide.app/Contents/MacOS/deno" ||
      p === "/opt/homebrew/bin/deno",
  }));
  assert(result.ok);
  assertEquals(result.data, "/Applications/Tide.app/Contents/MacOS/deno");
});

Deno.test("with no bundled deno it still falls back to PATH", () => {
  const result = resolveDenoToolchain(probe({
    standalone: true,
    execPath: () => "/Applications/Tide.app/Contents/MacOS/tide-kernel",
    pathVar: "/opt/homebrew/bin",
    isFile: (p) => p === "/opt/homebrew/bin/deno",
  }));
  assert(result.ok);
  assertEquals(result.data, "/opt/homebrew/bin/deno");
});

Deno.test("a source-run kernel does NOT look beside its executable", () => {
  // Under `deno run` the running executable already IS the toolchain, so the
  // sibling lookup must not run — a stray file named `deno` next to the deno
  // binary would otherwise shadow it.
  const result = resolveDenoToolchain(probe({
    standalone: false,
    execPath: () => "/usr/bin/deno",
    isFile: () => true,
  }));
  assert(result.ok);
  assertEquals(result.data, "/usr/bin/deno");
});

Deno.test("the unavailable message names the bundled case too", () => {
  const result = resolveDenoToolchain(probe({
    standalone: true,
    execPath: () => "/Applications/Tide.app/Contents/MacOS/tide-kernel",
  }));
  assert(!result.ok);
  assertEquals(result.error.code, DENO_TOOLCHAIN_UNAVAILABLE);
  assertStringIncludes(result.error.message, "bundled");
  assertStringIncludes(result.error.message, "PATH");
});

Deno.test("the windows sidecar looks for deno.exe beside itself", () => {
  const result = resolveDenoToolchain(probe({
    standalone: true,
    execPath: () => "C:\\Program Files\\Tide\\tide-kernel.exe",
    binaryName: "deno.exe",
    pathDelimiter: ";",
    isFile: (p) => p.endsWith("deno.exe"),
  }));
  assert(result.ok);
  assertStringIncludes(result.data, "deno.exe");
});
