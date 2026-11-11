'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { summarize, buildOf, deviceOf, runScore } = require('../../lib/perfSummary');
const { SCORE_FORMULA, score } = require('../../lib/perf');

let seq = 0;
// a passed, measured run; startedAt sorts in creation order
function run({ scenarioId = 's1', variant, score: sc = 80, formula = SCORE_FORMULA, frames, device = {}, build = 'app-debug.apk', status = 'passed', p95 = 5, jank = 0.01, startMs } = {}) {
  seq++;
  return {
    id: `run-${seq}`, status, scenarioId, scenarioName: scenarioId, variant, build,
    startedAt: `2026-01-01T00:00:${String(seq).padStart(2, '0')}Z`,
    perf: { score: sc, formula, startMs, frames: frames || { count: 100, jank, app: { p95 } }, device: { emulator: true, versionName: '1.0', versionCode: 1, ...device } }
  };
}

test('buildOf keys a build by versionName|versionCode|md5 when the digest is recorded', () => {
  const b = buildOf({ build: 'app-debug.apk', perf: { device: { versionName: '1.2', versionCode: 34, apkMd5: 'abcdefabcdef' } } });
  assert.equal(b.key, '1.2|34|md5:abcdefabcdef');
  assert.equal(b.apk, 'app-debug');
  assert.equal(b.versionCode, '34');
});

test('buildOf falls back to the APK file name for old runs without a digest', () => {
  assert.equal(buildOf({ build: 'app-debug.apk', perf: { device: { versionName: '1.2', versionCode: 34 } } }).key, '1.2|34|apk:app-debug');
  assert.equal(buildOf({ perf: {} }).key, '||apk:—');
  assert.equal(buildOf({ build: 'x.apk', perf: { device: { versionCode: 0 } } }).versionCode, '0');
});

test('deviceOf groups every emulator together and phones by model', () => {
  assert.equal(deviceOf({ perf: { device: { emulator: true, model: 'sdk' } } }).key, 'emulator');
  assert.deepEqual(deviceOf({ perf: { device: { model: 'Fake Phone', soc: 'SM0000' } } }), { key: 'Fake Phone', name: 'Fake Phone', emulator: false, chip: 'SM0000' });
  assert.equal(deviceOf({ device: 'serial-1', perf: {} }).key, 'serial-1');
});

test('summarize: median score, min-max range and run counts per scenario', () => {
  const runs = [run({ score: 70 }), run({ score: 90 }), run({ score: 80 }), run({ score: 100, status: 'failed' })];
  const s = summarize(runs, [{ id: 's1', name: 'Scenario one', section: 'Feed' }]);
  const b = s.devices[0].builds[0];
  const item = b.sections[0].items[0];
  assert.equal(item.score, 80);
  assert.deepEqual(item.range.score, [70, 90]);
  assert.equal(item.runs, 3);
  assert.equal(item.name, 'Scenario one');
  assert.equal(b.sections[0].name, 'Feed');
  assert.equal(b.minRuns, 3);
  assert.equal(b.runs, 3);
  assert.equal(s.formula, SCORE_FORMULA);
});

test('summarize: an even number of runs takes the mean of the middle two', () => {
  const s = summarize([run({ score: 60, p95: 4 }), run({ score: 70, p95: 6 })], []);
  const item = s.devices[0].builds[0].sections[0].items[0];
  assert.equal(item.score, 65);
  assert.equal(item.p95, 5);
  assert.deepEqual(item.range.p95, [4, 6]);
});

test('summarize: sections average their scenarios, the total sums the sections out of sections × 100', () => {
  const scenarios = [{ id: 'a', section: 'Feed' }, { id: 'b', section: 'Feed' }, { id: 'c', section: 'Cart' }];
  const runs = [run({ scenarioId: 'a', score: 60 }), run({ scenarioId: 'a', score: 80 }), run({ scenarioId: 'b', score: 90 }), run({ scenarioId: 'c', score: 50 })];
  const b = summarize(runs, scenarios).devices[0].builds[0];
  assert.deepEqual(b.sections.map((x) => [x.name, x.score, x.range, x.minRuns]), [['Cart', 50, [50, 50], 1], ['Feed', 80, [75, 85], 1]]);
  assert.equal(b.total, 130);
  assert.equal(b.max, 200);
  assert.deepEqual(b.range, [125, 135]);
  assert.equal(b.minRuns, 1);
  assert.equal(b.runs, 4);
});

test('summarize: variants are separate items; a missing section is Other', () => {
  const b = summarize([run({ variant: 'lite' }), run({ variant: 'full' }), run({ scenarioId: 'unknown' })], []).devices[0].builds[0];
  assert.deepEqual(b.sections.map((x) => x.name), ['Other']);
  assert.equal(b.sections[0].items.length, 3);
});

test('summarize: builds with the same APK name but different versionCode or digest stay apart', () => {
  const runs = [run({ device: { versionCode: 1 } }), run({ device: { versionCode: 2 } }), run({ device: { versionCode: 2, apkMd5: 'aaaaaaaaaaaa' } }), run({ device: { versionCode: 2, apkMd5: 'bbbbbbbbbbbb' } })];
  const keys = summarize(runs, []).devices[0].builds.map((b) => b.key).sort();
  assert.deepEqual(keys, ['1.0|1|apk:app-debug', '1.0|2|apk:app-debug', '1.0|2|md5:aaaaaaaaaaaa', '1.0|2|md5:bbbbbbbbbbbb']);
});

test('summarize: phones come before the emulator', () => {
  const s = summarize([run({}), run({ device: { emulator: false, model: 'Fake Phone' } })], []);
  assert.deepEqual(s.devices.map((d) => d.key), ['Fake Phone', 'emulator']);
});

test('runs without the formula stamp are rescored from their frames', () => {
  const frames = { count: 100, jank: 0, app: { p95: 8 } };
  const old = run({ score: 12, frames });
  delete old.perf.formula;
  assert.equal(runScore(old), score(frames));
  assert.equal(runScore(old), 100);
  const current = run({ score: 12, frames });
  assert.equal(runScore(current), 12);
  // too few frames to rescore: the stored score stays
  assert.equal(runScore(run({ score: 33, formula: 'old', frames: { count: 3, jank: 0, app: { p95: 1 } } })), 33);
  const item = summarize([old, run({ score: 50 })], []).devices[0].builds[0].sections[0].items[0];
  assert.equal(item.rescored, 1);
  assert.equal(item.score, 75);
});

test('summarize skips failed runs and runs without a score or frames', () => {
  const noScore = run({});
  noScore.perf.score = null;
  const noFrames = run({});
  delete noFrames.perf.frames;
  assert.deepEqual(summarize([run({ status: 'failed' }), noScore, noFrames, { status: 'passed' }], []).devices, []);
});
