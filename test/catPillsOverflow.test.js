import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderHtmlReport } from '../src/reportHtml.js';

/**
 * CATEGORY-CARD PILL OVERFLOW — owner-flagged LIVE layout bug (Job #2B
 * follow-up): on the real ledger-story paid report, the REPETITION card
 * (crossPage 100/100, priority pill CRITICAL, evidence pill FINDINGS) renders
 * in .cat-grid's narrowest cell (repeat(auto-fill, minmax(228px, 1fr))). The
 * card's .cat-mid row (score + .cat-pills) had NO wrap, so at the narrowest
 * cell the pill row was wider than the card and the FINDINGS bubble hung off
 * the right edge.
 *
 * FIX (display CSS only — no markup, no scoring, no status logic):
 *   .cat-pills { flex-wrap: wrap; justify-content: flex-end; row-gap: .25rem }
 *   .cat-mid   { min-width: 0 }
 * With flex-wrap: wrap, flex items that don't fit the row's main axis break
 * to the next line (guaranteed by the flexbox spec) — the pills stack and the
 * FINDINGS bubble can no longer hang out of the card. The report HTML is a
 * plain string in src/reportHtml.js, so this regression pins the CSS-in-HTML
 * contract deterministically (no browser): if the wrap declaration or the
 * min-width gets removed, this test fails — exactly what lets the overflow
 * come back.
 */
const VECTOR = { filler: 31, boilerplate: 37, infoDensity: 32, repetitive: 35, crossPage: 100, fingerprints: 13, assets: 44 };

/** Faithful ledger-story breakdown (same fixture as test/categoryCardStatus). */
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

/** The rendered breakdown card for one category (everything inside its <a>). */
function cardByHref(html, anchor) {
  const m = html.match(new RegExp(`<a class="cat-card ([^"]*)" href="#${anchor}">[\\s\\S]*?<\\/a>`));
  assert.ok(m, `card #${anchor} rendered`);
  return m[0];
}

/** The shared report <style> block (the large one, not the mail/share block). */
function reportStyle(html) {
  const start = html.indexOf('<style>');
  const end = html.indexOf('</style>', start);
  assert.ok(start >= 0 && end > start, 'shared <style> block present');
  return html.slice(start + '<style>'.length, end);
}

/** All CSS rules whose selector list contains `name` (e.g. '.cat-pills'). */
function rulesFor(style, name) {
  const rules = [];
  // Coarse-but-deterministic rule split: a rule starts at a selector and ends
  // at its closing brace. The report CSS has no nested blocks, so splitting
  // on '}' is safe. Leading block comments (which can contain commas) are
  // stripped before the selector is read.
  for (const chunk of style.split('}')) {
    const clean = chunk.replace(/\/\*[\s\S]*?\*\//g, ' ');
    const open = clean.lastIndexOf('{');
    if (open === -1) continue;
    const selector = clean.slice(0, open).replace(/\s+/g, ' ').trim();
    if (selector.split(',').some((s) => s.trim() === name)) {
      rules.push(clean.slice(open + 1));
    }
  }
  return rules;
}

function declarations(body) {
  const map = {};
  for (const part of body.split(';')) {
    const i = part.indexOf(':');
    if (i === -1) continue;
    const prop = part.slice(0, i).trim();
    const value = part.slice(i + 1).trim();
    if (prop) map[prop] = value;
  }
  return map;
}

test('cat-card pills wrap: .cat-pills carries flex-wrap + row-gap and .cat-mid carries min-width — the heaviest card (100/100 CRITICAL FINDINGS) can never overflow the 228px cell', () => {
  const html = renderHtmlReport({
    id: 'cat-pills-overflow-0001',
    url: 'https://www.ledger-story.com/',
    score: 70,
    created_at: '2026-10-09T12:00:00.000Z',
    breakdown: ledgerBreakdown(),
  });
  const style = reportStyle(html);

  // (1) The heaviest real card stays intact: 100/100 + CRITICAL + FINDINGS,
  // both pills nested inside the single .cat-pills span (the element that now
  // wraps instead of overflowing).
  const xp = cardByHref(html, 'cat-crosspage');
  assert.ok(xp.includes('<span class="cat-score">100<span class="cat-den">/100</span></span>'), 'crossPage card shows 100/100');
  const pillsMatch = xp.match(/<span class="cat-pills">[\s\S]*?<span class="cat-state">CRITICAL<\/span>[\s\S]*?<span class="cat-ev cat-ev-findings">FINDINGS<\/span>[\s\S]*?<\/span>/);
  assert.ok(pillsMatch, 'CRITICAL + FINDINGS pills sit inside ONE .cat-pills wrapper (the wrap target)');

  // (2) The grid still declares the 228px minimum cell the fix protects (the
  // mobile media-query variant legitimately switches to a single column).
  const gridRules = rulesFor(style, '.cat-grid').map(declarations);
  assert.ok(gridRules.length >= 1, '.cat-grid rule exists');
  assert.ok(gridRules.some((d) => (d['grid-template-columns'] ?? '').includes('minmax(228px, 1fr)')),
    '.cat-grid keeps the 228px narrowest cell');

  // (3) The fix contract, parsed from the ACTIVE rules: .cat-pills must wrap,
  // .cat-mid must be allowed to shrink — and no rule anywhere re-declares
  // flex-wrap: nowrap for .cat-pills (which would resurrect the overflow).
  const pillBodies = rulesFor(style, '.cat-pills');
  assert.ok(pillBodies.length >= 1, '.cat-pills rule exists in the shared style block');
  for (const body of pillBodies) {
    const d = declarations(body);
    assert.equal(d['display'], 'flex', '.cat-pills stays a flex row container');
    assert.equal(d['flex-wrap'], 'wrap', '.cat-pills wraps — pills stack instead of hanging off the card edge');
    assert.equal(d['align-items'], 'baseline', 'baseline alignment kept');
    assert.equal(d['justify-content'], 'flex-end', 'wrapped rows align to the right edge');
    assert.equal(d['row-gap'], '.25rem', 'wrapped pill rows keep their breathing room');
  }
  const midBodies = rulesFor(style, '.cat-mid');
  assert.ok(midBodies.length >= 1, '.cat-mid rule exists in the shared style block');
  for (const body of midBodies) {
    const d = declarations(body);
    assert.equal(d['display'], 'flex', '.cat-mid stays a flex row');
    assert.equal(d['align-items'], 'baseline', 'score baseline alignment kept');
    assert.equal(d['min-width'], '0', '.cat-mid can shrink to the 228px cell (no min-content blowout)');
    assert.equal(d['gap'], '.5rem', 'score-to-pills gap kept');
  }

  // (4) No flex-wrap: nowrap anywhere for the pills (a later override would
  // bring the overflow back even with the base rule in place).
  assert.ok(!/\.cat-pills\s*\{[^}]*flex-wrap\s*:\s*nowrap/i.test(style), 'no nowrap override for .cat-pills');
});

test('cat-pills wrap: a MEASURED card (NEEDS WORK band) also keeps both pills inside the wrap target at the same 228px layout', () => {
  const html = renderHtmlReport({
    id: 'cat-pills-overflow-0002',
    url: 'https://www.ledger-story.com/',
    score: 70,
    created_at: '2026-10-09T12:00:00.000Z',
    breakdown: ledgerBreakdown(),
  });
  // infoDensity 32/100 + NEEDS WORK + MEASURED — the owner's ORIGINALITY case:
  // its two pills must live inside the same wrapping .cat-pills span too.
  const info = cardByHref(html, 'cat-infodensity');
  assert.ok(info.includes('<span class="cat-score">32<span class="cat-den">/100</span></span>'), 'infoDensity card shows 32/100');
  const pillsMatch = info.match(/<span class="cat-pills">[\s\S]*?<span class="cat-state">NEEDS WORK<\/span>[\s\S]*?<span class="cat-ev cat-ev-measured">MEASURED<\/span>[\s\S]*?<\/span>/);
  assert.ok(pillsMatch, 'NEEDS WORK + MEASURED pills sit inside ONE .cat-pills wrapper');
});