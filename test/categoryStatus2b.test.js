import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../src/app.js';
import { openDb } from '../src/db.js';
import { validateUrl } from '../src/fetch/ssrf.js';
import { createReportToken } from '../src/paywall.js';
import { categoryPriority, categoryEvidence, categoryStatus } from '../src/reportHtml.js';

// Band-aware MEASURED one-liner copy (owner follow-up on #37): the CLEAN band
// (metrics only, score 0-9) gets the nothing-found flavor; every band from
// NEEDS WORK up gets the honest "score comes from generic-content
// measurements" line — the pill stays MEASURED at every band (Job #2B).
const MEASURED_CONCERN_LINE = 'Score comes from generic-content measurements — no single line crossed the threshold to quote.';
const MEASURED_CLEAN_LINE = 'Measurements found nothing to roast here.';

/**
 * JOB #2B REGRESSION — the two-axis category status contract (owner
 * requirement #8 from the Job #2B brief).
 *
 * Every category surfaces TWO independent labels, both derived from the SAME
 * stored classification (display-layer only — no scoring/weight/threshold/
 * detector/verdict-band changes):
 *
 *   AXIS 1 — PRIORITY pill = the score band of the sub-score:
 *       0–9 CLEAN · 10–24 WATCH · 25–49 NEEDS WORK · 50–74 PRIORITY ·
 *       75–100 CRITICAL.  A real negative finding in a CLEAN-band category
 *       promotes it to WATCH (10-07 invariant) — a roast is NEVER labeled
 *       CLEAN at the priority axis.  Skipped modules (null score) get NO
 *       priority pill.
 *
 *   AXIS 2 — EVIDENCE pill = what backs the score:
 *       FINDINGS (actionable negative findings; wins over measurements) ·
 *       MEASURED (only neutral metric measurements) ·
 *       NOT ENOUGH DATA (skipped module — never CLEAN) ·
 *       CLEAN (assessed, no meaningful concern).
 *
 * Coverage (brief §"at minimum"):
 *   - every priority band boundary (0, 9, 10, 24, 25, 49, 50, 74, 75, 100)
 *     -> exact band label, unit-pinned AND surface-pinned;
 *   - score/evidence combos: low band + negatives (never CLEAN), low band +
 *     metrics (MEASURED), mid band + metrics (NEEDS WORK / PRIORITY +
 *     MEASURED), high band + findings (CRITICAL + FINDINGS), skipped module /
 *     null score (NOT ENOUGH DATA — never CLEAN at either axis), genuinely
 *     clean (CLEAN + CLEAN), CLEAN band + negatives -> WATCH promotion;
 *   - BOTH axes render on the breakdown card AND the focused view.
 */
const SECRET = 'category-status-2b-secret';

const tmpDb = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ccs2b-test-')), 'test.db');
const fakeFetcher = () => ({ fetchHtml: async () => ({ status: 200, url: 'https://www.zoo.example/', body: '<html><body><p>x</p></body></html>' }) });
const offlineValidateTarget = async (raw) => validateUrl(raw);

function startApp(dbPath) {
  const app = createApp({ dbPath, fetcher: fakeFetcher(), validateTarget: offlineValidateTarget, maxScansPerDay: 0, reportTokenSecret: SECRET });
  const server = app.listen(0);
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

async function insertScan(dbPath, { id, breakdown, score = 33 }) {
  const repository = openDb(dbPath);
  repository.insertScan({ id, url: 'https://www.zoo.example/', score, breakdown, createdAt: '2026-10-09T12:00:00.000Z' });
  repository.close();
}

async function paidHtml(base, id) {
  const token = createReportToken(SECRET, id);
  const res = await fetch(`${base}/api/v1/scans/${id}?token=${encodeURIComponent(token)}`, { headers: { accept: 'text/html' } });
  assert.equal(res.status, 200, 'paid report serves 200 with a valid token');
  return res.text();
}

// --- fixtures ----------------------------------------------------------------

/** Metric-only measurement lines (classify as 'metric', never 'negative'). */
const METRICS = [
  'word variety: 0.852 (lower = more repetitive vocabulary)',
  'common words: 40.3% (little words like "the" and "and" — more means less substance)',
  'average sentence length: 32.8 words (9 sentences)',
  'short paragraphs (<25 words): 87% (23 paragraphs)',
];

/**
 * COMBO scan — one category per score/evidence combination (metric lines
 * classify as metrics ONLY under the infoDensity key — src/threeLayer.js
 * isMetricFinding — so every other category uses real roast/clean lines):
 *   filler        7    + 1 negative        -> WATCH + FINDINGS   (low band + negative, never CLEAN; promotion)
 *   boilerplate  24    + 1 negative        -> WATCH + FINDINGS   (WATCH ceiling 24 + findings)
 *   infoDensity  25    metrics only        -> NEEDS WORK + MEASURED (NEEDS WORK floor 25 + mid band + metrics)
 *   repetitive   49    + 1 negative        -> NEEDS WORK + FINDINGS (NEEDS WORK ceiling 49 + mid band + findings)
 *   crossPage   null  skipped              -> (no priority) + NOT ENOUGH DATA
 *   fingerprints  0   assessed, nothing   -> CLEAN + CLEAN      (genuinely clean)
 *   assets       75    + 1 negative        -> CRITICAL + FINDINGS (CRITICAL floor 75 + high band + findings)
 */
const COMBO_BREAKDOWN = {
  filler: { score: 7, findings: ['2× "robust"'] },
  boilerplate: { score: 24, findings: ['1× generic commitment claim'] },
  infoDensity: { score: 25, findings: METRICS },
  repetitive: { score: 49, findings: ['repeated sentence openings: 4× "the company"'] },
  crossPage: { score: null, findings: [], note: 'insufficient pages for cross-page analysis' },
  fingerprints: { score: 0, findings: [] },
  assets: { score: 75, findings: ['2 of 2 images from stock/placeholder CDNs'] },
};

/** MEASURED-band probe: the same metric lines at other bands (low / upper-mid). */
const MEASURED_LOW_BREAKDOWN = {
  filler: { score: 0, findings: ['0 filler phrases in 108 words (0.0 per 300 words)'] },
  boilerplate: { score: 0, findings: ['0 boilerplate signals in 108 words (0.0 per 300 words)'] },
  infoDensity: { score: 5, findings: METRICS },
  repetitive: { score: 0, findings: ['no notable repetitive structure (6 sentences, 3 paragraphs)'] },
  crossPage: { score: null, findings: [], note: 'insufficient pages for cross-page analysis' },
  fingerprints: { score: 0, findings: [] },
  assets: { score: 0, findings: ['0 of 2 images flagged for stock/placeholder signals'] },
};

const MEASURED_UP_BREAKDOWN = {
  filler: { score: 0, findings: ['0 filler phrases in 108 words (0.0 per 300 words)'] },
  boilerplate: { score: 62, findings: ['1× hedge phrase "we aim to"'] },
  infoDensity: { score: 55, findings: METRICS },
  repetitive: { score: 0, findings: ['no notable repetitive structure (6 sentences, 3 paragraphs)'] },
  crossPage: { score: 30, findings: [] },
  fingerprints: { score: 0, findings: [] },
  assets: { score: 0, findings: ['0 of 2 images flagged for stock/placeholder signals'] },
};

/**
 * BANDS scan — every remaining band boundary (9, 10, 24, 50, 74, 100) on the
 * card surface with no negatives and no metrics, so the plain band label
 * shows (evidence CLEAN for each).
 */
const BANDS_BREAKDOWN = {
  filler: { score: 9, findings: [] },        // CLEAN ceiling
  boilerplate: { score: 10, findings: [] },  // WATCH floor
  infoDensity: { score: 24, findings: [] },  // WATCH ceiling
  repetitive: { score: 50, findings: [] },   // PRIORITY floor
  crossPage: { score: 74, findings: [] },    // PRIORITY ceiling
  fingerprints: { score: 100, findings: [] },// CRITICAL ceiling
  assets: { score: 12, findings: ['1× "game-changer"'] }, // WATCH band + a real roast (mid-band + findings)
};

/** The rendered breakdown card for one category (everything inside its <a>). */
function cardByHref(html, anchor) {
  const m = html.match(new RegExp(`<a class="cat-card ([^"]*)" href="#${anchor}">[\\s\\S]*?<\\/a>`));
  assert.ok(m, `card #${anchor} rendered`);
  return m[0];
}

/** The focused-view section for one category. */
function viewSlice(html, key) {
  const start = html.indexOf(`view-cat-${key}`);
  assert.ok(start >= 0, `focused view for ${key} exists`);
  const end = html.indexOf('<section class="cat-view"', start + 1);
  return html.slice(start, end >= 0 ? end : html.length);
}

// ---------------------------------------------------------------------------
// UNIT: priority boundaries -> exact band labels (brief rule 1, all 10 edges)
// ---------------------------------------------------------------------------
test('unit: categoryPriority maps every band boundary to the exact label (0/9/10/24/25/49/50/74/75/100)', () => {
  assert.equal(categoryPriority(0, 0), 'CLEAN', '0 is CLEAN (floor)');
  assert.equal(categoryPriority(9, 0), 'CLEAN', '9 is CLEAN (ceiling)');
  assert.equal(categoryPriority(10, 0), 'WATCH', '10 is WATCH (floor)');
  assert.equal(categoryPriority(24, 0), 'WATCH', '24 is WATCH (ceiling)');
  assert.equal(categoryPriority(25, 0), 'NEEDS WORK', '25 is NEEDS WORK (floor)');
  assert.equal(categoryPriority(49, 0), 'NEEDS WORK', '49 is NEEDS WORK (ceiling)');
  assert.equal(categoryPriority(50, 0), 'PRIORITY', '50 is PRIORITY (floor)');
  assert.equal(categoryPriority(74, 0), 'PRIORITY', '74 is PRIORITY (ceiling)');
  assert.equal(categoryPriority(75, 0), 'CRITICAL', '75 is CRITICAL (floor)');
  assert.equal(categoryPriority(100, 0), 'CRITICAL', '100 is CRITICAL (ceiling)');
  assert.equal(categoryPriority(null), null, 'skipped module (null score) has NO priority pill');
  assert.equal(categoryPriority(undefined), null, 'missing score has no priority pill');
});

// ---------------------------------------------------------------------------
// UNIT: evidence semantics (brief rule 2) + the promotion rule
// ---------------------------------------------------------------------------
test('unit: categoryEvidence returns FINDINGS / MEASURED / NOT ENOUGH DATA / CLEAN from the classified split', () => {
  assert.equal(categoryEvidence(5, 1, 0), 'FINDINGS', 'a negative finding wins over nothing');
  assert.equal(categoryEvidence(5, 1, 4), 'FINDINGS', 'negatives win over measurement lines');
  assert.equal(categoryEvidence(5, 0, 4), 'MEASURED', 'metrics with zero negatives = MEASURED');
  assert.equal(categoryEvidence(5, 0, 0), 'CLEAN', 'assessed with nothing found = CLEAN');
  assert.equal(categoryEvidence(null, 0, 0), 'NOT ENOUGH DATA', 'skipped module = NOT ENOUGH DATA, never CLEAN');
  assert.equal(categoryEvidence(undefined, 0, 0), 'NOT ENOUGH DATA', 'missing score = NOT ENOUGH DATA');
});

test('unit: categoryStatus returns both axes, and a CLEAN band with negatives promotes to WATCH (10-07 invariant)', () => {
  assert.deepEqual(categoryStatus(32, 0, 4), { priority: 'NEEDS WORK', evidence: 'MEASURED' },
    'the ledger-story ORIGINALITY 32 shape: band fact + MEASURED');
  assert.deepEqual(categoryStatus(7, 1, 0), { priority: 'WATCH', evidence: 'FINDINGS' },
    'CLEAN band + real roast promotes to WATCH and stays FINDINGS');
  assert.deepEqual(categoryStatus(100, 1, 0), { priority: 'CRITICAL', evidence: 'FINDINGS' },
    'high band + real roast = CRITICAL + FINDINGS');
  assert.deepEqual(categoryStatus(3, 0, 0), { priority: 'CLEAN', evidence: 'CLEAN' },
    'genuinely clean assessed = CLEAN on both axes');
  assert.deepEqual(categoryStatus(null, 0, 0), { priority: null, evidence: 'NOT ENOUGH DATA' },
    'skipped module: no priority pill + NOT ENOUGH DATA evidence');
});

// ---------------------------------------------------------------------------
// SURFACE: the COMBO matrix — both axes on the breakdown card AND the focused
// view for every score/evidence combination in the brief
// ---------------------------------------------------------------------------
test('surface: every score/evidence combo renders both axes on the card and the focused view', async () => {
  const dbPath = tmpDb();
  const COMBO_ID = 's2b-00000000-0000-4000-8000-0000000000c1';
  await insertScan(dbPath, { id: COMBO_ID, breakdown: COMBO_BREAKDOWN, score: 33 });
  const app = startApp(dbPath);
  try {
    const html = await paidHtml(app.base, COMBO_ID);

    // (1) LOW band + real negative -> WATCH + FINDINGS, NEVER CLEAN at either axis.
    const filler = cardByHref(html, 'cat-filler');
    assert.ok(filler.includes('class="cat-card cat-watch"'), 'filler (7+neg): CLEAN band promotes to WATCH');
    assert.ok(filler.includes('<span class="cat-state">WATCH</span>'), 'filler: priority pill WATCH (never CLEAN)');
    assert.ok(!filler.includes('<span class="cat-state">CLEAN</span>'), 'filler: no CLEAN priority pill next to a roast');
    assert.ok(filler.includes('<span class="cat-ev cat-ev-findings">FINDINGS</span>'), 'filler: evidence pill FINDINGS');
    assert.ok(!filler.includes('cat-ev-clean">CLEAN'), 'filler: no CLEAN evidence pill next to a roast');
    assert.ok(filler.includes('1 roast — see receipts'), 'filler: roast count line kept');
    const fillerView = viewSlice(html, 'filler');
    assert.ok(fillerView.includes('cv-state cv-state-watch">WATCH</span>'), 'filler view: promoted WATCH priority pill');
    assert.ok(fillerView.includes('cv-ev cv-ev-findings">FINDINGS</span>'), 'filler view: FINDINGS evidence pill');

    // (2) WATCH band ceiling (24) with a real negative -> WATCH + FINDINGS.
    const boiler = cardByHref(html, 'cat-boilerplate');
    assert.ok(boiler.includes('class="cat-card cat-watch"'), 'boilerplate (24+neg): WATCH band class');
    assert.ok(boiler.includes('<span class="cat-state">WATCH</span>'), 'boilerplate (24): priority pill WATCH at 24');
    assert.ok(boiler.includes('<span class="cat-ev cat-ev-findings">FINDINGS</span>'), 'boilerplate (24): evidence pill FINDINGS');
    assert.ok(boiler.includes('1 roast — see receipts'), 'boilerplate: roast count line kept');
    const boilerView = viewSlice(html, 'boilerplate');
    assert.ok(boilerView.includes('cv-state cv-state-watch">WATCH</span>'), 'boilerplate view: WATCH priority pill');
    assert.ok(boilerView.includes('cv-ev cv-ev-findings">FINDINGS</span>'), 'boilerplate view: FINDINGS evidence pill');

    // (3) MID band (NEEDS WORK floor) + metrics -> NEEDS WORK + MEASURED.
    const info = cardByHref(html, 'cat-infodensity');
    assert.ok(info.includes('class="cat-card cat-needs-work"'), 'infoDensity (25): NEEDS WORK band class');
    assert.ok(info.includes('<span class="cat-state">NEEDS WORK</span>'), 'infoDensity (25): priority pill NEEDS WORK');
    assert.ok(info.includes('<span class="cat-ev cat-ev-measured">MEASURED</span>'), 'infoDensity (25): evidence pill MEASURED');
    assert.ok(!info.includes('cat-ev-findings'), 'infoDensity: never FINDINGS (measurements are neutral)');
    assert.ok(info.includes('Measurements only'), 'infoDensity (25): Measurements only line');
    const infoView = viewSlice(html, 'infodensity');
    assert.ok(infoView.includes('cv-state cv-state-needs-work">NEEDS WORK</span>'), 'infoDensity view: NEEDS WORK priority pill');
    assert.ok(infoView.includes('cv-ev cv-ev-measured">MEASURED</span>'), 'infoDensity view: MEASURED evidence pill');

    // (4) NEEDS WORK ceiling (49) with a real negative -> NEEDS WORK + FINDINGS.
    const rep = cardByHref(html, 'cat-repetitive');
    assert.ok(rep.includes('class="cat-card cat-needs-work"'), 'repetitive (49): NEEDS WORK band class at the ceiling');
    assert.ok(rep.includes('<span class="cat-state">NEEDS WORK</span>'), 'repetitive (49): priority pill NEEDS WORK at 49');
    assert.ok(rep.includes('<span class="cat-ev cat-ev-findings">FINDINGS</span>'), 'repetitive (49): evidence pill FINDINGS');
    const repView = viewSlice(html, 'repetitive');
    assert.ok(repView.includes('cv-state cv-state-needs-work">NEEDS WORK</span>'), 'repetitive view: NEEDS WORK priority pill');
    assert.ok(repView.includes('cv-ev cv-ev-findings">FINDINGS</span>'), 'repetitive view: FINDINGS evidence pill');

    // (5) SKIPPED module / null score -> NOT ENOUGH DATA, never CLEAN at either axis.
    const xp = cardByHref(html, 'cat-crosspage');
    assert.ok(xp.includes('class="cat-card cat-skipped"'), 'crossPage (null): skipped card class');
    assert.ok(xp.includes('<span class="cat-ev cat-ev-nodata">NOT ENOUGH DATA</span>'), 'crossPage: NOT ENOUGH DATA evidence pill');
    assert.ok(!xp.includes('<span class="cat-state">'), 'crossPage: no priority pill at all (no score to band)');
    assert.ok(!xp.includes('CLEAN'), 'crossPage card: never CLEAN');
    assert.ok(xp.includes('insufficient pages for cross-page analysis'), 'crossPage: stored note surfaced');
    const xpView = viewSlice(html, 'crosspage');
    assert.ok(xpView.includes('cv-ev cv-ev-nodata">NOT ENOUGH DATA</span>'), 'crossPage view: NOT ENOUGH DATA evidence pill');
    assert.ok(!xpView.includes('cv-state'), 'crossPage view: no priority badge (never CLEAN at the priority axis)');
    assert.ok(xpView.includes('insufficient pages for cross-page analysis'), 'crossPage view: note kept');

    // (6) GENUINELY CLEAN assessed -> CLEAN + CLEAN on both axes.
    const fp = cardByHref(html, 'cat-fingerprints');
    assert.ok(fp.includes('class="cat-card cat-clean"'), 'fingerprints (0, nothing found): CLEAN band class');
    assert.ok(fp.includes('<span class="cat-state">CLEAN</span>'), 'fingerprints: priority pill CLEAN');
    assert.ok(fp.includes('<span class="cat-ev cat-ev-clean">CLEAN</span>'), 'fingerprints: evidence pill CLEAN');
    assert.ok(!fp.includes('MEASURED') && !fp.includes('NOT ENOUGH DATA'), 'fingerprints: no invented neutral/skipped states');
    const fpView = viewSlice(html, 'fingerprints');
    assert.ok(fpView.includes('cv-state cv-state-clean">CLEAN</span>'), 'fingerprints view: CLEAN priority pill');
    assert.ok(fpView.includes('cv-ev cv-ev-clean">CLEAN</span>'), 'fingerprints view: CLEAN evidence pill');

    // (7) HIGH band + findings -> CRITICAL + FINDINGS on both axes.
    const assets = cardByHref(html, 'cat-assets');
    assert.ok(assets.includes('class="cat-card cat-critical"'), 'assets (75): CRITICAL band class');
    assert.ok(assets.includes('<span class="cat-state">CRITICAL</span>'), 'assets (75): priority pill CRITICAL');
    assert.ok(assets.includes('<span class="cat-ev cat-ev-findings">FINDINGS</span>'), 'assets (75): evidence pill FINDINGS');
    const assetsView = viewSlice(html, 'assets');
    assert.ok(assetsView.includes('cv-state cv-state-critical">CRITICAL</span>'), 'assets view: CRITICAL priority pill');
    assert.ok(assetsView.includes('cv-ev cv-ev-findings">FINDINGS</span>'), 'assets view: FINDINGS evidence pill');
  } finally {
    app.server.close();
  }
});

// ---------------------------------------------------------------------------
// SURFACE: MEASURED evidence at OTHER bands (low CLEAN band and upper-mid
// PRIORITY band) — the neutral evidence axis never depends on the band
// ---------------------------------------------------------------------------
test('surface: MEASURED evidence renders at the low CLEAN band and the upper-mid PRIORITY band', async () => {
  const dbPath = tmpDb();
  const LOW_ID = 's2b-00000000-0000-4000-8000-0000000000l3';
  const UP_ID = 's2b-00000000-0000-4000-8000-0000000000u4';
  await insertScan(dbPath, { id: LOW_ID, breakdown: MEASURED_LOW_BREAKDOWN, score: 3 });
  await insertScan(dbPath, { id: UP_ID, breakdown: MEASURED_UP_BREAKDOWN, score: 34 });
  const app = startApp(dbPath);
  try {
    const lowHtml = await paidHtml(app.base, LOW_ID);
    const low = cardByHref(lowHtml, 'cat-infodensity');
    assert.ok(low.includes('class="cat-card cat-clean"'), 'infoDensity (5): CLEAN band card class');
    assert.ok(low.includes('<span class="cat-state">CLEAN</span>'), 'infoDensity (5): priority pill CLEAN');
    assert.ok(low.includes('<span class="cat-ev cat-ev-measured">MEASURED</span>'), 'infoDensity (5): evidence pill MEASURED at the low band');
    assert.ok(low.includes('Measurements only'), 'infoDensity (5): Measurements only line');
    assert.ok(low.includes(MEASURED_CLEAN_LINE), 'infoDensity (5): CLEAN-band MEASURED keeps the clean one-liner');
    assert.ok(!low.includes(MEASURED_CONCERN_LINE), 'infoDensity (5): no concern copy at a CLEAN band');
    const lowView = viewSlice(lowHtml, 'infodensity');
    assert.ok(lowView.includes('cv-state cv-state-clean">CLEAN</span>'), 'infoDensity (5) view: CLEAN priority pill');
    assert.ok(lowView.includes('cv-ev cv-ev-measured">MEASURED</span>'), 'infoDensity (5) view: MEASURED evidence pill');

    assert.ok(lowView.includes(MEASURED_CLEAN_LINE), 'infoDensity (5) view: same clean one-liner on the focused view');
    const upHtml = await paidHtml(app.base, UP_ID);
    const up = cardByHref(upHtml, 'cat-infodensity');
    assert.ok(up.includes('class="cat-card cat-priority"'), 'infoDensity (55): PRIORITY band card class');
    assert.ok(up.includes('<span class="cat-state">PRIORITY</span>'), 'infoDensity (55): priority pill PRIORITY');
    assert.ok(up.includes('<span class="cat-ev cat-ev-measured">MEASURED</span>'), 'infoDensity (55): evidence pill MEASURED at PRIORITY band');
    assert.ok(up.includes('Measurements only'), 'infoDensity (55): Measurements only line');
    assert.ok(up.includes(MEASURED_CONCERN_LINE), 'infoDensity (55): PRIORITY-band MEASURED gets the honest concern copy');
    assert.ok(!up.includes(MEASURED_CLEAN_LINE), 'infoDensity (55): never the CLEAN nothing-found flavor at a concern band');
    assert.ok(!up.includes('cat-ev-findings'), 'infoDensity (55): never FINDINGS — measurements stay neutral at any band');
    const upView = viewSlice(upHtml, 'infodensity');
    assert.ok(upView.includes('cv-state cv-state-priority">PRIORITY</span>'), 'infoDensity (55) view: PRIORITY priority pill');
    assert.ok(upView.includes('cv-ev cv-ev-measured">MEASURED</span>'), 'infoDensity (55) view: MEASURED evidence pill');
    assert.ok(upView.includes(MEASURED_CONCERN_LINE), 'infoDensity (55) view: same concern copy on the focused view');
    // Control in the SAME upper scan: a real-roast category (boilerplate 62)
    // keeps FINDINGS evidence — the two axes never bleed into each other.
    const control = cardByHref(upHtml, 'cat-boilerplate');
    assert.ok(control.includes('<span class="cat-state">PRIORITY</span>'), 'boilerplate (62): PRIORITY priority pill');
    assert.ok(control.includes('<span class="cat-ev cat-ev-findings">FINDINGS</span>'), 'boilerplate (62): FINDINGS evidence pill');
  } finally {
    app.server.close();
  }
});

// ---------------------------------------------------------------------------
// SURFACE: the remaining band boundaries (9/10/24/50/74/100) render their
// exact pill labels on the card; mid-band + real roast keeps both axes
// ---------------------------------------------------------------------------
test('surface: the remaining band boundaries render the exact priority pill and the CLEAN evidence (band-only categories)', async () => {
  const dbPath = tmpDb();
  const BANDS_ID = 's2b-00000000-0000-4000-8000-0000000000b2';
  await insertScan(dbPath, { id: BANDS_ID, breakdown: BANDS_BREAKDOWN, score: 33 });
  const app = startApp(dbPath);
  try {
    const html = await paidHtml(app.base, BANDS_ID);
    // 9 = CLEAN ceiling, 10 = WATCH floor, 24 = WATCH ceiling.
    const clean = cardByHref(html, 'cat-filler');
    assert.ok(clean.includes('<span class="cat-state">CLEAN</span>'), '9 renders CLEAN');
    assert.ok(clean.includes('<span class="cat-ev cat-ev-clean">CLEAN</span>'), '9 renders CLEAN evidence');
    const watchFloor = cardByHref(html, 'cat-boilerplate');
    assert.ok(watchFloor.includes('class="cat-card cat-watch"') && watchFloor.includes('<span class="cat-state">WATCH</span>'),
      '10 renders WATCH (floor)');
    const watchCeil = cardByHref(html, 'cat-infodensity');
    assert.ok(watchCeil.includes('<span class="cat-state">WATCH</span>'), '24 renders WATCH (ceiling)');
    // 50 = PRIORITY floor, 74 = PRIORITY ceiling.
    const prioFloor = cardByHref(html, 'cat-repetitive');
    assert.ok(prioFloor.includes('class="cat-card cat-priority"') && prioFloor.includes('<span class="cat-state">PRIORITY</span>'),
      '50 renders PRIORITY (floor)');
    const prioCeil = cardByHref(html, 'cat-crosspage');
    assert.ok(prioCeil.includes('<span class="cat-state">PRIORITY</span>'), '74 renders PRIORITY (ceiling)');
    // 100 = CRITICAL ceiling.
    const critCeil = cardByHref(html, 'cat-fingerprints');
    assert.ok(critCeil.includes('class="cat-card cat-critical"') && critCeil.includes('<span class="cat-state">CRITICAL</span>'),
      '100 renders CRITICAL (ceiling)');
    // Control inside the SAME report: a mid-band score with a real roast
    // keeps FINDINGS evidence on both axes (assets 12 -> WATCH + FINDINGS).
    const assets = cardByHref(html, 'cat-assets');
    assert.ok(assets.includes('<span class="cat-state">WATCH</span>'), 'assets (12+neg): priority pill WATCH');
    assert.ok(assets.includes('<span class="cat-ev cat-ev-findings">FINDINGS</span>'), 'assets (12+neg): evidence pill FINDINGS');
    const assetsView = viewSlice(html, 'assets');
    assert.ok(assetsView.includes('cv-state cv-state-watch">WATCH</span>'), 'assets view: WATCH priority pill');
    assert.ok(assetsView.includes('cv-ev cv-ev-findings">FINDINGS</span>'), 'assets view: FINDINGS evidence pill');
  } finally {
    app.server.close();
  }
});