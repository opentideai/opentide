// @layer composition — the `opentide` entry point, the file the installed
// launcher runs. It only picks a module: `mcp` goes straight to mcp-main.ts,
// everything else to cli-run.ts. The split exists for `opentide mcp`, which a
// Claude Code plugin starts in every session: it is a relay to a project's
// serve, and importing cli-run.ts would load the database, the compiler and the
// model SDKs for nothing. cli/startup-weight_test.ts holds that line.
import { parseCliCommand } from "./cli-commands.ts";
import { importLater } from "../core/import-later.ts";

export async function runCli(argv: string[] = Deno.args): Promise<void> {
  const { command, rest } = parseCliCommand(argv);
  if (command === "mcp") {
    // serveMcp owns its own no-project handling and stdout discipline.
    const mcp = await importLater<typeof import("./mcp-main.ts")>(
      "./mcp-main.ts",
      import.meta.url,
    );
    await mcp.serveMcp(rest);
    return;
  }
  const cli = await importLater<typeof import("./cli-run.ts")>(
    "./cli-run.ts",
    import.meta.url,
  );
  await cli.runCli(argv);
}

if (import.meta.main) runCli();
