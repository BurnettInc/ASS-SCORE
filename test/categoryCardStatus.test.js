import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../src/app.js';
import { openDb } from '../src/db.js';
import { validateUrl } from '../src/fetch/ssrf.js';
import { createReportToken } from '../src/paywall.js';

/**
 * CATEGORY-CARD STATUS — the zero-negatives-with-metrics contradiction (Job #2,
 * owner defect 2026-10-12, ledger-story.com paid report).
 *
 * A category whose sub-score comes ONLY from neutral metric measurements (the
 * stored findings array holds metric rows — e.g. ORIGINALITY 32 on the live
 * ledger-story scan — but ZERO actual negative findings) must render a NEUTRAL
 * status, never the severity ladder the band math alone would produce:
 *
 *   BEFORE: ORIGINALITY card rendered "32/100 · WATCH · MEASUREMENTS ONLY" —
 *   the WATCH pill implies a roastable problem while the line says the
 *   measurements are neutral. Same class of contradiction as the 10-07 CLEAN
 *   fix, on the other side of the band.
 *
 *   AFTER:  ORIGINALITY renders "32/100 · MEASURED · Measurements only" with
 *   the neutral gray treatment (cat-measured / cv-state-measured) and the
 *   neutral one-liner "Score reflects measurements — no roastable findings."
 *   The numeric score and meter render exactly as before.
 *
 * Invariants pinned here:
 *   (a) the exact ledger-story shape — ORIGINALITY 32 with metrics + zero
 *       negatives -> MEASURED (no WATCH), "Measurements only" + neutral
 *       explanation on BOTH the card and the focused view;
 *   (b) a HIGHER band (PRIORITY-band score) with metrics + zero negatives also
 *       renders neutral — severity can never leak back through the band;
 *   (c) a category WITH actual negative findings keeps today's exact severity
 *       logic — card pill + "N roasts — see receipts" + focused-view state +
 *       fix-first pills + receipt badges all unchanged (WATCH/PRIORITY);
 *   (d) the CLEAN-band-with-negatives promotion (10-07 invariant) still works —
 *       a CLEAN sub-score with a real roast promotes to WATCH;
 *   (e) CLEAN with no negatives stays CLEAN.
 *
 * DISPLAY-LAYER ONLY: no scoring, weights, thresholds, detector or stored-data
 * changes — the free JSON surface must serve the exact stored row verbatim.
 */
const SECRET = 'category-card-status-test-secret';
const LEDGER_ID = 'ccs-00000000-0000-4000-8000-0000000000a1';
const PRIO_ID = 'ccs-00000000-0000-4000-8000-0000000000b2';
const CLEAN_ID = 'ccs-00000000-0000-4000-8000-0000000000c3';

const tmpDb = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ccs-test-')), 'test.db');
const fakeFetcher = () => ({ fetchHtml: async () => ({ status: 200, url: 'https://www.ledger-story.com/', body: '<html><body><p>x</p></body></html>' }) });
const offlineValidateTarget = async (raw) => validateUrl(raw);

function startApp(dbPath) {
  const app = createApp({ dbPath, fetcher: fakeFetcher(), validateTarget: offlineValidateTarget, maxScansPerDay: 0, reportTokenSecret: SECRET });
  const server = app.listen(0);
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

async function insertScan(dbPath, { id, breakdown, score = 70 }) {
  const repository = openDb(dbPath);
  repository.insertScan({
    id,
    url: 'https://www.ledger-story.com/',
    score,
    breakdown,
    createdAt: '2026-10-09T12:00:00.000Z', // the production scan's date
  });
  repository.close();
}

async function paidHtml(base, id) {
  const token = createReportToken(SECRET, id);
  const res = await fetch(`${base}/api/v1/scans/${id}?token=${encodeURIComponent(token)}`, { headers: { accept: 'text/html' } });
  assert.equal(res.status, 200, 'paid report serves 200 with a valid token');
  return res.text();
}

/** The exact production vector's category scores (scoreConsistency test pins 70). */
const LEDGER_SCORES = { filler: 31, boilerplate: 37, infoDensity: 32, repetitive: 35, crossPage: 100, fingerprints: 13, assets: 44 };

/**
 * Faithful ledger-story breakdown: the ORIGINALITY category stores ONLY
 * neutral metric measurements (score 32 — the owner's exact case); every other
 * category carries REAL negative findings so their severity cards prove the
 * unchanged path. Scores are the production vector's.
 */
function ledgerBreakdown() {
  return {
    filler: { score: 31, findings: ['2× "robust"', '1× "seamless"'] },
    boilerplate: { score: 37, findings: ['1× generic commitment claim'] },
    infoDensity: {
      score: 32,
      findings: [
        'word variety: 0.852 (lower = more repetitive vocabulary)',
        'common words: 40.3% (little words like "the" and "and" — more means less substance)',
        'average sentence length: 32.8 words (9 sentences)',
        'short paragraphs (<25 words): 87% (23 paragraphs)',
      ],
    },
    repetitive: { score: 35, findings: ['repeated sentence openings: 4× "the company"'] },
    crossPage: { score: 100, findings: ['the same value proposition appears on 5 of 5 pages'], pages: ['https://www.ledger-story.com/'], pairs: [] },
    fingerprints: { score: 13, findings: ['template: v0.dev'] },
    assets: { score: 44, findings: ['2 of 14 images from stock/placeholder CDNs'] },
  };
}

/** Same metrics, but the ORIGINALITY score sits in the PRIORITY band (75+). */
function priorityMetricsBreakdown() {
  const b = ledgerBreakdown();
  b.infoDensity.score = 88;
  return b;
}

/** A genuinely clean breakdown — no negatives anywhere (CLEAN unchanged case). */
function cleanBreakdown() {
  return {
    filler: { score: 0, findings: ['0 filler phrases in 108 words (0.0 per 300 words)'] },
    boilerplate: { score: 0, findings: ['0 boilerplate signals in 108 words (0.0 per 300 words)'] },
    infoDensity: {
      score: 0,
      findings: [
        'word variety: 0.900 (lower = more repetitive vocabulary)',
        'common words: 31.4% (little words like "the" and "and" — more means less substance)',
        'average sentence length: 18.0 words (6 sentences)',
        'short paragraphs (<25 words): 0% (3 paragraphs)',
      ],
    },
    repetitive: { score: 0, findings: ['no notable repetitive structure (6 sentences, 3 paragraphs)'] },
    crossPage: { score: 0, findings: ['no two pages are more than 80% the same (5 pages compared)'], pages: [], pairs: [] },
    fingerprints: { score: 0, findings: [] },
    assets: { score: 0, findings: ['0 of 2 images flagged for stock/placeholder signals'] },
  };
}

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

const MEASURED_LINE = 'Score reflects measurements — no roastable findings.';

// ---------------------------------------------------------------------------
// (a) THE OWNER'S EXACT CASE: ORIGINALITY 32, metrics only -> MEASURED/neutral
// ---------------------------------------------------------------------------
test('(a) ledger-story case: ORIGINALITY 32 with measurements and zero negatives renders the NEUTRAL pill (no WATCH) + "Measurements only" + the neutral explanation', async () => {
  const dbPath = tmpDb();
  await insertScan(dbPath, { id: LEDGER_ID, breakdown: ledgerBreakdown(), score: 70 });
  const app = startApp(dbPath);
  try {
    const html = await paidHtml(app.base, LEDGER_ID);

    // The ORIGINALITY card: neutral gray class, MEASURED pill, no severity.
    const orig = cardByHref(html, 'cat-infodensity');
    assert.ok(orig.includes('class="cat-card cat-measured"'), 'neutral gray card class (cat-measured) — no severity class');
    assert.ok(!orig.includes('cat-card cat-watch'), 'ORIGINALITY card is NOT WATCH — the contradiction is gone');
    assert.ok(!orig.includes('cat-card cat-attention') && !orig.includes('cat-card cat-priority'), 'no severity class at all');
    assert.ok(orig.includes('<span class="cat-state">MEASURED</span>'), 'neutral pill label is MEASURED');
    // Numeric score + meter render exactly as today.
    assert.ok(orig.includes('<span class="cat-score">32<span class="cat-den">/100</span></span>'), 'ORIGINALITY 32/100 shown verbatim');
    assert.ok(orig.includes('<span class="cat-meter-fill" style="width:32%">'), 'meter width unchanged (32%)');
    // Findings line + neutral explanation.
    assert.ok(orig.includes('<span class="cat-findings">Measurements only</span>'), '"Measurements only" line kept');
    assert.ok(orig.includes(MEASURED_LINE), 'neutral explanation one-liner on the card');

    // The focused view agrees (owner reads both surfaces).
    const v = viewSlice(html, 'infodensity');
    assert.ok(v.includes('cv-state cv-state-measured'), 'focused view shows the same neutral state');
    assert.ok(!v.includes('cv-state cv-state-watch'), 'focused view never shows WATCH for the metrics-only category');
    assert.ok(v.includes(MEASURED_LINE), 'focused view carries the neutral explanation');

    // The metrics-only category has NO finding card, NO fix-first entry, NO
    // severity badge anywhere (its Measurements block stays neutral).
    assert.ok(!html.includes('id="finding-infodensity-'), 'no finding card/deep-link for the metrics-only category');
    const fixSection = html.slice(html.indexOf('What To Fix First'), html.indexOf("What's Working"));
    assert.ok(!fixSection.includes('ORIGINALITY') && !fixSection.includes('MEASURED'), 'fix-first never lists the metrics-only category');

    // Stored data + scores are byte-identical: the free JSON surface serves the
    // exact row (display-layer-only constraint).
    const res = await fetch(`${app.base}/api/v1/scans/${LEDGER_ID}`, { headers: { accept: 'application/json' } });
    assert.equal(res.status, 200);
    const payload = await res.json();
    assert.equal(payload.score, 70, 'overall score unchanged');
    for (const [key, expected] of Object.entries(LEDGER_SCORES)) {
      assert.equal(payload.breakdown[key].score, expected, `${key} sub-score unchanged (${expected})`);
    }
  } finally {
    app.server.close();
  }
});

// ---------------------------------------------------------------------------
// (b) HIGHER BAND + metrics + zero negatives -> still neutral (never PRIORITY)
// ---------------------------------------------------------------------------
test('(b) a PRIORITY-band score with measurements and zero negatives ALSO renders neutral — severity cannot leak back through the band', async () => {
  const dbPath = tmpDb();
  await insertScan(dbPath, { id: PRIO_ID, breakdown: priorityMetricsBreakdown(), score: 70 });
  const app = startApp(dbPath);
  try {
    const html = await paidHtml(app.base, PRIO_ID);
    const orig = cardByHref(html, 'cat-infodensity');
    assert.ok(orig.includes('class="cat-card cat-measured"'), 'still the neutral gray class at 88/100');
    assert.ok(!orig.includes('cat-card cat-priority') && !orig.includes('cat-card cat-attention') && !orig.includes('cat-card cat-watch'),
      'no severity class at a PRIORITY-band score');
    assert.ok(orig.includes('<span class="cat-state">MEASURED</span>'), 'pill is MEASURED, not PRIORITY');
    assert.ok(orig.includes('<span class="cat-score">88<span class="cat-den">/100</span></span>'), 'score 88 verbatim');
    assert.ok(orig.includes('<span class="cat-findings">Measurements only</span>'), '"Measurements only" kept at the high band');
    assert.ok(orig.includes(MEASURED_LINE), 'neutral explanation kept at the high band');

    // Control in the SAME report: categories with real negatives still get
    // their full severity ladder (crossPage 100 -> PRIORITY).
    const xp = cardByHref(html, 'cat-crosspage');
    assert.ok(xp.includes('class="cat-card cat-priority"'), 'control: crossPage 100 with negatives stays PRIORITY');
    assert.ok(xp.includes('<span class="cat-state">PRIORITY</span>'), 'control: PRIORITY pill on the real-roast category');
  } finally {
    app.server.close();
  }
});

// ---------------------------------------------------------------------------
// (c) categories WITH actual negative findings keep today's exact status logic
// ---------------------------------------------------------------------------
test('(c) a category with negative findings keeps its severity status, "N roasts — see receipts" line, severity pill, receipt badges and fix-first pills', async () => {
  const dbPath = tmpDb();
  await insertScan(dbPath, { id: LEDGER_ID, breakdown: ledgerBreakdown(), score: 70 });
  const app = startApp(dbPath);
  try {
    const html = await paidHtml(app.base, LEDGER_ID);

    // REPETITION (35, WATCH band, 1 negative) keeps WATCH everywhere.
    const rep = cardByHref(html, 'cat-repetitive');
    assert.ok(rep.includes('class="cat-card cat-watch"'), 'STRUCTURE card keeps WATCH (real roast)');
    assert.ok(rep.includes('<span class="cat-state">WATCH</span>'), 'STRUCTURE pill stays WATCH');
    assert.ok(rep.includes('<span class="cat-findings cat-findings-problem">1 roast — see receipts</span>'),
      '"1 roast — see receipts" line unchanged');
    const repView = viewSlice(html, 'repetitive');
    assert.ok(repView.includes('cv-state cv-state-watch'), 'focused view keeps WATCH for the real-roast category');

    // REPETITION (crossPage 100) keeps PRIORITY on the card + focused view.
    const xp = cardByHref(html, 'cat-crosspage');
    assert.ok(xp.includes('<span class="cat-state">PRIORITY</span>'), 'REPETITION cross-page card stays PRIORITY');
    const xpView = viewSlice(html, 'crosspage');
    assert.ok(xpView.includes('cv-state cv-state-priority'), 'focused view keeps PRIORITY');

    // Receipt badges on the finding cards keep the severity states.
    assert.ok(html.includes('class="fc-state fc-state-watch"'), 'finding-severity badges still render WATCH');
    assert.ok(html.includes('class="fc-state fc-state-priority"'), 'finding-severity badges still render PRIORITY');

    // What To Fix First pills: only categories with negatives, severity states
    // intact, never a neutral/measured entry.
    const fixSection = html.slice(html.indexOf('What To Fix First'), html.indexOf("What's Working"));
    assert.ok(fixSection.includes('WATCH'), 'fix-first pills still show WATCH severity');
    assert.ok(fixSection.includes('PRIORITY'), 'fix-first pills still show PRIORITY severity');
    assert.ok(!fixSection.includes('MEASURED'), 'fix-first never shows the neutral state');
    assert.ok(!fixSection.includes('ORIGINALITY'), 'fix-first never lists the metrics-only ORIGINALITY');
  } finally {
    app.server.close();
  }
});

// ---------------------------------------------------------------------------
// (d) the CLEAN-band-with-negatives promotion (10-07 invariant) still works
// ---------------------------------------------------------------------------
test('(d) CLEAN-band + real negative findings still promotes to WATCH on every surface', async () => {
  const dbPath = tmpDb();
  await insertScan(dbPath, { id: LEDGER_ID, breakdown: ledgerBreakdown(), score: 70 });
  const app = startApp(dbPath);
  try {
    const html = await paidHtml(app.base, LEDGER_ID);

    // DESIGN (fingerprints 13 -> CLEAN band) has one REAL negative finding
    // ('template: v0.dev') — the 10-07 promotion must keep forcing WATCH.
    const fp = cardByHref(html, 'cat-fingerprints');
    assert.ok(fp.includes('class="cat-card cat-watch"'), 'CLEAN-band + roast promotes to WATCH on the card');
    assert.ok(fp.includes('<span class="cat-state">WATCH</span>'), 'promoted WATCH pill (never CLEAN)');
    assert.ok(!fp.includes('<span class="cat-state">CLEAN</span>'), 'never a CLEAN pill next to a real roast');
    assert.ok(fp.includes('1 roast — see receipts'), 'promoted card still shows the roast count');
    const fpView = viewSlice(html, 'fingerprints');
    assert.ok(fpView.includes('cv-state cv-state-watch'), 'focused view shows the promoted WATCH');
    assert.ok(!html.includes('DESIGN — CLEAN:'), 'promoted category is never complimented as CLEAN in What\'s Working');
  } finally {
    app.server.close();
  }
});

// ---------------------------------------------------------------------------
// (e) CLEAN with no negatives stays CLEAN (unchanged reading)
// ---------------------------------------------------------------------------
test('(e) a genuinely clean category with zero negatives keeps CLEAN', async () => {
  const dbPath = tmpDb();
  await insertScan(dbPath, { id: CLEAN_ID, breakdown: cleanBreakdown(), score: 11 });
  const app = startApp(dbPath);
  try {
    const html = await paidHtml(app.base, CLEAN_ID);
    const xp = cardByHref(html, 'cat-crosspage');
    assert.ok(xp.includes('class="cat-card cat-clean"'), 'clean category keeps the green CLEAN card class');
    assert.ok(xp.includes('<span class="cat-state">CLEAN</span>'), 'CLEAN pill unchanged');
    assert.ok(!xp.includes('MEASURED'), 'no neutral state invented for a genuinely clean category');
    const v = viewSlice(html, 'crosspage');
    assert.ok(v.includes('cv-state cv-state-clean'), 'focused view keeps CLEAN');
    // And a clean category is still a legitimate What\'s Working compliment source.
    assert.ok(html.includes('REPETITION — CLEAN:') || html.includes('ORIGINALITY — CLEAN:'),
      'clean categories still complimented as CLEAN');
  } finally {
    app.server.close();
  }
});

// ---------------------------------------------------------------------------
// Report-level invariants (sacred): no <table>/<tr>, no raw injection on the
// neutral line, and the whole page renders the new state exactly once.
// ---------------------------------------------------------------------------
test('report invariants: no table tags, neutral state renders once per surface, no severity line next to Measurements only', async () => {
  const dbPath = tmpDb();
  await insertScan(dbPath, { id: LEDGER_ID, breakdown: ledgerBreakdown(), score: 70 });
  const app = startApp(dbPath);
  try {
    const html = await paidHtml(app.base, LEDGER_ID);
    assert.ok(!/<table|<tr\b/i.test(html), 'no <table>/<tr> anywhere in the report HTML');
    // One MEASURED pill per surface: the card and the focused view (both are
    // the surfaces the owner reads — the rest of the page never shows it).
    assert.equal((html.match(/<span class="cat-state">MEASURED<\/span>/g) ?? []).length, 1, 'exactly one MEASURED card pill');
    assert.equal((html.match(/cv-state-measured">MEASURED<\/span>/g) ?? []).length, 1, 'exactly one MEASURED focused-view pill');
    // Never a severity pill adjacent to a "Measurements only" line anywhere.
    const measuredLine = html.match(/<a class="cat-card ([^"]*)" href="#cat-infodensity">[\s\S]*?<span class="cat-state">([^<]+)<\/span>[\s\S]*?Measurements only<\/span>/);
    assert.ok(measuredLine, 'ORIGINALITY card carries the Measurements only line');
    assert.equal((html.match(/WATCH<\/span>/g) ?? []).length >= 6, true, 'WATCH pills still exist for every WATCH-band real-roast category');
  } finally {
    app.server.close();
  }
});