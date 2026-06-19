# Tests

End-to-end tests for the Lunch Money read-only MCP server. They run the **real
server process** against the **official Lunch Money v2 static mock API**
(`mock.lunchmoney.dev/v2`), talk to it over stdio JSON-RPC exactly as an MCP
client would, and assert on the rendered output. No real account and no real
API key are required — the static mock accepts any Bearer token of 11+
characters and returns spec-faithful data.

> Why only the live mock? An earlier hand-rolled in-process mock fabricated
> response shapes that did **not** match the real v2 API (most notably the
> nested `recurringObject`), so it passed while real output was broken. A mock
> that lies is worse than no mock, so it was removed. Everything here now
> validates against the real v2 shapes the official mock returns.

## Running

```sh
npm test
```

That's it. A `pretest` hook starts the local relay (idempotent), then the suite
spawns the server pointed at the relay, runs the JSON-RPC handshake, calls
tools, and asserts on the rendered output. It prints `PASS`/`FAIL` lines and a
count. Exit code is `0` on success, `1` if any assertion fails, `2` on a
harness/preflight error (e.g. the relay is unreachable).

Requires Node >= 20.6 (same as the server).

You can also run the runner directly (relay must already be up):

```sh
node test/run-live.js
```

## What's here

| File | Purpose |
| --- | --- |
| `run-live.js` | The test runner: spawns the server pointed at the relay, performs the JSON-RPC handshake, calls tools, asserts on output against live-mock data. |
| `MOCK-SERVER.md` | Documents the official static mock, the local relay, the sandbox-only network workarounds, and the live data shapes the assertions rely on. |

## How it fits together

The server supports an `LM_API_BASE_URL` override (defaulting to the real
`https://api.lunchmoney.dev/v2`). The test points it at a local relay on
`127.0.0.1:8787`, which tunnels to the official static mock at
`mock.lunchmoney.dev/v2`. So the exact code path a client hits in production is
what gets exercised — including auth, error handling, and the markdown/JSON
renderers.

```
run-live.js --spawns--> lunch-money-mcp-ro.js --HTTP(LM_API_BASE_URL)--> relay (127.0.0.1:8787) --CONNECT tunnel--> mock.lunchmoney.dev/v2
     |                         |
     +------stdio JSON-RPC-----+
```

The relay exists only because of two sandbox-only network constraints (raw
`https` ignoring the proxy, and the egress proxy truncating large bodies). Both
are explained in detail in `MOCK-SERVER.md`. The relay buffers + validates
`Content-Length` and retries, and the runner sets `LM_TX_BATCH_LIMIT=5` to page
transactions in small chunks.

## What's covered

- Handshake + `tools/list` (all tools present).
- Budget summary rendering: child-category id -> name flattening, fixed 2dp
  money formatting, no float-drift digits, no `undefined` cells.
- Budget settings rendering: markdown section (not a JSON fallback), boolean
  settings surfaced, income option surfaced.
- Recurring items: the nested `recurringObject` shape (`transaction_criteria` /
  `overrides` / `matches`) renders cadence/granularity, resolves a live id, has
  no `undefined`, and isn't misrendered as a transaction.
- `output_format: json` field selection: core fields kept, bulky/irrelevant
  fields dropped, explicit `fields` allowlist returns only those keys.
- Error passthrough: a `401` surfaces its real auth-failure message instead of
  an empty `{}` body.
- A global sweep asserting no tool unexpectedly falls back from markdown to a
  raw JSON dump.

## Adding a test

Assertions use a tiny `ok(condition, message, detail)` helper in `run-live.js`.
Most tests call a tool and check the returned text:

```js
let r = await callTool('list_tags', {});
ok(r.text && r.text.includes('Road Trip'), 'list_tags surfaces tag names', r.text);
```

The mock is **static** (same data every call), so assert against the known
fixtures documented in `MOCK-SERVER.md` (users, categories, tags, accounts,
recurring ids `994069`/`994079`, etc.). To test a failure mode, use a token
shorter than 11 chars for a `401`, or an unknown id for a `404`.
