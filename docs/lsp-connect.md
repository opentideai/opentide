# Connecting an editor or agent over LSP

`opentide lsp` exposes a project's **language intelligence** — completions,
hover, go-to-definition, find-references, document highlights, diagnostics, and
edit / rename / create — over the Language Server Protocol. It is an adapter
over the same language service (`GenieLanguageService`,
`core/language-service.ts`) the rest of the core uses: it translates JSON-RPC to
the runtime's `get*` intelligence methods and the `define_*` tools, and adds no
intelligence of its own.

There are two audiences:

- **External AI agents.** An agent never saves through LSP; it saves through the
  tool layer (`define_handler`, …). It uses LSP as a **feedback channel**:
  completions to learn a signature, diagnostics to self-correct. Read-only, no
  write path needed. See [the agent recipe](#the-agent-recipe).
- **Humans in a plain editor.** Read-only LSP over a _virtual_ codebase is
  mainly a way to **browse the live app** (hover, go-to-def, find-refs) or type
  scratch code and see squiggles. Authoring still happens through an agent. The
  [addressing gap](#the-opentide-addressing-gap) is why.

## Transports

|                       | **stdio**                                          | **HTTP / WebSocket** |
| --------------------- | -------------------------------------------------- | -------------------- |
| Status                | The only transport                                 | Not built            |
| Who starts the server | The **client spawns it** from its `command`/`args` | —                    |
| Best for              | Editors, and agents on the same machine            | —                    |
| Transport             | JSON-RPC over stdin/stdout                         | —                    |

**stdio is local-trust only** (see [Security](#security-posture)). For stdio you
don't run anything yourself — the client launches the process from its config.

## The launch command

```sh
opentide lsp --project /abs/path/to/project
```

Editor configs need the launcher's absolute path, e.g.
`/Users/you/.opentide/bin/opentide`. From a clone, `deno task lsp --project …`
runs the same server.

The server logs to **stderr** (`stdout` is the JSON-RPC channel and carries only
protocol frames), so an editor that surfaces LSP stderr shows the
`LSP server ready on stdio` banner.

**It loads the project in-process.** With the default PGlite database, a project
already open in `opentide serve` (including one the MCP bridge started) can't
also be opened by `opentide lsp`: it fails with `PROJECT_ALREADY_OPEN`. And
while `opentide lsp` holds the project, the MCP bridge can't start a serve for
it.

## Neovim (built-in LSP)

Neovim has no native `opentide://` file browser, so you start the client
explicitly. The `opentide` filetype below is illustrative — see
[the addressing gap](#the-opentide-addressing-gap).

```lua
-- init.lua — start the OpenTide LSP server for opentide:// documents.
vim.lsp.config.opentide = {
  cmd = {
    "/Users/you/.opentide/bin/opentide", "lsp",
    "--project", "/abs/path/to/project",
  },
  -- The server addresses documents by opentide:// URI (not root_dir); this is a
  -- single-project server, so no root markers are needed.
  root_dir = "/abs/path/to/project",
  filetypes = { "opentide", "typescript" },
}
vim.lsp.enable("opentide")
```

On older Neovim (`nvim-lspconfig`, pre-0.11) the equivalent is a
`configs.opentide` table with the same `cmd`.

## Zed

For a local server, point a custom language server at the same command. In your
Zed settings:

```jsonc
{
  "lsp": {
    "opentide": {
      "binary": {
        "path": "/Users/you/.opentide/bin/opentide",
        "arguments": ["lsp", "--project", "/abs/path/to/project"]
      }
    }
  }
}
```

## Generic `lspconfig`-style clients

Any client that can launch a stdio LSP server works: give it the
[launch command](#the-launch-command) as `command` + `args`. There is nothing
OpenTide-specific in the handshake beyond the advertised capabilities — a
vanilla client negotiates the read providers and ignores what it doesn't
understand (including the two `opentide/*` custom notifications).

## The `opentide://` addressing gap

Editors open files by **`file://` path**. OpenTide entities are **virtual**
documents addressed by an `opentide://` URI (`lsp/uri.ts`):

```
opentide://<runtimeId>/<entityTypePlural>/<name>.ts
e.g.  opentide://typescript/handlers/getUsers.ts
```

There is no file on disk. The read features work **only once the client opens
`opentide://` URIs**, which a vanilla editor can't browse or open. Making one do
that needs a client-side extension (a `TextDocumentContentProvider` for the
scheme, say). None ships today, so a plain editor is an observer, not an
authoring surface.

**An agent sidesteps this.** An agent that knows the entity coordinates builds
the `opentide://` URI and `didOpen`s it — no file browser needed. That is what
[the agent recipe](#the-agent-recipe) does.

## Feature-degradation matrix

A plain client gets the read features (pointed at `opentide://` URIs) and sees
governance outcomes as `window/showMessage` toasts. A richer client can also
handle the two `opentide/*` custom notifications; there are only two.

| Feature                                                       | LSP method                                         | Plain client                                                    | Needs a rich client |
| ------------------------------------------------------------- | -------------------------------------------------- | --------------------------------------------------------------- | ------------------- |
| Completion                                                    | `textDocument/completion`                          | ✅ (at an `opentide://` URI)                                    | —                   |
| Hover                                                         | `textDocument/hover`                               | ✅                                                              | —                   |
| Go-to-definition                                              | `textDocument/definition`                          | ✅                                                              | —                   |
| Find references                                               | `textDocument/references`                          | ✅                                                              | —                   |
| Document highlights                                           | `textDocument/documentHighlight`                   | ✅                                                              | —                   |
| Diagnostics (tsc ⊕ qc ⊕ verify)                               | `textDocument/publishDiagnostics`                  | ✅ (server push)                                                | —                   |
| Save an edit                                                  | `textDocument/didSave`                             | ⚠️ persists; outcome as a toast                                 | richer status UI    |
| Rename (atomic, cross-entity)                                 | `textDocument/rename`                              | ⚠️ applies; buffers reconcile from the returned `WorkspaceEdit` | —                   |
| Create an entity                                              | `workspace/executeCommand` `opentide.createEntity` | ⚠️ works if the client can invoke it with the metadata form     | a form UI           |
| **Changeset status** (gated save)                             | `opentide/changesetStatus`                         | ❌ falls back to a `window/showMessage` toast                   | approve affordance  |
| **Server-initiated refresh** (stale write / out-of-band edit) | `opentide/documentChanged`                         | ❌ ignored; caught by `STALE_WRITE` on next save                | buffer replace      |

Write features (save / rename / create) are advertised only when
`LSP_WRITE_FEATURES_ENABLED` (`core/config.ts`) is true, which is the default.
There is no command-line flag to turn them off. With it false, none are
advertised and a client shows no write affordance. A rejected or gated write is
reported as such, through diagnostics and/or a toast.

## The version / compatibility contract

The advertised capability surface is a stable contract: once a client pins
against it, it should not change silently. Three _distinct_ versions are in play
on the `initialize` result — don't conflate them:

| Version                                                         | What it identifies                                                                               | Where it lives                                             | Who bumps it         |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | ---------------------------------------------------------- | -------------------- |
| **LSP protocol version**                                        | the wire spec itself                                                                             | negotiated by the client/SDK                               | the LSP spec         |
| **Server version** (`LSP_SERVER_VERSION`, = `OPENTIDE_VERSION`) | the OpenTide **build**                                                                           | `initialize` → `serverInfo.version` (`opentide` / version) | the OpenTide release |
| **Surface version** (`LSP_SURFACE_VERSION`, `2.0.0`)            | the **advertised capability contract** — which providers / commands / `opentide/*` notifications | `initialize` → `capabilities.opentideSurface`              | this policy          |

The surface can be at `2.x` while the build is at `0.x` — versioning them
separately is what lets a pinned integration survive server churn (the same
discipline the [MCP surface](./mcp-connect.md) uses).

### Reading the surface version and fingerprint

The `initialize` result advertises the contract under the `opentideSurface`
capability:

```jsonc
// initialize result
{
  "serverInfo": { "name": "opentide", "version": "0.1.0" },
  "capabilities": {
    "completionProvider": { "resolveProvider": false },
    "hoverProvider": true,
    "definitionProvider": true,
    "referencesProvider": true,
    "documentHighlightProvider": true,
    "renameProvider": true,
    "executeCommandProvider": { "commands": ["opentide.createEntity"] },
    "opentideReadinessEnforcement": "advisory", // runtime policy value (not pinned)
    "opentideSurface": {
      "version": "2.0.0", // LSP_SURFACE_VERSION — the handle you pin
      "fingerprint": "208-805b3b7e" // structural hash of the advertised surface
    }
  }
}
```

- **`version`** is the semver you pin an integration against.
- **`fingerprint`** is a deterministic hash of the **advertised capabilities +
  the `opentide/*` custom notification methods**. It excludes advisory/runtime
  values (`opentideReadinessEnforcement`, the `serverInfo` build version), so a
  config or build change never moves it. A client can cache it and detect that
  the structural surface changed even within the same `version` (it never should
  — a fingerprint change without a `version` bump is a release bug, guarded by a
  pinned test in `lsp/surface_test.ts`).

With write features off, the server advertises a strict subset (no write
providers), so its fingerprint differs. That's correct: the fingerprint captures
the surface a client actually sees.

### What a version bump means (semver)

- **PATCH** (`1.0.0 → 1.0.1`) — advisory-only: a policy-value field
  (`opentideReadinessEnforcement`) or the `serverInfo` build version. The
  fingerprint is unchanged.
- **MINOR** (`1.0.x → 1.1.0`) — additive-and-compatible: a **new** provider,
  command, or `opentide/*` notification. Existing pinned behavior keeps working.
- **MAJOR** (`1.x → 2.0.0`) — incompatible: a capability/method **removed or
  renamed**, or an incompatible change. The only kind that can break a pinned
  client.

Within a major version the surface only ever **grows** or gains advisory
metadata. A capability present at `2.0.0` is present, by the same name, for the
entire `2.x` line.

**Today: `2.0.0`.** The read providers, the write surface (save,
`opentide.createEntity`, `didCreate`, rename), and the two `opentide/*` custom
notifications (`changesetStatus`, `documentChanged`).

## The agent recipe

An agent drives the server like this:

1. `initialize`, and read the identity and surface contract off the handshake;
2. `didOpen` an `opentide://` document, with the URI built directly;
3. request `textDocument/completion` to **learn a signature** (`db.` members);
4. send a buffer with a type error and **watch the pushed diagnostics** report
   it, then fix the buffer and watch the diagnostic **clear**.

The framing is plain LSP (`Content-Length` headers over stdio). If you're
writing the client in Deno/TypeScript, `encodeMessage` and `MessageBuffer` in
`lsp/transport.ts` do it. This repo ships no ready-made example client.

## Security posture

- **stdio is local-trust only.** Anything that can spawn the stdio process can
  read and (with write features on) change the project's code — the server
  exposes the `define_*` tool layer. Treat it as a local development surface,
  not a public API.
- **No auth on stdio.** It relies on process-spawn trust. There is no network
  transport, so nothing is exposed off-host.
- **Writes are governed.** Saves run the same QC gate and changelog as every
  other write. A risky save can be held as a pending changeset
  (`opentideReadinessEnforcement`), and a rename is applied all-or-nothing as
  one reversible change. The editor is told when a write is rejected or gated.
