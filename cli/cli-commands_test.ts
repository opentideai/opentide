import {
  assert,
  assertEquals,
  assertFalse,
  assertStringIncludes,
} from "@std/assert";
import { cliUsage, parseCliCommand, scaffoldCommand } from "./cli-commands.ts";
import { isProject, removeProject } from "../core/project-manager.ts";

Deno.test("parseCliCommand: first token is the command, rest is forwarded verbatim", () => {
  const parsed = parseCliCommand(["serve", "--project", "/x", "--http"]);
  assertEquals(parsed.command, "serve");
  assertEquals(parsed.rest, ["--project", "/x", "--http"]);
  assertFalse(parsed.help);
});

Deno.test("parseCliCommand: no args yields a null command (dispatcher shows usage)", () => {
  const parsed = parseCliCommand([]);
  assertEquals(parsed.command, null);
  assertEquals(parsed.rest, []);
  assertFalse(parsed.help);
});

Deno.test("parseCliCommand: leading help flag yields help with no command", () => {
  for (const flag of ["-h", "--help", "help"]) {
    const parsed = parseCliCommand([flag, "serve"]);
    assertEquals(parsed.command, null, `${flag} should not be a command`);
    assert(parsed.help, `${flag} should set help`);
  }
});

Deno.test("parseCliCommand: leading version flag yields version with no command", () => {
  for (const flag of ["-V", "--version", "version"]) {
    const parsed = parseCliCommand([flag]);
    assertEquals(parsed.command, null, `${flag} should not be a command`);
    assert(parsed.version, `${flag} should set version`);
    assertFalse(parsed.help);
  }
});

Deno.test("parseCliCommand: an unknown command is passed through (dispatcher rejects it)", () => {
  const parsed = parseCliCommand(["bogus", "arg"]);
  assertEquals(parsed.command, "bogus");
  assertEquals(parsed.rest, ["arg"]);
  assertFalse(parsed.help);
});

Deno.test("cliUsage advertises the dispatchable commands", () => {
  const usage = cliUsage();
  assertStringIncludes(usage, "serve");
  assertStringIncludes(usage, "mcp");
  assertStringIncludes(usage, "scaffold");
  assertStringIncludes(usage, "build");
  assertStringIncludes(usage, "export");
  assertStringIncludes(usage, "opentide");
});

Deno.test("scaffoldCommand: missing <name> is a usage error (dispatcher → exit 2)", () => {
  const result = scaffoldCommand(["./only-a-dir"]);
  assert(!result.ok && result.kind === "usage");
});

Deno.test("scaffoldCommand: extra positional beyond <dir> <name> is a usage error", () => {
  const result = scaffoldCommand(["./dir", "Name", "surprise"]);
  assert(!result.ok && result.kind === "usage");
});

Deno.test("scaffoldCommand: creates a valid, loadable project under <dir>", async () => {
  // Follows the cli_test.ts precedent: createProject writes the global registry,
  // so scaffold into a temp parent and removeProject-clean up after.
  const parent = await Deno.makeTempDir({ prefix: "opentide-scaffold-" });
  const result = scaffoldCommand([parent, "Todo App"]);
  try {
    assert(result.ok, "scaffold should succeed");
    // D2: the folder is slug(<name>) under <dir>, not the literal <dir>.
    assertStringIncludes(result.path, "todo-app");
    assertEquals(result.name, "Todo App");
    // "Loadable" is the gate word: the created path is a real project.
    assert(
      isProject(result.path),
      "scaffolded path should be a loadable project",
    );
  } finally {
    if (result.ok) removeProject(result.path);
    await Deno.remove(parent, { recursive: true }).catch(() => {});
  }
});

Deno.test("scaffoldCommand: a second scaffold at the same path is an error (dispatcher → exit 1)", async () => {
  const parent = await Deno.makeTempDir({ prefix: "opentide-scaffold-dup-" });
  const first = scaffoldCommand([parent, "Dup App"]);
  try {
    assert(first.ok);
    const second = scaffoldCommand([parent, "Dup App"]);
    assert(
      !second.ok && second.kind === "error" &&
        second.message.includes("already exists"),
    );
  } finally {
    if (first.ok) removeProject(first.path);
    await Deno.remove(parent, { recursive: true }).catch(() => {});
  }
});
