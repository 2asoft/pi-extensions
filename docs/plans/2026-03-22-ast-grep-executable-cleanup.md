# AST executable cleanup Implementation Plan

  > ** REQUIRED SUB - SKILL:** Use the executing - plans skill to implement this plan task - by - task.

** Goal:** Make the AST extension require a system - installed`ast-grep` executable, stop relying on the npm `@ast-grep/cli` package, and stop invoking the conflicting `sg` binary.

** Architecture:** Keep the existing tool surface(`sg_health`, `ast_search`, `ast_rewrite`) but change the command runner to invoke `ast-grep` directly.Remove local PATH augmentation tied to`node_modules/.bin`, then update repository metadata and docs so installation requirements match runtime behavior.

** Tech Stack:** TypeScript, Vitest, Bun workspace metadata, pi extension tool API

---

### Task 1: Establish baseline behavior

  ** TDD scenario:** Modifying tested code - run existing tests first

    ** Files:**
      - Test: `packages/ast/test/integration.test.ts`

        ** Step 1: Run existing AST tests **

          Run: `bun test packages/ast/test/integration.test.ts`
Expected: current failures show the `sg` executable conflict on this system.

** Step 2: Record failing behavior **

  Expected: failures or tool errors reference `sg` usage or incorrect executable resolution.

### Task 2: Add failing test coverage for executable selection

  ** TDD scenario:** New feature - full TDD cycle

    ** Files:**
      - Modify: `packages/ast/test/integration.test.ts`
        - Modify: `packages/ast/src/index.ts`

          ** Step 1: Write the failing test **

            Add a behavior test for `sg_health` that expects successful output from the `ast-grep` executable name.

** Step 2: Run test to verify it fails **

  Run: `bun test packages/ast/test/integration.test.ts`
Expected: the new test fails before implementation because the code still calls`sg`.

### Task 3: Switch runtime command invocation

  ** TDD scenario:** Modifying tested code - run focused tests after each change

    ** Files:**
      - Modify: `packages/ast/src/index.ts`
        - Modify: `packages/ast/src/tools/ast-search.ts`
          - Modify: `packages/ast/src/tools/ast-rewrite.ts`
            - Modify: `packages/ast/src/utils/exec.ts`

              ** Step 1: Replace command names **

                Change hardcoded `sg` invocations to`ast-grep`.

** Step 2: Remove local npm binary PATH augmentation **

  Simplify`exec` so it no longer prefers `node_modules/.bin` for this package.

** Step 3: Run focused tests **

  Run: `bun test packages/ast/test/integration.test.ts`
Expected: AST integration tests pass using system `ast-grep`.

### Task 4: Remove npm dependency and align repository metadata

  ** TDD scenario:** Trivial change - use judgment

    ** Files:**
      - Modify: `package.json`
        - Modify: `bun.lock`
          - Modify: `scripts/scorecard.ts`

            ** Step 1: Remove the unused dependency metadata **

              Delete`@ast-grep/cli` from root workspace metadata.

** Step 2: Update scorecard expectations **

  Replace hardening checks that assume `sg` or `node_modules/.bin` behavior with checks that reflect `ast-grep` and the simplified exec helper.

** Step 3: Refresh lockfile if needed **

  Run the appropriate package manager command so `bun.lock` matches`package.json`.

### Task 5: Update docs

  ** TDD scenario:** Trivial change - use judgment

    ** Files:**
      - Modify: `packages/ast/README.md`

        ** Step 1: Update user - facing command references **

          Document`ast-grep` rather than`sg` in feature descriptions and prerequisites.

** Step 2: Mention system dependency expectation **

  State that users must install the system `ast-grep` package and expose`ast-grep` in PATH.

### Task 6: Verify the complete change

  ** TDD scenario:** Modifying tested code - run relevant checks after changes

    ** Files:**
      - Test: `packages/ast/test/integration.test.ts`
        - Test: `package.json`
          - Test: `scripts/scorecard.ts`

            ** Step 1: Run AST tests **

              Run: `bun test packages/ast/test/integration.test.ts`
Expected: PASS

  ** Step 2: Run repo checks affected by metadata / code changes **

    Run: `bun run typecheck`
Expected: PASS

Run: `bun run scorecard:check`
Expected: PASS

  ** Step 3: Commit **

    ```bash
git add docs/plans/2026-03-22-ast-grep-executable-cleanup.md packages/ast/src/index.ts packages/ast/src/tools/ast-search.ts packages/ast/src/tools/ast-rewrite.ts packages/ast/src/utils/exec.ts packages/ast/test/integration.test.ts packages/ast/README.md package.json bun.lock scripts/scorecard.ts
git commit -m "fix(ast): use system ast-grep executable"
```
