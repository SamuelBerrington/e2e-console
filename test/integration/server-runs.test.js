'use strict';
const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { startServer, writeRun, readJsonFile, PNG } = require('./helpers');

const DAY = 864e5;
const ago = (days) => new Date(Date.now() - days * DAY).toISOString();
const stamp = (days) => ago(days).replace(/[-:T]/g, '').slice(0, 14);

const steps = (n, shots = true) => Array.from({ length: n }, (_, i) => ({ n: i + 1, type: 'tap', status: 'passed', ...(shots ? { screenshot: `step-${i + 1}.png` } : {}) }));
const pngs = (n) => Array.from({ length: n }, (_, i) => `step-${i + 1}.png`);

// three runs of scenario-a (100, 50 and 1 day old), two of scenario-b (a measured one 80 days old, a plain one 70 days old)
const SEED = [
  { id: `${stamp(100)}-scenario-a`, scenarioId: 'scenario-a', startedAt: ago(100) },
  { id: `${stamp(50)}-scenario-a`, scenarioId: 'scenario-a', startedAt: ago(50) },
  { id: `${stamp(1)}-scenario-a`, scenarioId: 'scenario-a', startedAt: ago(1) },
  { id: `${stamp(80)}-scenario-b`, scenarioId: 'scenario-b', startedAt: ago(80), measure: { iterations: 1, iteration: 1 } },
  { id: `${stamp(70)}-scenario-b`, scenarioId: 'scenario-b', startedAt: ago(70) }
];
const ID = Object.fromEntries(SEED.map((r) => [`${r.scenarioId.slice(-1)}${Math.round((Date.now() - Date.parse(r.startedAt)) / DAY)}`, r.id]));

function seed(data) {
  const runs = path.join(data, 'runs');
  fs.rmSync(runs, { recursive: true, force: true });
  fs.mkdirSync(runs);
  for (const r of SEED) writeRun(data, { ...r, steps: steps(2) }, { pngs: [...pngs(2), 'maestro/steps-1-2/debug/shot.png'] });
}
const exists = (srv, id) => fs.existsSync(srv.file('runs', id));
const pngCount = (srv, id) => {
  let n = 0;
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) e.isDirectory() ? walk(path.join(d, e.name)) : (/\.png$/.test(e.name) && n++); };
  walk(srv.file('runs', id));
  return n;
};

describe('starting a run without a device', () => {
  let srv;
  before(async () => {
    srv = await startServer();
    await srv.post('/api/scenarios', { name: 'Phone flow', steps: [{ type: 'launch' }, { type: 'tap', target: 'OK' }] });
    await srv.post('/api/scenarios', { name: 'Web flow', steps: [{ type: 'browser', steps: [{ type: 'launch', url: 'http://127.0.0.1:9/' }] }] });
    await srv.post('/api/scenarios', { name: 'Broken flow', steps: [{ type: 'teleport' }] });
  });
  after(async () => { if (srv) await srv.stop(); });

  it('lists no device and no browser when adb and the browser do not exist', async () => {
    const r = await srv.get('/api/device');
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.devices, []);
    assert.equal(r.json.browser.ok, false);
    assert.match(r.json.browser.error, /browser not found/);
  });

  it('reports a missing adb on the setup page instead of failing', async () => {
    const r = await srv.get('/api/setup');
    assert.equal(r.status, 200);
    assert.equal(r.json.adb.ok, false);
    assert.deepEqual(r.json.devices, []);
    assert.equal(r.json.scenarios, 3);
  });

  it('refuses a phone scenario with 409 "no emulator or phone connected" and creates no run', async () => {
    for (const q of ['', '?device=any', '?device=all', '?force=1', '?measure=1']) {
      const r = await srv.post('/api/scenarios/phone-flow/run' + q, {});
      assert.equal(r.status, 409, q);
      assert.equal(r.json.error, 'no emulator or phone connected', q);
    }
    assert.deepEqual(fs.readdirSync(srv.file('runs')), []);
    assert.deepEqual((await srv.get('/api/queue')).json, { active: [], queue: [] });
  });

  it('refuses a browser scenario with 409 naming the missing browser and creates no run', async () => {
    const r = await srv.post('/api/scenarios/web-flow/run', {});
    assert.equal(r.status, 409);
    assert.match(r.json.error, /the browser engine is not available: browser not found/);
    assert.deepEqual(fs.readdirSync(srv.file('runs')), []);
  });

  it('refuses a scenario that fails the check with 400 and its lint, before looking for a device', async () => {
    const r = await srv.post('/api/scenarios/broken-flow/run', {});
    assert.equal(r.status, 400);
    assert.match(r.json.error, /fails the check/);
    assert.ok(r.json.lint.errors.length > 0);
    assert.deepEqual(fs.readdirSync(srv.file('runs')), []);
  });

  it('answers 404 for a run of a missing scenario', async () => {
    assert.equal((await srv.post('/api/scenarios/no-such/run', {})).status, 404);
  });

  it('answers an adb error (not a hang) for device commands that need adb', async () => {
    const r = await srv.get('/api/device/foreground');
    assert.ok(r.status >= 400, String(r.status));
    assert.match(r.json.error, /adb/);
  });
});

describe('runs list, read and delete', () => {
  let srv;
  before(async () => { srv = await startServer({ prepare: seed }); });
  after(async () => { if (srv) await srv.stop(); });

  it('lists the runs newest first with step counts and a thumbnail, without the steps', async () => {
    const r = await srv.get('/api/runs');
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.map((x) => x.id), [ID.a1, ID.a50, ID.b70, ID.b80, ID.a100]);
    const first = r.json[0];
    assert.equal(first.total, 2);
    assert.equal(first.passedSteps, 2);
    assert.equal(first.failedStep, null);
    assert.equal(first.thumb, 'step-2.png');
    assert.equal('steps' in first, false);
  });

  it('skips a folder whose run.json is missing or damaged', async () => {
    fs.mkdirSync(srv.file('runs', 'empty-folder'));
    fs.mkdirSync(srv.file('runs', 'bad-json'));
    fs.writeFileSync(srv.file('runs', 'bad-json', 'run.json'), '{oops');
    const r = await srv.get('/api/runs');
    assert.equal(r.status, 200);
    assert.equal(r.json.length, 5);
    fs.rmSync(srv.file('runs', 'empty-folder'), { recursive: true });
    fs.rmSync(srv.file('runs', 'bad-json'), { recursive: true });
  });

  it('reads one run with its steps, and 404 for a missing one', async () => {
    const r = await srv.get('/api/runs/' + ID.a50);
    assert.equal(r.status, 200);
    assert.equal(r.json.steps.length, 2);
    assert.equal((await srv.get('/api/runs/20200101000000-nope')).status, 404);
  });

  it('serves a step screenshot as PNG', async () => {
    const r = await srv.get(`/runs/${ID.a50}/step-1.png`);
    assert.equal(r.status, 200);
    assert.equal(r.headers['content-type'], 'image/png');
    assert.ok(r.buf.equals(PNG));
  });

  it('deletes a finished run folder', async () => {
    const r = await srv.del('/api/runs/' + ID.a100);
    assert.equal(r.status, 200);
    assert.equal(exists(srv, ID.a100), false);
    assert.equal((await srv.get('/api/runs')).json.length, 4);
  });

  it('answers 400 for a run id that is not safe', async () => {
    assert.equal((await srv.del('/api/runs/..%2F..%2Fsettings.json')).status, 400);
    assert.ok(fs.existsSync(srv.file('settings.json')));
  });
});

describe('runs prune', () => {
  let srv;
  before(async () => { srv = await startServer(); });
  beforeEach(() => seed(srv.data));
  after(async () => { if (srv) await srv.stop(); });

  it('refuses a call without keep or olderThanDays, and an unknown "what", with 400', async () => {
    for (const body of [{}, { keep: -1 }, { keep: 1.5 }, { olderThanDays: 0 }, { keep: '2' }, { keep: 1, what: 'everything' }]) {
      const r = await srv.post('/api/runs/prune', body);
      assert.equal(r.status, 400, JSON.stringify(body));
      assert.ok(r.json.error, JSON.stringify(body));
    }
    for (const r of SEED) assert.ok(exists(srv, r.id));
  });

  it('dryRun reports what would go and deletes nothing', async () => {
    const r = await srv.post('/api/runs/prune', { keep: 1, dryRun: true });
    assert.equal(r.status, 200);
    assert.equal(r.json.dryRun, true);
    assert.equal(r.json.runs, 2);
    assert.equal(r.json.screenshots, 1, 'the measured run of scenario-b would lose only its pictures');
    for (const x of SEED) { assert.ok(exists(srv, x.id)); assert.equal(pngCount(srv, x.id), 3); }
    assert.ok(r.json.bytes > 0);
    const shots = await srv.post('/api/runs/prune', { olderThanDays: 60, what: 'screenshots', dryRun: true });
    assert.equal(shots.json.screenshots, 3);
    for (const x of SEED) assert.equal(pngCount(srv, x.id), 3);
  });

  it('keep: N leaves the newest N runs of every scenario', async () => {
    const r = await srv.post('/api/runs/prune', { keep: 1 });
    assert.equal(r.json.runs, 2);
    assert.ok(exists(srv, ID.a1));
    assert.ok(!exists(srv, ID.a50));
    assert.ok(!exists(srv, ID.a100));
    assert.ok(exists(srv, ID.b70));
  });

  it('a measured run loses only its pictures, never the run', async () => {
    const r = await srv.post('/api/runs/prune', { keep: 0 });
    assert.equal(r.json.runs, 4);
    assert.equal(r.json.screenshots, 1);
    assert.ok(exists(srv, ID.b80));
    assert.equal(pngCount(srv, ID.b80), 0);
    const run = readJsonFile(srv.file('runs', ID.b80, 'run.json'));
    assert.ok(run.screenshotsDropped);
    assert.ok(run.steps.every((s) => !('screenshot' in s)));
    assert.deepEqual((await srv.get('/api/runs')).json.map((x) => x.id), [ID.b80]);
  });

  it('olderThanDays deletes only runs older than that', async () => {
    const r = await srv.post('/api/runs/prune', { olderThanDays: 60 });
    assert.equal(r.json.runs, 2);
    assert.ok(!exists(srv, ID.a100));
    assert.ok(!exists(srv, ID.b70));
    assert.ok(exists(srv, ID.b80), 'measured');
    assert.ok(exists(srv, ID.a50));
    assert.ok(exists(srv, ID.a1));
  });

  it('keep and olderThanDays together delete a run only when it is past both', async () => {
    const r = await srv.post('/api/runs/prune', { keep: 1, olderThanDays: 60 });
    assert.equal(r.json.runs, 1);
    assert.ok(!exists(srv, ID.a100));
    assert.ok(exists(srv, ID.a50), 'second newest of scenario-a but younger than 60 days');
    assert.ok(exists(srv, ID.b70), 'the newest of scenario-b');
  });

  it('what: screenshots drops the pictures and keeps the runs, their statuses and steps', async () => {
    const r = await srv.post('/api/runs/prune', { olderThanDays: 60, what: 'screenshots' });
    assert.equal(r.json.runs, 0);
    assert.equal(r.json.screenshots, 3);
    for (const id of [ID.a100, ID.b70, ID.b80]) {
      assert.ok(exists(srv, id));
      assert.equal(pngCount(srv, id), 0);
      const run = readJsonFile(srv.file('runs', id, 'run.json'));
      assert.equal(run.status, 'passed');
      assert.equal(run.steps.length, 2);
      assert.ok(run.screenshotsDropped);
    }
    assert.equal(pngCount(srv, ID.a50), 3);
    const listed = (await srv.get('/api/runs')).json.find((x) => x.id === ID.a100);
    assert.equal(listed.thumb, null);
    const again = await srv.post('/api/runs/prune', { olderThanDays: 60, what: 'screenshots' });
    assert.equal(again.json.screenshots, 0, 'a run whose pictures are gone is not counted twice');
  });

  it('scenarioId limits the clean-up to one scenario', async () => {
    const r = await srv.post('/api/runs/prune', { keep: 0, scenarioId: 'scenario-a' });
    assert.equal(r.json.runs, 3);
    assert.ok(exists(srv, ID.b70));
  });

  it('never touches a run that is still marked running or queued', async () => {
    const live = `${stamp(200)}-scenario-a-live`;
    const wait = `${stamp(201)}-scenario-a-wait`;
    writeRun(srv.data, { id: live, scenarioId: 'scenario-a', startedAt: ago(200), status: 'running', steps: steps(1) }, { pngs: pngs(1) });
    writeRun(srv.data, { id: wait, scenarioId: 'scenario-a', startedAt: ago(201), status: 'queued', steps: [] });
    await srv.post('/api/runs/prune', { keep: 0 });
    await srv.post('/api/runs/prune', { keep: 0, what: 'screenshots' });
    assert.ok(exists(srv, live));
    assert.equal(pngCount(srv, live), 1);
    assert.ok(exists(srv, wait));
  });
});

describe('runs left unfinished by a previous console', () => {
  let srv;
  const RUNNING = '20260101100000-left-running';
  const QUEUED = '20260101100001-left-queued';
  const PAUSED = '20260101100002-left-paused';
  const DONE = '20260101100003-finished';
  const LOGS = '20260101100004-logs-live';
  before(async () => {
    srv = await startServer({
      prepare: (data) => {
        writeRun(data, { id: RUNNING, status: 'running', finishedAt: undefined, steps: [{ n: 1, status: 'passed' }, { n: 2, status: 'running' }, { n: 3, status: 'pending' }] });
        writeRun(data, { id: QUEUED, status: 'queued', finishedAt: undefined, steps: [] });
        writeRun(data, { id: PAUSED, status: 'paused', finishedAt: undefined, pending: { n: 2 }, steps: [{ n: 1, status: 'passed' }] });
        writeRun(data, { id: DONE, status: 'failed', finishedAt: '2026-01-01T10:05:00.000Z', error: 'own error', steps: [{ n: 1, status: 'failed' }] });
        writeRun(data, { id: LOGS, status: 'passed', logs: { status: 'live', total: 3 }, steps: [] });
      }
    });
  });
  after(async () => { if (srv) await srv.stop(); });

  it('marks a running run stopped with finishedAt, a reason, and its unfinished steps skipped', () => {
    const r = readJsonFile(srv.file('runs', RUNNING, 'run.json'));
    assert.equal(r.status, 'stopped');
    assert.ok(!Number.isNaN(Date.parse(r.finishedAt)));
    assert.match(r.error, /restarted during this run/);
    assert.deepEqual(r.steps.map((s) => s.status), ['passed', 'skipped', 'skipped']);
    assert.equal(r.pending, null);
  });

  it('marks a queued run stopped with its own reason', () => {
    const r = readJsonFile(srv.file('runs', QUEUED, 'run.json'));
    assert.equal(r.status, 'stopped');
    assert.ok(r.finishedAt);
    assert.match(r.error, /waited in the queue/);
  });

  it('marks a paused run stopped', () => {
    const r = readJsonFile(srv.file('runs', PAUSED, 'run.json'));
    assert.equal(r.status, 'stopped');
    assert.equal(r.pending, null);
  });

  it('leaves a finished run as it was', () => {
    const r = readJsonFile(srv.file('runs', DONE, 'run.json'));
    assert.equal(r.status, 'failed');
    assert.equal(r.error, 'own error');
    assert.equal(r.finishedAt, '2026-01-01T10:05:00.000Z');
  });

  it('marks a log collection that was live as an error to refresh', () => {
    const r = readJsonFile(srv.file('runs', LOGS, 'run.json'));
    assert.equal(r.status, 'passed');
    assert.equal(r.logs.status, 'error');
    assert.equal(r.logs.total, 3);
    assert.match(r.logs.error, /Refresh logs/);
  });

  it('serves the stopped runs through the API', async () => {
    const list = (await srv.get('/api/runs')).json;
    assert.equal(list.find((x) => x.id === RUNNING).status, 'stopped');
    assert.equal(list.find((x) => x.id === QUEUED).status, 'stopped');
  });

  it('answers 409 when asked to stop or resume a run that is not live', async () => {
    assert.equal((await srv.post(`/api/runs/${RUNNING}/stop`, {})).status, 409);
    assert.equal((await srv.post(`/api/runs/${RUNNING}/resume`, {})).status, 409);
  });
});

describe('performance history', () => {
  let srv;
  const FORMULA = require('../../lib/perf').SCORE_FORMULA;
  const measured = (id, scenarioId, days, score, p95, extra = {}) => ({
    id, scenarioId, scenarioName: scenarioId, startedAt: ago(days), status: 'passed', measure: { iterations: 3 }, steps: [],
    perf: { score, formula: FORMULA, startMs: 1000 + score, frames: { count: 120, jank: score / 1000, app: { p95 } }, device: { model: 'Testphone X1', versionName: '1.0.0', versionCode: 7 } },
    ...extra
  });
  before(async () => {
    srv = await startServer({
      prepare: (data) => {
        writeRun(data, measured('20260101000001-scroll', 'scroll', 5, 60, 20));
        writeRun(data, measured('20260101000002-scroll', 'scroll', 4, 90, 12));
        writeRun(data, measured('20260101000003-scroll', 'scroll', 3, 70, 16));
        writeRun(data, measured('20260101000004-open', 'open', 2, 40, 25));
        // not counted: a failed run and one without a score
        writeRun(data, measured('20260101000005-scroll', 'scroll', 1, 10, 30, { status: 'failed' }));
        writeRun(data, { id: '20260101000006-scroll', scenarioId: 'scroll', status: 'passed', startedAt: ago(1), steps: [] });
        fs.mkdirSync(path.join(data, 'scenarios'), { recursive: true });
        fs.writeFileSync(path.join(data, 'scenarios', 'scroll.json'), JSON.stringify({ id: 'scroll', name: 'Scroll feed', section: 'Feed', steps: [{ type: 'launch' }] }));
      }
    });
  });
  after(async () => { if (srv) await srv.stop(); });

  it('returns medians with their min–max range per scenario, section and build', async () => {
    const r = await srv.get('/api/perf/summary');
    assert.equal(r.status, 200);
    assert.equal(r.json.formula, FORMULA);
    assert.equal(r.json.devices.length, 1);
    const dev = r.json.devices[0];
    assert.equal(dev.name, 'Testphone X1');
    assert.equal(dev.builds.length, 1);
    const build = dev.builds[0];
    assert.equal(build.runs, 4);
    assert.deepEqual(r.json.sections, ['Feed', 'Other']);
    const feed = build.sections.find((s) => s.name === 'Feed');
    const scroll = feed.items[0];
    assert.equal(scroll.name, 'Scroll feed');
    assert.equal(scroll.runs, 3);
    assert.equal(scroll.score, 70);
    assert.deepEqual(scroll.range.score, [60, 90]);
    assert.equal(scroll.p95, 16);
    assert.deepEqual(scroll.range.p95, [12, 20]);
    assert.equal(scroll.startMs, 1070);
    assert.deepEqual(scroll.range.startMs, [1060, 1090]);
    assert.equal(scroll.lastRunId, '20260101000003-scroll');
    assert.deepEqual(feed.range, [60, 90]);
    const other = build.sections.find((s) => s.name === 'Other');
    assert.equal(other.items[0].score, 40);
    assert.deepEqual(other.items[0].range.score, [40, 40]);
    assert.equal(build.total, 110);
    assert.equal(build.max, 200);
    assert.deepEqual(build.range, [100, 130]);
  });

  it('returns an empty history when no run is measured', async () => {
    const empty = await startServer();
    try {
      const r = await empty.get('/api/perf/summary');
      assert.equal(r.status, 200);
      assert.deepEqual(r.json.devices, []);
      assert.deepEqual(r.json.sections, []);
    } finally { await empty.stop(); }
  });
});
