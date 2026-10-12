import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeSlopScore } from '../src/scorer.js';
import { renderHtmlReport } from '../src/reportHtml.js';

/**
 * "WHY THIS SCORE?" (Job 1B, owner spec 2026-10-12) — the compact
 * explainer under the hero score:
 *
 *   scorer: computeSlopScore now returns `preRoundTotal` (weighted total
 *   BEFORE credits) and `credits` (only the credits that ACTUALLY applied,
 *   each with a plain-English reason) alongside the unchanged
 *   `{slopScore, components}`. The renderer derives EVERY number it shows
 *   from those returned values — it never re-implements a credit gate.
 *
 *   Ledger-story anchor (same vector as test/scoreConsistency.test.js, which
 *   stays the ground truth): {filler:31, boilerplate:37, infoDensity:32,
 *   repetitive:35, crossPage:100, fingerprints:13, assets:44} ->
 *   preRoundTotal 52.45, C2 credit +18 (k=7, all categories >= 10), no C1
 *   (32 < 45, 13 < 15) -> 52.45 + 18 = 70.45 -> single Math.round -> 70
 *   (clamp no-op). The hero's big number stays the STORED score (scan.score);
 *   the calculation block's final line presents the stored score too (the
 *   scorer's slopScore is shown only when it equals it — they agree here).
 */

const cat = (scores) =>
  Object.fromEntries(
    Object.entries(scores).map(([k, v]) => [k, Number.isFinite(v) ? { score: v } : { score: null, findings: [], note: 'insufficient pages for cross-page analysis' }]),
  );

const VECTOR = { filler: 31, boilerplate: 37, infoDensity: 32, repetitive: 35, crossPage: 100, fingerprints: 13, assets: 44 };
const SCORE = 70;
const NO_CREDIT = { filler: 0, boilerplate: 0, infoDensity: 0, repetitive: 0, crossPage: 5, fingerprints: 0, assets: 0 };
const STACK = { filler: 10, boilerplate: 10, infoDensity: 45, repetitive: 10, crossPage: 80, fingerprints: 15, assets: 10 }; // 36.75 + 4 + 18 = 58.75 -> 59

/** Build a report-shaped scan row (same shape the routes pass to renderHtmlReport). */
function scanRow({ id = 'score-explain-0001', url = 'https://fixture.example/', score, breakDown }) {
  return { id, url, score, created_at: '2026-10-12T00:00:00.000Z', breakdown: breakDown };
}

// ---------------------------------------------------------------------------
// 1. LEDGER STORY: scorer exposes 52.45 / C2(+18) / 70
// ---------------------------------------------------------------------------

test('ledger-story scorer: preRoundTotal ~= 52.45, credits == [C2 +18], slopScore 70', () => {
  const r = computeSlopScore(cat(VECTOR));
  assert.ok(Math.abs(r.preRoundTotal - 52.45) < 1e-9, `pre-round weighted total is 52.45 (got ${r.preRoundTotal})`);
  assert.equal(r.credits.length, 1, 'exactly one credit applies to the ledger vector');
  assert.equal(r.credits[0].id, 'C2');
  assert.equal(r.credits[0].amount, 18);
  // C1 does NOT fire (infoDensity 32 < 45, fingerprints 13 < 15) — no C1 row.
  assert.ok(!r.credits.some((c) => c.id === 'C1'), 'C1 never renders because it never fired');
  assert.ok(r.credits[0].reason.includes('Corroborated duplication'), 'C2 reason is the plain-English duplicate-proof line');
  assert.ok(r.credits[0].reason.includes('+3 × (7−1) = +18'), 'C2 reason reflects the real k=7 math');
  assert.equal(r.slopScore, SCORE, '52.45 + 18 = 70.45 -> Math.round -> 70');
  assert.equal(Math.round(r.preRoundTotal + r.credits[0].amount), SCORE, 'round(preRoundTotal + creditSum) === the scorer final');
});

test('ledger-story report: block renders Why/ThisScore, 52.45, the +18 credit + reason, 70.45, final 70', () => {
  const html = renderHtmlReport(scanRow({ score: SCORE, breakDown: cat(VECTOR) }));
  assert.ok(html.includes('<summary>Why this score?</summary>'), 'compact label renders');
  assert.ok(html.includes('View score calculation'), 'the expandable calculation label renders');
  assert.ok(html.includes('52.45'), 'weighted category total renders');
  assert.ok(html.includes('+18'), 'the +18 credit amount renders');
  assert.ok(html.includes('Corroborated duplication: 7 of 7 categories are elevated'), 'the C2 plain-English reason renders');
  assert.ok(html.includes('70.45'), 'pre-round total (weighted + credits) renders');
  assert.ok(html.includes('<dd>70</dd>'), 'final score row displays 70');
  assert.ok(html.includes('Score = round(weighted total + credits), clamped 0–100.'), 'the one-line rounding note renders');
  assert.ok(!html.includes('No scoring credits applied.'), 'credits DID apply here — the no-credit line must not render');
  assert.ok(!html.includes('Credit C1'), 'no C1 row for a vector where C1 never fired');
});

// ---------------------------------------------------------------------------
// 2. NO-CREDIT CASE
// ---------------------------------------------------------------------------

test('no-credit scorer: clean multi-page vector -> preRoundTotal 1.5, credits [], final 2', () => {
  const r = computeSlopScore(cat(NO_CREDIT));
  assert.equal(r.credits.length, 0, 'no credit applies when every gate is shut');
  assert.ok(Math.abs(r.preRoundTotal - 1.5) < 1e-9, `pre-round weighted total is 1.5 (got ${r.preRoundTotal})`);
  assert.equal(r.slopScore, 2, 'Math.round(1.5) === 2');
});

test('no-credit report: block says no credits applied and shows weighted total -> final = stored score', () => {
  const stored = computeSlopScore(cat(NO_CREDIT)).slopScore; // the scan row would store 2
  const html = renderHtmlReport(scanRow({ score: stored, breakDown: cat(NO_CREDIT) }));
  assert.ok(html.includes('<summary>Why this score?</summary>'), 'block still renders for a clean breakdown');
  assert.ok(html.includes('1.50'), 'weighted category total renders');
  assert.ok(html.includes('No scoring credits applied.'), 'the no-credit line renders');
  assert.ok(html.includes(`<dd>${stored}</dd>`), 'final score row displays the stored score (2)');
  assert.ok(html.includes('Score = round(weighted total + credits), clamped 0–100.'), 'the rounding note renders');
  assert.ok(!html.includes('Credit C'), 'no credit row of any kind when none applied');
});

// ---------------------------------------------------------------------------
// 3. ROUNDING: the known .5 case — 36.75 + 4 + 18 = 58.75 -> 59
// ---------------------------------------------------------------------------

test('rounding: stack vector 36.75 + 4 (C1) + 18 (C2) = 58.75 -> rendered final 59, nothing off-by-one', () => {
  const r = computeSlopScore(cat(STACK));
  assert.ok(Math.abs(r.preRoundTotal - 36.75) < 1e-9, `pre-round is 36.75 (got ${r.preRoundTotal})`);
  const creditSum = r.credits.reduce((s, c) => s + c.amount, 0);
  assert.equal(creditSum, 22, 'C1 +4 and C2 +18 both applied');
  assert.equal(Math.round(r.preRoundTotal + creditSum), 59, '58.75 rounds to 59 — the exact .5 case must not drift');
  assert.equal(r.slopScore, 59, 'scorer final agrees');

  const html = renderHtmlReport(scanRow({ score: 59, breakDown: cat(STACK) }));
  assert.ok(html.includes('58.75'), 'pre-round total (weighted + credits) displays 58.75');
  assert.ok(html.includes('<dd>59</dd>'), 'displayed final is Math.round(58.75) = 59 — not 58, not 60');
  assert.ok(html.includes('Credit C1') && html.includes('Credit C2'), 'BOTH applied credits render (C1 and C2)');
});

// ---------------------------------------------------------------------------
// 4. CONSISTENCY: stored score == scorer slopScore == what the block displays
// ---------------------------------------------------------------------------

test('consistency: ledger stored score (70) == scorer slopScore == rendered final; hero still shows stored 70', () => {
  const html = renderHtmlReport(scanRow({ score: SCORE, breakDown: cat(VECTOR) }));
  // The hero's big number is UNTOUCHED by the explainer — stored score verbatim.
  assert.ok(html.includes('<span class="hero-val">70</span>'), 'hero big number is still the stored 70');
  assert.ok(html.includes('<p class="score">A.S.S. Score: 70 / 100</p>'), 'hero score line still the stored 70');
  // The explainer's final row and the hero agree (both present the stored score).
  assert.ok(html.includes('<dd>70</dd>'), 'explainer final row displays 70 == stored score == scorer slopScore');
});

// ---------------------------------------------------------------------------
// 5. LEGACY SAFETY: no breakdown / empty breakdown -> exactly as today
// ---------------------------------------------------------------------------

test('legacy: scans with no breakdown or an empty breakdown render without the block and without throwing', () => {
  for (const breakdown of [undefined, {}]) {
    const html = renderHtmlReport(scanRow({ score: 13, breakDown: breakdown }));
    assert.equal(typeof html, 'string');
    // The explainer's static CSS lives in the shared <style> block, so assert on
    // the DYNAMIC markup (the details/summary the renderer would inject) — a
    // legacy render must contain none of it.
    assert.ok(!html.includes('<details class="score-explain"'), 'no explainer details element for legacy scans');
    assert.ok(!html.includes('<summary>Why this score?</summary>'), 'no explainer summary label for legacy scans');
    assert.ok(!html.includes('View score calculation'), 'no calculation expander');
  }
});