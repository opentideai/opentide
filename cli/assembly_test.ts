import { assertEquals } from "@std/assert";
import {
  getBuildArgs,
  getExportArgs,
  getOrchestratorArgs,
  getServeArgs,
} from "./assembly.ts";
import { APP_PORT_AUTO } from "../core/config.ts";

// getBuildArgs / getExportArgs are pure argv parsers (no kernel), so the D2
// required-project contract can be enforced in the dispatcher before assembling.

Deno.test("getBuildArgs: --project is captured; absent yields null", () => {
  assertEquals(getBuildArgs(["--project", "/x"]).projectPath, "/x");
  assertEquals(getBuildArgs(["-p", "/y"]).projectPath, "/y");
  assertEquals(getBuildArgs([]).projectPath, null);
});

Deno.test("getExportArgs: --project/--out captured, --tarball defaults false", () => {
  const bare = getExportArgs(["--project", "/x"]);
  assertEquals(bare.projectPath, "/x");
  assertEquals(bare.out, null);
  assertEquals(bare.tarball, false);
  assertEquals(bare.force, false);

  const full = getExportArgs([
    "-p",
    "/x",
    "--out",
    "/o",
    "--tarball",
    "--force",
  ]);
  assertEquals(full.projectPath, "/x");
  assertEquals(full.out, "/o");
  assertEquals(full.tarball, true);
  assertEquals(full.force, true);
});

Deno.test("getExportArgs: no --project yields a null path (dispatcher rejects)", () => {
  assertEquals(getExportArgs([]).projectPath, null);
  assertEquals(getExportArgs(["--tarball"]).tarball, true);
});

Deno.test("getServeArgs: --port overrides, invalid falls back to the default", () => {
  const DEFAULT = 3003;
  assertEquals(getServeArgs(DEFAULT, ["--port", "3457"]).port, 3457);
  assertEquals(getServeArgs(DEFAULT, []).port, DEFAULT);
  assertEquals(getServeArgs(DEFAULT, ["--port", "nope"]).port, DEFAULT);
  // A negative must use the =form (a bare "--port -5" is ambiguous to parseArgs).
  assertEquals(getServeArgs(DEFAULT, ["--port=-5"]).port, DEFAULT);
});

Deno.test("getServeArgs: --app-port defaults to auto and pins when given", () => {
  const DEFAULT = 3003;
  // Absent → auto (OS-assigned free port), so two stacks never collide.
  assertEquals(
    getServeArgs(DEFAULT, ["--project", "/x"]).appPort,
    APP_PORT_AUTO,
  );
  // Explicit value pins the preview port.
  assertEquals(getServeArgs(DEFAULT, ["--app-port", "3011"]).appPort, 3011);
  // Explicit 0 is a valid "auto" value.
  assertEquals(
    getServeArgs(DEFAULT, ["--app-port", "0"]).appPort,
    APP_PORT_AUTO,
  );
  // Invalid / negative falls back to auto rather than binding a bad port.
  assertEquals(
    getServeArgs(DEFAULT, ["--app-port", "nope"]).appPort,
    APP_PORT_AUTO,
  );
  assertEquals(getServeArgs(DEFAULT, ["--app-port=-3"]).appPort, APP_PORT_AUTO);
  // --port and --app-port are independent.
  const both = getServeArgs(DEFAULT, ["--port", "3013", "--app-port", "3011"]);
  assertEquals(both.port, 3013);
  assertEquals(both.appPort, 3011);
});

Deno.test("getOrchestratorArgs: --ui-dist is captured; absent yields null", () => {
  assertEquals(getOrchestratorArgs([]).uiDist, null);
  assertEquals(
    getOrchestratorArgs(["--ui-dist", "/build/ide"]).uiDist,
    "/build/ide",
  );
  // Positionals / unrelated flags don't interfere with the one flag it parses.
  assertEquals(
    getOrchestratorArgs(["--ui-dist=/dist", "extra"]).uiDist,
    "/dist",
  );
});

Deno.test("getServeArgs: --ui-dist is captured; absent yields null", () => {
  const DEFAULT = 3003;
  assertEquals(getServeArgs(DEFAULT, []).uiDist, null);
  assertEquals(
    getServeArgs(DEFAULT, ["--ui-dist", "/build/ide"]).uiDist,
    "/build/ide",
  );
  // Independent of the port flags.
  const all = getServeArgs(DEFAULT, [
    "--project",
    "/x",
    "--port",
    "3101",
    "--ui-dist",
    "/dist",
  ]);
  assertEquals(all.uiDist, "/dist");
  assertEquals(all.port, 3101);
});
