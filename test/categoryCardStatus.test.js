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
 * CATEGORY-CARD STATUS — TWO-AXIS display model (Job #2 + Job #2B, owner
 * defect chain 2026-10-07 / 2026-10-12, ledger-story.com paid report).
 *
 * Job #2 (owner defect 2026-10-12) proved that a category whose sub-score
 * comes ONLY from neutral metric measurements (ORIGINALITY 32 on the live
 * ledger-story scan — metrics stored, ZERO actual negative findings) must
 * NEVER render a severity claim — the score band alone would make "32/100 ·
 * WATCH" read like a roastable problem while the line says the measurements
 * are neutral.
 *
 * Job #2B replaces the single fused severity pill with TWO independent axes,
 * so the band and the evidence can no longer lie to each other:
 *
 *   AXIS 1 — PRIORITY pill (src/reportHtml.js categoryPriority): the
 *   score-band label for the sub-score, 0–9 CLEAN, 10–24 WATCH, 25–49
 *   NEEDS WORK, 50–74 PRIORITY, 75–100 CRITICAL. Promotion (10-07
 *   invariant): a REAL negative finding in a CLEAN-band category forces
 *   WATCH so a roast is never labeled CLEAN at the priority axis either.
 *
 *   AXIS 2 — EVIDENCE pill (src/reportHtml.js categoryEvidence): what backs
 *   the score — FINDINGS (actionable negative findings exist; wins over
 *   measurements), MEASURED (only neutral metric measurements — the
 *   ORIGINALITY 32 case), NOT ENOUGH DATA (skipped module: score null, e.g.
 *   crossPage on a single-page scan — never CLEAN), CLEAN (assessed, no
 *   meaningful concern).
 *
 *   AFTER (Job #2B): ORIGINALITY 32 renders "32/100 · NEEDS WORK · MEASURED ·
 *   Measurements only" — the NEEDS WORK pill is a band fact, not a roast
 *   claim, and the MEASURED evidence pill + band-aware one-liner ("Score
 *   comes from generic-content measurements — no single line crossed the
 *   threshold to quote.") carry the honest reading the owner demanded: at a
 *   NEEDS WORK band or worse the line owns the score's concern instead of
 *   dismissing it (owner follow-up: "why no roastable findings at 32?"), and
 *   a CLEAN band (metrics only) gets the nothing-found flavor. Numeric score
 *   and meter render exactly as before.
 *
 * Invariants pinned here:
 *   (a) the exact ledger-story shape — ORIGINALITY 32 with metrics + zero
 *       negatives -> PRIORITY pill NEEDS WORK (band fact) + EVIDENCE pill
 *       MEASURED (never FINDINGS), "Measurements only" + neutral
 *       explanation on BOTH the card and the focused view;
 *   (b) a HIGHER band (88, CRITICAL band) with metrics + zero negatives also
 *       renders MEASURED evidence — the evidence axis never leaks FINDINGS
 *       back through the band;
 *   (c) a category WITH actual negative findings keeps the real status on
 *       both axes — "N roasts — see receipts" + focused-view state +
 *       fix-first pills + receipt badges all keep the severity reading
 *       (NEEDS WORK / CRITICAL / promoted WATCH);
 *   (d) the CLEAN-band-with-negatives promotion (10-07 invariant) still works —
 *       a CLEAN sub-score with a real roast promotes to WATCH on BOTH axes
 *       (priority pill WATCH, evidence pill FINDINGS — never CLEAN);
 *   (e) CLEAN with no negatives stays CLEAN on both axes.
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

/** Same metrics, but the ORIGINALITY score sits in the CRITICAL band (75+). */
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

// Band-aware MEASURED copy (owner follow-up): the NEEDS WORK / CRITICAL band
// keeps the honest "score comes from generic-content measurements" line; the
// CLEAN band (metrics only) gets the nothing-found flavor. Pills stay MEASURED.
const MEASURED_LINE = 'Score comes from generic-content measurements — no single line crossed the threshold to quote.';
const MEASURED_CLEAN_LINE = 'Measurements found nothing to roast here.';
// Two-axis pill markup (Job #2B): priority pill is the score band; the
// evidence pill states what backs the score.
const PRIORITY_NEEDS_WORK = '<span class="cat-state">NEEDS WORK</span>';
const EVIDENCE_MEASURED = '<span class="cat-ev cat-ev-measured">MEASURED</span>';
const EVIDENCE_FINDINGS = '<span class="cat-ev cat-ev-findings">FINDINGS</span>';

// ---------------------------------------------------------------------------
// (a) THE OWNER'S EXACT CASE: ORIGINALITY 32, metrics only -> band NEEDS WORK
//     + evidence MEASURED (never a FINDINGS / roast claim)
// ---------------------------------------------------------------------------
test('(a) ledger-story case: ORIGINALITY 32 with measurements and zero negatives renders the band pill NEEDS WORK + the MEASURED evidence pill (no FINDINGS claim) + "Measurements only" + the neutral explanation', async () => {
  const dbPath = tmpDb();
  await insertScan(dbPath, { id: LEDGER_ID, breakdown: ledgerBreakdown(), score: 70 });
  const app = startApp(dbPath);
  try {
    const html = await paidHtml(app.base, LEDGER_ID);

    // The ORIGINALITY card: band class (cat-needs-work — a band fact, not a
    // roast claim) + MEASURED evidence pill; never a FINDINGS claim.
    const orig = cardByHref(html, 'cat-infodensity');
    assert.ok(orig.includes('class="cat-card cat-needs-work"'), 'priority band class (cat-needs-work) from the 32 sub-score');
    assert.ok(orig.includes(PRIORITY_NEEDS_WORK), 'priority pill is the band label NEEDS WORK');
    assert.ok(orig.includes(EVIDENCE_MEASURED), 'evidence pill is MEASURED (metrics only — the neutral axis)');
    assert.ok(!orig.includes(EVIDENCE_FINDINGS), 'ORIGINALITY card NEVER claims FINDINGS — the contradiction is gone');
    assert.ok(!orig.includes('<span class="cat-state">WATCH</span>') && !orig.includes('<span class="cat-state">PRIORITY</span>')
      && !orig.includes('<span class="cat-state">CRITICAL</span>'), 'no severity-flavored priority pill for the metrics-only category');
    // Numeric score + meter render exactly as today.
    assert.ok(orig.includes('<span class="cat-score">32<span class="cat-den">/100</span></span>'), 'ORIGINALITY 32/100 shown verbatim');
    assert.ok(orig.includes('<span class="cat-meter-fill" style="width:32%">'), 'meter width unchanged (32%)');
    // Findings line + neutral explanation.
    assert.ok(orig.includes('<span class="cat-findings">Measurements only</span>'), '"Measurements only" line kept');
    assert.ok(orig.includes(MEASURED_LINE), 'neutral explanation one-liner on the card');

    // The focused view agrees (owner reads both surfaces): same two axes.
    const v = viewSlice(html, 'infodensity');
    assert.ok(v.includes('cv-state cv-state-needs-work">NEEDS WORK</span>'), 'focused view shows the same band pill (NEEDS WORK)');
    assert.ok(v.includes('cv-ev cv-ev-measured">MEASURED</span>'), 'focused view shows the same MEASURED evidence pill');
    assert.ok(!v.includes('cv-ev cv-ev-findings'), 'focused view never claims FINDINGS for the metrics-only category');
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
// (b) HIGHER BAND + metrics + zero negatives -> evidence stays MEASURED
//     (FINDINGS can never leak back through the band)
// ---------------------------------------------------------------------------
test('(b) an 88 sub-score with measurements and zero negatives keeps the MEASURED evidence pill — FINDINGS never leak back through the band', async () => {
  const dbPath = tmpDb();
  await insertScan(dbPath, { id: PRIO_ID, breakdown: priorityMetricsBreakdown(), score: 70 });
  const app = startApp(dbPath);
  try {
    const html = await paidHtml(app.base, PRIO_ID);
    const orig = cardByHref(html, 'cat-infodensity');
    assert.ok(orig.includes('class="cat-card cat-critical"'), 'priority band class is the band fact cat-critical at 88/100');
    assert.ok(orig.includes('<span class="cat-state">CRITICAL</span>'), 'priority pill is CRITICAL (the band label — a band fact)');
    assert.ok(orig.includes(EVIDENCE_MEASURED), 'evidence pill stays MEASURED at the high band');
    assert.ok(!orig.includes(EVIDENCE_FINDINGS), 'never a FINDINGS evidence claim at a high band with zero negatives');
    assert.ok(orig.includes('<span class="cat-score">88<span class="cat-den">/100</span></span>'), 'score 88 verbatim');
    assert.ok(orig.includes('<span class="cat-findings">Measurements only</span>'), '"Measurements only" kept at the high band');
    assert.ok(orig.includes(MEASURED_LINE), 'neutral explanation kept at the high band');
    const v = viewSlice(html, 'infodensity');
    assert.ok(v.includes('cv-state cv-state-critical">CRITICAL</span>'), 'focused view band pill agrees (CRITICAL)');
    assert.ok(v.includes('cv-ev cv-ev-measured">MEASURED</span>'), 'focused view evidence pill stays MEASURED');
    assert.ok(!v.includes('cv-ev cv-ev-findings'), 'focused view never claims FINDINGS at the high band');

    // Control in the SAME report: categories with real negatives still get
    // their full status on both axes (crossPage 100 -> CRITICAL + FINDINGS).
    const xp = cardByHref(html, 'cat-crosspage');
    assert.ok(xp.includes('class="cat-card cat-critical"'), 'control: crossPage 100 with negatives stays CRITICAL');
    assert.ok(xp.includes('<span class="cat-state">CRITICAL</span>'), 'control: CRITICAL priority pill on the real-roast category');
    assert.ok(xp.includes(EVIDENCE_FINDINGS), 'control: FINDINGS evidence pill on the real-roast category');
  } finally {
    app.server.close();
  }
});

// ---------------------------------------------------------------------------
// (c) categories WITH actual negative findings keep the real status on BOTH
//     axes — "N roasts — see receipts", receipt badges and fix-first pills
// ---------------------------------------------------------------------------
test('(c) a category with negative findings keeps its two-axis status, "N roasts — see receipts" line, receipt badges and fix-first pills', async () => {
  const dbPath = tmpDb();
  await insertScan(dbPath, { id: LEDGER_ID, breakdown: ledgerBreakdown(), score: 70 });
  const app = startApp(dbPath);
  try {
    const html = await paidHtml(app.base, LEDGER_ID);

    // STRUCTURE (35, NEEDS WORK band, 1 negative) keeps NEEDS WORK on both axes.
    const rep = cardByHref(html, 'cat-repetitive');
    assert.ok(rep.includes('class="cat-card cat-needs-work"'), 'STRUCTURE card band class stays cat-needs-work (real roast)');
    assert.ok(rep.includes('<span class="cat-state">NEEDS WORK</span>'), 'STRUCTURE priority pill stays NEEDS WORK');
    assert.ok(rep.includes(EVIDENCE_FINDINGS), 'STRUCTURE evidence pill is FINDINGS (real roast backs the score)');
    assert.ok(rep.includes('<span class="cat-findings cat-findings-problem">1 roast — see receipts</span>'),
      '"1 roast — see receipts" line unchanged');
    const repView = viewSlice(html, 'repetitive');
    assert.ok(repView.includes('cv-state cv-state-needs-work">NEEDS WORK</span>'), 'focused view band pill keeps NEEDS WORK');
    assert.ok(repView.includes('cv-ev cv-ev-findings">FINDINGS</span>'), 'focused view evidence pill keeps FINDINGS');

    // REPETITION (crossPage 100) keeps CRITICAL on the card + focused view.
    const xp = cardByHref(html, 'cat-crosspage');
    assert.ok(xp.includes('class="cat-card cat-critical"'), 'REPETITION cross-page card class stays cat-critical');
    assert.ok(xp.includes('<span class="cat-state">CRITICAL</span>'), 'REPETITION priority pill stays CRITICAL');
    const xpView = viewSlice(html, 'crosspage');
    assert.ok(xpView.includes('cv-state cv-state-critical">CRITICAL</span>'), 'focused view band pill keeps CRITICAL');
    assert.ok(xpView.includes('cv-ev cv-ev-findings">FINDINGS</span>'), 'focused view evidence pill keeps FINDINGS');

    // DESIGN (fingerprints 13, CLEAN band + real roast) — the 10-07 promotion
    // keeps WATCH on the priority axis (its card pill + focused pill).
    const fp = cardByHref(html, 'cat-fingerprints');
    assert.ok(fp.includes('<span class="cat-state">WATCH</span>'), 'promoted DESIGN card keeps the WATCH priority pill');
    assert.ok(fp.includes(EVIDENCE_FINDINGS), 'promoted DESIGN card evidence is FINDINGS (real roast)');

    // Receipt badges on the finding cards keep the severity states.
    assert.ok(html.includes('class="fc-state fc-state-watch"'), 'finding-severity badges still render WATCH (promoted DESIGN)');
    assert.ok(html.includes('class="fc-state fc-state-needs-work"'), 'finding-severity badges render NEEDS WORK');
    assert.ok(html.includes('class="fc-state fc-state-critical"'), 'finding-severity badges still render CRITICAL');

    // What To Fix First pills: only categories with negatives, severity-band
    // states intact, never a neutral/measured entry.
    const fixSection = html.slice(html.indexOf('What To Fix First'), html.indexOf("What's Working"));
    assert.ok(fixSection.includes('>CRITICAL<'), 'fix-first pills still show the CRITICAL band');
    assert.ok(fixSection.includes('>NEEDS WORK<'), 'fix-first pills still show the NEEDS WORK band');
    assert.ok(!fixSection.includes('MEASURED'), 'fix-first never shows the neutral state');
    assert.ok(!fixSection.includes('ORIGINALITY'), 'fix-first never lists the metrics-only ORIGINALITY');
  } finally {
    app.server.close();
  }
});

// ---------------------------------------------------------------------------
// (d) the CLEAN-band-with-negatives promotion (10-07 invariant) still works
// ---------------------------------------------------------------------------
test('(d) CLEAN-band + real negative findings still promotes to WATCH on both axes of every surface', async () => {
  const dbPath = tmpDb();
  await insertScan(dbPath, { id: LEDGER_ID, breakdown: ledgerBreakdown(), score: 70 });
  const app = startApp(dbPath);
  try {
    const html = await paidHtml(app.base, LEDGER_ID);

    // DESIGN (fingerprints 13 -> CLEAN band) has one REAL negative finding
    // ('template: v0.dev') — the 10-07 promotion must keep forcing WATCH.
    const fp = cardByHref(html, 'cat-fingerprints');
    assert.ok(fp.includes('class="cat-card cat-watch"'), 'CLEAN-band + roast promotes to WATCH on the card');
    assert.ok(fp.includes('<span class="cat-state">WATCH</span>'), 'promoted WATCH priority pill (never CLEAN)');
    assert.ok(fp.includes(EVIDENCE_FINDINGS), 'promoted card evidence is FINDINGS (the real roast)');
    assert.ok(!fp.includes('<span class="cat-state">CLEAN</span>'), 'never a CLEAN priority pill next to a real roast');
    assert.ok(!fp.includes('cat-ev-clean">CLEAN'), 'never a CLEAN evidence pill next to a real roast');
    assert.ok(fp.includes('1 roast — see receipts'), 'promoted card still shows the roast count');
    const fpView = viewSlice(html, 'fingerprints');
    assert.ok(fpView.includes('cv-state cv-state-watch">WATCH</span>'), 'focused view shows the promoted WATCH priority pill');
    assert.ok(fpView.includes('cv-ev cv-ev-findings">FINDINGS</span>'), 'focused view evidence is FINDINGS');
    assert.ok(!html.includes('DESIGN — CLEAN:'), 'promoted category is never complimented as CLEAN in What\'s Working');
  } finally {
    app.server.close();
  }
});

// ---------------------------------------------------------------------------
// (e) CLEAN with no negatives stays CLEAN on both axes (unchanged reading)
// ---------------------------------------------------------------------------
test('(e) a genuinely clean category with zero negatives keeps CLEAN on both axes', async () => {
  const dbPath = tmpDb();
  await insertScan(dbPath, { id: CLEAN_ID, breakdown: cleanBreakdown(), score: 11 });
  const app = startApp(dbPath);
  try {
    const html = await paidHtml(app.base, CLEAN_ID);
    const xp = cardByHref(html, 'cat-crosspage');
    assert.ok(xp.includes('class="cat-card cat-clean"'), 'clean category keeps the green CLEAN card class');
    assert.ok(xp.includes('<span class="cat-state">CLEAN</span>'), 'CLEAN priority pill unchanged');
    assert.ok(xp.includes('cat-ev cat-ev-clean">CLEAN</span>'), 'CLEAN evidence pill unchanged (assessed, nothing found)');
    assert.ok(!xp.includes('MEASURED'), 'no neutral state invented for a genuinely clean category');
    assert.ok(!xp.includes('NOT ENOUGH DATA'), 'an assessed clean category is not "not enough data"');
    const v = viewSlice(html, 'crosspage');
    assert.ok(v.includes('cv-state cv-state-clean">CLEAN</span>'), 'focused view priority pill keeps CLEAN');
    assert.ok(v.includes('cv-ev cv-ev-clean">CLEAN</span>'), 'focused view evidence pill keeps CLEAN');
    // And a clean category is still a legitimate What\'s Working compliment source.
    assert.ok(html.includes('REPETITION — CLEAN:') || html.includes('ORIGINALITY — CLEAN:'),
      'clean categories still complimented as CLEAN');
  } finally {
    app.server.close();
  }
});

// ---------------------------------------------------------------------------
// Report-level invariants (sacred): no <table>/<tr>, no raw injection on the
// neutral line, and every evidence pill renders exactly once per surface.
// ---------------------------------------------------------------------------
test('report invariants: no table tags, evidence pills render once per surface, no FINDINGS claim next to Measurements only', async () => {
  const dbPath = tmpDb();
  await insertScan(dbPath, { id: LEDGER_ID, breakdown: ledgerBreakdown(), score: 70 });
  const app = startApp(dbPath);
  try {
    const html = await paidHtml(app.base, LEDGER_ID);
    assert.ok(!/<table|<tr\b/i.test(html), 'no <table>/<tr> anywhere in the report HTML');
    // One MEASURED evidence pill per surface: the card and the focused view
    // (both are the surfaces the owner reads — the rest of the page never
    // shows it; the priority axis shows the band fact instead).
    assert.equal((html.match(/cat-ev cat-ev-measured">MEASURED<\/span>/g) ?? []).length, 1, 'exactly one MEASURED card evidence pill');
    assert.equal((html.match(/cv-ev cv-ev-measured">MEASURED<\/span>/g) ?? []).length, 1, 'exactly one MEASURED focused-view evidence pill');
    // Never a FINDINGS evidence claim adjacent to a "Measurements only" line
    // anywhere: the ORIGINALITY card's ev pill is MEASURED.
    const measuredCard = html.match(/<a class="cat-card ([^"]*)" href="#cat-infodensity">[\s\S]*?<span class="cat-ev cat-ev-[a-z-]+">([^<]+)<\/span>/);
    assert.ok(measuredCard, 'ORIGINALITY card carries an evidence pill');
    assert.equal(measuredCard[2], 'MEASURED', 'the evidence pill next to "Measurements only" is MEASURED, never FINDINGS');
    // The promoted WATCH still renders on all three surfaces it belongs to:
    // DESIGN card pill, DESIGN focused-view pill, DESIGN receipt badge.
    assert.equal((html.match(/>WATCH<\/span>/g) ?? []).length >= 3, true, 'promoted WATCH pill renders on card + focused view + receipt badge');
  } finally {
    app.server.close();
  }
});