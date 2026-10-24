# OpenTide

OpenTide is a server that coding agents build web apps in. You point Claude
Code, Codex or Cursor at it over MCP. The agent defines routes, handlers,
schemas, templates and tests in a running app you can open in a browser, and
exports a plain Deno or Node project when you're done.

Every change goes through a changeset: a plan with acceptance criteria, the
work, then a readiness gate that wants test evidence before it lets the change
complete. The server runs no model and needs no API key.

Version 0.1.0. Early, and tested on macOS (Apple silicon) only.

## Install

Needs [Deno 2](https://deno.com).

```sh
curl -fsSL https://github.com/opentideai/opentide/releases/latest/download/install.sh | sh
```

This puts an `opentide` command in `~/.deno/bin`. The details, and how to
install a specific version, are in
[docs/opentide-cli.md](docs/opentide-cli.md#install).

## Start a project

```sh
opentide scaffold ~/apps "Todo App"
```

That creates `~/apps/todo-app`. The app's code lives in the project's database,
not in source files; [docs/project-storage.md](docs/project-storage.md) has the
layout.

## Connect Claude Code

From the project directory:

```sh
opentide mcp --print-config claude-code --project "$PWD" > .mcp.json
claude
```

The config starts a bridge, and the bridge starts `opentide serve` for the
project if one isn't already running. Ask for something like "add GET /api/hello
with a test".

## Connect Codex

```sh
opentide mcp --print-config codex --project ~/apps/todo-app >> ~/.codex/config.toml
```

Cursor works the same way with `--print-config cursor`. HTTP transports, tokens
and what the agent is told on connect are in
[docs/mcp-connect.md](docs/mcp-connect.md).

## See the app

```sh
opentide serve --project ~/apps/todo-app --app-port 3001
```

Then open <http://localhost:3001>. Without `--app-port` the preview gets a free
port. To fix it for every start, including one the MCP bridge makes, set
`"previewPort": 3001` in the project's `opentide.json`.

## Ship it

```sh
opentide export --project ~/apps/todo-app --out ./todo-export
```

That writes a standalone Deno app: an entry point, a router, the handlers with
their request validation, a schema seed, and generated API docs.
`opentide build` makes a deployable build. The flags are in
[docs/opentide-cli.md](docs/opentide-cli.md).

## Things to know

- **One writer per project.** One session holds an open changeset at a time. A
  second agent is refused with `CHANGESET_ACTIVE`. To run two at once, use tasks
  (`start_task`), which fork the project.
- **A changeset left behind by a client that's gone** (after `/clear`, a crash,
  a restart) can be picked up with `adopt_changeset`, or rewound with
  `abandon_changeset`.
- **Work lives in memory until it's flushed.** `complete_changeset` flushes it.
  If it reports `stateFlushed: false`, the work exists only in the running
  server.

## Editors

`opentide lsp --project <path>` serves completion, hover, go-to-definition and
rename for the project's code over LSP. See
[docs/lsp-connect.md](docs/lsp-connect.md).

## License

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
