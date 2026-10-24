<p align="center">
  <img src="assets/hero.svg" alt="OpenTide: your agent builds it live, then it proves it works" width="100%">
</p>

<p align="center">
  <a href="https://github.com/opentideai/opentide/actions/workflows/ci.yml"><img src="https://github.com/opentideai/opentide/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="https://github.com/opentideai/opentide/releases/latest"><img src="https://img.shields.io/github/v/release/opentideai/opentide?color=5eead4&label=release" alt="Latest release"></a>
  <img src="https://img.shields.io/badge/MCP-109_tools-7dd3fc" alt="MCP: 109 tools">
  <img src="https://img.shields.io/badge/Deno-2-a5b4fc?logo=deno" alt="Deno 2">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-Apache--2.0-94a3b8" alt="Apache-2.0"></a>
</p>

<p align="center">
  <b><a href="#quick-start">Quick start</a></b> ·
  <b><a href="#how-it-works">How it works</a></b> ·
  <b><a href="#everything-it-does">Features</a></b> ·
  <b><a href="#ship-it">Ship it</a></b> ·
  <b><a href="#docs">Docs</a></b>
</p>

---

**Coding agents are fast. Then you spend the afternoon finding out what they
actually did.**

OpenTide flips that. Plug in Claude Code, Codex or Cursor, and your agent stops
editing files in the dark. It builds inside a **running app**: every handler,
route and table it creates is serving requests seconds later. And when it says
_done_, it has to **prove it**, with test runs and type checks the server
witnessed and recorded, not ones the agent typed into a summary.

When you're happy, one command hands you a **plain Deno or Node app**. No
platform to rent. No lock-in. No model inside, no API key. Bring the agent you
already pay for.

<p align="center">
  <img src="assets/pillars.svg" alt="Live, Proven, Yours" width="100%">
</p>

## Quick start

You need [Deno 2](https://deno.com). Then it's four commands:

```sh
curl -fsSL https://github.com/opentideai/opentide/releases/latest/download/install.sh | sh
opentide scaffold ~/apps "Todo App" && cd ~/apps/todo-app
opentide mcp --print-config claude-code --project "$PWD" > .mcp.json
claude
```

Now ask for something real:

> _Add a todos API with create, list and complete, backed by a table, with
> tests._

<p align="center">
  <img src="assets/session.svg" alt="A Claude Code session: plan, build live, test, attest, complete" width="88%">
</p>

The agent opens a changeset with a plan and acceptance criteria. It builds the
schema, handlers and routes straight into the running app, writes the tests,
runs them, cites the server's attestation as evidence, and closes the change,
which is flushed to disk for you to commit.

<details>
<summary><b>Codex, Cursor, or any other MCP client</b></summary>

```sh
# Codex
opentide mcp --print-config codex --project ~/apps/todo-app >> ~/.codex/config.toml

# Cursor (paste into .cursor/mcp.json)
opentide mcp --print-config cursor --project ~/apps/todo-app
```

Every config starts a small stdio bridge. It attaches to the project's server,
or starts one if none is running. HTTP transport, tokens and what the agent is
told on connect: [docs/mcp-connect.md](docs/mcp-connect.md).

</details>

## How it works

<p align="center">
  <img src="assets/architecture.svg" alt="Agents connect over MCP to opentide serve, which runs the live preview and exports your app" width="100%">
</p>

One `opentide serve` per project holds the app. Its routes, handlers, schemas,
templates, migrations and tests live in a project database the server owns, and
they hot-swap the moment they're defined. Agents drive it through **109 MCP
tools**. Any number of them can connect; one at a time holds the pen.

## Everything it does

<table>
<tr>
<td width="50%" valign="top">

### 🌊 Builds live

Define a handler and it's serving. Register a route and it's on the preview
port. Alter a table and the migration has run. No build step, no restart, no
waiting to find out whether it works.

</td>
<td width="50%" valign="top">

### 🧾 Proof the agent can't fake

`run_tests`, `check_export_types` and `verify_formal_specs` mint
**attestations** on the server. Evidence has to cite them, and editing the code
afterwards makes them stale. `complete_changeset` stays shut until every
criterion in the plan is covered.

</td>
</tr>
<tr>
<td valign="top">

### 📋 Changesets, not chaos

Every change starts as a plan: steps, acceptance criteria, a verification plan.
Each step is tracked. The readiness gate runs advisory, graduated or strict: you
decide how hard it bites.

</td>
<td valign="top">

### ⏪ Real undo

`undo_change` and `undo_turn` step back one change or one agent turn. Abandoning
a changeset **rewinds** code, schema and files to where they started, and your
app's data stays put.

</td>
</tr>
<tr>
<td valign="top">

### 🔀 Parallel agents, no merge hell

`start_task` forks the project so a second agent can build alongside the first.
`merge_task` replays the fork onto main under main's own tests. If the two
collide, it refuses and names the conflict.

</td>
<td valign="top">

### 🧰 The tools agents wish they had

Blast radius before a rename. Test coverage. Lint. Dependency security checks.
Browser screenshots and scripted UI tests against the running app. Git.
Snapshots. Generated API docs.

</td>
</tr>
<tr>
<td valign="top">

### 🔌 Survives `/clear`

Agent crashed, restarted or lost its context mid-change? The next one calls
`adopt_changeset` and picks up the work, plan and progress included.

</td>
<td valign="top">

### ✍️ Editors too

`opentide lsp` serves completion, hover, go-to-definition and rename for the
app's code, so your editor sees what the agent built.
[docs/lsp-connect.md](docs/lsp-connect.md)

</td>
</tr>
</table>

## See it running

```sh
opentide serve --project ~/apps/todo-app --app-port 3001
open http://localhost:3001
```

To pin the port for every start, including the ones the bridge makes, set
`"previewPort": 3001` in the project's `opentide.json`.

## Ship it

```sh
opentide export --project ~/apps/todo-app --out ./todo-export
cd todo-export && deno task start
```

You get a standalone app: an entry point, a router, the handlers with their
request validation, a schema seed and generated API docs. `opentide build` makes
a deployable build for **Deno or Node** (Node 24+), and its gates boot the build
and smoke-test the routes before you ship.

## Good to know

- **Work lives in memory until it's flushed.** `complete_changeset` flushes it
  to `.opentide/state/`, which you commit. If it reports `stateFlushed: false`,
  the work exists only in the running server.
- **Projects live in Git.** What's shared and what stays local:
  [docs/project-storage.md](docs/project-storage.md).
- **Platforms.** macOS and Linux run the full test suite and the install smoke
  in CI on every push. On Windows, use WSL; native Windows hasn't been run.
- **It's 0.1.** Expect rough edges, and please
  [file them](https://github.com/opentideai/opentide/issues).

## Docs

| Doc                                               | What's in it                                                |
| ------------------------------------------------- | ----------------------------------------------------------- |
| [opentide CLI](docs/opentide-cli.md)              | Install, every command and flag, releases, CI               |
| [Connecting agents over MCP](docs/mcp-connect.md) | Claude Code, Codex, Cursor, HTTP, tokens, changesets, tasks |
| [LSP for editors](docs/lsp-connect.md)            | Neovim, Zed, capabilities, writing through LSP              |
| [Project storage](docs/project-storage.md)        | What's in a project, what to commit, what stays local       |

## License

[Apache-2.0](LICENSE). See [NOTICE](NOTICE).
