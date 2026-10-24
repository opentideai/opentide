# Project storage

An OpenTide project is built to live in Git with several people working on it.
Shareable project state and local app data live in separate places.

## At a glance

| Path                   | What it holds                                         | Commit it                                  |
| ---------------------- | ----------------------------------------------------- | ------------------------------------------ |
| `opentide.json`        | Project manifest                                      | Yes                                        |
| `.opentide/state/`     | Routes, handlers, functions, schemas, configs, tests… | Yes                                        |
| `.opentide/history/`   | Sessions, changesets, changelog                       | Yes, minus the local telemetry files below |
| `fixtures/`            | Seed / test rows you exported on purpose              | Yes                                        |
| `data/`                | The local database (PGlite)                           | No                                         |
| `.opentide/caches/`    | Logs, UI-only state                                   | No                                         |
| `.opentide/snapshots/` | Changeset start snapshots                             | No                                         |
| `.opentide/tasks.json` | Task-fork records                                     | No                                         |
| `.opentide/kernel.*`   | A running server's lock and bearer token              | No                                         |
| `.env`                 | Local secrets and overrides                           | No                                         |
| `dist/`                | Build output                                          | No                                         |

## User config

Outside the project:

```text
~/.config/opentide/
```

Personal settings: model choices, provider keys (`config.json`), the project
registry (`registry.json`), database backups (`backups/<project-hash>/`), and
task forks (`tasks/<project-hash>/`). Never committed with a project.

## Project manifest

```text
opentide.json
```

Marks the directory as an OpenTide project and holds project-level metadata,
such as `previewPort`.

## Mergeable project state

```text
.opentide/state/
```

Committed. Split JSON files for routes, handlers, configs, schemas, migrations,
tests, dev views and the other project definitions, one file per category and
per named entity where practical, so ordinary Git merges stay small.

The server keeps these in memory and writes them back on a flush; see
[docs/mcp-connect.md](mcp-connect.md#your-registry-changes-are-not-on-disk-until-something-flushes).

Schema definitions and migrations live under:

```text
.opentide/state/schemas/
```

These describe the app's table structure, not its rows. When a cloned project is
opened on a fresh machine, OpenTide recreates the tables from this directory in
the local database.

## Mergeable project history

```text
.opentide/history/
```

Committed. Sessions, messages, changesets, changelog records and usage metadata.
History files use timestamped IDs, merge-safe numeric IDs, one-file-per-entity
layouts and append-friendly formats where practical.

The changelog undo/redo cursor lives here too, so collaborators see the same
applied/undone boundary.

Machine-local telemetry under it is ignored: `usage/`, `model-usage.jsonl`,
`survival.jsonl`, `episodes.jsonl`, `cursor.json`, `cache-composition.jsonl`.

## Local app data

```text
data/
```

Ignored by Git. The local database: test rows, scratch rows, PGlite files.
Deleting `data/` doesn't delete the project definition, schemas or history.

Opening a clone recreates the tables from `.opentide/state/schemas/`, but not
their rows. If `data/` is missing or new, the tables are empty until you import
a fixture or create rows.

With `OPENTIDE_DB_URL` set, rows live in that Postgres database instead and
`data/` isn't used.

## Local runtime caches

```text
.opentide/caches/
.opentide/caches/logs.json
.opentide/caches/local-state.json
```

Ignored by Git.

- **`logs.json`** — the unified log, restored when the project is opened so log
  tools can see recent runtime context after a restart. Kept out of history
  because log lines can carry secrets, stack traces and runtime data.
- **`local-state.json`** — UI-only state for a client: navigation history,
  editor positions, drafts.

## Files a running server writes

```text
.opentide/kernel.lock     # which process holds the project
.opentide/kernel.token    # MCP/HTTP bearer token, mode 0600, deleted on shutdown
.opentide/serve.log       # output of a serve the MCP bridge started
```

Ignored by Git in projects created from 0.1.0 on. An older project's
`.gitignore` lacks them, and `git add -A` while a server runs would commit the
token. Add the three lines yourself.

## Shareable seed / test data

```text
fixtures/<name>/
fixtures/default/manifest.json
fixtures/default/<table>.json
```

Committed. Deterministic JSON. Three tools manage them:

| Tool          | Effect                                                  |
| ------------- | ------------------------------------------------------- |
| `export_data` | Writes the current local rows into a fixture.           |
| `import_data` | Loads a fixture into the local database.                |
| `reset_data`  | Clears local rows; schemas and project state untouched. |

To share rows, use a fixture. Don't commit `data/`.

## The default `.gitignore`

`opentide scaffold` writes:

```text
.env
data/
dist/
.opentide/caches/
.opentide/backups/
.opentide/history/usage/
.opentide/history/model-usage.jsonl
.opentide/history/survival.jsonl
.opentide/history/episodes.jsonl
.opentide/history/cursor.json
.opentide/history/cache-composition.jsonl
.opentide/tasks.json
.opentide/snapshots/
```

## After a pull or a merge

Loading the project should just work. To check it, run the consistency check:
`project_status` over MCP, or `GET /api/project/doctor` on the control API. The
changeset readiness gate runs the same check and blocks completion on
consistency errors, so an agent has to repair them as part of verification.

The check validates JSON and JSONL files, detects duplicate IDs, checks
cross-references between sessions, messages, changesets, changelog records,
schemas and migrations, and verifies that `data/` is ignored by Git. It also
warns when committed schema metadata exists but `data/` is missing or lacks a
table, because opening the project will recreate that table empty rather than
restore its rows.
