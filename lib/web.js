'use strict';
// A web page as a "device": the calls the runner makes on a phone (nodes, tap, typeText, swipe, screenshot,
// launch…) answered by Playwright driving the Chrome or Edge already installed on this computer (or
// Playwright's own Chromium when it is there). Elements are reported like uiautomator's tree — text,
// description, id and a centre point — so «Tap "Confirm"» means the same on a page as on a phone.
// Coordinates are document pixels: a tap scrolls the point into view first, and dx/dy offsets keep working.
const fs = require('node:fs');
const path = require('node:path');

let pw = null;
function playwright() {
  if (pw) return pw;
  try { pw = require('playwright-core'); } catch { throw new Error('the browser engine needs playwright-core: run npm install in the console folder'); }
  return pw;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Where a browser may live, per platform; `settings.web.browserPath` wins over all of them.
function candidates() {
  const local = process.env.LOCALAPPDATA || '';
  const pf = process.env.ProgramFiles || 'C:\\Program Files', pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  if (process.platform === 'win32') {
    return [
      { name: 'Chrome', channel: 'chrome', file: path.join(pf, 'Google', 'Chrome', 'Application', 'chrome.exe') },
      { name: 'Chrome', channel: 'chrome', file: path.join(pf86, 'Google', 'Chrome', 'Application', 'chrome.exe') },
      { name: 'Chrome', channel: 'chrome', file: path.join(local, 'Google', 'Chrome', 'Application', 'chrome.exe') },
      { name: 'Edge', channel: 'msedge', file: path.join(pf86, 'Microsoft', 'Edge', 'Application', 'msedge.exe') },
      { name: 'Edge', channel: 'msedge', file: path.join(pf, 'Microsoft', 'Edge', 'Application', 'msedge.exe') }
    ];
  }
  if (process.platform === 'darwin') {
    return [
      { name: 'Chrome', channel: 'chrome', file: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' },
      { name: 'Chrome', file: path.join(require('node:os').homedir(), 'Applications', 'Google Chrome.app', 'Contents', 'MacOS', 'Google Chrome') },
      { name: 'Edge', channel: 'msedge', file: '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge' },
      { name: 'Chromium', file: '/Applications/Chromium.app/Contents/MacOS/Chromium' }
    ];
  }
  return [
    { name: 'Chrome', channel: 'chrome', file: '/usr/bin/google-chrome' }, { name: 'Chrome', channel: 'chrome', file: '/usr/bin/google-chrome-stable' }, { name: 'Chrome', channel: 'chrome', file: '/opt/google/chrome/chrome' },
    { name: 'Chromium', file: '/usr/bin/chromium' }, { name: 'Chromium', file: '/usr/bin/chromium-browser' }, { name: 'Chromium', file: '/snap/bin/chromium' },
    { name: 'Edge', channel: 'msedge', file: '/usr/bin/microsoft-edge' }, { name: 'Edge', channel: 'msedge', file: '/usr/bin/microsoft-edge-stable' }
  ];
}

// Which browser the engine would start: { ok, name, path } — for the setup page and the header.
function probe(settings = {}) {
  const cfg = settings.web || {};
  let installed = false;
  try { require.resolve('playwright-core'); installed = true; } catch { /* not installed */ }
  if (!installed) return { ok: false, error: 'playwright-core is not installed — run npm install in the console folder' };
  if (cfg.browserPath) return fs.existsSync(cfg.browserPath) ? { ok: true, name: path.basename(cfg.browserPath), path: cfg.browserPath, executablePath: cfg.browserPath } : { ok: false, error: `browser not found: ${cfg.browserPath}` };
  for (const c of candidates()) if (fs.existsSync(c.file)) return { ok: true, name: c.name, path: c.file, channel: c.channel, executablePath: c.channel ? undefined : c.file };
  try {
    const bundled = playwright().chromium.executablePath();
    if (bundled && fs.existsSync(bundled)) return { ok: true, name: 'Chromium (Playwright)', path: bundled, executablePath: bundled };
  } catch { /* no bundled browser */ }
  return { ok: false, error: 'no browser found: install Chrome or Edge, or run npx playwright install chromium' };
}

function pathOf(url) {
  try { const u = new URL(url); return u.pathname + (u.search || ''); } catch { return url; }
}
function hostOf(url) {
  try { return new URL(url).host; } catch { return ''; }
}

class WebDevice {
  constructor({ settings = {}, serial = 'web' } = {}) {
    this.serial = serial;
    this.platform = 'web';
    this.settings = settings;
    this.cfg = { headless: true, width: 1280, height: 800, ...(settings.web || {}) };
    this.browser = null;
    this.context = null;
    this.page = null;
    this.console = [];
    this.calls = [];
    // snapshot generation: every nodes() call strips the old marks and tags the reported elements "<gen>:<i>",
    // so a node from an older snapshot can never resolve to whatever element now carries its index
    this.gen = 0;
  }

  async open() {
    if (this.page && !this.page.isClosed()) return;
    const { chromium } = playwright();
    const found = probe(this.settings);
    if (!found.ok) throw new Error(found.error);
    const opts = { headless: this.cfg.headless !== false };
    if (found.channel) opts.channel = found.channel; else opts.executablePath = found.executablePath;
    if (!this.browser) this.browser = await chromium.launch(opts);
    await this.newContext();
  }

  // settings.web.locale (navigator.language, Accept-Language, Intl formats); empty = this computer's locale
  locale() {
    const set = String(this.cfg.locale || '').trim();
    if (set) return set;
    try { return Intl.DateTimeFormat().resolvedOptions().locale || 'en-US'; } catch { return 'en-US'; }
  }

  async newContext() {
    if (this.context) await this.context.close().catch(() => {});
    this.context = await this.browser.newContext({ viewport: { width: Number(this.cfg.width) || 1280, height: Number(this.cfg.height) || 800 }, locale: this.locale(), ignoreHTTPSErrors: true, deviceScaleFactor: 1 });
    this.page = await this.context.newPage();
    this.page.setDefaultTimeout(20000);
    this.page.on('console', (m) => { if (['error', 'warning'].includes(m.type())) this.log(m.type(), m.text()); });
    this.page.on('pageerror', (e) => this.log('error', e.message));
    this.page.on('dialog', (d) => d.dismiss().catch(() => {}));
    // the page's own API calls, shown on the step like the app's network log
    this.page.on('response', (res) => {
      const req = res.request();
      if (!['xhr', 'fetch'].includes(req.resourceType())) return;
      const timing = req.timing();
      this.calls.push({ corr: res.headers()['x-correlation-id'] || '', t: new Date().toISOString(), method: req.method(), path: pathOf(req.url()), status: res.status(), ms: timing && timing.responseEnd > 0 ? Math.round(timing.responseEnd) : undefined, service: hostOf(req.url()) });
    });
    this.page.on('requestfailed', (req) => {
      if (!['xhr', 'fetch'].includes(req.resourceType())) return;
      this.calls.push({ corr: '', t: new Date().toISOString(), method: req.method(), path: pathOf(req.url()), status: 0, errorCode: (req.failure() || {}).errorText, service: hostOf(req.url()) });
    });
  }

  log(level, text) {
    this.console.push(`${new Date().toISOString().slice(11, 23)} ${level.toUpperCase()} ${text}`);
    if (this.console.length > 400) this.console.splice(0, this.console.length - 400);
  }

  async close() {
    if (this.browser) await this.browser.close().catch(() => {});
    this.browser = null; this.context = null; this.page = null;
  }

  url() {
    return this.page && !this.page.isClosed() ? this.page.url() : '';
  }

  // settings.webUrl + a relative path, or the url as given
  resolveUrl(url) {
    const u = String(url || '').trim();
    const base = String(this.settings.webUrl || '').replace(/\/$/, '');
    if (!u) { if (!base) throw new Error('no site address: give the step a url or set "Site address" in the settings'); return base; }
    if (/^https?:\/\//i.test(u)) return u;
    if (!base) throw new Error(`a relative address "${u}" needs "Site address" in the settings`);
    return base + (u.startsWith('/') ? u : '/' + u);
  }

  // Opens a page. `clear` starts from a fresh browser context (no cookies, no storage); `storage` puts
  // localStorage entries in place before the page's own scripts run — a saved session, feature flags.
  // An init script does it, so an app that redirects on its first load (no token → /login) already sees them;
  // it fires once, on the first document of the target's origin, and is removed when the launch is done.
  async launch(url, _activity, { clear = false, storage = null } = {}) {
    await this.open();
    if (clear) await this.newContext();
    const target = this.resolveUrl(url);
    let init = null;
    const entries = storage && typeof storage === 'object' ? Object.entries(storage).map(([k, v]) => [k, typeof v === 'string' ? v : JSON.stringify(v)]) : [];
    const flag = `__e2e_storage_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    if (entries.length) {
      let origin = '';
      try { origin = new URL(target).origin; } catch { /* resolveUrl gave an absolute url */ }
      init = await this.page.addInitScript(([want, list, mark]) => {
        try {
          if (location.origin !== want || sessionStorage.getItem(mark)) return;
          for (const [k, v] of list) localStorage.setItem(k, v);
          sessionStorage.setItem(mark, '1');
        } catch { /* storage blocked on this document */ }
      }, [origin, entries, flag]);
    }
    let res;
    try {
      res = await this.page.goto(target, { waitUntil: 'load', timeout: 30000 });
    } catch (e) {
      if (init) await init.dispose().catch(() => {});
      throw new Error(`could not open ${target}: ${e.message.split('\n')[0]} — is the site running?`);
    }
    if (res && res.status() >= 400) { if (init) await init.dispose().catch(() => {}); throw new Error(`${target} answered HTTP ${res.status()}`); }
    await this.page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
    if (init) {
      await init.dispose().catch(() => {});
      const applied = await this.page.evaluate((mark) => { try { return !!sessionStorage.getItem(mark); } catch { return false; } }, flag).catch(() => false);
      if (!applied) this.log('warning', `launch storage is set for ${target}'s origin only, and the page ended elsewhere: ${this.page.url()}`);
    }
    return '';
  }

  async openLink(_pkg, url) {
    await this.launch(url);
  }

  // Elements as a flat list, like uiautomator's: interactive elements carry their whole label, other
  // elements only their own text (so a container does not repeat every word on the page); fields carry
  // their <label>, placeholder or aria-label as the description. Positions are document pixels.
  // Only what a person could see counts: not transparent (here or above), not a 1px screen-reader-only box,
  // not parked at negative coordinates, not cut off by an overflow:hidden ancestor (collapsed panels, other
  // carousel slides). Each call is a new generation; see this.gen.
  async nodes() {
    await this.open();
    const gen = ++this.gen;
    const out = await this.page.evaluate((g) => {
      const out = [];
      const sx = window.scrollX, sy = window.scrollY;
      for (const old of document.querySelectorAll('[data-e2e-i]')) old.removeAttribute('data-e2e-i');
      // the ancestors that clip (overflow hidden/clip), with their boxes, worked out once per snapshot
      const clipCache = new Map();
      const clipBox = (p) => {
        if (clipCache.has(p)) return clipCache.get(p);
        const ps = getComputedStyle(p);
        const clips = /hidden|clip/.test(ps.overflowX) || /hidden|clip/.test(ps.overflowY);
        const box = clips ? p.getBoundingClientRect() : null;
        clipCache.set(p, box);
        return box;
      };
      const clippedAway = (el, r) => {
        for (let p = el.parentElement; p && p !== document.body && p !== document.documentElement; p = p.parentElement) {
          const b = clipBox(p);
          if (b && (r.right <= b.left || r.left >= b.right || r.bottom <= b.top || r.top >= b.bottom)) return true;
        }
        return false;
      };
      const SKIP = new Set(['SCRIPT', 'STYLE', 'SVG', 'PATH', 'NOSCRIPT', 'HEAD', 'META', 'LINK', 'TEMPLATE', 'BR', 'HR']);
      const INTERACTIVE = new Set(['BUTTON', 'A', 'SUMMARY', 'LABEL', 'OPTION', 'TH']);
      const FIELD = new Set(['INPUT', 'SELECT', 'TEXTAREA']);
      const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, 300);
      const labelOf = (el) => {
        if (el.id) { const l = document.querySelector(`label[for="${CSS.escape(el.id)}"]`); if (l) return clean(l.innerText); }
        const l = el.closest('label');
        return l ? clean(l.innerText) : '';
      };
      for (const el of document.body.querySelectorAll('*')) {
        if (SKIP.has(el.tagName)) continue;
        const st = getComputedStyle(el);
        if (st.visibility === 'hidden' || st.display === 'none') continue;
        const r = el.getBoundingClientRect();
        if (r.width <= 1 || r.height <= 1) continue;
        if (r.right + sx <= 0 || r.bottom + sy <= 0) continue;
        if (el.checkVisibility && !el.checkVisibility({ opacityProperty: true, visibilityProperty: true })) continue;
        if (clippedAway(el, r)) continue;
        const role = el.getAttribute('role') || '';
        const interactive = INTERACTIVE.has(el.tagName) || FIELD.has(el.tagName) || ['button', 'tab', 'link', 'menuitem', 'option', 'checkbox', 'switch'].includes(role) || typeof el.onclick === 'function';
        let text = '';
        if (FIELD.has(el.tagName)) {
          if (el.tagName === 'SELECT') text = clean((el.selectedOptions[0] || {}).text);
          else if (!['checkbox', 'radio', 'password'].includes(el.type)) text = clean(el.value);
        } else if (interactive) text = clean(el.innerText);
        else text = clean(Array.from(el.childNodes).filter((n) => n.nodeType === 3).map((n) => n.textContent).join(' '));
        const desc = clean(el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.getAttribute('title') || el.getAttribute('alt') || (FIELD.has(el.tagName) ? labelOf(el) : ''));
        const id = el.id || el.getAttribute('data-testid') || el.getAttribute('name') || '';
        if (!text && !desc && !id && !interactive) continue;
        // a disabled button is reported, so a tap can wait for it to come alive (a page that is busy)
        const disabled = !!(el.disabled || el.getAttribute('aria-disabled') === 'true');
        // the element keeps its mark, so a tap can scroll exactly it into view (pages scroll inside panels, not the window)
        const i = out.length;
        el.setAttribute('data-e2e-i', g + ':' + i);
        out.push({ i, text, desc, id, clickable: interactive, disabled, focused: el === document.activeElement, cls: el.tagName.toLowerCase() + (role ? '[' + role + ']' : ''), x: Math.round(r.left + r.width / 2 + sx), y: Math.round(r.top + r.height / 2 + sy), w: Math.round(r.width), h: Math.round(r.height) });
        if (out.length > 4000) break;
      }
      return out;
    }, gen);
    for (const n of out) n.gen = gen;
    return out;
  }

  async screenText() {
    return (await this.nodes()).map((n) => n.text || n.desc).filter(Boolean);
  }

  // document → viewport, scrolling the point to the middle when it is outside or near an edge: sticky headers
  // and bottom docks (an inspector bar) live there and would take the click instead of the element
  async viewportPoint(x, y) {
    const vp = this.page.viewportSize() || { width: 1280, height: 800 };
    const TOP = 90, BOTTOM = 140;
    let { sx, sy } = await this.page.evaluate(() => ({ sx: window.scrollX, sy: window.scrollY }));
    if (x - sx < 4 || x - sx > vp.width - 4 || y - sy < TOP || y - sy > vp.height - BOTTOM) {
      await this.page.evaluate(([px, py, w, hh]) => window.scrollTo(Math.max(0, px - w / 2), Math.max(0, py - hh / 2)), [x, y, vp.width, vp.height]);
      await sleep(250);
      ({ sx, sy } = await this.page.evaluate(() => ({ sx: window.scrollX, sy: window.scrollY })));
    }
    return { x: Math.min(vp.width - 1, Math.max(0, x - sx)), y: Math.min(vp.height - 1, Math.max(0, y - sy)) };
  }

  async tap(x, y) {
    await this.open();
    const p = await this.viewportPoint(Number(x), Number(y));
    await this.page.mouse.click(p.x, p.y);
    await this.page.waitForLoadState('load', { timeout: 5000 }).catch(() => {});
  }

  // The same element in a fresh snapshot: same text, description, id and kind; the nearest one when several match.
  async refind(node) {
    const same = (await this.nodes()).filter((n) => n.text === node.text && n.desc === node.desc && n.id === node.id && n.cls === node.cls);
    const dist = (n) => Math.abs(n.x - node.x) + Math.abs(n.y - node.y);
    return same.sort((a, b) => dist(a) - dist(b))[0] || null;
  }

  // Click an element of a snapshot. A node from an older snapshot, or one whose element was replaced or changed
  // its text since, is looked up again in a fresh one. The element must be visible; its own scroll container
  // brings it to the middle (sticky headers and bottom docks would otherwise take the click); then the element
  // must be the top one at the click point, or the tap fails instead of clicking through an overlay. With a
  // dx/dy offset the point is meant to be outside the element, so only the element itself is checked.
  async tapNode(node, dx = 0, dy = 0) {
    await this.open();
    if (!node || node.i == null) { await this.tap(Number(node.x) + dx, Number(node.y) + dy); return; }
    const label = JSON.stringify(node.text || node.desc || node.id || node.cls || '?');
    let cur = node.gen === this.gen ? node : await this.refind(node);
    for (let attempt = 0; ; attempt++) {
      if (!cur) throw new Error(`${label} is no longer on the page (it changed after it was found) — not clicked`);
      const sel = `[data-e2e-i="${cur.gen}:${cur.i}"]`;
      const state = await this.page.evaluate(([s, text]) => {
        const el = document.querySelector(s);
        if (!el) return 'missing';
        const clean = (t) => String(t || '').replace(/\s+/g, ' ').trim();
        // a recycled element (a list re-rendered in place) keeps the mark but shows something else
        if (text && !['INPUT', 'SELECT', 'TEXTAREA'].includes(el.tagName) && !clean(el.innerText || el.textContent).includes(text)) return 'missing';
        const b = el.getBoundingClientRect();
        if (b.width <= 1 || b.height <= 1 || (el.checkVisibility && !el.checkVisibility({ opacityProperty: true, visibilityProperty: true }))) return 'hidden';
        el.scrollIntoView({ block: 'center', inline: 'nearest' });
        return 'ok';
      }, [sel, cur.text]);
      if (state === 'missing' && attempt === 0) { cur = await this.refind(node); continue; }
      if (state === 'missing') throw new Error(`${label} is no longer on the page (it changed after it was found) — not clicked`);
      if (state === 'hidden') throw new Error(`${label} is not visible (hidden, transparent or zero-size) — not clicked`);
      break;
    }
    await sleep(150);
    const sel = `[data-e2e-i="${cur.gen}:${cur.i}"]`;
    const r = await this.page.evaluate(([s, ox, oy]) => {
      const el = document.querySelector(s);
      if (!el) return { error: 'missing' };
      const b = el.getBoundingClientRect();
      const px = b.left + b.width / 2 + ox, py = b.top + b.height / 2 + oy;
      if (px < 0 || py < 0 || px >= window.innerWidth || py >= window.innerHeight) return { error: 'outside', x: Math.round(px), y: Math.round(py) };
      const hit = document.elementFromPoint(px, py);
      const describe = (h) => {
        if (!h) return 'nothing';
        const cls = typeof h.className === 'string' && h.className.trim() ? '.' + h.className.trim().split(/\s+/)[0] : '';
        const text = String(h.innerText || h.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 40);
        return `<${h.tagName.toLowerCase()}${h.id ? '#' + h.id : ''}${cls}>${text ? ' "' + text + '"' : ''}`;
      };
      const root = h => h === document.body || h === document.documentElement;
      // the element, something inside it, or a wrapper it lives in (but not the page itself) takes the click
      // a field's own <label> lying over it (floating labels) passes the click on to the field
      const ownLabel = !!hit && !!hit.closest && !!hit.closest('label') && hit.closest('label').control === el;
      const clear = ox || oy ? true : !!hit && (hit === el || el.contains(hit) || (hit.contains(el) && !root(hit)) || ownLabel);
      return clear ? { x: px, y: py } : { error: 'covered', by: describe(hit), x: Math.round(px), y: Math.round(py) };
    }, [sel, Number(dx) || 0, Number(dy) || 0]);
    if (r.error === 'missing') throw new Error(`${label} disappeared while it was scrolled into view — not clicked`);
    if (r.error === 'outside') throw new Error(`${label}: the click point (${r.x}, ${r.y}) is outside the window — not clicked`);
    if (r.error === 'covered') throw new Error(`${label} is covered by ${r.by} at (${r.x}, ${r.y}) — not clicked`);
    await this.page.mouse.click(r.x, r.y);
    await this.page.waitForLoadState('load', { timeout: 5000 }).catch(() => {});
  }

  // scroll a found element into the window, so the step's screenshot shows what was checked
  async reveal(node) {
    if (!node || !this.page) return;
    const sel = node.i != null && node.gen === this.gen ? `[data-e2e-i="${node.gen}:${node.i}"]` : null;
    const done = sel ? await this.page.evaluate((s) => { const el = document.querySelector(s); if (!el) return false; el.scrollIntoView({ block: 'center', inline: 'nearest' }); return true; }, sel) : false;
    if (!done) await this.viewportPoint(Number(node.x), Number(node.y));
    await sleep(150);
  }

  // into the focused element; a <select> takes the option whose label matches the text
  async typeText(text) {
    await this.open();
    const tag = await this.page.evaluate(() => (document.activeElement ? document.activeElement.tagName : ''));
    if (tag === 'SELECT') {
      const labels = await this.page.evaluate(() => Array.from(document.activeElement.options).map((o) => o.text.trim()));
      const want = String(text).trim().toLowerCase();
      const label = labels.find((l) => l.toLowerCase() === want) || labels.find((l) => l.toLowerCase().includes(want));
      if (!label) throw new Error(`no option "${text}" in the list — options: ${labels.filter(Boolean).slice(0, 12).join(' · ') || '—'}`);
      await this.page.selectOption(':focus', { label });
      return;
    }
    if (!tag || tag === 'BODY') throw new Error('no field is focused: tap the field first (target)');
    await this.page.keyboard.type(String(text), { delay: 15 });
  }

  async clearField() {
    await this.page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A');
    await this.page.keyboard.press('Backspace');
  }

  // Android key codes the runner uses: 4 back, 66 enter, 67 backspace, 111 escape, 123 end
  async key(code) {
    await this.open();
    const map = { 66: 'Enter', 67: 'Backspace', 111: 'Escape', 123: 'End', 122: 'Home', 61: 'Tab' };
    if (Number(code) === 4) { await this.page.goBack({ waitUntil: 'load', timeout: 10000 }).catch(() => {}); return; }
    if (map[code]) await this.page.keyboard.press(map[code]);
  }

  async shell(cmd) {
    // «input keyevent 67 67 …» from the type step's clearing: erase the same way on a page
    const m = /^input keyevent (.*)$/.exec(String(cmd || ''));
    if (m) { for (const c of m[1].trim().split(/\s+/)) await this.key(Number(c)); }
    return '';
  }

  // down = read further (the wheel turns down); left/right scroll the row under atY
  async swipe(direction = 'down', atY, { fast = false } = {}) {
    await this.open();
    const vp = this.page.viewportSize() || { width: 1280, height: 800 };
    const step = Math.round((['left', 'right'].includes(direction) ? vp.width : vp.height) * (fast ? 0.9 : 0.6));
    const y = atY != null ? (await this.viewportPoint(vp.width / 2, Number(atY))).y : vp.height / 2;
    await this.page.mouse.move(vp.width / 2, y);
    const dx = direction === 'left' ? step : direction === 'right' ? -step : 0;
    const dy = direction === 'down' ? step : direction === 'up' ? -step : 0;
    await this.page.mouse.wheel(dx, dy);
    await sleep(fast ? 120 : 400);
  }

  async screenshot(file) {
    await this.open();
    await this.page.screenshot({ path: file, fullPage: false });
  }

  async clearLogcat() { this.console = []; }
  async logcat() { return this.console.slice(-150).join('\n'); }
  // the runner reads the app's network log off the phone; here the calls are collected directly
  async takeNetLog() { return ''; }
  netCalls() { const out = this.calls; this.calls = []; return out; }

  async info() {
    await this.open();
    return { model: (probe(this.settings).name || 'browser') + ' ' + (this.browser ? this.browser.version() : ''), platform: 'web', emulator: false };
  }
}

module.exports = { WebDevice, probe, sleep };
