/**
 * Owner payment alert — "New A.S.S. Report sold" email on every completed
 * paid report (owner request 2026-10-15; spec with the lead).
 *
 * Today a sale only surfaces in Stripe and the admin counter — the owner gets
 * no email when someone buys a full report. This module adds a best-effort,
 * env-gated alert to the owner on each fulfillment:
 *
 *   recipient   — OWNER_EMAIL (e.g. support@ass-score.com). When unset the
 *                 alert is SKIPPED SILENTLY (no call, no log): the gate lives
 *                 in the factory, so even a wired router never "attempts" a
 *                 send without a recipient.
 *   content     — scanned URL, A.S.S. score, verdict (read from
 *                 src/verdict.js — never hardcoded), amount paid (converted
 *                 from Stripe's smallest currency unit), customer email, and
 *                 the SAME token'd report link the buyer was emailed (the
 *                 report stays token-protected).
 *   failure     — soft-fail: any transport error is logged and swallowed; the
 *                 returned function NEVER rejects. The customer's report email
 *                 and the checkout/fulfillment flow are never blocked by it.
 *
 * Transport selection mirrors src/email.js (Resend API -> SMTP -> logged
 * no-op), so the alert rides the same credentials the product already uses.
 */
import { verdictFor } from './verdict.js';
import { createReportToken, reportSecret } from './paywall.js';
import { buildSiteReportUrl, RESEND_API_URL, RESEND_DEFAULT_FROM } from './email.js';
import nodemailer from 'nodemailer';

/** Default sender name/address — same value as src/email.js (not exported there). */
const DEFAULT_FROM = 'A.S.S. Score <no-reply@ass-score.com>';

/** Default subject — the task's example shape: domain + score in the subject. */
export const OWNER_ALERT_SUBJECT = 'New A.S.S. Report sold — {domain} ({score})';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Convert Stripe's smallest currency unit to a display amount.
 *
 * @param {number|null|undefined} minorUnits e.g. 1200 for Stripe's amount_total
 * @param {string|null|undefined} currency   e.g. 'usd' (case-insensitive)
 * @returns {string} "$12.00" / "€5.00" — or 'unknown' when either is missing
 *                   or the currency code is not a valid Intl code (never throw).
 */
export function formatAmount(minorUnits, currency) {
  if (minorUnits === null || minorUnits === undefined || minorUnits === '') return 'unknown';
  const minor = Number(minorUnits);
  const cur = typeof currency === 'string' ? currency.trim() : '';
  if (!Number.isFinite(minor) || cur === '') return 'unknown';
  try {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: cur.toUpperCase(),
    }).format(minor / 100);
  } catch {
    // Unknown/unsupported currency code — fail soft to a readable fallback.
    return `${cur} ${minor / 100}`;
  }
}

/** Hostname of a scanned URL for the subject line; falls back to the raw URL. */
export function siteDomain(url) {
  if (typeof url !== 'string' || url === '') return 'unknown';
  try {
    return new URL(url).hostname;
  } catch {
    return url.replace(/^https?:\/\//i, '').split('/')[0] || 'unknown';
  }
}

/**
 * Build the owner-alert email (plain text + HTML). Every variable field is
 * escaped; the score, the verdict (via src/verdict.js — single source), the
 * formatted amount, the customer email, and the token'd report link appear in
 * BOTH bodies.
 *
 * @param {object} opts
 * @param {string} opts.to            owner recipient (OWNER_EMAIL)
 * @param {object} opts.scan          public scan shape ({ id, url, score, ... })
 * @param {number|null|undefined} opts.amountMinor  Stripe amount_total (cents)
 * @param {string|null|undefined} opts.currency     Stripe currency code
 * @param {string|null|undefined} opts.customerEmail buyer the report went to
 * @param {string} opts.reportUrl     token'd full-report link (public origin)
 * @param {string} [opts.subject]     subject line
 * @param {string} [opts.from]        from address
 * @returns {{ from: string, to: string, subject: string, text: string, html: string }}
 */
export function buildOwnerAlertMail({ to, scan, amountMinor, currency, customerEmail, reportUrl, subject = OWNER_ALERT_SUBJECT, from = DEFAULT_FROM }) {
  const score = Number(scan.score ?? scan.slopScore);
  const domain = siteDomain(scan.url);
  const amount = formatAmount(amountMinor, currency);
  const customer = typeof customerEmail === 'string' && customerEmail.trim() !== '' ? customerEmail : 'unknown';
  const resolvedSubject = String(subject)
    .replace('{domain}', domain)
    .replace('{score}', String(score));

  const text = [
    'A.S.S. Score — new paid report',
    '',
    `URL scanned: ${scan.url}`,
    `A.S.S. Score: ${score} / 100`,
    `Verdict: ${verdictFor(score)}`,
    `Amount paid: ${amount}`,
    `Customer email: ${customer}`,
    `Report link: ${reportUrl}`,
    '',
    'The customer was emailed this same token-protected link on checkout.',
  ].join('\n');

  const esc = (v) => String(v)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');

  const html = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"/><title>${esc(resolvedSubject)}</title></head>
<body style="margin:0;background:#f1f5f9;font-family:system-ui,-apple-system,sans-serif;color:#1a202c">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f1f5f9;padding:24px 12px">
    <tr><td align="center">
      <table role="presentation" width="600" cellspacing="0" cellpadding="0" style="max-width:600px;width:100%;background:#ffffff;border-radius:12px;overflow:hidden;border:1px solid #e2e8f0">
        <tr><td style="background:linear-gradient(90deg,#f59e0b,#fbbf24);padding:18px 28px">
          <span style="font-size:20px;font-weight:700;color:#0f172a">A.S.S. Score</span>
          <span style="float:right;font-size:13px;color:#78350f">ass-score.com</span>
        </td></tr>
        <tr><td style="padding:28px">
          <p style="margin:0 0 18px;font-size:17px;font-weight:600;color:#1e293b">New paid report — ${esc(domain)}</p>
          <p style="margin:0 0 6px;font-size:13px;color:#64748b">URL scanned</p>
          <p style="margin:0 0 18px;font-size:15px;font-weight:600;color:#1e293b">${esc(scan.url)}</p>
          <p style="margin:0 0 6px;font-size:13px;color:#64748b">A.S.S. Score</p>
          <p style="margin:0 0 4px;font-size:36px;font-weight:800;color:#f59e0b">${score} <span style="font-size:16px;color:#94a3b8">/ 100</span></p>
          <p style="margin:0 0 18px;font-size:15px;color:#334155">${esc(verdictFor(score))}</p>
          <p style="margin:0 0 6px;font-size:13px;color:#64748b">Amount paid</p>
          <p style="margin:0 0 18px;font-size:18px;font-weight:700;color:#0f172a">${esc(amount)}</p>
          <p style="margin:0 0 6px;font-size:13px;color:#64748b">Customer email</p>
          <p style="margin:0 0 18px;font-size:15px;color:#334155">${esc(customer)}</p>
          <p style="margin:0 0 8px"><a href="${esc(reportUrl)}" style="display:inline-block;background:#0f172a;color:#f8fafc;text-decoration:none;padding:12px 22px;border-radius:8px;font-weight:600">Open the paid report</a></p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;

  return { from, to, subject: resolvedSubject, text, html };
}

/**
 * Factory for the owner-alert sender.
 *
 * GATE FIRST: when `ownerEmail` (OWNER_EMAIL) is unset/empty the returned
 * function is a SILENT no-op — no log, no transport, no crash. The gate is
 * independent of transport config, so a wired router with no OWNER_EMAIL can
 * never email anyone by accident.
 *
 * Otherwise transport precedence mirrors src/email.js exactly:
 *   1. Resend API — when `env.RESEND_API_KEY` is set (POST to api.resend.com
 *      via the injectable fetchImpl; global fetch by default).
 *   2. SMTP via Nodemailer — when `env.SMTP_HOST` is set (injectable
 *      `transport`, default a real transporter — same timeouts as email.js).
 *   3. logged no-op — neither set (the alert is dropped WITH a log line, so
 *      a configured recipient with no transport is discoverable).
 *
 * @param {object} [opts]
 * @param {string} [opts.ownerEmail]      OWNER_EMAIL recipient (default process.env.OWNER_EMAIL)
 * @param {string} [opts.from]            sender override (default per transport: Resend →
 *                                        RESEND_FROM ?? SMTP_FROM ?? RESEND_DEFAULT_FROM;
 *                                        SMTP → SMTP_FROM ?? DEFAULT_FROM)
 * @param {string} [opts.publicBaseUrl]   public origin the token'd report link is built on
 *                                        (default process.env.PUBLIC_BASE_URL || 'https://www.ass-score.com')
 * @param {string} [opts.reportTokenSecret] report-token secret (default env REPORT_TOKEN_SECRET /
 *                                        per-boot random via paywall.reportSecret)
 * @param {object} [opts.env]             env to read RESEND_, SMTP_ and other transport
 *                                        settings (default process.env)
 * @param {object} [opts.logger]          logger with .log/.error/.warn (default console)
 * @param {number} [opts.maxAttempts=3]   total attempts
 * @param {number[]} [opts.backoffMs]     delay before attempts 2, 3, ...
 * @param {object} [opts.transport]       injected Nodemailer transporter (SMTP path only)
 * @param {Function} [opts.fetchImpl]     injected fetch (Resend path only; default globalThis.fetch)
 * @returns {(ctx: { scan: object, amountMinor?: number|null, currency?: string|null,
 *           customerEmail?: string|null }) => Promise<{ok: boolean, configured: boolean,
 *           attempts?: number, error?: Error}>} — never rejects
 */
export function createOwnerAlertSender({
  ownerEmail = process.env.OWNER_EMAIL,
  from,
  publicBaseUrl = process.env.PUBLIC_BASE_URL || 'https://www.ass-score.com',
  reportTokenSecret,
  env = process.env,
  logger = console,
  maxAttempts = 3,
  backoffMs = [1_000, 3_000, 9_000],
  transport = null,
  fetchImpl = globalThis.fetch,
} = {}) {
  const owner = String(ownerEmail ?? '').trim();
  if (owner === '') {
    // GATE: no recipient configured -> silent skip (owner's call pending).
    return async function sendOwnerAlertNoop() {
      return { ok: false, configured: false };
    };
  }

  const secret = reportTokenSecret ?? reportSecret(env, logger);
  const logError = (...args) => {
    if (typeof logger.error === 'function') logger.error(...args);
    else console.error(...args);
  };

  // Build the token'd report link EXACTLY like the customer email sender does
  // (buildSiteReportUrl — the public /report/<scanId>?token=… route), so the
  // owner's link and the buyer's link are the same shape and stay protected.
  const reportUrlFor = (scan) =>
    buildSiteReportUrl(publicBaseUrl, scan.id, createReportToken(secret, scan.id));

  // Shared delivery core: build the mail, hand it to the transport's
  // (async) per-attempt send function, retry transient failures. Never throws.
  const deliver = async (sendAttempt, scan, ctx) => {
    const mail = buildOwnerAlertMail({
      to: owner,
      scan,
      amountMinor: ctx.amountMinor,
      currency: ctx.currency,
      customerEmail: ctx.customerEmail,
      reportUrl: reportUrlFor(scan),
      from: resolvedFrom,
    });
    let lastError = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      if (attempt > 1) {
        const delay = backoffMs[attempt - 2] ?? backoffMs[backoffMs.length - 1] ?? 0;
        if (delay > 0) await sleep(delay);
      }
      try {
        const outcome = await sendAttempt(mail, attempt);
        if (outcome && outcome.ok === false && typeof outcome.permanent === 'boolean' && outcome.permanent) {
          return { ok: false, configured: true, attempts: attempt, error: outcome.error };
        }
        if (outcome && outcome.ok) return { ok: true, configured: true, attempts: attempt };
      } catch (err) {
        lastError = err;
        logError(`[ownerAlert] delivery to ${owner} for scan ${scan?.id ?? '?'} failed: ${err?.message ?? err} (attempt ${attempt}/${maxAttempts})`);
      }
    }
    if (lastError) {
      return { ok: false, configured: true, attempts: maxAttempts, error: lastError };
    }
    return { ok: false, configured: true, attempts: maxAttempts, error: new Error('delivery failed') };
  };

  const resendApiKey = (env.RESEND_API_KEY || '').trim();
  const smtpHost = (env.SMTP_HOST || '').trim();
  const resolvedFrom = from ?? (resendApiKey ? (env.RESEND_FROM ?? env.SMTP_FROM ?? RESEND_DEFAULT_FROM) : (env.SMTP_FROM ?? DEFAULT_FROM));

  if (resendApiKey) {
    // 1) Resend — same contract as src/email.js: 2xx ok, 4xx permanent
    //    (retrying cannot change the rejection), 5xx/network transient.
    return async function sendOwnerAlertViaResend(ctx = {}) {
      const scan = ctx.scan;
      if (!scan || typeof scan.id !== 'string') {
        logError(`[ownerAlert] send to ${owner} aborted: payload is not a scan result`);
        return { ok: false, configured: true, attempts: 0, error: new Error('missing scan payload') };
      }
      return deliver(async (mail) => {
        const response = await fetchImpl(RESEND_API_URL, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${resendApiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ from: mail.from, to: mail.to, subject: mail.subject, html: mail.html }),
        });
        const status = Number(response?.status);
        if (status >= 200 && status < 300) return { ok: true };
        if (status >= 400 && status < 500) {
          const err = new Error(`Resend rejected the owner alert with HTTP ${status} (4xx is not retried)`);
          logError(`[ownerAlert] delivery to ${owner} for scan ${scan.id} rejected by Resend: HTTP ${status}`);
          return { ok: false, permanent: true, error: err };
        }
        throw new Error(`Resend returned HTTP ${status}`);
      }, scan, ctx);
    };
  }

  if (smtpHost) {
    const port = Number(env.SMTP_PORT) || (String(env.SMTP_SECURE) === 'true' ? 465 : 587);
    const secure = String(env.SMTP_SECURE) === 'true' || port === 465;
    const user = env.SMTP_USER || '';
    const pass = env.SMTP_PASS || '';
    const transporter = transport ?? nodemailer.createTransport({
      host: smtpHost,
      port,
      secure,
      auth: user && pass ? { user, pass } : undefined,
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 10_000,
    });
    return async function sendOwnerAlertViaSmtp(ctx = {}) {
      const scan = ctx.scan;
      if (!scan || typeof scan.id !== 'string') {
        logError(`[ownerAlert] send to ${owner} aborted: payload is not a scan result`);
        return { ok: false, configured: true, attempts: 0, error: new Error('missing scan payload') };
      }
      return deliver(async (mail) => {
        await transporter.sendMail(mail);
        return { ok: true };
      }, scan, ctx);
    };
  }

  // 3) No transport -> dropped WITH a log line (recipient is set, so the
  //    absence of credentials is worth knowing about).
  return async function sendOwnerAlertNoop(/* ctx */) {
    logger.log(
      `[ownerAlert] email not configured (set RESEND_API_KEY, or SMTP_HOST/SMTP_PORT/SMTP_USER/SMTP_PASS/SMTP_FROM); skipping owner alert to ${owner}`
    );
    return { ok: false, configured: false };
  };
}