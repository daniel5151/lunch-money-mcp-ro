# Lunch Money v2 — Live Static Mock Server (source of truth)

The real Lunch Money v2 API ships a **static mock server** that returns
spec-faithful data with no real account and no real token. **This is the source
of truth for all exploration and validation of this MCP server.** Assertions in
`test/run-live.js` are grounded in the shapes this mock actually returns.

## Endpoints & auth

- **Live mock base URL:** `https://mock.lunchmoney.dev/v2`
- **Real API (do NOT point exploration at this):** `https://api.lunchmoney.dev/v2`
- **Auth:** any Bearer token **11+ characters long** (e.g. `live-validate-token-123456`).
  A token shorter than 11 chars → `401 {"message":"Unauthorized","errors":[{"errMsg":"Access token does not exist."}]}`.
- **OpenAPI spec:** `https://alpha.lunchmoney.dev/v2/openapi` (YAML; human docs at
  `/v2/docs` render it via Scalar). Saved copy:
  `~/workspace/lm-mcp-explore/lunchmoney-v2-openapi.yaml`.

The server reads `LM_API_BASE_URL` and `LUNCHMONEY_API_KEY` from env, so it can
be pointed anywhere without code changes.

## How to run the live validation

```sh
# npm test starts the relay automatically (pretest hook) then runs the suite:
cd /root/src/lunch-money-mcp-ro && npm test          # = start-relay.sh + node test/run-live.js

# or do it by hand:
bash ~/workspace/lm-mcp-explore/start-relay.sh       # 1. start the relay (idempotent)
npm run test:live                                    # 2. = node test/run-live.js
```

`test/run-live.js` spawns the real MCP server pointed at the relay, does the
JSON-RPC/stdio handshake, and asserts on live-mock data. It is the **only** test
suite — the former hand-rolled in-process mock (`run.js` / `mock-lm-server.js`)
was deleted because it fabricated response shapes that hid real bugs (see the
recurring-items note below). The reusable stdio MCP client is
`~/workspace/lm-mcp-explore/client.mjs`.

## ⚠️ Two sandbox-only network constraints (NOT server bugs)

The production server runs where it can reach `api.lunchmoney.dev` directly.
Inside this VM, egress only works through `hatch-egress-proxy:3128`. Two
consequences, both worked around for testing only:

1. **Raw `https` ignores `https_proxy`.** The server's `nativeFetch` uses Node's
   `https` module directly, so pointing it straight at `https://mock.lunchmoney.dev`
   times out. **Workaround: the relay** (`~/workspace/lm-mcp-explore/relay.mjs`)
   listens plain HTTP on `127.0.0.1:8787` (in the `no_proxy` range), opens a
   CONNECT tunnel through the egress proxy per request, does TLS to the mock,
   and returns the response. Point the server at it:
   ```
   LM_API_BASE_URL=http://127.0.0.1:8787/v2
   LUNCHMONEY_API_KEY=live-validate-token-123456   # any 11+ char string
   ```

2. **The egress proxy truncates large tunneled bodies (~8 KB cap, intermittent).**
   A full `/transactions?limit=2000` response is ~10.5 KB and almost never
   arrives complete; single-attempt success even for small (~600 B) bodies is
   only ~67%. Two mitigations:
   - **Relay buffers + validates against `Content-Length` and retries the whole
     request up to 8× (`RELAY_MAX_TRIES`).** This makes small-body requests
     effectively 100% reliable.
   - **`test/run-live.js` sets `LM_TX_BATCH_LIMIT=5`** so the server's
     in-memory-filter loop (search / multi-category / category-group) pages in
     small chunks instead of one 2000-row request. See the product seam below.

## Product change made during live validation

- **`LM_TX_BATCH_LIMIT` (new env seam, default 2000, clamped 1..2000).** Page
  size for the transaction in-memory-filter loop. Production default is
  unchanged; it only matters on networks/proxies that cap body size or for
  rate-limit-sensitive setups.

- **Recurring-items renderer bug — FOUND & FIXED via the live mock.** The v2
  `recurringObject` nests `amount`/`currency`/`payee` under
  `transaction_criteria`, the display label under `overrides`, and upcoming
  dates under `matches.expected_occurrence_dates`. There is **no** top-level
  `amount`/`payee`/`billing_date`. The old renderer read `r.amount` /
  `r.billing_date` → printed `undefined`, and the single-item branch
  discriminated on `billing_date` (a field that doesn't exist). The in-process
  mock had *fabricated* a flat shape that matched the bug, so `run.js` passed
  while real output was broken. Fixed the renderer, corrected the in-process
  mock to the real nested shape, and added recurring assertions to the live suite. (The in-process mock was later deleted entirely.)

## Live mock data shape (as of 2026-06-19)

- **User:** "User 1", `user-1@lunchmoney.dev`, budget "🏠 Family budget", usd.
- **Categories:** Automobile (group), Food (group), Gifts, Home Supplies,
  Interest Income, Rent, Transfer, W2 Income.
- **Tags:** Date Night, Penny's, Road Trip.
- **Accounts:** several manual (Individual Brokerage @ Fidelity, Euro Travel
  Card, Savings Shoebox) + Plaid synced (401k @ Vanguard, Freedom @ Chase, …).
- **Transactions:** real-looking payees ("Food Town", "Rent"), some with
  `category_id: null` (good for "categorize my spending" tasks), statuses
  `unreviewed`/`delete_pending`, `source: plaid`. Paginates via
  `limit`/`offset`/`has_more`.
- **Recurring items:** ids 994069 ("Income"/Penny Lane→Paycheck) and 994079
  (rent), nested `transaction_criteria` + `overrides` + `matches`.
- The mock is **static** — same data every call.
