'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const perf = require('../../lib/perf');

const { score, verdict, frameStats, calibrationCheck, forecast, MIN_FRAMES, CAL_MAX_DAYS } = perf;
const st = (count, jank, p95) => ({ count, jank, app: { p95 } });

test('score is 100 for no jank and a cheap p95, 0 for heavy jank and an expensive p95', () => {
  assert.equal(score(st(100, 0, 8)), 100);
  assert.equal(score(st(100, 0, 1)), 100);
  assert.equal(score(st(100, 0.3, 33)), 0);
  assert.equal(score(st(100, 0.9, 200)), 0);
});

test('score weighs jank share and p95 cost half and half', () => {
  assert.equal(score(st(100, 0.15, 8)), 75);
  assert.equal(score(st(100, 0, 20.5)), 75);
  assert.equal(score(st(100, 0.15, 20.5)), 50);
});

test('fewer frames than MIN_FRAMES give no score', () => {
  assert.equal(MIN_FRAMES, 20);
  assert.equal(score(st(19, 0, 5)), null);
  assert.equal(score(st(20, 0, 5)), 100);
  assert.equal(score({ count: 0 }), null);
  assert.equal(score(null), null);
});

test('verdict thresholds: 85 smooth, 60 fine, below laggy', () => {
  assert.deepEqual([verdict(85), verdict(84), verdict(60), verdict(59), verdict(null)], ['smooth', 'fine', 'fine', 'laggy', null]);
});

test('frameStats counts jank against 16.7 ms and the display interval', () => {
  const frames = [...Array(10)].map((_, i) => ({ app: i < 8 ? 5 : 20, total: 10, interval: 8.3, missed: i === 0 }));
  const s = frameStats(frames);
  assert.equal(s.count, 10);
  assert.equal(s.jank, 0.2);
  assert.equal(s.jankHz, 0.2);
  assert.equal(s.missed, 0.1);
  assert.equal(s.app.p50, 5);
  assert.equal(s.app.max, 20);
  assert.deepEqual(frameStats([]), { count: 0 });
});

test('score of frameStats over synthetic frames lands where expected', () => {
  const smooth = [...Array(40)].map(() => ({ app: 4, total: 16 }));
  assert.equal(score(frameStats(smooth)), 100);
  const laggy = [...Array(40)].map(() => ({ app: 40, total: 50 }));
  assert.equal(score(frameStats(laggy)), 0);
});

test('parseFramestats derives app cost and drops first-of-surface frames', () => {
  const head = 'Flags,FrameInterval,IntendedVsync,HandleInputStart,SyncQueued,SyncStart,SwapBuffers,FrameCompleted,DequeueBufferDuration,InputEventId';
  const ms = 1e6;
  const row = (flags, v) => [flags, 16.6 * ms, v, v + 1 * ms, v + 4 * ms, v + 5 * ms, v + 9 * ms, v + 12 * ms, 1 * ms, 0].join(',');
  const text = ['Window: com.example.fake/Main', '---PROFILEDATA---', head, row(0, 1e9), row(1, 2e9), '---PROFILEDATA---'].join('\n');
  const frames = perf.parseFramestats(text);
  assert.equal(frames.length, 1);
  assert.equal(frames[0].ui, 3);
  assert.equal(frames[0].render, 3);
  assert.equal(frames[0].app, 6);
  assert.equal(frames[0].total, 12);
  assert.equal(frames[0].win, 'com.example.fake/Main');
});

// ---------- calibration ----------
const NOW = Date.parse('2026-06-15T12:00:00Z');
const daysAgo = (d) => new Date(NOW - d * 864e5).toISOString();
const EMU = { model: 'sdk_gphone64_x86_64', sdk: 35, abi: 'x86_64', avd: 'Fake_AVD', buildFingerprint: 'fake/fingerprint/1' };
const BUILD = { versionName: '1.0', versionCode: 7, apkMd5: 'aaaaaaaaaaaa' };
const goodCal = () => ({
  k: { app: 0.5, steps: 3 },
  reference: {
    name: 'Fake Phone', chip: 'Fake Chip', score: 1000, at: daysAgo(1), scenarioId: 'cal-scenario',
    phone: { model: 'FakePhone', ...BUILD }, emulator: { ...EMU, ...BUILD, p95: 20 }
  }
});
const emuRun = (p95 = 20, extra = {}) => ({ scenarioId: 'cal-scenario', perf: { frames: { count: 100, jank: 0.05, app: { p95 } }, device: { emulator: true, ...EMU, ...BUILD } }, ...extra });

test('calibrationCheck trusts a fresh calibration of the same image and build', () => {
  const r = calibrationCheck(goodCal(), emuRun(), NOW);
  assert.deepEqual(r.reasons, []);
  assert.equal(r.ok, true);
  assert.equal(r.ageDays, 1);
  assert.equal(r.maxDays, CAL_MAX_DAYS);
});

test('calibrationCheck: a bare K has no-reference and unknown-age', () => {
  const r = calibrationCheck({ k: { app: 0.5 } }, emuRun(), NOW);
  assert.equal(r.ok, false);
  assert.deepEqual(r.reasons, ['no-reference', 'unknown-age']);
});

test('calibrationCheck: a reference without a date is unknown-age', () => {
  const cal = goodCal();
  delete cal.reference.at;
  assert.deepEqual(calibrationCheck(cal, emuRun(), NOW).reasons, ['unknown-age']);
});

test('calibrationCheck: a calibration older than the limit is stale', () => {
  const cal = goodCal();
  cal.reference.at = daysAgo(CAL_MAX_DAYS + 1);
  assert.deepEqual(calibrationCheck(cal, emuRun(), NOW).reasons, ['stale']);
  cal.reference.at = daysAgo(CAL_MAX_DAYS);
  assert.deepEqual(calibrationCheck(cal, emuRun(), NOW).reasons, []);
});

test('calibrationCheck: an old calibration without origin is no-origin, plus build-mismatch when its versions differ', () => {
  const old = { k: { app: 0.5 }, reference: { name: 'P', score: 1000, at: daysAgo(1), phoneVersion: '1.0', emuVersion: '1.0' } };
  assert.deepEqual(calibrationCheck(old, emuRun(), NOW).reasons, ['no-origin']);
  old.reference.emuVersion = '1.1';
  assert.deepEqual(calibrationCheck(old, emuRun(), NOW).reasons, ['no-origin', 'build-mismatch']);
});

test('calibrationCheck: a run on another emulator image is other-image', () => {
  for (const change of [{ sdk: 34 }, { abi: 'arm64-v8a' }, { avd: 'Other_AVD' }, { buildFingerprint: 'other/fp' }, { model: 'other' }]) {
    const run = emuRun();
    Object.assign(run.perf.device, change);
    assert.deepEqual(calibrationCheck(goodCal(), run, NOW).reasons, ['other-image'], JSON.stringify(change));
  }
  // an AVD name recorded on one side only does not count against it
  const run = emuRun();
  delete run.perf.device.avd;
  assert.deepEqual(calibrationCheck(goodCal(), run, NOW).reasons, []);
});

test('calibrationCheck: different builds or variants at calibration are build-mismatch', () => {
  const variants = [
    (c) => { c.reference.phone.versionCode = 8; },
    (c) => { c.reference.phone.versionName = '1.1'; },
    (c) => { c.reference.phone.apkMd5 = 'bbbbbbbbbbbb'; },
    (c) => { delete c.reference.phone; },
    (c) => { c.reference.variant = 'lite'; }
  ];
  for (const change of variants) {
    const cal = goodCal();
    change(cal);
    assert.ok(calibrationCheck(cal, emuRun(), NOW).reasons.includes('build-mismatch'), change.toString());
  }
  // a digest on one side only is not a mismatch
  const cal = goodCal();
  delete cal.reference.phone.apkMd5;
  assert.deepEqual(calibrationCheck(cal, emuRun(), NOW).reasons, []);
});

test('calibrationCheck: K outside 0.1..3 is k-implausible', () => {
  for (const k of [0.05, 3.5]) {
    const cal = goodCal();
    cal.k.app = k;
    assert.deepEqual(calibrationCheck(cal, emuRun(), NOW).reasons, ['k-implausible'], String(k));
  }
});

test('calibrationCheck: the calibration scenario costing 2x more or less on the emulator is emu-drift', () => {
  assert.deepEqual(calibrationCheck(goodCal(), emuRun(41), NOW).reasons, ['emu-drift']);
  assert.deepEqual(calibrationCheck(goodCal(), emuRun(9), NOW).reasons, ['emu-drift']);
  assert.deepEqual(calibrationCheck(goodCal(), emuRun(39), NOW).reasons, []);
  // another scenario is not compared with the calibration's
  assert.deepEqual(calibrationCheck(goodCal(), emuRun(80, { scenarioId: 'other' }), NOW).reasons, []);
});

test('forecast gives phone numbers only for a trusted calibration', () => {
  const summary = emuRun(20).perf;
  const examples = [{ name: 'Fast', score: 2000 }, { name: 'Slow', score: 500 }];
  const f = forecast(summary, goodCal(), examples, emuRun(20), NOW);
  assert.equal(f.trust.ok, true);
  // p95 20 ms × K 0.5 = 10 ms on the reference (score 1000): fine; × 1000/2000 = 5 ms smooth; × 2 = 20 ms laggy
  assert.deepEqual(f.reference, { name: 'Fake Phone', chip: 'Fake Chip', score: 1000, ms: 10, verdict: 'fine' });
  assert.deepEqual(f.phones.map((p) => [p.name, p.ms, p.verdict]), [['Slow', 20, 'laggy'], ['Fast', 5, 'smooth']]);
  assert.equal(f.needOk, Math.round(1000 * 10 / 12));
  assert.equal(f.needSmooth, Math.round(1000 * 10 / 7));
});

test('forecast returns no phone numbers when the calibration is unfit', () => {
  const stale = goodCal();
  stale.reference.at = daysAgo(60);
  for (const cal of [stale, { k: { app: 0.5 } }]) {
    const f = forecast(emuRun(20).perf, cal, [{ name: 'X', score: 900 }], emuRun(20), NOW);
    assert.equal(f.trust.ok, false);
    assert.equal(f.phones, undefined);
    assert.equal(f.needOk, undefined);
    assert.equal(f.needSmooth, undefined);
    assert.ok(!f.reference || f.reference.ms === undefined);
  }
});

test('forecast is null without enough frames or without K', () => {
  assert.equal(forecast({ frames: { count: 5, app: { p95: 10 } } }, goodCal(), [], null, NOW), null);
  assert.equal(forecast(emuRun().perf, {}, [], null, NOW), null);
  assert.equal(forecast(null, goodCal(), [], null, NOW), null);
});

test('calibrate takes the median p95 ratio over steps both runs measured', () => {
  const step = (n, p95, p50 = p95) => ({ n, perf: { frames: { count: 50, app: { p95, p50 } } } });
  const phone = { steps: [step(1, 5), step(2, 10), step(3, 6), step(4, 1)] };
  const emu = { steps: [step(1, 10), step(2, 10), step(3, 30)] };
  const k = perf.calibrate(phone, emu);
  assert.equal(k.steps, 3);
  assert.equal(k.app, 0.5);
});

test('normalizeMeasure clamps iterations and lets the override win', () => {
  assert.equal(perf.normalizeMeasure(null, null), null);
  assert.deepEqual(perf.normalizeMeasure(true, null), { iterations: 1, flashlight: true, iteration: 1 });
  assert.deepEqual(perf.normalizeMeasure({ iterations: 50, flashlight: false }, { iteration: 3 }), { iterations: 20, flashlight: false, iteration: 3 });
  assert.deepEqual(perf.normalizeMeasure({ iterations: 2 }, { iterations: 5, flashlight: false }), { iterations: 5, flashlight: false, iteration: 1 });
});

test('parseAmStart and parseProc read their outputs', () => {
  assert.deepEqual(perf.parseAmStart('Status: ok\nLaunchState: COLD\nTotalTime: 812\n'), { totalMs: 812, state: 'COLD' });
  assert.equal(perf.parseAmStart('Error'), null);
  const stat = (tid, name, ut, st) => `${tid} (${name}) S ${Array(10).fill(0).join(' ')} ${ut} ${st} 0 0`;
  const p = perf.parseProc(['100 250 0', '---', stat(42, 'main', 10, 5), stat(43, 'RenderThread', 3, 1)].join('\n'), 42);
  assert.deepEqual(p.threads, { 'UI Thread': 15, RenderThread: 4 });
  assert.equal(p.rssPages, 250);
  assert.equal(perf.parseProc('', 1), null);
});
