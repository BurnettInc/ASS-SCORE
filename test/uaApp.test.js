import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyApp, LABELS } from '../src/uaApp.js';

// ---------------------------------------------------------------------------
// Deterministic UA classifier for the admin "direct traffic by app/device"
// breakdown (owner GO 2026-10-15). Pure string rules, no deps — the same UA
// always classifies the same way. Realistic UA samples only.
// ---------------------------------------------------------------------------

// Realistic UA samples (app tokens first so the app half is covered well).
const X_ANDROID = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Twitter for Android/10.0.1 Mobile Safari/537.36';
const X_FOR_ANDROID = 'X for Android/10.45 (Pixel 8; Android 14; Mobile)';
const X_IPHONE = 'Twitter for iPhone/10.11 (iPhone; iOS 17.4.1; Scale/3.00)';
const X_FOR_IPHONE = 'X for iPhone/10.45 (iPhone; iOS 17.5; Scale/3.00)';
const X_FOR_IOS = 'X for iOS/10.45 (iPhone; iOS 17.4.1; Scale/3.00)';
const X_IPAD = 'Twitter for iPad/9.68 (iPad; iPadOS 17.4; Scale/2.00)';
const REDDIT_IOS = 'Reddit/2024.16.0 (com.reddit.Reddit; iOS 17.4; iPhone14,5)';
const WHATSAPP_IOS = 'WhatsApp/2.24.4.76 (iPhone; iOS 17.4; Scale/3.00)';
const FB_ANDROID = '[FBAN/FB4A;FBAV/447.0.0.30.112;FBDV/Google Pixel 8;FBSV/14;FBCR/;FBMF/google;FBLC/en_US;FBRV/0;FBCA/;FBDM/{density=1.5,width=1080,height=2400};FBDD/3;FBPN/com.facebook.katana;FBDM]';
const FB_BARE = 'Mozilla/5.0 (Android 14; Mobile) AppleWebKit/537.36 (KHTML, like Gecko) Facebook/447.0.0.30.112';
const INSTAGRAM_IOS = 'Instagram 276.0.0.18.100 (iPhone14,5; iOS 17.4; en_US; en; scale=3.00; 1170x2532; 331476171)';
const TELEGRAM_ANDROID = 'Telegram/9.4.4 (Pixel 8; Android 14; Mobile)';
const DISCORD_MAC = 'Discord/0.0.310 (Macintosh; Intel Mac OS X 10_15_7)';
const LINKEDIN_IOS = 'LinkedIn/9.47.2 (iPhone; iOS 17.4; Scale/3.00)';
const TIKTOK_IOS = 'TikTok/34.3.2 (iPhone; iOS 17.4; Scale/3.00)';
const PINTEREST_IOS = 'Pinterest/11.9.0 (iPhone; iOS 17.4; Scale/3.00)';
const THREADS_IOS = 'Threads/315.0 (iPhone; iOS 17.4; Scale/3.00)';
const SNAPCHAT_IOS = 'Snapchat/13.15.0.43 (iPhone14,5; iOS 17.4; en_US; en; scale=3.00; 1170x2532)';
const SLACK_MAC = 'Slack/4.36.84 (Macintosh; Intel Mac OS X 10_15_7)';

test('uaApp: X/Twitter app tokens all classify as app "x"', () => {
  const cases = [
    [X_ANDROID, 'mobile', 'Twitter for Android in-app browser'],
    [X_FOR_ANDROID, 'mobile', 'rebranded X for Android'],
    [X_IPHONE, 'mobile', 'classic Twitter for iPhone'],
    [X_FOR_IPHONE, 'mobile', 'rebranded X for iPhone'],
    [X_FOR_IOS, 'mobile', 'rebranded X for iOS'],
    [X_IPAD, 'tablet', 'Twitter for iPad'],
  ];
  for (const [ua, device, why] of cases) {
    const r = classifyApp(ua);
    assert.equal(r.app, 'x', `${why} -> x`);
    assert.equal(r.device, device, `${why} device ${device}`);
    assert.equal(r.label, 'X app', `${why} label`);
  }
});

test('uaApp: Reddit -> app "reddit" (iOS product token incl. com.reddit bundle id)', () => {
  const r = classifyApp(REDDIT_IOS);
  assert.deepEqual(r, { app: 'reddit', device: 'mobile', label: 'Reddit app' });
  // The bare 'reddit ' token also matches (Android-style 'Reddit for …').
  assert.equal(classifyApp('Reddit for Android/2024.16.0').app, 'reddit');
});

test('uaApp: WhatsApp -> app "whatsapp"', () => {
  assert.deepEqual(classifyApp(WHATSAPP_IOS), { app: 'whatsapp', device: 'mobile', label: 'WhatsApp' });
});

test('uaApp: Facebook app via the FBAN token and the bare facebook token', () => {
  const r = classifyApp(FB_ANDROID);
  assert.equal(r.app, 'facebook', 'FBAN/FB4A bracketed token -> facebook');
  assert.equal(r.label, 'Facebook');
  // FB\'s in-app browser rides the FBAN token on a Chrome-for-Android UA —
  // the platform tokens then decide the device like any other Android WebView.
  const iab = classifyApp('Mozilla/5.0 (Linux; Android 14; Pixel 8; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/124.0.0.0 Mobile Safari/537.36 [FBAN/FB4A;FBAV/447.0.0.30.112]');
  assert.equal(iab.app, 'facebook', 'FBAN wins over the Chrome tokens the webview embeds');
  assert.equal(iab.device, 'mobile', 'Android + Mobile tokens -> mobile');
  assert.equal(classifyApp(FB_BARE).app, 'facebook', 'bare facebook product token');
});

test('uaApp: Instagram -> app "instagram"', () => {
  assert.deepEqual(classifyApp(INSTAGRAM_IOS), { app: 'instagram', device: 'mobile', label: 'Instagram' });
});

test('uaApp: Telegram and Discord -> their apps', () => {
  assert.deepEqual(classifyApp(TELEGRAM_ANDROID), { app: 'telegram', device: 'mobile', label: 'Telegram' });
  assert.deepEqual(classifyApp(DISCORD_MAC), { app: 'discord', device: 'desktop', label: 'Discord' });
});

test('uaApp: LinkedIn / TikTok / Pinterest / Threads / Snapchat -> their apps', () => {
  assert.equal(classifyApp(LINKEDIN_IOS).app, 'linkedin');
  assert.equal(classifyApp(TIKTOK_IOS).app, 'tiktok');
  assert.equal(classifyApp(PINTEREST_IOS).app, 'pinterest');
  assert.equal(classifyApp(THREADS_IOS).app, 'threads');
  assert.equal(classifyApp(SNAPCHAT_IOS).app, 'snapchat');
  assert.equal(classifyApp(LINKEDIN_IOS).device, 'mobile');
});

test('uaApp: Slack matches the word-boundary token, never "slackware"/"slackbot"', () => {
  assert.deepEqual(classifyApp(SLACK_MAC), { app: 'slack', device: 'desktop', label: 'Slack' });
  // 'slackware' is a real Linux browser UA — the bare substring must not
  // blindly match ("don't match bare 'slack' inside other strings").
  const slackware = classifyApp('Mozilla/5.0 (X11; U; Slackware Linux i686; en-US; rv:1.9.0.19) Gecko/2010070114 Firefox/3.0.19');
  assert.equal(slackware.app, 'firefox-desktop', 'slackware contains \'slack\' but classifies as Firefox');
  assert.equal(classifyApp('Slackbot-LinkExpanding/1.0').app, 'other', 'slackbot never matches slack');
});

test('uaApp: plain iOS Safari (Version/N + Safari/N) -> safari-ios, mobile', () => {
  const r = classifyApp('Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1');
  assert.deepEqual(r, { app: 'safari-ios', device: 'mobile', label: 'Safari (iPhone)' });
});

test('uaApp: Chrome on Android -> chrome-android, mobile', () => {
  const r = classifyApp('Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36');
  assert.deepEqual(r, { app: 'chrome-android', device: 'mobile', label: 'Chrome (Android)' });
});

test('uaApp: Chrome on desktop -> chrome-desktop, desktop', () => {
  const r = classifyApp('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36');
  assert.deepEqual(r, { app: 'chrome-desktop', device: 'desktop', label: 'Chrome (desktop)' });
});

test('uaApp: Firefox desktop vs Firefox mobile', () => {
  assert.deepEqual(
    classifyApp('Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:126.0) Gecko/20100101 Firefox/126.0'),
    { app: 'firefox-desktop', device: 'desktop', label: 'Firefox (desktop)' },
  );
  assert.deepEqual(
    classifyApp('Mozilla/5.0 (Android 14; Mobile; rv:126.0) Gecko/126.0 Firefox/126.0'),
    { app: 'firefox-mobile', device: 'mobile', label: 'Firefox (mobile)' },
  );
});

test('uaApp: Samsung Internet beats the Chrome token it embeds', () => {
  const r = classifyApp('Mozilla/5.0 (Linux; Android 13; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/21.0 Chrome/110.0.0.0 Mobile Safari/537.36');
  assert.deepEqual(r, { app: 'samsung-internet', device: 'mobile', label: 'Samsung Internet' });
});

test('uaApp: Edge / Opera / Brave beat the Chrome token they all embed', () => {
  const edge = classifyApp('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 Edg/126.0.2592.87');
  assert.equal(edge.app, 'edge', 'Edg/ product token wins over Chrome');
  assert.equal(edge.device, 'desktop');
  const opera = classifyApp('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 OPR/112.0.0.0');
  assert.equal(opera.app, 'opera', 'OPR/ product token wins over Chrome');
  const brave = classifyApp('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 Brave/1.65.0');
  assert.equal(brave.app, 'brave', 'Brave/ product token wins over Chrome');
});

test('uaApp: desktop Safari (Macintosh + Version/Safari) -> safari-macos', () => {
  const r = classifyApp('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15');
  assert.deepEqual(r, { app: 'safari-macos', device: 'desktop', label: 'Safari (Mac)' });
});

test('uaApp: iOS WKWebView-style UA without the Safari/Version token -> wkwebview-ios (generic in-app webview)', () => {
  // The raw WKWebView UA is the Safari UA minus the Version token (some
  // in-app browsers keep a bare Safari token; the plain form has neither).
  const plain = classifyApp('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148');
  assert.equal(plain.app, 'wkwebview-ios', 'iOS + WebKit without Version/ is an in-app webview');
  assert.equal(plain.device, 'mobile');
  assert.equal(plain.label, 'In-app webview (iOS)');
  const withSafariToken = classifyApp('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Safari/604.1');
  assert.equal(withSafariToken.app, 'wkwebview-ios', 'a Safari token without Version/ is still a webview');
});

test('uaApp: nonsense / empty UAs -> other, Unknown', () => {
  const nonsense = classifyApp('TotallyNotARealBrowser/1.0 (Nowhere; OS 99)');
  assert.deepEqual(nonsense, { app: 'other', device: 'desktop', label: 'Unknown' });
  assert.deepEqual(classifyApp(''), { app: 'other', device: 'desktop', label: 'Unknown' });
  assert.deepEqual(classifyApp(undefined), { app: 'other', device: 'desktop', label: 'Unknown' });
});

test('uaApp: LABELS registry has a label for every bucket the classifier can emit', () => {
  const emit = (ua) => classifyApp(ua).app;
  const emitted = new Set([
    emit(X_ANDROID), emit(REDDIT_IOS), emit(WHATSAPP_IOS), emit(FB_ANDROID), emit(INSTAGRAM_IOS),
    emit(TELEGRAM_ANDROID), emit(DISCORD_MAC), emit(LINKEDIN_IOS), emit(TIKTOK_IOS), emit(PINTEREST_IOS),
    emit(THREADS_IOS), emit(SNAPCHAT_IOS), emit(SLACK_MAC),
    emit('Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1'),
    emit('Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36'),
    emit('Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:126.0) Gecko/20100101 Firefox/126.0'),
    emit('Mozilla/5.0 (Android 14; Mobile; rv:126.0) Gecko/126.0 Firefox/126.0'),
    emit('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'),
    emit('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15'),
    emit('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148'),
    emit('nonsense'),
  ]);
  for (const key of emitted) {
    assert.ok(typeof LABELS[key] === 'string' && LABELS[key] !== '', `LABELS has a label for ${key}`);
  }
});

test('uaApp: classifyApp is deterministic — same UA, same result, repeated', () => {
  const ua = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Twitter for Android/10.0.1 Mobile Safari/537.36';
  const a = classifyApp(ua);
  for (let i = 0; i < 20; i++) assert.deepEqual(classifyApp(ua), a);
});