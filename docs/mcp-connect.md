# Connecting an external agent over MCP

`opentide mcp` exposes a project's tool surface to external coding agents —
**Claude Code, Codex, Cursor** — over the Model Context Protocol. The agent
lists tools, creates a changeset, defines handlers / routes / functions /
schemas, runs checks, and builds. The server runs no model; your agent is the
loop.

From a clone, `deno task mcp …` is the same command.

## stdio vs HTTP

|                       | **stdio** (default)                                                                                             | **HTTP** (`--http`)                                  |
| --------------------- | --------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| Who starts the server | The **client spawns a bridge** from your config's `command`/`args`; the bridge finds or starts `opentide serve` | **You start it**; the client connects to a URL       |
| Config carries        | `command` + `args` (+ project path)                                                                             | a `url` + a bearer token                             |
| Best for              | Everything local. Several agents share one project                                                              | A client that only speaks HTTP                       |
| Transport             | JSON-RPC over stdin/stdout, relayed to serve's `/mcp`                                                           | Streamable-HTTP on `127.0.0.1:<port>/mcp` (loopback) |

`opentide serve` answers MCP at `/mcp` on its control port (default `3003`),
behind the token below. Point an HTTP client there. `opentide mcp --http` is a
separate standalone server on `3005` that holds the project alone.

### What the stdio bridge does

It reads `<project>/.opentide/kernel.lock` and checks with the OS whether its
holder is alive. A record left by a `kill -9` is ignored.

| The project is held by                  | The bridge                                                                                                                                   |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `opentide serve`                        | Attaches to it.                                                                                                                              |
| Nobody                                  | Starts `opentide serve` detached on a free port, then attaches. Prints the pid and the log path, `<project>/.opentide/serve.log`, to stderr. |
| `opentide mcp --standalone` or `--http` | Refuses with `PROJECT_ALREADY_OPEN`. Stop that and use serve.                                                                                |
| Anything else (e.g. `opentide lsp`)     | Gives up after 90 s with `SERVE_NOT_READY`.                                                                                                  |

- **A serve the bridge started exits on its own** 10 minutes after its last
  client disconnects, so it doesn't hold the project lock for days. To stop it
  sooner, `kill <pid>`; the pid is in the bridge's stderr and in `kernel.lock`.
  A serve you start by hand runs until you stop it.
- **If serve goes away mid-session** (it idled out, was stopped, or Tide took
  the project over), the bridge finds the project's serve again, starting one if
  nothing holds the project, and replays the client's `initialize` there. The
  client stays connected. A call in flight when serve went away fails with
  JSON-RPC error `-32000`; retry it. After three failed tries the bridge exits
  with code 1.
- **Tide can take a project over from a serve the bridge started.** Opening the
  project in Tide offers **Open here**, which asks that serve to close the
  project and exit, then opens it in Tide. Your client's bridge moves to Tide's
  kernel by itself. Takeover works on any `opentide serve --project`, including
  one you started by hand. It's refused while a changeset is in progress, and a
  launcher-mode kernel (one with its own IDE) can't be taken over.
- **`--standalone`** is an in-process stdio server. It takes the project for
  itself; use it where nothing else should touch the project, like CI.

Start the server yourself for HTTP. Pin the token first, so the client config
keeps working across restarts:

```sh
export OPENTIDE_MCP_TOKEN=$(openssl rand -hex 32)
opentide mcp --project /abs/path/to/project --http            # port 3005
opentide mcp --project /abs/path/to/project --http --port 4000
```

### The bearer token

Every HTTP request needs `Authorization: Bearer <token>`. No token or a wrong
one gets `401`; a non-loopback `Host` or a foreign `Origin` gets `403`.

| Where the token comes from | When                                         |
| -------------------------- | -------------------------------------------- |
| `OPENTIDE_MCP_TOKEN`       | Set in the server's environment. Used as-is. |
| Fresh 32 random bytes      | Otherwise, minted on every project open.     |

Either way the server writes it to `<project>/.opentide/kernel.token` (mode
`0600`) and deletes it on shutdown. The printed HTTP configs read
`OPENTIDE_MCP_TOKEN` from the client's environment, so set it there too. If you
didn't pin it, read the file:

```sh
cat /abs/path/to/project/.opentide/kernel.token
```

For stdio you don't run anything yourself — the client launches the process from
its config.

## Generating config

Don't hand-edit the static blocks below. Generate the exact config for your
client:

```sh
opentide mcp --print-config claude-code --project /abs/path/to/project
opentide mcp --print-config codex      --project /abs/path/to/project
opentide mcp --print-config cursor     --project /abs/path/to/project --http
```

From an install, the stdio config runs the `opentide` launcher. From a clone,
`deno task mcp --print-config …` emits a `deno run … cli/mcp-main.ts` line
derived from the `mcp` task, so the permission flags match the task.

`--print-config <client>` prints to stdout and exits; it starts no server. Add
`--http [--port N]` for the HTTP form, which references `OPENTIDE_MCP_TOKEN`
rather than holding the token. Without `--project`, the stdio form carries a
`/absolute/path/to/your/project` placeholder to replace.

### First-run notes

- **Leave serve running.** The stdio bridge attaches to whatever serve already
  has the project. Only `--standalone` and `--http` load it themselves, and
  they're refused with `PROJECT_ALREADY_OPEN` if anything else holds it.
- **Restart the client after adding the server.** Coding agents discover MCP
  servers at startup, so restart the client (e.g. Codex) after writing the
  config, and it spawns the bridge and lists the `opentide` tools.
- **First run writes to `~/.config/opentide/` and may prompt for permissions.**
  Loading a project registers it in `~/.config/opentide/registry.json`; a
  sandboxed client will prompt to allow that write (and the project's data dir)
  the first time. Approve it once.
- **Cold start.** When no serve is running, the first spawn starts one, which
  compiles the kernel graph and opens the database. Expect a few seconds; the
  generated Codex config sets its startup timeout to 30 s to cover it.

## A folder of apps

Point `opentide mcp` at a folder that isn't itself a project, and it serves the
apps directly inside it:

- `list_projects`: the apps in the folder, and which one is open.
- `open_project <name>`: every other tool acts on that app from the next call,
  in the same chat. Starts its `opentide serve` if it isn't running.
- `new_project <name>`: creates an empty app in the folder (the name in
  lowercase, with dashes) and opens it.

Until an app is open, the other tools answer "No app is open" and name the apps
there.

- **Named with `--project`** (the Desktop extension, a client config): the whole
  tool list is there from the start. Claude Desktop only picks up a changed tool
  list in a new chat, so this is what lets an open work in the chat that asked
  for it.
- **The directory a client started in** (the Claude Code plugin): only the three
  app tools until one is open, so a directory with nothing to do with OpenTide
  costs a few hundred tokens, not the whole surface. Opening an app tells the
  client its tools changed; Claude Code picks them up mid-turn.
- **The last-opened app is remembered** per folder, in
  `~/.config/opentide/mcp-workspaces.json`, and opened again when the client
  restarts the server.
- **Only direct children count.** `~/apps/todo` is found from `~/apps`;
  `~/apps/work/todo` isn't.
- **One open app per server process.** Claude Desktop runs every chat on one
  process, so two chats working on different apps at once switch it under each
  other. To keep a Desktop project on one app, put this in the project's
  instructions:

```text
This project is the OpenTide app todo-app. Before any other OpenTide tool, call open_project with name "todo-app".
```

## Claude Code

### The plugin

```sh
claude plugin install opentide --marketplace opentideai/opentide
```

On Claude Code older than 2.1.275, inside a session:

```text
/plugin marketplace add opentideai/opentide
/plugin install opentide@opentide
```

It installs for your user, not one project. Claude Code starts its server in the
directory you launch it from, and `opentide mcp` serves that directory when it
holds an `opentide.json`.

- **The server** shows in `/mcp` as `plugin:opentide:opentide`. Its tools are
  named `mcp__plugin_opentide_opentide__<verb>`.
- **The commands** are the server's four prompts, as `/opentide:start`,
  `/opentide:change <goal>`, `/opentide:land [changeset_id]` and
  `/opentide:recover`. Only you can run them; Claude doesn't invoke them on its
  own.
- **Outside an OpenTide project** the server lists only `list_projects`,
  `open_project` and `new_project`, for the apps directly under that directory
  (see [A folder of apps](#a-folder-of-apps)). Open one and the rest of the
  tools appear in the same session.
- **Without `opentide` installed** the server shows as failed. The plugin looks
  for `opentide` on your PATH, then at `~/.opentide/bin/opentide`, and otherwise
  exits with the install command on stderr. `claude mcp list` shows only
  `Connection closed`.

Don't also `claude mcp add` the same project: every tool would load twice.

Tested end to end with Claude Code 2.1.310 and OpenTide 0.1.3, plugin installed
from the marketplace: all four commands ran, and `/opentide:change` landed a
route with its test.

### Without the plugin

Project-scoped config lives in `.mcp.json` at your project root. `type` is
explicit; HTTP requires it.

**stdio** — the client spawns the bridge:

```json
{
  "mcpServers": {
    "opentide": {
      "type": "stdio",
      "command": "/Users/you/.opentide/bin/opentide",
      "args": ["mcp", "--project", "/abs/path/to/project"]
    }
  }
}
```

**HTTP** — start `opentide mcp … --http` first, then:

```json
{
  "mcpServers": {
    "opentide": {
      "type": "http",
      "url": "http://127.0.0.1:3005/mcp",
      "headers": { "Authorization": "Bearer ${OPENTIDE_MCP_TOKEN}" }
    }
  }
}
```

Or via the CLI:

```sh
# stdio, run from the project directory (everything after -- is the spawn command)
cd /abs/path/to/project && claude mcp add opentide -- opentide mcp

# http
claude mcp add --transport http opentide http://127.0.0.1:3005/mcp \
  --header "Authorization: Bearer $OPENTIDE_MCP_TOKEN"
```

`claude mcp add` registers the server for the directory it's run in, and Claude
Code starts it there, so `opentide mcp` finds the project without `--project`.
`.mcp.json` has no per-server `cwd`, so a command written there must be an
absolute path.

## Codex

The quickest way is Codex's own CLI, which writes `~/.codex/config.toml` for
you:

```sh
codex mcp add opentide -- ~/.opentide/bin/opentide mcp --project /abs/path/to/project
```

The Codex CLI and the IDE extension read the same file. Whether the Codex
desktop app does too hasn't been checked.

Tested end to end with Codex CLI 0.161.0 and OpenTide 0.1.3: `codex exec` landed
a route with its test. Codex doesn't put all 109 tool schemas in every turn: the
first turn was 16k input tokens in all, less than the ~25k the schemas alone
would take, and 92% of the run's input was cached. The IDE extension hasn't been
run.

Config lives in `~/.codex/config.toml`, one `[mcp_servers.<name>]` table per
server. Codex infers the transport from the keys present — `command` ⇒ stdio,
`url` ⇒ streamable-HTTP — there is no `type` field.

**stdio:**

```toml
[mcp_servers.opentide]
command = "/Users/you/.opentide/bin/opentide"
args = ["mcp", "--project", "/abs/path/to/project"]
startup_timeout_sec = 30
```

`startup_timeout_sec` is raised from Codex's default (10 s) to cover the cold
start. From a clone, the generated config also sets `cwd` to the repo root, so
the task's `--env` finds `.env`.

**HTTP** — start `opentide mcp … --http` first, then:

```toml
[mcp_servers.opentide]
url = "http://127.0.0.1:3005/mcp"
bearer_token_env_var = "OPENTIDE_MCP_TOKEN"
```

> **Codex HTTP caveat.** Streamable-HTTP runs on Codex's Rust MCP client
> (`rmcp`). On older releases it is gated behind
> `[features]\nrmcp_client = true` (formerly
> `experimental_use_rmcp_client = true`). If an HTTP server won't connect,
> upgrade Codex (`codex --version`) or enable that feature. stdio has no such
> caveat.

## Cursor

Config lives in `.cursor/mcp.json` (project) or `~/.cursor/mcp.json` (global).
Same object shape as Claude Code, but **no `type` field** — Cursor infers the
transport from `command` vs `url`.

Tested end to end with the Cursor CLI (`cursor-agent` 2026.10.22) and OpenTide
0.1.3, stdio config in the project's `.cursor/mcp.json`: it landed a route with
its test. The Cursor editor hasn't been run.

**stdio:**

```json
{
  "mcpServers": {
    "opentide": {
      "command": "/Users/you/.opentide/bin/opentide",
      "args": ["mcp", "--project", "/abs/path/to/project"]
    }
  }
}
```

**HTTP** — start `opentide mcp … --http` first, then:

```json
{
  "mcpServers": {
    "opentide": {
      "url": "http://127.0.0.1:3005/mcp",
      "headers": { "Authorization": "Bearer ${env:OPENTIDE_MCP_TOKEN}" }
    }
  }
}
```

## Claude Desktop

### The extension

Download `opentide.mcpb` from the latest release:

```
https://github.com/opentideai/opentide/releases/latest/download/opentide.mcpb
```

Double-click it, or in Claude Desktop use Settings → Extensions → Advanced
settings → Install Extension…, and pick it. Desktop asks for **Apps folder**:
choose where your apps live, say `~/apps`. Claude creates, lists and opens apps
there itself (see [A folder of apps](#a-folder-of-apps)). One app's own folder
works too, and then the extension serves only that app.

- It bundles no runtime. A small Node script, run on Desktop's own Node, starts
  `~/.opentide/bin/opentide mcp --project <folder>` (`$OPENTIDE_HOME/bin` if you
  set it). Desktop doesn't use your shell's PATH, so an `opentide` installed
  anywhere else isn't found.
- OpenTide not installed: the extension still shows as running, with one tool,
  `opentide_setup`. Ask Claude to do anything with OpenTide and it gives you the
  install command. Install, then turn the extension off and on in Settings →
  Extensions.
- A `~` at the start of **Apps folder** is expanded to your home folder.
- "Show me the app" renders it live in the chat (see
  [Seeing the app](#seeing-the-app)).
- Desktop starts the extension twice: once for chats, once for Cowork and Code
  sessions. An app opened in a chat doesn't switch a Cowork session that's
  already running; it picks up the last-opened app when it next starts.
- The extension isn't signed, so Desktop shows it as unverified when you install
  it.
- macOS and Linux only, like `install.sh`.
- Tested end to end in Claude Desktop against a project: it landed a route with
  its test. Use OpenTide 0.1.4 or later, with the extension from the same
  release. In 0.1.3 the extension couldn't start, and Desktop's Cowork and Code
  sessions couldn't connect either.

### Without the extension

Claude Desktop also reads `claude_desktop_config.json` (Settings → Developer →
Edit Config). Print the entry and merge its `mcpServers` into that file:

```sh
opentide mcp --print-config claude-desktop --project /abs/path/to/project
```

It launches local stdio servers only; `--http` still prints the stdio form. The
command is the launcher's absolute path, because a desktop app doesn't inherit
your shell's PATH. Restart Claude Desktop after editing. Pass a folder of apps
as `--project` and one entry serves all of them.

## Any other MCP client

Windsurf, VS Code, Zed, Cline or your own client: anything that can launch a
stdio MCP server works. Register one server with

| Field   | Value                                                                             |
| ------- | --------------------------------------------------------------------------------- |
| command | `opentide`, or `~/.opentide/bin/opentide` if the client doesn't inherit your PATH |
| args    | `mcp`, `--project`, `/absolute/path/to/your/app`                                  |

`--print-config cursor` prints the generic `mcpServers` JSON shape most clients
accept. A client that only speaks HTTP connects to `opentide serve`'s `/mcp`
with the bearer token (see [stdio vs HTTP](#stdio-vs-http)).

Claude Code has been run end to end against OpenTide. Codex, Cursor and every
other client use the same stdio protocol and config shape, but none of them has
been run end to end yet.

## Seeing the app

`show_app` shows the user the running app. Ask Claude to "show me the app".

- **Claude Desktop** renders it live under the tool call: click, type and
  navigate in it. **Open in browser** opens the same page outside the chat.
- **Every other client** gets the app's URL to open.
- **How it works:** Desktop won't frame a `127.0.0.1` page, so the preview
  fetches the app's HTML itself and renders that. The page's `fetch`/XHR calls,
  links and form posts are redirected to the app. Three gaps:
  - a script that builds a URL from `location` gets the sandbox's;
  - a relative `url()` in an inline `style` won't load;
  - `history.pushState` updates the path shown above the preview, not the page.
- **An app with no routes** has no server yet. The preview says it couldn't
  reach the app.

`screenshot_app` and `test_app` need a browser:

- tried in this order: Playwright's own Chromium; an installed Google Chrome,
  then Microsoft Edge; a distro Chromium (`/usr/bin/chromium`,
  `/usr/bin/chromium-browser`, `/snap/bin/chromium`); Playwright's own Firefox.
  A Firefox you installed yourself doesn't count, since Playwright can only
  drive its own patched build;
- headless, unless `OPENTIDE_BROWSER_HEADFUL=1`;
- with none of those, they fail and say how to install Chromium:

```sh
deno run -A npm:playwright@1 install chromium
```

## What the external agent does

MCP projects a **tool catalog, not a loop**. Your agent reads the app, decides
what to write, and drives the changeset flow; the server supplies the tools, a
short rulebook and the gate. The repair strategy is yours.

### What the server tells the agent

| Channel               | What it carries                                                                                                                                                                                                                                                     | Reaches the model                                                     |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| Server `instructions` | Ownership rules, the changeset loop, what to do when storage breaks. Then the project's own rules (`set_system_prompt`), if they fit. Source: `core/agent-guide.ts`.                                                                                                | On connect, in the system prompt. Nobody has to ask.                  |
| `project_status`      | Verdict (`ok` / `attention` / `stop`) and one line per problem: consistency errors, memory against `.opentide/state`, unreachable code, the active changeset, the surface version, the project's rules in full (`projectRules`), and its enabled skills (`skills`). | When the agent calls it. The instructions tell it to, first.          |
| `INVALID_ARGUMENTS`   | A refusal naming the argument the agent meant (`query` → `sql`, `code` → `source`, `status: "completed"` → `done`). camelCase/snake_case spellings of a declared key are accepted and renamed. Source: `core/tools/validate-args.ts`.                               | On the wrong call.                                                    |
| A refusal             | `Error [CODE]: message`, then `Suggestion: …` on a line of its own. When the refusal found something, such as `complete_changeset`'s readiness report, a second text block carries it as JSON.                                                                      | On the refused call.                                                  |
| Tool descriptions     | `create_changeset` and `amend_changeset_plan` say they auto-approve.                                                                                                                                                                                                | Always. Clients don't show the model a tool's `_meta` or annotations. |
| Prompts               | `start`, `change <goal>`, `land [changeset_id]`, `recover`. In Claude Code: `/opentide:start`, `/opentide:change add a dark mode toggle`. Source: `mcp/mcp-prompts.ts`.                                                                                             | Only when a human types one.                                          |

Two limits. **Claude Code cuts a server's instructions at 2,048 characters**,
silently. `CLAUDE_CODE_MAX_MCP_DESCRIPTION_LENGTH` raises the cap. The general
rules take most of that, so a project's rules that don't fit are not inlined;
the instructions point at `project_status` instead, which returns them whole.
Second, argument checking runs **on the MCP face only**. The built-in chat agent
on the control API still dispatches unchecked.

### Where the tokens go

Turn-by-turn reasoning bills to your client — its subscription or its key — not
to OpenTide. No MCP verb calls a model; the ones that used to hand the work
back:

| Verb                                             | In OpenTide                                                                                                  |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------ |
| `request_review`, `submit_review`                | The server builds the packet and checks the verdict. Your client runs the review on its own model.           |
| `complete_changeset`                             | Reads the verdicts you submitted. It never refutes or reviews on its own.                                    |
| `index_codebase` with `classification: "assist"` | Builds the index and returns classification `review_owed`. Classify with `request_review {kind: "imports"}`. |
| `git_commit` with no `message`                   | Builds the subject from the staged file list. Write the message yourself for a better one.                   |

For verification, use the deterministic checks: `qc`, `run_tests`,
`check_export_types`, `test_coverage`.

## Driving a changeset to completion

Intent-approval is auto-satisfied over MCP, for amendments too: an
`amend_changeset_plan` that sends the changeset back to `planning` is
re-approved and restarted in the same call. The **completion gate is not**
auto-satisfied, and these are the failure modes worth knowing.

### Letting the user approve the plan

Pass `await_approval: true` to `create_changeset` or `amend_changeset_plan` and
the changeset waits in `planning`, the way the IDE chat's plans do. Nothing can
change the project until it starts. Two things start it:

- **The user, in the IDE:** the plan's **Approve** button.
- **You, once the user says yes:**

  ```
  approve_changeset { changeset_id: "cs_…" }
  ```

A light-lane plan needs no person. Start it with `light_lane: true`; that's
refused unless the class is `light` and not escalated, and the changeset is
stamped `autoApproved`, never recorded as a human approval.

Serve doesn't check who approved. Approval is between you and your user.

`get_changeset` returns a changeset as stored: the full plan, attestations and
message anchors. Without `changeset_id` it returns the session's active one, or
`null`. It's bigger than `get_changeset_context`; reach for it when you need the
record itself.

### One writer per project

Every write lands in the live kernel straight away, and readiness is judged on
the whole project, so only one session can hold an active changeset (`planning`,
`approved` or `in_progress`) at a time. That includes the built-in chat agent on
the control API.

- **A second session's `create_changeset` fails with `CHANGESET_ACTIVE`.** The
  error names the holder's changeset, its session and its age. Wait, or free it.
  `project_status` shows the same thing up front, as `heldElsewhere`.
- **An agent can only abandon its own changeset.** `abandon_changeset` on
  another session's returns `CHANGESET_NOT_OWNED`.
- **A client that's gone leaves its changeset for the next one.** That covers
  Claude Code after `/clear` or a restart, a crash, or the server itself
  restarting. The next client's `create_changeset` gets `CHANGESET_ACTIVE`
  saying nobody is driving it, and `project_status` shows
  `heldElsewhere.orphaned: true`. From there:
  - `adopt_changeset` moves the changeset to the new session with its plan and
    step statuses, and work carries on.
  - `abandon_changeset` from any session rewinds it instead.

  "Gone" means one of these:
  - the client disconnected;
  - this server process has never seen it (the server restarted since);
  - it made no call for 30 minutes (`MCP_SESSION_IDLE_MS`). This is the case for
    a client killed without closing its connection.

  While the owner is connected, `adopt_changeset` returns `CHANGESET_HELD`.
  Changesets from a non-MCP chat session are never adoptable.
- **A person can always free the project:** `POST /api/changesets/<id>/abandon`
  on the control API. Abandoning rewinds code, schema and project files to where
  they were when the changeset started. App rows stay. A changeset with no start
  snapshot, or with a migration that can't be reversed, is abandoned without
  rewinding.

For two agents working at once, use [tasks](#running-tasks-in-parallel).

### The session record

The server creates one session per instance — stdio has a single instance, the
HTTP transport builds one per client connection — on the first `tools/call`.
It's named after the `clientInfo.name` the client sent in `initialize`, plus a
random tag: **<name> (MCP) #3f9a**. A client that sends no name gets **External
MCP agent #3f9a**. The tag is there because a client sends the same name every
time (Claude Code always sends `claude-code`), and two sessions would otherwise
read the same. Changesets and changelog records store that id, and that name is
what a second session sees in `CHANGESET_ACTIVE`.

To pick the session yourself, call `open_session` first:

```
open_session { }                                   → a new project session
open_session { name: "Billing", visibility: "private",
               owner: { id: "u_1", display_name: "Ada" } }
open_session { session_id: "session_…" }           → resume it; reopens if ended
```

Every later call on the connection, history writes and changes alike, belongs to
the session it returns. Call it again to switch. The session you leave stays
open. Without a `name`, an empty session of the same owner is reused rather than
starting another. Calling it first means the server never starts a session of
its own.

The session is a real record under `.opentide/history/sessions/`. The
consistency check (`core/project-doctor.ts`) counts a reference to a missing
session as an **error** (`CHANGESET_SESSION_MISSING`), and the readiness gate
refuses to look past any consistency error, so don't delete session files.

The record starts empty. These verbs fill it, and all of them act on the calling
session only:

| Verb                      | What it writes                                                                                                                                                                                              |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `append_session_messages` | Messages, up to 50 a call. `change_ids` links a message to change records; `plan_for` and `approves` anchor it to a changeset. `tool_calls` and `author_user_id` are kept with the message.                 |
| `link_session_message`    | Links a message already appended: `changes` (each `{id, rationale?, implementation?}`) to change records, `plan_for`, `approves` and `work_for` to a changeset. Returns the updated records and changesets. |
| `set_session_summary`     | The session's summary, which replaces the last one, and/or a `metadata` object merged into the session's metadata. A `null` value removes that key.                                                         |
| `record_usage`            | One model call's tokens. Calls with the same `turn_id` add up to that turn, and the result returns the total as `turn`. Recording the same `id` again replaces it. Stays on the machine.                    |
| `manage_sessions`         | `rename` and `end` default to the calling session. `list` and `search` cover every session.                                                                                                                 |

The change ids come from the call that made the change. Any call that writes to
the changelog gets one more text block at the end of its result:

```json
{
  "changes": [{ "id": 412, "scope": "handler:get_user", "action": "update" }],
  "changesets": [
    {
      "id": "cs_…",
      "status": "in_progress",
      "steps": { "done": 1, "total": 3 }
    }
  ]
}
```

`changesets` lists each changeset the changes landed in. A call that changed
nothing has no such block.

To tie a call's changes to a turn of your own, put the turn in the call's
`_meta` under `opentide/turn`. The change records it makes carry it:

```json
{
  "name": "define_handler",
  "arguments": { "name": "get_user", "source": "…" },
  "_meta": {
    "opentide/turn": {
      "turn_id": "turn_…",
      "turn_index": 3,
      "tool_call_id": "toolu_…",
      "user_message": "add a user lookup"
    }
  }
}
```

`turn_id` is required for the rest to count. Without it the call works as
before.

A link that can't be made (an unknown change id, or `approves` on a changeset
still in `planning`) doesn't fail the call. The message is stored and the result
carries a `warnings` list.

Documents a message cites go through `document_write`:

```
document_write { action: "create", name: "shot.png", kind: "image/png",
                 content_base64: "iVBOR…", attachment: true }
document_write { action: "ref", id: "doc_…", message_id: 1730…,
                 role: "attachment" }   ← or "mention"
```

`attachment: true` records the document as the user's. A ref takes a message in
your own session. `document_query` reads bytes back with `encoding: "base64"`,
and `action: "pinned"` lists the session's working set.

`get_session_context {session_id}` reads a past session's messages and summary:
the first 50 messages, or all of them with `messageLimit: 0`. It serves this
project only: `project_path` or `project_name` naming another project fails with
`OTHER_PROJECT`.

Your session's history is the project's. It's stored in `.opentide/history/` and
travels with the code through git. Sessions marked private (Tide's chat, by
default) are stored in `.opentide/history/private/`, which ignores itself, so a
commit never ships them. Each leaves a tracked marker in
`.opentide/history/private-sessions/` with its id and owner, so changesets made
in it still check out on a clone.

### Completing a changeset commits it

**Off unless `opentide.json` turns it on** in this release:

```json
{ "name": "notes", "commitOnComplete": true }
```

When it's on and `complete_changeset` passes the gate, it commits the work. The
result carries `commit`:

| `commit`                                              | Meaning                                                           |
| ----------------------------------------------------- | ----------------------------------------------------------------- |
| `{"committed": true, "sha": "…"}`                     | Committed.                                                        |
| `{"committed": false, "reason": "nothing_to_commit"}` | Nothing of OpenTide's changed.                                    |
| `{"committed": false, "reason": "off"}`               | `commitOnComplete` isn't `true`.                                  |
| `{"committed": false, "reason": "no_project"}`        | No project loaded.                                                |
| `{"committed": false, "reason": "failed", "message"}` | Git refused. The changeset is still complete. `message` says why. |

What goes in:

- `.opentide/state/` and `.opentide/history/`, minus machine-local telemetry and
  private sessions;
- `opentide.json`, `assets/` and `fixtures/`;
- project files the changeset wrote through OpenTide (`write_project_file`,
  `apply_project_file`, `generate_project_docs`).

Nothing else. Your other modified, staged or untracked files stay as they were:
the commit is made with `git commit --only`, so what you staged stays staged and
out of it. A project with no repo gets one, with OpenTide's `.gitignore`. The
commit message is the changeset title.

Your hooks run. A pre-commit hook that fails, or a repo with no
`user.name`/`user.email`, gives `reason: "failed"`.

`"commitOnComplete": false` also stops Tide's per-step checkpoint commits, which
otherwise run whatever the setting.

To make the same commit yourself, mid-changeset, pass the changeset to
`git_commit`. It commits what landing would, and nothing else in the work tree:

```
git_commit { changeset_id: "cs_…", message: "step 2: add the route" }
```

The message is required. `{committed: false}` means nothing had changed, or the
project turned commits off.

History you append after completing (`append_session_messages`,
`set_session_summary`) goes into the next commit.

### Reading what the gate is complaining about

`PROJECT_CONSISTENCY_ERRORS` and `PROJECT_CONSISTENCY_WARNINGS` point at
`project_status`, which runs the same consistency check (`doctorProject`) and
lists every error with its code, path and message. `doctor_project` itself is
not on the surface (`AGENT_TOOL_EXCLUDE` in `core/tools/definitions.ts`);
`project_status` covers it.

### Reviewing a change yourself

The server never calls a model to review. It tells you what to review, hands you
the code, and records your verdict; your model does the reviewing.

1. `request_review {kind}` returns a packet: `packetId`, `instructions`, the
   code to review and `response`, the shape of the answer.
2. Run the packet in a fresh context: a subagent, or a new conversation. Not the
   one that wrote the code.
3. `submit_review {packet_id, verdict, reviewer}`.

| `kind`     | Also takes                                                                           | The packet carries                                                                                     | The verdict                                                                                     |
| ---------- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------- |
| `refute`   | `changeset_id`, `claim_ids`, `force`                                                 | `claims`, each with a `contextId` into `contexts`; `reused`, the claims with a verdict on current code | `{results: [{claimId, refuted, confidence, counterexample, reasoning}]}`, one or more per claim |
| `criteria` | `changeset_id`                                                                       | `request`, the user's words (`requestFromUser: false` if only the title was found), and `context`      | `{criteria: [{text, priority, rationale}]}`                                                     |
| `audit`    | `category` (built-in, or one from `define_audit`)                                    | `instructions` with the audit's prompt, and `context`, the whole project                               | `{issues: [{severity, rule, message, entity, line, suggestion}]}`                               |
| `imports`  | nothing: it classifies the last `index_codebase` run with `classification: "assist"` | `request`: the graph summary, package and framework hints, and source excerpts                         | `{facts, mappings, diagnostics, candidateEntities}`                                             |

- **Refute.** A claim is refuted only by an attempt with `refuted: true`,
  `confidence: "high"` and a `counterexample`. Each claim gets an `adversarial`
  attestation. A refuted claim blocks `complete_changeset` (`CLAIM_REFUTED`)
  until a fresh review says otherwise. With no `claim_ids` the packet covers the
  `must` claims without a fresh verdict; an empty `claims` means nothing is
  owed.
- **Criteria.** The reviewer never sees the plan's criteria. The server compares
  afterwards, and each proposal no criterion covers is an
  `UNCOVERED_INDEPENDENT_CRITERION` warning.
- **Audit.** Stored like any audit (`list_audits`), with an `audit` attestation.
- **Imports.** Merged into the codebase graph (`GET /api/codebase`); no
  attestation, and no registry writes. Mappings under 0.75 confidence aren't
  applied. Indexing again makes the packet stale. Without a pending assist-mode
  index, `request_review` refuses with `NO_INDEX_TO_CLASSIFY`.

What `submit_review` refuses:

| Code                      | When                                                          | The packet                     |
| ------------------------- | ------------------------------------------------------------- | ------------------------------ |
| `STALE_REVIEW`            | The code changed after the packet was issued.                 | Request a new one.             |
| `INVALID_VERDICT`         | The verdict doesn't match `response`, or misses a claim.      | Still open. Fix it and resend. |
| `REVIEW_PACKET_USED`      | The packet was already answered.                              | Request a new one.             |
| `REVIEW_PACKET_NOT_FOUND` | Unknown id. Packets live in memory until the server restarts. | Request a new one.             |

Attestations from `submit_review` carry `producer: "client"` and the `reviewer`
you named, in the changeset and in the verification ledger. A pass from the
agent that wrote the code is weaker evidence than its refutation, and nothing
proves it used a fresh context; the marking is there so a reader can tell.

`get_code_context` hands you the same code without a packet:

| Call                                              | Returns                                                                     |
| ------------------------------------------------- | --------------------------------------------------------------------------- |
| `get_code_context {changeset_id, claim_id}`       | The claim's formal-spec targets and tests; failing those, what changed.     |
| `get_code_context {changeset_id}`                 | Every entity the changeset changed.                                         |
| `get_code_context {scopes: ["handler:get_user"]}` | Those entities. Also `function:`, `template:`, `test:`, `route:GET /users`. |
| `get_code_context {}`                             | The whole project.                                                          |

Output is capped at 40,000 characters, and a scoped call at 12 entities.
`list_tests {claim_id}` names the tests that verify a claim.

### `must` criteria

A `must` criterion with no refute review against the current code raises
`MUST_CLAIM_UNREVIEWED`, a warning (an error under `strict`). Nothing runs the
review for you: request one before `complete_changeset`. `change_class:
"light"`
can't carry a `must` criterion, so it never needs one.

A criterion with no priority is stored as `should`, and so is one written as a
bare string (`normalizeAcceptanceCriteria`), so `must` is only ever chosen on
purpose. Over MCP, `create_changeset` and `amend_changeset_plan` warn about
every `must` criterion in their result. A priority can't be lowered once the
changeset has started.

### Warnings that never block

`run_tests`, `check_export_types`, and `test_coverage` mint kernel attestations
and discard the returned id (`core/tools/dispatch.ts`), so nothing can cite one
in `record_verification_run` evidence. Every such run raises:

```
UNATTESTED_EVIDENCE: unit evidence "ev_suite" is not backed by a kernel attestation.
```

It is a warning and never blocks completion. The ids are minted and counted
(`attestations`, `staleAttestations`), just never handed back.
`verify_formal_specs` returns its id.

The gate also reports an AGENT.md that disagrees with the registry:

```
DOCS_STALE_ENTITIES: AGENT.md documents 63 entities that no longer exist:
handlers (acceptProposal, agentCreateDocument, +61 more).
DOCS_MISSING_ENTITIES: AGENT.md omits 13 registered entities: routes (…).
```

Both are warnings and neither blocks. They fire on _contradiction_, not
staleness — a doc one handler behind says nothing, a doc naming entities the
registry does not have says both. The remedy is one call to
`generate_project_docs`, inside the open changeset: like every writer, it needs
one in progress. The check covers routes, handlers and functions; schemas,
configs and env vars are documented but not checked.

## Running tasks in parallel

A task is a fork of the project: a full copy of its files, state and database,
running under its own `opentide serve`. One agent works in each fork, and the
fork merges back into the project ("main") when its work is done.

### Start a task

Call `start_task`:

```json
{
  "title": "Add GET /api/invoices",
  "claims": ["handler:listInvoices", "route:GET /api/invoices"]
}
```

- **`claims` lock nothing.** They're optional `category:key` scopes, used only
  to flag overlaps with other open tasks. The result lists them in `overlaps`.
- **Main's half-done work stays out of the fork.** If main has a changeset open,
  the fork starts from where that changeset started.
- **Refusals:**
  - `TASK_LIMIT`: the project already has 4 open tasks.
  - `TASK_IN_FORK`: the call came from inside a fork. Start tasks from main.
  - `TASK_NO_CLEAN_POINT`: main's open changeset has no start snapshot.
  - `TASK_SOURCE_BACKED`, `TASK_EXTERNAL_DB`: this project can't be forked.

The same thing from a terminal:

```bash
opentide task start --project <path> --title "Add GET /api/invoices" --claim handler:listInvoices
```

### Point a client at the fork

You can't work in a fork over the connection that started it. Claude Code
subagents share their parent's MCP connection, so they can't either. Each fork
needs a client of its own. `start_task` returns `connect`:

- **`connect.claudeCode`** is a command that starts Claude Code in the fork,
  with only the fork's server. To run it headless, append
  `--allowedTools mcp__opentide -p "<instructions>"`; without `--allowedTools`
  every tool call is denied.
- **`connect.mcpServers`** is the server entry, for any other client.

Both start the stdio bridge, which attaches to the fork's running serve.

The agent in the fork works the usual way: `create_changeset`, the work,
`run_tests`, `complete_changeset`.

### Merge

Call `merge_task`:

```json
{ "task_id": "task_3f9a1c2b7d4e" }
```

Merge replays what the fork changed onto main, under a new changeset. It then
runs main's tests and completes that changeset only if main's own verification
passes.

- **What merges:** schema, handlers, functions, routes, templates, assets,
  tests, types, configs, env var definitions, packages, dev views and tools,
  audits, and text files.
- **What doesn't:** app rows, documents and secret values. `notMerged` lists
  them.
- **`outcome`** is one of:
  - `merged`: landed and verified.
  - `unverified`: landed, but main's changeset didn't pass its gate. It stays
    open and `readiness` says why. A main with no tests always lands here.
  - `apply-failed`: stopped partway. What landed stays, under an open changeset.
- **Refusals:**
  - `TASK_BUSY`: the fork's changeset is still open, or another process holds
    the fork. Complete the changeset in the fork first.
  - `CHANGESET_ACTIVE`: main has a changeset open.
  - `TASK_MERGE_BLOCKED`: main changed the same entities since the fork, or the
    fork has a binary file, a dropped table or an undone migration. The error
    names each one. There's no rebase: discard the task and redo it from main.

`list_tasks` shows every task with its status, port, claims and overlaps.
`discard_task` stops the fork's serve and deletes the fork. Anything not merged
is gone; a merged task stays `merged`.

## Your registry changes are not on disk until something flushes

**This is the one that loses work.** The registries — routes, handlers,
functions, templates, assets, tests, types, configs — live in memory and are
loaded from the project's state directory (`.opentide/state/`, via
`loadKernelState` in `core/project-loader.ts`). PGlite holds your _application_
data; it does not hold the registry. Until the state directory is written,
everything you defined or removed this session exists only in the server
process.

The other flush paths hang off things an MCP session usually doesn't do:

| Flush path                               | Who triggers it                         |
| ---------------------------------------- | --------------------------------------- |
| control-server REST write routes         | a REST client                           |
| agent-loop per-step checkpoint           | the built-in chat agent                 |
| `git_status` / `git_commit` / `git_push` | a git verb, deliberately or by accident |
| `unloadProject`                          | a clean shutdown (SIGINT/SIGTERM)       |

A headless session that defines and removes entities for an hour, never touches
git, and is then killed with `SIGKILL` loses all of it — the next load replays
the stale state directory and the removed entities come back.

Two things close that gap:

- **`complete_changeset` flushes.** It is best-effort: the returned
  `stateFlushed` boolean tells you whether the write happened, and a failure
  logs at `warn`/`system` rather than failing the completion.
- **`complete_changeset` commits, when `commitOnComplete` is on.** See
  [Completing a changeset commits it](#completing-a-changeset-commits-it).
- **`flush_project_state`** is the explicit verb for work outside a changeset,
  or before ending a long session. It writes only the project's state directory
  — no git operations, no database writes — and returns the path plus live
  entity counts.

```
flush_project_state  { }
→ { stateDir: "…/.opentide/state", routes: 39, handlers: 39, functions: 74 }
```

`git_status` also flushes (`flush?.()` is the first line of `gitStatus` in
`core/git.ts`). Don't rely on it.

To check whether you're exposed, compare the registry against the directory it
loads from — they should agree. `project_status` does this comparison for you;
by hand:

```sh
ls .opentide/state/handlers | wc -l     # vs. the handler count the kernel reports
ls .opentide/state/functions | wc -l
```

## Security posture

- **Loopback only.** The HTTP transport binds to `127.0.0.1` (`DEV_SERVER_HOST`)
  and must never be exposed to the LAN — the MCP surface exposes **mutating tool
  verbs** (create/modify handlers, routes, functions, schemas; run builds).
- **HTTP needs the token; stdio doesn't.** HTTP checks `Host`/`Origin` against
  loopback, then the bearer token from `.opentide/kernel.token`. Anyone who can
  read that file can mutate the project — it's a gate, not an identity. stdio
  has no check: whoever can spawn the process already has the files.
- **Every call is audited, contents excluded.** Each `tools/call` writes a row
  to `_genie_mcp_calls`: client, tool, session, transport, allow or deny,
  changeset, and the argument size. Arguments and results aren't stored. It
  keeps the newest 10,000 (`MCP_AUDIT_MAX_RECORDS`). Nothing displays it; query
  the table. Calls through the stdio bridge are recorded as `http`, because
  that's how they reach serve. The changeset is filled in only for writes the
  gate pins; `create_changeset`, `complete_changeset` and `run_tests` rows have
  none.
- **The client names itself.** Changelog records and attestations carry
  `principalId: "local:<clientInfo.name>"`. The name is whatever the client
  sent, unchecked, so it says which tool did the work, not who's allowed to.
- **Arguments over 1 MiB are refused** with `ARGS_TOO_LARGE` before dispatch
  (`MCP_MAX_ARG_BYTES`), and audited as a deny.
- **Headless approval.** Over MCP, changeset intent-approval is auto-satisfied
  (there is no human approver in a headless session); the completion/readiness
  gate is unchanged, so builds still must pass verification.

## Protocol & surface versioning

The MCP tool surface is a stable external contract: once agents pin against the
tool names and input schemas, those can't change silently. Three _distinct_
versions are in play — don't conflate them:

| Version                                                         | What it identifies                                      | Where it lives                                | Who bumps it         |
| --------------------------------------------------------------- | ------------------------------------------------------- | --------------------------------------------- | -------------------- |
| **MCP protocol version**                                        | the wire spec itself                                    | negotiated by the SDK at `connect()`          | the MCP spec / SDK   |
| **Server version** (`MCP_SERVER_VERSION`, = `OPENTIDE_VERSION`) | the OpenTide **build**                                  | handshake `serverInfo` (`opentide` / version) | the OpenTide release |
| **Tool-surface version** (`MCP_SURFACE_VERSION`, `6.4.0`)       | the **published tool contract** — names + input schemas | `tools/list` result `_meta` (see below)       | this policy          |

The surface can be at `6.x` while the build is at `0.x` — versioning it
separately is what lets a pinned integration survive server churn.

### Reading the surface version and fingerprint

Every `tools/list` response carries a metadata block under the
`opentide/surface` key in the result `_meta`:

```jsonc
// tools/list result
{
  "tools": [/* … 121 tools … */],
  "_meta": {
    "opentide/surface": {
      "version": "7.2.2", // MCP_SURFACE_VERSION — the contract handle you pin
      "fingerprint": "f8d7-ea949677", // structural hash of names + input schemas
      "toolCount": 121
    }
  }
}
```

- **`version`** is the semver you pin an integration against.
- **`fingerprint`** is a deterministic hash of the tool names + input schemas.
  Descriptions and annotations are excluded, so wording tweaks never move it. A
  client can cache it and detect that the structural surface changed even within
  the same `version` (it never should — a fingerprint change without a `version`
  bump is a release bug, guarded by a pinned test in
  `mcp/mcp-projection_test.ts`).

### What a version bump means (semver)

- **PATCH** (`1.0.0 → 1.0.1`) — advisory-only changes: annotation hints,
  description wording. No name or schema change; the fingerprint is unchanged.
- **MINOR** (`1.0.x → 1.1.0`) — additive-and-compatible: a **new** tool verb, or
  an existing verb newly **marked deprecated**. Existing pinned calls keep
  working.
- **MAJOR** (`1.x → 2.0.0`) — an incompatible change: a verb **removed** or
  **renamed**, or an input schema changed in a breaking way (e.g. a new required
  field). This is the only kind of bump that can break a pinned client, and it
  is gated by the deprecation window below.

### Compatibility guarantee for pinned clients

Within a major version, the surface only ever **grows** (new verbs) or gains
**advisory** metadata. A tool present at `6.0.0` is present, by the same name
and with a compatible input schema, for the entire `6.x` line. No verb is
removed or renamed without first going through a deprecation window and a major
bump.

### Deprecation

A verb is never removed abruptly. When a verb is on a removal path it is first
**marked deprecated** — advisory only; it still dispatches and behaves exactly
as before. The signal appears on the wire in two forms on that tool:

- a machine-readable record under `_meta["opentide/deprecated"]`:

  ```jsonc
  "_meta": {
    "opentide/deprecated": {
      "since": "1.1.0",          // surface version it was deprecated in
      "removeAfter": "2.0.0",    // earliest MAJOR version it may be removed at
      "supersededBy": "new_verb", // the replacement, if any
      "note": "Migrate to new_verb."
    }
  }
  ```

- a human-readable `DEPRECATED (…)` banner prepended to the tool's
  `description`, for clients that surface only the description to the model.

**Deprecation window.** A verb marked deprecated in a `1.x` release remains
callable for the **remainder of the `1.x` line** and may only be removed in a
subsequent major version at or after its `removeAfter` (never before). That
gives pinned integrations at least one full major version to migrate. Removal
itself is a MAJOR bump and is called out in the release notes for that version.

**Nothing is deprecated today.** The deprecation registry (`MCP_DEPRECATIONS` in
`mcp/mcp-projection.ts`) is empty. The surface is `6.4.0`, 110 verbs.
