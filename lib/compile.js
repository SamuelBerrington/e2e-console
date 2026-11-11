'use strict';
// Turns a scenario as written (blocks, setup/teardown, if/else, repeat, matrix) into the flat list of
// steps the runner executes. Nothing here touches a device: it is also what the linter, the Maestro
// export and the run page see.
//
//   blocks:                      reusable step lists; `use: open-order` inlines one, `with:` fills its params
//     open-order:
//       params: { number: '' }
//       steps: [ ... {{number}} ... ]
//   setup: [...]                 runs first; a failure here skips the main steps
//   steps: [...]                 the scenario
//   teardown: [...]              runs after the main steps whatever happened (not after «Остановить»)
//   matrix: { product: [a, b] }  one run per combination (or a list of rows), merged into the run's vars
//
//   - use: open-order            a block, with: { number: '{{orderNumber}}' }
//   - if: { visible: 'Отменить' }  then: [...] else: [...]   evaluated once when reached
//   - when: { visible: '...' }   on any step: run it only when the condition holds
//   - repeat: { until: {...} | times: N, max: 10, steps: [...] }
//
// Flat steps carry `_phase` (setup | main | teardown), `_from` (block path) and `_cond` ({ id, negate, when, parent }):
// members of one if/else share the id, so the runner checks the screen once for the whole group. A step
// inside several if/when (an if in an if, a block's own when under `use: … when`) keeps its innermost
// condition in `_cond` and each enclosing one in `.parent`; the runner requires all of them, outermost first.
//   - browser: [...]             the steps inside run in the browser (Playwright); `phone: [...]` on the phone;
//   - tap: { target: X, on: web }  one step elsewhere than the scenario's engine; the runner sees `_on`
const CONDITION_KEYS = ['visible', 'notVisible', 'var', 'equals', 'matches', 'platform', 'not', 'on', 'timeout'];
const SCREENS = { web: 'web', browser: 'web', phone: 'phone', mobile: 'phone', app: 'phone' };
const screenOf = (v) => (v == null || v === '' ? null : SCREENS[String(v).toLowerCase()] || null);

function substParams(value, params) {
  if (typeof value === 'string') return value.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (all, k) => (params[k] !== undefined ? String(params[k]) : all));
  if (Array.isArray(value)) return value.map((v) => substParams(v, params));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, substParams(v, params)]));
  return value;
}

// puts `outer` above the outermost condition of a step's chain; copies, so no chain is shared between steps
// an absent or empty `when` is no condition; anything else — also `false` or `0` — is one, and lint and the runner
// refuse what is not a proper condition instead of running the step unconditionally
const hasWhen = (w) => w !== undefined && w !== null && w !== '';
function wrapCond(c, outer) {
  return c ? { ...c, parent: wrapCond(c.parent, outer) } : outer;
}
// a step's conditions, outermost first
function condChain(step) {
  const out = [];
  for (let c = step && step._cond; c; c = c.parent) out.unshift(c);
  return out;
}

function blockParams(block) {
  // a list of names declares params without defaults: an unset one stays `{{name}}` and resolves at run time
  if (Array.isArray(block.params)) return Object.fromEntries(block.params.map((p) => [p, undefined]));
  return block.params && typeof block.params === 'object' ? { ...block.params } : {};
}

// steps as written → flat steps; `ctx.blocks` is scenario blocks over the shared library
function expand(steps, ctx, phase, from, depth = 0, on = null) {
  const out = [];
  for (const raw of steps || []) {
    if (!raw || typeof raw !== 'object') continue;
    const step = { ...raw };
    // where this step and whatever it contains run: its own `on`, else the enclosing group's
    if (step.on !== undefined && !screenOf(step.on)) ctx.warnings.push(`${from ? from + ' → ' : ''}unknown screen "${step.on}" — web or phone`);
    const here = screenOf(step.on) || on;
    delete step.on;
    if (step.type === 'browser' || step.type === 'phone') {
      const inner = expand(step.steps || [], ctx, phase, from, depth + 1, step.type === 'browser' ? 'web' : 'phone');
      if (hasWhen(step.when)) {
        const id = ctx.nextId++;
        for (const e of inner) e._cond = wrapCond(e._cond, { id, negate: false, when: step.when });
      }
      out.push(...inner);
      continue;
    }
    if (step.type === 'use') {
      const name = String(step.use || step.block || '');
      const block = ctx.blocks[name];
      if (!block) { ctx.errors.push(`${from ? from + ' → ' : ''}block "${name}" not found`); continue; }
      if (depth > 8) { ctx.errors.push(`block "${name}": nesting too deep (does it call itself?)`); continue; }
      const params = { ...blockParams(block), ...(step.with || {}) };
      for (const k of Object.keys(step.with || {})) if (!(k in blockParams(block)) && block.params) ctx.warnings.push(`block "${name}": parameter "${k}" is not declared in params`);
      const inner = substParams(block.steps || [], params);
      const path = from ? `${from} → ${name}` : name;
      const expanded = expand(inner, ctx, phase, path, depth + 1, here);
      if (hasWhen(step.when)) {
        const id = ctx.nextId++;
        for (const e of expanded) e._cond = wrapCond(e._cond, { id, negate: false, when: step.when });
      }
      out.push(...expanded);
      continue;
    }
    if (step.type === 'if') {
      const id = ctx.nextId++;
      const cond = step.if || step.condition;
      // `when` on the if itself sits above the if's own condition
      const own = hasWhen(step.when) ? { id: ctx.nextId++, negate: false, when: step.when } : null;
      const branch = (negate) => (e) => { e._cond = wrapCond(e._cond, { id, negate, when: cond, ...(own ? { parent: own } : {}) }); out.push(e); };
      expand(step.then || [], ctx, phase, from, depth + 1, here).forEach(branch(false));
      expand(step.else || [], ctx, phase, from, depth + 1, here).forEach(branch(true));
      continue;
    }
    if (step.type === 'repeat') {
      // the body's conditions are checked on every pass; `when` on the repeat itself gates the whole repeat
      const body = expand(step.steps || [], ctx, phase, from, depth + 1, here);
      const { when, ...rest } = step;
      out.push({ ...rest, steps: body, _phase: phase, ...(hasWhen(when) ? { _cond: { id: ctx.nextId++, negate: false, when } } : {}), ...(here ? { _on: here } : {}), ...(from ? { _from: from } : {}) });
      continue;
    }
    if (hasWhen(step.when)) {
      step._cond = { id: ctx.nextId++, negate: false, when: step.when };
      delete step.when;
    }
    step._phase = phase;
    if (from) step._from = from;
    if (here) step._on = here;
    out.push(step);
  }
  return out;
}

// matrix → rows of vars: an object of lists is the cartesian product, a list is used as is
function matrixRows(matrix) {
  if (!matrix) return [];
  if (Array.isArray(matrix)) return matrix.filter((r) => r && typeof r === 'object');
  const keys = Object.keys(matrix).filter((k) => Array.isArray(matrix[k]));
  if (!keys.length) return [];
  let rows = [{}];
  for (const k of keys) rows = rows.flatMap((r) => matrix[k].map((v) => ({ ...r, [k]: v })));
  return rows;
}

function rowLabel(row) {
  return Object.entries(row).map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : v}`).join(', ');
}

// variants: the same scenario under different app modes — `variants: { lite: { title, vars, setup, teardown } }`.
// A variant's setup runs before the scenario's own, its teardown after; its vars join the run's.
// One run per variant; a scenario without variants has one unnamed variant.
function variantsOf(scenario) {
  const v = scenario && scenario.variants;
  if (!v || typeof v !== 'object' || Array.isArray(v)) return [{ name: null }];
  const list = Object.entries(v).filter(([, d]) => d && typeof d === 'object').map(([name, d]) => ({ name, title: d.title || name, vars: d.vars || {}, setup: d.setup || [], teardown: d.teardown || [] }));
  return list.length ? list : [{ name: null }];
}

function compile(scenario, { library = {}, variant = null } = {}) {
  const ctx = { blocks: { ...library, ...(scenario.blocks || {}) }, errors: [], warnings: [], nextId: 1 };
  const v = variant && variant.name ? variant : null;
  // `engine: web` puts every screen step in the browser unless a step or group says `phone`
  const on = scenario.engine === 'web' ? 'web' : null;
  const steps = [
    ...expand([...(v ? v.setup : []), ...(scenario.setup || [])], ctx, 'setup', undefined, 0, on),
    ...expand(scenario.steps, ctx, 'main', undefined, 0, on),
    ...expand([...(scenario.teardown || []), ...(v ? v.teardown : [])], ctx, 'teardown', undefined, 0, on)
  ];
  return { steps, errors: ctx.errors, warnings: ctx.warnings, rows: matrixRows(scenario.matrix), blocks: ctx.blocks };
}

// The role an api step without `auth:` runs as: the account the app itself is signed in as (auth.appAccount)
// when it is described, else the first described account. 'buyer' is only the name of the old single
// account, used when nothing is described at all, so settings from before named accounts read the same.
function defaultRole(settings) {
  const s = settings || {};
  const names = Object.keys(s.accounts || {});
  const app = (s.auth || {}).appAccount;
  if (app && (!names.length || names.includes(app))) return app;
  return names[0] || app || 'buyer';
}

module.exports = { compile, matrixRows, rowLabel, substParams, variantsOf, condChain, CONDITION_KEYS, screenOf, defaultRole };
