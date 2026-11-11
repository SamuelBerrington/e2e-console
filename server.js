'use strict';
// Local E2E console: scenarios, runs and screenshots over a tiny JSON API plus the web UI.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { Run } = require('./lib/runner');
const { devices, startEmulator, Device } = require('./lib/adb');
const adb = require('./lib/adb');
const auth = require('./lib/auth');
const backendLogs = require('./lib/backendLogs');
const appNet = require('./lib/appNet');
const formats = require('./lib/formats');
const maestro = require('./lib/maestro');
const { zip } = require('./lib/zip');
const { lint, jsonSchema } = require('./lib/lint');
const { compile, rowLabel, variantsOf, defaultRole } = require('./lib/compile');
const perf = require('./lib/perf');
const { normalizeMeasure } = perf;
const chips = require('./lib/chips');
const perfSummary = require('./lib/perfSummary');
const ios = require('./lib/ios');
const web = require('./lib/web');
const YAML = require('yaml');

// `node server.js [--port 4778] [--data data-bare]` (or PORT / E2E_DATA): a second console next to the first,
// e.g. a bare one with an empty data folder to see what a newcomer sees.
const argv = process.argv.slice(2);
const arg = (name) => { const i = argv.indexOf('--' + name); return i >= 0 ? argv[i + 1] : undefined; };
const PORT = Number(arg('port')) || Number(process.env.PORT) || 4777;
const ROOT = __dirname;
const DATA = path.resolve(ROOT, arg('data') || process.env.E2E_DATA || 'data');
const SCEN = path.join(DATA, 'scenarios');
const RUNS = path.join(DATA, 'runs');
const SETTINGS = path.join(DATA, 'settings.json');
const FIGMA = path.join(DATA, 'figma');
const BLOCKS = path.join(DATA, 'blocks');
const BASELINES = path.join(DATA, 'baselines');
const PUBLIC = path.join(ROOT, 'public');
for (const d of [DATA, SCEN, RUNS, FIGMA, BLOCKS, BASELINES]) fs.mkdirSync(d, { recursive: true });

// ANDROID_HOME → ANDROID_SDK_ROOT → the platform's SDK folder → PATH (lib/adb.js sdkTool)
const DEFAULT_SETTINGS = {
  adbPath: adb.sdkTool('adb'),
  emulatorPath: adb.sdkTool('emulator'),
  avd: '',
  serial: '',
  package: '',
  activity: '',
  // iOS: the app's bundle id (the screen is driven by Maestro there)
  bundleId: '',
  apkPath: '',
  appName: '',
  envName: '',
  apiBase: '',
  apiToken: '',
  sellerToken: '',
  figmaToken: '',
  vars: {},
  // {{name}} → this text, expanded on every use (lib/runner.js subst)
  templates: {},
  engine: 'adb',
  maestro: { path: '', javaHome: '' },
  // the browser engine (Playwright over the installed Chrome/Edge): the site `launch` opens by default,
  // the browser to use (empty = the first one found), headless or a visible window, the page size
  webUrl: '',
  web: { browserPath: '', headless: true, width: 1280, height: 800, locale: '' },
  // tabs on the scenario list: [{ id, name, kind: 'tests' | 'perf' }]; empty = the two built-in shelves
  tabs: [],
  // named accounts for backend checks: `auth: <role>` on a step; `appAccount` is the one the app itself is signed in as
  accounts: {},
  // autoToken: before each run, refresh (or mint) the API tokens through the login plugin (lib/auth.js)
  autoToken: false,
  auth: { plugin: '', appAccount: 'buyer' },
  // known devices: [{ serial, platform: 'android' | 'ios', name }]; adb and simctl find the connected ones anyway
  devices: [],
  // shell commands run by «Подготовить» on a device before measuring (after `adb root` where it works), e.g. the
  // emulator's spinning radio HAL: "stop vendor.radio-ranchu"
  emulatorHygiene: [],
  // HTTP statuses the «no 5xx» rule tolerates; screen areas (x1,y1,x2,y2) the baseline compare ignores
  allowStatus: [],
  screenIgnore: [],
  // the app's own HTTP log in logcat; an empty tag turns it off
  appNet: { tag: '' },
  // screenshots of earlier runs: 'all' keeps them; 'latest' — a new start of a scenario drops the screenshots of its
  // earlier runs (statuses, timings and scores stay)
  runs: { screenshots: 'all' },
  logs: { enabled: false, kubeconfig: '', namespace: '', service: '', port: 9428, filter: '', limit: 5000 }
};
const NESTED = ['logs', 'maestro', 'auth', 'appNet', 'web', 'runs'];

// writes go through a temp file + rename; settings.json that exists but does not parse is an error, never "{}" —
// otherwise the next save would write the defaults over every account and token
const { readJson, writeJson, readJsonStrict } = require('./lib/jsonfile');
function settings() {
  const saved = readJsonStrict(SETTINGS, {});
  const out = { ...DEFAULT_SETTINGS, ...saved };
  for (const k of NESTED) out[k] = { ...DEFAULT_SETTINGS[k], ...(saved[k] || {}) };
  out.accounts = { ...(saved.accounts || {}) };
  return out;
}
// Once at start: settings from before named accounts keep buyer / seller in flat keys (apiToken, sellerToken,
// refreshToken…). They move into accounts and leave the file, so a role deleted later cannot come back from them.
// Called only once the data folder is locked: a second console that is refused must not rewrite the first one's file.
function migrateSettings() {
  try {
    const migrated = formats.migrateLegacy(readJsonStrict(SETTINGS, {}));
    if (migrated) { writeJson(SETTINGS, migrated); console.log('[e2e-console] settings: old buyer/seller keys moved into accounts'); }
  } catch (e) { console.error('[e2e-console] settings: could not migrate the old keys —', e.message); }
}
// A patch of the saved settings: nested groups merge key by key (accounts per role); with `deep`, vars and templates too.
function mergeSettings(cur, patch, deep = false) {
  const next = { ...cur };
  const renamed = {};
  for (const [k, v] of Object.entries(patch || {})) {
    if (k === 'accounts' && v && typeof v === 'object') {
      next.accounts = {};
      for (const [role, a] of Object.entries(v)) {
        if (!a) continue;
        // a row renamed in the table says where it came from, so what the table does not show (refreshToken) moves along
        const { renamedFrom, ...fields } = a;
        const was = (cur.accounts || {})[role] || (renamedFrom && (cur.accounts || {})[renamedFrom]) || {};
        if (renamedFrom && !(cur.accounts || {})[role]) renamed[renamedFrom] = role;
        next.accounts[role] = { ...was, ...fields };
      }
      // the UI sends the whole table: a role left out is removed, unless this is an import (deep), which only adds
      if (deep) for (const [role, a] of Object.entries(cur.accounts || {})) if (!next.accounts[role]) next.accounts[role] = a;
      continue;
    }
    // an import adds its tabs and replaces the ones with the same id; the user's own tabs stay
    if (k === 'tabs' && deep && Array.isArray(v)) {
      const mine = Array.isArray(cur.tabs) ? cur.tabs : [];
      const byId = new Map(v.filter((x) => x && x.id).map((x) => [x.id, x]));
      const have = new Set(mine.map((x) => x && x.id));
      next.tabs = [...mine.map((x) => (x && byId.get(x.id)) || x), ...v.filter((x) => !x || !have.has(x.id))];
      continue;
    }
    const nested = NESTED.includes(k) || (deep && (k === 'vars' || k === 'templates'));
    next[k] = nested && v && typeof v === 'object' ? { ...(cur[k] || {}), ...v } : v;
  }
  // the app's own account follows its role through a rename
  const app = next.auth && next.auth.appAccount;
  if (app && renamed[app] && !(next.accounts || {})[app]) next.auth = { ...next.auth, appAccount: renamed[app] };
  return next;
}

// ---------- shared blocks: data/blocks/*.yaml ----------
// A file is either one block ({ params, steps }, named after the file) or a map of blocks.
function loadBlocks() {
  const library = {};
  const warnings = [];
  for (const f of fs.readdirSync(BLOCKS).filter((x) => /\.ya?ml$/i.test(x)).sort()) {
    try {
      const doc = YAML.parse(fs.readFileSync(path.join(BLOCKS, f), 'utf8'));
      if (!doc || typeof doc !== 'object') continue;
      const entries = Array.isArray(doc.steps) ? [[path.basename(f).replace(/\.ya?ml$/i, ''), doc]] : Object.entries(doc);
      for (const [name, b] of entries) {
        const block = Array.isArray(b) ? { steps: b } : (b || {});
        library[name] = { ...(block.params ? { params: block.params } : {}), steps: formats.normalizeSteps(block.steps || [], warnings, `${f} → ${name}`) };
      }
    } catch (e) { warnings.push(`${f}: ${e.message}`); }
  }
  return { library, warnings };
}
const LIBRARY_FILE = path.join(BLOCKS, 'library.yaml');

function lintScenario(sc) {
  const s = settings();
  const lastRun = listRuns().find((r) => r.scenarioId === sc.id && ['passed', 'failed'].includes(r.status));
  const { library, warnings } = loadBlocks();
  const r = lint(sc, { settings: s, library, lastRun: lastRun ? loadRun(lastRun.id) : null });
  r.warnings.push(...warnings.map((w) => 'block library: ' + w));
  return r;
}

// Logs reach VictoriaLogs a few seconds late, so the live poll trails "now" and a final pass
// after the run picks up the tail. Lines are saved to logs.json next to the screenshots.
const LOG_LAG_MS = 5000;
const LOG_TAIL_MS = 12000;

function logSummary(lines) {
  return {
    total: lines.length,
    errors: lines.filter((l) => l.level === 'ERROR' || l.level === 'FATAL').length,
    warns: lines.filter((l) => l.level === 'WARN' || l.level === 'WARNING').length
  };
}

async function collectRunLogs(run, s) {
  if (!s.logs.enabled || !s.logs.service) return;
  const file = path.join(RUNS, run.data.id, 'logs.json');
  const from = new Date(run.data.startedAt).getTime() - 2000;
  let cursor = from;
  let lines = [];
  const pull = async (to) => {
    if (to <= cursor) return;
    const got = await backendLogs.fetchLogs(s, cursor, to);
    lines = lines.concat(got);
    cursor = to;
    writeJson(file, lines);
    run.data.backendIssues = appNet.enrich(run.data.steps, lines, s.backendIgnore);
    run.data.logs = { status: run.data.finishedAt ? 'collecting' : 'live', ...logSummary(lines) };
    run.save();
  };
  try {
    run.data.logs = { status: 'live', total: 0, errors: 0, warns: 0 };
    run.save();
    while (!run.data.finishedAt) {
      await new Promise((r) => setTimeout(r, 8000));
      await pull(Date.now() - LOG_LAG_MS);
    }
    await new Promise((r) => setTimeout(r, LOG_TAIL_MS));
    await pull(new Date(run.data.finishedAt).getTime() + LOG_TAIL_MS - LOG_LAG_MS);
    run.data.logs = { status: 'done', ...logSummary(lines) };
  } catch (e) {
    run.data.logs = { status: 'error', error: e.message, ...logSummary(lines) };
  }
  run.save();
}

// Re-reads the whole window of a finished run, e.g. when the live pass could not reach the cluster.
async function refetchRunLogs(id) {
  const s = settings();
  const data = loadRun(id);
  if (!data || !data.finishedAt) { const e = new Error('the run has not finished yet'); e.status = 409; throw e; }
  const lines = await backendLogs.fetchLogs(s, new Date(data.startedAt).getTime() - 2000, new Date(data.finishedAt).getTime() + LOG_TAIL_MS);
  writeJson(path.join(RUNS, id, 'logs.json'), lines);
  data.backendIssues = appNet.enrich(data.steps, lines, s.backendIgnore);
  data.logs = { status: 'done', ...logSummary(lines) };
  writeJson(path.join(RUNS, id, 'run.json'), data);
  return data.logs;
}
function safeId(s) {
  return /^[a-z0-9][a-z0-9_-]{0,80}$/i.test(String(s || '')) ? String(s) : null;
}
function slug(name) {
  const map = { а:'a',б:'b',в:'v',г:'g',д:'d',е:'e',ё:'e',ж:'zh',з:'z',и:'i',й:'y',к:'k',л:'l',м:'m',н:'n',о:'o',п:'p',р:'r',с:'s',т:'t',у:'u',ф:'f',х:'h',ц:'c',ч:'ch',ш:'sh',щ:'sch',ы:'y',э:'e',ю:'yu',я:'ya' };
  const s = String(name || '').toLowerCase().split('').map((c) => map[c] ?? c).join('')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50);
  return s || 'scenario';
}

function listScenarios() {
  return fs.readdirSync(SCEN).filter((f) => f.endsWith('.json'))
    .map((f) => readJson(path.join(SCEN, f), null)).filter(Boolean)
    .sort((a, b) => (a.order ?? 999) - (b.order ?? 999) || a.name.localeCompare(b.name));
}
function loadRun(id) {
  return readJson(path.join(RUNS, id, 'run.json'), null);
}
// an emulator run gets the forecast for phones from the current calibration (numbers only when the
// calibration is checked fit for this run, see perf.calibrationCheck); a phone run gets its chip
function withForecast(r) {
  if (!r || !r.perf || !r.perf.device) return r;
  const s = settings();
  const extra = (s.perf || {}).chips;
  const chip = chips.lookup(r.perf.device, extra);
  const out = { ...r, perf: { ...r.perf, chip: chip || undefined } };
  if (r.perf.device.emulator) out.perf.forecast = perf.forecast(r.perf, s.perf, chips.examples(extra), r) || undefined;
  if (!out.perf.forecast && r.perf.device.emulator) out.perf.calibration = s.perf && s.perf.k ? 'ok' : 'none';
  return out;
}
function listRuns() {
  return fs.readdirSync(RUNS).map(loadRun).filter(Boolean)
    .map(({ steps, vars, ...r }) => ({
      ...r,
      total: steps.length,
      passedSteps: steps.filter((s) => s.status === 'passed').length,
      failedStep: (steps.find((s) => s.status === 'failed') || {}).n || null,
      thumb: (steps.slice().reverse().find((s) => s.screenshot) || {}).screenshot || null
    }))
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

// ---------- cleaning up old runs ----------
const isLiveRun = (id) => !!activeRun(id) || queue.some((j) => j.id === id);
function pngsOf(dir) {
  const out = [];
  const walk = (d) => {
    let list = [];
    try { list = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of list) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (/.png$/i.test(e.name)) { let size = 0; try { size = fs.statSync(p).size; } catch { /* gone */ } out.push({ p, size }); }
    }
  };
  walk(dir);
  return out;
}
function dirSize(dir) {
  let n = 0;
  const walk = (d) => {
    let list = [];
    try { list = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of list) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p); else { try { n += fs.statSync(p).size; } catch { /* gone */ } }
    }
  };
  walk(dir);
  return n;
}
// Removes a finished run's screenshots (every .png in its folder) and keeps the rest: statuses, timings, scores, logs.
function dropScreenshots(id, dry = false) {
  const dir = path.join(RUNS, id);
  const files = pngsOf(dir);
  const bytes = files.reduce((a, f) => a + f.size, 0);
  if (dry || !files.length) return bytes;
  for (const f of files) { try { fs.rmSync(f.p, { force: true }); } catch { /* locked: left for the next pass */ } }
  const run = loadRun(id);
  if (run) {
    for (const st of run.steps || []) { delete st.screenshot; delete st.diff; }
    run.screenshotsDropped = new Date().toISOString();
    writeJson(path.join(dir, 'run.json'), run);
  }
  return bytes;
}
// `runs.screenshots: latest`: a new start of a scenario drops the screenshots of its earlier finished runs
function dropEarlierScreenshots(scenarioId) {
  const head = String(scenarioId).slice(0, 55);
  for (const id of fs.readdirSync(RUNS)) {
    if (!id.slice(15).startsWith(head) || isLiveRun(id)) continue;
    const run = loadRun(id);
    if (!run || run.scenarioId !== scenarioId || run.screenshotsDropped) continue;
    try { dropScreenshots(id); } catch (e) { console.error('[e2e-console] could not drop the screenshots of ' + id + ': ' + e.message); }
  }
}
// Bulk clean-up. `keep`: the newest N runs of every scenario stay; `olderThanDays`: only runs older than that go;
// both given — a run goes when it is past both. `what`: 'runs' deletes the run, 'screenshots' only its pictures.
// A measured run never goes whole: its score feeds the history, so it loses the screenshots only.
function pruneRuns({ keep, olderThanDays, what = 'runs', scenarioId, dryRun = false } = {}) {
  const keepN = Number.isInteger(keep) && keep >= 0 ? keep : null;
  const days = Number(olderThanDays) > 0 ? Number(olderThanDays) : null;
  if (keepN === null && days === null) { const e = new Error('give "keep" (runs to leave per scenario) or "olderThanDays"'); e.status = 400; throw e; }
  if (!['runs', 'screenshots'].includes(what)) { const e = new Error('"what" is "runs" or "screenshots"'); e.status = 400; throw e; }
  const before = days === null ? null : Date.now() - days * 864e5;
  const seen = {};
  const out = { runs: 0, screenshots: 0, bytes: 0, dryRun: !!dryRun };
  const all = fs.readdirSync(RUNS).map((id) => loadRun(id)).filter(Boolean).sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)));
  for (const r of all) {
    if (scenarioId && r.scenarioId !== scenarioId) continue;
    const rank = (seen[r.scenarioId] = (seen[r.scenarioId] || 0) + 1);
    if (keepN !== null && rank <= keepN) continue;
    if (before !== null && !(new Date(r.startedAt).getTime() < before)) continue;
    if (isLiveRun(r.id) || ['running', 'paused', 'queued'].includes(r.status)) continue;
    const dir = path.join(RUNS, r.id);
    if (what === 'runs' && !r.measure) {
      out.bytes += dirSize(dir);
      out.runs++;
      if (!dryRun) fs.rmSync(dir, { recursive: true, force: true });
    } else {
      if (r.screenshotsDropped) continue;
      const bytes = dropScreenshots(r.id, dryRun);
      if (bytes) { out.bytes += bytes; out.screenshots++; }
    }
  }
  return out;
}

// A run left running by a crash or restart can never finish. Called once the port is ours and the data folder is
// locked, so a second console that fails to start never touches the first one's live runs.
function recoverRuns() {
  for (const r of fs.readdirSync(RUNS)) {
    const run = loadRun(r);
    if (run && ['running', 'paused', 'queued'].includes(run.status)) {
      const was = run.status;
      run.status = 'stopped';
      run.pending = null;
      run.finishedAt = run.finishedAt || new Date().toISOString();
      run.error = run.error || (was === 'queued' ? 'the console restarted while this run waited in the queue — start it again' : 'the console restarted during this run — start it again');
      run.steps.forEach((s) => { if (['running', 'pending'].includes(s.status)) s.status = 'skipped'; });
      writeJson(path.join(RUNS, r, 'run.json'), run);
    }
    if (run && run.logs && ['live', 'collecting'].includes(run.logs.status)) {
      run.logs = { ...run.logs, status: 'error', error: 'the console restarted while collecting logs — press "Refresh logs"' };
      writeJson(path.join(RUNS, r, 'run.json'), run);
    }
  }
}

// ---------- devices, queue ----------
// connected devices: adb's (android), booted simulators (ios), named from settings.devices — and the
// browser as one more "device" (serial `web`) when a Chrome/Edge is on this computer
async function allDevices(s) {
  const known = new Map((s.devices || []).map((d) => [d.serial, d]));
  const out = [];
  for (const serial of await devices(s.adbPath).catch(() => [])) out.push({ serial, platform: 'android', name: (known.get(serial) || {}).name || serial });
  for (const d of await ios.devices()) out.push({ serial: d.serial, platform: 'ios', name: (known.get(d.serial) || {}).name || d.name });
  const b = web.probe(s);
  if (b.ok) out.push({ serial: 'web', platform: 'web', name: b.name });
  return out;
}
const phonesOf = (list) => list.filter((d) => d.platform !== 'web');

// One run at a time per device; jobs wait in the queue for a device that is free and fits.
const active = new Map(); // serial → Run
const queue = []; // { id, scenario, device: serial | 'any', vars, label, engine }
const activeRun = (id) => [...active.values()].find((r) => r.data.id === id) || null;

async function startRun(scenarioId, opts = {}) {
  const scenario = readJson(path.join(SCEN, scenarioId + '.json'), null);
  if (!scenario) { const e = new Error('no such scenario'); e.status = 404; throw e; }
  if (['adb', 'maestro', 'web'].includes(opts.engine)) scenario.engine = opts.engine;
  const check = lintScenario(scenario);
  if (check.errors.length && !opts.force) { const e = new Error('the scenario fails the check: ' + check.errors.slice(0, 3).join('; ')); e.status = 400; e.lint = check; throw e; }
  const s = settings();
  const list = await allDevices(s);
  const phones = phonesOf(list);
  const compiled = compile(scenario, { library: loadBlocks().library });
  // what the scenario needs: a phone for its phone screen steps (and any measurement), the browser for
  // steps that run in it; a scenario with browser steps only takes the `web` slot and no phone
  const isScreen = (st) => !['api', 'ai'].includes(st.type);
  const needsPhone = compiled.steps.some((st) => isScreen(st) && st._on !== 'web') || !!(opts.measure || scenario.measure);
  const needsWeb = compiled.steps.some((st) => st._on === 'web');
  if (needsWeb && !list.some((d) => d.platform === 'web')) { const e = new Error('the browser engine is not available: ' + (web.probe(s).error || 'no browser')); e.status = 409; throw e; }
  if (needsPhone && !phones.length) { const e = new Error('no emulator or phone connected'); e.status = 409; throw e; }
  let targets;
  if (!needsPhone) targets = [needsWeb || !phones.length ? 'web' : 'any'];
  else if (opts.device === 'all') targets = phones.map((d) => d.serial);
  else if (opts.device && !['any', 'web'].includes(opts.device)) {
    if (!phones.some((d) => d.serial === opts.device)) { const e = new Error(`device ${opts.device} is not connected`); e.status = 409; throw e; }
    targets = [opts.device];
  } else if (s.serial && phones.some((d) => d.serial === s.serial)) targets = [s.serial];
  else targets = ['any'];
  if (targets[0] === 'web' && !list.some((d) => d.platform === 'web')) { const e = new Error('no emulator or phone connected, and no browser for the backend checks'); e.status = 409; throw e; }
  // a measured series must stay on one device: «any» is resolved now, not per job in the queue
  if ((opts.measure || scenario.measure) && targets[0] === 'any') {
    const pick = phones.find((d) => d.platform === 'android' && !active.has(d.serial)) || phones.find((d) => d.platform === 'android') || phones[0];
    targets = [pick.serial];
  }
  const rows = compiled.rows;
  const variants = rows.length ? rows.map((vars) => ({ vars, label: rowLabel(vars) })) : [{ vars: {}, label: '' }];
  // `measure: true` in the scenario, or «Замер» on the run; several iterations are several queued runs
  const measure = normalizeMeasure(scenario.measure, opts.measure ? { iterations: opts.iterations, flashlight: opts.flashlight } : null);
  const reps = measure ? measure.iterations : 1;
  // variants of the scenario (app modes): one run each, or just the one asked for
  const vlist = variantsOf(scenario).filter((v) => !opts.variant || v.name === opts.variant);
  if (!vlist.length) { const e = new Error(`the scenario has no variant "${opts.variant}"`); e.status = 400; throw e; }
  if ((s.runs || {}).screenshots === 'latest') dropEarlierScreenshots(scenarioId);
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const started = [];
  let n = 0;
  const many = targets.length * variants.length * reps * vlist.length > 1;
  for (const device of targets) {
    for (const vr of vlist) {
      for (const vnt of variants) {
        for (let k = 1; k <= reps; k++) {
          const base = `${stamp}-${scenarioId}`.slice(0, 70) + (many ? `-${++n}` : '');
          // the stamp has one-second resolution: a second start in the same second must not take over the first's folder
          let id = base;
          for (let r = 2; fs.existsSync(path.join(RUNS, id)); r++) id = `${base}-r${r}`;
          const label = [vr.name ? vr.title : '', vnt.label, targets.length > 1 ? device : '', reps > 1 ? `measurement ${k}/${reps}` : ''].filter(Boolean).join(' · ');
          const job = { id, scenario, device, vars: vnt.vars, label, engine: scenario.engine, measure: measure ? { ...measure, iteration: k } : null, variant: vr.name ? vr : null };
          fs.mkdirSync(path.join(RUNS, id), { recursive: true });
          writeJson(path.join(RUNS, id, 'run.json'), { id, scenarioId, scenarioName: scenario.name + (label ? ` — ${label}` : ''), status: 'queued', startedAt: new Date().toISOString(), device: device === 'any' ? '' : device, engine: scenario.engine || s.engine || 'adb', steps: [], matrix: Object.keys(vnt.vars).length ? vnt.vars : undefined, measure: job.measure || undefined, variant: vr.name || undefined, variantTitle: vr.name ? vr.title : undefined, section: scenario.section || undefined });
          queue.push(job);
          started.push(loadRun(id));
        }
      }
    }
  }
  await pump();
  return started.length === 1 ? loadRun(started[0].id) : { runs: started.map((r) => loadRun(r.id)), id: started[0].id };
}

let pumping = false;
async function pump() {
  if (pumping) return;
  pumping = true;
  try {
    let s;
    try { s = settings(); } catch (e) { console.error('[e2e-console] queue paused: ' + e.message); return; }
    const list = await allDevices(s).catch(() => []);
    for (let i = 0; i < queue.length; i++) {
      const job = queue[i];
      const free = list.filter((d) => !active.has(d.serial));
      // «any» means any free phone; the browser slot is taken only by jobs that asked for it
      const dev = job.device === 'any' ? (free.find((d) => d.platform === 'android') || free.find((d) => d.platform !== 'web')) : free.find((d) => d.serial === job.device);
      if (!dev) continue;
      queue.splice(i--, 1);
      active.set(dev.serial, { data: { id: job.id, scenarioName: job.scenario.name }, stop() { this.cancelled = true; }, resume() { return false; } }); // placeholder while tokens are fetched
      launchJob(job, dev).catch((e) => {
        const r = loadRun(job.id) || { id: job.id, scenarioId: job.scenario.id, scenarioName: job.scenario.name, steps: [] };
        writeJson(path.join(RUNS, job.id, 'run.json'), { ...r, status: 'failed', error: e.message, device: dev.serial, startedAt: r.startedAt || new Date().toISOString(), finishedAt: new Date().toISOString() });
        if (active.get(dev.serial) && active.get(dev.serial).data.id === job.id) active.delete(dev.serial);
        setTimeout(pump, 100);
      });
    }
  } finally { pumping = false; }
}
// pump() runs when a job is added or a run ends; one failed `adb devices` at that moment (adbd restarting, a device
// reconnecting) would leave the queue waiting for an event that never comes — so it is retried while jobs wait
setInterval(() => { if (queue.length) pump().catch((e) => console.error('[e2e-console] queue:', e)); }, 5000).unref();

async function launchJob(job, dev) {
  const s = settings();
  const scenario = job.scenario;
  const library = loadBlocks().library;
  const steps = compile(scenario, { library }).steps;
  if (s.autoToken && s.auth.plugin && s.apiBase) {
    // A plugin may refuse a fresh login for the account the app is signed in to (MINT_NOT_ALLOWED):
    // only a scenario that signs the app in afresh (it clears the app's data first) allows one for that role.
    const signsInApp = steps.some((st) => (st.type === 'launch' && st.clear)
      || (st.type === 'maestro' && /clearState\\?"?\s*:\s*true/.test(JSON.stringify(st.commands || st.yaml || ''))));
    const roles = new Set(steps.filter((st) => st.type === 'api').map((st) => st.auth || defaultRole(s)));
    for (const st of steps) if (st.type === 'maestro') for (const role of Object.keys(s.accounts)) if (JSON.stringify(st.commands || st.yaml || '').includes(role.toUpperCase() + '_TOKEN')) roles.add(role);
    // a browser step that plants {{role.token}} into the page's storage needs that token fresh too
    for (const st of steps) for (const role of Object.keys(s.accounts)) if (JSON.stringify(st).includes(`{{${role}.token`)) roles.add(role);
    roles.delete('none');
    for (const role of roles) {
      const acc = s.accounts[role];
      if (!acc || (!acc.phone && !acc.refreshToken)) continue;
      try {
        const t = await auth.freshToken(s, { root: ROOT, role, phone: acc.phone, otp: acc.otp || (s.vars || {}).otp, refreshToken: acc.refreshToken, allowMint: role !== defaultRole(s) || signsInApp });
        acc.token = t.accessToken;
        if (t.refreshToken) {
          // written over the migrated table, so a legacy phone is not lost behind a half-filled role
          const cur = readJsonStrict(SETTINGS, {});
          const accounts = settings().accounts;
          writeJson(SETTINGS, { ...cur, accounts: { ...accounts, [role]: { ...(accounts[role] || {}), refreshToken: t.refreshToken } } });
        }
      } catch (e) {
        if (active.get(dev.serial) && active.get(dev.serial).cancelled) return;
        throw e.code === 'MINT_NOT_ALLOWED'
          ? new Error(e.hint || `The token for role "${role}" has expired. First run a scenario that signs the app in afresh (a launch with cleared data): a new sign-in behind the app's back throws it out of the account.`)
          : new Error(`the login plugin returned no token (${role}): ` + e.message);
      }
    }
  }
  if (active.get(dev.serial) && active.get(dev.serial).cancelled) { active.delete(dev.serial); const r = loadRun(job.id); if (r) writeJson(path.join(RUNS, job.id, 'run.json'), { ...r, status: 'stopped', finishedAt: new Date().toISOString() }); setTimeout(pump, 100); return; }
  const number = fs.readdirSync(RUNS).filter((f) => f.includes('-' + scenario.id)).length;
  const run = new Run({ id: job.id, scenario, settings: s, runsDir: RUNS, serial: dev.serial, platform: dev.platform, library, vars: job.vars, label: job.label, measure: job.measure, variant: job.variant });
  run.data.number = number;
  run.save();
  active.set(dev.serial, run);
  run.execute()
    .catch((e) => { run.data.status = 'failed'; run.data.error = e.message; run.data.finishedAt = new Date().toISOString(); run.save(); })
    .finally(() => { if (active.get(dev.serial) === run) active.delete(dev.serial); setTimeout(pump, 100); });
  collectRunLogs(run, s);
}

function stopRun(id) {
  const qi = queue.findIndex((j) => j.id === id);
  if (qi >= 0) {
    const [job] = queue.splice(qi, 1);
    const r = loadRun(job.id);
    if (r) writeJson(path.join(RUNS, id, 'run.json'), { ...r, status: 'stopped', finishedAt: new Date().toISOString() });
    return true;
  }
  const run = activeRun(id);
  if (!run) return false;
  run.stop();
  return true;
}

// ---------- import / export ----------
function saveImported(sc, onConflict) {
  let id = safeId(sc.id) || slug(sc.name);
  const exists = (x) => fs.existsSync(path.join(SCEN, x + '.json'));
  let replaced = false;
  if (exists(id) && onConflict === 'replace') replaced = true;
  else for (let i = 2, base = id; exists(id); i++) id = base + '-' + i;
  const out = { ...sc, id };
  writeJson(path.join(SCEN, id + '.json'), out);
  return { id, name: out.name, steps: out.steps.length, replaced };
}
function applySettingsPatch(patch) {
  writeJson(SETTINGS, mergeSettings(readJsonStrict(SETTINGS, {}), patch, true));
  return Object.keys(patch);
}
// What an import would change, with secrets shown only as their names.
function describeSettings(patch) {
  if (!patch) return null;
  const out = {};
  for (const [k, v] of Object.entries(patch)) {
    if (formats.SECRET_KEYS.includes(k)) out[k] = v ? '••• (key)' : '';
    else if (k === 'accounts' && v) out[k] = Object.fromEntries(Object.entries(v).map(([role, a]) => [role, Object.fromEntries(Object.entries(a || {}).map(([f, x]) => [f, formats.ACCOUNT_SECRETS.includes(f) ? (x ? '•••' : '') : x]))]));
    else out[k] = v;
  }
  return out;
}
// key order does not make two blocks different
const canon = (x) => JSON.stringify(x, (k, v) => (v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.keys(v).sort().map((n) => [n, v[n]])) : v));
// Imported blocks against the library, by name: new, same (nothing to do) or changed (the user decides).
function compareBlocks(blocks) {
  const { library } = loadBlocks();
  const sources = blockSources();
  return Object.entries(blocks || {}).map(([name, b]) => {
    const mine = library[name];
    const status = !mine ? 'new' : canon(mine) === canon(b) ? 'same' : 'changed';
    const params = Array.isArray(b.params) ? b.params : Object.keys(b.params || {});
    return { name, status, params, steps: b.steps.length, ...(mine ? { mineSteps: mine.steps.length, file: path.basename(sources[name] || LIBRARY_FILE) } : {}) };
  });
}
// which file of data/blocks defines each block (the last one wins, as in loadBlocks)
function blockSources() {
  const out = {};
  for (const f of fs.readdirSync(BLOCKS).filter((x) => /\.ya?ml$/i.test(x)).sort()) {
    try {
      const doc = YAML.parse(fs.readFileSync(path.join(BLOCKS, f), 'utf8'));
      if (!doc || typeof doc !== 'object') continue;
      for (const name of Array.isArray(doc.steps) ? [path.basename(f).replace(/\.ya?ml$/i, '')] : Object.keys(doc)) out[name] = path.join(BLOCKS, f);
    } catch { /* loadBlocks reports it */ }
  }
  return out;
}
// New blocks go to library.yaml; a replaced one is rewritten where it lives. YAML.parseDocument keeps the
// other blocks and their comments as they were.
function writeBlocks(list) {
  const sources = blockSources();
  const byFile = new Map();
  for (const [name, b] of list) {
    const file = sources[name] || LIBRARY_FILE;
    if (!byFile.has(file)) byFile.set(file, []);
    byFile.get(file).push([name, b]);
  }
  for (const [file, items] of byFile) {
    const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
    const doc = YAML.parseDocument(text);
    const js = doc.toJS();
    if (js && Array.isArray(js.steps)) { fs.writeFileSync(file, YAML.stringify(formats.blockOut(items[0][1]), { lineWidth: 0 })); continue; }
    if (!doc.contents || !YAML.isMap(doc.contents)) doc.contents = doc.createNode({});
    for (const [name, b] of items) doc.set(name, doc.createNode(formats.blockOut(b)));
    fs.writeFileSync(file, doc.toString({ lineWidth: 0 }));
  }
}
function doImport(body) {
  const files = (body.files || []).filter((f) => f && typeof f.content === 'string');
  if (!files.length) { const e = new Error('nothing to import'); e.status = 400; throw e; }
  const parsed = formats.parseImport(files, { mode: body.mode || 'auto', appId: settings().package });
  parsed.scenarios.forEach((sc) => {
    const id = safeId(sc.id) || slug(sc.name);
    sc.conflict = fs.existsSync(path.join(SCEN, id + '.json')) ? id : null;
  });
  const blocks = compareBlocks(parsed.blocks);
  if (!body.apply) return { preview: true, files: parsed.files, warnings: parsed.warnings, settings: describeSettings(parsed.settings), scenarios: parsed.scenarios, blocks };
  const pick = Array.isArray(body.only) ? new Set(body.only.map(Number)) : null;
  const saved = parsed.scenarios.filter((_, i) => !pick || pick.has(i)).map(({ conflict, ...sc }) => saveImported(sc, body.onConflict));
  const changed = parsed.settings && body.settings !== false ? applySettingsPatch(parsed.settings) : [];
  // blocks: a new one is added unless unticked; a different one with the same name stays as it is unless the user
  // chose to replace it (per block, or `blockConflict: replace` for all)
  const choice = (name) => ((body.blocks || {})[name] || body.blockConflict || 'keep');
  const write = [], kept = [];
  for (const b of blocks) {
    if (b.status === 'new' && choice(b.name) !== 'skip') write.push(b.name);
    if (b.status === 'changed') (choice(b.name) === 'replace' ? write : kept).push(b.name);
  }
  if (write.length) writeBlocks(write.map((n) => [n, parsed.blocks[n]]));
  const warnings = [...parsed.warnings, ...kept.map((n) => `block "${n}" differs from yours and was kept as it is — choose "replace" to take the imported one`)];
  return { preview: false, saved, settingsChanged: changed, blocksSaved: write, blocksKept: kept, warnings };
}
function sendText(res, text, filename, type = 'text/yaml; charset=utf-8') {
  res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store', 'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(filename)}` });
  res.end(text);
}

// A frame link → its rendered PNG, through the Figma REST API with the user's personal token.
// Cached by file key + node id: a mockup that changes needs «Обновить макет».
function parseFigmaUrl(url) {
  const m = /figma\.com\/(?:design|file|proto)\/([A-Za-z0-9]+)\/[^?]*\?(?:.*&)?node-id=([0-9]+[-:][0-9]+)/.exec(String(url || ''));
  return m ? { fileKey: m[1], nodeId: m[2].replace('-', ':') } : null;
}
async function figmaImage(url, refresh) {
  const ref = parseFigmaUrl(url);
  if (!ref) { const e = new Error('this is not a Figma frame link (node-id needed)'); e.status = 400; throw e; }
  const name = `${ref.fileKey}_${ref.nodeId.replace(':', '-')}.png`;
  const file = path.join(FIGMA, name);
  if (fs.existsSync(file) && !refresh) return name;
  const token = settings().figmaToken;
  if (!token) { const e = new Error('no Figma token — add it in the settings and the mockup will show here'); e.status = 409; throw e; }
  const r = await fetch(`https://api.figma.com/v1/images/${ref.fileKey}?ids=${encodeURIComponent(ref.nodeId)}&format=png&scale=1`,
    { headers: { 'X-Figma-Token': token }, signal: AbortSignal.timeout(30000) });
  const j = await r.json().catch(() => ({}));
  const src = j.images && j.images[ref.nodeId];
  if (!r.ok || !src) { const e = new Error('Figma returned no image: ' + (j.err || j.message || 'HTTP ' + r.status)); e.status = 502; throw e; }
  const png = await fetch(src, { signal: AbortSignal.timeout(60000) });
  fs.writeFileSync(file, Buffer.from(await png.arrayBuffer()));
  return name;
}

// Design verdict for one step: written into the live run when it is still going, else into run.json.
function setStepDesign(id, n, body) {
  const live = activeRun(id);
  const target = live ? live.data : loadRun(id);
  if (!target) { const e = new Error('no such run'); e.status = 404; throw e; }
  const step = target.steps[n - 1];
  if (!step) { const e = new Error('no such step'); e.status = 404; throw e; }
  if (body.figma !== undefined) step.figma = String(body.figma || '').trim() || undefined;
  if (body.verdict !== undefined || body.note !== undefined) {
    const verdict = ['ok', 'mismatch'].includes(body.verdict) ? body.verdict : null;
    step.design = verdict || body.note ? { verdict, note: String(body.note || ''), at: new Date().toISOString() } : undefined;
  }
  if (live) live.save();
  else writeJson(path.join(RUNS, id, 'run.json'), target);
  return step;
}

// this run's screenshot of step n becomes the baseline the step compares against
function acceptBaseline(id, n) {
  const run = loadRun(id);
  const step = run && run.steps[n - 1];
  if (!step || !step.screenshot) { const e = new Error('the step has no screenshot'); e.status = 404; throw e; }
  const name = String(step.baseline || `step-${n}`).replace(/[^\p{L}\p{N}_.-]+/gu, '_');
  const dir = path.join(BASELINES, run.scenarioId || 'scenario');
  fs.mkdirSync(dir, { recursive: true });
  fs.copyFileSync(path.join(RUNS, id, step.screenshot), path.join(dir, name + '.png'));
  return { ok: true, baseline: name };
}

function send(res, status, body, type = 'application/json; charset=utf-8') {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(type.startsWith('application/json') ? JSON.stringify(body) : body);
}
// A body is JSON or nothing: a browser can send text/plain cross-site without asking first, application/json it cannot.
function readBody(req) {
  return new Promise((resolve, reject) => {
    const fail = (status, message) => reject(Object.assign(new Error(message), { status }));
    let raw = '';
    let over = false;
    req.on('data', (c) => {
      if (over) return;
      raw += c;
      if (raw.length > 5e6) { over = true; raw = ''; fail(413, 'the request body is over 5 MB'); }
    });
    req.on('end', () => {
      if (over) return;
      if (raw && !/^application\/json\b/i.test(req.headers['content-type'] || '')) return fail(415, 'the request body must be application/json');
      try { resolve(raw ? JSON.parse(raw) : {}); } catch (e) { reject(Object.assign(e, { status: 400 })); }
    });
    req.on('error', reject);
  });
}

// Only this computer's own pages may drive the API. The server listens on 127.0.0.1, so other machines never reach
// it — but any site open in the user's browser can: by a simple cross-site request (no Origin check before), or by
// pointing its own domain at 127.0.0.1 (DNS rebinding, a foreign Host). The CLI and curl send no Origin.
const LOCAL_NAMES = new Set(['127.0.0.1', 'localhost', '[::1]']);
function isLocalHost(host) {
  const m = /^(\[[^\]]+\]|[^:]+)(?::(\d+))?$/.exec(String(host || '').toLowerCase());
  return !!m && LOCAL_NAMES.has(m[1]) && Number(m[2] || 80) === PORT;
}
function requestRefusal(req, isApi) {
  if (!isLocalHost(req.headers.host)) return 'this console only answers on 127.0.0.1 / localhost';
  if (!isApi) return null;
  const origin = req.headers.origin;
  if (origin !== undefined) {
    let ok = false;
    try { const u = new URL(origin); ok = u.protocol === 'http:' && isLocalHost(u.host); } catch { /* "null" or junk */ }
    if (!ok) return 'requests from other sites are refused';
  }
  // GETs with side effects (/api/setup runs adb) carry no Origin when sent cross-site; the browser marks them here
  const site = req.headers['sec-fetch-site'];
  if (site && !['same-origin', 'none'].includes(site)) return 'requests from other sites are refused';
  return null;
}
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml' };
function serveFile(res, file) {
  fs.readFile(file, (err, buf) => {
    if (err) return send(res, 404, { error: 'not found' });
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' });
    res.end(buf);
  });
}

async function api(req, res, parts) {
  const [, , a, b, c] = parts; // '', 'api', ...
  const m = req.method;

  if (a === 'scenarios' && !b && m === 'GET') return send(res, 200, listScenarios());
  if (a === 'scenarios' && !b && m === 'POST') {
    const body = await readBody(req);
    let id = slug(body.name);
    for (let i = 2; fs.existsSync(path.join(SCEN, id + '.json')); i++) id = slug(body.name) + '-' + i;
    // the editor posts the whole draft: engine, tab, tags and the rest come along, not only the steps
    const sc = { id, name: body.name || 'New scenario', description: body.description || '', steps: body.steps || [] };
    for (const k of ['engine', 'tab', 'section', 'tags', 'vars', 'order', 'setup', 'teardown', 'blocks', 'matrix', 'rules', 'measure', 'variants']) if (body[k] !== undefined && body[k] !== null && body[k] !== '') sc[k] = body[k];
    writeJson(path.join(SCEN, id + '.json'), sc);
    return send(res, 201, sc);
  }
  if (a === 'scenarios' && b) {
    const id = safeId(b);
    if (!id) return send(res, 400, { error: 'bad id' });
    const file = path.join(SCEN, id + '.json');
    if (!c && m === 'GET') { const sc = readJson(file, null); return sc ? send(res, 200, sc) : send(res, 404, { error: 'no such scenario' }); }
    if (!c && m === 'PUT') {
      const body = await readBody(req);
      const prev = readJson(file, {});
      const sc = { ...prev, ...body, id };
      // the editor sends its draft back whole, with the lint result and the YAML text it was shown: neither is the scenario
      delete sc.lint; delete sc.yamlText;
      for (const k of ['setup', 'teardown', 'blocks', 'matrix', 'rules', 'measure', 'tab', 'section', 'engine']) if (body[k] === null || body[k] === '') delete sc[k];
      writeJson(file, sc);
      return send(res, 200, { ...sc, lint: lintScenario(sc) });
    }
    if (c === 'lint' && m === 'GET') {
      const sc = readJson(file, null);
      return sc ? send(res, 200, lintScenario(sc)) : send(res, 404, { error: 'no such scenario' });
    }
    if (!c && m === 'DELETE') { fs.rmSync(file, { force: true }); return send(res, 200, { ok: true }); }
    if (c === 'run' && m === 'POST') {
      const q = new URL(req.url, 'http://localhost').searchParams;
      try {
        return send(res, 202, await startRun(id, { engine: q.get('engine'), device: q.get('device'), force: q.get('force') === '1', measure: q.get('measure') === '1', iterations: q.get('iterations'), flashlight: q.get('flashlight') === '0' ? false : undefined, variant: q.get('variant') || undefined }));
      } catch (e) { if (e.lint) return send(res, 400, { error: e.message, lint: e.lint }); throw e; }
    }
    if (c === 'export' && m === 'GET') {
      const sc = readJson(file, null);
      if (!sc) return send(res, 404, { error: 'no such scenario' });
      const fmt = new URL(req.url, 'http://localhost').searchParams.get('format') || 'yaml';
      if (fmt === 'maestro') {
        // a flow with backend checks comes with its scripts: one zip; a plain flow is one YAML
        const { files } = formats.exportMaestro(sc, settings(), loadBlocks().library);
        if (files.length === 1) return sendText(res, files[0].content, id + '.maestro.yaml');
        const buf = zip(files.map((f) => ({ name: id + '/' + f.name, content: f.content })));
        res.writeHead(200, { 'content-type': 'application/zip', 'cache-control': 'no-store', 'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(id + '.maestro.zip')}` });
        return res.end(buf);
      }
      if (fmt === 'json') return sendText(res, JSON.stringify(sc, null, 2), id + '.json', 'application/json; charset=utf-8');
      return sendText(res, formats.exportScenario(sc), id + '.yaml');
    }
    if (c === 'yaml' && m === 'PUT') {
      // the editor's YAML mode: the text replaces the scenario, keeping its id
      const body = await readBody(req);
      const parsed = formats.parseImport([{ name: id + '.yaml', content: String(body.text || '') }], { mode: body.mode || 'native', appId: settings().package, strict: true });
      // strict: a line the converter would drop is an error and nothing is written
      if (parsed.errors.length) return send(res, 400, { error: 'YAML not saved:\n' + parsed.errors.join('\n'), errors: parsed.errors });
      if (parsed.scenarios.length !== 1) return send(res, 400, { error: (parsed.warnings[0] || 'the text must contain exactly one scenario'), warnings: parsed.warnings });
      const sc = { ...parsed.scenarios[0], id };
      writeJson(file, sc);
      return send(res, 200, { scenario: sc, warnings: parsed.warnings, lint: lintScenario(sc) });
    }
  }

  if (a === 'import' && m === 'POST') return send(res, 200, doImport(await readBody(req)));
  if (a === 'schema' && m === 'GET') return send(res, 200, jsonSchema());
  if (a === 'blocks' && m === 'GET') {
    const { library, warnings } = loadBlocks();
    const text = fs.existsSync(LIBRARY_FILE) ? fs.readFileSync(LIBRARY_FILE, 'utf8') : '';
    return send(res, 200, { text, blocks: Object.fromEntries(Object.entries(library).map(([k, b]) => [k, { params: b.params || [], steps: b.steps.length }])), warnings });
  }
  if (a === 'blocks' && m === 'PUT') {
    const body = await readBody(req);
    const text = String(body.text || '');
    try { const doc = YAML.parse(text); if (text.trim() && (!doc || typeof doc !== 'object')) throw new Error('an object was expected: block name → { params, steps }'); } catch (e) { return send(res, 400, { error: 'block library: ' + e.message }); }
    fs.writeFileSync(LIBRARY_FILE, text);
    const { library, warnings } = loadBlocks();
    return send(res, 200, { blocks: Object.keys(library), warnings });
  }
  if (a === 'queue' && !b && m === 'GET') return send(res, 200, { active: [...active.entries()].map(([serial, r]) => ({ serial, id: r.data.id, name: r.data.scenarioName })), queue: queue.map((j) => ({ id: j.id, name: j.scenario.name, device: j.device, label: j.label })) });
  if (a === 'export' && m === 'GET') {
    const q = new URL(req.url, 'http://localhost').searchParams;
    const withSecrets = q.get('secrets') === '1';
    const ids = q.get('ids') ? new Set(q.get('ids').split(',')) : null;
    const list = listScenarios().filter((x) => !ids || ids.has(x.id));
    // the blocks the scenarios call travel with them; an export of everything carries the whole library
    const bundle = formats.exportBundle({ scenarios: list, settings: settings(), withSecrets, library: loadBlocks().library, allBlocks: !ids });
    return sendText(res, bundle, withSecrets ? 'e2e-bundle-with-keys.yaml' : 'e2e-bundle.yaml');
  }
  if (a === 'maestro' && m === 'GET') {
    const s = settings();
    const r = maestro.resolve(s);
    let ver = null, error = null;
    if (new URL(req.url, 'http://localhost').searchParams.get('check') === '1') {
      try { ver = await maestro.version(s); } catch (e) { error = e.message; }
    }
    return send(res, 200, { bin: r.bin, javaHome: r.javaHome, version: ver, error });
  }

  if (a === 'runs' && !b && m === 'GET') return send(res, 200, listRuns());
  if (a === 'runs' && b === 'prune' && !c && m === 'POST') return send(res, 200, pruneRuns(await readBody(req)));
  if (a === 'runs' && b) {
    const id = safeId(b);
    if (!id) return send(res, 400, { error: 'bad id' });
    if (!c && m === 'GET') { const r = loadRun(id); return r ? send(res, 200, withForecast(r)) : send(res, 404, { error: 'no such run' }); }
    if (!c && m === 'DELETE') {
      if (activeRun(id) || queue.some((j) => j.id === id)) return send(res, 409, { error: 'the run is still going' });
      fs.rmSync(path.join(RUNS, id), { recursive: true, force: true });
      return send(res, 200, { ok: true });
    }
    if (c === 'steps' && parts[5] && parts[6] === 'design' && m === 'POST') {
      return send(res, 200, setStepDesign(id, Number(parts[5]), await readBody(req)));
    }
    if (c === 'steps' && parts[5] && parts[6] === 'baseline' && m === 'POST') return send(res, 200, acceptBaseline(id, Number(parts[5])));
    if (c === 'logs' && m === 'GET') return send(res, 200, readJson(path.join(RUNS, id, 'logs.json'), []));
    if (c === 'logs' && m === 'POST') return send(res, 200, await refetchRunLogs(id));
    if (c === 'resume' && m === 'POST') {
      const run = activeRun(id);
      if (!run) return send(res, 409, { error: 'this run is not waiting' });
      const body = await readBody(req);
      return send(res, run.resume(body) ? 200 : 409, run.data);
    }
    if (c === 'stop' && m === 'POST') {
      if (!stopRun(id)) return send(res, 409, { error: 'this run is not running' });
      return send(res, 200, { ok: true });
    }
  }

  if (a === 'figma' && b === 'image' && m === 'GET') {
    const u = new URL(req.url, 'http://localhost');
    return send(res, 200, { src: '/figma/' + await figmaImage(u.searchParams.get('url'), u.searchParams.get('refresh') === '1') });
  }

  if (a === 'settings' && m === 'GET') return send(res, 200, settings());
  if (a === 'settings' && m === 'PUT') {
    const body = await readBody(req);
    writeJson(SETTINGS, mergeSettings(readJsonStrict(SETTINGS, {}), body));
    return send(res, 200, settings());
  }

  if (a === 'device' && !b && m === 'GET') {
    const s = settings();
    let list = [], error;
    try { list = await allDevices(s); } catch (e) { error = e.message; }
    const phones = phonesOf(list);
    const b = web.probe(s);
    return send(res, 200, { devices: phones.map((d) => d.serial), details: phones, browser: { ok: b.ok, name: b.name || '', error: b.error || '' }, error, active: [...active.values()].map((r) => r.data.id), queued: queue.length });
  }
  if (a === 'device' && b === 'emulator' && m === 'POST') {
    const s = settings();
    // a wrong emulator path is an answer for the UI, not a crash of the console
    try { await startEmulator(s.emulatorPath, s.avd); } catch (e) { return send(res, 400, { error: e.message }); }
    return send(res, 202, { ok: true });
  }
  if (a === 'device' && b === 'install' && m === 'POST') {
    const s = settings();
    const list = await devices(s.adbPath);
    const want = new URL(req.url, 'http://localhost').searchParams.get('device');
    const serial = want && !['any', 'all'].includes(want) ? want : (s.serial || list[0]);
    if (!serial) return send(res, 409, { error: 'no emulator or phone connected' });
    if (!list.includes(serial)) return send(res, 409, { error: `device ${serial} is not connected` });
    if (!s.apkPath || !fs.existsSync(s.apkPath)) return send(res, 400, { error: 'APK not found: ' + s.apkPath });
    try {
      const out = await new Device({ adbPath: s.adbPath, serial }).install(s.apkPath);
      return send(res, 200, { ok: true, output: String(out).trim() });
    } catch (e) {
      // MIUI/HyperOS refuses adb installs until «Install via USB» is on in developer options
      if (/USER_RESTRICTED/i.test(e.message)) return send(res, 400, { error: 'the phone refused the install: turn on "Install via USB" in Developer options (MIUI/HyperOS, sometimes asks to sign in to a Mi account) and retry' });
      throw e;
    }
  }
  // Wi-Fi debugging: pair (once, with the code from the phone's dialog) and/or connect (the port changes
  // every time wireless debugging is turned on; without it the phone is looked up over mDNS)
  if (a === 'device' && b === 'pair' && m === 'POST') {
    const s = settings();
    const body = await readBody(req);
    const pairAddr = String(body.pair || '').trim(), code = String(body.code || '').replace(/\s+/g, '');
    let connect = String(body.connect || '').trim();
    const log = [];
    if (pairAddr && code) {
      const r = await adb.pair(s.adbPath, pairAddr, code).catch((e) => e.message);
      log.push(`adb pair ${pairAddr}\n${r.trim()}`);
      if (!/Successfully paired/i.test(r)) return send(res, 400, { error: 'pairing failed: ' + r.trim().split('\n').pop(), log });
    } else if (!connect) return send(res, 400, { error: 'a pairing address and code are needed — or a connection address if the phone was paired before' });
    const ip = (connect || pairAddr).split(':')[0];
    if (!connect) {
      const found = (await adb.mdnsConnectable(s.adbPath)).filter((x) => x.address.startsWith(ip + ':'));
      if (!found.length) return send(res, 200, { paired: true, needConnect: true, log });
      connect = found[0].address;
      log.push(`mDNS: ${connect}`);
    }
    const c = await adb.connect(s.adbPath, connect).catch((e) => e.message);
    log.push(`adb connect ${connect}\n${c.trim()}`);
    if (!/^(already )?connected to/im.test(c)) return send(res, 400, { error: 'could not connect: ' + c.trim().split('\n').pop(), log });
    const dev = new Device({ adbPath: s.adbPath, serial: connect });
    const names = (await dev.shell('getprop ro.product.marketname; getprop ro.product.model').catch(() => '')).split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
    const name = names[0] || connect;
    const cur = readJsonStrict(SETTINGS, {});
    // the same phone comes back with another port tomorrow: one entry per ip
    const known = (cur.devices || []).filter((d) => !(d.platform !== 'ios' && String(d.serial).startsWith(ip + ':')));
    writeJson(SETTINGS, { ...cur, devices: [...known, { serial: connect, platform: 'android', name }] });
    return send(res, 200, { connected: connect, name, log });
  }
  if (a === 'device' && b === 'disconnect' && m === 'POST') {
    const s = settings();
    const body = await readBody(req);
    const out = await adb.disconnect(s.adbPath, String(body.serial || ''));
    return send(res, 200, { ok: true, output: String(out).trim() });
  }
  if (a === 'device' && b === 'mdns' && m === 'GET') return send(res, 200, { phones: await adb.mdnsConnectable(settings().adbPath) });
  // the app in the foreground of a device: fills package/activity in the settings without guessing
  if (a === 'device' && b === 'foreground' && m === 'GET') {
    const s = settings();
    const list = await devices(s.adbPath);
    const want = new URL(req.url, 'http://localhost').searchParams.get('device');
    const serial = want && !['any', 'all'].includes(want) ? want : (s.serial && list.includes(s.serial) ? s.serial : list[0]);
    if (!serial) return send(res, 409, { error: 'no device connected' });
    const out = await new Device({ adbPath: s.adbPath, serial }).shell('dumpsys activity activities').catch((e) => e.message);
    const mm = /(?:topResumedActivity|ResumedActivity:|mResumedActivity)[^{]*\{\S+ u\d+ ([\w.]+)\/(\S+?)[\s}]/.exec(out);
    if (!mm) return send(res, 404, { error: 'no app found on screen — open it on the device and retry' });
    const pkg = mm[1], act = mm[2].startsWith('.') ? pkg + mm[2] : mm[2];
    return send(res, 200, { serial, package: pkg, activity: act });
  }
  // what a newcomer needs to see: is the toolchain there, a device, the app, a backend, any scenarios
  if (a === 'setup' && m === 'GET') {
    const s = settings();
    const out = {
      adb: { path: s.adbPath, ok: !!s.adbPath && fs.existsSync(s.adbPath) },
      emulator: { path: s.emulatorPath, ok: !!s.emulatorPath && fs.existsSync(s.emulatorPath), avds: [], avd: s.avd },
      devices: [],
      app: { package: s.package, activity: s.activity, apkPath: s.apkPath, apkOk: !!s.apkPath && fs.existsSync(s.apkPath), installed: null, appName: s.appName },
      backend: { apiBase: s.apiBase, envName: s.envName, plugin: (s.auth || {}).plugin || '', pluginOk: !!(s.auth || {}).plugin && fs.existsSync(path.resolve(ROOT, (s.auth || {}).plugin)), accounts: Object.keys(s.accounts || {}), autoToken: !!s.autoToken },
      scenarios: listScenarios().length,
      blocks: Object.keys(loadBlocks().library).length,
      maestro: !!maestro.resolve(s).bin,
      browser: web.probe(s),
      webUrl: s.webUrl || ''
    };
    if (out.adb.ok) out.adb.version = (await adb.run(s.adbPath, ['version'], { timeoutMs: 10000 }).catch(() => '')).split(/\r?\n/)[0];
    if (out.emulator.ok) out.emulator.avds = (await adb.run(s.emulatorPath, ['-list-avds'], { timeoutMs: 15000 }).catch(() => '')).split(/\r?\n/).map((x) => x.trim()).filter((x) => x && !/^INFO|^WARNING/.test(x));
    out.devices = phonesOf(await allDevices(s).catch(() => []));
    const first = out.devices.find((d) => d.platform === 'android');
    if (s.package && first) out.app.installed = /^package:/m.test(await new Device({ adbPath: s.adbPath, serial: first.serial }).shell(`pm path ${s.package}`).catch(() => ''));
    return send(res, 200, out);
  }
  // Emulator hygiene before a measurement: adb root when the image allows it, the configured shell commands,
  // then what the guest looks like (load average, top processes).
  if (a === 'device' && b === 'hygiene' && m === 'POST') {
    const s = settings();
    const body = await readBody(req);
    const list = await devices(s.adbPath);
    const serial = String(body.serial || s.serial || list[0] || '');
    if (!serial || !list.includes(serial)) return send(res, 409, { error: 'device not connected' });
    const dev = new Device({ adbPath: s.adbPath, serial });
    const log = [];
    const rootOut = await dev.adb(['root'], { timeoutMs: 15000 }).catch((e) => e.message);
    const rooted = /restarting adbd as root|already running as root/i.test(rootOut);
    log.push(`adb root → ${String(rootOut).trim().split('\n')[0] || 'ok'}`);
    if (rooted) { await adb.sleep(2500); await dev.adb(['wait-for-device'], { timeoutMs: 20000 }).catch(() => {}); }
    for (const cmd of s.emulatorHygiene || []) {
      const out = await dev.shell(cmd, { timeoutMs: 20000 }).catch((e) => e.message);
      log.push(`$ ${cmd}\n${String(out).trim() || 'ok'}`);
    }
    await adb.sleep(3000);
    const load = (await dev.shell('cat /proc/loadavg').catch(() => '')).trim().split(/\s+/).slice(0, 3).join(' ');
    const top = (await dev.shell('top -n 1 -m 5 -b').catch(() => '')).split(/\r?\n/).filter((l) => /^\s*\d+\s/.test(l)).map((l) => { const p = l.trim().split(/\s+/); return { pid: p[0], cpu: p[8], name: p.slice(11).join(' ') || p[p.length - 1] }; });
    return send(res, 200, { serial, rooted, log, load, top });
  }
  // a phone on the cable → the same phone over Wi-Fi (adb tcpip), so the cable can go
  if (a === 'device' && b === 'wifi' && m === 'POST') {
    const s = settings();
    const body = await readBody(req);
    const serial = String(body.serial || '');
    if (!(await devices(s.adbPath)).includes(serial)) return send(res, 409, { error: `device ${serial} is not connected` });
    const dev = new Device({ adbPath: s.adbPath, serial });
    const ipOut = await dev.shell('ip -f inet addr show wlan0').catch(() => '');
    const ip = (/inet (\d+\.\d+\.\d+\.\d+)/.exec(ipOut) || [])[1];
    if (!ip) return send(res, 400, { error: 'the phone has no Wi-Fi address: connect it to the same network as the computer' });
    const name = (await dev.shell('getprop ro.product.marketname; getprop ro.product.model').catch(() => '')).split(/\r?\n/).map((x) => x.trim()).filter(Boolean)[0] || serial;
    await dev.adb(['tcpip', '5555'], { timeoutMs: 20000 });
    await new Promise((r) => setTimeout(r, 2500));
    const c = await adb.connect(s.adbPath, ip + ':5555').catch((e) => e.message);
    if (!/^(already )?connected to/im.test(c)) return send(res, 400, { error: 'adb connect failed: ' + c.trim().split('\n').pop() });
    const cur = readJsonStrict(SETTINGS, {});
    const known = (cur.devices || []).filter((d) => !(d.platform !== 'ios' && String(d.serial).startsWith(ip + ':')));
    writeJson(SETTINGS, { ...cur, devices: [...known, { serial: ip + ':5555', platform: 'android', name }] });
    return send(res, 200, { connected: ip + ':5555', name });
  }

  // Calibration: a measured run on a real phone becomes the reference; K against an emulator run of the
  // same scenario (and build when there is one). Saved in settings.perf, applied to emulator runs on read.
  if (a === 'perf' && b === 'calibrate' && m === 'POST') {
    const body = await readBody(req);
    const phoneRun = loadRun(safeId(String(body.phoneRun || '')) || '');
    if (!phoneRun || !phoneRun.perf || !phoneRun.perf.frames) return send(res, 400, { error: 'a measured run on a phone is needed' });
    const dev = phoneRun.perf.device || {};
    if (dev.emulator) return send(res, 400, { error: 'this run is on the emulator — only a phone can be the reference' });
    if (phoneRun.perf.frames.count < perf.MIN_FRAMES) return send(res, 400, { error: `the run has only ${phoneRun.perf.frames.count} frames — too few for a reference` });
    const s = settings();
    const candidates = listRuns().filter((r) => r.status === 'passed' && r.scenarioId === phoneRun.scenarioId && r.perf && r.perf.device && r.perf.device.emulator && r.perf.frames && r.perf.frames.count >= perf.MIN_FRAMES);
    // the same installed build and variant with the same Flashlight mode first (K across builds is not a device
    // ratio), then the same Flashlight mode (its profiler adds its own load), then the same build, then the latest
    const flOf = (r) => !!(r.measure && r.measure.flashlight);
    const twin = (r) => (r.variant || '') === (phoneRun.variant || '') && perf.sameBuild(r.perf.device, dev);
    // another variant runs other code (stubs vs backend): only when there is no run of the same one
    const sameVariant = candidates.filter((r) => (r.variant || '') === (phoneRun.variant || ''));
    const pool = sameVariant.length ? sameVariant : candidates;
    const pick = pool.find((r) => twin(r) && flOf(r) === flOf(phoneRun)) || pool.find(twin) || pool.find((r) => flOf(r) === flOf(phoneRun) && r.build === phoneRun.build) || pool.find((r) => flOf(r) === flOf(phoneRun)) || pool.find((r) => r.build === phoneRun.build) || pool[0];
    const emuRun = body.emuRun ? loadRun(safeId(String(body.emuRun)) || '') : loadRun((pick || {}).id || '');
    if (!emuRun || !emuRun.perf) return send(res, 400, { error: 'no measured run of this scenario on the emulator — run it there first' });
    const k = perf.calibrate(phoneRun, emuRun);
    if (!k) return send(res, 400, { error: 'could not match the steps of the two runs' });
    const chip = chips.lookup(dev, (s.perf || {}).chips);
    const score = Number(body.score) || (chip && chip.score);
    if (!score) return send(res, 400, { error: `chip "${dev.soc || dev.platform || '?'}" is not in the table — pass the score manually (score)`, device: dev });
    const cal = {
      ...(s.perf || {}),
      reference: {
        serial: phoneRun.device, name: dev.model || phoneRun.device, chip: chip ? chip.name : dev.soc, score, runId: phoneRun.id, emuRunId: emuRun.id, scenarioId: phoneRun.scenarioId, build: phoneRun.build,
        phoneVersion: dev.versionName, emuVersion: (emuRun.perf.device || {}).versionName, flashlight: flOf(phoneRun), emuFlashlight: flOf(emuRun), at: new Date().toISOString(),
        // which emulator image and builds K compares: forecasts are checked against this (perf.calibrationCheck)
        ...perf.calibrationOrigin(phoneRun, emuRun)
      },
      k
    };
    writeJson(SETTINGS, { ...readJsonStrict(SETTINGS, {}), perf: cal });
    // the reasons this calibration will not give forecasts right away (another build or variant, odd K)
    return send(res, 200, { ...cal, check: perf.calibrationCheck(cal, emuRun) });
  }
  if (a === 'perf' && b === 'calibration' && m === 'GET') return send(res, 200, settings().perf || {});
  // the history: per device and build — total, sections, scenarios (and variants) with medians over their runs
  if (a === 'perf' && b === 'summary' && m === 'GET') return send(res, 200, perfSummary.summarize(listRuns(), listScenarios()));

  return send(res, 404, { error: 'no such method' });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    const parts = url.pathname.split('/');
    const refusal = requestRefusal(req, parts[1] === 'api');
    if (refusal) return send(res, 403, { error: refusal });
    if (parts[1] === 'api') return await api(req, res, parts);
    if (parts[1] === 'runs' && safeId(parts[2]) && /^step-\d+(\.diff)?\.png$/.test(parts[3] || '')) {
      return serveFile(res, path.join(RUNS, parts[2], parts[3]));
    }
    if (parts[1] === 'runs' && safeId(parts[2]) && parts[3] === 'maestro' && /^steps-\d+-\d+$/.test(parts[4] || '') && ['flow.yaml', 'maestro.out.txt'].includes(parts[5])) {
      return fs.readFile(path.join(RUNS, parts[2], 'maestro', parts[4], parts[5]), 'utf8', (err, text) => (err ? send(res, 404, { error: 'not found' }) : send(res, 200, text, 'text/plain; charset=utf-8')));
    }
    if (parts[1] === 'figma' && /^[A-Za-z0-9]+_[0-9]+-[0-9]+\.png$/.test(parts[2] || '')) {
      return serveFile(res, path.join(FIGMA, parts[2]));
    }
    const rel = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
    const file = path.join(PUBLIC, path.normalize(rel));
    if (!file.startsWith(PUBLIC)) return send(res, 403, { error: 'forbidden' });
    return serveFile(res, file);
  } catch (e) {
    if (res.headersSent) return res.end();
    send(res, e.status || 500, { error: e.message });
  }
});

// A stray error in a background task (a log fetch, a child process, a timer) is logged, never fatal: one console
// holds live runs, a queue and a device, and dying mid-run loses all three.
process.on('unhandledRejection', (e) => console.error('[e2e-console] unhandled rejection:', e));
process.on('uncaughtException', (e) => console.error('[e2e-console] uncaught exception:', e));

// One console per data folder: two would drive the same phone at once and mark each other's live runs stopped.
const LOCK = path.join(DATA, '.console.lock');
function takeLock() {
  const held = readJson(LOCK, null);
  if (held && held.pid !== process.pid) {
    let alive = false;
    try { process.kill(held.pid, 0); alive = true; } catch (e) { alive = e.code === 'EPERM'; }
    if (alive) {
      console.error(`Another console (pid ${held.pid}, port ${held.port}) already uses ${DATA}.\nStop it, or start this one on its own folder: node server.js --port ${PORT} --data <other folder>
(If that console is gone and the pid now belongs to something else, delete ${LOCK}.)`);
      process.exit(1);
    }
  }
  writeJson(LOCK, { pid: process.pid, port: PORT, startedAt: new Date().toISOString() });
  const release = () => { try { if ((readJson(LOCK, {}) || {}).pid === process.pid) fs.rmSync(LOCK, { force: true }); } catch { /* best effort */ } };
  process.on('exit', release);
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => process.exit(0));
}

server.on('error', (e) => {
  console.error(e.code === 'EADDRINUSE' ? `Port ${PORT} is busy (another console?). Pass another one: node server.js --port <n>` : `The console could not start: ${e.message}`);
  process.exit(1);
});
takeLock();
migrateSettings();
server.listen(PORT, '127.0.0.1', () => {
  recoverRuns();
  console.log(`E2E console: http://localhost:${PORT}`);
});
