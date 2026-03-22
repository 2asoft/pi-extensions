# LSP Lazy Activation and Root Detection Implementation Plan

> **REQUIRED SUB-SKILL:** Use the executing-plans skill to implement this plan task-by-task.

**Goal:** Finish the `packages/lsp` implementation by resolving the remaining real-world Rust LSP reliability issues discovered during manual verification, while explicitly treating rename as preview-only behavior.

**Architecture:** Phase 1 of the work is already implemented on branch `aasoft/smarter_lsp`: built-in provider discovery, root detection, lazy activation, per-root runtime caching, overlap priority, richer launch config, and lazy-aware write-through. The remaining work is Phase 2: add reliable document lifecycle synchronization for document-scoped requests, make reload-safe reactivation deterministic, document rename as preview-only, and investigate workspace-symbol flakiness only after the first-request and reload regressions are fixed.

**Tech Stack:** TypeScript, Vitest, Pi extension API, JSON-RPC/LSP, Bun/Node subprocess spawning, rust-analyzer real-world verification.

---

## Status Snapshot

**Current implementation status:** Partially complete.

### Complete

Phase 1 implementation is complete on branch `aasoft/smarter_lsp`.

Implemented and committed:
- built-in root-aware provider discovery
- project-local binary resolution before Mason and PATH
- Go, Rust, TypeScript, and Deno root heuristics
- lazy runtime activation on first use
- per-root runtime caching
- concurrent startup deduplication
- initialization options and environment overrides
- stderr-aware startup errors
- deterministic provider priority for overlaps
- lazy-aware write-through
- explicit root marker config support
- updated README and original implementation plan

Relevant commits already on the branch:
- `4b7e6d8` feat(lsp): add root-aware provider discovery
- `94e7cf3` feat(lsp): activate runtimes lazily
- `a2287c8` feat(lsp): cache runtimes per root
- `a1c078a` feat(lsp): support launch options and startup errors
- `a9dca3a` feat(lsp): prioritize overlapping providers deterministically
- `40619fb` fix(lsp): make write-through lazy-aware
- `828aa47` feat(lsp): support explicit root marker config
- `6b6b47f` docs(lsp): describe lazy root-aware lifecycle

### Not Complete

The branch is **not ready to merge**. Real-world Rust LSP verification exposed these remaining issues:
- first cold document-scoped request can fail even though activation begins
- first document-scoped request after `reload` can fail again
- workspace-symbol behavior is flaky during cold activation and after reload
- rename returns a workspace edit preview, but this preview-only behavior is not yet explicitly codified as the intended contract for the extension
- manual verification is incomplete until the above is addressed and re-tested

### Explicit Out of Scope

Do **not** implement rename application in Phase 2.

Rename is intentionally treated as:
- preview-only
- returns LSP workspace edits
- does not mutate files automatically

---

## Zero-Context Continuation Checkpoint

If a new session starts with no history, assume only what is written here.

### Working branch
- Repo: `/home/aasoft/projects/oss/pi/yofriadi_pi-extensions`
- Branch: `aasoft/smarter_lsp`

### Target verification repo
- Repo under test: `/home/aasoft/projects/oss/bevy/bevy/bevy_voxel_world`
- Branch there: `aasoft/deterministic_perf`
- Root markers present there:
  - `Cargo.toml`
  - `Cargo.lock`
- Primary target files used during verification:
  - `src/plugin.rs`
  - `src/voxel_world.rs`
  - `src/configuration.rs`
  - `src/voxel.rs`

### Runtime used during verification
- rust-analyzer path: `/usr/lib/rustup/bin/rust-analyzer`
- Pi command shape used for verification:

```bash
pi --no-session --mode json \
  -e /home/aasoft/projects/oss/pi/yofriadi_pi-extensions/packages/lsp/src/index.ts \
  --thinking off \
  -p '<targeted prompt>'
```

### Observed real-world behavior

#### Confirmed good behavior
- `lsp action=status` works
- `lsp_health` works
- root detection selected the repo root correctly:
  - `/home/aasoft/projects/oss/bevy/bevy/bevy_voxel_world`
- once the runtime is warm, these can work:
  - `hover`
  - `definition`
  - `references`
  - `diagnostics`
  - `symbols`

#### Confirmed failing behavior

1. Cold first document-scoped request failure
- Fresh session
- Initial `status` shows one configured Rust provider, zero active runtimes
- First `hover path=src/plugin.rs line=72 character=10` failed with:
  - `file not found: /home/aasoft/projects/oss/bevy/bevy/bevy_voxel_world/src/plugin.rs`
- Immediately after that failure, `status` showed the runtime as ready
- A later repeat of the same `hover` in the same session succeeded in some runs
- In another run, the repeated `hover` timed out instead

2. Cold diagnostics failure
- `diagnostics path=src/plugin.rs` failed on cold activation with:
  - `file not found: /home/aasoft/projects/oss/bevy/bevy/bevy_voxel_world/src/plugin.rs`
- After warm activation, `diagnostics` later succeeded with:

```json
{"kind":"full","resultId":"rust-analyzer","items":[]}
```

3. Reload regression
- After a warm successful request, `reload` returned the registry to:
  - `inactive`
  - `activeServers: 0`
- The first immediate path-based `hover` after reload failed again with:
  - `file not found: /home/aasoft/projects/oss/bevy/bevy/bevy_voxel_world/src/plugin.rs`
- After that failure, `status` showed the runtime as ready again

4. Workspace-symbol flakiness
- `symbols query=VoxelWorldPlugin` succeeded in one run with 3 results
- In another run it returned `[]`
- In another run it timed out waiting for `workspace/symbol`
- This flakiness was observed during cold activation and after reload
- This must be investigated **last**, after first-request and reload reliability are fixed

5. Rename behavior
- After warming the target file first, `rename path=src/voxel_world.rs line=152 character=11 newName=set_voxel_verified` returned an LSP workspace edit payload
- Parsed result from one captured run:
  - `documentChanges=10`
  - `edits=83`
- The target repo working tree stayed clean before and after:
  - `git status --short` empty both times
- A colder rename attempt failed with:
  - `content modified`

### Working hypothesis for root cause

This is still a hypothesis, not yet verified in code:
- document-scoped LSP requests are reaching rust-analyzer before the extension has synchronized document state in a way rust-analyzer accepts
- the extension likely needs explicit document lifecycle handling for path-based requests, such as `textDocument/didOpen` and `textDocument/didChange`, or an equivalent synchronization layer
- reload probably clears runtime state but does not guarantee the next path-based request reopens and resynchronizes the document before issuing hover/diagnostics/rename/etc.
- workspace-symbol flakiness may be a separate warmup/indexing issue, and must be treated separately after document request reliability is fixed

Do not assume this hypothesis is correct without proving it in tests or instrumentation.

---

## Phase 1 Historical Summary

The original Tasks 1-9 are complete. They established:
- built-in provider catalog
- local binary lookup
- root-aware resolution
- lazy activation
- per-root runtime cache
- startup deduplication
- init options/env/stderr support
- deterministic priority
- lazy-aware write-through
- docs and focused automated tests

The existing focused automated suite already passes on this branch.

Previously verified commands from the branch root:

```bash
mise exec node@25.8.1 -- npx vitest run \
  packages/lsp/test/runtime.test.ts \
  packages/lsp/test/resolver.test.ts \
  packages/lsp/test/root-detection.test.ts \
  packages/lsp/test/registry.test.ts \
  packages/lsp/test/writethrough.test.ts

mise exec node@25.8.1 -- npm test
mise exec node@25.8.1 -- npm run typecheck
PATH="$(mise where bun@1.3.11)/bin:$PATH" npm run check
```

Those automated checks are not sufficient. Real-world Rust verification failed as described above.

---

## Phase 2: Remaining Work

These tasks are **not started yet**. They supersede any claim that the branch is done.

### Task 10: Codify the cold-start and reload regressions with failing tests before changing code

**TDD scenario:** Bug fix - full TDD cycle

**Files:**
- Modify: `packages/lsp/test/registry.test.ts`
- Modify: `packages/lsp/test/runtime.test.ts`
- Create: `packages/lsp/test/document-sync.test.ts` if the existing test files become too crowded
- Reference only: `packages/lsp/src/client/registry.ts`
- Reference only: `packages/lsp/src/client/runtime.ts`

**Intent:** Make the currently observed production failures reproducible in tests first.

**Step 1: Write failing tests for first document-scoped request reliability**

Add a fake LSP runtime/server contract that models the real rust-analyzer constraint:
- a document-scoped request fails unless the document was explicitly opened first
- after reload, the document must be opened again before the next document-scoped request

Example behaviors to cover:

```ts
it("opens a document before the first hover request on a cold runtime", async () => {
  // cold registry start
  // first path-based request should trigger document synchronization
  // hover should succeed, not fail with file-not-found
});

it("reopens the document after reload before the next hover request", async () => {
  // warm request succeeds
  // reload clears active runtime and document state
  // next path-based request should reopen/resync the document and succeed
});
```

**Step 2: Run tests to verify they fail**

Run:

```bash
mise exec node@25.8.1 -- npx vitest run \
  packages/lsp/test/registry.test.ts \
  packages/lsp/test/runtime.test.ts \
  packages/lsp/test/document-sync.test.ts
```

Expected: FAIL because the current implementation has no explicit document lifecycle synchronization.

**Step 3: Add minimal instrumentation tests for outgoing notifications if needed**

If the behavior is hard to model at the registry layer alone, add a runtime-level test asserting that the implementation can emit notifications like:
- `textDocument/didOpen`
- `textDocument/didChange`

Do not implement fixes yet. Only capture the missing behavior with failing tests.

**Step 4: Re-run the tests to keep them red and isolated**

Run the same command again and confirm the failures are still the intended ones.

**Step 5: Commit**

```bash
git add packages/lsp/test/registry.test.ts packages/lsp/test/runtime.test.ts packages/lsp/test/document-sync.test.ts
git commit -m "test(lsp): capture cold-start and reload document request regressions"
```

---

### Task 11: Add explicit document lifecycle synchronization for document-scoped requests

**TDD scenario:** Bug fix - implement only after Task 10 is red

**Files:**
- Modify: `packages/lsp/src/client/runtime.ts`
- Modify: `packages/lsp/src/client/registry.ts`
- Modify: `packages/lsp/src/tools/lsp-tool.ts`
- Modify: `packages/lsp/src/hooks/writethrough.ts`
- Test: `packages/lsp/test/registry.test.ts`
- Test: `packages/lsp/test/runtime.test.ts`
- Test: `packages/lsp/test/document-sync.test.ts`

**Step 1: Design the smallest public API addition needed**

Prefer one of these minimal shapes:

```ts
interface LspClientRuntime {
  notify(method: string, params: unknown): void;
}
```

or a narrowly-scoped helper if a generic notification API is too broad:

```ts
interface LspClientRuntime {
  openDocument(input: { uri: string; languageId: string; version: number; text: string }): void;
  changeDocument(input: { uri: string; version: number; text: string }): void;
}
```

Use the smallest interface that cleanly supports the required behavior.

**Step 2: Implement the minimal runtime support**

Add notification support in `runtime.ts` without disturbing existing request behavior.

**Step 3: Track open documents per active runtime in the registry**

The registry should:
- map document state by `(provider, root, uri)`
- read the on-disk file contents before the first path-based request
- send `didOpen` once per runtime/document
- detect changed on-disk contents and send `didChange` when needed before the next request
- clear tracked document state on `stop()` and `reload()`

Keep it simple. No editor-style incremental ranges. Full-document sync is acceptable for this phase.

**Step 4: Make document-scoped actions use the synchronization layer**

Ensure these route through synchronization before the actual request:
- `hover`
- `definition`
- `references`
- `rename`
- `diagnostics`
- `documentSymbol`
- `formatting`

Workspace-scoped requests like `workspace/symbol` should not require document sync.

**Step 5: Run the focused tests and make them pass**

Run:

```bash
mise exec node@25.8.1 -- npx vitest run \
  packages/lsp/test/registry.test.ts \
  packages/lsp/test/runtime.test.ts \
  packages/lsp/test/document-sync.test.ts \
  packages/lsp/test/writethrough.test.ts
```

Expected: PASS

**Step 6: Commit**

```bash
git add packages/lsp/src/client/runtime.ts packages/lsp/src/client/registry.ts packages/lsp/src/tools/lsp-tool.ts packages/lsp/src/hooks/writethrough.ts packages/lsp/test/registry.test.ts packages/lsp/test/runtime.test.ts packages/lsp/test/document-sync.test.ts packages/lsp/test/writethrough.test.ts
git commit -m "fix(lsp): synchronize documents before path-based requests"
```

---

### Task 12: Make reload reactivation deterministic for path-based requests

**TDD scenario:** Bug fix - modifying tested code

**Files:**
- Modify: `packages/lsp/src/client/registry.ts`
- Modify: `packages/lsp/src/index.ts` only if session lifecycle wiring must change
- Test: `packages/lsp/test/registry.test.ts`
- Test: `packages/lsp/test/document-sync.test.ts`

**Step 1: Add failing reload-specific tests beyond document sync**

Cover the real sequence seen in the Rust repo:
- warm path-based request succeeds
- `reload` returns to inactive/discovered state
- first immediate path-based request after reload succeeds without a warmup workspace request

Example:

```ts
it("allows the first path-based request after reload without requiring an intermediate workspace request", async () => {
  // warm request
  // reload
  // immediate hover or diagnostics on same file succeeds
});
```

**Step 2: Run tests to verify they fail**

Run:

```bash
mise exec node@25.8.1 -- npx vitest run \
  packages/lsp/test/registry.test.ts \
  packages/lsp/test/document-sync.test.ts
```

Expected: FAIL if reload still loses required per-document or per-runtime setup.

**Step 3: Implement the smallest fix**

Likely requirements:
- `reload()` must fully clear stale runtime and document state
- the next path-based request must recreate the runtime cleanly
- the same request path must also resync the document before issuing the LSP method

Do not add global warmup hacks here.

**Step 4: Run the tests again**

Expected: PASS

**Step 5: Commit**

```bash
git add packages/lsp/src/client/registry.ts packages/lsp/test/registry.test.ts packages/lsp/test/document-sync.test.ts
git commit -m "fix(lsp): make reload-safe document reactivation deterministic"
```

---

### Task 13: Codify rename as preview-only behavior

**TDD scenario:** Behavior clarification with documentation and tests

**Files:**
- Modify: `packages/lsp/README.md`
- Modify: `packages/lsp/src/tools/lsp-tool.ts` if output wording should explicitly say preview-only
- Create or modify: `packages/lsp/test/lsp-tool.test.ts`
- Reference only: `packages/lsp/test/writethrough.test.ts`

**Intent:** Make the contract explicit so future work does not accidentally implement file mutation under the existing `rename` action.

**Step 1: Write failing tests or assertions for the intended contract**

Add coverage for the user-visible behavior:
- `rename` returns the workspace edit payload from the server
- `rename` does not write files
- tool output or documentation makes the preview-only behavior explicit

**Step 2: Run the tests to verify they fail if new wording/assertions are added**

Run:

```bash
mise exec node@25.8.1 -- npx vitest run packages/lsp/test/lsp-tool.test.ts
```

Expected: FAIL if explicit preview-only wording or contract assertions are newly added.

**Step 3: Implement the minimal clarification**

At minimum:
- README must state that `rename` is preview-only
- if helpful, tool output should label the payload as a preview/workspace edit result rather than an applied rename

Do not add automatic rename application.

**Step 4: Run tests and documentation verification**

Run:

```bash
mise exec node@25.8.1 -- npx vitest run packages/lsp/test/lsp-tool.test.ts
mise exec node@25.8.1 -- npx biome check packages/lsp/README.md packages/lsp/src/tools/lsp-tool.ts packages/lsp/test/lsp-tool.test.ts
```

Expected: PASS

**Step 5: Commit**

```bash
git add packages/lsp/README.md packages/lsp/src/tools/lsp-tool.ts packages/lsp/test/lsp-tool.test.ts
git commit -m "docs(lsp): define rename as preview-only"
```

---

### Task 14: Investigate and, if justified, fix workspace-symbol flakiness last

**TDD scenario:** Systematic debugging first, then TDD

**Files:**
- Modify: `packages/lsp/src/client/registry.ts` only if a fix is proven necessary
- Modify: `packages/lsp/src/client/runtime.ts` only if a fix is proven necessary
- Modify: `packages/lsp/README.md` if the behavior remains partially limited
- Create: `packages/lsp/test/workspace-symbol.test.ts` if needed
- Update: `docs/plans/2026-03-22-lsp-lazy-activation-root-detection.md` with final findings

**This task must remain last. Do not start it before Tasks 10-13 are green and manually reverified.**

### Known currently available detail

Observed in the Rust repo:
- `workspace/symbol` returned 3 results in one run
- `workspace/symbol` returned `[]` in another run
- `workspace/symbol` timed out in another run
- these observations happened during cold activation and after reload
- one repeated `hover` also timed out once after the runtime was nominally ready
- it is not yet proven whether this is:
  - rust-analyzer indexing latency
  - missing document/workspace synchronization
  - request ordering during activation
  - generic timeout policy that is too aggressive

### Required debugging order

**Step 1: Reproduce after Tasks 10-13 land**

Re-run manual verification against:
- `/home/aasoft/projects/oss/bevy/bevy/bevy_voxel_world`

using sequences that separate:
- cold first workspace-symbol request
- warm workspace-symbol request
- post-reload workspace-symbol request

Capture exact outputs again.

**Step 2: Decide whether the bug still exists**

- If the flakiness disappears after document-sync and reload fixes, document that outcome and stop.
- If the flakiness remains, continue.

**Step 3: Write the smallest failing test that models the proven cause**

Examples of acceptable targeted behaviors:
- a server that returns a retry/cancel signal once during warmup
- a server that delays workspace-symbol readiness until after initialization completes
- a server that times out under the current timeout budget but passes with a narrowly-scoped retry policy

Do not add generic retries without a failing test proving they are needed.

**Step 4: Implement the minimal fix only if justified**

Potential acceptable fixes, only if proven by tests and manual repro:
- narrowly-scoped retry for `workspace/symbol` on a specific transient LSP cancellation shape
- activation/readiness gating for the first workspace request
- a dedicated timeout policy for workspace-symbol requests

Potential unacceptable fixes unless the evidence demands them:
- broad retries for all LSP methods
- arbitrary sleeps
- forcing eager startup again

**Step 5: Re-run manual verification**

Run the real Pi command again against `bevy_voxel_world` and capture output.

**Step 6: If the issue remains, document it explicitly instead of guessing**

Update README and this plan with:
- what was tried
- what still fails
- exact error forms
- why the remaining behavior is being deferred

**Step 7: Commit**

If fixed:

```bash
git add packages/lsp/src/client/registry.ts packages/lsp/src/client/runtime.ts packages/lsp/test/workspace-symbol.test.ts packages/lsp/README.md docs/plans/2026-03-22-lsp-lazy-activation-root-detection.md
git commit -m "fix(lsp): stabilize workspace symbol activation"
```

If only documented:

```bash
git add packages/lsp/README.md docs/plans/2026-03-22-lsp-lazy-activation-root-detection.md
git commit -m "docs(lsp): record remaining workspace symbol limitations"
```

---

## Phase 2 Verification Checklist

Do not claim completion until all of these are true.

### Automated
- focused LSP suite passes
- any new document-sync tests pass
- any new tool-router tests pass
- full repo test suite passes
- typecheck passes
- repo check command passes

### Real-world manual verification
Against `/home/aasoft/projects/oss/bevy/bevy/bevy_voxel_world`:
- cold first document-scoped `hover` succeeds
- cold first document-scoped `diagnostics` succeeds
- `definition` succeeds
- `references` succeeds
- warm `workspace/symbol` succeeds consistently
- first path-based request after `reload` succeeds without needing an intermediate workspace request
- rename returns a preview payload and leaves the working tree unchanged

### Documentation
- README says rename is preview-only
- README describes any remaining workspace-symbol limitation if unresolved
- this plan file clearly reflects final complete vs incomplete state

---

## Follow-up Work After Phase 2

Only consider these after the remaining regressions are closed or explicitly documented:
- import more of OpenCode's long-tail server catalog
- add custom linter/fixer providers with multi-provider diagnostics aggregation
- optional background warmup of top detected providers
- idle shutdown configuration exposed through config
- richer per-language root strategies for more monorepo ecosystems
