#!/usr/bin/env node
'use strict';
// Runs the test files with Node's built-in runner: `node test/run.js [unit|integration]`.
// The files are listed explicitly because `node --test <dir>` and glob arguments behave differently in Node 20 and 22+.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const which = process.argv[2];
if (which && !['unit', 'integration'].includes(which)) {
  console.error('usage: node test/run.js [unit|integration]');
  process.exit(2);
}
const files = [];
const walk = (dir) => {
  if (!fs.existsSync(dir)) return;
  for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name.endsWith('.test.js')) files.push(p);
  }
};
for (const part of which ? [which] : ['unit', 'integration']) walk(path.join(__dirname, part));
if (!files.length) {
  console.error('no test files found');
  process.exit(1);
}

// The readable report goes to the terminal; a TAP copy goes to a file so the failed tests can be listed at the end
// (and shown as annotations on a GitHub Actions run, where the full log is not always at hand).
const tap = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-test-')), 'report.tap');
const r = spawnSync(process.execPath, [
  '--test',
  '--test-reporter=spec', '--test-reporter-destination=stdout',
  '--test-reporter=tap', `--test-reporter-destination=${tap}`,
  ...files
], { stdio: 'inherit', cwd: path.join(__dirname, '..') });

function failures(text) {
  const out = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const m = /^(\s*)not ok \d+ - (.*)$/.exec(lines[i]);
    if (!m) continue;
    const f = { name: m[2], error: '', location: '', type: '' };
    for (let k = i + 1; k < lines.length && !/^\s*\.\.\.\s*$/.test(lines[k]); k++) {
      const kv = /^\s*(error|location|failureType):\s*(.*)$/.exec(lines[k]);
      if (!kv) continue;
      let v = kv[2];
      // a multi-line value: `error: |-` followed by more indented lines
      if (/^[|>]/.test(v)) {
        const block = [];
        for (let q = k + 1; q < lines.length && /^\s{4,}\S/.test(lines[q]) && !/^\s*(code|name|stack|expected|actual|operator):/.test(lines[q]); q++) block.push(lines[q].trim());
        v = block.join(' ');
      }
      v = v.replace(/^'(.*)'$/, '$1');
      if (kv[1] === 'error') f.error = v; else if (kv[1] === 'location') f.location = v; else f.type = v;
    }
    // a file or a suite that failed only because a test inside it failed says nothing new
    if (f.type !== 'subtestsFailed') out.push(f);
  }
  return out;
}

let failed = [];
try { failed = failures(fs.readFileSync(tap, 'utf8')); } catch { /* no report: the runner itself did not start */ }
try { fs.rmSync(path.dirname(tap), { recursive: true, force: true }); } catch { /* best effort */ }
if (failed.length) {
  console.log(`\nFailed tests (${failed.length}):`);
  for (const f of failed) console.log(`  ✖ ${f.name}\n      ${f.error.slice(0, 300)}${f.location ? `\n      ${f.location}` : ''}`);
  if (process.env.GITHUB_ACTIONS) {
    const esc = (s) => String(s).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
    for (const f of failed.slice(0, 10)) console.log(`::error title=${esc(f.name.slice(0, 120)).replace(/,/g, '%2C').replace(/:/g, '%3A')}::${esc((f.error || 'failed').slice(0, 600))}`);
  }
}
process.exit(r.status === null ? 1 : r.status);
