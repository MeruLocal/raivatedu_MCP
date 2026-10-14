# Plan: add CI (typecheck, build, test) and a light ESLint config

- **Severity:** P2 (nothing stops a broken commit reaching main)
- **Effort:** S
- **Status:** Plan only. Implementation follows after approval.

## Finding

- The repo has no `.github/` directory, so no CI runs on push or pull request. Main @ d64497c went straight in without automated checks.
- Locally on main, `npm ci`, `npm run typecheck`, `npm run build` and `npm test` all pass: 5 test files passed, 1 skipped (51 passed, 2 live-smoke skipped). So CI can be green from day one.
- No linter is configured.
- `npm ci` reports existing `npm audit` advisories (not triaged here).

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
3. Later plans add steps here: `check:versions` from the registry plan, and optionally `npm audit --omit=dev --audit-level=high` as non-blocking.

## Tests to add

- The workflow is the test. Verify with the PR's own CI run (green), plus a throwaway commit with a type error that turns it red, then revert.

## Risks / founder decisions

- **Founder decision:** make CI a required status check on `main` (a branch protection setting in GitHub, done by a repo admin).
- Adds about 1 minute per push. ESLint adds dev dependencies only, with no runtime impact.
