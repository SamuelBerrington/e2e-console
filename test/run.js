#!/usr/bin/env node
'use strict';
// Runs the test files with Node's built-in runner: `node test/run.js [unit|integration]`.
// The files are listed explicitly because `node --test <dir>` and glob arguments behave differently in Node 20 and 22+.
const fs = require('node:fs');
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
const r = spawnSync(process.execPath, ['--test', ...files], { stdio: 'inherit', cwd: path.join(__dirname, '..') });
process.exit(r.status === null ? 1 : r.status);
