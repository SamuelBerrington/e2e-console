'use strict';
// Scenario and settings files in and out of the console.
//   native  — our YAML (or JSON): a scenario, a list of steps, or a bundle with settings, keys and scenarios
//   maestro — a Maestro flow: translated into our steps where they mean the same, kept as raw
//             Maestro commands where they do not
//   env     — KEY=VALUE lines: settings, keys and variables
const path = require('node:path');
const YAML = require('yaml');
const { compile, defaultRole } = require('./compile');

const STEP_TYPES = ['launch', 'link', 'tap', 'type', 'swipe', 'pinch', 'back', 'wait', 'assertText', 'assertScreen', 'api', 'ai', 'maestro', 'use', 'if', 'repeat', 'browser', 'phone'];
// scenario fields besides steps
const SCENARIO_KEYS = ['id', 'engine', 'tags', 'vars', 'order', 'appId', 'matrix', 'rules', 'measure', 'section', 'tab'];
// every top-level key a scenario file may have; anything else would vanish on the way in
const SCENARIO_ALL = ['name', 'description', 'steps', 'setup', 'teardown', 'variants', 'blocks', ...SCENARIO_KEYS];
const VARIANT_KEYS = ['title', 'vars', 'setup', 'teardown'];
const BLOCK_KEYS = ['params', 'steps'];
// The one field a step can be written with in short form: `- tap: "В корзину"`.
const PRIMARY = { tap: 'target', type: 'text', input: 'text', link: 'url', wait: 'seconds', assertText: 'text', assertScreen: 'baseline', swipe: 'direction', pinch: 'direction', ai: 'text', maestro: 'commands', use: 'use' };
const SECRET_KEYS = ['apiToken', 'sellerToken', 'figmaToken', 'refreshToken', 'sellerRefreshToken'];
// inside `accounts.<role>` these are secrets too
const ACCOUNT_SECRETS = ['token', 'refreshToken'];
// What a bundle without keys carries: only settings that mean the same on another machine. true = the whole value,
// a list = those fields of a group. Left out on purpose: paths (adb, emulator, apk, Maestro, Java, browser,
// kubeconfig), the AVD, serials and devices, perf calibration — they belong to this machine; phones, OTPs and
// tokens — they belong to a person and travel only in the export with keys.
const PORTABLE = {
  package: true, activity: true, bundleId: true, appName: true, envName: true, apiBase: true, engine: true, webUrl: true,
  autoToken: true, templates: true, allowStatus: true, screenIgnore: true, backendIgnore: true, emulatorHygiene: true, tabs: true,
  auth: ['appAccount', 'plugin'], appNet: ['tag'], web: ['headless', 'width', 'height'], runs: ['screenshots'],
  logs: ['enabled', 'namespace', 'service', 'port', 'filter', 'limit']
};
// a variable that holds a person's data (a phone, a code, a key) goes with the keys, not with the settings
const PERSONAL_VAR = /phone|otp|token|secret|passw|apikey|api_key/i;
const personalVar = (k, v) => PERSONAL_VAR.test(k) || (typeof v === 'string' && /^\+?[\d\s()-]+$/.test(v) && v.replace(/\D/g, '').length >= 10);
// Settings from before named accounts: flat buyer / seller keys. They move into accounts and are dropped
// (migrateLegacy), so they are kept here only to be read from old files and bundles.
const LEGACY_TOKENS = { buyer: { token: 'apiToken', refreshToken: 'refreshToken' }, seller: { token: 'sellerToken', refreshToken: 'sellerRefreshToken' } };
const LEGACY_VARS = { buyer: { phone: 'phone', otp: 'otp' }, seller: { phone: 'sellerPhone', otp: 'otp' } };
const SETTING_KEYS = ['adbPath', 'emulatorPath', 'avd', 'serial', 'package', 'activity', 'bundleId', 'apkPath', 'appName', 'envName', 'apiBase', 'engine', 'autoToken', 'auth', 'appNet', 'templates', 'accounts', 'devices', 'allowStatus', 'screenIgnore', 'backendIgnore', 'logs', 'maestro', 'vars', 'perf', 'emulatorHygiene', 'webUrl', 'web', 'tabs', 'runs', ...SECRET_KEYS];
// .env names → settings; anything else becomes a scenario variable.
const ENV_MAP = {
  API_BASE: 'apiBase', FIGMA_TOKEN: 'figmaToken', AUTH_PLUGIN: 'auth.plugin', APP_NET_TAG: 'appNet.tag', APP_NAME: 'appName',
  APK_PATH: 'apkPath', APP_PACKAGE: 'package', APP_ACTIVITY: 'activity', ENV_NAME: 'envName', AVD: 'avd', ADB_PATH: 'adbPath', DEVICE_SERIAL: 'serial',
  ENGINE: 'engine', MAESTRO_PATH: 'maestro.path', MAESTRO_JAVA_HOME: 'maestro.javaHome', OTP: 'vars.otp', BUNDLE_ID: 'bundleId',
  // the one old name that does not say its role: it always meant the buyer's token (BUYER_TOKEN, SELLER_TOKEN… are generic below)
  API_TOKEN: 'accounts.buyer.token'
};
// <ROLE>_PHONE / _TOKEN / _REFRESH_TOKEN / _OTP → accounts.<role>
const ROLE_ENV = /^([A-Z][A-Z0-9]*)_(PHONE|TOKEN|REFRESH_TOKEN|OTP)$/;
const ROLE_FIELD = { PHONE: 'phone', TOKEN: 'token', REFRESH_TOKEN: 'refreshToken', OTP: 'otp' };
const MAESTRO_COMMANDS = new Set(['launchApp', 'tapOn', 'doubleTapOn', 'longPressOn', 'inputText', 'inputRandomText', 'inputRandomNumber', 'inputRandomEmail',
  'inputRandomPersonName', 'eraseText', 'assertVisible', 'assertNotVisible', 'assertTrue', 'assertWithAI', 'assertNoDefectsWithAI', 'extendedWaitUntil',
  'waitForAnimationToEnd', 'back', 'pressKey', 'hideKeyboard', 'openLink', 'scroll', 'scrollUntilVisible', 'swipe', 'takeScreenshot', 'runFlow', 'runScript',
  'evalScript', 'repeat', 'retry', 'stopApp', 'killApp', 'clearState', 'clearKeychain', 'copyTextFrom', 'pasteText', 'setLocation', 'travel', 'startRecording',
  'stopRecording', 'addMedia', 'setAirplaneMode', 'toggleAirplaneMode', 'setOrientation', 'setPermissions', 'onFlowStart', 'onFlowComplete', 'killApp']);

// ---------- native ----------
// In YAML the «Ввести текст» step is written `input:`: `type:` is the canonical field name.
const ALIAS = { input: 'type' };
function normalizeStep(item, warnings, where) {
  if (typeof item === 'string') {
    if (STEP_TYPES.includes(item)) return { type: item };
    if (MAESTRO_COMMANDS.has(item)) return { type: 'maestro', commands: [item] };
    warnings.push(`${where}: unclear step "${item}"`);
    return null;
  }
  if (!item || typeof item !== 'object') { warnings.push(`${where}: empty step`); return null; }
  const nested = (st) => {
    for (const k of ['then', 'else', 'steps']) if (Array.isArray(st[k])) st[k] = st[k].map((x, i) => normalizeStep(x, warnings, `${where} → ${k} ${i + 1}`)).filter(Boolean);
    return st;
  };
  if (typeof item.type === 'string' && STEP_TYPES.includes(item.type)) return nested({ ...item });
  const keys = Object.keys(item);
  // - if: { visible: … }   then: […]   else: […]
  if (keys.includes('if') && !keys.includes('type')) return nested({ type: 'if', ...item });
  if (keys.includes('repeat') && !keys.includes('type')) {
    const r = item.repeat;
    const rest = Object.fromEntries(keys.filter((k) => k !== 'repeat').map((k) => [k, item[k]]));
    return nested(r && typeof r === 'object' && !Array.isArray(r) ? { type: 'repeat', ...r, ...rest } : { type: 'repeat', steps: Array.isArray(r) ? r : [], ...rest });
  }
  const found = keys.find((k) => STEP_TYPES.includes(k) || ALIAS[k]);
  if (found) {
    const key = ALIAS[found] || found;
    const own = found;
    const v = item[own];
    const rest = Object.fromEntries(keys.filter((k) => k !== own).map((k) => [k, item[k]]));
    if (key === 'maestro') return { type: 'maestro', ...(typeof v === 'string' ? { yaml: v } : { commands: Array.isArray(v) ? v : [v] }), ...rest };
    if (key === 'launch' && (v === true || v === 'clear')) return { type: 'launch', clear: true, ...rest };
    // - browser: [ …steps… ]  /  - phone: [ …steps… ]
    if ((key === 'browser' || key === 'phone') && Array.isArray(v)) return nested({ type: key, steps: v, ...rest });
    if (v && typeof v === 'object' && !Array.isArray(v)) return nested({ type: key, ...v, ...rest });
    if (v == null || v === true) return { type: key, ...rest };
    return PRIMARY[key] ? { type: key, [PRIMARY[key]]: key === 'wait' ? Number(v) : v, ...rest } : { type: key, ...rest };
  }
  const mkey = keys.find((k) => MAESTRO_COMMANDS.has(k));
  if (mkey) return { type: 'maestro', commands: [item] };
  warnings.push(`${where}: unclear step ${JSON.stringify(item).slice(0, 80)}`);
  return null;
}

// a block: { params?, steps } or a bare list of steps — the shape data/blocks/*.yaml and bundles share
function normalizeBlock(b, warnings, where) {
  if (Array.isArray(b)) return { steps: normalizeSteps(b, warnings, `${where}, step`) };
  if (!b || typeof b !== 'object') { warnings.push(`${where}: a block is { params, steps } or a list of steps — not kept`); return { steps: [] }; }
  for (const k of Object.keys(b)) if (!BLOCK_KEYS.includes(k)) warnings.push(`${where}: unknown key "${k}" — not kept`);
  return { ...(b.params ? { params: b.params } : {}), steps: normalizeSteps(b.steps, warnings, `${where}, step`) };
}

function normalizeScenario(raw, warnings, where) {
  const list = (arr, label) => (arr || []).map((s, i) => normalizeStep(s, warnings, `${where}, ${label} ${i + 1}`)).filter(Boolean);
  const sc = { name: String(raw.name || raw.id || 'Untitled'), description: raw.description || '', steps: list(raw.steps, 'step') };
  // a key the console does not know is not kept: say so instead of dropping it quietly
  for (const k of Object.keys(raw)) if (!SCENARIO_ALL.includes(k)) warnings.push(`${where}: unknown key "${k}" — not kept`);
  for (const k of SCENARIO_KEYS) if (raw[k] !== undefined) sc[k] = raw[k];
  if (raw.setup) sc.setup = list(raw.setup, 'setup');
  if (raw.teardown) sc.teardown = list(raw.teardown, 'teardown');
  // variants: name → { title, vars, setup, teardown } — the steps inside are written like any others
  if (raw.variants && typeof raw.variants === 'object' && !Array.isArray(raw.variants)) {
    sc.variants = {};
    for (const [name, v] of Object.entries(raw.variants)) {
      if (!v || typeof v !== 'object' || Array.isArray(v)) { warnings.push(`${where}: variant "${name}" must be a map { title, vars, setup, teardown } — not kept`); continue; }
      for (const k of Object.keys(v)) if (!VARIANT_KEYS.includes(k)) warnings.push(`${where}: variant "${name}": unknown key "${k}" — not kept`);
      sc.variants[name] = { ...(v.title ? { title: v.title } : {}), ...(v.vars ? { vars: v.vars } : {}), ...(v.setup ? { setup: list(v.setup, `variant ${name}, setup`) } : {}), ...(v.teardown ? { teardown: list(v.teardown, `variant ${name}, teardown`) } : {}) };
    }
  }
  if (raw.blocks && typeof raw.blocks === 'object') {
    sc.blocks = {};
    for (const [name, b] of Object.entries(raw.blocks)) sc.blocks[name] = normalizeBlock(b, warnings, `${where}, block ${name}`);
  }
  if (sc.engine && !['adb', 'maestro', 'web'].includes(sc.engine)) { warnings.push(`${where}: unknown engine "${sc.engine}" — the default will be used`); delete sc.engine; }
  return sc;
}

function stepOut(step) {
  const { type, ...f } = step;
  for (const k of Object.keys(f)) if (f[k] === undefined || f[k] === '' || k.startsWith('_')) delete f[k];
  if (type === 'if') { const { if: cond, then, else: els, ...rest } = f; return { if: cond, ...(then ? { then: then.map(stepOut) } : {}), ...(els ? { else: els.map(stepOut) } : {}), ...rest }; }
  if (type === 'repeat') { const { steps, ...rest } = f; return { repeat: { ...rest, steps: (steps || []).map(stepOut) } }; }
  if (type === 'browser' || type === 'phone') { const { steps, ...rest } = f; return { [type]: (steps || []).map(stepOut), ...rest }; }
  if (type === 'use') { const { use, ...rest } = f; return { use, ...rest }; }
  if (type === 'maestro') {
    const cmds = f.commands || (f.yaml ? YAML.parse(f.yaml) : []);
    delete f.commands; delete f.yaml;
    return { maestro: cmds, ...f };
  }
  const keys = Object.keys(f);
  const name = type === 'type' ? 'input' : type;
  if (!keys.length) return name;
  if (type === 'launch' && keys.length === 1 && f.clear === true) return { launch: 'clear' };
  const p = PRIMARY[type];
  if (p && keys.length === 1 && keys[0] === p && typeof f[p] !== 'object') return { [name]: f[p] };
  return { [name]: f };
}

function scenarioOut(sc) {
  const out = { name: sc.name };
  if (sc.id) out.id = sc.id;
  if (sc.description) out.description = sc.description;
  for (const k of ['engine', 'appId', 'tags', 'tab', 'section', 'vars', 'matrix', 'rules', 'measure', 'order']) if (sc[k] !== undefined) out[k] = sc[k];
  if (sc.variants) out.variants = Object.fromEntries(Object.entries(sc.variants).map(([n, v]) => [n, { ...(v.title ? { title: v.title } : {}), ...(v.vars ? { vars: v.vars } : {}), ...(v.setup ? { setup: v.setup.map(stepOut) } : {}), ...(v.teardown ? { teardown: v.teardown.map(stepOut) } : {}) }]));
  if (sc.blocks) out.blocks = Object.fromEntries(Object.entries(sc.blocks).map(([n, b]) => [n, { ...(b.params ? { params: b.params } : {}), steps: (b.steps || []).map(stepOut) }]));
  if (sc.setup) out.setup = sc.setup.map(stepOut);
  out.steps = (sc.steps || []).map(stepOut);
  if (sc.teardown) out.teardown = sc.teardown.map(stepOut);
  return out;
}

// accounts → { plain: role → {} (the names alone, so lint and `auth:` know them), secret: role → phone, otp, tokens }
function splitAccounts(accounts) {
  if (!accounts || typeof accounts !== 'object') return {};
  const plain = {}, secret = {};
  for (const [role, a] of Object.entries(accounts)) {
    if (!a || typeof a !== 'object') continue;
    plain[role] = {};
    const s = Object.fromEntries(Object.entries(a).filter(([, v]) => v !== '' && v != null));
    if (Object.keys(s).length) secret[role] = s;
  }
  return { plain: Object.keys(plain).length ? plain : null, secret: Object.keys(secret).length ? secret : null };
}

// the portable part of the settings (PORTABLE); an absolute plugin path is this machine's, a relative one travels
function portableSettings(settings) {
  const out = {};
  for (const [k, rule] of Object.entries(PORTABLE)) {
    const v = settings[k];
    if (v === undefined || v === '' || v === null) continue;
    if (rule === true) { out[k] = v; continue; }
    if (!v || typeof v !== 'object') continue;
    const part = {};
    for (const f of rule) if (v[f] !== undefined && v[f] !== '') part[f] = v[f];
    if (k === 'auth' && part.plugin && path.isAbsolute(String(part.plugin))) delete part.plugin;
    if (Object.keys(part).length) out[k] = part;
  }
  return out;
}

// names of the blocks these scenarios call (`use:`), through blocks that call other blocks; own blocks of a
// scenario shadow the library, so they are not counted
function usedBlocks(scenarios, library) {
  const want = new Set();
  const walk = (steps, own) => {
    for (const st of steps || []) {
      if (!st || typeof st !== 'object') continue;
      if (st.type === 'use') {
        const name = String(st.use || st.block || '');
        if (name && !own.has(name) && library[name] && !want.has(name)) { want.add(name); walk(library[name].steps, new Set()); }
      }
      for (const k of ['then', 'else', 'steps']) if (Array.isArray(st[k])) walk(st[k], own);
    }
  };
  for (const sc of scenarios) {
    const own = new Set(Object.keys(sc.blocks || {}));
    for (const list of [sc.setup, sc.steps, sc.teardown, ...Object.values(sc.blocks || {}).map((b) => b.steps), ...Object.values(sc.variants || {}).flatMap((v) => [v.setup, v.teardown])]) walk(list, own);
  }
  return [...want].sort();
}
const blockOut = (b) => ({ ...(b.params ? { params: b.params } : {}), steps: (b.steps || []).map(stepOut) });
function invert(c) { return c && c.not ? c.not : { not: c }; }

function toYaml(value, comment) {
  const doc = new YAML.Document(value, { aliasDuplicateObjects: false });
  if (comment) doc.commentBefore = ' ' + comment;
  return doc.toString({ lineWidth: 0 });
}

function exportScenario(sc) {
  return toYaml(scenarioOut(sc), 'e2e-console scenario. Import: "Import" on the main page or node tools/e2e.js import <file>');
}

// library: the shared blocks; allBlocks: carry the whole library (an export of everything), otherwise only the
// blocks the exported scenarios call
function exportBundle({ scenarios, settings, withSecrets, library = {}, allBlocks = false }) {
  const plain = portableSettings(settings);
  const vars = Object.entries(settings.vars || {});
  const openVars = Object.fromEntries(vars.filter(([k, v]) => !personalVar(k, v)));
  const personal = Object.fromEntries(vars.filter(([k, v]) => personalVar(k, v)));
  if (Object.keys(openVars).length) plain.vars = openVars;
  const split = splitAccounts(settings.accounts);
  if (split.plain) plain.accounts = split.plain;
  const bundle = { kind: 'e2e-console/bundle', version: 1, settings: plain };
  if (withSecrets) {
    bundle.secrets = Object.fromEntries(SECRET_KEYS.filter((k) => settings[k]).map((k) => [k, settings[k]]));
    if (split.secret) bundle.secrets.accounts = split.secret;
    if (Object.keys(personal).length) bundle.secrets.vars = personal;
  }
  const names = allBlocks ? Object.keys(library).sort() : usedBlocks(scenarios, library);
  if (names.length) bundle.blocks = Object.fromEntries(names.map((n) => [n, blockOut(library[n])]));
  bundle.scenarios = scenarios.map(scenarioOut);
  return toYaml(bundle, withSecrets ? 'WARNING: contains keys and tokens — do not commit or share' : 'Without keys: add tokens separately (.env or "Import")');
}

// ---------- maestro → ours ----------
const REGEXY = /[\\^$*+?()[\]{}|]/;
const fromVars = (s) => (typeof s === 'string' ? s.replace(/\$\{\s*([A-Za-z_]\w*)\s*\}/g, '{{$1}}') : s);

function selectorText(sel) {
  if (typeof sel === 'string') return { text: sel };
  if (!sel || typeof sel !== 'object') return null;
  const extra = Object.keys(sel).filter((k) => !['text', 'id', 'optional', 'label'].includes(k));
  if (extra.length) return null;
  if (sel.text != null) return { text: String(sel.text), optional: sel.optional };
  if (sel.id != null) return { text: String(sel.id), optional: sel.optional, id: true };
  return null;
}
// «.*текст.*» with escaped specials is our «text contains» (how the console exports checks) → plain text.
function containsText(s) {
  if (!s || s.id) return s;
  const m = /^(?:\(\?s\))?\.\*(.*)\.\*$/s.exec(s.text);
  if (!m) return s;
  const inner = m[1];
  if (/(^|[^\\])[.*+?^()|[\]]/.test(inner)) return s;
  return { ...s, text: inner.replace(/\\(.)/g, '$1') };
}

function maestroToSteps(commands, ctx) {
  const steps = [];
  // A raw command keeps the script files it runs, so the step works without the original folder.
  const raw = (c) => {
    const step = { type: 'maestro', commands: [c] };
    const files = {};
    JSON.stringify(c, (k, v) => {
      if ((k === 'runScript' && typeof v === 'string') || (k === 'file' && typeof v === 'string' && /\.js$/.test(v))) {
        const f = ctx.files[path.basename(v)];
        if (f) files[v] = f.content; else ctx.warnings.push(`runScript "${v}": the file is not among the uploads — the step fails until you add it`);
      }
      if (k === 'runScript' && v && typeof v === 'object' && typeof v.file === 'string') {
        const f = ctx.files[path.basename(v.file)];
        if (f) files[v.file] = f.content; else ctx.warnings.push(`runScript "${v.file}": the file is not among the uploads`);
      }
      return v;
    });
    if (Object.keys(files).length) step.files = files;
    steps.push(step);
  };
  for (const cmd of commands) {
    const name = typeof cmd === 'string' ? cmd : Object.keys(cmd)[0];
    const v = typeof cmd === 'string' ? undefined : cmd[name];
    const last = steps[steps.length - 1];
    switch (name) {
      case 'launchApp': {
        const o = v && typeof v === 'object' ? v : {};
        if (o.appId && ctx.appId && o.appId !== ctx.appId) ctx.warnings.push(`launchApp for another app (${o.appId}) kept as a Maestro command`), raw(cmd);
        else if (Object.keys(o).some((k) => !['appId', 'clearState', 'stopApp'].includes(k))) raw(cmd);
        else steps.push({ type: 'launch', ...(o.clearState ? { clear: true } : {}) });
        break;
      }
      case 'tapOn': case 'doubleTapOn': {
        const s = selectorText(v);
        if (!s || (!s.id && REGEXY.test(s.text))) { raw(cmd); break; }
        steps.push({ type: 'tap', target: fromVars(s.text), ...(s.id ? { by: 'id' } : {}), ...(s.optional ? { optional: true } : {}), ...(name === 'doubleTapOn' ? { double: true } : {}) });
        break;
      }
      case 'inputText': {
        const text = fromVars(String(typeof v === 'object' && v ? v.text : v));
        const prevErase = last && last.type === 'maestro' && last.commands.length === 1 && (last.commands[0] === 'eraseText' || (last.commands[0] && last.commands[0].eraseText !== undefined));
        if (prevErase) steps.pop();
        const prevTap = steps[steps.length - 1];
        // tapOn field + inputText → one «Ввести текст» into that field
        if (prevTap && prevTap.type === 'tap' && !prevTap.double && !prevTap.optional) { steps.pop(); steps.push({ type: 'type', target: prevTap.target, ...(prevTap.by ? { by: prevTap.by } : {}), text, ...(prevErase ? {} : { clear: false }) }); }
        else steps.push({ type: 'type', text, ...(prevErase ? {} : { clear: false }) });
        break;
      }
      case 'pressKey':
        if (/^back$/i.test(String(v))) steps.push({ type: 'back' });
        else if (/^enter$/i.test(String(v)) && last && last.type === 'type' && !last.enter) last.enter = true;
        else raw(cmd);
        break;
      case 'back': steps.push({ type: 'back' }); break;
      case 'openLink': {
        const url = typeof v === 'object' && v ? v.link : v;
        if (typeof v === 'object' && v && Object.keys(v).some((k) => !['link', 'autoVerify'].includes(k))) raw(cmd);
        else steps.push({ type: 'link', url: fromVars(String(url)) });
        break;
      }
      case 'assertVisible': case 'assertNotVisible': {
        const s = containsText(selectorText(v));
        if (!s || s.id || REGEXY.test(s.text)) { raw(cmd); break; }
        steps.push({ type: 'assertText', text: fromVars(s.text), ...(name === 'assertNotVisible' ? { absent: true } : {}) });
        break;
      }
      case 'extendedWaitUntil': {
        const o = v || {};
        const which = o.visible !== undefined ? 'visible' : o.notVisible !== undefined ? 'notVisible' : null;
        // the console's own pause: wait for something that never shows, optionally
        const never = o.visible && /^__(e2e_)?never__$/.test((selectorText(o.visible) || {}).text || '');
        if (never && o.optional) { steps.push({ type: 'wait', seconds: Math.round(Number(o.timeout || 1000) / 1000) }); break; }
        const s = which && containsText(selectorText(o[which]));
        if (!s || s.id || REGEXY.test(s.text) || Object.keys(o).some((k) => ![which, 'timeout'].includes(k))) { raw(cmd); break; }
        steps.push({ type: 'assertText', text: fromVars(s.text), ...(which === 'notVisible' ? { absent: true } : {}), ...(o.timeout ? { timeout: Math.ceil(Number(o.timeout) / 1000) } : {}) });
        break;
      }
      case 'scroll': steps.push({ type: 'swipe', direction: 'down' }); break;
      case 'swipe': {
        const o = v || {};
        const dir = String(o.direction || '').toUpperCase();
        const fromText = o.from && selectorText(o.from);
        if (dir && !o.start && !o.end && Object.keys(o).every((k) => ['direction', 'from', 'duration'].includes(k))) {
          if (['UP', 'DOWN'].includes(dir) && !o.from) { steps.push({ type: 'swipe', direction: dir === 'UP' ? 'down' : 'up' }); break; }
          if (['LEFT', 'RIGHT'].includes(dir) && fromText && !fromText.id && !REGEXY.test(fromText.text)) { steps.push({ type: 'swipe', direction: dir.toLowerCase(), target: fromVars(fromText.text) }); break; }
        }
        raw(cmd);
        break;
      }
      case 'takeScreenshot':
        break; // the console screenshots every step itself
      case 'runFlow': {
        const file = typeof v === 'string' ? v : v && v.file;
        if (file && !(v && (v.when || v.env))) {
          const sub = ctx.files[path.basename(file)];
          if (sub && ctx.depth < 5) {
            const parsed = parseMaestro(sub.content, sub.name, { ...ctx, depth: ctx.depth + 1 });
            steps.push(...parsed.steps);
            break;
          }
          ctx.warnings.push(`runFlow "${file}": the file is not among the uploads — kept as a Maestro command (will not work without the file)`);
        }
        raw(cmd);
        break;
      }
      default:
        raw(cmd);
    }
  }
  // Raw neighbours are one step: fewer Maestro round trips in a run, same meaning.
  const merged = [];
  for (const s of steps) {
    const prev = merged[merged.length - 1];
    const plain = (x) => Object.keys(x).every((k) => ['type', 'commands', 'files'].includes(k));
    if (s.type === 'maestro' && prev && prev.type === 'maestro' && plain(prev) && plain(s)) {
      prev.commands.push(...s.commands);
      if (s.files) prev.files = { ...(prev.files || {}), ...s.files };
    }
    else merged.push(s);
  }
  return merged;
}

function parseMaestro(text, name, ctx) {
  const docs = YAML.parseAllDocuments(text).map((d) => d.toJS());
  let header = {}, commands;
  if (docs.length >= 2) { header = docs[0] || {}; commands = docs[1] || []; }
  else if (Array.isArray(docs[0])) commands = docs[0];
  else { header = docs[0] || {}; commands = []; }
  if (!Array.isArray(commands)) throw new Error(`${name}: a list of Maestro commands must follow "---"`);
  const local = { ...ctx, appId: ctx.appId };
  if (header.appId && ctx.appId && header.appId !== ctx.appId) ctx.warnings.push(`${name}: appId ${header.appId} differs from the package in the settings (${ctx.appId})`);
  const pre = header.onFlowStart ? [{ type: 'maestro', commands: header.onFlowStart }] : [];
  const steps = [...pre, ...maestroToSteps(commands, local)];
  if (header.onFlowComplete) ctx.warnings.push(`${name}: onFlowComplete is not carried over — add the steps at the end yourself`);
  return { header, steps };
}

// ---------- ours → maestro ----------
const toVars = (s, saved) => String(s ?? '').replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, k) => (saved.has(k) ? '${output.' + k + '}' : '${' + k + '}'));

// One backend check as a Maestro script file (runScript): Maestro gives it http, json and output,
// and env values (API_BASE, BUYER_TOKEN, …) as globals. evalScript cannot hold it: Maestro's ${…}
// parser stops at the first «}».
// Templates from the settings ({{name}} → the template's text, with fresh {{uuid}} / {{now}} on every call) are expanded
// the same way the console's own runner does it.
function apiScript(step, saved, role, templates = {}) {
  const js = (s, depth = 0) => {
    // a string with {{placeholders}} → a JS expression
    const parts = String(s ?? '').split(/(\{\{\s*[\w.]+\s*\}\})/).filter((p) => p !== '');
    if (!parts.length) return "''";
    return parts.map((p) => {
      const m = /^\{\{\s*([\w.]+)\s*\}\}$/.exec(p);
      if (!m) return JSON.stringify(p);
      const k = m[1];
      if (k === 'uuid') return 'uuid()';
      if (k === 'now') return 'new Date().toISOString()';
      if (k === 'hex64') return 'hex(64)';
      if (saved.has(k)) return `output.${k}`;
      if (templates[k] !== undefined && depth < 5) {
        const t = templates[k];
        return '(' + js(typeof t === 'string' ? t : JSON.stringify(t), depth + 1) + ')';
      }
      return `(typeof ${k} !== 'undefined' ? ${k} : '')`;
    }).join(' + ');
  };
  const body = step.body ? js(typeof step.body === 'string' ? step.body : JSON.stringify(step.body)) : null;
  const token = step.auth === 'none' ? null : String(step.auth || role).toUpperCase().replace(/\W/g, '_') + '_TOKEN';
  const headers = Object.entries(step.headers || {}).map(([k, v]) => `${JSON.stringify(k)}: ${js(v)}`);
  if (token) headers.push(`authorization: 'Bearer ' + ${token}`);
  if (body) headers.push("'content-type': 'application/json'");
  const url = /^https?:/.test(step.url || '') ? js(step.url) : `API_BASE + '/' + ${js(String(step.url || '').replace(/^\//, ''))}`;
  const lines = [
    `// ${step.title || 'backend check'}: ${step.auth && step.auth !== 'none' ? '[' + step.auth + '] ' : ''}${step.method || 'GET'} ${step.url}`,
    'function uuid(){return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g,function(c){var r=Math.random()*16|0;return (c=="x"?r:(r&3|8)).toString(16)})}',
    'function hex(n){var s="";while(s.length<n)s+=Math.floor(Math.random()*16).toString(16);return s}',
    'function pick(o,p){return p.split(".").filter(Boolean).reduce(function(o,k){if(o==null)return undefined;var m=/^(\\w*)\\[(\\w+)=([^\\]]*)\\]$/.exec(k);if(!m)return o[k];var a=m[1]?o[m[1]]:o;return Array.isArray(a)?a.filter(function(x){return x&&String(x[m[2]])===m[3]})[0]:undefined},o)}',
    `var r = http.request(${url}, {method: ${JSON.stringify(step.method || 'GET')}, headers: {${headers.join(', ')}}${body ? ', body: ' + body : ''}});`,
    'var j; try { j = json(r.body); } catch (e) { j = undefined; }',
    step.expectStatus ? `if (r.status != ${Number(step.expectStatus)}) throw new Error('HTTP ' + r.status + ' ' + r.body);` : "if (r.status >= 400) throw new Error('HTTP ' + r.status + ' ' + r.body);"
  ];
  if (step.expectPath) lines.push(`var got = String(pick(j, ${js(step.expectPath)})); if (${js(String(step.expectValue ?? ''))}.split('|').indexOf(got) < 0) throw new Error(${JSON.stringify(step.expectPath)} + ' = ' + got);`);
  for (const [k, p] of Object.entries(step.save || {})) {
    lines.push(`output.${k} = pick(j, ${js(p)}); if (output.${k} == null) throw new Error('no ${p}');`);
    saved.add(k);
  }
  return lines.join('\n') + '\n';
}

// → { files: [{ name, content }] }: flow.yaml, plus scripts/NN-….js when the scenario checks the backend
function exportMaestro(sc, settings, library = {}) {
  const saved = new Set();
  const out = [];
  const scripts = [];
  const cmd = (c) => out.push(YAML.stringify([c], { lineWidth: 0, aliasDuplicateObjects: false }).trimEnd());
  const note = (t) => out.push('# ' + t.replace(/\n/g, ' '));
  const compiled = compile(sc, { library });
  for (const w of compiled.errors) note('ERROR: ' + w);
  const plat = (x) => (x && typeof x === 'object' && !Array.isArray(x) ? x.android ?? x.ios ?? '' : x);
  const condOf = (c) => {
    if (!c) return null;
    if (c.not && c.not.visible) return { notVisible: String(toVars(plat(c.not.visible), saved)) };
    if (c.not && c.not.notVisible) return { visible: String(toVars(plat(c.not.notVisible), saved)) };
    const w = {};
    if (c.visible) w.visible = String(toVars(plat(c.visible), saved));
    if (c.notVisible) w.notVisible = String(toVars(plat(c.notVisible), saved));
    if (c.var) w.true = c.equals !== undefined ? '${output.' + c.var + ' == ' + JSON.stringify(String(c.equals)) + '}' : '${!!output.' + c.var + '}';
    if (c.platform) w.platform = c.platform === 'ios' ? 'iOS' : 'Android';
    if (c.not && !w.visible && !w.notVisible) { const inner = condOf(c.not); if (inner && inner.true) w.true = '${!(' + inner.true.slice(2, -1) + ')}'; }
    return Object.keys(w).length ? w : null;
  };
  let lastPhase = 'main', lastFrom = null;
  for (const s0 of compiled.steps) {
    const s = { ...s0 };
    for (const k of ['target', 'text', 'url']) if (k in s) s[k] = plat(s[k]);
    if (s._phase !== lastPhase) { note(`— ${s._phase} —`); lastPhase = s._phase; }
    if (s._from && s._from !== lastFrom) note(`block ${s._from}`);
    lastFrom = s._from || null;
    // a conditional group: each command wrapped in runFlow.when (an else branch is the negated condition)
    const when = s._cond ? condOf(s._cond.negate ? invert(s._cond.when) : s._cond.when) : null;
    const before = out.length;
    const t = (x) => toVars(x, saved);
    switch (s.type) {
      case 'repeat': {
        const inner = YAML.parse(exportMaestro({ name: 'x', steps: s.steps || [] }, settings, library).files[0].content.split('---\n')[1] || '[]') || [];
        cmd(s.until ? { repeat: { while: condOf(invert(s.until)) || { true: 'true' }, commands: inner } } : { repeat: { times: Number(s.times) || Number(s.max) || 10, commands: inner } });
        break;
      }
      case 'assertScreen': note(`baseline comparison "${s.baseline || ''}" — console only`); break;
      case 'launch': cmd(s.clear ? { launchApp: { clearState: true } } : 'launchApp'); break;
      case 'tap': {
        const key = s.by === 'id' ? 'id' : 'text';
        const sel = s.optional || s.by === 'id' ? { [key]: t(s.target), ...(s.optional ? { optional: true } : {}) } : t(s.target);
        if (s.dx || s.dy) note(`the step tapped with an offset (${s.dx || 0}, ${s.dy || 0}) from "${s.target}" — Maestro has no offset, check it`);
        if (s.fallback) { cmd({ tapOn: { text: t(s.target), optional: true } }); note(`if "${s.target}" is not in the tree: tapOn point ${s.fallback.join(',')}`); break; }
        cmd({ [s.double ? 'doubleTapOn' : 'tapOn']: sel });
        break;
      }
      case 'type':
        if (s.target) cmd({ tapOn: s.by === 'id' ? { id: t(s.target) } : t(s.target) });
        if (s.clear !== false) cmd({ eraseText: 40 });
        cmd({ inputText: t(s.text) });
        if (s.enter) cmd({ pressKey: 'Enter' });
        break;
      case 'link': cmd({ openLink: t(s.url) }); break;
      case 'swipe':
        if ((s.direction === 'left' || s.direction === 'right') && s.target) cmd({ swipe: { from: { text: t(s.target) }, direction: s.direction.toUpperCase() } });
        else if ((s.direction || 'down') === 'down') cmd('scroll');
        else cmd({ swipe: { direction: { up: 'DOWN', left: 'LEFT', right: 'RIGHT' }[s.direction] } });
        break;
      case 'pinch': note(`pinch ${s.direction || 'out'}${Number(s.times) > 1 ? ' ×' + s.times : ''} — console only (Maestro has no two-finger gestures)`); break;
      case 'back': cmd('back'); break;
      case 'wait': cmd({ extendedWaitUntil: { visible: { text: '__never__' }, timeout: (Number(s.seconds) || 1) * 1000, optional: true } }); break;
      case 'assertText': {
        // ours matches text containing the value; Maestro matches the whole text as a regex
        // ($ and braces stay: they carry Maestro's ${...} variables)
        if (s.count != null) note(`count check (${s.count} × "${s.id || s.text}") — console only`);
        const text = s.id || s.by === 'id' ? { id: String(t(s.id || s.text)) } : s.regex ? '(?s).*(' + String(t(s.text)) + ').*'
          : '.*' + String(t(s.text)).replace(/[.*+?^()|[\]\\]/g, (c) => '\\' + c) + '.*';
        cmd(s.timeout ? { extendedWaitUntil: { [s.absent ? 'notVisible' : 'visible']: text, timeout: Number(s.timeout) * 1000 } }
          : { [s.absent ? 'assertNotVisible' : 'assertVisible']: text });
        break;
      }
      case 'api': {
        note(`${s.title || 'backend'}: ${s.auth && s.auth !== 'none' ? '[' + s.auth + '] ' : ''}${s.method || 'GET'} ${s.url}`);
        const file = 'scripts/' + String(scripts.length + 1).padStart(2, '0') + '-' + String(s.method || 'get').toLowerCase() + '-'
          + (String(s.url || '').split('?')[0].split('/').filter((x) => x && !x.includes('{{')).slice(-2).join('-').replace(/[^\w-]+/g, '') || 'api') + '.js';
        scripts.push({ name: file, content: apiScript(s, saved, defaultRole(settings), (settings && settings.templates) || {}) });
        const run = { runScript: file };
        cmd(Number(s.timeout) > 5 ? { retry: { maxRetries: Math.min(10, Math.ceil(Number(s.timeout) / 5)), commands: [run] } } : run);
        break;
      }
      case 'ai': note(`manual step: ${s.text || ''}`); break;
      case 'maestro': for (const c of s.commands || YAML.parse(s.yaml || '[]') || []) cmd(c); break;
      default: note(`unknown step ${s.type}`);
    }
    if (when && out.length > before) {
      const cmds = YAML.parse(out.splice(before).filter((l) => !l.startsWith('#')).join('\n')) || [];
      cmd({ runFlow: { when, commands: cmds } });
    }
  }
  // Maestro names its report folder after the flow: Windows refuses «:» and friends there (2.12.1).
  const header = { appId: (settings && settings.package) || sc.appId || 'com.example.app', name: String(sc.name).replace(/[<>:"/\\|?*]+/g, ' —').replace(/\s+/g, ' ').trim() };
  const env = Object.fromEntries(Object.keys(sc.vars || {}).map((k) => [k, String(sc.vars[k])]));
  if (Object.keys(env).length) header.env = env;
  const flow = [
    `# Maestro flow from the e2e-console scenario "${sc.name}".`,
    scripts.length ? '# Backend checks — scripts/*.js. Run: maestro test flow.yaml -e API_BASE=https://api.example.com -e <ROLE>_TOKEN=… per role (+ scenario variables)' : '# Run: maestro test flow.yaml',
    YAML.stringify(header, { lineWidth: 0 }).trimEnd(),
    '---',
    ...out
  ].join('\n') + '\n';
  return { files: [{ name: 'flow.yaml', content: flow }, ...scripts] };
}

// ---------- env ----------
function parseEnv(text) {
  const patch = {};
  for (const line of String(text).split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][\w.]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m || line.trim().startsWith('#')) continue;
    let v = m[2];
    if (/^(['"]).*\1$/.test(v)) v = v.slice(1, -1);
    if (v === '') continue; // an empty line in a template must not wipe a key that is already set
    const role = ROLE_ENV.exec(m[1]);
    const key = ENV_MAP[m[1]] || (role ? `accounts.${role[1].toLowerCase()}.${ROLE_FIELD[role[2]]}` : SETTING_KEYS.includes(m[1]) ? m[1] : 'vars.' + m[1]);
    setPath(patch, key, v);
  }
  return patch;
}
function setPath(obj, key, v) {
  const parts = key.split('.');
  let o = obj;
  while (parts.length > 1) { const p = parts.shift(); o = o[p] = o[p] || {}; }
  o[parts[0]] = v;
}

// ---------- entry ----------
function detect(name, text) {
  const ext = path.extname(name || '').toLowerCase();
  if (ext === '.env' || /(^|[\\/])\.env(\.|$)|\.env(\.\w+)?$/.test(name || '')) return 'env';
  const t = String(text).trim();
  if (!t) return 'native';
  if (ext === '.json' || t.startsWith('{') || t.startsWith('[')) return 'native';
  if (/^\s*[A-Z_][A-Z0-9_]*\s*=/m.test(t) && !/^\s*-\s/m.test(t) && !/:\s/.test(t.split('\n')[0])) return 'env';
  let docs;
  try { docs = YAML.parseAllDocuments(t).map((d) => d.toJS()); } catch { return 'native'; }
  if (docs.length >= 2 && docs[0] && typeof docs[0] === 'object' && !Array.isArray(docs[0]) && (docs[0].appId || docs[0].url) && Array.isArray(docs[1])) return 'maestro';
  if (docs[0] && !Array.isArray(docs[0]) && docs[0].appId && !docs[0].steps) return 'maestro';
  if (Array.isArray(docs[0]) && docs[0].length && docs[0].every((c) => {
    const k = typeof c === 'string' ? c : c && Object.keys(c)[0];
    return MAESTRO_COMMANDS.has(k) && !STEP_TYPES.includes(k);
  })) return 'maestro';
  return 'native';
}

function baseName(name) {
  return path.basename(name || 'import').replace(/\.(ya?ml|json|env)$/i, '');
}

// Saved settings with the old flat buyer / seller keys → the same settings with them moved into accounts and
// dropped; null when there is nothing to move. Only empty fields are filled. When the file already has accounts,
// only the roles listed there are filled — a role the user deleted must not come back from a leftover key.
function migrateLegacy(saved) {
  if (!saved || typeof saved !== 'object') return null;
  const flat = Object.values(LEGACY_TOKENS).flatMap((m) => Object.values(m)).filter((k) => k in saved);
  const v = saved.vars || {};
  const fromVars = !saved.accounts && Object.values(LEGACY_VARS).some((m) => v[m.phone]);
  if (!flat.length && !fromVars) return null;
  const next = { ...saved, accounts: { ...(saved.accounts || {}) } };
  for (const role of Object.keys(LEGACY_TOKENS)) {
    const l = { phone: v[LEGACY_VARS[role].phone], token: saved[LEGACY_TOKENS[role].token], refreshToken: saved[LEGACY_TOKENS[role].refreshToken] };
    if (!Object.values(l).some(Boolean)) continue;
    if (saved.accounts && !saved.accounts[role]) continue;
    const a = { ...(next.accounts[role] || {}) };
    for (const [k, x] of Object.entries({ ...l, otp: v[LEGACY_VARS[role].otp] })) if (!a[k] && x) a[k] = x;
    next.accounts[role] = a;
  }
  for (const k of flat) delete next[k];
  return next;
}
// An imported patch with the old flat token keys: they set (not fill) the role's field, as the import asked.
function legacyPatch(patch) {
  for (const [role, m] of Object.entries(LEGACY_TOKENS)) {
    for (const [field, key] of Object.entries(m)) {
      if (!(key in patch)) continue;
      if (patch[key]) {
        patch.accounts = patch.accounts || {};
        patch.accounts[role] = { ...(patch.accounts[role] || {}), [field]: patch[key] };
      }
      delete patch[key];
    }
  }
  return patch;
}

// A block library file: a map name → { params, steps } or name → [steps] (data/blocks/*.yaml, a preset's blocks/).
function isBlockLibrary(doc) {
  const vals = Object.values(doc);
  return vals.length > 0 && !doc.kind && vals.every((b) => Array.isArray(b) || (b && typeof b === 'object' && Array.isArray(b.steps) && Object.keys(b).every((k) => BLOCK_KEYS.includes(k))));
}

// The editor saves YAML as data: comments have nowhere to go. Every comment token, with its line.
function yamlComments(text) {
  const found = [];
  const walk = (x) => {
    if (!x || typeof x !== 'object') return;
    if (Array.isArray(x)) { x.forEach(walk); return; }
    if (x.type === 'comment' && typeof x.offset === 'number') { found.push({ line: String(text).slice(0, x.offset).split('\n').length, text: String(x.source || '').trim() }); return; }
    for (const v of Object.values(x)) if (v && typeof v === 'object') walk(v);
  };
  for (const tok of new YAML.Parser().parse(String(text))) walk(tok);
  // the header the console writes on export says nothing about the scenario
  return found.filter((c) => !/^# e2e-console scenario\./.test(c.text));
}
function keyLine(text, key) {
  const esc = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const lines = String(text).split(/\r?\n/);
  // a key that starts its line first, then one inside a { … } map
  let i = lines.findIndex((l) => new RegExp(`^\\s*(-\\s+)?["']?${esc}["']?\\s*:`).test(l));
  if (i < 0) i = lines.findIndex((l) => new RegExp(`[{,]\\s*["']?${esc}["']?\\s*:`).test(l));
  if (i < 0) i = lines.findIndex((l) => new RegExp(`^\\s*-\\s+["']?${esc}["']?\\s*$`).test(l));
  return i >= 0 ? i + 1 : null;
}

// files: [{ name, content }], mode: auto | native | maestro | env
// → { scenarios: [scenario], settings: patch | null, blocks: name → block | null, warnings: [], files: [{ name, mode }] }
// strict (the editor's YAML save): anything that would not survive the trip — a comment, an unknown key, an
// unclear step — is listed in `errors` instead of being dropped with a warning
function parseImport(files, { mode = 'auto', appId, strict = false } = {}) {
  const result = { scenarios: [], settings: null, blocks: null, warnings: [], files: [] };
  const addBlocks = (map, where) => {
    result.blocks = result.blocks || {};
    for (const [n, b] of Object.entries(map || {})) {
      const block = normalizeBlock(b, result.warnings, `${where}, block ${n}`);
      if (result.blocks[n] && JSON.stringify(result.blocks[n]) !== JSON.stringify(block)) result.warnings.push(`${where}: block "${n}" is also in another file — this one is taken`);
      result.blocks[n] = block;
    }
  };
  const byName = Object.fromEntries(files.map((f) => [path.basename(f.name || ''), f]));
  // Maestro subflows referenced by runFlow are inlined, not imported on their own.
  const referenced = new Set();
  for (const f of files) {
    for (const m of String(f.content).matchAll(/runFlow:\s*(?:\n\s*file:\s*)?["']?([^\s"'\n]+\.ya?ml)/g)) referenced.add(path.basename(m[1]));
  }
  const mergeSettings = (patch) => {
    result.settings = result.settings || {};
    for (const [k, v] of Object.entries(patch)) {
      if (k === 'accounts' && v && typeof v === 'object') {
        result.settings.accounts = result.settings.accounts || {};
        for (const [role, a] of Object.entries(v)) result.settings.accounts[role] = { ...(result.settings.accounts[role] || {}), ...(a || {}) };
      } else if (['vars', 'logs', 'maestro', 'templates', 'auth', 'appNet', 'web', 'runs'].includes(k) && v && typeof v === 'object' && !Array.isArray(v)) result.settings[k] = { ...(result.settings[k] || {}), ...v };
      else result.settings[k] = v;
    }
  };
  for (const f of files) {
    const name = f.name || 'pasted text';
    if (/\.js$/i.test(name)) { result.files.push({ name, mode: 'script for runScript' }); continue; }
    const m = mode === 'auto' ? detect(name, f.content) : mode;
    if (m === 'maestro' && referenced.has(path.basename(name)) && files.length > 1) { result.files.push({ name, mode: 'maestro (subflow)' }); continue; }
    result.files.push({ name, mode: m });
    try {
      if (m === 'env') { mergeSettings(parseEnv(f.content)); continue; }
      if (m === 'maestro') {
        const ctx = { files: byName, warnings: result.warnings, depth: 0, appId };
        const { header, steps } = parseMaestro(f.content, name, ctx);
        const sc = { name: header.name || baseName(name), description: `Imported from Maestro: ${path.basename(name)}`, engine: 'maestro', steps };
        if (header.env) sc.vars = Object.fromEntries(Object.entries(header.env).map(([k, v]) => [k, fromVars(String(v))]));
        if (header.tags) sc.tags = header.tags;
        result.scenarios.push(sc);
        continue;
      }
      // native: JSON or YAML; one scenario, a list of them, bare steps, or a bundle
      const text = String(f.content);
      let docs;
      if (/^\s*[[{]/.test(text)) docs = [JSON.parse(text)];
      else {
        // a YAML error (an unquoted {{var}} inside { … } is the usual one) must not import a half-parsed scenario
        const parsed = YAML.parseAllDocuments(text);
        const bad = parsed.flatMap((d) => d.errors);
        if (bad.length) throw new Error('YAML error — ' + bad[0].message.split('\n')[0] + (/\{\{/.test(text) ? ' (hint: {{variables}} inside { … } must be quoted)' : ''));
        // `target: {{x}}` is valid YAML — a map whose key is the map {x} — so it parses without an error and the step
        // would tap "[object Object]". A map or a list used as a key is never meant in a scenario.
        for (const d of parsed) {
          YAML.visit(d, {
            Pair(_, pair) {
              if (!YAML.isMap(pair.key) && !YAML.isSeq(pair.key)) return;
              const at = pair.key.range ? text.slice(0, pair.key.range[0]).split('\n').length : 0;
              throw new Error(`YAML error — line ${at}: an unquoted {{variable}} is read as a nested map; put it in quotes: "{{name}}"`);
            }
          });
        }
        docs = parsed.map((d) => d.toJS());
      }
      for (const doc of docs) {
        if (doc == null) continue;
        if (Array.isArray(doc)) {
          if (doc.length && doc.every((x) => x && typeof x === 'object' && Array.isArray(x.steps))) doc.forEach((x, i) => result.scenarios.push(normalizeScenario(x, result.warnings, `${name} #${i + 1}`)));
          else result.scenarios.push(normalizeScenario({ name: baseName(name), steps: doc }, result.warnings, name));
          continue;
        }
        if (doc.kind === 'e2e-console/bundle' || doc.scenarios || doc.settings || doc.secrets) {
          if (doc.settings) mergeSettings(Object.fromEntries(Object.entries(doc.settings).filter(([k]) => SETTING_KEYS.includes(k) && !SECRET_KEYS.includes(k))));
          if (doc.secrets) mergeSettings(Object.fromEntries(Object.entries(doc.secrets).filter(([k]) => SECRET_KEYS.includes(k) || k === 'accounts' || k === 'vars')));
          if (doc.vars) mergeSettings({ vars: doc.vars });
          if (doc.blocks && typeof doc.blocks === 'object' && !Array.isArray(doc.blocks)) addBlocks(doc.blocks, name);
          (doc.scenarios || []).forEach((x, i) => result.scenarios.push(normalizeScenario(x, result.warnings, `${name}, scenario ${i + 1}`)));
          continue;
        }
        if (doc.steps) { result.scenarios.push(normalizeScenario({ name: baseName(name), ...doc }, result.warnings, name)); continue; }
        if (!strict && isBlockLibrary(doc)) { addBlocks(doc, name); result.files[result.files.length - 1].mode = 'blocks'; continue; }
        result.warnings.push(`${name}: found neither steps, nor scenarios, nor settings`);
      }
    } catch (e) {
      result.warnings.push(`${name}: ${e.message}`);
    }
  }
  if (result.settings) legacyPatch(result.settings);
  if (strict) {
    const text = files.map((f) => String(f.content)).join('\n');
    result.errors = [
      ...(/^\s*[[{]/.test(text) ? [] : yamlComments(text).map((c) => `line ${c.line}: comment "${c.text.slice(0, 60)}" would be lost — a scenario is stored as data; put the note into description or a step title`)),
      ...result.warnings.map((w) => {
        const k = /unknown key "([^"]+)"/.exec(w) || /unclear step \{"([^"]+)"/.exec(w) || /unclear step "([^"]+)"/.exec(w);
        const line = k && keyLine(text, k[1]);
        return line ? `line ${line}: ${w}` : w;
      })
    ];
  }
  return result;
}

const normalizeSteps = (list, warnings = [], where = "") => (list || []).map((s, i) => normalizeStep(s, warnings, `${where} ${i + 1}`)).filter(Boolean);
module.exports = { parseImport, exportScenario, exportBundle, exportMaestro, scenarioOut, normalizeSteps, normalizeBlock, blockOut, usedBlocks, migrateLegacy, detect, STEP_TYPES, SECRET_KEYS, ACCOUNT_SECRETS, splitAccounts };
