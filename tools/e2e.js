#!/usr/bin/env node
'use strict';
// Command line for the running console: http://127.0.0.1:4777, or the address in E2E_CONSOLE (another port, another host):
//   node tools/e2e.js import <file|folder>... [--mode auto|native|maestro|env] [--replace] [--dry]
//   node tools/e2e.js export <scenario-id|all> [--format yaml|maestro|json] [--secrets] [--out <folder>]
//   node tools/e2e.js run <scenario-id>... [--engine adb|maestro|web] [--device <serial>|all] [--measure [--iterations N] [--no-flashlight]] [--variant <name>]   waits, exits 1 if a run failed
//   node tools/e2e.js lint <scenario-id|all>                            exits 1 on errors
//   node tools/e2e.js calibrate <phone-run-id> [--emu <run-id>] [--score N]   phone run → K and reference chip for forecasts
//   node tools/e2e.js list
const fs = require('node:fs');
const path = require('node:path');

const BASE = process.env.E2E_CONSOLE || 'http://127.0.0.1:4777';
const args = process.argv.slice(2);
// a boolean flag never takes a value (`run --force web-smoke-1` must not eat the scenario id); a value flag does
const BOOLEAN = new Set(['force', 'measure', 'no-flashlight', 'replace', 'dry', 'secrets']);
const VALUED = new Set(['engine', 'device', 'iterations', 'variant', 'mode', 'format', 'out', 'emu', 'score']);
const flag = (name) => {
  const i = args.indexOf('--' + name);
  if (i < 0) return undefined;
  if (BOOLEAN.has(name)) { args.splice(i, 1); return true; }
  const v = args[i + 1];
  if (VALUED.has(name) && (v === undefined || v.startsWith('--'))) throw new Error(`--${name} needs a value`);
  args.splice(i, 2);
  return v;
};

async function call(method, url, body, raw) {
  let res;
  try {
    res = await fetch(BASE + url, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  } catch (e) {
    // fetch says only "fetch failed"; the reason is in its cause (ECONNREFUSED when nothing listens)
    const c = e.cause;
    const why = (c && [c.code, c.message].filter(Boolean).join(': ')) || e.message;
    throw new Error(`cannot reach the console at ${BASE} (${why}) — is it running? Set E2E_CONSOLE for another address`);
  }
  if (raw) { if (!res.ok) throw new Error(`HTTP ${res.status}`); return { text: Buffer.from(await res.arrayBuffer()), name: decodeURIComponent((/filename\*=UTF-8''([^;]+)/.exec(res.headers.get('content-disposition') || '') || [])[1] || 'export.yaml') }; }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'HTTP ' + res.status);
  return data;
}

function collect(p) {
  const st = fs.statSync(p);
  if (st.isDirectory()) return fs.readdirSync(p).flatMap((f) => collect(path.join(p, f)));
  return /\.(ya?ml|json|env|js)$|(^|[\\/])\.env/i.test(p) ? [{ name: p, content: fs.readFileSync(p, 'utf8') }] : [];
}

async function main() {
  const cmd = args.shift();
  if (cmd === 'import') {
    const mode = flag('mode') || 'auto', replace = flag('replace'), dry = flag('dry');
    const files = args.flatMap(collect);
    if (!files.length) throw new Error('no .yaml/.yml/.json/.env files');
    // --replace also takes the imported version of a block that differs from yours; without it yours stays
    const r = await call('POST', '/api/import', { files, mode, apply: !dry, onConflict: replace ? 'replace' : 'copy', blockConflict: replace ? 'replace' : 'keep' });
    for (const f of r.files || []) console.log(`  ${f.name}: ${f.mode}`);
    if (dry) {
      for (const s of r.scenarios) console.log(`  scenario "${s.name}": ${s.steps.length} steps${s.conflict ? ` (already exists: ${s.conflict})` : ''}`);
      for (const b of r.blocks || []) console.log(`  block "${b.name}": ${b.status === 'new' ? 'new' : b.status === 'same' ? 'the same as yours' : `differs from yours (${b.file})${replace ? ' — will be replaced' : ' — yours stays; --replace takes it'}`}`);
      if (r.settings) console.log('  settings:', Object.keys(r.settings).join(', '));
    } else {
      for (const s of r.saved) console.log(`  ${s.replaced ? 'replaced' : 'added'}: ${s.id} — ${s.name} (${s.steps} steps)`);
      if ((r.blocksSaved || []).length) console.log('  blocks written:', r.blocksSaved.join(', '));
      if (r.settingsChanged.length) console.log('  settings updated:', r.settingsChanged.join(', '));
    }
    for (const w of r.warnings) console.log('  ! ' + w);
    return;
  }
  if (cmd === 'export') {
    const format = flag('format') || 'yaml', secrets = flag('secrets'), out = flag('out');
    const id = args[0] || 'all';
    const r = id === 'all'
      ? await call('GET', `/api/export${secrets ? '?secrets=1' : ''}`, null, true)
      : await call('GET', `/api/scenarios/${encodeURIComponent(id)}/export?format=${format}`, null, true);
    if (!out) { process.stdout.write(r.text); return; } // a zip goes to stdout as is too
    fs.mkdirSync(out, { recursive: true });
    fs.writeFileSync(path.join(out, r.name), r.text);
    console.log(path.join(out, r.name));
    return;
  }
  if (cmd === 'calibrate') {
    const emu = flag('emu'), score = flag('score');
    if (!args[0]) throw new Error('a measured phone run id is needed');
    const c = await call('POST', '/api/perf/calibrate', { phoneRun: args[0], emuRun: emu, score: score ? Number(score) : undefined });
    console.log(`K = ${c.k.app} (ui ${c.k.ui ?? '—'}, render ${c.k.render ?? '—'}, over ${c.k.steps} steps) · reference ${c.reference.name}: ${c.reference.chip || '?'}, ${c.reference.score} points · runs ${c.reference.runId} ↔ ${c.reference.emuRunId}`);
    if (c.check && !c.check.ok) console.log(`warning: this calibration gives no forecasts: ${c.check.reasons.join(', ')}`);
    return;
  }
  if (cmd === 'list') {
    for (const s of await call('GET', '/api/scenarios')) console.log(`${s.id.padEnd(36)} ${String((s.steps || []).length).padStart(3)} steps  ${s.engine || ''}  ${s.name}`);
    return;
  }
  if (cmd === 'lint') {
    const ids = args[0] && args[0] !== 'all' ? args : (await call('GET', '/api/scenarios')).map((s) => s.id);
    let errors = 0;
    for (const id of ids) {
      const r = await call('GET', `/api/scenarios/${encodeURIComponent(id)}/lint`);
      console.log(`${id}: ${r.errors.length ? 'errors ' + r.errors.length : 'ok'}${r.warnings.length ? ', warnings ' + r.warnings.length : ''} · ${r.steps} steps${r.rows ? ', matrix × ' + r.rows : ''}`);
      for (const e of r.errors) console.log('  ✕ ' + e);
      for (const w of r.warnings) console.log('  ! ' + w);
      errors += r.errors.length;
    }
    process.exitCode = errors ? 1 : 0;
    return;
  }
  if (cmd === 'run') {
    const engine = flag('engine'), device = flag('device'), force = flag('force'), measure = flag('measure'), iterations = flag('iterations'), noFlashlight = flag('no-flashlight'), variant = flag('variant');
    // nothing to run must not look like a pass in a CI script
    if (!args.length) throw new Error('run: name at least one scenario id (node tools/e2e.js list shows them)');
    const q = [engine && 'engine=' + engine, device && 'device=' + device, force && 'force=1', measure && 'measure=1', iterations && 'iterations=' + iterations, noFlashlight && 'flashlight=0', variant && 'variant=' + encodeURIComponent(variant)].filter(Boolean).join('&');
    let failed = 0;
    for (const id of args) {
      const started = await call('POST', `/api/scenarios/${encodeURIComponent(id)}/run${q ? '?' + q : ''}`);
      for (const r of started.runs || [started]) {
        process.stdout.write(`${r.scenarioName || id}: `);
        let x;
        for (;;) {
          await new Promise((res) => setTimeout(res, 2000));
          x = await call('GET', '/api/runs/' + r.id);
          if (!['running', 'paused', 'queued'].includes(x.status)) break;
        }
        const bad = x.steps.find((s) => s.status === 'failed');
        const warned = x.steps.filter((s) => s.status === 'warned').length;
        const p = x.perf;
        const perfLine = !p ? '' : p.error ? ` · measurement: ${p.error}`
          : ` · score ${p.score ?? '—'}${p.verdict ? ` (${p.verdict})` : ''}, p95 ${p.frames && p.frames.app ? p.frames.app.p95 : '—'} ms, jank ${p.frames && p.frames.jank != null ? Math.round(p.frames.jank * 100) : '—'}%${p.startMs ? `, start ${p.startMs} ms` : ''}${p.flashlight && p.flashlight.score != null ? `, Flashlight ${p.flashlight.score}` : ''}`;
        console.log(x.status === 'passed' ? `passed ${x.steps.length}/${x.steps.length}${warned ? ` (with warnings: ${warned})` : ''}`
          : `${x.status}${bad ? ` at step ${bad.n}: ${String(bad.error).split('\n')[0]}` : x.error ? ': ' + String(x.error).split('\n')[0] : ''}`, perfLine, `· ${BASE}/#/run/${r.id}`);
        if (x.status !== 'passed') failed++;
      }
    }
    process.exitCode = failed ? 1 : 0;
    return;
  }
  console.log(fs.readFileSync(__filename, 'utf8').split('\n').slice(2, 9).map((l) => l.replace(/^\/\/ ?/, '')).join('\n'));
}

main().catch((e) => { console.error(e.message); process.exitCode = 2; });
