import { Router } from 'express';
import { clientIp } from '../clientIp.js';

/**
 * Silent homepage-view beacon — POST /api/v1/track.
 *
 * The site fires this once per page load after hydration (client-only, never
 * visible, never logged by the site). This route records one row in
 * `page_views` per REAL human browser hit and answers 204 on every
 * non-error outcome so a beacon failure can never break the page:
 *
 *   - Missing / empty path          -> 204 (not a beacon hit at all, no record)
 *   - Empty / missing UA            -> 204 + bot_hits row (reason 'empty_ua')
 *   - webdriver:true beacon flag    -> 204 + bot_hits row (reason 'webdriver')
 *   - Known bot/crawler UA          -> 204 + bot_hits row (reason 'ua:<pattern>',
 *     substring match, case-insensitive)
 *   - Same IP within 30s            -> 204 + bot_hits row (reason 'dedup')
 *   - Success                       -> 204 (silent — the site never reads a body)
 *   - Anything throws               -> 204 (try/catch wrapper)
 *
 * BOT LEDGER (owner 2026-10-10): every dropped hit is recorded in `bot_hits`
 * (ip, ua, path, ref, reason) BEFORE the dedup check — a bot burst records
 * every single hit, and the 30s dedup only ever applies to human views (the
 * deduped repeat is itself recorded as reason 'dedup'). This is what lets the
 * admin stats PROVE the views ledger is humans-only: bots blocked total/today,
 * a daily bots line next to the views line, and the latest 20 with reasons.
 *
 * The in-memory dedup map is the same style as the scanner's per-IP rate
 * limits (single-process synchronous = race-free): keyed by the exact client
 * IP derivation the ledgers use (src/clientIp.js —
 * req.ip behind the trust-proxy edge), never by forwarded strings we invent.
 */
const BOT_PATTERNS = [
  // Classic crawlers / link expanders / CLI tools (unchanged from v1).
  'googlebot', 'bingbot', 'baiduspider', 'baidu', 'yandex', 'duckduckbot', 'slurp',
  'facebookexternalhit', 'facebookbot', 'twitterbot', 'linkedinbot', 'discordbot', 'slackbot',
  'telegrambot', 'whatsapp', 'curl/', 'wget', 'python-requests',
  'go-http-client', 'headlesschrome', 'phantomjs',
  // Modern SEO / uptime / verification crawlers (owner 2026-10-10). Lowercase
  // substrings on purpose; full tokens only — never a bare 'bot'.
  'ahrefsbot', 'semrushbot', 'petalbot', 'mj12bot', 'dotbot', 'uptimerobot',
  'pingdom', 'statuscake', 'google-inspectiontool', 'googlesiteverification',
  'google-site-verification', 'bingpreview', 'applebot', 'gptbot', 'ccbot', 'amazonbot', 'bytespider',
  'dataforseo',
];
const DEDUP_WINDOW_MS = 30_000;
const MAX_PATH_LENGTH = 200;
const MAX_REF_LENGTH = 500;
const MAX_UTM_LENGTH = 100;

export function trackRouter({ db, now = () => new Date().toISOString() } = {}) {
  const r = Router();
  // { ip -> last accepted ts (ms) }. Pruned on every hit while the map is
  // tiny: entries die 30s after they are written, so it can never grow past
  // distinct-IPs-in-30s regardless of traffic.
  const lastHit = new Map();
  const prune = (tsMs) => {
    for (const [ip, lastTs] of lastHit) {
      if (tsMs - lastTs > DEDUP_WINDOW_MS) lastHit.delete(ip);
    }
  };
  /** Server-side referrer sanitization: must be a string, trimmed, capped at
   *  500 chars; anything else becomes ''. The site mirrors this client-side. */
  const sanitizeRef = (raw) => {
    if (typeof raw !== 'string') return '';
    return raw.trim().slice(0, MAX_REF_LENGTH);
  };
  /** Server-side UTM sanitization (owner 2026-10-15): identical contract to
   *  ref but capped at 100 chars — the beacon never sends a longer tag, and a
   *  hostile body must not be able to stuff arbitrary text into the ledger. */
  const sanitizeUtm = (raw) => {
    if (typeof raw !== 'string') return '';
    return raw.trim().slice(0, MAX_UTM_LENGTH);
  };
  r.post('/api/v1/track', (req, res) => {
    try {
      const rawPath = req.body?.path;
      if (typeof rawPath !== 'string') return res.status(204).end();
      const path = rawPath.trim().slice(0, MAX_PATH_LENGTH);
      if (path === '') return res.status(204).end();
      const ua = (req.get('user-agent') || '').trim();
      const ts = Date.parse(now()); // epoch ms (the page_views.ts convention)
      const ip = clientIp(req);
      const ref = sanitizeRef(req.body?.ref);
      // UTM campaign attribution (owner 2026-10-15): the site beacon parses
      // ?utm_source/utm_medium/utm_campaign out of the landing URL and sends
      // them here — they survive in-app browsers that strip the Referer
      // header. Sanitized exactly like ref (string, trimmed, capped); anything
      // else -> '', stored on the page_views row only (bot_hits unchanged).
      const utmSource = sanitizeUtm(req.body?.utm_source);
      const utmMedium = sanitizeUtm(req.body?.utm_medium);
      const utmCampaign = sanitizeUtm(req.body?.utm_campaign);
      // Bot-ledger write at a drop point. The outer try/catch already keeps the
      // 204 contract, but a ledger failure must also never break this route —
      // and the views row (if any) is written independently of this.
      const recordBot = (reason) => {
        try {
          db.insertBotHit({ ts, ip, ua, path, ref, reason });
        } catch {
          // Dropped on the floor: bots blocked stats are best-effort honesty,
          // not a hard requirement of the beacon path.
        }
      };
      if (ua === '') {
        recordBot('empty_ua');
        return res.status(204).end();
      }
      // Headless/automation signal from the site (navigator.webdriver === true
      // — Playwright/Puppeteer/Selenium). Plausibility signal, not a verdict:
      // it catches automated browsers that carry a perfectly normal UA.
      if (req.body?.webdriver === true) {
        recordBot('webdriver');
        return res.status(204).end();
      }
      const uaLower = ua.toLowerCase();
      const matched = BOT_PATTERNS.find((bot) => uaLower.includes(bot));
      if (matched) {
        recordBot(`ua:${matched}`);
        return res.status(204).end();
      }
      prune(ts);
      if (lastHit.has(ip)) {
        recordBot('dedup'); // same human, second hit inside the window — still recorded
        return res.status(204).end();
      }
      lastHit.set(ip, ts);
      db.insertPageView({ ts, ip, ua, path, ref, utmSource, utmMedium, utmCampaign });
      return res.status(204).end();
    } catch {
      return res.status(204).end();
    }
  });
  return r;
}