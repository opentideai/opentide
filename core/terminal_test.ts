import { assertEquals, assertStringIncludes } from "@std/assert";
import { ReplSession } from "./terminal.ts";
import type { Kernel } from "./registries.ts";
import { TEST_TMP_DIR } from "./test-home_test.ts";

function stubRegistry() {
  return {
    list: () => [],
  };
}

function stubKernel(): Kernel {
  return {
    db: {},
    routes: stubRegistry(),
    handlers: stubRegistry(),
    functions: stubRegistry(),
    configs: stubRegistry(),
    templates: stubRegistry(),
    assets: stubRegistry(),
    schemas: {},
    env: {},
    log: {},
    tests: stubRegistry(),
    devViews: stubRegistry(),
    devTools: stubRegistry(),
    packages: {},
    listModules: () => [],
  } as unknown as Kernel;
}

Deno.test("REPL ask shorthand awaits a bare ask expression", async () => {
  const repl = new ReplSession();
  const calls: string[] = [];
  repl.attach(stubKernel());
  repl.setAgentFn(async (question) => {
    await Promise.resolve();
    calls.push(question);
    return "";
  });

  const result = await repl.eval('ask("hello")');

  assertEquals(result.ok, true);
  assertEquals(result.value, "");
  assertEquals(calls, ["hello"]);
});

Deno.test("REPL ask shorthand awaits a bare ask call with trailing semicolon", async () => {
  const repl = new ReplSession();
  const calls: string[] = [];
  repl.attach(stubKernel());
  repl.setAgentFn(async (question) => {
    await Promise.resolve();
    calls.push(question);
    return "";
  });

  const result = await repl.eval('ask("hello");');

  assertEquals(result.ok, true);
  assertEquals(result.value, "");
  assertEquals(calls, ["hello"]);
});

Deno.test("REPL shell command uses true shell semantics in cwd", async () => {
  const dir = await Deno.makeTempDir({
    dir: TEST_TMP_DIR,
    prefix: "genie-shell-",
  });
  try {
    const repl = new ReplSession();
    repl.setCwd(dir);

    const result = await repl.shell(
      "echo hello > shell-out.txt && cat shell-out.txt",
    );

    assertEquals(result.ok, true);
    assertStringIncludes(
      result.value,
      "$ echo hello > shell-out.txt && cat shell-out.txt",
    );
    assertStringIncludes(result.value, "stdout:\nhello");
    assertEquals(await Deno.readTextFile(`${dir}/shell-out.txt`), "hello\n");
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});
