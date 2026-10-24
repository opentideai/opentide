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

- **A serve the bridge started keeps running** after every client exits. Stop it
  with `kill <pid>`; the pid is in the bridge's stderr and in `kernel.lock`.
- **If serve dies or switches project mid-session,** the bridge exits with
  code 1. Restart the client and it reattaches, or starts a new serve.
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

## Claude Code

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
# stdio (everything after -- is the spawn command)
claude mcp add opentide -- /Users/you/.opentide/bin/opentide mcp --project /abs/path/to/project

# http
claude mcp add --transport http opentide http://127.0.0.1:3005/mcp \
  --header "Authorization: Bearer $OPENTIDE_MCP_TOKEN"
```

`.mcp.json` has no per-server `cwd`, so the command must be an absolute path.

## Codex

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

## What the external agent does

MCP projects a **tool catalog, not a loop**. Your agent reads the app, decides
what to write, and drives the changeset flow; the server supplies the tools, a
short rulebook and the gate. The repair strategy is yours.

### What the server tells the agent

| Channel               | What it carries                                                                                                                                                                                                                       | Reaches the model                                                     |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| Server `instructions` | Ownership rules, the changeset loop, what to do when storage breaks. Then the project's own rules (`set_system_prompt`), if they fit. Source: `core/agent-guide.ts`.                                                                  | On connect, in the system prompt. Nobody has to ask.                  |
| `project_status`      | Verdict (`ok` / `attention` / `stop`) and one line per problem: consistency errors, memory against `.opentide/state`, unreachable code, the active changeset, the surface version, and the project's rules in full (`projectRules`).  | When the agent calls it. The instructions tell it to, first.          |
| `INVALID_ARGUMENTS`   | A refusal naming the argument the agent meant (`query` → `sql`, `code` → `source`, `status: "completed"` → `done`). camelCase/snake_case spellings of a declared key are accepted and renamed. Source: `core/tools/validate-args.ts`. | On the wrong call.                                                    |
| Tool descriptions     | `create_changeset` and `amend_changeset_plan` say they auto-approve.                                                                                                                                                                  | Always. Clients don't show the model a tool's `_meta` or annotations. |
| Prompts               | `start`, `change <goal>`, `land [changeset_id]`, `recover`. In Claude Code: `/opentide:start`, `/opentide:change add a dark mode toggle`. Source: `mcp/mcp-prompts.ts`.                                                               | Only when a human types one.                                          |

Two limits. **Claude Code cuts a server's instructions at 2,048 characters**,
silently. `CLAUDE_CODE_MAX_MCP_DESCRIPTION_LENGTH` raises the cap. The general
rules take most of that, so a project's rules that don't fit are not inlined;
the instructions point at `project_status` instead, which returns them whole.
Second, argument checking runs **on the MCP face only**. The built-in chat agent
on the control API still dispatches unchecked.

### Where the tokens go

Turn-by-turn reasoning bills to your client — its subscription or its key — not
to OpenTide. None of the MCP verbs below calls a model:

| Verb                                             | In OpenTide                                                                                                                              |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `refute_claims`                                  | Not on the surface.                                                                                                                      |
| `run_audit`                                      | Every category returns `status: "error"`, "Audit provider not configured". The audits are model-backed and no audit provider ships here. |
| `index_codebase` with `classification: "assist"` | Classification comes back `skipped_unconfigured`; the index itself is built.                                                             |
| `complete_changeset`                             | The gate's adversarial refutation step is skipped; the deterministic gate runs.                                                          |

The one exception: `git_commit` with no `message` asks the utility model for a
subject line if you've configured a utility model and its provider key in
`~/.config/opentide/config.json`. Without both it uses a deterministic subject.
Pass `message` and it never calls a model.

For verification, use the deterministic checks: `qc`, `run_tests`,
`check_export_types`, `test_coverage`.

## Driving a changeset to completion

Intent-approval is auto-satisfied over MCP, for amendments too: an
`amend_changeset_plan` that sends the changeset back to `planning` is
re-approved and restarted in the same call. The **completion gate is not**
auto-satisfied, and these are the failure modes worth knowing.

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

The session is a real record under `.opentide/history/sessions/`. The
consistency check (`core/project-doctor.ts`) counts a reference to a missing
session as an **error** (`CHANGESET_SESSION_MISSING`), and the readiness gate
refuses to look past any consistency error, so don't delete session files.

### Reading what the gate is complaining about

`PROJECT_CONSISTENCY_ERRORS` and `PROJECT_CONSISTENCY_WARNINGS` point at
`project_status`, which runs the same consistency check (`doctorProject`) and
lists every error with its code, path and message. `doctor_project` itself is
not on the surface (`AGENT_TOOL_EXCLUDE` in `core/tools/definitions.ts`);
`project_status` covers it.

### `must` criteria

`change_class: "light"` skips the adversarial pass outright. In OpenTide a
`standard` changeset skips it too, because no refutation agent is assembled.

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
| **Tool-surface version** (`MCP_SURFACE_VERSION`, `6.3.0`)       | the **published tool contract** — names + input schemas | `tools/list` result `_meta` (see below)       | this policy          |

The surface can be at `6.x` while the build is at `0.x` — versioning it
separately is what lets a pinned integration survive server churn.

### Reading the surface version and fingerprint

Every `tools/list` response carries a metadata block under the
`opentide/surface` key in the result `_meta`:

```jsonc
// tools/list result
{
  "tools": [/* … 109 tools … */],
  "_meta": {
    "opentide/surface": {
      "version": "6.3.0", // MCP_SURFACE_VERSION — the contract handle you pin
      "fingerprint": "d2f4-904e3487", // structural hash of names + input schemas
      "toolCount": 109
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
`mcp/mcp-projection.ts`) is empty. The surface is `6.3.0`, 109 verbs.
