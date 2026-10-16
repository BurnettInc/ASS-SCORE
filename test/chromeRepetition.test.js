/**
 * Chrome-repetition fix — INVESTIGATION 2026-10-16 (session d1848d58), owner GO.
 *
 * Site chrome — <nav>/<header>/<footer>/<button> — must never register as
 * repeated writing ("Contact" ×4 in the nav bar is a menu, not a template).
 * Two independent mechanisms are locked in here:
 *
 *   1. src/scan.js feeds the repetition family (repetitive rule, crossPage's
 *      in-page phrase detector, boilerplate's dup-block term) a BODY-ONLY
 *      corpus (extractBodyText / extractBodyReadableText) that removes chrome
 *      subtrees BEFORE extraction. Body content stays fully in scope.
 *   2. src/rules/repetitive.js MIN_REPEATED_WORDS = 3 kills 1-2 word repeats
 *      ("Contact", "Home", "Book now") even on the direct rule path.
 *
 * Guardrails proven: real repeated BODY sentences still fire; boilerplate
 * REGEX signals still scan the FULL text so footer cookie/legal/CTA
 * boilerplate keeps counting; crossPage pairwise similarity stays
 * main-content-only (the shared "Contact" chrome never flags a pair).
 *
 * Synthetic fixtures only — no network.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractText, extractBodyText, extractBodyReadableText } from '../src/text.js';
import * as repetitive from '../src/rules/repetitive.js';
import { analyze as analyzeBoilerplate } from '../src/rules/boilerplate.js';
import { analyzeCrossPage } from '../src/rules/crossPage.js';
import { runScan } from '../src/scan.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
/** "Contact" repeated 4× in chrome (nav ×1, button ×1, footer <p> ×2) + one
 *  real repeated body sentence (2×, 10 words). */
const CHROME_PAGE = `<!doctype html>
<html><head><title>Acme Corp</title></head><body>
<header>
  <nav><a>Home</a><a>Contact</a><a>Pricing</a></nav>
  <button>Contact</button>
</header>
<main>
  <p>Our team will double your monthly output within thirty days.</p>
  <p>Our team will double your monthly output within thirty days.</p>
  <p>We also provide a full onboarding session with every plan.</p>
</main>
<footer>
  <p>Contact</p><p>Contact</p>
  <p>© 2026 Acme Corp. All rights reserved.</p>
</footer>
</body></html>`;

const TARGET_URL = 'https://chrome.example/';
/** Fake fetcher: serves the target page, 404s everything discovery might probe. */
const chromeFetcher = {
  fetchHtml: async (raw) =>
    raw === TARGET_URL
      ? { status: 200, url: TARGET_URL, body: CHROME_PAGE, contentType: 'text/html' }
      : { status: 404, url: raw, body: '', contentType: 'text/html' },
};
const stubDb = { insertScan: () => {} };

// ---------------------------------------------------------------------------
// 1. Text layer: body-only extraction strips chrome, full extraction does not
// ---------------------------------------------------------------------------
test('text: extractBodyText/extractBodyReadableText drop nav/header/footer/button subtrees; extractText keeps them', () => {
  const full = extractText(CHROME_PAGE);
  assert.ok(/Contact/.test(full.text), 'full corpus still contains the chrome "Contact" strings');
  assert.ok(/Our team will double your monthly output within thirty days/.test(full.text),
    'full corpus contains the body sentence');

  const body = extractBodyText(CHROME_PAGE);
  assert.ok(!/Contact/i.test(body.text), `body corpus must not contain chrome "Contact": ${body.text}`);
  assert.ok(/Our team will double your monthly output within thirty days/.test(body.text),
    'body corpus keeps the real body copy');
  assert.ok(body.paragraphs.length >= 3, 'body paragraphs survive the strip');
  assert.ok(body.paragraphs.every((p) => !/Contact/i.test(p)), 'no chrome paragraph survives into the corpus');
  assert.ok(body.sentences.length >= 3, 'body sentences survive the strip');
  assert.equal(body.sentences.filter((s) => /Contact/i.test(s)).length, 0, 'no chrome sentence in the corpus');

  const bodyReadable = extractBodyReadableText(CHROME_PAGE);
  assert.ok(!/Contact/i.test(bodyReadable.text), 'body-readable corpus excludes chrome');
  assert.ok(/Our team will double your monthly output within thirty days/.test(bodyReadable.text),
    'body-readable corpus keeps the body copy');
  assert.ok(bodyReadable.sentences.length >= 3, 'readable sentences survive');
});

// ---------------------------------------------------------------------------
// 2. MIN_REPEATED_WORDS: 1-2 word repeats never count
// ---------------------------------------------------------------------------
test('MIN_REPEATED_WORDS: a 1-word repeated sentence never counts', () => {
  const res = repetitive.analyze({ text: 'x', sentences: ['Contact.', 'Contact.', 'Contact.'], paragraphs: [] });
  assert.equal(res.score, 0, JSON.stringify(res));
  assert.deepEqual(res.findings, ['no notable repetitive structure (3 sentences, 0 paragraphs)']);
});

test('MIN_REPEATED_WORDS: 2-word repeated openings never count (sentences shorter than 3 words)', () => {
  const res = repetitive.analyze({
    text: 'x',
    sentences: ['Get started.', 'Get started.', 'Get started.', 'Book now.', 'Book now.', 'Book now.'],
    paragraphs: [],
  });
  assert.equal(res.score, 0, JSON.stringify(res));
  assert.deepEqual(res.findings, ['no notable repetitive structure (6 sentences, 0 paragraphs)']);
});

test('MIN_REPEATED_WORDS: 2-word repeated paragraphs never count', () => {
  const res = repetitive.analyze({
    text: 'x',
    sentences: ['We offer the best service in town.', 'Our pricing is transparent and fair.'],
    paragraphs: ['Book now', 'Book now', 'Book now'],
  });
  assert.equal(res.score, 0, JSON.stringify(res));
  assert.deepEqual(res.findings, ['no notable repetitive structure (2 sentences, 3 paragraphs)']);
});

// ---------------------------------------------------------------------------
// 3. MIN_REPEATED_WORDS: a 3-word repeated phrase DOES count
// ---------------------------------------------------------------------------
test('MIN_REPEATED_WORDS: a 3-word repeated sentence counts (real body repetition is still caught)', () => {
  const res = repetitive.analyze({
    text: 'x',
    sentences: ['Book a call.', 'Book a call.', 'We are happy to help anytime.'],
    paragraphs: [],
  });
  assert.equal(res.score, 40, JSON.stringify(res));
  assert.equal(res.findings[0], 'near-identical sentences: 2× "book a call"');
});

test('MIN_REPEATED_WORDS: a 3-word repeated paragraph counts', () => {
  const res = repetitive.analyze({
    text: 'x',
    sentences: ['Call us today for a free consultation.', 'Browse our full catalog online now.'],
    paragraphs: ['Book a call', 'Book a call', 'Browse our full catalog online now'],
  });
  assert.equal(res.score, 17, JSON.stringify(res));
  // paragraphQuote falls back to the NORMALIZED (lowercased) block text when
  // no readable corpus is passed.
  assert.equal(res.findings[0], 'repeated paragraphs: 2× "book a call"');
});

test('MIN_REPEATED_WORDS: a 3-word repeated opening counts across 6 sentences', () => {
  const res = repetitive.analyze({
    text: 'x',
    sentences: [
      'Book a call with our team today.',
      'Book a call with the sales team.',
      'Book a call on the website.',
      'Book a call about your project.',
      'Book a call at your convenience.',
      'Book a call before the launch.',
    ],
    paragraphs: [],
  });
  // extras 5 / 6 sentences * 220 = 183.3 -> clamped to 100, then * 0.4 = 40.
  assert.equal(res.score, 40, JSON.stringify(res));
  assert.ok(res.findings[0].startsWith('repeated sentence openings: 6×'), res.findings[0]);
  assert.ok(res.findings[0].includes('book a call'), res.findings[0]);
  assert.equal(res.findings.length, 1, 'only the opening finding fires');
});

// ---------------------------------------------------------------------------
// 4. Boilerplate regex signals survive on footer text (full-text path)
// ---------------------------------------------------------------------------
test('boilerplate: regex signals still fire when the matching text lives in a footer (cookie/legal/CTA)', () => {
  const footerish = [
    'We use cookies to improve your experience. Accept all cookies or open Cookie Settings.',
    'Subscribe to our newsletter for monthly updates.',
    '© 2026 Acme Corp. All rights reserved. Read our Privacy Policy and Terms of Service.',
  ].join(' ');
  const res = analyzeBoilerplate({ text: footerish });
  assert.ok(res.score > 0, JSON.stringify(res));
  const joined = res.findings.join('\n');
  for (const label of ['cookie notice', 'cookie banner', 'newsletter subscribe block', 'copyright line', 'privacy policy', 'terms of service']) {
    assert.ok(new RegExp(label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).test(joined), `expected boilerplate signal "${label}" to fire: ${joined}`);
  }
  assert.ok(!res.findings.some((f) => f.startsWith('× repeated block:')), 'footer text is regex-signalled, not dup-blocked, here');
});

// ---------------------------------------------------------------------------
// 5. Scan-level: chrome dups produce ZERO repetition-family findings; the real
//    repeated body sentence still produces findings (the guardrail).
// ---------------------------------------------------------------------------
test('scan: chrome "Contact" dups produce no repetitive/boilerplate-dup/crossPage findings; the body sentence still fires', async () => {
  assert.ok((CHROME_PAGE.match(/Contact/g) ?? []).length >= 4, 'fixture really repeats Contact in chrome');
  const r = await runScan({ db: stubDb, fetcher: chromeFetcher, url: TARGET_URL, scanBudgetMs: 5000 });
  assert.equal(r.ok, true);
  assert.equal(r.payload.crawlFetched, 1, 'single-page synthetic scan');
  const bd = r.payload.breakdown;

  // GUARDRAIL: the real repeated body sentence still produces repetition
  // findings (5+ word sentences are exactly what the fix must preserve).
  const rep = bd.repetitive;
  assert.ok(rep.score > 0, `body repetition must still raise STRUCTURE: ${JSON.stringify(rep)}`);
  const repFindings = rep.findings.join('\n');
  assert.match(repFindings, /near-identical sentences: 2×/, 'near-identical body sentence receipt fires');
  assert.ok(!/Contact/i.test(repFindings), `chrome "Contact" must never appear in repetitive findings: ${repFindings}`);

  // Boilerplate: the footer REGEX signals survive (full-text path); the
  // chrome "Contact" <p>s never become a dup-block (body-only paragraph corpus).
  const bp = bd.boilerplate;
  const bpFindings = bp.findings.join('\n');
  assert.match(bpFindings, /copyright line/, `footer copyright regex must fire: ${bpFindings}`);
  assert.match(bpFindings, /copyright notice/, 'All rights reserved regex fires');
  assert.ok(!/× repeated block: "Contact/i.test(bpFindings), `no "Contact" dup-block: ${bpFindings}`);

  // crossPage: single-page scan — no chrome-driven in-page phrase finding.
  const cp = bd.crossPage;
  const cpFindings = (cp.findings ?? []).join('\n');
  assert.ok(!/Contact/i.test(cpFindings), `crossPage must not report chrome text: ${cpFindings}`);
  assert.ok(!/repeated phrase/i.test(cpFindings), 'no in-page phrase fired from chrome (2× body sentence < 3-occurrence threshold)');
});

// ---------------------------------------------------------------------------
// 6. crossPage pairwise similarity ignores chrome (main-only regression guard)
// ---------------------------------------------------------------------------
const SHARED_CHROME = ['Contact our team five different ways today.'];
const MAIN_A = 'alpha beta gamma delta epsilon'.split(' ');
const MAIN_B = 'one two three four five six seven eight nine ten'.split(' ');

test('crossPage: identical MAIN content still flags a pair (duplication is still caught)', () => {
  const res = analyzeCrossPage({
    pages: [
      { url: 'https://a.example/', main: { words: MAIN_A }, sentences: SHARED_CHROME, paragraphs: SHARED_CHROME, title: 'A' },
      { url: 'https://b.example/', main: { words: MAIN_A }, sentences: SHARED_CHROME, paragraphs: SHARED_CHROME, title: 'B' },
    ],
  });
  assert.ok(res.findings.some((f) => f.startsWith('near-identical page pair:')), JSON.stringify(res.findings));
  assert.ok(res.score >= 100, `identical main -> max pairwise score, got ${res.score}`);
});

test('crossPage: pairwise ignores chrome — identical shared chrome, different main content flags NOTHING', () => {
  const res = analyzeCrossPage({
    pages: [
      { url: 'https://a.example/', main: { words: MAIN_A }, sentences: SHARED_CHROME, paragraphs: SHARED_CHROME, title: 'A' },
      { url: 'https://b.example/', main: { words: MAIN_B }, sentences: SHARED_CHROME, paragraphs: SHARED_CHROME, title: 'B' },
    ],
  });
  assert.ok(!res.findings.some((f) => f.startsWith('near-identical page pair:')), JSON.stringify(res.findings));
  assert.equal(res.score, 0, 'the shared "Contact" chrome sentence must never flag a pair');
});