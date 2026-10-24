<p align="center">
  <img src="assets/hero.svg" alt="OpenTide: let your coding agent ship real apps. Fewer bugs, less review, fewer tokens." width="100%">
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
  <b><a href="#what-you-get">What you get</a></b> ·
  <b><a href="#how-it-works">How it works</a></b> ·
  <b><a href="#ship-it">Ship it</a></b> ·
  <b><a href="#docs">Docs</a></b>
</p>

---

**You asked your agent for a feature. It said "done". Now you're reading 900
lines of diff, running the tests it didn't run, and finding the bug it didn't
mention.**

OpenTide is the workspace that fixes that. Connect Claude Code, Codex or Cursor
over MCP and your agent builds inside a running app that keeps it honest:

- 🐛 **Fewer bugs reach you.** A change can't be marked done until tests the
  server ran itself cover every point in the plan.
- 👀 **You review in minutes, not hours.** Every change comes with its plan, its
  acceptance criteria and its evidence. You check the proof instead of
  reverse-engineering the diff.
- 🪙 **You spend fewer tokens.** The agent asks the app what exists instead of
  rereading your codebase, edits one function at a time, and gets errors that
  say exactly what to fix.
- 🔓 **You own the result.** One command exports a plain Deno or Node app. No
  platform fee, no lock-in, no API key. Bring the agent you already pay for.

<p align="center">
  <img src="assets/pillars.svg" alt="Fewer bugs, less review, fewer tokens" width="100%">
</p>

## Quick start

You need [Deno 2](https://deno.com). Four commands:

```sh
curl -fsSL https://github.com/opentideai/opentide/releases/latest/download/install.sh | sh
opentide scaffold ~/apps "Todo App" && cd ~/apps/todo-app
opentide mcp --print-config claude-code --project "$PWD" > .mcp.json
claude
```

Ask for something real:

> _Add a todos API with create, list and complete, backed by a table, with
> tests._

<p align="center">
  <img src="assets/session.svg" alt="A Claude Code session: plan, build, test, attest, complete" width="88%">
</p>

What you get back isn't a summary to take on faith. It's a finished change with
a plan, passing tests the server witnessed, and the evidence linked to each
acceptance criterion, already saved to files you commit.

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

## What you get

<table>
<tr>
<td width="50%" valign="top">

### 🐛 Fewer bugs reach you

The agent can't call a change finished on its own say-so.

- `complete_changeset` refuses until every acceptance criterion is backed by
  evidence.
- Evidence must cite **attestations** that the server mints when it runs
  `run_tests`, `check_export_types` or `verify_formal_specs`. Edit the code
  afterwards and the attestation goes stale.
- Before an agent edits something, `search_changes` tells it why the code is the
  way it is, so it doesn't undo a fix.
- `opentide build` boots the build and smoke-tests its routes before you ship.

</td>
<td width="50%" valign="top">

### 👀 You review in minutes

Every change is a **changeset**: a title, a plan with steps, acceptance
criteria, a verification plan, and the evidence that it was met.

- You read what was intended and what was proven, not a wall of diff.
- Every edit records its rationale, searchable later with `search_changes` and
  `get_change`.
- `project_status` gives you one verdict on the project's health, and
  `get_changeset_context` shows a change's plan and progress.
- The gate runs advisory, graduated or strict. You decide how hard it bites.

</td>
</tr>
<tr>
<td valign="top">

### 🪙 You spend fewer tokens

Most agent tokens go on rediscovering your code. Here the agent asks.

- `list_routes`, `list_handlers` and `list_schemas` return the app's structure
  directly, with no file crawling or grep loops.
- Edits are per entity: one handler, one route, one schema. The agent doesn't
  rewrite whole files to change one function.
- Errors are structured and specific. A mistyped argument comes back as
  `INVALID_ARGUMENTS` naming the right key, so it's fixed on the first retry.
- Claude Code loads OpenTide's tools on demand, so 109 tools don't sit in every
  prompt.

</td>
<td valign="top">

### ⚡ You see it working right away

No build-and-restart loop between "written" and "running".

- A handler is serving the moment it's defined. A route is on the preview port
  the moment it's registered. A schema change has run the moment it lands.
- The agent checks its own UI work with browser screenshots and scripted UI
  tests (`screenshot_app`, `test_app`) against the running app.
- You open `localhost` and click around while it's still working.

</td>
</tr>
<tr>
<td valign="top">

### ⏪ You never lose work

Agents go off the rails. Getting back is one call.

- `undo_change` and `undo_turn` step back one change or a whole agent turn.
- Abandoning a changeset **rewinds** the code, schema and files to where they
  started, and your app's data stays.
- Agent crashed, restarted, or you ran `/clear` mid-change? The next session
  calls `adopt_changeset` and carries on with the plan and progress intact.
- `take_snapshot` and `restore_snapshot` for anything bigger.

</td>
<td valign="top">

### 🔀 You go faster in parallel

Two agents, one project, no merge hell.

- `start_task` forks the project for a second agent, with its own server and
  preview.
- `merge_task` replays the fork onto main and completes it only if main's own
  tests pass.
- If two forks change the same thing, the second merge is refused with the
  conflicts named. You never get a silent overwrite.
- One writer at a time on main, enforced, so agents can't trample each other.

</td>
</tr>
<tr>
<td valign="top">

### 🔓 You own the result

- `opentide export` writes a standalone Deno app, and `opentide build` makes a
  deployable Deno or Node build.
- Apache-2.0, runs on your machine, uses your Postgres (PGlite locally, or any
  Postgres via `OPENTIDE_DB_URL`).
- No model inside and no API key. It works with the agent subscription you
  already have.

</td>
<td valign="top">

### 🔒 Safe by default

- The server listens on loopback only and needs a per-project bearer token.
- Secrets go through `define_secret`, never into code.
- `check_package_security` checks installed packages for known vulnerabilities
  and deprecations, with upgrade advice.
- Projects live in Git, and machine-local state stays out of commits. See
  [docs/project-storage.md](docs/project-storage.md).

</td>
</tr>
</table>

## How it works

<p align="center">
  <img src="assets/architecture.svg" alt="Agents connect over MCP to opentide serve, which runs the live preview and exports your app" width="100%">
</p>

One `opentide serve` per project holds the app. Its routes, handlers, schemas,
templates, migrations and tests live in a project database the server owns, and
they hot-swap the moment they're defined. Agents drive it through **109 MCP
tools**. Any number can connect; one at a time holds the pen.

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
a deployable build for **Deno or Node** (Node 24+).

## Good to know

- **Work lives in memory until it's flushed.** `complete_changeset` flushes it
  to `.opentide/state/`, which you commit. If it reports `stateFlushed: false`,
  the work exists only in the running server.
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
