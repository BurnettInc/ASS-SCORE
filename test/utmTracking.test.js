// ---------------------------------------------------------------------------
// UTM attribution (owner GO 2026-10-15): the site beacon parses
// ?utm_source/utm_medium/utm_campaign out of the landing URL and POSTs them
// to /api/v1/track, so campaign attribution survives in-app browsers that
// strip the Referer header. The tracked route sanitizes them exactly like
// ref (string, trimmed, capped at 100) and stores them on the page_views
// row; the admin /admin/stats JSON gains an additive `utm` block (window =
// the same viewFloorTs floor as sources) and the dashboard renders a UTM
// attribution card only when tagged views exist.
//
// Conventions mirrored from adminSourcesBots.test.js / adminStats.test.js:
// tmp DB per test, injectable clocks, real HTTP against a local listen(0).
// ADMIN_PASSWORD is deleted at module top so the "unset => 403" behavior is
// deterministic regardless of the runner's env.
// ---------------------------------------------------------------------------
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { openDb } from '../src/db.js';
import { createApp } from '../src/app.js';

delete process.env.ADMIN_PASSWORD;

const tmpDb = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ass-utm-')), 'test.db');
const PASSWORD = 'hunter2-secret-key';
const TICK = '2026-09-23T12:00:00.000Z'; // an injected "now" (UTC, app convention)
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/126.0 Safari/537.36';
const ro = (dbPath) => new Database(dbPath, { readonly: true });
const viewRows = (dbPath) =>
  ro(dbPath)
    .prepare('SELECT ts, ip, ua, path, ref, utm_source, utm_medium, utm_campaign FROM page_views ORDER BY id')
    .all();
function startApp(opts = {}) {
  const app = createApp({ adminPassword: PASSWORD, ...opts });
  const server = app.listen(0);
  const port = server.address().port;
  return { server, base: `http://127.0.0.1:${port}` };
}
const track = (base, body, headers = {}) =>
  fetch(`${base}/api/v1/track`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
// ---------------------------------------------------------------------------
// Schema migration — old page_views shapes gain the 3 utm columns
// ---------------------------------------------------------------------------
/** DB with the pre-ref page_views shape (no ref, no utm columns) + one row. */
function preRefSchemaDb() {
  const dbp = tmpDb();
  const raw = new Database(dbp);
  raw.exec(`
    CREATE TABLE page_views (
      id   INTEGER PRIMARY KEY AUTOINCREMENT,
      ts   INTEGER NOT NULL,
      ip   TEXT NOT NULL,
      ua   TEXT NOT NULL DEFAULT '',
      path TEXT NOT NULL
    );
  `);
  raw.prepare('INSERT INTO page_views (ts, ip, ua, path) VALUES (?, ?, ?, ?)').run(Date.parse(TICK), '203.0.113.9', UA, '/pre');
  raw.close();
  return dbp;
}
/** DB that already went through the ref migration (ref exists, utm absent). */
function refOnlySchemaDb() {
  const dbp = tmpDb();
  const raw = new Database(dbp);
  raw.exec(`
    CREATE TABLE page_views (
      id   INTEGER PRIMARY KEY AUTOINCREMENT,
      ts   INTEGER NOT NULL,
      ip   TEXT NOT NULL,
      ua   TEXT NOT NULL DEFAULT '',
      path TEXT NOT NULL,
      ref  TEXT NOT NULL DEFAULT ''
    );
  `);
  raw
    .prepare('INSERT INTO page_views (ts, ip, ua, path, ref) VALUES (?, ?, ?, ?, ?)')
    .run(Date.parse(TICK), '203.0.113.9', UA, '/pre', 'https://www.example.com/');
  raw.close();
  return dbp;
}
test('db: migrated DBs gain utm_source/utm_medium/utm_campaign with \'\' defaults; fresh DB has them from the start', () => {
  // -- Pre-ref production DB: migration adds ref + all three utm columns --
  const migrated = preRefSchemaDb();
  const db = openDb(migrated);
  try {
    const cols = db.raw.prepare('PRAGMA table_info(page_views)').all().map((c) => c.name);
    for (const col of ['ref', 'utm_source', 'utm_medium', 'utm_campaign']) {
      assert.ok(cols.includes(col), `${col} column added by migration`);
    }
    // Old row backfills to '' — exactly what "untagged" needs.
    const old = db.raw.prepare('SELECT ref, utm_source, utm_medium, utm_campaign FROM page_views WHERE path = ?').get('/pre');
    assert.deepEqual(old, { ref: '', utm_source: '', utm_medium: '', utm_campaign: '' });
    // New inserts write utm fields normally.
    db.insertPageView({
      ts: Date.parse(TICK),
      ip: '203.0.113.1',
      ua: UA,
      path: '/post',
      ref: 'https://www.example.com/',
      utmSource: 'ph',
      utmMedium: 'social',
      utmCampaign: 'ph-launch',
    });
    const rows = db.raw.prepare('SELECT path, ref, utm_source, utm_medium, utm_campaign FROM page_views ORDER BY id').all();
    assert.deepEqual(rows, [
      { path: '/pre', ref: '', utm_source: '', utm_medium: '', utm_campaign: '' },
      { path: '/post', ref: 'https://www.example.com/', utm_source: 'ph', utm_medium: 'social', utm_campaign: 'ph-launch' },
    ]);
    // Idempotent: re-opening the same already-migrated DB is a no-op.
    db.close();
    const db2 = openDb(migrated);
    try {
      assert.equal(db2.countPageViews(), 2);
      assert.equal(db2.pageViewUtmCounts(Date.parse('2026-01-01T00:00:00.000Z')).length, 1);
    } finally {
      db2.close();
    }
  } finally {
    db.close();
  }
  // -- Post-ref DB (production that already ran the ref migration): only the
  //    utm ALTERs run; existing ref data is preserved untouched.
  const migrated2 = refOnlySchemaDb();
  const db3 = openDb(migrated2);
  try {
    const cols = db3.raw.prepare('PRAGMA table_info(page_views)').all().map((c) => c.name);
    for (const col of ['ref', 'utm_source', 'utm_medium', 'utm_campaign']) {
      assert.ok(cols.includes(col), `${col} column present after second migration`);
    }
    const old = db3.raw.prepare('SELECT ref, utm_source, utm_medium, utm_campaign FROM page_views WHERE path = ?').get('/pre');
    assert.deepEqual(old, { ref: 'https://www.example.com/', utm_source: '', utm_medium: '', utm_campaign: '' }, 'ref preserved, utm backfilled to \'\'');
  } finally {
    db3.close();
  }
  // -- Fresh DB -- the columns are in CREATE TABLE itself (never ALTERed).
  const fresh = tmpDb();
  const fdb = openDb(fresh);
  try {
    const cols = fdb.raw.prepare('PRAGMA table_info(page_views)').all().map((c) => c.name);
    for (const col of ['utm_source', 'utm_medium', 'utm_campaign']) {
      assert.ok(cols.includes(col), `fresh DB includes ${col} in CREATE TABLE`);
    }
    fdb.insertPageView({ ts: Date.parse(TICK), ip: '203.0.113.1', ua: UA, path: '/', utmSource: 'x', utmMedium: 'email' });
    const row = fdb.raw.prepare('SELECT utm_source, utm_medium, utm_campaign FROM page_views').get();
    assert.deepEqual(row, { utm_source: 'x', utm_medium: 'email', utm_campaign: '' });
  } finally {
    fdb.close();
  }
});
// ---------------------------------------------------------------------------
// Track route — utm capture + sanitization
// ---------------------------------------------------------------------------
test('track: utm params are captured and stored on the view; missing/empty/non-string/overlong sanitize to \'\'', async () => {
  const dbp = tmpDb();
  const app = startApp({ dbPath: dbp, now: () => TICK });
  try {
    await track(app.base, { path: '/', utm_source: 'x', utm_medium: 'social', utm_campaign: 'ph-launch' }, { 'user-agent': UA, 'x-forwarded-for': '203.0.113.1' });
    await track(app.base, { path: '/', utm_source: 'reddit', utm_medium: 'social' }, { 'user-agent': UA, 'x-forwarded-for': '203.0.113.2' });
    await track(app.base, { path: '/', utm_source: '   x   ', utm_medium: '  email  ', utm_campaign: '  ' }, { 'user-agent': UA, 'x-forwarded-for': '203.0.113.3' });
    await track(app.base, { path: '/' }, { 'user-agent': UA, 'x-forwarded-for': '203.0.113.4' });
    await track(app.base, { path: '/', utm_source: '' }, { 'user-agent': UA, 'x-forwarded-for': '203.0.113.5' });
    await track(app.base, { path: '/', utm_source: 42, utm_medium: { broken: true }, utm_campaign: ['a'] }, { 'user-agent': UA, 'x-forwarded-for': '203.0.113.6' });
    const views = viewRows(dbp);
    assert.equal(views.length, 6);
    assert.equal(views[0].utm_source, 'x', 'utm_source stored as sent');
    assert.equal(views[0].utm_medium, 'social');
    assert.equal(views[0].utm_campaign, 'ph-launch');
    assert.equal(views[1].utm_source, 'reddit');
    assert.equal(views[1].utm_medium, 'social');
    assert.equal(views[1].utm_campaign, '', 'absent utm_campaign stored as \'\'');
    assert.equal(views[2].utm_source, 'x', 'utm_source trimmed');
    assert.equal(views[2].utm_medium, 'email', 'utm_medium trimmed');
    assert.equal(views[2].utm_campaign, '', 'whitespace-only utm_campaign sanitized to \'\'');
    assert.equal(views[3].utm_source, '', 'missing utm params stored as \'\'');
    assert.equal(views[4].utm_source, '', 'empty-string utm_source stored as \'\'');
    assert.equal(views[5].utm_source, '', 'non-string utm_source sanitized to \'\'');
    assert.equal(views[5].utm_medium, '', 'object utm_medium sanitized to \'\'');
    assert.equal(views[5].utm_campaign, '', 'array utm_campaign sanitized to \'\'');
    // ref / bot filtering untouched: every accepted hit wrote a normal view
    // with the stored ref honouring the same '' default.
    assert.ok(views.every((v) => typeof v.ref === 'string' && v.ref === ''), 'untagged refs stay \'\'');
  } finally {
    app.server.close();
  }
});
test('track: utm sanitization caps values at 100 chars (server-side, like ref)', async () => {
  const dbp = tmpDb();
  const app = startApp({ dbPath: dbp, now: () => TICK });
  try {
    await track(
      app.base,
      { path: '/', utm_source: `  ${'s'.repeat(500)}  `, utm_medium: 'm'.repeat(150), utm_campaign: 'c' },
      { 'user-agent': UA, 'x-forwarded-for': '203.0.113.1' },
    );
    const views = viewRows(dbp);
    assert.equal(views.length, 1);
    assert.equal(views[0].utm_source.length, 100, 'utm_source trimmed + capped at 100');
    assert.ok(views[0].utm_source.startsWith('s'), 'cap keeps the value head');
    assert.ok(!views[0].utm_source.endsWith(' '), 'leading/trailing whitespace trimmed');
    assert.equal(views[0].utm_medium.length, 100, 'utm_medium capped at 100');
    assert.equal(views[0].utm_campaign, 'c', 'short values pass through unchanged');
  } finally {
    app.server.close();
  }
});
test('track: a bot/automation drop with utm params records bot_hits and NEVER a view (utm never touches the bot ledger)', async () => {
  const dbp = tmpDb();
  const app = startApp({ dbPath: dbp, now: () => TICK });
  try {
    const r1 = await track(app.base, { path: '/', utm_source: 'x', utm_medium: 'social', webdriver: true }, { 'user-agent': UA });
    assert.equal(r1.status, 204);
    assert.equal(ro(dbp).prepare('SELECT COUNT(*) AS n FROM bot_hits').get().n, 1, 'bot hit recorded with reason');
    assert.equal(ro(dbp).prepare('SELECT COUNT(*) AS n FROM page_views').get().n, 0, 'no view row for a dropped hit');
    const bot = ro(dbp).prepare('SELECT reason FROM bot_hits').get();
    assert.equal(bot.reason, 'webdriver');
    // A real human view with the same utm values DOES land in page_views.
    await track(app.base, { path: '/', utm_source: 'x', utm_medium: 'social' }, { 'user-agent': UA });
    const views = viewRows(dbp);
    assert.equal(views.length, 1);
    assert.equal(views[0].utm_source, 'x');
  } finally {
    app.server.close();
  }
});
// ---------------------------------------------------------------------------
// Admin JSON — utm block (additive)
// ---------------------------------------------------------------------------
test('admin: utm JSON block aggregates tagged views over the window (sorted count desc then source asc); views/sources untouched', async () => {
  const dbp = tmpDb();
  const app = startApp({ dbPath: dbp, now: () => TICK });
  try {
    const seed = openDb(dbp);
    const t = Date.parse(TICK);
    seed.insertPageView({ ts: t, ip: '203.0.113.1', ua: UA, path: '/', utmSource: 'x', utmMedium: 'social', utmCampaign: 'ph-launch' });
    seed.insertPageView({ ts: t, ip: '203.0.113.2', ua: UA, path: '/', utmSource: 'x', utmMedium: 'social', utmCampaign: 'ph-launch' });
    seed.insertPageView({ ts: t, ip: '203.0.113.3', ua: UA, path: '/', utmSource: 'reddit', utmMedium: 'social' });
    seed.insertPageView({ ts: t, ip: '203.0.113.4', ua: UA, path: '/', ref: 'https://www.google.com/' });
    seed.close();
    const json = await (await fetch(`${app.base}/admin/stats`, { headers: { 'x-admin-password': PASSWORD } })).json();
    // Additive utm block: total = tagged views only (the google referrer row
    // is untagged and counts to sources, never to utm).
    assert.equal(json.utm.total, 3, 'utm.total = sum of tagged rows only');
    assert.deepEqual(json.utm.by_source, [
      { source: 'x', medium: 'social', campaign: 'ph-launch', count: 2 },
      { source: 'reddit', medium: 'social', campaign: '', count: 1 },
    ], 'grouped by (source, medium, campaign), count desc then source asc');
    // Existing views/sources blocks are byte-identical in spirit: every row
    // still counted the same way (sources is ref-based; utm is additive).
    assert.equal(json.views.total, 4, 'views block unchanged');
    assert.equal(json.sources.total, 4, 'sources total unchanged');
    assert.deepEqual(json.sources.top, [{ source: 'direct', count: 3 }, { source: 'google.com', count: 1 }], 'sources.top unchanged');
  } finally {
    app.server.close();
  }
});
test('admin: utm respects the stats_epoch floor exactly like sources (pre-epoch tagged rows never counted)', async () => {
  const dbp = tmpDb();
  const app = startApp({ dbPath: dbp, now: () => TICK });
  try {
    const seed = openDb(dbp);
    const pre = Date.parse('2026-09-01T00:00:00.000Z');
    seed.insertPageView({ ts: pre, ip: '203.0.113.1', ua: UA, path: '/pre', utmSource: 'oldcampaign', utmMedium: 'email' });
    seed.setSetting('stats_epoch', '2026-09-10T00:00:00.000Z'); // floor AFTER the seeded row
    seed.close();
    const json = await (await fetch(`${app.base}/admin/stats`, { headers: { 'x-admin-password': PASSWORD } })).json();
    assert.equal(json.utm.total, 0, 'pre-epoch tagged row never counted');
    assert.deepEqual(json.utm.by_source, []);
    // Rows AFTER the epoch count.
    const post = openDb(dbp);
    const t = Date.parse('2026-09-23T11:00:00.000Z');
    post.insertPageView({ ts: t, ip: '203.0.113.2', ua: UA, path: '/post', utmSource: 'newcampaign', utmMedium: 'social' });
    post.close();
    const json2 = await (await fetch(`${app.base}/admin/stats`, { headers: { 'x-admin-password': PASSWORD } })).json();
    assert.equal(json2.utm.total, 1);
    assert.deepEqual(json2.utm.by_source, [{ source: 'newcampaign', medium: 'social', campaign: '', count: 1 }]);
  } finally {
    app.server.close();
  }
});
// ---------------------------------------------------------------------------
// Admin HTML dashboard — UTM attribution card
// ---------------------------------------------------------------------------
test('admin: HTML dashboard renders the UTM attribution card (source prominent, medium · campaign secondary, count, all escaped)', async () => {
  const dbp = tmpDb();
  const app = startApp({ dbPath: dbp, now: () => TICK });
  try {
    const seed = openDb(dbp);
    const t = Date.parse(TICK);
    seed.insertPageView({ ts: t, ip: '203.0.113.1', ua: UA, path: '/', utmSource: 'x', utmMedium: 'social', utmCampaign: 'ph-launch' });
    seed.insertPageView({ ts: t, ip: '203.0.113.2', ua: UA, path: '/', utmSource: 'x', utmMedium: 'social', utmCampaign: 'ph-launch' });
    // Hostile source value: every dynamic value must be escaped.
    seed.insertPageView({ ts: t, ip: '203.0.113.3', ua: UA, path: '/', utmSource: '<script>alert(1)</script>', utmMedium: 'social' });
    seed.close();
    const r = await fetch(`${app.base}/admin/stats`, { headers: { accept: 'text/html', 'x-admin-password': PASSWORD } });
    assert.equal(r.status, 200);
    const html = await r.text();
    assert.ok(html.includes('UTM attribution'), 'UTM attribution card title rendered when utm.total > 0');
    assert.ok(html.includes('utm-detail'), 'medium · campaign secondary line markup present');
    assert.ok(html.includes('>social · ph-launch</div>'), 'detail line renders medium · campaign');
    assert.ok(html.includes('title="x">x</span><span class="src-count">2'), 'source prominent + count right-aligned');
    assert.ok(html.includes('tagged views in the window'), 'scale line explains the % base');
    assert.ok(html.includes('.utm-detail{'), 'detail-line CSS present');
    assert.ok(!html.includes('<script>alert(1)</script>'), 'never a raw hostile source string');
    assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'), 'hostile source escaped');
    assert.ok(html.includes('src-fill'), 'share bars rendered');
  } finally {
    app.server.close();
  }
});
test('admin: HTML dashboard renders NO UTM card when there are no tagged views (no empty shell)', async () => {
  const dbp = tmpDb();
  const app = startApp({ dbPath: dbp, now: () => TICK });
  try {
    const seed = openDb(dbp);
    const t = Date.parse(TICK);
    seed.insertPageView({ ts: t, ip: '203.0.113.1', ua: UA, path: '/', ref: 'https://t.co/xyz' });
    seed.close();
    const r = await fetch(`${app.base}/admin/stats`, { headers: { accept: 'text/html', 'x-admin-password': PASSWORD } });
    assert.equal(r.status, 200);
    const html = await r.text();
    assert.ok(!html.includes('UTM attribution'), 'no card title when utm.total === 0');
    assert.ok(!html.includes('class="utm-detail"'), 'no detail-line markup when there are no tagged views');
    assert.ok(html.includes('Top referrers'), 'the referrers card still renders independently');
  } finally {
    app.server.close();
  }
});