# LSP Lazy Activation and Root Detection Implementation Plan

> **REQUIRED SUB-SKILL:** Use the executing-plans skill to implement this plan task-by-task.

**Goal:** Upgrade `packages/lsp` from eager, file-type-only startup to a root-aware, lazily activated LSP registry that auto-discovers applicable providers using a built-in server catalog plus user/project overrides.

**Architecture:** Keep `packages/lsp/src/client/runtime.ts` as the low-level JSON-RPC/LSP process engine, but stop using it eagerly for every configured server on `session_start`. Introduce a provider catalog and root-detection layer in `packages/lsp/src/config`, then change `packages/lsp/src/client/registry.ts` to maintain discovered server definitions and lazily instantiate per-`(server, root)` runtimes on first request or write-through. Borrow OpenCode's per-language root heuristics and lazy per-file activation, and borrow oh-my-pi's config-driven catalog, project-local binary resolution, provider priority, and idle/warmup lifecycle ideas.

**Tech Stack:** TypeScript, Vitest, Bun/Node subprocess spawning, JSON-RPC/LSP, YAML/JSON config parsing.

---

## Preflight

- Implement this plan in a dedicated branch or worktree, not directly on `main`.
- Do not commit the current workspace-local `.pi/lsp.json` unless it is intentionally part of the feature.
- Preserve backward compatibility for existing config keys and tool names:
  - `serverCommand`
  - `server`
  - `args`
  - `serverCandidates`
  - `servers`
  - `lsp` tool actions
  - `lsp_health`
  - `/lsp-status`

## Reference Inputs To Follow

### Current repo
- `packages/lsp/src/config/resolver.ts`
- `packages/lsp/src/client/registry.ts`
- `packages/lsp/src/client/runtime.ts`
- `packages/lsp/src/hooks/writethrough.ts`
- `packages/lsp/src/index.ts`
- `packages/lsp/test/resolver.test.ts`
- `packages/lsp/test/registry.test.ts`
- `packages/lsp/test/runtime.test.ts`

### oh-my-pi reference
- `can1357/oh-my-pi/packages/coding-agent/src/lsp/config.ts`
- `can1357/oh-my-pi/packages/coding-agent/src/lsp/defaults.json`
- `can1357/oh-my-pi/packages/coding-agent/src/lsp/client.ts`
- `can1357/oh-my-pi/packages/coding-agent/src/lsp/index.ts`

Use as reference for:
- config-driven default catalog
- root markers
- project-local binary resolution
- provider priority (`isLinter` / primary ordering)
- optional warmup and idle timeout behavior

### OpenCode reference
- `~/projects/oss/opencode/packages/opencode/src/lsp/index.ts`
- `~/projects/oss/opencode/packages/opencode/src/lsp/server.ts`
- `~/projects/oss/opencode/packages/opencode/src/config/config.ts`
- `~/projects/oss/opencode/packages/web/src/content/docs/lsp.mdx`

Use as reference for:
- lazy client activation per file
- root detector heuristics per language
- inflight startup deduplication
- per-root runtime caching
- server-specific launch args and initialization settings

## Non-Goals For This Plan

These are useful in the references, but they should not be part of the first implementation in this repo:

- automatic server download/install
- custom non-LSP linter clients
- full multi-client diagnostics aggregation for overlapping providers
- reproducing every OpenCode-specific server wrapper

The first implementation should deliver:
- lazy activation
- root detection
- project-local binary resolution
- provider auto-detection from a built-in catalog
- explicit args/init/env support
- deterministic provider selection when extensions overlap

## Proposed Internal Model

Create a built-in provider model roughly like this:

```ts
export type LspProviderPriority = "primary" | "secondary" | "linter";

export type LspRootStrategy =
  | { type: "nearest"; markers: string[]; excludeMarkers?: string[] }
  | { type: "go" }
  | { type: "rust" }
  | { type: "typescript" }
  | { type: "java" }
  | { type: "kotlin" }
  | { type: "fallback-cwd" };

export type LspProviderDefinition = {
  name: string;
  command: string;
  args?: string[];
  fileTypes: string[];
  priority: LspProviderPriority;
  rootStrategy: LspRootStrategy;
  initializationOptions?: Record<string, unknown>;
  environment?: Record<string, string>;
  warmupTimeoutMs?: number;
};
```

Resolver output should stop meaning "start these now" and start meaning "these providers are applicable in this workspace and can be activated later".

Suggested resolved shape:

```ts
export type ResolvedLspServerConfig = {
  name: string;
  command: string[];
  fileTypes: string[];
  priority: LspProviderPriority;
  rootStrategy: LspRootStrategy;
  initializationOptions?: Record<string, unknown>;
  environment?: Record<string, string>;
  warmupTimeoutMs?: number;
};
```

Registry should cache runtimes by root plus provider name:

```ts
const runtimeKey = `${server.name}:${rootPath}`;
```

Status should remain backward-compatible, but gain enough detail to debug lazy activation:
- discovered providers count
- active runtime count
- per-runtime root path
- configured command
- active command
- current state

---

### Task 1: Introduce a built-in provider catalog with default args and root metadata

**TDD scenario:** New feature - full TDD cycle

**Files:**
- Create: `packages/lsp/src/config/catalog.ts`
- Create: `packages/lsp/src/config/root-detection.ts`
- Modify: `packages/lsp/src/config/resolver.ts`
- Test: `packages/lsp/test/resolver.test.ts`

**Step 1: Write the failing tests**

Add tests covering these behaviors:

```ts
it("auto-detects typescript with built-in --stdio args when project markers exist", () => {
  // cwd contains package.json or tsconfig.json
  // PATH contains typescript-language-server
  // expect resolver.resolve().servers to include:
  // { name: "typescript", command: [resolvedBinary, "--stdio"] }
});

it("does not auto-detect a provider when the workspace lacks its root markers", () => {
  // PATH contains typescript-language-server
  // cwd has no package.json, tsconfig.json, jsconfig.json
  // expect resolver.resolve().servers toEqual([])
});
```

**Step 2: Run tests to verify they fail**

Run:

```bash
bunx vitest run packages/lsp/test/resolver.test.ts
```

Expected: FAIL because the current resolver uses a bare executable candidate list without root gating or built-in args.

**Step 3: Write minimal implementation**

- Add `catalog.ts` with a small seed catalog first:
  - `typescript` -> `typescript-language-server --stdio`
  - `yaml` -> `yaml-language-server --stdio`
  - `rust` -> `rust-analyzer`
  - `gopls` -> `gopls`
  - `clangd` -> `clangd`
  - `lua` -> `lua-language-server`
- Add `root-detection.ts` with a first generic `findNearestRoot()` and `hasAnyMarkerInWorkspace()` helper.
- Change `resolver.ts` so built-in auto-detection uses catalog entries, not `DEFAULT_SERVER_CANDIDATES`.
- Preserve explicit config precedence over built-ins.

**Step 4: Run test to verify it passes**

Run:

```bash
bunx vitest run packages/lsp/test/resolver.test.ts
```

Expected: PASS

**Step 5: Commit**

```bash
git add packages/lsp/src/config/catalog.ts packages/lsp/src/config/root-detection.ts packages/lsp/src/config/resolver.ts packages/lsp/test/resolver.test.ts
git commit -m "feat(lsp): add built-in provider catalog with root-gated detection"
```

---

### Task 2: Prefer project-local binaries before Mason and PATH

**TDD scenario:** New feature - full TDD cycle

**Files:**
- Modify: `packages/lsp/src/config/resolver.ts`
- Test: `packages/lsp/test/resolver.test.ts`

**Step 1: Write the failing tests**

Add tests for local executable resolution:

```ts
it("prefers node_modules/.bin over PATH for typescript-language-server", () => {
  // create cwd/node_modules/.bin/typescript-language-server
  // PATH also contains a different typescript-language-server
  // expect resolver to choose cwd/node_modules/.bin/typescript-language-server
});

it("prefers .venv/bin over PATH for python language servers", () => {
  // create cwd/.venv/bin/pyright-langserver
  // PATH contains a different pyright-langserver
  // expect local virtualenv binary to win
});
```

**Step 2: Run tests to verify they fail**

Run:

```bash
bunx vitest run packages/lsp/test/resolver.test.ts
```

Expected: FAIL because current resolver only checks Mason dirs and PATH.

**Step 3: Write minimal implementation**

Add local bin probing before Mason/PATH, using a small ordered table inspired by oh-my-pi:

```ts
const LOCAL_BIN_PATHS = [
  { markers: ["package.json", "package-lock.json", "pnpm-lock.yaml", "yarn.lock", "bun.lock", "bun.lockb"], binDir: "node_modules/.bin" },
  { markers: ["pyproject.toml", "requirements.txt", "setup.py", "setup.cfg", "Pipfile"], binDir: ".venv/bin" },
  { markers: ["pyproject.toml", "requirements.txt", "setup.py", "setup.cfg", "Pipfile"], binDir: "venv/bin" },
];
```

Update binary resolution to search these first when the matching project markers exist.

**Step 4: Run test to verify it passes**

Run:

```bash
bunx vitest run packages/lsp/test/resolver.test.ts
```

Expected: PASS

**Step 5: Commit**

```bash
git add packages/lsp/src/config/resolver.ts packages/lsp/test/resolver.test.ts
git commit -m "feat(lsp): prefer project-local language server binaries"
```

---

### Task 3: Add language-specific root detection heuristics for overlapping ecosystems

**TDD scenario:** New feature - full TDD cycle

**Files:**
- Modify: `packages/lsp/src/config/catalog.ts`
- Modify: `packages/lsp/src/config/root-detection.ts`
- Modify: `packages/lsp/src/config/resolver.ts`
- Create: `packages/lsp/test/root-detection.test.ts`

**Step 1: Write the failing tests**

Add tests for the highest-value heuristics borrowed from OpenCode:

```ts
it("suppresses typescript when deno markers exist", () => {
  // cwd contains deno.json and package.json
  // expect typescript provider not to be auto-enabled for TS/JS files
  // expect deno provider to be preferred if deno binary exists
});

it("prefers go.work over go.mod as the root", async () => {
  // nested module under a repo with both go.work and go.mod
  // expect selected root to equal go.work directory
});

it("uses the cargo workspace root when an ancestor Cargo.toml declares [workspace]", async () => {
  // nested crate inside a Rust workspace
  // expect root to be workspace root, not just the nearest crate
});
```

**Step 2: Run tests to verify they fail**

Run:

```bash
bunx vitest run packages/lsp/test/root-detection.test.ts packages/lsp/test/resolver.test.ts
```

Expected: FAIL because the current code has no per-language root heuristics.

**Step 3: Write minimal implementation**

Implement explicit root strategies in `root-detection.ts`:

```ts
export async function resolveRoot(strategy: LspRootStrategy, filePath: string, workspaceRoot: string): Promise<string | undefined>
```

Support at least:
- `nearest` markers with optional `excludeMarkers`
- `go`:
  - nearest `go.work`
  - fallback to nearest `go.mod` / `go.sum`
- `rust`:
  - nearest crate markers
  - then walk upward to the topmost ancestor with `[workspace]`
- `typescript`:
  - prefer package/tsconfig/jsconfig markers
  - return `undefined` if `deno.json` / `deno.jsonc` is present in the selected root path chain

Seed the catalog with a `deno` entry.

**Step 4: Run test to verify it passes**

Run:

```bash
bunx vitest run packages/lsp/test/root-detection.test.ts packages/lsp/test/resolver.test.ts
```

Expected: PASS

**Step 5: Commit**

```bash
git add packages/lsp/src/config/catalog.ts packages/lsp/src/config/root-detection.ts packages/lsp/src/config/resolver.ts packages/lsp/test/root-detection.test.ts packages/lsp/test/resolver.test.ts
git commit -m "feat(lsp): add language-specific root detection heuristics"
```

---

### Task 4: Change the registry from eager startup to lazy discovered-provider activation

**TDD scenario:** New feature - full TDD cycle

**Files:**
- Modify: `packages/lsp/src/client/registry.ts`
- Modify: `packages/lsp/src/index.ts`
- Test: `packages/lsp/test/registry.test.ts`

**Step 1: Write the failing tests**

Add tests that describe the new lifecycle:

```ts
it("does not spawn any runtimes during registry start", async () => {
  // registry.start(config)
  // expect createRuntime not called
  // expect status.activeServers toBe(0)
});

it("starts the matching runtime on first document-scoped request", async () => {
  // request hover on src/main.ts
  // expect typescript runtime allocated exactly once
});

it("reuses an existing runtime for later requests in the same root", async () => {
  // hover twice on two TS files under same project root
  // expect one runtime allocation
});
```

**Step 2: Run tests to verify they fail**

Run:

```bash
bunx vitest run packages/lsp/test/registry.test.ts
```

Expected: FAIL because current registry eagerly starts every resolved server in `start()`.

**Step 3: Write minimal implementation**

Refactor `registry.ts` so that:
- `start(config)` stores discovered provider definitions and clears existing runtimes
- `request()` resolves the matching provider and root for `options.path`
- `request()` creates the runtime on demand if none exists for `(provider, root)`
- `getStatus()` reports discovered providers separately from active runtimes while keeping `configuredServers` and `activeServers`

At this stage, keep workspace-scoped requests simple:
- use the first active runtime if any
- otherwise use the highest-priority discovered provider that can resolve a workspace root

Update `index.ts` so `session_start` loads discovery data but does not spawn all providers.

**Step 4: Run test to verify it passes**

Run:

```bash
bunx vitest run packages/lsp/test/registry.test.ts
```

Expected: PASS

**Step 5: Commit**

```bash
git add packages/lsp/src/client/registry.ts packages/lsp/src/index.ts packages/lsp/test/registry.test.ts
git commit -m "feat(lsp): lazily activate runtimes from discovered providers"
```

---

### Task 5: Add per-root runtime caching and concurrent startup deduplication

**TDD scenario:** New feature - full TDD cycle

**Files:**
- Modify: `packages/lsp/src/client/registry.ts`
- Test: `packages/lsp/test/registry.test.ts`

**Step 1: Write the failing tests**

Add concurrency and multi-root coverage:

```ts
it("deduplicates concurrent startup for the same provider and root", async () => {
  // fire two requests against the same TS file without awaiting the first
  // expect createRuntime called exactly once
});

it("creates separate runtimes for the same provider in different roots", async () => {
  // request TS files in two separate package roots
  // expect two runtime allocations
});
```

**Step 2: Run tests to verify they fail**

Run:

```bash
bunx vitest run packages/lsp/test/registry.test.ts
```

Expected: FAIL because the registry has no inflight-start map and no root-keyed runtime cache.

**Step 3: Write minimal implementation**

Add two maps:

```ts
const activeEntries = new Map<string, RuntimeEntry>();
const startingEntries = new Map<string, Promise<RuntimeEntry>>();
```

where the key is:

```ts
`${server.name}:${rootPath}`
```

Ensure that:
- if a start is in progress, later callers await it
- if a runtime already exists, later callers reuse it
- runtime shutdown on `stop()` clears both maps

**Step 4: Run test to verify it passes**

Run:

```bash
bunx vitest run packages/lsp/test/registry.test.ts
```

Expected: PASS

**Step 5: Commit**

```bash
git add packages/lsp/src/client/registry.ts packages/lsp/test/registry.test.ts
git commit -m "feat(lsp): cache runtimes per root and deduplicate concurrent starts"
```

---

### Task 6: Extend runtime startup to support initialization options, environment overrides, and better process errors

**TDD scenario:** New feature - full TDD cycle

**Files:**
- Modify: `packages/lsp/src/client/runtime.ts`
- Modify: `packages/lsp/src/client/registry.ts`
- Modify: `packages/lsp/src/config/resolver.ts`
- Test: `packages/lsp/test/runtime.test.ts`

**Step 1: Write the failing tests**

Add tests for the runtime contract:

```ts
it("passes initialization options in the initialize request", async () => {
  // runtime.start(serverConfig)
  // mock server inspects initialize params.initializationOptions
});

it("passes environment overrides to the spawned process", async () => {
  // mock spawn captures options.env
  // expect server-specific env values present
});

it("surfaces stderr when the child exits before initialize completes", async () => {
  // mock process writes stderr and exits 1
  // expect status.reason to contain stderr text
});
```

**Step 2: Run tests to verify they fail**

Run:

```bash
bunx vitest run packages/lsp/test/runtime.test.ts
```

Expected: FAIL because current runtime only accepts a command array and discards stderr.

**Step 3: Write minimal implementation**

Refactor runtime startup input from a bare command to a richer shape:

```ts
type LspLaunchConfig = {
  command: string[];
  initializationOptions?: Record<string, unknown>;
  environment?: Record<string, string>;
};
```

Implement:
- merged env: `{ ...process.env, ...environment }`
- initialize request includes `initializationOptions`
- stderr buffer capture with a small max size
- if startup fails before ready, use stderr text in `status.reason`

Keep `lspmux` support intact.

**Step 4: Run test to verify it passes**

Run:

```bash
bunx vitest run packages/lsp/test/runtime.test.ts
```

Expected: PASS

**Step 5: Commit**

```bash
git add packages/lsp/src/client/runtime.ts packages/lsp/src/client/registry.ts packages/lsp/src/config/resolver.ts packages/lsp/test/runtime.test.ts
git commit -m "feat(lsp): support init options env overrides and richer startup errors"
```

---

### Task 7: Make provider selection deterministic for overlapping file types

**TDD scenario:** New feature - full TDD cycle

**Files:**
- Modify: `packages/lsp/src/config/catalog.ts`
- Modify: `packages/lsp/src/client/registry.ts`
- Test: `packages/lsp/test/registry.test.ts`

**Step 1: Write the failing tests**

Add tests for overlap behavior:

```ts
it("prefers deno over typescript in deno workspaces", async () => {
  // both providers support .ts
  // cwd/root markers indicate deno workspace
  // expect deno runtime selected
});

it("prefers primary providers over linter-style providers when extensions overlap", async () => {
  // typescript and eslint both support .ts
  // expect definition/hover to route to typescript
});
```

**Step 2: Run tests to verify they fail**

Run:

```bash
bunx vitest run packages/lsp/test/registry.test.ts packages/lsp/test/root-detection.test.ts
```

Expected: FAIL because current registry picks the first matching provider only.

**Step 3: Write minimal implementation**

Introduce deterministic ordering in provider discovery and file routing:
- priority order: `primary` before `secondary` before `linter`
- when priorities tie, preserve stable catalog order
- `selectEntryForPath()` should sort matching providers before runtime selection

Do not implement cross-provider diagnostics aggregation in this task. Keep one selected provider per request path.

**Step 4: Run test to verify it passes**

Run:

```bash
bunx vitest run packages/lsp/test/registry.test.ts packages/lsp/test/root-detection.test.ts
```

Expected: PASS

**Step 5: Commit**

```bash
git add packages/lsp/src/config/catalog.ts packages/lsp/src/client/registry.ts packages/lsp/test/registry.test.ts packages/lsp/test/root-detection.test.ts
git commit -m "feat(lsp): add deterministic provider priority for overlapping file types"
```

---

### Task 8: Make write-through and tool actions lazy-aware, and add targeted regression coverage

**TDD scenario:** New feature - full TDD cycle

**Files:**
- Modify: `packages/lsp/src/hooks/writethrough.ts`
- Modify: `packages/lsp/src/tools/lsp-tool.ts`
- Modify: `packages/lsp/src/client/registry.ts`
- Create: `packages/lsp/test/writethrough.test.ts`
- Test: `packages/lsp/test/registry.test.ts`

**Step 1: Write the failing tests**

Add tests for behavior after the lazy lifecycle refactor:

```ts
it("activates the matching runtime lazily during write-through formatting", async () => {
  // no runtime active after start()
  // write/edit a TS file
  // expect runtime created only when formatting/diagnostics request is made
});

it("status remains stable before and after a lazy tool activation", async () => {
  // call status before any file request -> discovered providers only
  // call hover/diagnostics on matching file -> one active runtime
  // call status again -> reports one active runtime
});
```

**Step 2: Run tests to verify they fail**

Run:

```bash
bunx vitest run packages/lsp/test/writethrough.test.ts packages/lsp/test/registry.test.ts
```

Expected: FAIL because current write-through assumes runtimes are already active.

**Step 3: Write minimal implementation**

Update write-through and tool routing so they rely on lazy resolution rather than prestarted runtimes:
- `getStatusForPath()` should be able to report a discovered-but-inactive provider state
- write-through should allow `runtime.request()` to materialize the provider lazily
- `/lsp-status` and tool `status` should show:
  - discovered providers
  - active runtimes
  - per-runtime root if active

**Step 4: Run test to verify it passes**

Run:

```bash
bunx vitest run packages/lsp/test/writethrough.test.ts packages/lsp/test/registry.test.ts
```

Expected: PASS

**Step 5: Commit**

```bash
git add packages/lsp/src/hooks/writethrough.ts packages/lsp/src/tools/lsp-tool.ts packages/lsp/src/client/registry.ts packages/lsp/test/writethrough.test.ts packages/lsp/test/registry.test.ts
git commit -m "feat(lsp): make tool routing and write-through lazy-aware"
```

---

### Task 9: Document the new behavior and verify the implementation end-to-end

**TDD scenario:** Modifying tested code - run existing tests first

**Files:**
- Modify: `packages/lsp/README.md`
- Modify: `docs/plans/2026-03-22-lsp-lazy-activation-root-detection.md` (only if implementation reality diverges and the plan must be corrected)
- Test: `packages/lsp/test/runtime.test.ts`
- Test: `packages/lsp/test/resolver.test.ts`
- Test: `packages/lsp/test/root-detection.test.ts`
- Test: `packages/lsp/test/registry.test.ts`
- Test: `packages/lsp/test/writethrough.test.ts`

**Step 1: Run the full focused test suite before docs edits**

Run:

```bash
bunx vitest run \
  packages/lsp/test/runtime.test.ts \
  packages/lsp/test/resolver.test.ts \
  packages/lsp/test/root-detection.test.ts \
  packages/lsp/test/registry.test.ts \
  packages/lsp/test/writethrough.test.ts
```

Expected: PASS

**Step 2: Update README with the new lifecycle and config model**

Document:
- lazy activation semantics
- root detection semantics
- project-local binary resolution
- built-in provider catalog behavior
- overlap handling and priority rules
- new optional server fields:
  - `rootMarkers`
  - `excludeMarkers`
  - `priority`
  - `initializationOptions`
  - `environment`
  - `warmupTimeoutMs` if implemented
- status output semantics: discovered providers vs active runtimes

Include at least one config example like this:

```json
{
  "servers": {
    "typescript": {
      "command": ["typescript-language-server", "--stdio"],
      "fileTypes": [".ts", ".tsx", ".js", ".jsx"],
      "rootMarkers": ["package.json", "tsconfig.json"]
    }
  }
}
```

**Step 3: Run the full focused suite again**

Run:

```bash
bunx vitest run \
  packages/lsp/test/runtime.test.ts \
  packages/lsp/test/resolver.test.ts \
  packages/lsp/test/root-detection.test.ts \
  packages/lsp/test/registry.test.ts \
  packages/lsp/test/writethrough.test.ts
```

Expected: PASS

**Step 4: Manual smoke verification**

Run from the project root in a fresh session after loading the extension:

```bash
pi /lsp-status
```

Then request a TS file operation and confirm:
- before first request: providers discovered, no active runtime required
- after first request: exactly one matching runtime becomes active
- YAML files activate only the YAML provider

**Step 5: Commit**

```bash
git add packages/lsp/README.md packages/lsp/src packages/lsp/test
git commit -m "docs(lsp): describe lazy activation and root-aware discovery"
```

---

## Final Verification Checklist

- `resolver` preserves explicit user/project overrides
- built-in catalog adds correct default args like `--stdio`
- provider auto-detection is gated by root markers and binary availability
- project-local binaries beat Mason and PATH where applicable
- registry startup does not eagerly spawn every provider
- per-file requests lazily create a runtime for the selected provider/root only
- concurrent requests do not create duplicate runtimes
- write-through still works after the lazy registry refactor
- runtime errors show real child stderr when possible
- `README.md` documents the new semantics

## Follow-up Work After This Plan

These should be separate work items, not folded into the initial implementation unless explicitly requested:
- import more of OpenCode's long-tail server catalog
- add custom linter/fixer providers with multi-provider diagnostics aggregation
- optional background warmup of the top N detected providers
- idle shutdown configuration exposed through project/user config
- richer per-language root strategies for additional monorepo ecosystems
