import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../src/app.js';
import { validateUrl } from '../src/fetch/ssrf.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SLOP_HTML = `<!doctype html><html><head><title>Test</title></head><body>
<p>In today's fast-paced world, it's no secret that cutting-edge solutions will revolutionize the landscape.</p>
<p>Learn more. Subscribe to our newsletter. All rights reserved.</p>
</body></html>`;
const fakeFetcher = (html) => ({
  fetchHtml: async (raw) => ({ status: 200, url: new URL(raw).href, body: html }),
});
const offlineValidateTarget = async (raw) => validateUrl(raw);
const tmpDb = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'aislop-asset-')), 'test.db');

let server;
let base;
before(() => {
  const app = createApp({ dbPath: tmpDb(), fetcher: fakeFetcher(SLOP_HTML), validateTarget: offlineValidateTarget });
  server = app.listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

test('GET /assets/ass-score-card.jpg serves the social-card JPEG with cacheable headers', async () => {
  const res = await fetch(`${base}/assets/ass-score-card.jpg`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'image/jpeg');
  assert.match(res.headers.get('cache-control'), /public, max-age=86400/);
  const body = new Uint8Array(await res.arrayBuffer());
  // JPEG magic bytes: 0xFF 0xD8 0xFF
  assert.deepEqual([body[0], body[1], body[2]], [0xff, 0xd8, 0xff]);
  // Byte-identical to the committed asset (never drift from the brand-approved file).
  const committed = fs.readFileSync(path.join(__dirname, '..', 'src', 'assets', 'ass-score-card.jpg'));
  assert.deepEqual(body, new Uint8Array(committed));
});

test('GET /assets/donkey-dashboard.png still serves 200 image/png (untouched)', async () => {
  const res = await fetch(`${base}/assets/donkey-dashboard.png`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'image/png');
  assert.match(res.headers.get('cache-control'), /public, max-age=86400/);
  const body = new Uint8Array(await res.arrayBuffer());
  // PNG magic bytes: 0x89 'PNG'
  assert.deepEqual([body[0], body[1], body[2], body[3]], [0x89, 0x50, 0x4e, 0x47]);
});