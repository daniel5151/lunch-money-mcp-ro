#!/usr/bin/env node
// LIVE end-to-end validation for lunch-money-mcp-ro against the official
// Lunch Money v2 static mock (https://mock.lunchmoney.dev/v2), reached through
// the local relay (see test/MOCK-SERVER.md). This is the live counterpart to
// run.js: same JSON-RPC-over-stdio path a real client sees, but every assertion
// is grounded in the REAL v2 response shapes the mock returns, so it catches
// schema drift that a hand-written in-process mock can hide.
//
// Prereqs:
//   1. relay running:  node ~/workspace/lm-mcp-explore/relay.mjs &
//   2. run:            node test/run-live.js
// The relay listens on 127.0.0.1:8787 (no_proxy range) and tunnels to the mock
// through the egress proxy. Any Bearer token of 11+ chars is accepted.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import http from 'node:http';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER = resolve(__dirname, '..', 'lunch-money-mcp-ro.js');
const NODE = process.execPath;

const RELAY_BASE = process.env.LM_LIVE_BASE || 'http://127.0.0.1:8787/v2';
const TOKEN = process.env.LM_LIVE_TOKEN || 'live-validate-token-123456'; // 11+ chars

// --- preflight: relay must be up, or the whole run is meaningless ---
function preflight() {
  return new Promise((res) => {
    const u = new URL(RELAY_BASE + '/me');
    const req = http.request({ hostname: u.hostname, port: u.port, path: u.pathname, method: 'GET',
      headers: { Authorization: `Bearer ${TOKEN}` }, timeout: 30000 }, (r) => {
      let d = ''; r.on('data', (c) => d += c); r.on('end', () => res({ status: r.statusCode, body: d }));
    });
    req.on('timeout', () => { req.destroy(); res({ status: 0, body: 'timeout' }); });
    req.on('error', (e) => res({ status: 0, body: e.message }));
    req.end();
  });
}

const pre = await preflight();
if (pre.status !== 200) {
  console.error(`PREFLIGHT FAILED: relay at ${RELAY_BASE} returned ${pre.status}: ${pre.body}`);
  console.error('Start it with:  node ~/workspace/lm-mcp-explore/relay.mjs &');
  process.exit(2);
}

const child = spawn(NODE, [SERVER], {
  // small page size: the sandbox egress proxy caps large tunneled bodies, so
  // the in-memory-filter path must page in small chunks (prod default is 2000).
  env: { ...process.env, LUNCHMONEY_API_KEY: TOKEN, LM_API_BASE_URL: RELAY_BASE, LM_TX_BATCH_LIMIT: '5' },
  stdio: ['pipe', 'pipe', 'pipe'],
});

let buf = '';
const pending = new Map();
child.stdout.on('data', (d) => {
  buf += d.toString();
  let idx;
  while ((idx = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    if (msg.id !== undefined && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  }
});
let stderr = '';
child.stderr.on('data', (d) => { stderr += d.toString(); });

let nextId = 1;
function rpc(method, params) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, resolve);
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    // generous: each call may traverse the (sometimes slow) egress proxy
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error(`timeout on ${method}`)); } }, 90000);
  });
}
function notify(method, params) {
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
}

async function callTool(name, args) {
  const r = await rpc('tools/call', { name, arguments: args || {} });
  if (r.error) return { error: r.error };
  const txt = r.result && r.result.content && r.result.content[0] && r.result.content[0].text;
  return { text: txt, isError: r.result && r.result.isError };
}

let pass = 0, fail = 0;
const results = [];
function ok(cond, msg, detail) {
  if (cond) { pass++; results.push(`PASS - ${msg}`); }
  else { fail++; results.push(`FAIL - ${msg}${detail ? '\n        ' + String(detail).slice(0, 300) : ''}`); }
}

async function finish(code) {
  try { child.kill(); } catch {}
  process.exit(code);
}

(async () => {
  // ---- Handshake ----
  const init = await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'live-harness', version: '1' } });
  ok(init.result && init.result.serverInfo, 'handshake: initialize returns serverInfo', JSON.stringify(init.error || {}));
  notify('notifications/initialized');

  // The exact tool roster is the server's public contract. Asserting the count
  // alone lets a rename, or a drop-and-re-add, pass silently at the same total,
  // so pin the full set of names instead.
  const EXPECTED_TOOLS = [
    'clear_cache', 'get_account', 'get_budget_settings', 'get_budget_summary',
    'get_categories_by_ids', 'get_category', 'get_current_user', 'get_manual_account',
    'get_plaid_account', 'get_recurring_item', 'get_tag', 'get_tags_by_ids',
    'get_transaction', 'get_transaction_attachment_url', 'list_accounts',
    'list_categories', 'list_recurring_items', 'list_tags', 'list_transactions',
  ];
  const tools = await rpc('tools/list', {});
  const toolNames = (tools.result && tools.result.tools || []).map(t => t.name).sort();
  ok(JSON.stringify(toolNames) === JSON.stringify([...EXPECTED_TOOLS].sort()),
     `tools/list advertises exactly the expected ${EXPECTED_TOOLS.length} tools`,
     `got: ${toolNames.join(', ')}`);

  // ---- Prompts surface (MCP prompts/list + prompts/get) ----
  // The server advertises two prompts; this surface had zero live coverage, so a
  // regression in registration or argument interpolation would ship silently.
  const plist = await rpc('prompts/list', {});
  const pnames = (plist.result && plist.result.prompts || []).map(x => x.name).sort();
  ok(plist.result && plist.result.prompts.length === 2, `prompts/list returns 2 prompts (got ${plist.result ? plist.result.prompts.length : 'err'})`, JSON.stringify(plist.error || {}));
  ok(JSON.stringify(pnames) === JSON.stringify(['analyze_spending', 'find_untagged']), 'prompts/list advertises analyze_spending + find_untagged', JSON.stringify(pnames));

  // analyze_spending must interpolate the timeframe argument into the message.
  let pg = await rpc('prompts/get', { name: 'analyze_spending', arguments: { timeframe: 'last_month' } });
  let pgText = pg.result && pg.result.messages && pg.result.messages[0] && pg.result.messages[0].content && pg.result.messages[0].content.text;
  ok(pgText && pgText.includes('last_month'), 'prompts/get analyze_spending interpolates the timeframe arg', pgText || JSON.stringify(pg.error || {}));

  // Omitting timeframe must fall back to the documented this_month default.
  pg = await rpc('prompts/get', { name: 'analyze_spending', arguments: {} });
  pgText = pg.result && pg.result.messages && pg.result.messages[0] && pg.result.messages[0].content && pg.result.messages[0].content.text;
  ok(pgText && pgText.includes('this_month'), 'prompts/get analyze_spending defaults timeframe to this_month', pgText || JSON.stringify(pg.error || {}));

  // find_untagged takes no args and must return a user-role message.
  pg = await rpc('prompts/get', { name: 'find_untagged', arguments: {} });
  pgText = pg.result && pg.result.messages && pg.result.messages[0] && pg.result.messages[0].content && pg.result.messages[0].content.text;
  ok(pg.result && pg.result.messages[0].role === 'user' && /tag/i.test(pgText || ''), 'prompts/get find_untagged returns a user message about tags', pgText || JSON.stringify(pg.error || {}));

  // An unknown prompt name must error, not return an empty/blank prompt.
  pg = await rpc('prompts/get', { name: 'does_not_exist', arguments: {} });
  ok(pg.error && /unknown prompt/i.test(pg.error.message || ''), 'prompts/get rejects an unknown prompt name', JSON.stringify(pg.result || pg.error || {}));

  // ---- get_current_user: reaches the LIVE mock ----
  let r = await callTool('get_current_user', {});
  ok(r.text && r.text.includes('### User Profile'), 'get_current_user renders markdown profile (not JSON fallback)', r.text);
  ok(r.text && r.text.includes('user-1@lunchmoney.dev'), 'get_current_user surfaces live mock email', r.text);
  ok(r.text && r.text.includes('Family budget'), 'get_current_user surfaces live budget name', r.text);

  // ---- list_categories: live category set ----
  r = await callTool('list_categories', {});
  ok(r.text && r.text.includes('### Categories'), 'list_categories renders table', r.text);
  ok(r.text && r.text.includes('Food'), 'list_categories includes live "Food" group', r.text);
  ok(r.text && r.text.includes('Rent'), 'list_categories includes live "Rent" category', r.text);

  // ---- get_categories_by_ids: must return EXACTLY the requested ids ----
  // Live v2 mock: group 84 (Food) nests children 315162/315163/315164. The
  // categories renderer recurses into children[], so before the handler stripped
  // children[] a by-ids fetch for the group alone leaked its subcategories as
  // extra rows. Verify the by-ids contract against the real nested shape.
  r = await callTool('get_categories_by_ids', { ids: [84], output_format: 'json' });
  let lgj = null; try { lgj = JSON.parse(r.text); } catch {}
  ok(lgj && Array.isArray(lgj.categories) && lgj.categories.length === 1 && lgj.categories[0].id === 84
       && !(lgj.categories[0].children && lgj.categories[0].children.length),
     'live get_categories_by_ids returns only the requested group, children[] stripped',
     JSON.stringify(lgj && lgj.categories));
  r = await callTool('get_categories_by_ids', { ids: [84] });
  ok(r.text && r.text.includes('Food') && !r.text.includes('Groceries') && !r.text.includes('Dining Out'),
     'live by-ids rendered group does not re-expand its subcategories', r.text);

  // by-ids partial match: a mix of a real id and a bogus one must return only the
  // real record, not error out and not fabricate a row for the missing id.
  r = await callTool('get_categories_by_ids', { ids: [83, 999999999], output_format: 'json' });
  let pcj = null; try { pcj = JSON.parse(r.text); } catch {}
  ok(pcj && Array.isArray(pcj.categories) && pcj.categories.length === 1 && pcj.categories[0].id === 83,
     'get_categories_by_ids returns only matching ids on a partial-match request', r.text);
  r = await callTool('get_tags_by_ids', { ids: [94319, 999999999], output_format: 'json' });
  let ptj = null; try { ptj = JSON.parse(r.text); } catch {}
  ok(ptj && Array.isArray(ptj.tags) && ptj.tags.length === 1 && ptj.tags[0].id === 94319,
     'get_tags_by_ids returns only matching ids on a partial-match request', r.text);

  // ---- list_tags: live tags ----
  r = await callTool('list_tags', {});
  ok(r.text && r.text.includes('### Tags'), 'list_tags renders table', r.text);
  ok(r.text && (r.text.includes('Date Night') || r.text.includes('Road Trip')), 'list_tags surfaces a live tag name', r.text);
  // The live mock's tag 94317 is "Penny&#x27;s" — markdown must decode it.
  ok(r.text && r.text.includes("Penny's") && !r.text.includes('&#x27;'), 'list_tags decodes HTML entity in live tag name', r.text);

  // ---- list_accounts: live manual + plaid ----
  r = await callTool('list_accounts', {});
  ok(r.text && r.text.includes('Manual Accounts'), 'list_accounts renders Manual section', r.text);
  ok(r.text && r.text.includes('Plaid Synced Accounts'), 'list_accounts renders Plaid section', r.text);
  ok(r.text && r.text.includes('Individual Brokerage'), 'list_accounts shows a live manual account', r.text);
  ok(r.text && (r.text.includes('Vanguard') || r.text.includes('Chase')), 'list_accounts shows a live plaid institution', r.text);

  // ---- get_account: single manual + single plaid (live ids) ----
  r = await callTool('get_account', { id: 219807 });
  ok(r.text && !r.isError && r.text.includes('219807'), 'get_account resolves a live manual account', r.text);
  r = await callTool('get_account', { id: 119804 });
  ok(r.text && !r.isError && r.text.includes('119804'), 'get_account resolves a live plaid account', r.text);

  // ---- list_transactions: live data is non-empty and well-formed ----
  r = await callTool('list_transactions', { limit: 5 });
  ok(r.text && r.text.includes('### Transactions'), 'list_transactions renders table', r.text);
  ok(r.text && r.text.includes('Food Town'), 'list_transactions surfaces a live payee', r.text);
  ok(r.text && !r.text.includes('No transactions found'), 'list_transactions is non-empty against live mock', r.text);

  // DEFAULT-RESOLUTION: include_category_names defaults to true, so a plain
  // call must resolve at least one real category name (a word, not a bare
  // "#<id>" reference) with no follow-up list_categories round trip needed.
  ok(r.text && r.text.includes('| Category'), 'list_transactions shows Category column by default (include_category_names default true)', r.text);
  {
    const catCells = [...r.text.matchAll(/\|[^|\n]*\|[^|\n]*\|[^|\n]*\|[^|\n]*\|[^|\n]*\| ([^|\n]+?) \|/g)];
    // Simpler, robust check: the rendered table must contain a resolved name,
    // not only "#digits" placeholders. Rent txn -> category 83 ("Rent").
    ok(/\b(Rent|Food|Automobile|Gifts|Home Supplies|Interest Income|W2 Income)\b/.test(r.text),
       'list_transactions resolves a real category name by default (no #id-only)', r.text);
  }

  // search filter (in-memory path) against live data
  r = await callTool('list_transactions', { limit: 50, search: 'Food Town' });
  ok(r.text && r.text.includes('Food Town'), 'list_transactions search filter matches live payee', r.text);

  // category-name enrichment against live categories (Rent txn -> category 83)
  // include_category_names alone uses the native single-fetch path (enrichment
  // does not trigger the paging loop), so keep limit small to stay under the
  // sandbox proxy's body cap; in production there is no such cap.
  r = await callTool('list_transactions', { limit: 3, include_category_names: true });
  ok(r.text && r.text.includes('| Category'), 'list_transactions include_category_names adds Category column', r.text);

  // JSON shape. concise is the DEFAULT now, so a plain JSON call returns the
  // lean projection (no to_base / original_name); category_name is present
  // because include_category_names also defaults true.
  r = await callTool('list_transactions', { limit: 3, output_format: 'json' });
  let parsed = null; try { parsed = JSON.parse(r.text); } catch {}
  ok(parsed && Array.isArray(parsed.transactions) && parsed.transactions.length > 0, 'list_transactions JSON has transactions[]', r.text);
  const t0 = parsed && parsed.transactions && parsed.transactions[0];
  ok(t0 && typeof t0.amount === 'string' && 'payee' in t0 && 'id' in t0 && 'date' in t0, 'live default txn JSON keeps core fields', JSON.stringify(t0));
  ok(t0 && !('to_base' in t0) && !('original_name' in t0), 'list_transactions is concise by DEFAULT (drops to_base/original_name)', JSON.stringify(t0));
  // category_name resolves by default (include_category_names default true).
  // Check a categorized txn — uncategorized rows legitimately omit the key.
  const catTxn = parsed.transactions.find(t => t.category_id != null);
  ok(catTxn && 'category_name' in catTxn && catTxn.category_name, 'list_transactions default JSON resolves category_name on categorized txns', JSON.stringify(catTxn));

  // Full fidelity remains one opt-out away: concise:false restores the ~23-field
  // record, so nothing is lost — exhaustiveness is preserved.
  r = await callTool('list_transactions', { limit: 3, concise: false, output_format: 'json' });
  let full = null; try { full = JSON.parse(r.text); } catch {}
  const f0 = full && full.transactions && full.transactions[0];
  ok(f0 && typeof f0.amount === 'string' && 'to_base' in f0 && 'payee' in f0, 'concise:false restores full txn JSON (to_base present)', JSON.stringify(f0));

  // single transaction by a live id
  if (t0 && t0.id) {
    r = await callTool('get_transaction', { id: t0.id });
    ok(r.text && r.text.includes(`Transaction #${t0.id}`), 'get_transaction resolves a live id', r.text);
  } else {
    ok(false, 'get_transaction resolves a live id', 'no live txn id available');
  }

  // G1: a single-transaction drill-down resolves category_id -> name, matching
  // the list row it came from (previously printed a bare "Category ID: 83").
  if (catTxn && catTxn.id) {
    r = await callTool('get_transaction', { id: catTxn.id });
    ok(r.text && /- \*\*Category\*\*: .+ \(\d+\)/.test(r.text) && !/- \*\*Category ID\*\*:/.test(r.text),
       'get_transaction resolves category name (G1)', r.text);
    // FAITHFUL JSON: the markdown enrichment must NOT leak into the JSON path.
    // category_name is a presentation-only field; JSON stays a raw passthrough.
    r = await callTool('get_transaction', { id: catTxn.id, output_format: 'json' });
    let txjson = null; try { txjson = JSON.parse(r.text); } catch {}
    ok(txjson && txjson.category_id != null && !('category_name' in txjson),
       'get_transaction JSON stays raw (no synthesized category_name)', r.text);
  } else {
    ok(false, 'get_transaction resolves category name (G1)', 'no categorized live txn id available');
  }

  // ---- BUG#4 regression on LIVE data: recurring v2 nested schema ----
  // The live mock returns transaction_criteria/overrides/matches. A correct
  // renderer must surface amount/payee/cadence with NO "undefined".
  r = await callTool('list_recurring_items', {});
  ok(r.text && r.text.includes('### Recurring Items'), 'list_recurring_items renders table (live)', r.text);
  ok(r.text && !r.text.includes('undefined'), 'live recurring list has no "undefined" (schema bug guard)', r.text);
  // F5: amounts go through formatMoney -> 2dp, never the raw 4-decimal string.
  ok(r.text && (r.text.includes('1250.84') || r.text.includes('850.00')) && !/\d\.\d{3,}/.test(r.text), 'live recurring amount from transaction_criteria (formatted 2dp)', r.text);
  ok(r.text && r.text.includes('month'), 'live recurring cadence/granularity surfaced', r.text);

  // single recurring item by a live id, JSON first to learn the real id
  r = await callTool('list_recurring_items', { output_format: 'json' });
  let recs = null; try { recs = JSON.parse(r.text); } catch {}
  const rec0 = recs && recs.recurring_items && recs.recurring_items[0];
  if (rec0 && rec0.id) {
    r = await callTool('get_recurring_item', { id: rec0.id });
    ok(r.text && r.text.includes(`Recurring Item #${rec0.id}`), 'get_recurring_item resolves a live id', r.text);
    ok(r.text && !r.text.includes('undefined'), 'single live recurring item has no "undefined"', r.text);
    ok(r.text && !r.text.includes('Transaction #'), 'single live recurring item not misrendered as a transaction', r.text);
    // G1: the effective category id (override/criteria) resolves to a name.
    // The seeded Paycheck recurring item carries category 88 (W2 Income).
    const recCatId = rec0.overrides?.category_id ?? rec0.transaction_criteria?.category_id;
    if (recCatId != null) {
      ok(r.text && /- \*\*Category\*\*: .+ \(\d+\)/.test(r.text) && !/- \*\*Category ID\*\*:/.test(r.text),
         'get_recurring_item resolves category name (G1)', r.text);
      // FAITHFUL JSON: enrichment is markdown-only; JSON stays a raw passthrough.
      r = await callTool('get_recurring_item', { id: rec0.id, output_format: 'json' });
      let recjson = null; try { recjson = JSON.parse(r.text); } catch {}
      ok(recjson && !('category_name' in recjson),
         'get_recurring_item JSON stays raw (no synthesized category_name)', r.text);
    }
  } else {
    ok(false, 'get_recurring_item resolves a live id', 'no live recurring id available');
  }

  // ---- get_budget_settings (live) ----
  r = await callTool('get_budget_settings', {});
  ok(r.text && r.text.toLowerCase().includes('budget'), 'get_budget_settings returns content (live)', r.text);
  // F9: must render markdown against the real shape, not fall back to raw JSON.
  ok(r.text && r.text.includes('Budget Settings'), 'F9 live budget settings renders a markdown section', r.text);
  ok(r.text && !r.text.trim().startsWith('{'), 'F9 live budget settings is markdown, not JSON fallback', r.text);
  ok(r.text && /Income Basis/.test(r.text), 'F9 live income option surfaced', r.text);

  // ---- get_budget_summary (live /summary, aligned-aware) ----
  r = await callTool('get_budget_summary', { start_date: '2026-06-01', end_date: '2026-06-30' });
  ok(r.text && !r.isError, 'get_budget_summary returns without error (live)', JSON.stringify(r));
  ok(r.text && !r.text.includes('undefined'), 'get_budget_summary has no "undefined" (live)', r.text);

  // DEFAULT-TOTALS: include_totals defaults to true, so a plain summary call
  // must render the Totals footer (no second call needed) and the JSON must
  // carry the totals object.
  ok(r.text && r.text.includes('**Totals**'), 'get_budget_summary renders Totals footer by default (include_totals default true)', r.text);
  r = await callTool('get_budget_summary', { start_date: '2026-06-01', end_date: '2026-06-30', output_format: 'json' });
  { let bj=null; try { bj=JSON.parse(r.text); } catch {}
    ok(bj && bj.totals && typeof bj.totals === 'object', 'get_budget_summary JSON carries totals by default', r.text); }
  // Opt-out still works: include_totals:false drops the footer.
  r = await callTool('get_budget_summary', { start_date: '2026-06-01', end_date: '2026-06-30', include_totals: false });
  ok(r.text && !r.text.includes('**Totals**'), 'get_budget_summary include_totals:false omits the footer', r.text);

  // ---- NEW (live) #1+#2: child category resolution + money formatting in budget ----
  // The live v2 mock keys most summary rows by 6-digit CHILD ids (e.g. 315162)
  // whose names live under a group's children[]. Resolution requires flattening.
  {
    const lines = (r.text || '').split('\n').filter(l => l.startsWith('| ') && !l.startsWith('| Category') && !l.startsWith('| ---'));
    // At least one row must resolve a child id to a real name, not a bare 6-digit number.
    const hasResolvedChild = lines.some(l => /\| [A-Za-z][^|]*\(31\d{4}\)/.test(l));
    ok(hasResolvedChild, 'NEW#1 live budget resolves a child category id to a name (flattening)', r.text);
    const bareChildId = lines.some(l => /\|\s*31\d{4}\s*\|/.test(l));
    ok(!bareChildId, 'NEW#1 live budget leaves no bare 6-digit child id unresolved', r.text);
    // Every money cell present must be fixed 2dp (or "Not set"/empty) — no float drift.
    ok(!/0000000000/.test(r.text), 'NEW#2 live budget has no float-drift digits', r.text);
    const moneyCells = (r.text.match(/\| -?\d+\.\d+ /g) || []);
    ok(moneyCells.length > 0 && moneyCells.every(c => /\.\d{2} $/.test(c)), 'NEW#2 live budget money cells are all fixed 2dp', JSON.stringify(moneyCells.slice(0,6)));
  }

  // ---- NEW (live) #3: transaction field projection ----
  // concise: lean shape, drops bulky fields (original_name, account ids, split metadata).
  r = await callTool('list_transactions', { limit: 3, concise: true, output_format: 'json' });
  {
    let pj = null; try { pj = JSON.parse(r.text); } catch {}
    const t = pj && pj.transactions && pj.transactions[0];
    ok(t && 'id' in t && 'date' in t && 'amount' in t && 'payee' in t, 'NEW#3 live concise keeps core fields', JSON.stringify(t));
    ok(t && !('original_name' in t) && !('plaid_account_id' in t) && !('manual_account_id' in t) && !('is_group' in t), 'NEW#3 live concise drops bulky/irrelevant fields', JSON.stringify(t));
  }
  // fields: explicit allowlist returns ONLY requested keys.
  r = await callTool('list_transactions', { limit: 3, fields: ['id', 'payee'], output_format: 'json' });
  {
    let pj = null; try { pj = JSON.parse(r.text); } catch {}
    const t = pj && pj.transactions && pj.transactions[0];
    ok(t && Object.keys(t).sort().join(',') === 'id,payee', 'NEW#3 live explicit fields allowlist returns only those keys', JSON.stringify(t));
  }

  // ---- AUTH passthrough on LIVE: a <11 char token must 401 with a real message ----
  const authText = await new Promise((resolveAuth) => {
    const bad = spawn(NODE, [SERVER], {
      env: { ...process.env, LUNCHMONEY_API_KEY: 'short', LM_API_BASE_URL: RELAY_BASE, LM_TX_BATCH_LIMIT: '5' },
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    let b = ''; let done = false;
    const settle = (v) => { if (!done) { done = true; try { bad.kill(); } catch {} resolveAuth(v); } };
    bad.stdout.on('data', (d) => {
      b += d.toString(); let i;
      while ((i = b.indexOf('\n')) >= 0) {
        const line = b.slice(0, i).trim(); b = b.slice(i + 1);
        if (!line) continue;
        let o; try { o = JSON.parse(line); } catch { continue; }
        if (o.id === 2) settle(o.result && o.result.content && o.result.content[0] && o.result.content[0].text);
      }
    });
    bad.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'auth', version: '1' } } }) + '\n');
    bad.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    bad.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'get_current_user', arguments: {} } }) + '\n');
    setTimeout(() => settle(null), 60000);
  });
  ok(authText && authText !== '{}', 'live 401 carries a real message, not "{}"', JSON.stringify(authText));
  // The live mock surfaces the real Lunch Money phrasing for a bad/short token.
  // The point is the upstream error text is passed through, not swallowed to "{}".
  ok(authText && /access token does not exist|unauthorized/i.test(authText),
     'live 401 passes through the real auth-failure message', JSON.stringify(authText));

  // ---- Guard: no tool may silently fall back to raw JSON in markdown mode ----
  // Mirrors the unit-suite guard: any "No markdown renderer matched" warning means
  // a user in markdown mode got raw JSON, which is a real renderer/shape gap.
  const fellBack = [...stderr.matchAll(/No markdown renderer matched tool "([^"]+)"/g)].map(m => m[1]);
  ok(fellBack.length === 0, `no unexpected markdown->JSON fallback (offenders: ${[...new Set(fellBack)].join(', ') || 'none'})`, stderr.trim());

  console.log(results.join('\n'));
  console.log(`\n${pass} passed, ${fail} failed  (LIVE mock via ${RELAY_BASE})`);
  if (stderr.trim()) console.log('\n--- server stderr ---\n' + stderr.trim());
  await finish(fail ? 1 : 0);
})().catch(async (e) => { console.error('HARNESS ERROR:', e); console.error(stderr); await finish(2); });
