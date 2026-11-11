'use strict';
// Checks a scenario before it runs: the shape of every step (the same table also produces the JSON
// Schema for editors), unknown {{variables}}, unknown blocks and roles, and — when a previous run is
// at hand — `save` / `expectPath` fields that the backend did not return last time.
const { compile, variantsOf, condChain, CONDITION_KEYS, defaultRole } = require('./compile');

const str = { type: 'string' }, num = { type: 'number' }, bool = { type: 'boolean' }, obj = { type: 'object' }, arr = { type: 'array' };
// text that may differ per platform: 'В корзину' or { android: 'В корзину', ios: 'Add to cart' }
const text = { oneOf: [str, { type: 'object', properties: { android: str, ios: str }, additionalProperties: false }] };
const screen = { enum: ['web', 'browser', 'phone'], description: 'where it runs: web (the browser) or phone; default — the scenario engine' };
const cond = { type: 'object', description: 'condition: visible / notVisible (text on screen), var + equals|matches, platform, not; on — which screen to look at', properties: {
  visible: text, notVisible: text, var: str, equals: {}, matches: str, platform: { enum: ['android', 'ios'] }, not: { $ref: '#/definitions/condition' }, on: screen, timeout: { ...num, description: 'seconds to look for visible / notVisible (3)' } }, additionalProperties: false };
const steps = { type: 'array', items: { $ref: '#/definitions/step' } };

// common to every step
const COMMON = {
  type: str, title: str, screenshot: bool, figma: str, when: { $ref: '#/definitions/condition' }, on: screen,
  retry: { ...num, description: 'retry the step this many times on failure' }, optional: { ...bool, description: 'a failure does not fail the run' },
  flaky: { ...bool, description: 'known flaky: two attempts, marked in the report' }, timeout: { ...num, description: 'seconds to wait' }, allowStatus: arr
};
const FIELDS = {
  launch: { clear: bool, settle: num, url: { ...str, description: 'browser: the page to open (full, or a path under the site address from the settings)' }, storage: { ...obj, description: 'browser: localStorage entries to put in place before the page loads' } },
  browser: { steps: { ...steps, required: true, description: 'these steps run in the browser' } },
  phone: { steps: { ...steps, required: true, description: 'these steps run on the phone' } },
  link: { url: { ...text, required: true }, settle: num },
  tap: { target: { ...text, required: true }, by: { enum: ['text', 'id'] }, double: bool, dx: num, dy: num, after: num, fallback: arr },
  type: { text: { ...str, required: true }, target: text, by: { enum: ['text', 'id'] }, clear: bool, enter: bool },
  swipe: { direction: { enum: ['up', 'down', 'left', 'right'] }, target: text, fast: { ...bool, description: 'a fling: 80 ms over most of the screen' }, times: { ...num, description: 'how many swipes in a row' }, pause: { ...num, description: 'seconds between swipes (0.25 with fast, else 1)' }, duration: { ...num, description: 'gesture duration, ms' } },
  back: {},
  wait: { seconds: num },
  assertText: { text, id: str, absent: bool, regex: bool, count: num, by: { enum: ['text', 'id'] } },
  assertScreen: { baseline: str, threshold: num, ignore: arr },
  api: { url: { ...str, required: true }, method: { enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] }, auth: str, headers: obj, body: {}, expectPath: str, expectValue: {}, expectStatus: num, save: obj, poll: num, interval: num },
  ai: { text: { ...str, required: true } },
  maestro: { commands: arr, yaml: str, files: obj },
  use: { use: { ...str, required: true }, with: obj },
  if: { if: { $ref: '#/definitions/condition', required: true }, then: steps, else: steps },
  repeat: { steps: { ...steps, required: true }, until: { $ref: '#/definitions/condition' }, times: num, max: num }
};
const BUILTIN_VARS = new Set(['uuid', 'now', 'hex64']);

function typeOk(spec, v) {
  if (!spec || spec.$ref || Object.keys(spec).length === 0) return true;
  if (spec.enum) return spec.enum.includes(v);
  if (spec.oneOf) return spec.oneOf.some((s) => typeOk(s, v));
  if (spec.type === 'array') return Array.isArray(v);
  if (spec.type === 'object') {
    if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
    // a closed object (per-platform text: android / ios) takes no other keys: `target: {{x}}` unquoted arrives as { '{ x }': null }
    if (spec.properties && spec.additionalProperties === false) return Object.entries(v).every(([k, x]) => spec.properties[k] && typeOk(spec.properties[k], x));
    return true;
  }
  if (spec.type === 'number') return typeof v === 'number' || (typeof v === 'string' && v.trim() !== '' && !isNaN(Number(v)));
  if (spec.type === 'boolean') return typeof v === 'boolean';
  if (spec.type === 'string') return typeof v === 'string';
  return true;
}

// the runner refuses a condition that names none of these, so lint does too
const CONDITION_SUBJECTS = ['visible', 'notVisible', 'var', 'platform', 'not'];
function checkCondition(c, where, out) {
  if (!c || typeof c !== 'object' || Array.isArray(c)) { out.errors.push(`${where}: the condition must be an object (visible / notVisible / var …)`); return; }
  // a misspelt key (`visibel`) would otherwise leave the condition meaning something else
  for (const k of Object.keys(c)) if (!CONDITION_KEYS.includes(k)) out.errors.push(`${where}: unknown condition field "${k}"`);
  if ((c.equals !== undefined || c.matches !== undefined) && !c.var) out.errors.push(`${where}: equals/matches need var`);
  if (c.not) checkCondition(c.not, where + ' → not', out);
  if (!CONDITION_SUBJECTS.some((k) => c[k] !== undefined)) out.errors.push(`${where}: empty condition — visible / notVisible / var / platform / not`);
}

function varsIn(value, acc = new Set()) {
  if (typeof value === 'string') for (const m of value.matchAll(/\{\{\s*([\w.]+)\s*\}\}/g)) acc.add(m[1]);
  else if (Array.isArray(value)) value.forEach((v) => varsIn(v, acc));
  else if (value && typeof value === 'object') Object.values(value).forEach((v) => varsIn(v, acc));
  return acc;
}

function pick(o, p) {
  return String(p || '').split('.').filter(Boolean).reduce((x, k) => {
    if (x == null) return undefined;
    const m = /^(\w*)\[(\w+)=([^\]]*)\]$/.exec(k);
    if (!m) return x[k];
    const a = m[1] ? x[m[1]] : x;
    return Array.isArray(a) ? a.find((y) => y && String(y[m[2]]) === m[3]) : undefined;
  }, o);
}

function checkStep(step, where, out, ctx) {
  const spec = FIELDS[step.type];
  if (!spec) { out.errors.push(`${where}: unknown step type "${step.type}"`); return; }
  for (const [k, v] of Object.entries(step)) {
    if (k.startsWith('_')) continue;
    const s = spec[k] || COMMON[k];
    if (!s) { out.warnings.push(`${where}: field "${k}" does nothing on a ${step.type} step`); continue; }
    if (!typeOk(s, v)) out.errors.push(`${where}: field "${k}" has the wrong type (${JSON.stringify(v).slice(0, 40)})`);
  }
  for (const [k, s] of Object.entries(spec)) if (s.required && (step[k] === undefined || step[k] === '')) out.errors.push(`${where}: the ${step.type} step lacks the required field "${k}"`);
  if (step.type === 'assertText' && !step.text && !step.id) out.errors.push(`${where}: a screen check needs text or id`);
  if (step.type === 'repeat' && !step.until && !step.times) out.warnings.push(`${where}: repeat without until or times repeats max times (${step.max || 10})`);
  // compile folded if/when into the `_cond` chain; a group's condition is reported once, on its first member
  for (const c of condChain(step)) {
    if (ctx.condsSeen.has(c.id)) continue;
    ctx.condsSeen.add(c.id);
    checkCondition(c.when, `${where} → ${c.negate ? 'else of if' : 'if/when'}`, out);
  }
  if (step.until) checkCondition(step.until, where + ' → until', out);
  if (step.type === 'api') {
    const role = step.auth || ctx.defaultRole;
    if (role !== 'none' && ctx.accounts && !ctx.accounts.has(role)) out.errors.push(`${where}: role "${role}" is not described in the settings (accounts)`);
    if (step.expectValue !== undefined && !step.expectPath) out.warnings.push(`${where}: expectValue without expectPath checks nothing`);
    if (typeof step.body === 'string' && step.body.trim().startsWith('{')) {
      // a body with {{context}} or {{uuid}} is valid JSON once substituted: check the shape with placeholders filled
      try { JSON.parse(step.body.replace(/\{\{\s*[\w.]+\s*\}\}/g, '0')); } catch (e) { out.warnings.push(`${where}: the request body does not look like JSON (${e.message.slice(0, 60)})`); }
    }
  }
  if (step.type === 'tap' && step.fallback && !(Array.isArray(step.fallback) && step.fallback.length === 2)) out.errors.push(`${where}: fallback is [x, y]`);
  if (step.type === 'assertScreen' && step.threshold != null && (step.threshold < 0 || step.threshold > 1)) out.errors.push(`${where}: threshold is a fraction from 0 to 1`);
}

// settings: { vars, templates, accounts }; library: shared blocks; lastRun: a finished run of this scenario
function lint(scenario, { settings = {}, library = {}, lastRun = null } = {}) {
  const out = { errors: [], warnings: [] };
  if (!scenario || typeof scenario !== 'object') return { errors: ['the scenario is empty'], warnings: [] };
  if (!scenario.name) out.warnings.push('the scenario has no name');
  const total = (scenario.setup || []).length + (scenario.steps || []).length + (scenario.teardown || []).length;
  if (!total) out.errors.push('the scenario has no steps');
  for (const [k, v] of Object.entries(scenario)) {
    if (['id', 'name', 'description', 'engine', 'tags', 'vars', 'order', 'appId', 'steps', 'setup', 'teardown', 'blocks', 'matrix', 'rules', 'measure', 'section', 'tab', 'variants', 'yamlText'].includes(k)) continue;
    out.warnings.push(`scenario field "${k}" does nothing`);
  }
  if (scenario.section !== undefined && typeof scenario.section !== 'string') out.errors.push('section must be a string: the section name in the performance history');
  if (scenario.tab !== undefined && typeof scenario.tab !== 'string') out.errors.push('tab must be a string: the name or id of a tab on the scenario list');
  if (scenario.variants !== undefined) {
    if (!scenario.variants || typeof scenario.variants !== 'object' || Array.isArray(scenario.variants)) out.errors.push('variants must be an object: variant name → { title, vars, setup, teardown }');
    else {
      for (const [name, v] of Object.entries(scenario.variants)) {
        if (!v || typeof v !== 'object' || Array.isArray(v)) { out.errors.push(`variant "${name}": an object { title, vars, setup, teardown } is needed`); continue; }
        for (const k of Object.keys(v)) if (!['title', 'vars', 'setup', 'teardown'].includes(k)) out.warnings.push(`variant "${name}": field "${k}" does nothing`);
        for (const k of ['setup', 'teardown']) if (v[k] !== undefined && !Array.isArray(v[k])) out.errors.push(`variant "${name}": ${k} must be a list of steps`);
      }
    }
  }
  if (scenario.engine && !['adb', 'maestro', 'web'].includes(scenario.engine)) out.errors.push(`unknown engine "${scenario.engine}" — adb, maestro or web`);
  const ms = scenario.measure;
  if (ms !== undefined && ms !== null && typeof ms !== 'boolean') {
    if (typeof ms !== 'object' || Array.isArray(ms)) out.errors.push('measure must be true or { iterations, flashlight }');
    else {
      for (const k of Object.keys(ms)) if (!['iterations', 'flashlight'].includes(k)) out.warnings.push(`measure: field "${k}" does nothing`);
      if (ms.iterations !== undefined && !(Number.isInteger(Number(ms.iterations)) && Number(ms.iterations) >= 1 && Number(ms.iterations) <= 20)) out.errors.push('measure.iterations must be an integer from 1 to 20');
    }
  }
  for (const [name, b] of Object.entries(scenario.blocks || {})) {
    if (!b || !Array.isArray(b.steps)) out.errors.push(`block "${name}": a steps list is needed`);
  }
  const compiled = compile(scenario, { library });
  out.errors.push(...compiled.errors);
  out.warnings.push(...compiled.warnings);
  // each variant's extra steps must compile too (blocks exist, nesting sane)
  for (const v of variantsOf(scenario)) {
    if (!v.name) continue;
    const c = compile(scenario, { library, variant: v });
    out.errors.push(...c.errors.filter((e) => !compiled.errors.includes(e)).map((e) => `variant "${v.name}": ${e}`));
  }
  const vVars = variantsOf(scenario).flatMap((v) => Object.keys(v.vars || {}));
  const accounts = settings.accounts ? new Set(Object.keys(settings.accounts)) : null;
  const ctx = { accounts, defaultRole: defaultRole(settings), condsSeen: new Set() };
  // variables known at each point: settings, templates, scenario, matrix, roles, then whatever `save` adds
  const known = new Set([...BUILTIN_VARS, ...Object.keys(settings.vars || {}), ...Object.keys(settings.templates || {}), ...Object.keys(scenario.vars || {}), ...vVars]);
  for (const row of compiled.rows) Object.keys(row).forEach((k) => known.add(k));
  for (const role of accounts || []) ['phone', 'token', 'otp', 'tokenExp'].forEach((f) => known.add(`${role}.${f}`));
  const blockParamNames = new Set(Object.values(compiled.blocks).flatMap((b) => (Array.isArray(b.params) ? b.params : Object.keys(b.params || {}))));
  const walk = (list, prefix) => list.forEach((step, i) => {
    const where = `${prefix}${step._phase && step._phase !== 'main' ? step._phase + ' ' : ''}step ${i + 1}${step._from ? ` (block ${step._from})` : ''}`;
    checkStep(step, where, out, ctx);
    const used = varsIn(Object.fromEntries(Object.entries(step).filter(([k]) => !['save', 'steps', 'then', 'else', '_cond'].includes(k))));
    for (const v of used) {
      if (known.has(v)) continue;
      if (blockParamNames.has(v)) out.errors.push(`${where}: block parameter "${v}" is not passed via with and is not a variable`);
      else out.warnings.push(`${where}: variable "${v}" is not defined anywhere (settings, scenario vars, save or matrix)`);
    }
    if (step.type === 'api' && step.save) Object.keys(step.save).forEach((k) => known.add(k));
    if (step.type === 'api' && lastRun) checkAgainstRun(step, where, out, lastRun);
    if (step.type === 'repeat') walk(step.steps || [], `${where} → `);
  });
  walk(compiled.steps, '');
  if (scenario.matrix && !compiled.rows.length) out.warnings.push('matrix is set but produced no rows');
  return { ...out, steps: compiled.steps.length, rows: compiled.rows.length };
}

// the last run's recorded responses: a field that was not there then is probably misspelt now
function checkAgainstRun(step, where, out, lastRun) {
  // the same request may be recorded several times (an empty cart, then a full one): a field counts as
  // seen when any of those responses had it
  const key = `${step.method || 'GET'} ${step.url || ''}`.split('?')[0].slice(0, 40);
  const bodies = (lastRun.steps || []).filter((r) => r.type === 'api' && r.status === 'passed' && r.response && String(r.title || '').includes(key))
    .map((r) => { try { return JSON.parse(r.response); } catch { return null; } }).filter(Boolean);
  if (!bodies.length) return;
  const paths = [...(step.expectPath ? [step.expectPath] : []), ...Object.values(step.save || {})];
  for (const p of paths) {
    if (/\{\{/.test(p)) continue;
    if (!bodies.some((j) => pick(j, p) !== undefined)) out.warnings.push(`${where}: the last run's response had no field "${p}"`);
  }
}

// JSON Schema (draft-07) for editors; the step shape is the same table as above
function jsonSchema() {
  const stepProps = { ...COMMON };
  for (const f of Object.values(FIELDS)) for (const [k, s] of Object.entries(f)) { const { required, ...rest } = s; stepProps[k] = stepProps[k] || rest; }
  stepProps.type = { enum: Object.keys(FIELDS), description: 'step type (the short form is the key: `- tap: Catalog`)' };
  // shorthand: `- tap: Каталог`, `- input: …`, `- launch`, or a raw Maestro command
  const shorthand = {};
  for (const t of Object.keys(FIELDS)) shorthand[t === 'type' ? 'input' : t] = {};
  const step = { oneOf: [
    { type: 'string', description: 'a step without fields: launch, back' },
    { type: 'object', properties: stepProps, additionalProperties: true }
  ] };
  const block = { type: 'object', properties: { params: { oneOf: [arr, obj] }, steps }, required: ['steps'], additionalProperties: false };
  return {
    $schema: 'http://json-schema.org/draft-07/schema#',
    $id: 'https://e2e-console/scenario.schema.json',
    title: 'e2e-console scenario',
    type: 'object',
    properties: {
      name: str, id: str, description: str, engine: { enum: ['adb', 'maestro', 'web'], description: 'adb / maestro drive the phone, web drives a browser page (Playwright)' }, tags: { type: 'array', items: str },
      tab: { ...str, description: 'the tab on the scenario list this scenario belongs to (name or id)' },
      vars: obj, matrix: { oneOf: [{ type: 'object', additionalProperties: arr }, { type: 'array', items: obj }] },
      blocks: { type: 'object', additionalProperties: block },
      rules: { type: 'object', properties: { noServerErrors: bool, allowStatus: { type: 'array', items: num } }, additionalProperties: false },
      measure: { oneOf: [bool, { type: 'object', properties: { iterations: num, flashlight: bool }, additionalProperties: false }], description: 'performance measurement: frames, CPU, memory on every step; iterations — how many runs to queue' },
      section: { ...str, description: 'section in the performance history (Feed, Catalog, Purchase…)' },
      variants: { type: 'object', additionalProperties: { type: 'object', properties: { title: str, vars: obj, setup: steps, teardown: steps }, additionalProperties: false }, description: 'variants of one scenario for app modes: one run per variant, its setup before the scenario, teardown after' },
      setup: steps, steps, teardown: steps
    },
    required: ['steps'],
    definitions: { step, steps, condition: cond, shorthand: { type: 'object', properties: shorthand } }
  };
}

module.exports = { lint, jsonSchema, FIELDS, COMMON, varsIn };
