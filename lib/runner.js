'use strict';
// Executes one scenario step by step on a device and records the run to disk.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { Device, sleep } = require('./adb');
const { IosDevice } = require('./ios');
const { WebDevice } = require('./web');
const { parse: parseNet } = require('./appNet');
const maestro = require('./maestro');
const { compile, condChain, defaultRole } = require('./compile');
const { writeJson } = require('./jsonfile');
const screenshot = require('./screenshot');
const { PerfSession, MEASURED_TYPES, normalizeMeasure, parseAmStart } = require('./perf');
const { FlashlightCollector } = require('./flashlight');

const STEP_LABELS = {
  launch: 'Open the app',
  link: 'Open a link',
  tap: 'Tap',
  type: 'Type text',
  swipe: 'Swipe',
  back: 'Back',
  wait: 'Wait',
  assertText: 'Check the screen',
  assertScreen: 'Compare with baseline',
  api: 'Check the backend',
  ai: 'Describe in words',
  maestro: 'Maestro commands',
  repeat: 'Repeat',
  browser: 'In the browser',
  phone: 'On the phone'
};

// the access token's expiry (ms since epoch) for {{role.tokenExp}}: a saved web session needs it
function jwtExp(token) {
  try {
    const payload = JSON.parse(Buffer.from(String(token).split('.')[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
    return payload.exp ? payload.exp * 1000 : null;
  } catch { return null; }
}

// 'В корзину' or { android: 'В корзину', ios: 'Add to cart' }
function perPlatform(value, platform) {
  if (value && typeof value === 'object' && !Array.isArray(value) && ('android' in value || 'ios' in value)) return value[platform] ?? value.android ?? value.ios ?? '';
  return value;
}
function localize(step, platform) {
  const out = { ...step };
  for (const k of ['target', 'text', 'url']) if (k in out) out[k] = perPlatform(out[k], platform);
  return out;
}

function condText(c) {
  if (!c) return '';
  if (c.not) return 'not ' + condText(c.not);
  if (c.visible) return `"${perPlatform(c.visible, 'android')}" on screen`;
  if (c.notVisible) return `no "${perPlatform(c.notVisible, 'android')}"`;
  if (c.var) return c.equals !== undefined ? `${c.var} = ${c.equals}` : c.matches ? `${c.var} ~ ${c.matches}` : `${c.var} is set`;
  if (c.platform) return c.platform;
  return JSON.stringify(c);
}

function describe(step, platform = 'android') {
  const s = localize(step, platform);
  switch (s.type) {
    case 'launch': return s._on === 'web' ? 'Open the site' + (s.url ? ' ' + s.url : '') : s.clear ? 'Open the app with cleared data' : 'Open the app';
    case 'tap': return `${s.double ? 'Double-tap' : 'Tap'} "${s.target || ''}"${s.optional ? ' (if present)' : ''}`;
    case 'type': return s.target ? `Type "${s.text || ''}" into "${s.target}"` : `Type "${s.text || ''}"`;
    case 'link': return `Open ${s.url || ''}`;
    case 'swipe': {
      const base = { up: 'Swipe up', down: 'Swipe down', left: 'Swipe row left', right: 'Swipe row right' }[s.direction || 'down'];
      return (s.fast ? base.replace('Swipe', 'Fling') : base) + (Number(s.times) > 1 ? ` ×${s.times}` : '') + (s.target ? ` "${s.target}"` : '');
    }
    case 'back': return 'Tap "Back"';
    case 'wait': return `Wait ${s.seconds || 1} s`;
    case 'assertText': {
      const what = s.id || s.by === 'id' ? `element ${s.id || s.text}` : s.regex ? `text matching ${s.text}` : `"${s.text || ''}"`;
      if (s.count != null) return `On screen: ${s.count} × ${what}`;
      return s.absent ? `Not on screen: ${what}` : `On screen: ${what}`;
    }
    case 'assertScreen': return `Screen equals baseline "${s.baseline || 'step'}"`;
    case 'api': return (s.title ? s.title + ' · ' : '') + `${s.auth && s.auth !== 'none' ? `[${s.auth}] ` : ''}${s.method || 'GET'} ${s.url || ''}${s.expectPath ? ` → ${s.expectPath} = ${s.expectValue}` : ''}`;
    case 'ai': return s.text || '';
    case 'repeat': return s.title || (s.until ? `Repeat until ${condText(s.until)}` : `Repeat ${s.times || s.max || 10} times`) + ` (${(s.steps || []).length} steps)`;
    case 'maestro': {
      let cmds = [];
      try { cmds = maestro.rawCommands(s); } catch { /* shown as is */ }
      const names = cmds.map((c) => (typeof c === 'string' ? c : Object.keys(c)[0] + (typeof Object.values(c)[0] === 'string' ? ` "${Object.values(c)[0]}"` : '')));
      return s.title || names.slice(0, 3).join(' → ') + (names.length > 3 ? ` (+${names.length - 3})` : '') || 'Maestro';
    }
    default: return s.type;
  }
}

// {{uuid}}, {{now}} and {{hex64}} are fresh on every use: idempotency keys, evidence digests.
// Templates from the settings (`templates: { context: '{"id":"{{uuid}}"}' }`) are expanded on every
// use too, so a request envelope the backend wants is written once and its ids stay fresh.
const TEMPLATES = Symbol('templates');
function subst(value, vars, depth = 0) {
  if (typeof value !== 'string') return value;
  const templates = (vars && vars[TEMPLATES]) || {};
  return value.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (all, k) => {
    if (k === 'uuid') return crypto.randomUUID();
    if (k === 'now') return new Date().toISOString();
    if (k === 'hex64') return crypto.randomBytes(32).toString('hex');
    if (vars[k] !== undefined) return String(vars[k]);
    if (templates[k] !== undefined && depth < 5) {
      const t = templates[k];
      return subst(typeof t === 'string' ? t : JSON.stringify(t), vars, depth + 1);
    }
    return all;
  });
}

// Dotted path; a segment `items[status=processing]` picks the first array element whose field matches.
function pick(obj, p) {
  return String(p || '').split('.').filter(Boolean).reduce((o, k) => {
    if (o == null) return undefined;
    const m = /^(\w*)\[(\w+)=([^\]]*)\]$/.exec(k);
    if (!m) return o[k];
    const arr = m[1] ? o[m[1]] : o;
    return Array.isArray(arr) ? arr.find((x) => x && String(x[m[2]]) === m[3]) : undefined;
  }, obj);
}

function norm(s) {
  return String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();
}

// All elements that match, best first: exact text / description / id, then text containing it.
// `by: 'id'` matches the resource id only; `regex` tests text and description as a regular expression.
function findNodes(nodes, target, { by, regex } = {}) {
  const visible = nodes.filter((n) => n.w > 0 && n.h > 0);
  if (by === 'id') return visible.filter((n) => n.id && (n.id === target || n.id.endsWith('/' + target)));
  if (regex) {
    let re; try { re = new RegExp(target, 'i'); } catch { return []; }
    return visible.filter((n) => re.test(n.text || '') || re.test(n.desc || ''));
  }
  const t = norm(target);
  if (!t) return [];
  const exact = visible.filter((n) => norm(n.text) === t || norm(n.desc) === t);
  const byId = visible.filter((n) => n.id && (n.id === target || n.id.endsWith('/' + target)));
  const partial = visible.filter((n) => norm(n.text).includes(t) || norm(n.desc).includes(t));
  return [...new Set([...exact, ...byId, ...partial])];
}
function findNode(nodes, target, opts) {
  return findNodes(nodes, target, opts)[0] || null;
}

// fn() is retried until it reports ok or the time is up; a throw (a screen dump that failed while a loader
// animates) is retried too, and only the last attempt's error is surfaced
async function waitFor(fn, timeoutSec, isStopped) {
  const until = Date.now() + Math.max(1, Number(timeoutSec) || 10) * 1000;
  let last;
  for (;;) {
    if (isStopped()) throw new Error('stopped');
    let err = null;
    try { last = await fn(); } catch (e) { err = e; }
    if (!err && last.ok) return last;
    if (Date.now() > until) { if (err) throw err; return last; }
    await sleep(700);
  }
}

const netTag = (s) => (s.appNet && s.appNet.tag) || '';
const roleToken = (s, role) => (((s.accounts || {})[role] || {}).token) || '';

class Run {
  constructor({ id, scenario, settings, runsDir, serial, platform = 'android', library = {}, vars = {}, label = '', measure = null, variant = null, onChange }) {
    this.dir = path.join(runsDir, id);
    fs.mkdirSync(this.dir, { recursive: true });
    this.settings = settings;
    this.platform = platform;
    // the browser is a second screen: opened on the first step that runs there, closed with the run
    this.web = null;
    this.device = platform === 'ios' ? new IosDevice({ serial }) : platform === 'web' ? this.webDevice() : new Device({ adbPath: settings.adbPath, serial });
    this.onChange = onChange || (() => {});
    this.stopped = false;
    this.resumeFn = null;
    this.conds = new Map(); // if/else group id → did the condition hold
    // a variant (an app mode) adds its setup/teardown steps and its vars; the run is labelled with it
    const compiled = compile(scenario, { library, variant });
    if (compiled.errors.length) throw new Error('the scenario did not compile: ' + compiled.errors.join('; '));
    this.steps = compiled.steps;
    this.scenario = scenario;
    this.variant = variant && variant.name ? variant : null;
    this.rowVars = { ...vars, ...(this.variant ? this.variant.vars : {}) };
    // `measure: true` in the scenario or «Замер» on the run: frames, CPU and memory around every screen step
    this.measure = normalizeMeasure(scenario.measure, measure);
    this.perf = null;
    this.data = {
      id,
      scenarioId: scenario.id,
      scenarioName: scenario.name + (label ? ` — ${label}` : ''),
      status: 'running',
      startedAt: new Date().toISOString(),
      finishedAt: null,
      device: serial,
      platform,
      build: path.basename(settings.apkPath || ''),
      engine: platform === 'ios' ? 'maestro' : (scenario.engine || settings.engine || 'adb'),
      env: settings.envName || '',
      pending: null,
      vars: {},
      matrix: Object.keys(vars).length ? vars : undefined,
      measure: this.measure || undefined,
      variant: this.variant ? this.variant.name : undefined,
      variantTitle: this.variant ? this.variant.title : undefined,
      section: scenario.section || undefined,
      steps: this.steps.map((s, i) => ({
        n: i + 1, type: s.type, label: STEP_LABELS[s.type] || s.type, title: describe(s, platform), status: 'pending',
        ...(s.type === 'api' || s.type === 'ai' ? {} : { screen: s._on === 'web' ? 'web' : 'phone' }),
        ...(s.figma ? { figma: s.figma } : {}), ...(s._phase !== 'main' ? { phase: s._phase } : {}), ...(s._from ? { from: s._from } : {}),
        ...(s._cond ? { cond: condChain(s).map((c) => (c.negate ? 'else: ' : 'if ') + condText(c.when)).join(' → ') } : {})
      }))
    };
    this.save();
  }

  save() {
    writeJson(path.join(this.dir, 'run.json'), this.data);
    this.onChange(this.data);
  }

  stop() {
    this.stopped = true;
    if (this.resumeFn) this.resumeFn({ ok: false, note: 'stopped' });
  }

  resume({ ok = true, note = '', vars = {} } = {}) {
    if (!this.resumeFn) return false;
    Object.assign(this.data.vars, vars);
    this.resumeFn({ ok, note });
    return true;
  }

  vars() {
    const v = { ...(this.settings.vars || {}), ...(this.scenario.vars || {}), ...this.rowVars, ...this.data.vars, platform: this.platform };
    for (const [role, a] of Object.entries(this.settings.accounts || {})) {
      for (const f of ['phone', 'token', 'otp']) if (a && a[f] != null) v[`${role}.${f}`] = a[f];
      const exp = a && a.token ? jwtExp(a.token) : null;
      if (exp) v[`${role}.tokenExp`] = exp;
    }
    v[TEMPLATES] = this.settings.templates || {};
    return v;
  }

  // which screen a step works on: the browser for `_on: web` (a browser: group, `on: web`, or engine web)
  dev(step) {
    return step && step._on === 'web' ? this.webDevice() : this.device;
  }
  webDevice() {
    if (!this.web) this.web = new WebDevice({ settings: this.settings });
    return this.web;
  }

  async shot(rec, d = this.device) {
    const file = `step-${rec.n}.png`;
    try {
      await d.screenshot(path.join(this.dir, file));
      rec.screenshot = file;
    } catch (e) {
      rec.detail = [rec.detail, 'screenshot not taken: ' + e.message].filter(Boolean).join('\n');
    }
  }

  // Android's «приложение не отвечает» dialog covers the screen; wait it out and note it on the step.
  async screen(d = this.device) {
    const nodes = await d.nodes();
    if (d.platform !== 'android') return nodes;
    const texts = nodes.map((n) => n.text || n.desc);
    const wait = nodes.find((n) => (n.text || '') === 'Подождать' || (n.text || '') === 'Wait');
    if (wait && texts.some((t) => /Закрыть приложение|не отвечает|Close app|isn't responding/i.test(t))) {
      this.anr = (this.anr || 0) + 1;
      await d.tap(wait.x, wait.y);
      await sleep(2000);
      return d.nodes();
    }
    return nodes;
  }

  // if/else and `when` conditions, checked on the screen (adb's tree, or the page for `on: web` and
  // steps that run in the browser) or on the run's variables
  async evalCond(c, v, on = null) {
    // a condition that names nothing known (`{visibel: X}`, `{}`, a bare string) is a mistake, not «true»
    if (!c || typeof c !== 'object' || Array.isArray(c)) throw new Error(`the condition must be an object (visible / notVisible / var …): ${JSON.stringify(c)}`);
    if (!['visible', 'notVisible', 'var', 'platform', 'not'].some((k) => c[k] !== undefined)) throw new Error(`the condition has no visible / notVisible / var / platform / not: ${JSON.stringify(c)}`);
    if (c.not) return !(await this.evalCond(c.not, v, on));
    if (c.platform) return c.platform === this.platform;
    const d = (c.on ? /^(web|browser)$/i.test(c.on) : on === 'web') ? this.webDevice() : this.device;
    if (c.var) {
      const val = v[c.var];
      if (c.equals !== undefined) return String(val) === String(subst(String(c.equals), v));
      if (c.matches !== undefined) { try { return new RegExp(c.matches).test(String(val ?? '')); } catch { return false; } }
      return val !== undefined && val !== '' && val !== null && val !== false;
    }
    const want = c.visible !== undefined ? subst(perPlatform(c.visible, this.platform), v) : null;
    const absent = c.notVisible !== undefined ? subst(perPlatform(c.notVisible, this.platform), v) : null;
    const timeout = Number(c.timeout) || 3;
    const r = await waitFor(async () => {
      const nodes = await this.screen(d);
      const okWant = want === null || !!findNode(nodes, want);
      const okAbsent = absent === null || !findNode(nodes, absent);
      return { ok: okWant && okAbsent };
    }, timeout, () => this.stopped);
    return r.ok;
  }

  // Which driver runs a step: backend checks and manual steps are ours, raw Maestro commands are Maestro's,
  // browser steps go to Playwright, screen steps to the scenario's engine — unless Maestro cannot express
  // them, then adb does.
  driverOf(step) {
    if (step.type === 'api' || step.type === 'ai' || step.type === 'assertScreen') return 'node';
    if (step._on === 'web') return 'web';
    if (step.type === 'repeat') return 'adb';
    if (step.type === 'maestro') return 'maestro';
    if (this.data.engine !== 'maestro') return 'adb';
    // a retried or optional step runs on its own, so its attempts stay one step
    if (step.retry || step.flaky || (step.optional && step.type !== 'tap')) return 'adb';
    // Maestro's inputText types ASCII only on Android; Cyrillic goes through the clipboard paste.
    if (step.type === 'type' && /[^\x20-\x7e]/.test(subst(perPlatform(step.text, this.platform), this.vars()))) return 'adb';
    return maestro.toCommands(localize(step, this.platform), this.settings, this.platform) ? 'maestro' : 'adb';
  }

  // whether a step with if/else / when conditions is to run: every condition of its chain must hold,
  // outermost first (an inner one is not looked at once an outer one fails). Each group is evaluated once,
  // on its first member, and remembered in `memo` (the run's; a repeat passes a fresh one per pass).
  async gate(step, v, memo = this.conds) {
    for (const { id, negate, when } of condChain(step)) {
      if (!memo.has(id)) {
        try { memo.set(id, await this.evalCond(when, v, step._on)); } catch (e) {
          if (this.stopped) throw e;
          throw new Error(`could not check the condition ${condText(when)}: ${e.message}`);
        }
      }
      if (memo.get(id) === negate) return false;
    }
    return true;
  }

  // what the remembered conditions already say about a step: true / false, or undefined while one of its
  // chain (up to the first failing one) has not been evaluated yet
  decided(step, memo = this.conds) {
    for (const { id, negate } of condChain(step)) {
      if (!memo.has(id)) return undefined;
      if (memo.get(id) === negate) return false;
    }
    return true;
  }

  async execute() {
    try {
      return await this.executeSteps();
    } finally {
      if (this.web) await this.web.close().catch(() => {});
    }
  }

  async executeSteps() {
    const d = this.device;
    let failed = false;
    // whatever throws, the teardown still runs and the measurement (and Flashlight's child process) is closed
    try {
      await d.clearLogcat();
      if (this.measure) await this.openPerf();
      const steps = this.steps;
      for (let i = 0; i < steps.length; i++) {
        const step = steps[i];
        const rec = this.data.steps[i];
        // after a failure only the teardown still runs; after «Остановить» nothing does
        if (this.stopped || (failed && step._phase !== 'teardown')) { rec.status = 'skipped'; continue; }
        try {
          if (!(await this.gate(step, this.vars()))) { rec.status = 'skipped'; rec.detail = 'condition did not hold'; rec.title = describe(maestro.substDeep(step, (t) => subst(t, this.vars())), this.platform); this.save(); continue; }
          if (this.driverOf(step) === 'maestro') {
            let j = i;
            // the batch stops before a conditional step whose conditions have not all been checked yet
            while (j + 1 < steps.length && this.driverOf(steps[j + 1]) === 'maestro' && steps[j + 1]._phase === step._phase
              && this.decided(steps[j + 1]) !== undefined) j++;
            // members of a group whose condition failed are skipped inside the batch
            const ok = await this.maestroBatch(i, j);
            if (!ok) failed = true;
            i = j;
            continue;
          }
          const ok = await this.runStep(i);
          if (!ok) failed = true;
        } catch (e) {
          // a throw outside a step's own handling (its condition's screen dump, a driver): this step fails
          if (this.stopped) rec.status = 'skipped';
          else { rec.status = 'failed'; rec.error = e.message; failed = true; }
          this.save();
        }
      }
      if (!failed && !this.stopped) {
        const broken = this.checkRules();
        if (broken) { failed = true; this.data.error = broken; }
      }
    } catch (e) {
      failed = true;
      this.data.error = e.message;
    } finally {
      if (this.perf) {
        try { this.data.perf = await this.perf.close(this.data.steps); } catch (e) { this.data.perf = { error: e.message }; }
      } else if (this.measure) this.data.perf = { error: this.platform === 'web' ? 'measurement is for the phone: browser steps are not measured' : 'measurement is Android-only for now' };
      this.data.status = this.stopped ? 'stopped' : failed ? 'failed' : 'passed';
      this.data.finishedAt = new Date().toISOString();
      this.data.pending = null;
      this.save();
    }
    return this.data;
  }

  // Frame, CPU and memory probes for this run; Flashlight's profiler alongside when asked for and installed.
  async openPerf() {
    if (this.platform !== 'android') return;
    const s = this.settings;
    const flashlight = this.measure.flashlight ? new FlashlightCollector({ adbPath: s.adbPath, serial: this.device.serial }) : null;
    this.perf = new PerfSession({ device: this.device, pkg: s.package, flashlight });
    await this.perf.open();
  }

  // Screen steps are measured; backend checks and manual steps are not the app's work.
  async probe(step, rec) {
    if (!this.perf || !MEASURED_TYPES.has(step.type) || rec.driver === 'node' || rec.driver === 'web') return null;
    try { return await this.perf.begin(); } catch (e) { rec.perfError = e.message; return null; }
  }

  async probeEnd(probe, rec) {
    if (!probe) return;
    try { rec.perf = await this.perf.end(probe, rec); } catch (e) { rec.perf = { error: e.message }; }
  }

  // One step through the adb / node drivers, with its retry / optional / flaky policy. Returns false on a failure that counts.
  async runStep(i) {
    const step = localize(this.steps[i], this.platform);
    const d = this.dev(step);
    const s = this.settings;
    const rec = this.data.steps[i];
    rec.status = 'running';
    rec.driver = this.driverOf(step);
    if (rec.driver !== 'node') rec.screen = d.platform === 'web' ? 'web' : 'phone';
    rec.startedAt = new Date().toISOString();
    // the title with the variables of this moment: «Нажать «№123456»» rather than «№{{orderNumber}}»
    rec.title = describe(maestro.substDeep(step, (t) => subst(t, this.vars())), this.platform);
    this.save();
    const t0 = Date.now();
    this.anr = 0;
    const probe = await this.probe(step, rec);
    const attempts = 1 + (Number(step.retry) || 0) + (step.flaky ? 1 : 0);
    let lastError = null;
    for (let a = 1; a <= attempts && !this.stopped; a++) {
      try {
        const v = this.vars();
        const res = step.type === 'repeat' ? await this.repeat(step, rec, v) : await this.step(step, v, rec);
        rec.detail = res && res.detail;
        if (res && res.request) { rec.request = res.request; rec.response = res.response; }
        rec.status = 'passed';
        lastError = null;
        if (a > 1) {
          rec.status = step.flaky ? 'warned' : 'passed';
          rec.detail = [`passed on attempt ${a}${step.flaky ? ' (flaky)' : ''}`, rec.detail].filter(Boolean).join('\n');
        }
        break;
      } catch (e) {
        lastError = e;
        if (a < attempts) { rec.attempts = a; await sleep(1000); }
      }
    }
    if (lastError) {
      rec.error = lastError.message;
      if (step.optional && step.type !== 'tap') { rec.status = 'warned'; rec.detail = 'optional step failed: ' + lastError.message; delete rec.error; }
      else rec.status = 'failed';
    }
    await this.probeEnd(probe, rec);
    rec.ms = Date.now() - t0;
    if (this.anr) rec.appIssues = [{ level: 'warn', text: `Android: the app was not responding (ANR) ${this.anr} time(s), the console pressed "Wait"` }];
    if (rec.status === 'failed' || step.screenshot !== false) await this.shot(rec, d);
    if (d.platform === 'web') rec.url = d.url();
    if (rec.status === 'failed') rec.logcat = await d.logcat(s.package);
    // the phone's network log comes off logcat; the browser collects its page's calls itself
    const calls = d.netCalls ? d.netCalls() : parseNet(await d.takeNetLog(netTag(s)), netTag(s));
    if (calls.length) rec.appCalls = calls;
    if (step.allowStatus) rec.allowStatus = step.allowStatus;
    this.save();
    return rec.status !== 'failed';
  }

  // scenario rules checked over the whole run: `rules: { noServerErrors: true, allowStatus: [...] }`
  checkRules() {
    const rules = this.scenario.rules || {};
    if (!rules.noServerErrors) return null;
    const allow = new Set([...(rules.allowStatus || []), ...(this.settings.allowStatus || [])].map(Number));
    const bad = [];
    for (const rec of this.data.steps) {
      for (const c of rec.appCalls || []) {
        if (c.status >= 500 && !allow.has(c.status) && !(rec.allowStatus || []).includes(c.status)) bad.push(`step ${rec.n}: ${c.method || '?'} ${c.path || '(path hidden)'} → ${c.status}`);
      }
    }
    return bad.length ? `rule noServerErrors: the app received 5xx — ${bad.slice(0, 5).join('; ')}${bad.length > 5 ? ` and ${bad.length - 5} more` : ''}` : null;
  }

  // Steps i..j as one Maestro flow. Returns false when one of them failed.
  async maestroBatch(i, j) {
    const d = this.device;
    const s = this.settings;
    const v = this.vars();
    const sub = (x) => maestro.substDeep(x, (t) => subst(t, v));
    const groups = [];
    const members = []; // step indexes in the batch (a group whose condition failed is left out)
    for (let k = i; k <= j; k++) {
      const raw = this.steps[k];
      if (this.decided(raw) === false) { this.data.steps[k].status = 'skipped'; this.data.steps[k].detail = 'condition did not hold'; continue; }
      const step = localize(raw, this.platform);
      // «Назад» right after typing closes the keyboard under adb; Maestro has already hidden it after
      // inputText, so a real back would leave the form (oformlenie-zakaza, 11-06).
      const prev = this.steps[k - 1];
      const commands = step.type === 'maestro' ? sub(maestro.rawCommands(step))
        : step.type === 'back' && prev && prev.type === 'type' ? ['hideKeyboard']
        : maestro.toCommands(sub(step), s, this.platform);
      groups.push({ key: k + 1, commands, screenshot: step.screenshot !== false, files: step.files });
      this.data.steps[k].title = describe(sub(step), this.platform);
      members.push(k);
    }
    if (!members.length) return true;
    const t0 = new Date().toISOString();
    members.forEach((k, gi) => Object.assign(this.data.steps[k], { status: gi === 0 ? 'running' : 'pending', driver: 'maestro' }));
    this.data.steps[members[0]].startedAt = t0;
    this.save();
    // Maestro echoes each top-level command as it finishes; that moves the «running» mark along.
    const owner = [];
    groups.forEach((g, gi) => { for (let c = 0; c < g.commands.length + (g.screenshot ? 1 : 0); c++) owner.push(gi); });
    let doneTop = 0;
    const onLine = (line) => {
      if (!/\.\.\. (COMPLETED|FAILED|SKIPPED|WARNED)\s*$/.test(line) || /^\s{2,}/.test(line)) return;
      doneTop++;
      const gi = owner[doneTop];
      if (gi === undefined) return;
      const rec = this.data.steps[members[gi]];
      if (rec.status === 'pending') { rec.status = 'running'; rec.startedAt = new Date().toISOString(); this.save(); }
    };
    const env = { ...Object.fromEntries(Object.entries(v).filter(([k, x]) => x != null && typeof x !== 'object' && /^[A-Za-z_]\w*$/.test(k))), API_BASE: s.apiBase || '' };
    // raw flows name the tokens they need: BUYER_TOKEN, SELLER_TOKEN, COURIER_TOKEN… — one per role
    const rawText = JSON.stringify(groups.filter((g, gi) => this.steps[members[gi]].type === 'maestro'));
    for (const role of Object.keys(s.accounts || {})) {
      const name = role.toUpperCase().replace(/\W/g, '_') + '_TOKEN';
      if (rawText.includes(name)) env[name] = roleToken(s, role);
    }
    const name = `steps-${i + 1}-${j + 1}`;
    // the whole flow is one measurement window, recorded on its first step
    const first = this.data.steps[members[0]];
    const probe = this.perf ? await this.probe({ type: 'maestro' }, first) : null;
    let res;
    try {
      res = await maestro.runGroups({ settings: s, serial: d.serial, dir: this.dir, name, groups, env, isStopped: () => this.stopped, onLine, platform: this.platform });
    } catch (e) {
      res = { results: groups.map((g, gi) => (gi === 0 ? { status: 'failed', error: e.message } : { status: 'skipped' })) };
    }
    await this.probeEnd(probe, first);
    if (first.perf && members.length > 1) first.perf.steps = members.map((k) => k + 1);
    const net = parseNet(await d.takeNetLog(netTag(s)), netTag(s));
    let ok = true;
    for (let gi = 0; gi < members.length; gi++) {
      const k = members[gi];
      const step = this.steps[k];
      const rec = this.data.steps[k];
      const r = res.results[gi];
      rec.status = !ok || this.stopped ? 'skipped' : r.status === 'skipped' ? 'skipped' : r.status;
      if (rec.status === 'skipped') { delete rec.startedAt; continue; }
      rec.startedAt = r.startedAt || rec.startedAt || t0;
      rec.ms = r.ms;
      rec.detail = 'via Maestro';
      rec.maestroFlow = `maestro/${name}`;
      if (r.screenshot && fs.existsSync(r.screenshot)) { fs.copyFileSync(r.screenshot, path.join(this.dir, `step-${rec.n}.png`)); rec.screenshot = `step-${rec.n}.png`; }
      if (r.status === 'failed') {
        if (step.optional && step.type !== 'tap') { rec.status = 'warned'; rec.detail = 'optional step failed: ' + r.error; continue; }
        ok = false;
        rec.error = r.error;
        await this.shot(rec);
        rec.logcat = await d.logcat(s.package);
      }
      if (step.allowStatus) rec.allowStatus = step.allowStatus;
    }
    // One network log for the whole flow: each call goes to the step that was running when it was made.
    const ran = members.map((k) => this.data.steps[k]).filter((x) => x.startedAt);
    for (const c of net) {
      const t = new Date(c.t).getTime();
      let owner2 = ran[0];
      for (const x of ran) if (new Date(x.startedAt).getTime() <= t + 500) owner2 = x;
      if (owner2) (owner2.appCalls = owner2.appCalls || []).push(c);
    }
    if (this.stopped) ok = false;
    this.save();
    return ok;
  }

  // `repeat`: its steps run through the adb / node drivers until the condition holds (or `times` is reached)
  async repeat(step, rec, v) {
    const max = Number(step.times) || Number(step.max) || 10;
    const log = [];
    for (let n = 1; n <= max; n++) {
      if (this.stopped) throw new Error('stopped');
      if (step.until && await this.evalCond(step.until, this.vars(), step._on)) { rec.iterations = n - 1; return { detail: `condition held after ${n - 1} repeats` + (log.length ? '\n' + log.join('\n') : '') }; }
      const memo = new Map(); // the body's if/when are looked at afresh on every pass, once per group
      for (const sub of step.steps || []) {
        const local = localize(sub, this.platform);
        if (!(await this.gate({ ...local, _on: local._on || step._on }, this.vars(), memo))) { log.push(`${n}: ${describe(local, this.platform)} — skipped`); continue; }
        const r = await this.step(local, this.vars(), rec);
        log.push(`${n}: ${describe(local, this.platform)}${r && r.detail ? ' — ' + String(r.detail).split('\n')[0] : ''}`);
      }
      rec.iterations = n;
      if (!step.until && step.times && n >= Number(step.times)) return { detail: `repeated ${n} times\n` + log.join('\n') };
    }
    if (step.until) throw new Error(`after ${max} repeats still not: ${condText(step.until)}\n` + log.slice(-6).join('\n'));
    return { detail: `repeated ${max} times\n` + log.join('\n') };
  }

  async step(step, v, rec) {
    const d = this.dev(step);
    const s = this.settings;
    const stopped = () => this.stopped;
    const appId = this.platform === 'ios' ? s.bundleId : s.package;
    switch (step.type) {
      case 'launch': {
        if (d.platform === 'web') {
          // a page: `url` (or the site address from the settings), `storage` → localStorage before it loads
          const storage = step.storage ? maestro.substDeep(step.storage, (t) => subst(t, v)) : null;
          await d.launch(subst(step.url, v), null, { clear: !!step.clear, storage });
          await sleep((Number(step.settle) || 1) * 1000);
          return { detail: d.url() };
        }
        const out = await d.launch(appId, s.activity, { clear: !!step.clear });
        const start = parseAmStart(out);
        if (start && rec) rec.launch = start; // cold start as the framework timed it
        await sleep((Number(step.settle) || 3) * 1000);
        await this.screen().catch(() => {});
        return start ? { detail: `${start.state === 'COLD' ? 'cold start' : 'start'} ${start.totalMs} ms` } : undefined;
      }
      case 'tap': {
        const target = subst(step.target, v);
        const opts = { by: step.by };
        // a found but disabled element (a page still busy) is waited for like an absent one
        const r = await waitFor(async () => {
          const n = findNode(await this.screen(d), target, opts);
          return { ok: !!n && !n.disabled, n };
        }, step.timeout, stopped);
        if (!r.ok && r.n && r.n.disabled) {
          if (step.optional) return { detail: `"${target}" stayed disabled — skipped` };
          throw new Error(`"${target}" stayed disabled the whole time`);
        }
        if (!r.ok && Array.isArray(step.fallback)) {
          // WebView content (the bank stub page) is not always in uiautomator's tree.
          await d.tap(step.fallback[0], step.fallback[1]);
          await sleep(step.after != null ? Number(step.after) * 1000 : 1200);
          return { detail: `"${target}" is not in the screen tree — tapped at (${step.fallback.join(', ')})` };
        }
        if (!r.ok) {
          if (step.optional) return { detail: `"${target}" did not appear — skipped` };
          throw new Error(`could not find "${target}" on screen\non screen: ${(await this.screen(d).catch(() => [])).map((n) => n.text || n.desc).filter(Boolean).slice(0, 25).join(' · ') || '—'}`);
        }
        const x = r.n.x + (Number(step.dx) || 0), y = r.n.y + (Number(step.dy) || 0);
        // a page clicks the element itself (its panel scrolls it clear of fixed bars); a phone taps the point
        const press = () => (d.tapNode ? d.tapNode(r.n, Number(step.dx) || 0, Number(step.dy) || 0) : d.tap(x, y));
        await press();
        if (step.double) { await sleep(150); await press(); }
        await sleep(step.after != null ? Number(step.after) * 1000 : 1200);
        return { detail: `tapped at (${x}, ${y})` };
      }
      case 'type': {
        const text = subst(step.text, v);
        if (step.target) {
          const target = subst(step.target, v);
          const r = await waitFor(async () => {
            const n = findNode(await this.screen(d), target, { by: step.by });
            return { ok: !!n, n };
          }, step.timeout, stopped);
          if (!r.ok) throw new Error(`could not find field "${target}"`);
          if (d.tapNode) await d.tapNode(r.n); else await d.tap(r.n.x, r.n.y);
          await sleep(500);
        }
        if (step.clear !== false) {
          // Prefilled fields would otherwise get the text appended: jump to the end and erase.
          if (d.clearField) await d.clearField();
          else {
            await d.key(123);
            await d.shell('input keyevent ' + Array(40).fill(67).join(' '));
          }
        }
        await d.typeText(text);
        if (step.enter) await d.key(66);
        await sleep(800);
        return;
      }
      case 'swipe': {
        let atY;
        if (step.target && ['left', 'right'].includes(step.direction)) {
          const target = subst(step.target, v);
          const r = await waitFor(async () => {
            const n = findNode(await this.screen(d), target);
            return { ok: !!n, n };
          }, step.timeout, stopped);
          if (!r.ok) throw new Error(`could not find row "${target}" to swipe`);
          atY = r.n.y;
        }
        // `times` swipes back to back; `fast` flings with a short pause so the list never settles
        const times = Math.max(1, Number(step.times) || 1);
        const pauseMs = step.pause != null ? Number(step.pause) * 1000 : step.fast ? 250 : 1000;
        for (let k = 0; k < times; k++) {
          if (this.stopped) throw new Error('stopped');
          await d.swipe(step.direction || 'down', atY, { fast: !!step.fast, durationMs: step.duration });
          await sleep(pauseMs);
        }
        return times > 1 ? { detail: `${step.fast ? 'flings' : 'swipes'} in a row: ${times}, pause ${pauseMs} ms` } : undefined;
      }
      case 'link':
        await d.openLink(appId, subst(step.url, v));
        await sleep((Number(step.settle) || 4) * 1000);
        return;
      case 'back':
        await d.key(4);
        await sleep(800);
        return;
      case 'wait':
        await sleep((Number(step.seconds) || 1) * 1000);
        return;
      case 'assertText': {
        const by = step.id ? 'id' : step.by;
        const text = subst(step.id || step.text, v);
        const opts = { by, regex: !!step.regex };
        const wantCount = step.count != null ? Number(step.count) : null;
        let seenCount = 0;
        let seen = [];
        const r = await waitFor(async () => {
          const found = findNodes(await this.screen(d), text, opts);
          seenCount = found.length;
          seen = found;
          if (wantCount !== null) return { ok: found.length === wantCount };
          return { ok: step.absent ? !found.length : found.length > 0 };
        }, step.timeout, stopped);
        if (!r.ok) {
          const seen = (await d.screenText().catch(() => [])).slice(0, 25).join(' · ');
          if (wantCount !== null) throw new Error(`on screen ${seenCount} × "${text}", expected ${wantCount}\non screen: ${seen || '—'}`);
          throw new Error(step.absent ? `"${text}" is still on screen` : `waited for "${text}" on screen\non screen: ${seen || '—'}`);
        }
        // on a page the checked text is scrolled into the window, so the screenshot shows it
        if (d.reveal && seen[0] && !step.absent) await d.reveal(seen[0]).catch(() => {});
        return wantCount !== null ? { detail: `found ${seenCount}` } : undefined;
      }
      case 'assertScreen':
        return this.assertScreen(step, rec);
      case 'api':
        return this.api(step, v);
      case 'browser':
      case 'phone':
        throw new Error('a browser/phone group is unfolded before the run — this step should not be here');
      case 'ai': {
        this.data.status = 'paused';
        this.data.pending = { n: this.data.steps.findIndex((x) => x.status === 'running') + 1, text: subst(step.text, v) };
        this.save();
        const answer = await new Promise((resolve) => { this.resumeFn = resolve; });
        this.resumeFn = null;
        this.data.status = 'running';
        this.data.pending = null;
        if (!answer.ok) throw new Error(answer.note || 'step marked as failed');
        return { detail: answer.note || undefined };
      }
      case 'maestro':
        throw new Error('a Maestro step runs only through Maestro');
      case 'repeat':
        return this.repeat(step, rec || {}, v);
      default:
        throw new Error('unknown step type: ' + step.type);
    }
  }

  // The screen against a saved baseline (data/baselines/<scenario>/<name>.png). The first run saves it.
  async assertScreen(step, rec) {
    const name = String(subst(step.baseline, this.vars()) || `step-${rec.n}`).replace(/[^\p{L}\p{N}_.-]+/gu, '_');
    const dir = path.join(this.settings.baselinesDir || path.join(path.dirname(this.dir), '..', 'baselines'), this.scenario.id || 'scenario');
    fs.mkdirSync(dir, { recursive: true });
    const baseline = path.join(dir, name + '.png');
    const actual = path.join(this.dir, `step-${rec.n}.png`);
    await this.dev(step).screenshot(actual);
    rec.screenshot = `step-${rec.n}.png`;
    rec.baseline = name;
    if (!fs.existsSync(baseline)) {
      fs.copyFileSync(actual, baseline);
      return { detail: `no baseline "${name}" yet — saved this screen as the baseline` };
    }
    const diffFile = path.join(this.dir, `step-${rec.n}.diff.png`);
    const r = screenshot.compare(actual, baseline, diffFile, { ignore: step.ignore || this.settings.screenIgnore || [] });
    rec.diff = `step-${rec.n}.diff.png`;
    rec.mismatch = r.mismatch;
    const limit = step.threshold != null ? Number(step.threshold) : 0.01;
    if (r.sizeDiffers) throw new Error(`screen size ${r.width}×${r.height} does not match the baseline ${r.baselineWidth}×${r.baselineHeight}`);
    if (r.mismatch > limit) throw new Error(`screen differs from baseline "${name}" by ${(r.mismatch * 100).toFixed(2)}% (threshold ${(limit * 100).toFixed(2)}%)`);
    return { detail: `matches baseline "${name}", mismatch ${(r.mismatch * 100).toFixed(2)}%` };
  }

  async api(step, v) {
    const s = this.settings;
    let url = subst(step.url || '', v);
    if (!/^https?:\/\//.test(url)) url = String(s.apiBase || '').replace(/\/$/, '') + '/' + url.replace(/^\//, '');
    const headers = { accept: 'application/json' };
    const role = step.auth || defaultRole(s);
    const token = role === 'none' ? '' : roleToken(s, role);
    if (role !== 'none' && !token) throw new Error(`no token for role "${role}": add it in Settings (accounts) — a token, or a phone for the login plugin`);
    if (token) headers.authorization = 'Bearer ' + token;
    for (const [k, val] of Object.entries(step.headers || {})) headers[k.toLowerCase()] = subst(val, v);
    let body;
    if (step.body) {
      body = subst(typeof step.body === 'string' ? step.body : JSON.stringify(step.body), v);
      headers['content-type'] = headers['content-type'] || 'application/json';
    }
    const want = step.expectPath ? subst(String(step.expectValue ?? ''), v) : null;
    const expectPath = subst(step.expectPath, v);
    let last = {};
    const method = String(step.method || 'GET').toUpperCase();
    const attempt = async () => {
      try {
        const res = await fetch(url, { method, headers, body, signal: AbortSignal.timeout(15000) });
        const text = await res.text();
        let json; try { json = JSON.parse(text); } catch { json = undefined; }
        const okStatus = step.expectStatus ? res.status === Number(step.expectStatus) : res.ok;
        const got = expectPath ? pick(json, expectPath) : undefined;
        // A value to save that is not there yet (a tracking number, a task) is waited for like an expectation.
        const missing = Object.values(step.save || {}).find((p) => pick(json, subst(p, v)) == null);
        last = { status: res.status, json, text, got, missing };
        // "a|b" accepts either value: a refund that may settle as refunded or partially_refunded.
        return { ok: okStatus && (want === null || want.split('|').includes(String(got))) && !missing };
      } catch (e) {
        // undici says only "fetch failed"; the reason (ECONNRESET, ENOTFOUND, a TLS error) is in its cause
        const c = e.cause;
        const why = c ? [c.code, c.message].filter(Boolean).join(': ') : '';
        last = { error: e.message + (why && !e.message.includes(why) ? ` (${why})` : '') };
        return { ok: false };
      }
    };
    // `poll: 60` keeps asking until the expectation holds (same as timeout, said plainly). A GET polls by
    // default; a POST/PUT/PATCH/DELETE is sent once unless `poll` is set: re-sending it would create another
    // order or cart line.
    const polls = method === 'GET' || method === 'HEAD' || step.poll != null;
    const r = polls ? await waitFor(attempt, step.poll || step.timeout || 5, () => this.stopped) : await attempt();
    const shown = last.error ? last.error : `HTTP ${last.status}${expectPath ? `, ${expectPath} = ${JSON.stringify(last.got)}` : ''}`;
    if (!r.ok) {
      const tail = last.text ? '\n' + last.text.slice(0, 800) : '';
      const miss = last.missing ? `, the response has no "${subst(last.missing, v)}"` : '';
      throw new Error(`${step.method || 'GET'} ${url}: ${shown}${want !== null ? `, expected ${want}` : ''}${miss}${tail}`);
    }
    for (const [name, rawPath] of Object.entries(step.save || {})) {
      const p = subst(rawPath, v);
      const val = pick(last.json, p);
      if (val === undefined) throw new Error(`the response has no "${p}" for variable ${name}`);
      this.data.vars[name] = val;
    }
    return { detail: shown, request: `${step.method || 'GET'} ${url}${body ? '\n' + body.slice(0, 1500) : ''}`, response: (last.text || '').slice(0, 4000) };
  }
}

module.exports = { Run, describe, STEP_LABELS, pick, subst, perPlatform };
