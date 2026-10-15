import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { openDb } from '../src/db.js';
import { runRetention } from '../src/retention.js';
import { createApp } from '../src/app.js';

// ---------------------------------------------------------------------------
// Admin traffic-tracker upgrade (owner 2026-10-10): referrer capture +
// visible bot filtering.
//
// Conventions mirrored from adminStats.test.js / adminStatsCutover.test.js:
// tmp DB per test, injectable clocks, real HTTP against a local listen(0).
// ADMIN_PASSWORD is deleted at module top so the "unset => 403" behavior is
// deterministic regardless of the runner's env.
// ---------------------------------------------------------------------------
delete process.env.ADMIN_PASSWORD;

const tmpDb = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ass-srcbot-')), 'test.db');
const PASSWORD = 'hunter2-secret-key';
const TICK = '2026-09-23T12:00:00.000Z'; // an injected "now" (UTC, app convention)
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/126.0 Safari/537.36';

const ro = (dbPath) => new Database(dbPath, { readonly: true });
const countRows = (dbPath, table) => ro(dbPath).prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
const botRows = (dbPath) => ro(dbPath).prepare('SELECT ts, ip, ua, path, ref, reason FROM bot_hits ORDER BY id').all();
const viewRows = (dbPath) => ro(dbPath).prepare('SELECT ts, ip, ua, path, ref FROM page_views ORDER BY id').all();

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
// Referrer capture + sanitization
// ---------------------------------------------------------------------------
test('track: ref is captured and stored on the view; missing/non-string/overlong refs sanitize to \'\'', async () => {
  const dbp = tmpDb();
  const app = startApp({ dbPath: dbp, now: () => TICK });
  try {
    await track(app.base, { path: '/', ref: 'https://www.producthunt.com/posts/ass-score?utm=x' }, { 'user-agent': UA });
    await track(app.base, { path: '/', ref: '' }, { 'user-agent': UA, 'x-forwarded-for': '203.0.113.2' });
    await track(app.base, { path: '/', ref: 'not-a-url' }, { 'user-agent': UA, 'x-forwarded-for': '203.0.113.3' });
    await track(app.base, { path: '/', ref: 42 }, { 'user-agent': UA, 'x-forwarded-for': '203.0.113.4' });
    await track(app.base, { path: '/', ref: { broken: true } }, { 'user-agent': UA, 'x-forwarded-for': '203.0.113.5' });
    // ref is trimmed and capped at 500 chars server-side.
    await track(
      app.base,
      { path: '/', ref: `  ${'https://www.long.example/?a='}${'y'.repeat(600)}  ` },
      { 'user-agent': UA, 'x-forwarded-for': '203.0.113.6' },
    );
    const views = viewRows(dbp);
    assert.equal(views.length, 6);
    assert.equal(views[0].ref, 'https://www.producthunt.com/posts/ass-score?utm=x', 'ref stored as sent');
    assert.equal(views[1].ref, '', 'empty ref stored as \'\'');
    assert.equal(views[2].ref, 'not-a-url', 'non-URL string still stored (the admin sources aggregation buckets it defensively)');
    assert.equal(views[3].ref, '', 'non-string ref sanitized to \'\'');
    assert.equal(views[4].ref, '', 'object ref sanitized to \'\'');
    const capped = views[5].ref;
    assert.equal(capped.length, 500, 'ref trimmed + capped at 500 chars');
    assert.ok(!capped.startsWith(' '), 'leading whitespace trimmed');
    assert.equal(capped.slice(0, 21), 'https://www.long.exam', 'cap keeps the URL head');
  } finally {
    app.server.close();
  }
});

// ---------------------------------------------------------------------------
// Visible bot filtering — bot_hits ledger
// ---------------------------------------------------------------------------
test('track: webdriver:true is dropped and recorded with reason webdriver (every hit, even a burst)', async () => {
  const dbp = tmpDb();
  const app = startApp({ dbPath: dbp, now: () => TICK });
  try {
    // Headless browsers carry a perfectly normal UA — only the flag gives them away.
    const r1 = await track(app.base, { path: '/', webdriver: true }, { 'user-agent': UA });
    const r2 = await track(app.base, { path: '/', webdriver: true }, { 'user-agent': UA });
    assert.equal(r1.status, 204);
    assert.equal(r2.status, 204);
    assert.equal(countRows(dbp, 'bot_hits'), 2, 'a bot burst records EVERY hit');
    assert.equal(countRows(dbp, 'page_views'), 0, 'no webdriver hit may ever be a view');
    for (const b of botRows(dbp)) {
      assert.equal(b.reason, 'webdriver');
      assert.equal(b.ua, UA);
      assert.equal(b.path, '/');
      assert.match(b.ip, /127\.0\.0\.1$/);
    }
    // And a NON-webdriver hit from the same IP is a real view (flag only).
    await track(app.base, { path: '/' }, { 'user-agent': UA });
    assert.equal(countRows(dbp, 'bot_hits'), 2);
    assert.equal(countRows(dbp, 'page_views'), 1);
  } finally {
    app.server.close();
  }
});

test('track: extended BOT_PATTERNS drop + record with reason "ua:<pattern>"', async () => {
  const dbp = tmpDb();
  const app = startApp({ dbPath: dbp, now: () => TICK });
  try {
    const bots = [
      // The NEW patterns (owner 2026-10-10).
      ['Mozilla/5.0 (compatible; AhrefsBot/7.0; +http://ahrefs.com/robot/)', 'ua:ahrefsbot'],
      ['Mozilla/5.0 (compatible; SemrushBot/7.0; +http://www.semrush.com/bot.html)', 'ua:semrushbot'],
      ['Mozilla/5.0 (compatible; PetalBot; +http://aspiegel.com/petalbot)', 'ua:petalbot'],
      ['Mozilla/5.0 (compatible; MJ12bot/v1.4.8; http://mj12bot.com/)', 'ua:mj12bot'],
      ['Mozilla/5.0 (compatible; DotBot/1.2; +https://opensiteexplorer.org/dotbot; help@moz.com)', 'ua:dotbot'],
      ['UptimeRobot/2.0', 'ua:uptimerobot'],
      ['Pingdom.com_bot_version_1.4', 'ua:pingdom'],
      ['StatusCake-PageSpeed', 'ua:statuscake'],
      ['Mozilla/5.0 (Linux; Android 6.0.1; Nexus 5X Build/MMB29P) AppleWebKit/537.36 Chrome/W.X.Y.Z Mobile Safari/537.36 (compatible; Google-InspectionTool/1.0)', 'ua:google-inspectiontool'],
      ['Google-Site-Verification/1.0', 'ua:google-site-verification'],
      // NOTE: this classic Google UA also announces itself as
      // http://www.bing.com/bingbot.htm inside the product token, and
      // 'bingbot' precedes 'bingpreview' in the pattern list — find()
      // returns the FIRST match, so the stored reason is 'ua:bingbot'.
      ['Mozilla/5.0 (compatible; BingPreview/1.0; +http://www.bing.com/bingbot.htm)', 'ua:bingbot'],
      ['Mozilla/5.0 (iPhone; CPU iPhone OS 14_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/14.0 Mobile/15E148 Safari/604.1 (compatible; Applebot/0.1; +http://www.apple.com/go/applebot)', 'ua:applebot'],
      ['Mozilla/5.0 (compatible; GPTBot/1.2; +https://openai.com/gptbot)', 'ua:gptbot'],
      ['Mozilla/5.0 (compatible; CCBot/2.0; https://commoncrawl.org/faq/)', 'ua:ccbot'],
      ['Mozilla/5.0 (compatible; Amazonbot/0.1; +https://developer.amazon.com/support/amazonbot)', 'ua:amazonbot'],
      ['facebookbot/1.0 (+http://www.facebook.com/externalhit_uatext.php)', 'ua:facebookbot'],
      ['Mozilla/5.0 (compatible; Bytespider; spider-feedback@bytedance.com)', 'ua:bytespider'],
      ['Mozilla/5.0 (compatible; DataForSeoBot/1.00; +https://dataforseo.com/dataforseo-bot)', 'ua:dataforseo'],
      ['Baiduspider-render/2.0', 'ua:baiduspider'],
      ['Mozilla/5.0 (compatible; YandexBot/3.0; +http://yandex.com/bots)', 'ua:yandex'],
    ];
    for (const [ua, expected] of bots) {
      const r = await track(app.base, { path: '/blog/referrer-test' }, { 'user-agent': ua, 'x-forwarded-for': '203.0.113.9' });
      assert.equal(r.status, 204);
    }
    assert.equal(countRows(dbp, 'page_views'), 0, 'none of the bot UAs may be views');
    assert.equal(countRows(dbp, 'bot_hits'), bots.length, 'one bot_hits row per dropped hit');
    const rows = botRows(dbp);
    rows.forEach((b, i) => {
      assert.equal(b.reason, bots[i][1], `reason ${i} is the matched pattern (${bots[i][1]})`);
      assert.equal(b.path, '/blog/referrer-test');
      assert.equal(b.ref, '', 'no ref sent -> stored empty');
      assert.equal(b.ip, '203.0.113.9', 'client IP recorded via the shared derivation');
    });
    // A real browser UA is STILL a view, proving the extended list doesn't over-match.
    await track(app.base, { path: '/', ref: 'https://www.example.com/' }, { 'user-agent': UA });
    assert.equal(countRows(dbp, 'page_views'), 1);
  } finally {
    app.server.close();
  }
});

test('track: empty/missing UA is dropped and recorded with reason empty_ua (204 semantics unchanged)', async () => {
  const dbp = tmpDb();
  const app = startApp({ dbPath: dbp, now: () => TICK });
  try {
    // undici injects `user-agent: node` when none is set, so the missing-UA
    // case is simulated with an empty header (undici drops it entirely).
    assert.equal((await track(app.base, { path: '/' }, { 'user-agent': '' })).status, 204);
    assert.equal((await track(app.base, { path: '/' }, { 'user-agent': '   ' })).status, 204);
    assert.equal(countRows(dbp, 'page_views'), 0);
    assert.equal(countRows(dbp, 'bot_hits'), 2);
    for (const b of botRows(dbp)) assert.equal(b.reason, 'empty_ua');
  } finally {
    app.server.close();
  }
});

test('track: per-IP 30s dedup drop is recorded with reason dedup (and later views still count)', async () => {
  const dbp = tmpDb();
  let tick = TICK;
  const app = startApp({ dbPath: dbp, now: () => tick });
  try {
    assert.equal((await track(app.base, { path: '/' }, { 'user-agent': UA })).status, 204);
    assert.equal((await track(app.base, { path: '/' }, { 'user-agent': UA })).status, 204, '2nd hit within window still 204');
    assert.equal(countRows(dbp, 'page_views'), 1, 'dedup keeps one view');
    assert.equal(countRows(dbp, 'bot_hits'), 1, 'the deduped repeat IS recorded');
    assert.equal(botRows(dbp)[0].reason, 'dedup');
    tick = new Date(Date.parse(TICK) + 31_000).toISOString();
    await track(app.base, { path: '/' }, { 'user-agent': UA });
    assert.equal(countRows(dbp, 'page_views'), 2, 'a hit after the window is a new view — dedup never starves humans');
    assert.equal(countRows(dbp, 'bot_hits'), 1, 'no new bot row for the accepted view');
  } finally {
    app.server.close();
  }
});

// ---------------------------------------------------------------------------
// Schema migration — page_views without the ref column (existing prod DB)
// ---------------------------------------------------------------------------
/** Build a DB file with the OLD page_views schema (no ref column) + one row. */
function oldSchemaDb() {
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
  raw
    .prepare('INSERT INTO page_views (ts, ip, ua, path) VALUES (?, ?, ?, ?)')
    .run(Date.parse(TICK), '203.0.113.9', UA, '/pre-migration');
  raw.close();
  return dbp;
}

test('db: migrated DB (old page_views, no ref column) gains ref + bot_hits; old rows read ref=\'\'; fresh DB has both from the start', () => {
  // -- Migrated (existing prod) DB --
  const migrated = oldSchemaDb();
  const db = openDb(migrated);
  try {
    const cols = db.raw.prepare('PRAGMA table_info(page_views)').all().map((c) => c.name);
    assert.ok(cols.includes('ref'), 'ref column added by migration');
    // Old row backfills to '' — exactly what 'direct' needs.
    assert.equal(db.raw.prepare('SELECT ref FROM page_views WHERE path = ?').get('/pre-migration').ref, '');
    assert.ok(db.raw.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='bot_hits'").get(), 'bot_hits created');
    // New inserts write ref normally; bot ledger works on the migrated DB too.
    db.insertPageView({ ts: Date.parse(TICK), ip: '203.0.113.1', ua: UA, path: '/post', ref: 'https://www.example.com/' });
    db.insertBotHit({ ts: Date.parse(TICK), ip: '203.0.113.1', ua: UA, path: '/', ref: '', reason: 'ua:gptbot' });
    const rows = db.raw.prepare('SELECT path, ref FROM page_views ORDER BY id').all();
    assert.deepEqual(rows, [
      { path: '/pre-migration', ref: '' },
      { path: '/post', ref: 'https://www.example.com/' },
    ]);
    // Idempotent: opening the SAME already-migrated DB again is a no-op.
    db.close();
    const db2 = openDb(migrated);
    try {
      assert.equal(db2.countPageViews(), 2);
      assert.equal(db2.countBotHitsTotal(), 1);
    } finally {
      db2.close();
    }
  } finally {
    db.close();
  }

  // -- Fresh DB --
  const fresh = tmpDb();
  const fdb = openDb(fresh);
  try {
    const cols = fdb.raw.prepare('PRAGMA table_info(page_views)').all().map((c) => c.name);
    assert.ok(cols.includes('ref'), 'fresh DB includes ref in CREATE TABLE');
    fdb.insertPageView({ ts: Date.parse(TICK), ip: '203.0.113.1', ua: UA, path: '/', ref: 'https://x.example/' });
    assert.equal(fdb.raw.prepare('SELECT ref FROM page_views').get().ref, 'https://x.example/');
  } finally {
    fdb.close();
  }
});

// ---------------------------------------------------------------------------
// Admin JSON — sources + bots
// ---------------------------------------------------------------------------
test('admin: sources aggregates the window by hostname (www. stripped, direct bucket, invalid ref fallback, top-10, sorted desc)', async () => {
  const dbp = tmpDb();
  const app = startApp({ dbPath: dbp, now: () => TICK });
  try {
    const seed = openDb(dbp);
    const t = Date.parse(TICK);
    const v = (path, ip, ref) => seed.insertPageView({ ts: t, ip, ua: UA, path, ref });
    v('/', '203.0.113.1', ''); // direct
    v('/', '203.0.113.2', ''); // direct
    v('/', '203.0.113.3', 'https://www.google.com/search?q=ass+score'); // google.com (www. stripped)
    v('/', '203.0.113.4', 'https://www.google.com/another-path'); // google.com again
    v('/', '203.0.113.5', 'https://producthunt.com/posts/ass-score'); // producthunt.com
    v('/', '203.0.113.6', 'https://news.ycombinator.com/item?id=1'); // news.ycombinator.com
    v('/', '203.0.113.7', '   https://example.com   '); // example.com — trimmed by route normally, stored as sent here
    // 8 more distinct refs + 3 invalid -> 14 distinct sources, only top 10 returned.
    for (let i = 0; i < 8; i++) v('/', `203.0.113.1${i}`, `https://ref${i}.example/page`);
    // Invalid refs (x3 — enough to stay inside the top-10) -> raw ref kept as evidence.
    v('/', '203.0.113.99', 'this is not a url');
    v('/', '203.0.113.100', 'this is not a url');
    v('/', '203.0.113.101', 'this is not a url');
    seed.close();
    const r = await fetch(`${app.base}/admin/stats`, { headers: { 'x-admin-password': PASSWORD } });
    assert.equal(r.status, 200);
    const json = await r.json();
    assert.ok(Array.isArray(json.sources.top), 'sources.top is an array');
    assert.equal(json.sources.total, json.views.last30d.reduce((n, d) => n + d.count, 0), 'sources.total = the whole window');
    assert.equal(json.sources.total, 18);
    assert.equal(json.sources.top.length, 10, 'top-10 cap');
    // Sorted descending by count.
    for (let i = 1; i < json.sources.top.length; i++) {
      assert.ok(json.sources.top[i - 1].count >= json.sources.top[i].count, 'sorted desc');
    }
    const google = json.sources.top.find((s) => s.source === 'google.com');
    assert.equal(google.count, 2, 'www. stripped + refs to the same hostname merged');
    assert.ok(json.sources.top.some((s) => s.source === 'direct'), 'the direct bucket is present');
    assert.equal(json.sources.top.find((s) => s.source === 'direct').count, 2);
    assert.equal(
      json.sources.top.find((s) => s.source === 'this is not a url').count,
      3,
      'unparseable ref kept as raw evidence (all 3 hits bucketed)'
    );
    assert.ok(json.sources.top.some((s) => s.source === 'producthunt.com'));
    assert.ok(json.sources.top.some((s) => s.source === 'news.ycombinator.com'));
    // The one-hit refN.example pages tie at 1: top-10 runs down the sort, so
    // the 3-count invalid bucket, the two 2-count buckets and 7 singles fill it.
    assert.ok(json.sources.top[0].count >= 2, 'highest count first');
  } finally {
    app.server.close();
  }
});

test('admin: sources gains direct_by_app + direct_total — ref=\'\' views classified by stored UA; direct_total == the direct bucket', async () => {
  const dbp = tmpDb();
  const app = startApp({ dbPath: dbp, now: () => TICK });
  try {
    const X_UA = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Twitter for Android/10.0.1 Mobile Safari/537.36';
    const SAFARI_IOS_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1';
    const seed = openDb(dbp);
    const t = Date.parse(TICK);
    // ref='' X-app view + ref='' Safari-iOS view + a t.co referral view.
    seed.insertPageView({ ts: t, ip: '203.0.113.1', ua: X_UA, path: '/', ref: '' });
    seed.insertPageView({ ts: t, ip: '203.0.113.2', ua: SAFARI_IOS_UA, path: '/', ref: '' });
    seed.insertPageView({ ts: t, ip: '203.0.113.3', ua: SAFARI_IOS_UA, path: '/', ref: 'https://t.co/abc123' });
    seed.close();
    const r = await fetch(`${app.base}/admin/stats`, { headers: { 'x-admin-password': PASSWORD } });
    assert.equal(r.status, 200);
    const json = await r.json();
    // sources.top is byte-identical to before the feature (direct 2 + t.co 1).
    assert.deepEqual(json.sources.top, [
      { source: 'direct', count: 2 },
      { source: 't.co', count: 1 },
    ]);
    assert.equal(json.sources.total, 3, 'total unchanged');
    assert.ok(Array.isArray(json.sources.direct_by_app), 'direct_by_app is an array');
    assert.equal(json.sources.direct_total, 2, 'direct_total = ref=\'\' views in the window');
    assert.equal(
      json.sources.direct_total,
      json.sources.top.find((s) => s.source === 'direct').count,
      'direct_total equals the \'direct\' bucket in sources.top by construction',
    );
    // Deterministic order: count desc, then app key desc (x before safari-ios).
    assert.deepEqual(json.sources.direct_by_app, [
      { app: 'x', label: 'X app', count: 1 },
      { app: 'safari-ios', label: 'Safari (iPhone)', count: 1 },
    ]);
    // Every other stats block is untouched: views/scan/purchase/bot shapes stand.
    assert.deepEqual(Object.keys(json.views).sort(), ['last30d', 'recent', 'today', 'total']);
    assert.deepEqual(Object.keys(json.sources).sort(), ['direct_by_app', 'direct_total', 'top', 'total']);
    assert.equal(json.views.total, 3);
  } finally {
    app.server.close();
  }
});

test('admin: sources.direct_by_app is empty when there is no direct traffic (referrals only)', async () => {
  const dbp = tmpDb();
  const app = startApp({ dbPath: dbp, now: () => TICK });
  try {
    const seed = openDb(dbp);
    const t = Date.parse(TICK);
    seed.insertPageView({ ts: t, ip: '203.0.113.1', ua: UA, path: '/', ref: 'https://t.co/xyz' });
    seed.insertPageView({ ts: t, ip: '203.0.113.2', ua: UA, path: '/', ref: 'https://www.google.com/' });
    seed.close();
    const json = await (await fetch(`${app.base}/admin/stats`, { headers: { 'x-admin-password': PASSWORD } })).json();
    assert.equal(json.sources.total, 2);
    // Tie at 1: the existing route tie-break is source asc, so google.com first.
    assert.deepEqual(json.sources.top, [
      { source: 'google.com', count: 1 },
      { source: 't.co', count: 1 },
    ]);
    assert.equal(json.sources.direct_total, 0, 'no direct rows -> zero');
    assert.deepEqual(json.sources.direct_by_app, [], 'no chips to render');
    assert.ok(!json.sources.top.some((s) => s.source === 'direct'), 'no direct row when directCount is 0');
  } finally {
    app.server.close();
  }
});

test('admin: sources + bots respect the stats_epoch floor (pre-epoch rows never counted)', async () => {
  const dbp = tmpDb();
  const app = startApp({ dbPath: dbp, now: () => TICK });
  try {
    const seed = openDb(dbp);
    const pre = Date.parse('2026-09-01T00:00:00.000Z');
    seed.insertPageView({ ts: pre, ip: '203.0.113.1', ua: UA, path: '/pre', ref: 'https://pre.example/' });
    seed.insertBotHit({ ts: pre, ip: '203.0.113.1', ua: 'Googlebot/2.1', path: '/pre', ref: '', reason: 'ua:googlebot' });
    seed.setSetting('stats_epoch', '2026-09-10T00:00:00.000Z'); // floor AFTER the seeded rows
    seed.close();
    const r = await fetch(`${app.base}/admin/stats`, { headers: { 'x-admin-password': PASSWORD } });
    const json = await r.json();
    assert.equal(json.views.total, 0);
    assert.equal(json.sources.total, 0, 'sources floor = viewFloorTs exactly');
    assert.deepEqual(json.sources.top, []);
    assert.equal(json.bots.total, 0, 'bots total floor = epochMs exactly like views');
    assert.equal(json.bots.today, 0);
    assert.ok(json.bots.last30d.every((d) => d.count === 0), 'bots series flat');
    assert.deepEqual(json.bots.recent, []);
    // Rows AFTER the epoch count in every bots/sources surface.
    const post = openDb(dbp);
    const t = Date.parse('2026-09-23T11:00:00.000Z');
    post.insertPageView({ ts: t, ip: '203.0.113.2', ua: UA, path: '/post', ref: 'https://post.example/' });
    post.insertBotHit({ ts: t, ip: '203.0.113.2', ua: 'GPTBot/1.2', path: '/post', ref: '', reason: 'ua:gptbot' });
    post.insertBotHit({ ts: t, ip: '203.0.113.3', ua: UA, path: '/post2', ref: '', reason: 'webdriver' });
    post.close();
    const g2 = await fetch(`${app.base}/admin/stats`, { headers: { 'x-admin-password': PASSWORD } });
    const json2 = await g2.json();
    assert.equal(json2.sources.total, 1);
    assert.deepEqual(json2.sources.top, [{ source: 'post.example', count: 1 }]);
    assert.equal(json2.bots.total, 2);
    assert.equal(json2.bots.today, 2);
    assert.equal(json2.bots.recent.length, 2);
    assert.deepEqual(json2.bots.recent.map((b) => b.reason), ['webdriver', 'ua:gptbot'], 'recent newest-first');
    assert.ok(json2.bots.last30d.some((d) => d.count === 2), 'today bucket in the series');
  } finally {
    app.server.close();
  }
});

test('admin: bots JSON shape + recent rows carry ts/ip/ua/path/ref/reason (latest 20)', async () => {
  const dbp = tmpDb();
  const app = startApp({ dbPath: dbp, now: () => TICK });
  try {
    // 25 bot hits — recent caps at 20.
    const seed = openDb(dbp);
    const t0 = Date.parse(TICK);
    for (let i = 0; i < 25; i++) {
      const ts = t0 - (24 - i) * 60_000; // i=24 newest
      seed.insertBotHit({
        ts,
        ip: `203.0.113.${i % 250}`,
        ua: i % 2 ? 'GPTBot/1.2' : 'AhrefsBot/7.0',
        path: `/p${i}`,
        ref: `https://src${i}.example/`,
        reason: i % 2 ? 'ua:gptbot' : 'ua:ahrefsbot',
      });
    }
    seed.close();
    const r = await fetch(`${app.base}/admin/stats`, { headers: { 'x-admin-password': PASSWORD } });
    const json = await r.json();
    assert.equal(json.bots.total, 25);
    assert.equal(json.bots.today, 25); // all within today's UTC bucket
    assert.equal(json.bots.recent.length, 20, 'latest 20');
    assert.ok(json.bots.last30d.length === 30);
    assert.equal(json.bots.last30d[29].count, 25, 'today bucket = all 25');
    const newest = json.bots.recent[0];
    assert.deepEqual(Object.keys(newest).sort(), ['ip', 'path', 'reason', 'ref', 'ts', 'ua']);
    assert.equal(newest.path, '/p24');
    assert.ok(json.bots.last30d[29].date, '2026-09-23');
  } finally {
    app.server.close();
  }
});

// ---------------------------------------------------------------------------
// Admin HTML dashboard
// ---------------------------------------------------------------------------
test('admin: HTML dashboard shows BOTS KPIs, the bots chart series, Top referrers card with % bars, and the recent-bot-hits table', async () => {
  const dbp = tmpDb();
  const app = startApp({ dbPath: dbp, now: () => TICK });
  try {
    await track(app.base, { path: '/', ref: 'https://www.google.com/' }, { 'user-agent': UA });
    await track(app.base, { path: '/' }, { 'user-agent': UA, 'x-forwarded-for': '203.0.113.2' });
    await track(app.base, { path: '/', ref: 'https://www.google.com/search?q=x' }, { 'user-agent': 'Googlebot/2.1' });
    await track(app.base, { path: '/', webdriver: true }, { 'user-agent': 'HeadlessChrome/120.0' });
    await track(app.base, { path: '/', webdriver: true }, { 'user-agent': 'HeadlessChrome/120.0' });
    const r = await fetch(`${app.base}/admin/stats`, { headers: { accept: 'text/html', 'x-admin-password': PASSWORD } });
    assert.equal(r.status, 200);
    const html = await r.text();
    // KPI row
    assert.ok(html.includes('BOTS BLOCKED'), 'bots total KPI label');
    assert.ok(html.includes('BOTS TODAY'), 'bots today KPI label');
    assert.match(html, /BOTS BLOCKED<\/span>\s*<span class="kpi-value"[^>]*>3<\/span>/, 'bots total renders 3 (2 webdriver + 1 googlebot)');
    assert.match(html, /BOTS TODAY<\/span>\s*<span class="kpi-value"[^>]*>3<\/span>/, 'bots today renders 3');
    // Chart: 30 bots bars + the legend swatch + today tooltip with the bots count.
    assert.equal((html.match(/class="bar bar-bots"/g) || []).length, 30, 'one bots bar per day');
    assert.ok(html.includes('sw-bots'), 'legend gains the bots swatch');
    assert.ok(html.includes('Bots blocked'), 'legend labels the bots series');
    assert.ok(html.includes('2026-09-23 — scans 0, views 2, reports 0, bots 3'), 'day-cell tooltip includes bots');
    assert.ok(html.includes('2026-09-23 · 3 bots blocked'), 'bots bar tooltip rendered');
    // Top referrers card
    assert.ok(html.includes('Top referrers'), 'referrers card title');
    assert.ok(html.includes('google.com'), 'hostname shown with www. stripped');
    assert.ok(html.includes('direct'), 'direct bucket shown');
    assert.ok(html.includes('src-fill'), '% bar markup present');
    assert.ok(html.includes('1%</span>') || html.includes('50%</span>'), 'percentage rendered');
    // Recent bot hits table
    assert.ok(html.includes('Recent bot hits'), 'bot table card title');
    assert.ok(html.includes('<th>Reason</th>'), 'reason column header');
    assert.ok(html.includes('ua:googlebot'), 'bot UA drop reason rendered');
    assert.ok(html.includes('webdriver'), 'webdriver drop reason rendered');
    assert.equal((html.match(/class="col-reason"/g) || []).length, 3, 'one reason cell per bot row');
    // Path cells appear in BOTH tables: 2 view rows + 3 bot rows.
    assert.equal((html.match(/class="col-path"/g) || []).length, 5);
  } finally {
    app.server.close();
  }
});

// ---------------------------------------------------------------------------
// Admin HTML dashboard — direct-by-app chips
// ---------------------------------------------------------------------------
test('admin: HTML dashboard renders the direct-by-app chips under the direct source row (labels + counts, wrap-safe)', async () => {
  const dbp = tmpDb();
  const app = startApp({ dbPath: dbp, now: () => TICK });
  try {
    const X_UA = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Twitter for Android/10.0.1 Mobile Safari/537.36';
    const SAFARI_IOS_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1';
    const seed = openDb(dbp);
    const t = Date.parse(TICK);
    seed.insertPageView({ ts: t, ip: '203.0.113.1', ua: X_UA, path: '/', ref: '' });
    seed.insertPageView({ ts: t, ip: '203.0.113.2', ua: SAFARI_IOS_UA, path: '/', ref: '' });
    seed.insertPageView({ ts: t, ip: '203.0.113.3', ua: SAFARI_IOS_UA, path: '/', ref: 'https://t.co/abc123' });
    seed.close();
    const r = await fetch(`${app.base}/admin/stats`, { headers: { accept: 'text/html', 'x-admin-password': PASSWORD } });
    assert.equal(r.status, 200);
    const html = await r.text();
    // The chip block renders under the direct row (markup, not just the CSS).
    assert.ok(html.includes('<div class="src-direct">'), 'chip container markup present');
    assert.ok(html.includes('class="src-chip"'), 'chip markup present');
    assert.ok(html.includes('>X app<span class="src-chip-n">1</span>'), 'X app chip with count');
    assert.ok(html.includes('>Safari (iPhone)<span class="src-chip-n">1</span>'), 'Safari (iPhone) chip with count');
    // Wrap-safe styling mirrors the pill-wrap fix (flex-wrap at narrow widths).
    assert.ok(html.includes('.src-direct{display:flex;flex-wrap:wrap;gap:6px;margin-top:6px;padding-left:2px}'), 'chip container wraps');
    assert.ok(html.includes('.src-chip-n{color:var(--lime);font-weight:800;font-variant-numeric:tabular-nums}'), 'chip count styled');
    // The direct row itself is unchanged: name, count, % bar.
    assert.ok(html.includes('title="direct">direct</span><span class="src-count">2'), 'direct row still renders its count');
    assert.ok(html.includes('src-fill'), '% bar markup present');
  } finally {
    app.server.close();
  }
});

test('admin: HTML dashboard renders NO chips when direct traffic is absent (referrals only)', async () => {
  const dbp = tmpDb();
  const app = startApp({ dbPath: dbp, now: () => TICK });
  try {
    const seed = openDb(dbp);
    const t = Date.parse(TICK);
    seed.insertPageView({ ts: t, ip: '203.0.113.1', ua: UA, path: '/', ref: 'https://www.google.com/' });
    seed.close();
    const r = await fetch(`${app.base}/admin/stats`, { headers: { accept: 'text/html', 'x-admin-password': PASSWORD } });
    assert.equal(r.status, 200);
    const html = await r.text();
    assert.ok(!html.includes('<div class="src-direct">'), 'no chip container markup when there are no direct rows');
    assert.ok(!html.includes('class="src-chip"'), 'no chips');
    assert.ok(html.includes('google.com'), 'the referral row still renders');
  } finally {
    app.server.close();
  }
});

// ---------------------------------------------------------------------------
// Retention — bot_hits purged with page_views
// ---------------------------------------------------------------------------
test('retention: bot_hits purged at the same epoch-ms cutoff as page_views (log line gains bots=)', () => {
  const db = openDb(tmpDb());
  try {
    const oldTs = Date.parse('2026-07-01T00:00:00.000Z'); // 84 days before TICK
    const freshTs = Date.parse('2026-09-10T00:00:00.000Z'); // 13 days before TICK
    db.insertPageView({ ts: oldTs, ip: '203.0.113.1', ua: UA, path: '/old' });
    db.insertPageView({ ts: freshTs, ip: '203.0.113.1', ua: UA, path: '/fresh' });
    db.insertBotHit({ ts: oldTs, ip: '203.0.113.1', ua: 'Googlebot/2.1', path: '/old', reason: 'ua:googlebot' });
    db.insertBotHit({ ts: oldTs, ip: '203.0.113.2', ua: '', path: '/old2', reason: 'empty_ua' });
    db.insertBotHit({ ts: freshTs, ip: '203.0.113.1', ua: 'GPTBot/1.2', path: '/fresh', reason: 'ua:gptbot' });
    // console.log capture — the log line must include bots=.
    const logs = [];
    const orig = console.log;
    console.log = (...args) => logs.push(args.join(' '));
    let res;
    try {
      res = runRetention({ db, now: () => TICK });
    } finally {
      console.log = orig;
    }
    assert.equal(res.deleted.views, 1, 'exactly the old page_view purged');
    assert.equal(res.deleted.bots, 2, 'exactly the two old bot hits purged');
    const leftBots = db.raw.prepare('SELECT reason FROM bot_hits').all().map((r) => r.reason);
    assert.deepEqual(leftBots, ['ua:gptbot'], 'fresh bot hit survives');
    const leftViews = db.raw.prepare('SELECT path FROM page_views').all().map((r) => r.path);
    assert.deepEqual(leftViews, ['/fresh']);
    assert.ok(logs[0].includes('bots=2'), `retention log line includes bots= (got: ${logs[0]})`);
    assert.ok(logs[0].includes('views=1'), 'log line still carries views=');
  } finally {
    db.close();
  }
});