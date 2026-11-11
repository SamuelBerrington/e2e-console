'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { writeJson, writeAtomic, readJson, readJsonStrict } = require('../../lib/jsonfile');

let dir;
test.beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-unit-json-')); });
test.afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

test('writeJson writes the value intact and leaves no temp file behind', () => {
  const file = path.join(dir, 'settings.json');
  const value = { a: 1, nested: { list: [1, 'two', null], text: 'кириллица ✓' } };
  writeJson(file, value);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), value);
  assert.deepEqual(fs.readdirSync(dir), ['settings.json']);
});

test('writeJson replaces an existing file completely', () => {
  const file = path.join(dir, 'x.json');
  writeJson(file, { long: 'x'.repeat(5000) });
  writeJson(file, { short: true });
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { short: true });
  assert.deepEqual(fs.readdirSync(dir), ['x.json']);
});

test('writeAtomic removes its temp file when the rename fails', () => {
  // the target is a non-empty directory: rename cannot replace it on any platform
  const target = path.join(dir, 'busy');
  fs.mkdirSync(target);
  fs.writeFileSync(path.join(target, 'keep'), '1');
  assert.throws(() => writeAtomic(target, 'text'));
  assert.deepEqual(fs.readdirSync(dir), ['busy']);
});

test('readJsonStrict returns the fallback for a missing file', () => {
  const fallback = { empty: true };
  assert.equal(readJsonStrict(path.join(dir, 'nope.json'), fallback), fallback);
});

test('readJsonStrict throws on a damaged file instead of returning {}', () => {
  const file = path.join(dir, 'settings.json');
  fs.writeFileSync(file, '{"accounts": {"buyer": ');
  assert.throws(() => readJsonStrict(file, {}), (e) => {
    assert.equal(e.code, 'E2E_DAMAGED_JSON');
    assert.equal(e.status, 500);
    assert.match(e.message, /settings\.json is damaged/);
    return true;
  });
  // the damaged file is left as it was
  assert.equal(fs.readFileSync(file, 'utf8'), '{"accounts": {"buyer": ');
});

test('readJsonStrict throws on an empty file', () => {
  const file = path.join(dir, 'empty.json');
  fs.writeFileSync(file, '');
  assert.throws(() => readJsonStrict(file, {}), { code: 'E2E_DAMAGED_JSON' });
});

test('readJsonStrict rethrows read errors other than a missing file', () => {
  // reading a directory fails with EISDIR (or EPERM on some platforms), not ENOENT
  assert.throws(() => readJsonStrict(dir, {}), (e) => e.code !== 'E2E_DAMAGED_JSON' && e.code !== 'ENOENT');
});

test('readJsonStrict reads a valid file', () => {
  const file = path.join(dir, 'ok.json');
  writeJson(file, [1, 2, 3]);
  assert.deepEqual(readJsonStrict(file, null), [1, 2, 3]);
});

test('readJson is lenient: missing or damaged → fallback, valid → value', () => {
  const bad = path.join(dir, 'bad.json');
  fs.writeFileSync(bad, 'not json');
  assert.equal(readJson(path.join(dir, 'missing.json'), 'fb'), 'fb');
  assert.equal(readJson(bad, 'fb'), 'fb');
  writeJson(bad, { ok: 1 });
  assert.deepEqual(readJson(bad, 'fb'), { ok: 1 });
});
