'use strict';
// The browser engine (lib/web.js) against static pages served from test/fixtures/integration/web.
// Needs an installed Chrome, Edge or Chromium: found the way the engine finds it (web.probe), else skipped.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { WebDevice, probe } = require('../../lib/web');

const SITE = path.join(__dirname, '..', 'fixtures', 'integration', 'web');
const found = probe({});
const SKIP = found.ok ? false : `no browser for the web engine: ${found.error}`;

function serve() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      const name = decodeURIComponent(new URL(req.url, 'http://x').pathname).replace(/^\/+/, '');
      const file = path.join(SITE, name);
      if (!name || !file.startsWith(SITE + path.sep) || !fs.existsSync(file)) { res.writeHead(404); res.end('not found'); return; }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(fs.readFileSync(file));
    });
    srv.listen(0, '127.0.0.1', () => resolve(srv));
  });
}

const byText = (nodes, t) => nodes.find((n) => n.text === t || n.desc === t);
async function tapError(d, node) {
  try { await d.tapNode(node); return null; } catch (e) { return e.message; }
}

describe('web engine', { skip: SKIP }, () => {
  let site;
  let base;
  let d;
  before(async () => {
    site = await serve();
    base = `http://127.0.0.1:${site.address().port}`;
    d = new WebDevice({ settings: { webUrl: base, web: { headless: true, locale: 'en-US' } } });
  });
  after(async () => {
    if (d) await d.close();
    if (site) await new Promise((r) => site.close(r));
  });

  it('taps the element whose text matches, not one that only contains it', async () => {
    await d.launch('/stale.html', null, { clear: true });
    const nodes = await d.nodes();
    await d.tapNode(byText(nodes, 'Second'));
    assert.equal(await d.page.title(), 'second');
    await d.tapNode(byText(nodes, 'Second item'));
    assert.equal(await d.page.title(), 'second-exact');
  });

  it('taps through a panel switch with nodes from the fresh snapshot', async () => {
    await d.launch('/stale.html', null, { clear: true });
    await d.tapNode(byText(await d.nodes(), 'Next'));
    await d.tapNode(byText(await d.nodes(), 'Keep'));
    assert.equal(await d.page.title(), 'kept');
  });

  it('refuses a node from an older snapshot whose element is now hidden, instead of clicking by index', async () => {
    await d.launch('/stale.html', null, { clear: true });
    const old = await d.nodes();
    await d.tapNode(byText(old, 'Next'));
    const fresh = await d.nodes();
    await d.tapNode(byText(fresh, 'Keep'));
    const err = await tapError(d, byText(old, 'Delete all'));
    assert.match(err || '', /"Delete all" is no longer on the page/);
    assert.equal(await d.page.title(), 'kept');
  });

  it('marks only the elements of the latest snapshot', async () => {
    await d.launch('/stale.html', null, { clear: true });
    await d.nodes();
    await d.nodes();
    const marks = await d.page.evaluate(() => Array.from(document.querySelectorAll('[data-e2e-i]')).map((e) => e.getAttribute('data-e2e-i')));
    assert.ok(marks.length > 0);
    assert.ok(marks.every((m) => m.startsWith(d.gen + ':')), marks.join(','));
  });

  it('refuses a node whose element now shows another text (a recycled element)', async () => {
    await d.launch('/stale.html', null, { clear: true });
    const nodes = await d.nodes();
    const alpha = byText(nodes, 'Alpha');
    await d.tapNode(byText(nodes, 'Recycle'));
    const err = await tapError(d, alpha);
    assert.match(err || '', /"Alpha" is no longer on the page/);
    assert.equal(await d.page.title(), 'start');
  });

  it('re-finds and clicks a node from an older snapshot when its element is still there', async () => {
    await d.launch('/stale.html', null, { clear: true });
    const old = await d.nodes();
    await d.nodes();
    await d.tapNode(byText(old, 'Alpha'));
    assert.equal(await d.page.title(), 'clicked:Alpha');
  });

  it('leaves out of the snapshot what a person cannot see', async () => {
    await d.launch('/cover.html', null, { clear: true });
    const nodes = await d.nodes();
    for (const t of ['Skip to content', 'Loading…', 'Collapsed answer', 'Invisible parent text', 'Transparent', 'Accept cookies', 'Display none', 'Visibility hidden']) {
      assert.equal(byText(nodes, t), undefined, `"${t}" should not be in the snapshot`);
    }
    for (const t of ['Buy', 'Ghost', 'Tiny', 'Gone']) assert.ok(byText(nodes, t), `"${t}" should be in the snapshot`);
  });

  it('refuses an element that turned transparent after the snapshot', async () => {
    await d.launch('/cover.html', null, { clear: true });
    const nodes = await d.nodes();
    await d.tapNode(byText(nodes, 'Fade'));
    const err = await tapError(d, byText(nodes, 'Ghost'));
    assert.match(err || '', /"Ghost" is not visible \(hidden, transparent or zero-size\) — not clicked/);
    assert.doesNotMatch(await d.page.title(), /ghost/);
  });

  it('refuses an element that shrank to zero size after the snapshot', async () => {
    await d.launch('/cover.html', null, { clear: true });
    const nodes = await d.nodes();
    await d.tapNode(byText(nodes, 'Shrink'));
    const err = await tapError(d, byText(nodes, 'Tiny'));
    assert.match(err || '', /"Tiny" is not visible/);
    assert.doesNotMatch(await d.page.title(), /tiny/);
  });

  it('refuses an element hidden with display:none after the snapshot', async () => {
    await d.launch('/cover.html', null, { clear: true });
    const nodes = await d.nodes();
    await d.tapNode(byText(nodes, 'Hide'));
    const err = await tapError(d, byText(nodes, 'Gone'));
    assert.match(err || '', /"Gone" is (not visible|no longer on the page)/);
    assert.doesNotMatch(await d.page.title(), /gone/);
  });

  it('refuses an element covered by a modal and names what covers it', async () => {
    await d.launch('/cover.html', null, { clear: true });
    const nodes = await d.nodes();
    await d.tapNode(byText(nodes, 'Open modal'));
    const err = await tapError(d, byText(nodes, 'Buy'));
    assert.match(err || '', /"Buy" is covered by <div#modal> "Accept cookies" at \(\d+, \d+\) — not clicked/);
    assert.doesNotMatch(await d.page.title(), /buy/);
  });

  it('clicks a field under its own floating label', async () => {
    await d.launch('/cover.html', null, { clear: true });
    const email = (await d.nodes()).find((n) => n.id === 'email');
    assert.equal(await tapError(d, email), null);
    assert.match(await d.page.title(), /focus/);
  });

  it('launch with storage plants it before an app that redirects on its first load', async () => {
    await d.launch('/needs-login.html', null, { clear: true, storage: { token: 'tok-dummy', flags: { beta: true } } });
    assert.ok(d.url().endsWith('/needs-login.html'), d.url());
    const text = (await d.screenText()).join(' | ');
    assert.match(text, /Welcome back/);
    assert.match(text, /flag=\{"beta":true\}/);
  });

  it('does not plant the storage again after the launch is done', async () => {
    await d.launch('/needs-login.html', null, { clear: true, storage: { token: 'tok-dummy' } });
    await d.page.evaluate(() => localStorage.removeItem('token'));
    await d.page.reload({ waitUntil: 'load' });
    assert.ok(d.url().endsWith('/login.html'), d.url());
  });

  it('launch without storage lets the app redirect', async () => {
    await d.launch('/needs-login.html', null, { clear: true });
    assert.ok(d.url().endsWith('/login.html'), d.url());
  });

  it('launch reports an HTTP error page as an error', async () => {
    await assert.rejects(d.launch('/no-such-page.html'), /answered HTTP 404/);
  });

  it('a relative address without a site address is an error', async () => {
    const bare = new WebDevice({ settings: {} });
    assert.throws(() => bare.resolveUrl('/x'), /needs "Site address"/);
    assert.equal(bare.resolveUrl('http://127.0.0.1:9/a'), 'http://127.0.0.1:9/a');
  });
});

describe('web engine locale', { skip: SKIP }, () => {
  let site;
  let base;
  before(async () => {
    site = await serve();
    base = `http://127.0.0.1:${site.address().port}`;
  });
  after(async () => { if (site) await new Promise((r) => site.close(r)); });

  async function localeText(locale) {
    const d = new WebDevice({ settings: { webUrl: base, web: { headless: true, locale } } });
    try {
      await d.launch('/locale.html');
      return (await d.screenText()).join(' ');
    } finally { await d.close(); }
  }

  it('takes navigator.language and number formats from settings.web.locale', async () => {
    const t = await localeText('de-DE');
    assert.ok(t.startsWith('de-DE '), t);
    assert.match(t, /1\.234,50/);
  });

  it('uses this computer\'s locale when settings.web.locale is empty', async () => {
    const os = Intl.DateTimeFormat().resolvedOptions().locale;
    const t = await localeText('');
    assert.ok(t.startsWith(os + ' '), `${t} (computer: ${os})`);
  });
});
