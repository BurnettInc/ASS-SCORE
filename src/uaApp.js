/**
 * Deterministic user-agent classifier for the admin "direct traffic by
 * app/device" breakdown (owner GO 2026-10-15). The owner sees 'direct' as the
 * #2 source bucket and needs to know which mobile apps that no-referrer
 * traffic actually came from (X app, Reddit app, WhatsApp, …).
 *
 * Pure string logic, NO dependencies, NO external calls — the same UA always
 * classifies the same way, every time (the rule-set determinism contract).
 * The beacon already excludes bots upstream, so the UAs that reach the
 * aggregation are humans-only (plus pre-migration rows, which classify as
 * `other`/Unknown like everything else unrecognized).
 *
 * Honest limits (known caveat — do NOT try to "fix" it): modern iOS in-app
 * browsers (X app, Reddit app post-iOS-17) may present a plain Mobile Safari
 * UA with no app signature — those legitimately classify as Safari (iPhone),
 * and the plain-iOS-Safari bucket is EXPECTED to absorb them. Android
 * in-app browsers reliably carry the app token (e.g. 'Twitter for Android'),
 * so Android app coverage is the strong half.
 */

/** App-bucket labels — the aggregation maps every classified key to its
 *  label through this registry (one place, dashboard never hardcodes). */
export const APP_LABELS = Object.freeze({
  x: 'X app',
  reddit: 'Reddit app',
  whatsapp: 'WhatsApp',
  facebook: 'Facebook',
  instagram: 'Instagram',
  telegram: 'Telegram',
  discord: 'Discord',
  linkedin: 'LinkedIn',
  tiktok: 'TikTok',
  pinterest: 'Pinterest',
  threads: 'Threads',
  snapchat: 'Snapchat',
  slack: 'Slack',
});

/** Browser-bucket labels (same registry family — app keys and browser keys
 *  share one `app` field in classifyApp's output). */
export const BROWSER_LABELS = Object.freeze({
  'safari-ios': 'Safari (iPhone)',
  'chrome-android': 'Chrome (Android)',
  'chrome-desktop': 'Chrome (desktop)',
  'firefox-mobile': 'Firefox (mobile)',
  'firefox-desktop': 'Firefox (desktop)',
  edge: 'Edge',
  opera: 'Opera',
  brave: 'Brave',
  'samsung-internet': 'Samsung Internet',
  'safari-macos': 'Safari (Mac)',
  'wkwebview-ios': 'In-app webview (iOS)',
  other: 'Unknown',
});

/** Combined key->label registry (app + browser + `other`) — the single map
 *  the admin aggregation uses to render labels. */
export const LABELS = Object.freeze({ ...APP_LABELS, ...BROWSER_LABELS });

/**
 * Ordered app-bucket matchers — checked FIRST, in exactly this order
 * (owner-specified: x → reddit → whatsapp → facebook → instagram → telegram
 * → discord → linkedin → tiktok → pinterest → threads → snapchat → slack).
 * Every matcher is a lowercase substring test unless it carries its own
 * `test` fn. All app tokens are distinct, so the order only matters for the
 * second-guessing a token could match two buckets (none do today), but the
 * owner-specified order is kept verbatim.
 */
const APP_MATCHERS = [
  // X (Twitter) — the classic "Twitter for <platform>" product tokens plus
  // the rebranded "X for …" set.
  {
    key: 'x',
    tokens: [
      'twitter for iphone',
      'twitter for android',
      'twitter for ipad',
      'x for iphone',
      'x for ios',
      'x for android',
    ],
  },
  // Reddit — 'Reddit/…' (iOS/desktop product token), 'Reddit ' (standalone),
  // 'com.reddit' (iOS bundle id inside the UA).
  { key: 'reddit', tokens: ['reddit/', 'reddit ', 'com.reddit'] },
  { key: 'whatsapp', tokens: ['whatsapp'] },
  // Facebook — 'FBAN/FB…' (the bracketed Meta-app token every FB/Messenger
  // client carries, iOS + Android) and the bare 'facebook' product token.
  { key: 'facebook', tokens: ['fban', 'fbav', 'facebook'] },
  { key: 'instagram', tokens: ['instagram'] },
  { key: 'telegram', tokens: ['telegram'] },
  { key: 'discord', tokens: ['discord'] },
  { key: 'linkedin', tokens: ['linkedin'] },
  { key: 'tiktok', tokens: ['tiktok'] },
  { key: 'pinterest', tokens: ['pinterest'] },
  { key: 'threads', tokens: ['threads'] },
  { key: 'snapchat', tokens: ['snapchat'] },
  // Slack — word-boundary match, NOT a bare substring: 'slackbot' (a bot UA,
  // though bots are filtered upstream so it can never reach here) and
  // 'slackware' (a real Linux browser UA) must not collide with 'Slack/4.29'.
  { key: 'slack', test: (s) => /\bslack\b/.test(s) },
];

/** iOS device-platform signal (any iPhone/iPad/iPod/iOS token). */
const isIos = (s) => s.includes('iphone') || s.includes('ipad') || s.includes('ipod') || s.includes('ios');

/**
 * Ordered browser-bucket checks — run AFTER every app check failed; returns
 * the bucket key or null. Order matters: browsers that embed another
 * engine's tokens (Edge, Brave, Opera, Samsung Internet ALL carry
 * 'Chrome/…') must be checked BEFORE the plain Chrome rules, and the plain
 * Chrome rules must run before Safari's (Chrome-derived Safari tokens).
 */
function browserBucket(s) {
  // Edge — 'Edg/' (desktop), 'EdgA/' (Android), 'EdgiOS/' (iOS).
  if (s.includes('edg/') || s.includes('edga/') || s.includes('edgios/')) return 'edge';
  // Brave adds a 'Brave/…' product token on top of Chrome's.
  if (s.includes('brave')) return 'brave';
  // Opera — 'OPR/' (desktop) and the classic 'Opera/…' / Opera Mini tokens.
  if (s.includes('opr/') || s.includes('opera')) return 'opera';
  // Samsung Internet — 'SamsungBrowser/…' over Chrome/Android.
  if (s.includes('samsungbrowser')) return 'samsung-internet';
  // Chrome — Android before desktop (the Mobile token decides).
  if (s.includes('chrome') && s.includes('android')) return 'chrome-android';
  if (s.includes('chrome')) return 'chrome-desktop';
  // Firefox — mobile first ('Android'/'Mobile' in the platform token). iOS
  // Firefox is 'FxiOS/…' (no 'firefox' token) and falls to wkwebview-ios.
  if (s.includes('firefox') && (s.includes('android') || s.includes('mobile'))) return 'firefox-mobile';
  if (s.includes('firefox')) return 'firefox-desktop';
  // iOS Safari — the strict 'Safari' + 'Version/N' pair. Everything else
  // iOS+WebKit (in-app webviews, FxiOS, CriOS) lands in wkwebview-ios.
  if (isIos(s) && s.includes('safari') && s.includes('version/')) return 'safari-ios';
  if (isIos(s) && s.includes('webkit')) return 'wkwebview-ios';
  // Desktop Safari — 'Macintosh' + 'Safari' + 'Version/N'. Chrome/Firefox/
  // Edge/Opera/Brave on macOS can't reach here (they matched above).
  if (s.includes('macintosh') && s.includes('safari') && s.includes('version/')) return 'safari-macos';
  return null;
}

/**
 * Device derivation from UA tokens — the owner-specified ladder:
 *   iPad → tablet; iPhone/iPod → mobile; Android+Mobile → mobile;
 *   Android alone → tablet; any 'Mobile/'-style token → mobile;
 *   Linux/Macintosh/Windows → desktop; nothing recognized → desktop.
 * Best-effort by design (iPadOS "desktop mode" reports Macintosh and is
 * indistinguishable from a Mac — it lands in desktop, honestly).
 */
function deviceFromUa(s) {
  if (s.includes('ipad')) return 'tablet';
  if (s.includes('iphone') || s.includes('ipod')) return 'mobile';
  if (s.includes('android') && s.includes('mobile')) return 'mobile';
  if (s.includes('android')) return 'tablet';
  if (s.includes('mobile')) return 'mobile';
  if (s.includes('linux')) return 'desktop';
  if (s.includes('macintosh')) return 'desktop';
  if (s.includes('windows')) return 'desktop';
  return 'desktop';
}

/**
 * Classify a raw User-Agent string into one of the registry buckets.
 * @param {string|undefined|null} ua the raw UA header value
 * @returns {{ app: string, device: 'mobile'|'tablet'|'desktop', label: string }}
 *   `app` is the bucket key (an app key, a browser key, or 'other');
 *   `label` is the human-readable dashboard string (LABELS[app]).
 */
export function classifyApp(ua) {
  const s = String(ua ?? '').toLowerCase();
  // 1. App buckets — the whole point of the split: no-referrer traffic
  //    usually comes from inside an app's webview.
  for (const matcher of APP_MATCHERS) {
    const hit = matcher.tokens ? matcher.tokens.some((t) => s.includes(t)) : matcher.test(s);
    if (hit) {
      return { app: matcher.key, device: deviceFromUa(s), label: APP_LABELS[matcher.key] };
    }
  }
  // 2. Browser buckets.
  const browser = browserBucket(s);
  if (browser) return { app: browser, device: deviceFromUa(s), label: BROWSER_LABELS[browser] };
  // 3. Unknown (nonsense UAs, empty strings, everything unrecognized).
  return { app: 'other', device: deviceFromUa(s), label: BROWSER_LABELS.other };
}