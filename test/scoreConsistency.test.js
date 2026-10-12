import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { computeSlopScore } from '../src/scorer.js';
import { createApp } from '../src/app.js';
import { validateUrl } from '../src/fetch/ssrf.js';
import { openDb } from '../src/db.js';
import { verdictLabel } from '../src/verdict.js';

/**
 * SCORING-CONSISTENCY REGRESSION (live 2026-10-12) — pins that the displayed
 * overall A.S.S. Score can NEVER drift apart from the displayed category
 * scores, using the OWNER's live production case:
 *
 *   scan 4ac4ac5e-027d-4824-9eed-40209d42a1ae (https://www.ledger-story.com/,
 *   created 2026-10-09, crawl 5/5) — stored score 70, breakdown
 *   {filler:31, boilerplate:37, infoDensity:32, repetitive:35, crossPage:100,
 *    fingerprints:13, assets:44}.
 *
 * WHY 70 (proven through the REAL computeSlopScore in src/scorer.js): the
 * overall is NOT the plain weighted average of the category scores (that would
 * be 52.45 -> 52). Phase-2 additive credits (owner-approved 2026-10-05) apply
 * on top of the PRE-ROUND weighted total:
 *   - C1 template-stack: +4 when infoDensity >= 45 AND fingerprints >= 15 ->
 *     NOT here (infoDensity 32, fingerprints 13).
 *   - C2 corroborated duplication: +3*(k-1) when crossPage >= 80, k = number
 *     of the 7 categories with score >= 10 (crossPage's own score included),
 *     capped +18. Here crossPage = 100 >= 80 and ALL SEVEN categories are
 *     >= 10 -> k=7 -> +3*6 = +18.
 *   52.45 + 18 = 70.45 -> single Math.round -> 70. Clamp 0-100 (no-op).
 *   Verdict band 70-79 = EXTREMELY ASSY.
 *
 * The report page renders BOTH the overall and the category cards from this
 * single stored row (src/reportHtml.js reads scan.score and scan.breakdown),
 * so same-scan/same-version is structurally guaranteed; the stored-row test
 * below pins that the NUMBERS themselves cannot drift apart (the free JSON
 * surface serves score + breakdown from the same row, and recomputing the
 * real scorer over the served breakdown must equal the served score).
 *
 * TEST-ONLY: no weights, thresholds, detectors, verdict bands, rounding or
 * production changes.
 */
const VECTOR = { filler: 31, boilerplate: 37, infoDensity: 32, repetitive: 35, crossPage: 100, fingerprints: 13, assets: 44 };
const SCORE = 70;
const LEDGER_ID = '4ac4ac5e-027d-4824-9eed-40209d42a1ae';
const LEDGER_URL = 'https://www.ledger-story.com/';

/** Convert a raw score map to the breakdown shape computeSlopScore expects. */
const cat = (scores) =>
  Object.fromEntries(
    Object.entries(scores).map(([k, v]) => [k, Number.isFinite(v) ? { score: v } : { score: null, findings: [], note: 'insufficient pages for cross-page analysis' }]),
  );

const composite = (scores) => computeSlopScore(cat(scores)).slopScore;

/** Pre-round weighted total (the number the phase-2 credits are added to). */
const preRound = (scores) =>
  Object.values(computeSlopScore(cat(scores)).components).reduce((s, c) => s + c.weighted, 0);

// ---------------------------------------------------------------------------
// 1. THE PRODUCTION VECTOR (ledger-story.com, scan 4ac4ac5e) -> 70
// ---------------------------------------------------------------------------

test('ledger-story anchor: the exact production vector scores 70 through the real computeSlopScore', () => {
  const { slopScore, components } = computeSlopScore(cat(VECTOR));
  assert.equal(slopScore, SCORE, 'computeSlopScore({filler:31, boilerplate:37, infoDensity:32, repetitive:35, crossPage:100, fingerprints:13, assets:44}).slopScore === 70');
  // Sanity on the inputs themselves: crossPage is fully weighted (its 0.30 is
  // the largest single weight) and the phase-3 seven-category table is in use.
  assert.equal(components.crossPage.weight, 0.3, 'multi-page branch: crossPage weight 0.30');
  assert.equal(components.crossPage.weighted, 30, '0.30 * 100 = 30 — the dominant term');
  assert.equal(verdictLabel(slopScore), 'EXTREMELY ASSY', '70 sits in the 70-79 EXTREMELY ASSY band (single verdict source)');
});

// ---------------------------------------------------------------------------
// 2. EXPLICIT DECOMPOSITION: 70 == Math.round(52.45 + 0 + 18)
// ---------------------------------------------------------------------------

test('decomposition: pre-round 52.45, C1 credit 0, C2 credit 18 (k=7) -> Math.round(70.45) == 70 == computeSlopScore', () => {
  // Pre-round weighted total straight from the real components (the number the
  // phase-2 credits are added to — NOT the plain average of the categories).
  const pre = preRound(VECTOR);
  assert.ok(Math.abs(pre - 52.45) < 1e-9, `pre-round weighted total is 52.45 (got ${pre})`);

  // Independent re-expression of the phase-2 credit spec with the SAME literal
  // constants as src/scorer.js — a change to EITHER side fails this test.
  const C1_INFO_DENSITY_BAR = 45;
  const C1_FINGERPRINTS_BAR = 15;
  const c1 = VECTOR.infoDensity >= C1_INFO_DENSITY_BAR && VECTOR.fingerprints >= C1_FINGERPRINTS_BAR ? 4 : 0;
  assert.equal(c1, 0, 'C1 does not fire (infoDensity 32 < 45; fingerprints 13 < 15)');

  const CATS = ['filler', 'boilerplate', 'infoDensity', 'repetitive', 'crossPage', 'fingerprints', 'assets'];
  const c2GateHolds = VECTOR.crossPage >= 80;
  assert.ok(c2GateHolds, 'crossPage 100 >= 80 — the C2 gate fires');
  const k = CATS.filter((key) => VECTOR[key] >= 10).length;
  assert.equal(k, 7, 'ALL SEVEN categories are >= 10 (crossPage itself included)');
  const c2 = c2GateHolds ? Math.min(18, 3 * (k - 1)) : 0;
  assert.equal(c2, 18, 'C2 = 3*(7-1) = 18 (at the cap)');

  // The composite IS Math.round(pre-round + credits), then clamp (no-op).
  assert.equal(Math.round(pre + c1 + c2), SCORE, 'Math.round(52.45 + 0 + 18) === 70');
  assert.equal(composite(VECTOR), Math.round(pre + c1 + c2), 'computeSlopScore agrees with the recomputed composite');
  // And it is NOT the plain average: 52.45 rounds to 52, not 70.
  assert.notEqual(Math.round(pre), SCORE, 'the plain weighted average would be 52 — the 18-credit gap is the whole story');
});

// ---------------------------------------------------------------------------
// 3. STORED-ROW CONSISTENCY: the free JSON surface can never show an overall
//    that disagrees with the category cards (same single stored row)
// ---------------------------------------------------------------------------

const SECRET = 'score-consistency-test-secret';
const tmpDb = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'score-consistency-test-')), 'test.db');
const fakeFetcher = () => ({ fetchHtml: async () => ({ status: 200, url: LEDGER_URL, body: '<html><body><p>x</p></body></html>' }) });
const offlineValidateTarget = async (raw) => validateUrl(raw);

function startApp(dbPath) {
  const app = createApp({ dbPath, fetcher: fakeFetcher(), validateTarget: offlineValidateTarget, maxScansPerDay: 0, reportTokenSecret: SECRET });
  const server = app.listen(0);
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

function insertLedgerRow(dbPath) {
  const repository = openDb(dbPath);
  repository.insertScan({
    id: LEDGER_ID,
    url: LEDGER_URL,
    score: SCORE,
    breakdown: Object.fromEntries(Object.entries(VECTOR).map(([k, v]) => [k, { score: v }])),
    createdAt: '2026-10-09T12:00:00.000Z', // the production scan's date
  });
  repository.close();
}

test('stored row: GET /api/v1/scans/:id returns score 70 AND the exact breakdown, and computeSlopScore(breakdown) == the returned score', async () => {
  const dbPath = tmpDb();
  insertLedgerRow(dbPath);
  const app = startApp(dbPath);
  try {
    const res = await fetch(`${app.base}/api/v1/scans/${LEDGER_ID}`, { headers: { accept: 'application/json' } });
    assert.equal(res.status, 200, 'free JSON route serves the stored row');
    const payload = await res.json();

    // The overall card reads the stored score verbatim.
    assert.equal(payload.id, LEDGER_ID);
    assert.equal(payload.score, SCORE, 'stored overall score is served verbatim');
    assert.equal(payload.verdict, verdictLabel(SCORE), 'verdict comes from the single verdict source (EXTREMELY ASSY)');

    // Every category card matches the stored breakdown exactly.
    for (const [key, expected] of Object.entries(VECTOR)) {
      assert.equal(payload.breakdown[key].score, expected, `${key} category card matches the stored breakdown`);
    }

    // THE invariant: recomputing the REAL scorer over the SERVED breakdown
    // must equal the SERVED overall — the displayed numbers cannot drift.
    const recomputed = computeSlopScore(payload.breakdown).slopScore;
    assert.equal(recomputed, payload.score, 'the displayed overall can never disagree with the displayed category scores under the current scorer');
    assert.equal(recomputed, SCORE, 'and both are 70');
  } finally {
    app.server.close();
  }
});

// ---------------------------------------------------------------------------
// 4. BOUNDARY GUARD: the 70 specifically depends on the crossPage >= 80 gate
// ---------------------------------------------------------------------------

test('boundary: same vector with crossPage 79 gets NO C2 credit — 70 depends on the >= 80 gate firing', () => {
  const justBelow = { ...VECTOR, crossPage: 79 };
  const pre = preRound(justBelow);
  assert.ok(Math.abs(pre - 46.15) < 1e-9, `crossPage 79 pre-round total is 46.15 (got ${pre})`);
  assert.equal(Math.round(pre), 46, 'sanity: 46.15 rounds to 46');
  // The gate is shut: the composite equals Math.round(preRound) with NO +18.
  assert.equal(composite(justBelow), Math.round(pre), 'composite == Math.round(preRound) — no C2 credit at crossPage 79');
  // And with the credit it would be 64 — explicit proof the +18 is absent.
  assert.equal(Math.round(pre) + 18, 64);
  assert.notEqual(composite(justBelow), Math.round(pre) + 18, 'the +18 C2 credit is NOT applied below the gate');
  // C1 still cannot fire on this vector (infoDensity 32 < 45, fingerprints 13 < 15).
  assert.equal(composite(justBelow), 46, 'final: crossPage 79 -> 46, crossPage 100 -> 70 — the 24-point gap is the gate semantics');
});