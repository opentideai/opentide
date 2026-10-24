# OpenTide

**A live app for your coding agent to build in, and a gate it can't talk its way
past.**

Point Claude Code, Codex or Cursor at OpenTide and the agent stops editing files
and hoping. It builds inside a running server. A handler it defines is serving
requests a moment later, and a route it registers is live in the preview, with
no build and no restart. The tests it writes run against the real thing.

When it says it's done, it has to prove it. Test runs, type checks and invariant
checks are recorded by the server, which mints an attestation for each. The
agent cites those; it can't invent them. A change completes only when the
evidence covers what the plan promised.

When you're done, `opentide export` hands you a plain Deno or Node project. No
runtime to keep paying for, no lock-in.

OpenTide runs no model and needs no API key. Bring the agent you already use.

## What you get

- **A running app, not a pile of files.** Routes, handlers, schemas, templates,
  migrations and tests live in a project database the server owns. Every change
  is live on the preview port as soon as it lands.
- **Changesets with a plan and a gate.** Every change starts as a plan with
  acceptance criteria and a verification plan. `complete_changeset` refuses
  until the evidence is in. You can make the gate stricter.
- **Proof the agent can't fake.** `run_tests`, `check_export_types` and
  `verify_formal_specs` mint attestations, and evidence has to cite them. Edit
  the code afterwards and the attestation goes stale.
- **Real undo.** `undo_change` and `undo_turn` step back one change or one agent
  turn. Abandoning a changeset rewinds the code, schema and files to where they
  were when it started. Your app's data stays.
- **Parallel agents without the mess.** One writer per project, enforced.
  `start_task` forks the project for a second agent, and `merge_task` replays
  the fork back under main's tests. It refuses, naming the conflicts, if the two
  collide.
- **Tools agents actually need.** 109 of them over MCP: blast radius before a
  rename, test coverage, lint, dependency security checks, browser screenshots
  and scripted UI tests of the running app, git, snapshots, project docs.
- **An exit.** `opentide export` and `opentide build` produce a standalone app
  that runs with `deno task start`. Before a build ships, its gates boot it and
  smoke-test its routes.

## Quick start

You need [Deno 2](https://deno.com).

```sh
curl -fsSL https://github.com/opentideai/opentide/releases/latest/download/install.sh | sh
opentide scaffold ~/apps "Todo App"
cd ~/apps/todo-app
opentide mcp --print-config claude-code --project "$PWD" > .mcp.json
claude
```

Then ask for something real: _"Add a todos API with create, list and complete,
backed by a table, with tests."_ The agent plans it, builds it into the running
app, runs the tests, records the evidence and completes the changeset.

The installer puts `opentide` in `~/.deno/bin`. Versions and offline installs
are in [docs/opentide-cli.md](docs/opentide-cli.md#install).

## Other agents

```sh
# Codex
opentide mcp --print-config codex --project ~/apps/todo-app >> ~/.codex/config.toml

# Cursor
opentide mcp --print-config cursor --project ~/apps/todo-app
```

Each config starts a small bridge. The bridge attaches to the project's server,
starting one if none is running. Several agents can connect to the same project;
only one at a time holds a changeset. The HTTP transport, tokens and what the
agent is told on connect are in [docs/mcp-connect.md](docs/mcp-connect.md).

## See it running

```sh
opentide serve --project ~/apps/todo-app --app-port 3001
```

Open <http://localhost:3001>. To pin the port for every start, including the
ones the bridge makes, set `"previewPort": 3001` in the project's
`opentide.json`.

## Ship it

```sh
opentide export --project ~/apps/todo-app --out ./todo-export
cd todo-export && deno task start
```

You get an entry point, a router, the handlers with their request validation, a
schema seed and generated API docs. `opentide build` makes a deployable build
for Deno or Node (Node 24 or later). The flags are in
[docs/opentide-cli.md](docs/opentide-cli.md).

## Good to know

- **Work is in memory until it's flushed.** `complete_changeset` flushes it to
  `.opentide/state/`, which you commit. If it reports `stateFlushed: false`, the
  work exists only in the running server.
- **A changeset left behind by an agent that's gone** (after `/clear`, a crash
  or a restart) is picked up with `adopt_changeset`, or rewound with
  `abandon_changeset`.
- **Projects live in Git.** What's shared and what stays local is in
  [docs/project-storage.md](docs/project-storage.md).
- **Editors get LSP.** `opentide lsp --project <path>` serves completion, hover,
  go-to-definition and rename for the project's code. See
  [docs/lsp-connect.md](docs/lsp-connect.md).

## Platforms

- **macOS:** tested on Apple silicon.
- **Linux:** should work; it isn't tested yet.
- **Windows:** use WSL. The installer is a POSIX shell script, and native
  Windows hasn't been run.

This is 0.1.0. Expect rough edges, and please file them.

## License

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
