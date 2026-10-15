import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { openDb } from '../src/db.js';
import { createApp } from '../src/app.js';
import { runRetention } from '../src/retention.js';
// ---------------------------------------------------------------------------
// Share-card download / share-text tracking (owner-approved backlog
// "Share-card download tracking"): the "shares per scan" KPI.
//   - GET /api/v1/scans/:id/card?dl=1 records a 'download' event in the
//     card_events ledger; PLAIN /card GETs (result-page preview <img>,
//     examples-page SSR embeds) must NEVER count.
//   - GET /api/v1/scans/:id/share records a 'share' event on every successful
//     fetch (the site fetches it only when the visitor copies the text).
//   - /admin/stats JSON gains a cards block (total/today/last30d/recent +
//     the downloads/shares split) with the exact floors the views counters
//     use; the HTML dashboard gains the SHARE CARDS KPI + recent-events table.
//   - POST /admin/stats/reset (epoch cutover) zeroes the card counters.
//   - The 30-day retention purge sweeps card_events like the beacon ledgers.
// Conventions mirrored from adminStats.test.js / adminRecentScans.test.js:
// tmp DB per test, injectable clocks, real HTTP against a local listen(0),
// ADMIN_PASSWORD deleted at module top. Card PNGs render through the real
// sharp pipeline (card.test.js precedent) — same scan -> identical bytes.
// ---------------------------------------------------------------------------
delete process.env.ADMIN_PASSWORD;
const tmpDb = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ass-card-events-')), 'test.db');
const PASSWORD = 'hunter2-secret-key';
const TICK = '2026-09-23T12:00:00.000Z'; // an injected "now" (UTC, app convention)
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/126.0 Safari/537.36';
const seedScan = (db, { id, url, score = 42, createdAt = TICK }) =>
  db.insertScan({ id, url, score, breakdown: {}, createdAt });
const cardRows = (dbPath) =>
  new Database(dbPath, { readonly: true })
    .prepare('SELECT ts, ip, ua, scan_id, action FROM card_events ORDER BY id')
    .all();
function startApp(opts = {}) {
  const app = createApp({ adminPassword: PASSWORD, ...opts });
  const server = app.listen(0); // no-host form: address() is available synchronously
  const port = server.address().port;
  return { server, base: `http://127.0.0.1:${port}` };
}
/** GET /admin/stats JSON with header auth. */
const adminStats = (base) =>
  fetch(`${base}/admin/stats`, { headers: { 'x-admin-password': PASSWORD } }).then((r) => r.json());
// ---------------------------------------------------------------------------
// Route-level counting: dl-flagged downloads vs plain previews
// ---------------------------------------------------------------------------
test('card: dl=1 GET records a download; plain and wrong-flag GETs never count; bytes identical', async () => {
  const dbp = tmpDb();
  const app = startApp({ dbPath: dbp, now: () => TICK });
  try {
    const seed = openDb(dbp);
    seedScan(seed, { id: 's1', url: 'https://acme.example/' });
    seed.close();
    // Plain GET — the preview <img> / examples-embed shape. Must NOT count.
    const plain = await fetch(`${app.base}/api/v1/scans/s1/card`);
    assert.equal(plain.status, 200);
    assert.equal(plain.headers.get('cache-control'), 'public, max-age=60', 'unchanged cache headers');
    const plainBuf = Buffer.from(await plain.arrayBuffer());
    // dl-flagged GET — the site's Download button. Must count.
    const dl = await fetch(`${app.base}/api/v1/scans/s1/card?dl=1`, { headers: { 'user-agent': UA } });
    assert.equal(dl.status, 200);
    const dlBuf = Buffer.from(await dl.arrayBuffer());
    assert.ok(dlBuf.equals(plainBuf), 'dl=1 never changes the PNG bytes (marker stripped before serving)');
    // A non-`1` flag value is a preview by definition — must NOT count.
    const wrong = await fetch(`${app.base}/api/v1/scans/s1/card?dl=yes`);
    assert.equal(wrong.status, 200);
    const rows = cardRows(dbp);
    assert.equal(rows.length, 1, 'exactly one event: the dl=1 fetch');
    assert.equal(rows[0].action, 'download');
    assert.equal(rows[0].scan_id, 's1');
    assert.equal(rows[0].ts, Date.parse(TICK), 'ts is epoch ms from the injectable clock');
    assert.match(rows[0].ip, /127\.0\.0\.1$/, 'req.ip via the shared clientIp derivation');
    assert.equal(rows[0].ua, UA, 'user-agent stored');
  } finally {
    app.server.close();
  }
});
test('card: missing scan is 404 — no download row even with dl=1 (only successful fetches count)', async () => {
  const dbp = tmpDb();
  const app = startApp({ dbPath: dbp, now: () => TICK });
  try {
    const r = await fetch(`${app.base}/api/v1/scans/no-such-scan/card?dl=1`);
    assert.equal(r.status, 404);
    assert.deepEqual(cardRows(dbp), [], 'no ledger row for a 404');
  } finally {
    app.server.close();
  }
});
// ---------------------------------------------------------------------------
// Route-level counting: prefilled share text
// ---------------------------------------------------------------------------
test('share: every successful fetch records a share event; 404 records nothing', async () => {
  const dbp = tmpDb();
  const app = startApp({ dbPath: dbp, now: () => TICK });
  try {
    const seed = openDb(dbp);
    seedScan(seed, { id: 's1', url: 'https://acme.example/', score: 42 });
    seed.close();
    const r = await fetch(`${app.base}/api/v1/scans/s1/share`, { headers: { 'user-agent': UA, accept: 'application/json' } });
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(body.text, 'My website got an A.S.S. Score of 42/100 (low is good). Check yours at ass-score.com');
    assert.equal(body.url, 'https://www.ass-score.com/scan/s1', 'shareBase = createApp default publicBaseUrl');
    // A second fetch (the site re-fetches on each copy click) is a second event.
    assert.equal((await fetch(`${app.base}/api/v1/scans/s1/share`)).status, 200);
    // Missing scan: 404, and no event (nothing was served).
    assert.equal((await fetch(`${app.base}/api/v1/scans/no-such-scan/share`)).status, 404);
    const rows = cardRows(dbp);
    assert.equal(rows.length, 2, 'two successful share fetches, both recorded');
    assert.equal(rows[0].action, 'share');
    assert.equal(rows[0].scan_id, 's1');
    assert.equal(rows[0].ts, Date.parse(TICK));
    assert.equal(rows[1].action, 'share');
  } finally {
    app.server.close();
  }
});
// ---------------------------------------------------------------------------
// Admin stats: cards block + floors + dashboard rendering
// ---------------------------------------------------------------------------
test('admin: /admin/stats JSON cards block — total/today/30-day series/recent (with URLs)/actions split', async () => {
  const dbp = tmpDb();
  const app = startApp({ dbPath: dbp, now: () => TICK });
  try {
    const seed = openDb(dbp);
    seedScan(seed, { id: 's1', url: 'https://acme.example/' });
    seedScan(seed, { id: 's2', url: 'https://beta.example/' });
    // Controlled event times: today, inside the 30-day window, outside it.
    seed.insertCardEvent({ ts: Date.parse(TICK), ip: '203.0.113.1', ua: 'U1', scanId: 's1', action: 'download' });
    seed.insertCardEvent({ ts: Date.parse('2026-09-10T00:00:00.000Z'), ip: '203.0.113.2', ua: 'U2', scanId: 's2', action: 'share' });
    seed.insertCardEvent({ ts: Date.parse('2026-08-01T00:00:00.000Z'), ip: '203.0.113.3', ua: 'U3', scanId: 's1', action: 'share' });
    seed.close();
    const json = await adminStats(app.base);
    assert.equal(json.cards.total, 3, 'total counts every row (no epoch floor yet)');
    assert.equal(json.cards.today, 1, 'today = epoch-ms day bucket of the injectable clock');
    assert.equal(json.cards.last30d.length, 30, 'exactly 30 daily buckets');
    assert.equal(json.cards.last30d[0].date, '2026-08-25', 'window starts 29 days before today');
    assert.equal(json.cards.last30d[29].date, '2026-09-23', 'window ends today');
    assert.equal(json.cards.last30d[29].count, 1, 'today bucket has the download');
    assert.equal(json.cards.last30d[16].count, 1, '2026-09-10 bucket has the share');
    assert.equal(json.cards.last30d[0].count, 0, 'pre-window row excluded from the series');
    assert.deepEqual(json.cards.actions, { downloads: 1, shares: 2 }, 'the dashboard KPI split');
    assert.equal(json.cards.recent.length, 3, 'newest-first, no epoch floor -> all rows');
    assert.deepEqual(json.cards.recent[0], {
      ts: Date.parse(TICK),
      scan_id: 's1',
      url: 'https://acme.example/',
      action: 'download',
    }, 'recent rows carry the scanned URL (LEFT JOIN) + action, newest first');
    assert.equal(json.cards.recent[1].action, 'share');
    assert.equal(json.cards.recent[1].scan_id, 's2');
    assert.equal(json.cards.recent[2].action, 'share');
  } finally {
    app.server.close();
  }
});
test('admin: HTML dashboard — SHARE CARDS KPI + recent-events table; empty traffic keeps no cards table', async () => {
  // With events: dashboard renders the tile + the table.
  const dbp = tmpDb();
  const app = startApp({ dbPath: dbp, now: () => TICK });
  try {
    const seed = openDb(dbp);
    seedScan(seed, { id: 's1', url: 'https://acme.example/' });
    seed.insertCardEvent({ ts: Date.parse(TICK), ip: '203.0.113.1', ua: 'U1', scanId: 's1', action: 'download' });
    seed.insertCardEvent({ ts: Date.parse(TICK), ip: '203.0.113.1', ua: 'U1', scanId: 's1', action: 'share' });
    seed.close();
    const r = await fetch(`${app.base}/admin/stats`, { headers: { accept: 'text/html', 'x-admin-password': PASSWORD } });
    assert.equal(r.status, 200);
    const html = await r.text();
    assert.ok(html.includes('SHARE CARDS'), 'KPI tile label');
    assert.ok(html.includes('1 downloads · 1 shares'), 'KPI tile sub-line carries the split');
    assert.ok(html.includes('<h2>Share cards'), 'recent-events card header');
    assert.ok(html.includes('col-action-dl'), 'download row rendered with its action color');
    assert.ok(html.includes('col-action-share'), 'share row rendered with its action color');
    assert.ok(html.includes('https://acme.example/'), 'recent event shows the scanned URL');
  } finally {
    app.server.close();
  }
  // Without events: the card section renders its empty state — and NO new
  // <table>, so a traffic-less dashboard stays table-free (existing contract).
  const dbp2 = tmpDb();
  const app2 = startApp({ dbPath: dbp2, now: () => TICK });
  try {
    const r = await fetch(`${app2.base}/admin/stats`, { headers: { accept: 'text/html', 'x-admin-password': PASSWORD } });
    const html = await r.text();
    assert.ok(html.includes('No share-card activity yet'), 'empty state text');
    assert.ok(!html.includes('<th>URL</th><th>Action</th>'), 'no cards table when there are no events');
  } finally {
    app2.server.close();
  }
});
// ---------------------------------------------------------------------------
// Epoch cutover: reset zeroes the card counters (rows stay, floor moves)
// ---------------------------------------------------------------------------
test('admin: stats reset zeroes the card counters; pre-epoch rows stay but stop counting', async () => {
  const dbp = tmpDb();
  let clock = '2026-09-22T00:00:00.000Z';
  const app = startApp({ dbPath: dbp, now: () => clock });
  try {
    const seed = openDb(dbp);
    seedScan(seed, { id: 's1', url: 'https://acme.example/', createdAt: clock });
    seed.close();
    // Real route-level activity BEFORE the cutover (one dl download + one share).
    assert.equal((await fetch(`${app.base}/api/v1/scans/s1/card?dl=1`)).status, 200);
    assert.equal((await fetch(`${app.base}/api/v1/scans/s1/share`)).status, 200);
    let json = await adminStats(app.base);
    assert.equal(json.cards.total, 2, 'counts before the reset');
    assert.equal(json.cards.actions.downloads, 1);
    assert.equal(json.cards.actions.shares, 1);
    // Cutover: epoch = now().
    clock = TICK;
    const reset = await fetch(`${app.base}/admin/stats/reset`, { method: 'POST', headers: { 'x-admin-password': PASSWORD } });
    assert.equal(reset.status, 200);
    assert.deepEqual(await reset.json(), { ok: true, epoch: TICK });
    json = await adminStats(app.base);
    assert.equal(json.cards.total, 0, 'reset zeroes every card counter');
    assert.equal(json.cards.today, 0);
    assert.deepEqual(json.cards.recent, [], 'no rows at/after the new epoch');
    assert.deepEqual(json.cards.actions, { downloads: 0, shares: 0 });
    // Post-epoch activity counts again.
    clock = '2026-09-24T00:00:00.000Z';
    assert.equal((await fetch(`${app.base}/api/v1/scans/s1/card?dl=1`)).status, 200);
    json = await adminStats(app.base);
    assert.equal(json.cards.total, 1, 'only the post-epoch download counts');
    assert.equal(json.cards.today, 1);
    assert.deepEqual(json.cards.actions, { downloads: 1, shares: 0 });
    // Evidence is never deleted: all three rows still exist in the ledger.
    assert.equal(cardRows(dbp).length, 3, 'pre-epoch rows remain in the database');
  } finally {
    app.server.close();
  }
});
// ---------------------------------------------------------------------------
// Retention: card_events joins the 30-day sweep
// ---------------------------------------------------------------------------
test('retention: card_events purged on the same 30-day cutoff as the beacon ledgers', () => {
  const db = openDb(tmpDb());
  const NOW = '2026-09-23T12:00:00.000Z';
  try {
    const OLD_TS = Date.parse('2026-07-01T00:00:00.000Z'); // 84 days before NOW -> purged
    const FRESH_TS = Date.parse('2026-09-10T00:00:00.000Z'); // 13 days before NOW -> survives
    db.insertCardEvent({ ts: OLD_TS, ip: '203.0.113.1', ua: '', scanId: 's-old', action: 'download' });
    db.insertCardEvent({ ts: FRESH_TS, ip: '203.0.113.2', ua: '', scanId: 's-fresh', action: 'share' });
    const res = runRetention({ db, now: () => NOW });
    assert.equal(res.deleted.cards, 1, 'the over-30-day event is purged');
    const remaining = db.raw.prepare('SELECT ts, scan_id, action FROM card_events').all();
    assert.equal(remaining.length, 1);
    assert.equal(remaining[0].action, 'share');
    assert.equal(remaining[0].ts, FRESH_TS, 'the in-window event survives');
    // Idempotent: a second run deletes nothing new.
    assert.equal(runRetention({ db, now: () => NOW }).deleted.cards, 0);
  } finally {
    db.close();
  }
});