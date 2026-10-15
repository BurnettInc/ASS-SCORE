import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../src/db.js';
import { createApp } from '../src/app.js';
import { verdictLabel } from '../src/verdict.js';

// ---------------------------------------------------------------------------
// Recent scans on the admin stats page (owner request 2026-10-16): the
// dashboard's scans counters showed daily totals only, so this adds the last
// 20 PUBLIC scans ({id, url, score, created_at}) to the /admin/stats JSON and
// a "Recent scans" table to the HTML dashboard. Internal admin-tool rows stay
// excluded (COALESCE(internal,0) = 0 — the same filter the scan counters
// use), the stats-epoch floor filters exactly like every other admin counter,
// and NO report links are rendered (public report links are token-protected;
// /admin/report/:scanId serves internal rows only).
// Conventions mirrored from adminStats.test.js / adminStatsCutover.test.js:
// tmp DB per test, injectable clocks, real HTTP against a local listen(0),
// ADMIN_PASSWORD deleted at module top.
// ---------------------------------------------------------------------------
delete process.env.ADMIN_PASSWORD;

const tmpDb = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ass-recent-scans-')), 'test.db');
const PASSWORD = 'hunter2-secret-key';
const TICK = '2026-09-23T12:00:00.000Z'; // an injected "now" (UTC, app convention)

const seedScan = (db, { id, url, score, createdAt, internal = false }) =>
  db.insertScan({ id, url, score, breakdown: {}, createdAt, internal });

function startApp(opts = {}) {
  const app = createApp({ adminPassword: PASSWORD, ...opts });
  const server = app.listen(0); // no-host form: address() is available synchronously
  const port = server.address().port;
  return { server, base: `http://127.0.0.1:${port}` };
}

// ---------------------------------------------------------------------------
// db-level recentScans()
// ---------------------------------------------------------------------------
test('recentScans: newest-first, LIMIT 20, excludes internal rows, respects a sinceIso floor', () => {
  const db = openDb(tmpDb());
  try {
    // 24 public rows — more than the LIMIT, so the truncation is exercised.
    for (let i = 1; i <= 24; i++) {
      seedScan(db, {
        id: `scan-${i}`,
        url: `https://site-${i}.example/`,
        score: i,
        createdAt: `2026-09-${String(i).padStart(2, '0')}T10:00:00.000Z`,
      });
    }
    // Internal rows must never appear even when they are the newest.
    seedScan(db, { id: 'internal-new', url: 'https://admin-tool.example/', score: 99, createdAt: '2026-10-01T00:00:00.000Z', internal: true });
    seedScan(db, { id: 'internal-old', url: 'https://admin-tool-2.example/', score: 99, createdAt: '2026-08-01T00:00:00.000Z', internal: true });

    const all = db.recentScans();
    assert.equal(all.length, 20, 'LIMIT 20');
    assert.equal(all[0].id, 'scan-24', 'newest first');
    assert.equal(all[19].id, 'scan-5', 'the 20 newest public rows, oldest within the limit last');
    assert.ok(all.every((r) => r.id !== 'internal-new' && r.id !== 'internal-old'), 'internal rows never in the list');
    for (const r of all) {
      assert.deepEqual(Object.keys(r).sort(), ['created_at', 'id', 'score', 'url'], 'exact field set');
      assert.equal(typeof r.score, 'number');
      assert.equal(typeof r.url, 'string');
      assert.equal(typeof r.created_at, 'string');
    }

    const floored = db.recentScans('2026-09-20T00:00:00.000Z');
    assert.equal(floored.length, 5, 'only rows created at/after the floor');
    assert.equal(floored[0].id, 'scan-24', 'still newest-first under the floor');
    assert.equal(floored.at(-1).id, 'scan-20');

    const future = db.recentScans('2030-01-01T00:00:00.000Z');
    assert.deepEqual(future, [], 'floor with no rows behind it is empty');
    assert.deepEqual(db.recentScans(null), all, 'explicit null === no floor');
  } finally {
    db.close();
  }
});

// ---------------------------------------------------------------------------
// JSON: scans.recent is additive
// ---------------------------------------------------------------------------
test('admin: stats JSON scans.recent has the expected fields, newest-first, internal rows excluded', async () => {
  const dbp = tmpDb();
  const app = startApp({ dbPath: dbp, now: () => TICK });
  try {
    const db = openDb(dbp);
    seedScan(db, { id: 'scan-old', url: 'https://old.example/', score: 12, createdAt: '2026-09-22T09:00:00.000Z' });
    seedScan(db, { id: 'scan-new', url: 'https://new.example/', score: 93, createdAt: '2026-09-23T11:00:00.000Z' });
    seedScan(db, { id: 'scan-internal', url: 'https://admin-tool.example/', score: 0, createdAt: '2026-09-23T11:30:00.000Z', internal: true });
    db.close();
    const r = await fetch(`${app.base}/admin/stats`, { headers: { 'x-admin-password': PASSWORD } });
    assert.equal(r.status, 200);
    const json = await r.json();
    assert.deepEqual(Object.keys(json.scans).sort(), ['last30d', 'recent', 'today', 'total'], 'scans gains only the recent key');
    assert.equal(json.scans.total, 2, 'internal row excluded from the counts too');
    assert.equal(json.scans.today, 1, 'today counts only the same-day row (scan-new); recent spans days');
    assert.equal(json.scans.recent.length, 2);
    assert.deepEqual(json.scans.recent[0], {
      id: 'scan-new',
      url: 'https://new.example/',
      score: 93,
      created_at: '2026-09-23T11:00:00.000Z',
    });
    assert.deepEqual(json.scans.recent[1], {
      id: 'scan-old',
      url: 'https://old.example/',
      score: 12,
      created_at: '2026-09-22T09:00:00.000Z',
    });
  } finally {
    app.server.close();
  }
});

test('cutover: scans.recent honors the stats_epoch floor (rows stay on disk, list empties)', async () => {
  const dbp = tmpDb();
  let t = TICK;
  const app = startApp({ dbPath: dbp, now: () => t });
  try {
    const db = openDb(dbp);
    seedScan(db, { id: 'scan-pre', url: 'https://pre.example/', score: 42, createdAt: TICK });
    db.close();
    const before = await fetch(`${app.base}/admin/stats`, { headers: { 'x-admin-password': PASSWORD } });
    assert.equal((await before.json()).scans.recent.length, 1, 'pre-condition: the row is visible before the cutover');
    t = '2026-09-23T13:00:00.000Z'; // one hour after the seeded row
    const reset = await fetch(`${app.base}/admin/stats/reset`, { method: 'POST', headers: { 'x-admin-password': PASSWORD } });
    assert.equal(reset.status, 200);
    const after = await fetch(`${app.base}/admin/stats`, { headers: { 'x-admin-password': PASSWORD } });
    const json = await after.json();
    assert.equal(json.scans.total, 0, 'counts go to zero after the cutover');
    assert.deepEqual(json.scans.recent, [], 'no recent scans at/after the epoch');
    const db2 = openDb(dbp);
    assert.equal(db2.raw.prepare('SELECT COUNT(*) AS n FROM scans').get().n, 1, 'row was never deleted');
    db2.close();
  } finally {
    app.server.close();
  }
});

// ---------------------------------------------------------------------------
// HTML dashboard
// ---------------------------------------------------------------------------
test('admin: HTML dashboard renders the Recent scans table (URL, score, verdict, UTC time)', async () => {
  const dbp = tmpDb();
  const app = startApp({ dbPath: dbp, now: () => TICK });
  try {
    const db = openDb(dbp);
    seedScan(db, { id: 'scan-1', url: 'https://acme.example/', score: 42, createdAt: TICK });
    seedScan(db, { id: 'scan-2', url: `https://example.com/${'x'.repeat(120)}`, score: 7, createdAt: '2026-09-23T10:00:00.000Z' });
    db.close();
    const r = await fetch(`${app.base}/admin/stats`, { headers: { accept: 'text/html', 'x-admin-password': PASSWORD } });
    assert.equal(r.status, 200);
    const html = await r.text();
    assert.ok(html.includes('Recent scans'), 'Recent scans heading present');
    assert.ok(html.includes('Time (UTC)'), 'table header present');
    assert.ok(html.includes('https://acme.example/'), 'scanned URL rendered');
    assert.ok(html.includes('2026-09-23 12:00 UTC'), 'timestamp rendered in YYYY-MM-DD HH:MM UTC');
    assert.ok(html.includes('<td class="col-score">42</td>'), 'score rendered in its cell');
    assert.ok(html.includes(`<td class="col-verdict" style="color:#fb923c">${verdictLabel(42)}</td>`), 'verdict label from src/verdict.js with its band color');
    assert.ok(html.includes(`>${verdictLabel(7)}</td>`), 'second row verdict renders too');
    assert.ok(
      html.includes(`title="${'https://example.com/' + 'x'.repeat(120)}"`),
      'full long URL kept in the title attribute'
    );
    assert.ok(html.includes('…'), 'long URL truncated in the visible cell');
  } finally {
    app.server.close();
  }
});

test('admin: HTML dashboard shows the muted empty state when there are no scans since the epoch', async () => {
  const dbp = tmpDb();
  const app = startApp({ dbPath: dbp, now: () => TICK });
  try {
    const r = await fetch(`${app.base}/admin/stats`, { headers: { accept: 'text/html', 'x-admin-password': PASSWORD } });
    assert.equal(r.status, 200);
    const html = await r.text();
    assert.ok(html.includes('Recent scans'), 'heading still present without rows');
    assert.ok(html.includes("No scans yet — they'll appear here as visitors run them."), 'muted empty-state line shown');
    // The scans section must not emit a <table> when empty (the views empty
    // state uses the same convention); a table elsewhere on the page (e.g. a
    // views row) would still be fine — assert per section by counting.
    assert.equal((html.match(/Time \(UTC\)<\/th>/g) || []).length, 0, 'no scans table header when empty');
  } finally {
    app.server.close();
  }
});