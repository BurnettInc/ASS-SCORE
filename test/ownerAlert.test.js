import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { createApp } from '../src/app.js';
import { validateUrl } from '../src/fetch/ssrf.js';
import { verdictFor, verdictLabel } from '../src/verdict.js';
import { createReportToken } from '../src/paywall.js';
import { buildSiteReportUrl, RESEND_API_URL, RESEND_DEFAULT_FROM } from '../src/email.js';
import {
  createOwnerAlertSender,
  buildOwnerAlertMail,
  formatAmount,
  siteDomain,
  OWNER_ALERT_SUBJECT,
} from '../src/ownerAlert.js';

/**
 * Owner payment alert (owner request 2026-10-15) — "New A.S.S. Report sold"
 * email on every completed paid report.
 *
 * Unit: mail content (verdict from src/verdict.js, amount formatted from
 * Stripe's smallest unit, token'd report link) + the env gate (OWNER_EMAIL
 * unset -> silent no-op; set -> Resend/SMTP delivery, soft-fail on error).
 * Integration: the alert fires EXACTLY ONCE per completed report on BOTH
 * fulfillment paths (Stripe webhook + /orders/:id/verify), never on retries
 * or the webhook/verify race, and a failing alert never breaks fulfillment
 * or the customer's report email.
 */

const tmpDb = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'assowner-')), 'test.db');
const SLOP_HTML = `<!doctype html><html><head><title>Test</title></head><body>
<p>In today's fast-paced world, it's no secret that cutting-edge solutions will revolutionize the landscape.</p>
<p>Learn more. All rights reserved.</p>
</body></html>`;
const fakeFetcher = () => ({ fetchHtml: async (raw) => ({ status: 200, url: new URL(raw).href, body: SLOP_HTML }) });
const offlineValidateTarget = async (raw) => validateUrl(raw);

/** Fake fetch recording outbound Resend calls; statuses is a queue (last wins). */
function fakeFetch({ statuses = [200] } = {}) {
  const calls = [];
  const queued = [...statuses];
  const fn = async (url, init) => {
    calls.push({ url, init: init ?? {} });
    const status = queued.length > 1 ? queued.shift() : queued[0];
    return { status, ok: status >= 200 && status < 300 };
  };
  fn.calls = calls;
  return fn;
}
const quietLogger = () => {
  const logs = [];
  const logger = {
    log: (m) => logs.push(String(m)),
    error: (m) => logs.push(String(m)),
    warn: (m) => logs.push(String(m)),
  };
  return { logger, logs };
};
const alertEnv = (extra = {}) => ({ RESEND_API_KEY: 're_123', RESEND_FROM: 'A.S.S. Score <no-reply@verified.example>', ...extra });

function stubSender() {
  const calls = [];
  const send = async (scan, to) => {
    calls.push({ scan, to });
    return { ok: true, attempts: 1 };
  };
  send.calls = calls;
  return send;
}
/** Stub owner-alert sender recording its ctx (optionally throwing). */
function stubOwnerAlert({ behavior = 'record' } = {}) {
  const calls = [];
  const send = async (ctx) => {
    calls.push(ctx);
    if (behavior === 'throw') throw new Error('stub owner alert boom');
    return { ok: true, configured: true, attempts: 1 };
  };
  send.calls = calls;
  return send;
}

function fakeStripe({ sessions = new Map() } = {}) {
  const calls = { createCheckoutSession: [], getCheckoutSession: [] };
  const client = {
    calls,
    sessions,
    async createCheckoutSession(params) {
      calls.createCheckoutSession.push(params);
      const id = `cs_test_${calls.createCheckoutSession.length}`;
      const session = {
        id,
        url: `https://checkout.stripe.com/c/pay/${id}`,
        client_reference_id: params.client_reference_id,
        customer_email: params.customer_email,
        payment_status: 'unpaid',
        metadata: params.metadata,
        ...(sessions.get(id) ?? {}),
      };
      sessions.set(id, session);
      return session;
    },
    async getCheckoutSession(id) {
      calls.getCheckoutSession.push(id);
      const session = sessions.get(id);
      if (!session) {
        const err = new Error(`No such checkout session: ${id}`);
        err.code = 'stripe_error';
        err.status = 404;
        throw err;
      }
      return session;
    },
  };
  return client;
}

function startApp(opts = {}) {
  const app = createApp({
    validateTarget: offlineValidateTarget,
    maxScansPerDay: 0,
    maxWebhooksPerDay: 0,
    stripe: fakeStripe(),
    stripePriceId: 'price_test_1',
    reportTokenSecret: 'test-secret',
    ...opts,
  });
  const server = app.listen(0);
  const port = server.address().port;
  return { server, base: `http://127.0.0.1:${port}` };
}
async function postJson(base, p, body, headers = {}) {
  const res = await fetch(`${base}${p}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* non-JSON body */ }
  return { status: res.status, json, text };
}
const query = (dbPath, sql, ...params) => new Database(dbPath, { readonly: true }).prepare(sql).all(...params);
async function makeScan(base) {
  const { status, json } = await postJson(base, '/api/v1/scan', { url: 'https://acme.example' });
  assert.equal(status, 200, 'scan should succeed');
  return json;
}
async function makeOrder(base, scanId, email = 'buyer@example.com') {
  const { status, json } = await postJson(base, '/api/v1/order-intent', { scanId, email });
  assert.equal(status, 200, 'order-intent should succeed');
  return json;
}
/** A payment-link checkout.session.completed (NO metadata — the new flow). */
const paymentLinkSession = (overrides = {}) => ({
  type: 'checkout.session.completed',
  data: {
    object: {
      id: overrides.id ?? 'cs_test_owner_1',
      client_reference_id: overrides.client_reference_id ?? undefined,
      customer_details: overrides.customer_details ?? { email: 'buyer@example.com' },
      ...(overrides.session ?? {}),
    },
  },
});

const PUBLIC_SCAN = { id: 'scan-1', url: 'https://acme.example/', score: 54, verdict: verdictFor(54) };
const OWNER = 'support@ass-score.com';

// ============================================================== unit: content
test('formatAmount: converts Stripe smallest-unit amounts for display; null/unknown never throw', () => {
  assert.equal(formatAmount(1200, 'usd'), '$12.00');
  assert.equal(formatAmount(500, 'eur'), '€5.00');
  assert.equal(formatAmount(0, 'usd'), '$0.00');
  assert.equal(formatAmount(1999, 'gbp'), '£19.99');
  assert.equal(formatAmount(undefined, 'usd'), 'unknown', 'missing amount -> unknown');
  assert.equal(formatAmount(null, 'usd'), 'unknown');
  assert.equal(formatAmount(1200, null), 'unknown', 'missing currency -> unknown');
  assert.equal(formatAmount('1200', 'usd'), '$12.00', 'string minor units accepted');
  assert.equal(formatAmount(1200, 'nope'), 'nope 12', 'unknown currency falls back without throwing');
});

test('siteDomain: hostname for the subject; garbage never throws', () => {
  assert.equal(siteDomain('https://www.example.com/very/deep'), 'www.example.com');
  assert.equal(siteDomain('http://example.com'), 'example.com');
  assert.equal(siteDomain('not a url'), 'not a url');
  assert.equal(siteDomain(''), 'unknown');
  assert.equal(siteDomain(undefined), 'unknown');
});

test('buildOwnerAlertMail: subject {domain} ({score}), body has URL/score/verdict/amount/customer/token link', () => {
  const url = 'https://support.example.com/pricing';
  const reportUrl = buildSiteReportUrl('https://ass-score.example', 'scan-1', createReportToken('sec', 'scan-1'));
  const mail = buildOwnerAlertMail({
    to: OWNER,
    scan: { id: 'scan-1', url, score: 54 },
    amountMinor: 1200,
    currency: 'usd',
    customerEmail: 'Buyer@Example.com',
    reportUrl,
  });
  assert.equal(mail.to, OWNER);
  assert.equal(mail.subject, 'New A.S.S. Report sold — support.example.com (54)');
  assert.ok(mail.subject.includes('support.example.com'), 'domain in subject');
  assert.ok(mail.subject.includes('(54)'), 'score in subject');
  // Body — plain text.
  assert.ok(mail.text.includes(url), 'scanned URL in text');
  assert.ok(mail.text.includes('54 / 100'), 'score in text');
  assert.ok(mail.text.includes(`Verdict: ${verdictFor(54)}`), 'verdict from src/verdict.js in text');
  assert.ok(mail.text.includes('$12.00'), 'formatted amount in text');
  assert.ok(mail.text.includes('Buyer@Example.com'), 'customer email in text');
  assert.ok(mail.text.includes(reportUrl), "token'd report link in text");
  // Body — HTML (escaped, verdict from the single source).
  assert.ok(mail.html.includes(verdictFor(54)), 'verdict in html');
  assert.ok(mail.html.includes('$12.00'), 'amount in html');
  assert.ok(mail.html.includes(`href="${reportUrl}"`), "token'd link as the HTML CTA");
  assert.ok(mail.html.includes('Buyer@Example.com'), 'customer email in html');
});

// ======================================================= unit: env gate + send
test('sender gate: OWNER_EMAIL unset -> silent no-op, zero outbound calls, never throws', async () => {
  const fetchFn = fakeFetch();
  const { logger, logs } = quietLogger();
  const sender = createOwnerAlertSender({ ownerEmail: '', env: alertEnv(), logger, fetchImpl: fetchFn });
  const result = await sender({ scan: PUBLIC_SCAN, amountMinor: 1200, currency: 'usd', customerEmail: 'a@b.co' });
  assert.deepEqual(result, { ok: false, configured: false }, 'skipped, not configured');
  assert.equal(fetchFn.calls.length, 0, 'nothing attempted');
  assert.equal(logs.length, 0, 'the skip is SILENT (no log)');
  // Whitespace-only env value is "unset" too.
  const ws = createOwnerAlertSender({ ownerEmail: '   ', env: alertEnv(), logger, fetchImpl: fetchFn });
  assert.deepEqual(await ws({ scan: PUBLIC_SCAN }), { ok: false, configured: false });
  assert.equal(fetchFn.calls.length, 0);
});

test('sender gate: default ownerEmail reads process.env.OWNER_EMAIL; unset -> no-op', async () => {
  const saved = process.env.OWNER_EMAIL;
  delete process.env.OWNER_EMAIL;
  try {
    const env = { ...process.env, RESEND_API_KEY: 're_env', RESEND_FROM: RESEND_DEFAULT_FROM };
    const fetchFn = fakeFetch();
    const sender = createOwnerAlertSender({ env, fetchImpl: fetchFn });
    const result = await sender({ scan: PUBLIC_SCAN, amountMinor: 1200, currency: 'usd', customerEmail: 'a@b.co' });
    assert.deepEqual(result, { ok: false, configured: false });
    assert.equal(fetchFn.calls.length, 0, 'no transport attempt without a recipient');
  } finally {
    if (saved !== undefined) process.env.OWNER_EMAIL = saved;
  }
});

test('sender: OWNER_EMAIL set + Resend -> POSTs the alert to the owner with the token link (exact wire shape)', async () => {
  const fetchFn = fakeFetch();
  const { logger } = quietLogger();
  const sender = createOwnerAlertSender({
    ownerEmail: OWNER,
    publicBaseUrl: 'https://ass-score.example',
    reportTokenSecret: 'sec',
    env: alertEnv(),
    logger,
    fetchImpl: fetchFn,
  });
  const result = await sender({ scan: PUBLIC_SCAN, amountMinor: 1200, currency: 'usd', customerEmail: 'a@b.co' });
  assert.deepEqual(result, { ok: true, configured: true, attempts: 1 });
  assert.equal(fetchFn.calls.length, 1);
  const { url, init } = fetchFn.calls[0];
  assert.equal(url, RESEND_API_URL);
  assert.equal(init.method, 'POST');
  assert.equal(init.headers.Authorization, 'Bearer re_123', 'same Resend credentials as customer email');
  const body = JSON.parse(init.body);
  assert.deepEqual(Object.keys(body).sort(), ['from', 'html', 'subject', 'to']);
  assert.equal(body.to, OWNER, 'recipient is OWNER_EMAIL');
  const expectedLink = buildSiteReportUrl('https://ass-score.example', PUBLIC_SCAN.id, createReportToken('sec', PUBLIC_SCAN.id));
  assert.ok(body.html.includes(expectedLink), 'token-protected report link in the delivered html');
});

test('sender soft-fail: Resend 5xx retries then succeeds; persistent 5xx returns ok:false without rejecting', async () => {
  const fetchFn = fakeFetch({ statuses: [500, 200] });
  const { logger } = quietLogger();
  const sender = createOwnerAlertSender({ ownerEmail: OWNER, env: alertEnv(), logger, fetchImpl: fetchFn, backoffMs: [1] });
  const ok = await sender({ scan: PUBLIC_SCAN, amountMinor: 1200, currency: 'usd' });
  assert.equal(ok.ok, true);
  assert.equal(ok.attempts, 2, 'retried the transient 500');

  const dead = fakeFetch({ statuses: [500, 500, 500] });
  const sender2 = createOwnerAlertSender({ ownerEmail: OWNER, env: alertEnv(), logger, fetchImpl: dead, backoffMs: [1] });
  const failed = await sender2({ scan: PUBLIC_SCAN, amountMinor: 1200, currency: 'usd' });
  assert.equal(failed.ok, false);
  assert.equal(failed.configured, true);
  assert.equal(failed.attempts, 3, 'gave up after maxAttempts');
  assert.ok(failed.error instanceof Error, 'error surfaced in the result, not thrown');
});

test('sender soft-fail: Resend 4xx is not retried (permanent rejection), still never throws', async () => {
  const fetchFn = fakeFetch({ statuses: [422] });
  const { logger } = quietLogger();
  const sender = createOwnerAlertSender({ ownerEmail: OWNER, env: alertEnv(), logger, fetchImpl: fetchFn });
  const result = await sender({ scan: PUBLIC_SCAN, amountMinor: 1200, currency: 'usd' });
  assert.equal(result.ok, false);
  assert.equal(result.attempts, 1, '4xx is permanent — no retry');
  assert.ok(result.error instanceof Error);
});

test('sender: OWNER_EMAIL set + no transport -> logged skip (recipient configured but no credentials)', async () => {
  const { logger, logs } = quietLogger();
  const sender = createOwnerAlertSender({ ownerEmail: OWNER, env: {}, logger });
  const result = await sender({ scan: PUBLIC_SCAN, amountMinor: 1200, currency: 'usd' });
  assert.deepEqual(result, { ok: false, configured: false });
  assert.equal(logs.length, 1);
  assert.ok(logs[0].includes('email not configured'), 'absence of credentials is logged, not fatal');
});

// ================================================== integration: webhook path
test('webhook fulfillment: owner alert fires once with URL/score/amount/customer from the real session', async () => {
  const dbp = tmpDb();
  const sender = stubSender();
  const alert = stubOwnerAlert();
  const app = startApp({ dbPath: dbp, fetcher: fakeFetcher(), emailSender: sender, ownerAlertSender: alert });
  try {
    const scan = await makeScan(app.base);
    const { orderId } = await makeOrder(app.base, scan.id, 'buyer@example.com');
    const { status, json } = await postJson(app.base, '/api/v1/webhook', paymentLinkSession({
      id: 'cs_test_owner_wh',
      client_reference_id: orderId,
      customer_details: { email: 'someone-else@example.com' }, // ref wins over email
      session: { amount_total: 1500, currency: 'usd' },
    }));
    assert.equal(status, 200);
    assert.equal(json.status, 'fulfilled');
    assert.equal(sender.calls.length, 1, 'customer report email sent');
    assert.equal(alert.calls.length, 1, 'owner alert fired exactly once');
    const ctx = alert.calls[0];
    assert.equal(ctx.scan.id, scan.id, 'alert receives the public scan shape (toPublicScan)');
    assert.equal(ctx.scan.url, scan.url);
    assert.equal(typeof ctx.scan.score, 'number');
    assert.equal(ctx.scan.verdict, verdictLabel(scan.score), 'verdict is the PUBLIC shape label from src/verdict.js, not hardcoded');
    assert.equal(ctx.amountMinor, 1500, 'amount is the REAL Stripe session amount_total (smallest unit)');
    assert.equal(ctx.currency, 'usd');
    assert.equal(ctx.customerEmail, 'buyer@example.com', 'customer email is the report recipient (order email)');
  } finally {
    app.server.close();
  }
});

test('webhook replay (Stripe retry): already_fulfilled -> owner alert still fires EXACTLY once', async () => {
  const dbp = tmpDb();
  const sender = stubSender();
  const alert = stubOwnerAlert();
  const app = startApp({ dbPath: dbp, fetcher: fakeFetcher(), emailSender: sender, ownerAlertSender: alert });
  try {
    const scan = await makeScan(app.base);
    const { orderId } = await makeOrder(app.base, scan.id);
    const body = paymentLinkSession({ id: 'cs_test_owner_retry', client_reference_id: orderId, session: { amount_total: 1200, currency: 'usd' } });
    const r1 = await postJson(app.base, '/api/v1/webhook', body);
    assert.equal(r1.json.status, 'fulfilled');
    const afterFirst = alert.calls.length;
    assert.equal(afterFirst, 1);
    const r2 = await postJson(app.base, '/api/v1/webhook', body); // Stripe replays the SAME event
    assert.equal(r2.json.status, 'already_fulfilled');
    assert.equal(alert.calls.length, afterFirst, 'retry fires NO second owner alert');
  } finally {
    app.server.close();
  }
});

// ================================================== integration: verify path
test('verify fulfillment: owner alert fires once with the session amount; a second verify does not re-fire', async () => {
  const dbp = tmpDb();
  const sender = stubSender();
  const alert = stubOwnerAlert();
  const stripe = fakeStripe({ sessions: new Map([['cs_test_1', { payment_status: 'paid', amount_total: 1750, currency: 'usd' }]]) });
  const app = startApp({ dbPath: dbp, fetcher: fakeFetcher(), emailSender: sender, ownerAlertSender: alert, stripe });
  try {
    const scan = await makeScan(app.base);
    const { orderId } = await makeOrder(app.base, scan.id, 'verify-buyer@example.com');
    const first = await postJson(app.base, `/api/v1/orders/${orderId}/verify`, { sessionId: 'cs_test_1' });
    assert.equal(first.status, 200);
    assert.equal(first.json.status, 'fulfilled');
    assert.equal(alert.calls.length, 1, 'alert fired on the verify-path fulfillment');
    const ctx = alert.calls[0];
    assert.equal(ctx.scan.id, scan.id);
    assert.equal(ctx.amountMinor, 1750, 'amount read from the session fetched back from Stripe');
    assert.equal(ctx.currency, 'usd');
    assert.equal(ctx.customerEmail, 'verify-buyer@example.com');

    const second = await postJson(app.base, `/api/v1/orders/${orderId}/verify`, { sessionId: 'cs_test_1' });
    assert.equal(second.status, 200);
    assert.equal(second.json.status, 'fulfilled');
    assert.equal(alert.calls.length, 1, 'NO second alert on the idempotent refresh');
  } finally {
    app.server.close();
  }
});

test('webhook/verify race (verify arrives late): alert fires ONCE total for the completed sale', async () => {
  const dbp = tmpDb();
  const sender = stubSender();
  const alert = stubOwnerAlert();
  const stripe = fakeStripe({ sessions: new Map([['cs_test_1', { payment_status: 'paid', amount_total: 1200, currency: 'usd' }]]) });
  const app = startApp({ dbPath: dbp, fetcher: fakeFetcher(), emailSender: sender, ownerAlertSender: alert, stripe });
  try {
    const scan = await makeScan(app.base);
    const { orderId } = await makeOrder(app.base, scan.id);
    // The webhook (primary path) fulfills + alerts.
    const wh = await postJson(app.base, '/api/v1/webhook', paymentLinkSession({
      id: 'cs_test_owner_race',
      client_reference_id: orderId,
      session: { amount_total: 1200, currency: 'usd' },
    }));
    assert.equal(wh.json.status, 'fulfilled');
    assert.equal(alert.calls.length, 1);
    // The success page's late verify re-opens but must NOT alert again.
    const late = await postJson(app.base, `/api/v1/orders/${orderId}/verify`, { sessionId: 'cs_test_1' });
    assert.equal(late.status, 200);
    assert.equal(late.json.status, 'fulfilled');
    assert.equal(alert.calls.length, 1, 'late verify fires NO second alert');
  } finally {
    app.server.close();
  }
});

// ============================================== integration: soft-fail + gate
test('alert soft-fail: a throwing owner alert never blocks fulfillment or the customer email', async () => {
  const dbp = tmpDb();
  const sender = stubSender();
  const alert = stubOwnerAlert({ behavior: 'throw' });
  const app = startApp({ dbPath: dbp, fetcher: fakeFetcher(), emailSender: sender, ownerAlertSender: alert });
  try {
    const scan = await makeScan(app.base);
    const { orderId } = await makeOrder(app.base, scan.id, 'boom@example.com');
    const { status, json } = await postJson(app.base, '/api/v1/webhook', paymentLinkSession({
      id: 'cs_test_owner_boom',
      client_reference_id: orderId,
      session: { amount_total: 1200, currency: 'usd' },
    }));
    assert.equal(status, 200);
    assert.equal(json.status, 'fulfilled', 'webhook response succeeded despite the alert crash');
    assert.equal(query(dbp, 'SELECT status FROM orders WHERE id = ?', orderId)[0].status, 'fulfilled');
    assert.equal(sender.calls.length, 1, 'customer report email still went out');
    assert.equal(alert.calls.length, 1, 'alert was attempted');
  } finally {
    app.server.close();
  }
});

test('env gate e2e: OWNER_EMAIL unset + default sender -> both paths fulfill cleanly, no crash, customer email intact', async () => {
  const savedOwner = process.env.OWNER_EMAIL;
  const savedResend = process.env.RESEND_API_KEY;
  const savedSmtp = process.env.SMTP_HOST;
  delete process.env.OWNER_EMAIL;
  delete process.env.RESEND_API_KEY;
  delete process.env.SMTP_HOST;
  try {
    const dbp = tmpDb();
    const sender = stubSender();
    const stripe = fakeStripe({ sessions: new Map([['cs_test_1', { payment_status: 'paid', amount_total: 1200, currency: 'usd' }]]) });
    const app = startApp({ dbPath: dbp, fetcher: fakeFetcher(), emailSender: sender, stripe }); // NO ownerAlertSender -> env default
    try {
      const scan = await makeScan(app.base);
      const { orderId } = await makeOrder(app.base, scan.id, 'gate@example.com');
      // Webhook path with the default (gated) alert sender: 200, no crash.
      const wh = await postJson(app.base, '/api/v1/webhook', paymentLinkSession({
        id: 'cs_test_owner_gate',
        client_reference_id: orderId,
        session: { amount_total: 1200, currency: 'usd' },
      }));
      assert.equal(wh.status, 200);
      assert.equal(wh.json.status, 'fulfilled');
      assert.equal(sender.calls.length, 1, 'customer report email unaffected');
      // Verify path with the same default sender: no crash either.
      const res = await postJson(app.base, `/api/v1/orders/${orderId}/verify`, { sessionId: 'cs_test_1' });
      assert.equal(res.status, 200);
      assert.equal(res.json.status, 'fulfilled');
    } finally {
      app.server.close();
    }
  } finally {
    if (savedOwner !== undefined) process.env.OWNER_EMAIL = savedOwner;
    if (savedResend !== undefined) process.env.RESEND_API_KEY = savedResend;
    if (savedSmtp !== undefined) process.env.SMTP_HOST = savedSmtp;
  }
});

// ------------------------------------- observed helper usage (constant sanity)
test('OWNER_ALERT_SUBJECT constant matches the shipped subject shape', () => {
  assert.equal(OWNER_ALERT_SUBJECT, 'New A.S.S. Report sold — {domain} ({score})');
});