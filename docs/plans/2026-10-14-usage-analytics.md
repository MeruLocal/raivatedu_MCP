# Plan: record anonymous tool usage (tool, client, latency, outcome)

- **Severity:** P2 (no way to tell whether the MCP is used, by which assistants, or which tools fail)
- **Effort:** S
- **Status:** Plan only. Implementation follows after approval.
- **Audit check:** skill §4 V4 · MCP Center C18.usage

## Finding

- No usage signal exists. `rg -n -i "usage|analytics|latency|metric" src` on main @ d64497c finds only feature names in catalog text.
- The logger (`src/utils/logger.ts`) writes free-text lines to stderr. Tool handlers log nothing on success; failures are only visible as `[WARN] Retrying …` lines from the website client.
- So the founder cannot answer: how many calls a day, from which clients (Claude, ChatGPT, Cursor …), which tools, how often they fail, and how slow they are. That also means the UTM work (PR #7) has no server-side counterpart to compare against.

**Not checked:** whatever request logging Cloudflare/Apache already keep in front of the server (they see `POST /mcp` only, not the tool name).

## Proposed fix

1. **New `src/utils/usage.ts`:** `recordToolCall({ tool, client, clientVersion, transport, market?, ok, errorKind?, latencyMs })`.
   - Writes **one JSON line to stderr** at `info` level with a fixed `event: "tool_call"` key, so any log shipper can count it. No new dependency and no outbound call.
   - **Never** records tool arguments other than `market` (a closed enum). `query`, `path` and free text are excluded: a search query can contain personal data.
   - `errorKind` is a closed set (`validation`, `upstream`, `timeout`, `internal`) derived from the error class, never from message text.
2. **Wrap registration once:** in `src/tools/index.ts`, wrap `server.registerTool` (or each handler) so every tool gets timing and outcome without per-tool edits.
3. **Client identity:** read `clientInfo.name`/`version` from the initialize request (`server.server.getClientVersion()` in the SDK). In the stateless HTTP mode every POST builds a new server, so for non-initialize requests fall back to the `User-Agent` header, truncated to 80 chars and stripped to `[A-Za-z0-9._/ -]`.
4. **Off switch:** `RAIVATEDU_USAGE_LOG=0` disables it (default on for HTTP, off for stdio, where the user runs it locally). Document in `.env.example`.
5. Optional later step (founder's call): ship these lines to the same analytics store the other Meru MCP servers use, so one dashboard covers all of them.

## Tests to add (`tests/usage.test.ts`)

- A successful call emits one `tool_call` line with `ok: true`, the tool name and a numeric `latencyMs`.
- A validation failure emits `ok: false, errorKind: "validation"`.
- A `search_content` call with a query containing an email address: the email does not appear anywhere in stderr.
- `RAIVATEDU_USAGE_LOG=0` emits nothing.
- The stdio default emits nothing.

## Risks / founder decisions

- Log volume: one short line per call. Negligible at current traffic.
- IP addresses are not recorded (the proxy already has them). **Founder decision:** keep it that way, or record a truncated/hashed IP for abuse analysis?
- **Founder decision:** whether usage should flow into a shared store (step 5); this plan stops at structured stderr lines.
