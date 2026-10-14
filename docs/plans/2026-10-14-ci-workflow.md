# Plan: add CI (typecheck, build, test) and a light ESLint config

- **Severity:** P2 (nothing stops a broken commit reaching main)
- **Effort:** S
- **Status:** Plan only. Implementation follows after approval.

## Finding

- The repo has no `.github/` directory, so no CI runs on push or pull request. Main @ d64497c went straight in without automated checks.
- Locally on main, `npm ci`, `npm run typecheck`, `npm run build` and `npm test` all pass: 5 test files passed, 1 skipped (51 passed, 2 live-smoke skipped). So CI can be green from day one.
- No linter is configured.
- `npm audit` (measured 2026-10-14 on main @ d64497c): **7 advisories (3 moderate, 1 high, 3 critical), all in the dev/test toolchain** (vitest 2.x via tinypool, vite, esbuild). `npm audit --omit=dev` reports **0**. The only offered fix is `vitest@5`, a breaking major upgrade. (Re-audit correction: the first draft said "not triaged".)

## Proposed fix

1. **`.github/workflows/ci.yml`** (the convention shared across the MCP repos):
   - `on: push` (branches: main) and `pull_request`
   - `permissions: contents: read`
   - a `concurrency` group that cancels superseded runs
   - one job on `ubuntu-latest`:
     - `actions/checkout@v4`
     - `actions/setup-node@v4` with `node-version: 22`, `cache: npm`
     - `npm ci`, `npm run typecheck`, `npm run build`, `npm test`
   - The live smoke tests stay skipped (no `RUN_SMOKE`), so CI never hits raivatedu.com.
2. **ESLint (light, optional second step):**
   - dev dependencies `eslint`, `@eslint/js` and `typescript-eslint`, pinned exact versions
   - `eslint.config.js` with `js.configs.recommended` and `tseslint.configs.recommended` over `src/` and `tests/`
   - `"lint": "eslint ."`
   - Fix or explicitly disable any findings in the same PR so it starts green. If findings exceed about 20, ship CI without lint and file a follow-up.
3. **`npm audit --omit=dev --audit-level=high` as a blocking step** from day one: it is 0 today, so it only fails when a shipped dependency picks up an advisory. (Re-audit 2026-10-14: the first draft made it optional and non-blocking.) Do not audit dev dependencies in CI until the toolchain is upgraded.
4. **Follow-up, separate PR:** upgrade vitest 2 → current major (and `@vitest/coverage-v8` with it) to clear the 7 dev advisories; CI makes that upgrade safe to check.
5. Later plans add steps here: `check:versions` from the registry plan.

## Tests to add

- The workflow is the test. Verify with the PR's own CI run (green), plus a throwaway commit with a type error that turns it red, then revert.

## Risks / founder decisions

- **Founder decision:** make CI a required status check on `main` (a branch protection setting in GitHub, done by a repo admin).
- Adds about 1 minute per push. ESLint adds dev dependencies only, with no runtime impact.
