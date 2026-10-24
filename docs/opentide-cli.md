# opentide CLI

`opentide` runs the OpenTide core from the terminal: one dispatcher, a
subcommand per job, no UI.

```sh
opentide <command> [options]
```

From a clone, `deno task opentide <command>` runs the same thing.

## Install

Needs Deno 2 on PATH (`curl -fsSL https://deno.land/install.sh | sh`).

```sh
curl -fsSL https://github.com/opentideai/opentide/releases/latest/download/install.sh | sh
```

Tested on macOS and Linux (CI runs the install smoke on both). On Windows, run
it under WSL: the installer is a POSIX shell script and native Windows hasn't
been run.

To install from a tarball you packaged yourself (see [Release](#release)):

```sh
deno task package:opentide
OPENTIDE_INSTALL_TARBALL=dist/opentide-0.1.0.tar.gz sh install.sh
```

What it does:

- unpacks the release into `~/.opentide/versions/<version>/`;
- downloads its dependencies against the lockfile it shipped with (the log goes
  to `~/.opentide/install.log`);
- writes an `opentide` launcher into `~/.deno/bin`, or `$DENO_INSTALL_ROOT/bin`,
  with the permissions of the `opentide` task minus `--env`.

Rerunning it installs the latest release over the old launcher. Old versions
stay in `~/.opentide/versions/` until you delete them.

| Variable                   | Effect                                         |
| -------------------------- | ---------------------------------------------- |
| `OPENTIDE_INSTALL_VERSION` | Install this version instead of the latest.    |
| `OPENTIDE_INSTALL_TARBALL` | Install from a local tarball; no download.     |
| `OPENTIDE_INSTALL_REPO`    | GitHub `owner/repo` to download releases from. |
| `OPENTIDE_HOME`            | Where releases unpack (default `~/.opentide`). |

`opentide --version` prints the installed version. Once installed,
`opentide mcp --print-config <client>` emits configs that run the launcher, so
they keep working across upgrades.

There is no single-file binary. A `deno compile` build can't load the npm
packages a project installs (`install_package`), and the export and build checks
run an external `deno` anyway.

## Release

1. Set `OPENTIDE_VERSION` in `core/config.ts` and commit.
2. Tag and push:

   ```sh
   git tag v0.1.1 && git push origin v0.1.1
   ```

The `Release` workflow (`.github/workflows/release.yml`) checks that the tag
matches the version, runs the install smoke, packages, and creates the GitHub
release with the tarball, its `.sha256` and `install.sh` attached.

To do it by hand:

```sh
deno task smoke:install                    # package, install, build, export: the new-user path
deno task package:opentide [--out <dir>]   # dist/opentide-<version>.tar.gz + .sha256
```

Packaging cuts from HEAD, so uncommitted changes are left out; it warns when
there are any.

## CI

`.github/workflows/ci.yml` runs on every push to `main` and every pull request:

| Job                 | Runs on       | What                                      |
| ------------------- | ------------- | ----------------------------------------- |
| Lint and type-check | Ubuntu        | `deno lint`, `deno check` over the source |
| Tests               | Ubuntu, macOS | `deno task test`                          |
| Install smoke       | Ubuntu, macOS | `deno task smoke:install`                 |

Formatting isn't enforced yet: 37 files aren't `deno fmt` clean.

## Commands

| Command        | What it does                                                        |
| -------------- | ------------------------------------------------------------------- |
| `serve`        | Run the REST control server for one project.                        |
| `mcp`          | Serve MCP for external coding agents.                               |
| `lsp`          | Serve LSP for editors and agents.                                   |
| `scaffold`     | Create a new project under a parent directory.                      |
| `build`        | Build a project's deno target into `dist/`.                         |
| `export`       | Export a project as a file tree or a tarball.                       |
| `lock:refresh` | Regenerate a project's committed `deno.lock` / `package-lock.json`. |
| `task`         | Fork a project into a parallel task; list, merge or discard one.    |

`opentide mcp` is the same code as `deno task mcp`, and `opentide lsp` the same
as `deno task lsp`.

## serve — REST control server

```sh
opentide serve --project /path/to/project
```

Boots the REST/OpenAPI control server (`:3003` by default) against one project.
It needs no LLM API key: serving, building and the deterministic checks never
call a model. Only the built-in chat agent (`/chat`) needs a provider key, and
without one it reports that no agent is configured.

- **`--project` is required.** One project per process; a missing `--project` is
  a usage error (exit 2).
- **`--port N`** overrides the control port (default `3003`). Same flag as
  `opentide mcp --port`.
- **`--app-port N`** pins the app-preview port (the running user app). The
  default is auto, an OS-assigned free port, so two servers never collide. The
  bound port is printed (`App server listening on :<port>`) and returned by
  `GET /api/project/preview-port`. Pass an explicit value for a stable preview
  URL. If that port is taken, it falls back to a free one rather than crashing.

  **Precedence:** `opentide.json`'s `previewPort` (a fixed number) >
  `--app-port` > auto. `"previewPort": "auto"` defers to `--app-port`. A fixed
  port is a preference: if it's taken at startup, serve still falls back to a
  free port.

There is no request auth. Every request resolves to the one local user, so
anyone who can reach the port can drive the project. The server binds to
loopback only, because it exposes eval, the filesystem and secrets; never put it
on the LAN.

```sh
opentide serve --project /path/to/project --port 3457 &
curl -s http://127.0.0.1:3457/api/status
```

### Two projects side by side

Give each `serve` its own `--port` and, for stable preview URLs, its own
`--app-port`. The default PGlite database is per project; with Postgres
(`OPENTIDE_DB_URL`), set the URL per process.

```sh
# Project A
opentide serve --project /path/A --port 3003 --app-port 3001
# Project B (separate terminal)
opentide serve --project /path/B --port 3013 --app-port 3011
```

A project can be open in only one process at a time. With PGlite, a second
process that loads the same project (`serve`, `lsp`, `build`, `export`,
`mcp --standalone`) is refused with `PROJECT_ALREADY_OPEN`.

## scaffold — create a new project

```sh
opentide scaffold <dir> <name>
```

Creates an empty project you can `serve` straight away. It writes
`opentide.json`, a starter `README.md` / `AGENT.md` and a `.gitignore`, runs
`git init`, and registers the project in `~/.config/opentide/registry.json`. It
starts no server.

- **`<dir>` is the parent directory, not the project folder.** The folder is the
  slug of `<name>`, so `opentide scaffold ./projects "Todo App"` creates
  `./projects/todo-app`. The resolved path is printed.
- **Both arguments are required.** A missing one is a usage error (exit 2);
  scaffolding where a project already exists is an error (exit 1).

```sh
opentide scaffold ./projects "Todo App"
# → Created project "Todo App" at /abs/projects/todo-app
opentide serve --project ./projects/todo-app
```

**`opentide scaffold --help` doesn't print help.** `scaffold` takes no flags, so
`--help` is read as `<dir>`; you get the top-level usage and exit 2.

## build — build a project's deno target

```sh
opentide build --project /path/to/project [--include-seed-data]
```

Loads the project and builds its deno target into `<project>/dist/v<version>`.
The version is read from `<project>/version.json` (default `0.1.0`). Prints the
output directory, file count and version:

```
Built deno target -> /abs/project/dist/v0.1.0 (4 files, v0.1.0)
```

- **`--project` is required.** Missing is a usage error (exit 2). A runtime that
  can't build, or a failed build, prints to stderr and exits 1.
- **Deno target only.** There is no `--target` flag. The node / docker / binary
  / docs builds are only on the control API.
- **Local database rows stay out.** `--include-seed-data` puts them in; use it
  only for intentional demo or test builds.
- **No version flag.** Bump `version.json` yourself.

## export — export a project as files or a tarball

```sh
opentide export --project /path/to/project [--out <path>] [--tarball] [--force] [--include-seed-data]
```

Loads the project and exports it as a standalone app.

- **Default: a file tree** in `--out` (default `<project>/export/`).
- **`--tarball`: one `.tar`** at `--out` (default `<project>/<slug>.tar`).
- **An explicit `--out` that already exists and isn't empty is refused.**
  `--force` clears it first. The defaults are overwritten without asking.

```sh
opentide export --project ./app                 # → ./app/export/
opentide export --project ./app --out ./out     # → ./out/
opentide export --project ./app --tarball       # → ./app/<slug>.tar
opentide export --project ./app --tarball --out ./app.tar
opentide export --project ./app --include-seed-data
```

Each run prints the path and file count, e.g.
`Exported tarball -> /abs/app/my-app.tar (4 files)`.

- **`--project` is required**; exit codes as for `build`.
- `--include-seed-data` bundles local rows as `seed.sql`.

`build` and `export` don't handle `--help` or unknown flags yet:
`opentide build --help` errors instead of printing help.

## lock:refresh — regenerate committed lockfiles

```sh
opentide lock:refresh --project /path/to/project [--target deno-source|node]
```

Regenerates the project's committed `deno.lock` and/or `package-lock.json` and
checks each one is valid frozen. It needs the network. No `--target` does both.
Prints one line per target; exits 1 if any failed.

## lsp — LSP server

```sh
opentide lsp --project /path/to/project
```

See [docs/lsp-connect.md](lsp-connect.md).

## mcp — MCP server

```sh
opentide mcp --project /path/to/project [--standalone | --http [--port N]]
```

See [docs/mcp-connect.md](mcp-connect.md) for the transports, per-client configs
(`--print-config claude-code|codex|cursor`), surface versioning and security.

## task — parallel task forks

```sh
opentide task start   --project /path/to/project --title "Totals" [--claim handler:calcTotal]... [--client claude-code|codex|cursor]
opentide task list    --project /path/to/project
opentide task merge   --project /path/to/project <task-id>
opentide task discard --project /path/to/project <task-id>
```

Each command goes to main's `opentide serve` over REST. If nothing is serving
the project, the command starts one, detached, and says so on stderr. It keeps
running afterwards; stop it with `kill <pid>`.

- **`start`** copies the project into
  `~/.config/opentide/tasks/<hash>/<task-id>/` and starts the fork's own
  `opentide serve`. It prints, in order: claim overlaps with other open tasks,
  the task id, the fork path, the open changeset the fork started before (if
  any), the fork's serve pid and port, and a connect config for the fork. Write
  that config where the header line says, then start the client there. The
  client works on the fork, not main.
- **`list`** shows every task, its status, and the port of the serve holding its
  fork right now, or `not running`.
- **`merge`** stops the fork's serve and replays the fork's changes onto main in
  one changeset, then runs main's tests and its gate. It prints what landed and
  the outcome: `merged`; `unverified` (the changes landed but the changeset is
  still open, with the reasons listed); or `apply-failed` (the replay stopped,
  the task stays open). Exit code 1 for anything but `merged`. The fork stays on
  disk until `discard`.
- **`discard`** stops the fork's serve (only the one `start` launched), deletes
  the fork, and marks the task `discarded`. If something else has the fork open,
  it refuses with `TASK_BUSY`.

Refusals come back with their code: `TASK_LIMIT` (4 open tasks),
`TASK_SOURCE_BACKED`, `TASK_EXTERNAL_DB`, `TASK_NO_CLEAN_POINT`, and for merge
`TASK_MERGE_BLOCKED` (each conflict on its own line), `TASK_BUSY` (the fork has
a changeset open) and `CHANGESET_ACTIVE` (main has one open). Exit code 1 on a
refusal, 2 on bad arguments.
