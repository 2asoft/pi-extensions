# LSP Extension

## Install from git URL

```bash
pi install git:github.com/yofriadi/pi-extensions@lsp-v<version>
```

To load only this extension from the monorepo package source, use package filtering in settings:

```json
{
  "packages": [
    {
      "source": "git:github.com/yofriadi/pi-extensions@lsp-v<version>",
      "extensions": ["packages/lsp/src/index.ts"]
    }
  ]
}
```

Standalone package for Pi LSP integration.

## Scope

This package provides:

- JSON-RPC LSP runtime management for subprocess-based servers
- lazy activation instead of eager startup
- root-aware provider selection
- project-local binary resolution before Mason and PATH
- per-root runtime caching with concurrent startup deduplication
- deterministic overlap handling for providers that share file types
- `lsp` tool actions for diagnostics, definition, references, hover, symbols, rename, status, and reload
- backward-compatible `lsp_health`
- write-through hooks for format-on-write and diagnostics-on-write

The extension is opt-in. It does not change Pi behavior unless loaded.

## Runtime model

The registry has two layers:

1. Discovered providers
   - resolved from config, explicit commands, explicit candidates, or built-in auto-discovery
   - do not start a process on `session_start`

2. Active runtimes
   - created on first matching request or write-through event
   - cached per `(provider, root)`
   - reused for later requests in the same root

This means:

- loading the extension does not eagerly spawn every LSP server
- opening or querying a TypeScript file only starts the TypeScript provider for that root
- separate package roots can get separate runtimes for the same provider
- concurrent requests for the same provider/root share one startup

## Resolution order

Config and auto-detection are applied in this order:

1. User config
   - `~/.pi/agent/lsp.json|yaml|yml`
   - fallback: `~/.pi/lsp.json|yaml|yml`
2. Project config
   - `<cwd>/.pi/lsp.json|yaml|yml`
   - overrides user config by server name
3. Explicit multi-server config: `servers`
4. Explicit single command: `serverCommand` or `server` + `args`
5. Explicit candidate probing: `serverCandidates`
6. Built-in provider catalog

## Built-in provider catalog

Current built-in providers:

- `deno` -> `deno lsp`
- `typescript` -> `typescript-language-server --stdio`
- `pyright` -> `pyright-langserver --stdio`
- `yaml` -> `yaml-language-server --stdio`
- `rust` -> `rust-analyzer`
- `gopls` -> `gopls`
- `clangd` -> `clangd`
- `lua` -> `lua-language-server`

Built-ins are gated by root detection and binary availability.

Examples:

- TypeScript activates only when JS/TS project markers exist
- Deno suppresses TypeScript in Deno workspaces
- Go prefers `go.work`, then `go.mod` / `go.sum`
- Rust lifts to the Cargo workspace root when an ancestor `Cargo.toml` contains `[workspace]`

## Binary resolution

Binary resolution prefers local project executables before Mason and PATH.

Current local search paths:

- Node: `node_modules/.bin`
- Python: `.venv/bin`
- Python: `venv/bin`

After local bins, the resolver checks common Mason bin directories, then regular PATH.

## Config

### Top-level single-server keys

Supported top-level keys:

- `serverCommand`: string or string array
- `server`: binary with optional `args`
- `args`: extra args for `server`
- `serverCandidates`: probe order for a single fallback server
- `servers`: named map or array of server definitions

### `servers` entry fields

Each entry under `servers` can use:

- `command`: string or string array
- `server`: binary name/path with optional `args`
- `args`: extra args for `server`
- `fileTypes`: file extensions or exact filenames
- `priority`: `primary`, `secondary`, or `linter`
- `rootMarkers`: nearest-root markers for explicit providers
- `excludeMarkers`: markers that suppress a `rootMarkers` match
- `initializationOptions`: forwarded in the LSP `initialize` request
- `environment`: extra environment variables for the child process
- `disabled`: skip this provider

### Example: explicit TypeScript and YAML config

```json
{
  "servers": {
    "typescript": {
      "command": ["typescript-language-server", "--stdio"],
      "fileTypes": [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"],
      "priority": "primary",
      "rootMarkers": ["package.json", "tsconfig.json", "jsconfig.json"],
      "excludeMarkers": ["deno.json", "deno.jsonc"]
    },
    "yaml": {
      "command": ["yaml-language-server", "--stdio"],
      "fileTypes": [".yaml", ".yml"],
      "priority": "primary",
      "rootMarkers": ["docker-compose.yml", "docker-compose.yaml", "mkdocs.yml", "openapi.yaml", "openapi.yml"]
    }
  }
}
```

### Example: environment and initialization options

```json
{
  "servers": {
    "typescript": {
      "command": ["typescript-language-server", "--stdio"],
      "fileTypes": [".ts", ".tsx"],
      "initializationOptions": {
        "typescript": {
          "preferences": {
            "includeCompletionsForModuleExports": true
          }
        }
      },
      "environment": {
        "TSS_LOG": "-level verbose -file /tmp/tsserver.log"
      }
    }
  }
}
```

## Overlap handling

Providers that match the same file type are selected deterministically.

Priority order:

1. `primary`
2. `secondary`
3. `linter`

When priorities tie, config/catalog order wins.

Important consequences:

- `eslint`-style providers should usually be marked `linter`
- Deno workspaces prefer Deno because TypeScript root detection is suppressed there
- one request targets one selected provider; this package does not aggregate diagnostics across multiple providers

## Status model

`lsp` status and `lsp_health` report:

- registry lifecycle state
- discovered provider count
- active runtime count
- server/runtime details

Status distinguishes:

- discovered but inactive providers
- active runtimes
- active runtime root paths when available

`/lsp-status` is a human-readable summary. The `lsp` tool `status` action returns the structured payload.

## Write-through behavior

Successful `write` and `edit` tool results trigger LSP write-through:

- `textDocument/formatting`
- `textDocument/diagnostic`

Write-through is lazy-aware:

- if a matching provider is discovered but inactive, the request activates it on demand
- if no provider matches the path, write-through is skipped with a warning

## Tool actions

The `lsp` tool supports:

- `status`
- `reload`
- `diagnostics`
- `hover`
- `definition`
- `references`
- `symbols`
- `rename`

Notes:

- `reload` re-resolves config and clears active runtimes
- document-scoped actions require `path`
- position-based actions require `path`, `line`, and `character`
- `symbols` uses workspace mode when `query` is provided, otherwise document mode
- workspace `symbols` queries use a dedicated 10s timeout because some servers continue startup progress after `initialize`
- `rename` is preview-only: it returns the LSP workspace edit payload and does not apply file changes automatically

## Package layout

- `src/index.ts`: extension entrypoint and command wiring
- `src/client/runtime.ts`: single LSP subprocess runtime and JSON-RPC transport
- `src/client/registry.ts`: discovered-provider registry and per-root runtime activation
- `src/config/catalog.ts`: built-in provider catalog
- `src/config/root-detection.ts`: root detection logic
- `src/config/resolver.ts`: config resolution and binary lookup
- `src/tools/lsp-tool.ts`: tool routing
- `src/hooks/writethrough.ts`: format-on-write and diagnostics-on-write hooks

## Usage

After loading the extension:

- run `/lsp-status`
- use the `lsp` tool for hover, definitions, references, symbols, diagnostics, rename, reload, and status
- use `lsp_health` for the status shortcut
- edit or write files to trigger write-through formatting and diagnostics

## Test coverage

Focused tests:

- `packages/lsp/test/runtime.test.ts`
  - initialize handshake
  - collision-safe JSON-RPC client ids
  - JSON-RPC id normalization
  - initialization options
  - environment overrides
  - workspace-symbol startup progress retry
  - stderr-aware startup failures
- `packages/lsp/test/resolver.test.ts`
  - built-in auto-discovery
  - project-local binary resolution
  - explicit provider metadata
  - Deno vs TypeScript detection
- `packages/lsp/test/root-detection.test.ts`
  - Go workspace root resolution
  - Rust workspace root lifting
- `packages/lsp/test/registry.test.ts`
  - lazy activation
  - per-root caching
  - concurrent startup deduplication
  - deterministic overlap handling
- `packages/lsp/test/document-sync.test.ts`
  - cold first-request document synchronization
  - reload-safe document reactivation
  - full-document `didChange` synchronization
- `packages/lsp/test/lsp-tool.test.ts`
  - rename preview-only rendering
  - dedicated workspace-symbol timeout routing
- `packages/lsp/test/writethrough.test.ts`
  - lazy write-through activation

Run the focused suite:

```bash
npx vitest run \
  packages/lsp/test/runtime.test.ts \
  packages/lsp/test/resolver.test.ts \
  packages/lsp/test/root-detection.test.ts \
  packages/lsp/test/registry.test.ts \
  packages/lsp/test/writethrough.test.ts
```
