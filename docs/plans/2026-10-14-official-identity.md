# Plan: present the server as the official RaivatEdu MCP and document HTTP/Docker

- **Severity:** P1 (contradictory identity, and missing deploy docs for the hosted endpoint)
- **Effort:** S
- **Status:** Plan only. Implementation follows after approval.

## Finding

- The founder runs RaivatEdu, and this is meant to be the official RaivatEdu MCP. The repo calls itself unofficial in three places:
  - `README.md:3`: "An unofficial, read-only … MCP server"
  - `README.md:379`: "Independent/unofficial; … Not affiliated or endorsed."
  - `LICENSE:25-27`: "independent, unofficial integration … not affiliated with or endorsed by them"
- Meanwhile the default User-Agent (`src/config.ts:165`) identifies the server to raivatedu.com as `raivat-education-mcp-server/1.0.0 (+https://raivatedu.com; read-only MCP client)`, which reads as first-party. The two contradict each other.
- `.env.example:21` contains the placeholder `https://github.com/your-org/raivat-education-mcp`. The real repo is `MeruLocal/raivatedu_MCP`.
- The README documents only stdio. It has no section on the HTTP transport (`--http` / `TRANSPORT=http`, `PORT` default 3000, `POST /mcp`, `/health`, `/version`, `/.well-known/mcp.json`) or on the existing multi-stage `Dockerfile` (HTTP on port 3000, non-root).
- The README test count is hard-coded ("51 tests", `README.md:289`) and will drift.
- `package.json` has no `repository`, `homepage` or `bugs` fields, and no `author` (re-audit 2026-10-14, skill §4 B4). npm, Smithery and Glama read these to show who publishes the server; today nothing ties the package to `MeruLocal/raivatedu_MCP`.

**Not checked:** the legal entity name (see founder decision below).

## Proposed fix (docs and comments only, no behaviour change)

1. **README intro:** "The official, read-only MCP server for RaivatEdu (raivatedu.com) …".
2. **README licence line and the LICENSE notice:**
   - Remove the "unofficial", "independent" and "not affiliated/endorsed" wording.
   - Keep the owner/marks sentence **exactly as it is** ("RaivatEdu" marks belong to RaivatEdu Technologies Pvt. Ltd.). Legal-owner names are out of scope.
   - The MIT text above the `---` is untouched.
3. **`.env.example:21`:** use `RAIVATEDU_USER_AGENT=raivat-education-mcp/1.0 (+https://github.com/MeruLocal/raivatedu_MCP)`.
4. **New README section, "Run over HTTP / Docker":**
   - `npm run start:http` or `TRANSPORT=http`, and `PORT`
   - endpoint `POST /mcp` (Streamable HTTP, stateless, JSON responses)
   - `GET /mcp` returns 405 by design
   - `/health`, `/version`, `/.well-known/mcp.json`
   - `docker build -t raivatedu-mcp . && docker run -p 3000:3000 raivatedu-mcp`
   - an Inspector example: `npx @modelcontextprotocol/inspector --cli http://localhost:3000/mcp --transport http --method tools/list`
   - the hosted URL `https://mcp.raivatedu.com/mcp`, once confirmed
5. Replace "51 tests" with wording that has no count (repo rule: counts drift).
6. **`package.json`:** add `repository` (`git+https://github.com/MeruLocal/raivatedu_MCP.git`), `homepage` (the repo README, or `https://www.raivatedu.com` if the founder prefers) and `bugs` (the repo issues URL). Leave `author` unset unless the founder supplies it: it names a legal owner, which is out of scope here.

## Tests to add

- `tests/identity.test.ts` asserts `package.json` has `repository.url` containing `MeruLocal/raivatedu_MCP`. It also reads README, LICENSE and `.env.example` and asserts that none of them match `/unofficial|not affiliated|your-org/i`, and that the README contains `/mcp` and `PORT`.
- The existing User-Agent test (`tests/website-client.test.ts`) stays.

## Risks / founder decisions

- **Founder decision (required):** confirm that "RaivatEdu Technologies Pvt. Ltd." is the right owner of the marks. If it is wrong, the founder supplies the change; this plan will not edit it.
- **Founder decision:** whether the LICENSE notice should be dropped entirely rather than reworded.
- **Founder decision:** the `author` value for `package.json`, if any.
- The hosted URL in the README depends on the status-page plan's `PUBLIC_BASE_URL` decision.
