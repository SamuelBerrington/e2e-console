'use strict';
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { startServer, runServerToExit, readJsonFile, hermeticEnv } = require('./helpers');

// a pid that belonged to a process which has exited
function deadPid() {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, ['-e', ''], { stdio: 'ignore', windowsHide: true });
    p.on('error', reject);
    p.on('exit', () => resolve(p.pid));
  });
}

describe('data-folder lock', () => {
  let first;
  before(async () => { first = await startServer(); });
  after(async () => { if (first) await first.stop(); });

  it('writes a lock with its pid and port', () => {
    const lock = readJsonFile(first.file('.console.lock'));
    assert.equal(lock.pid, first.proc.pid);
    assert.equal(lock.port, first.port);
  });

  it('refuses a second console on the same data folder with a non-zero exit and a message', async () => {
    const r = await runServerToExit({ data: first.data, env: first.env });
    assert.notEqual(r.code, 0);
    assert.match(r.stderr, /Another console \(pid \d+, port \d+\) already uses/);
    assert.ok(r.stderr.includes(String(first.proc.pid)));
  });

  it('keeps the first console working and its lock in place after the refusal', async () => {
    assert.ok(first.alive());
    const r = await first.post('/api/scenarios', { name: 'Still alive' });
    assert.equal(r.status, 201);
    assert.equal(readJsonFile(first.file('.console.lock')).pid, first.proc.pid);
  });

  it('does not mark the first console\'s live runs stopped when the second one is refused', async () => {
    // a run.json in "running" as the first console would have it; the refused second start must not touch it
    const dir = first.file('runs', '20260101000000-still-alive');
    fs.mkdirSync(dir, { recursive: true });
    const run = { id: '20260101000000-still-alive', scenarioId: 'still-alive', scenarioName: 'Still alive', status: 'running', startedAt: new Date().toISOString(), steps: [] };
    fs.writeFileSync(path.join(dir, 'run.json'), JSON.stringify(run));
    const r = await runServerToExit({ data: first.data, env: first.env });
    assert.notEqual(r.code, 0);
    assert.equal(readJsonFile(path.join(dir, 'run.json')).status, 'running');
  });

  it('does not let a refused second console rewrite settings.json', async () => {
    const before = fs.readFileSync(first.file('settings.json'), 'utf8');
    const withLegacy = JSON.stringify({ ...JSON.parse(before), apiToken: 'tok-dummy-legacy' }, null, 2);
    fs.writeFileSync(first.file('settings.json'), withLegacy);
    const r = await runServerToExit({ data: first.data, env: first.env });
    assert.notEqual(r.code, 0);
    assert.equal(fs.readFileSync(first.file('settings.json'), 'utf8'), withLegacy);
  });
});

describe('stale data-folder lock', () => {
  let srv;
  let stalePid;
  before(async () => {
    stalePid = await deadPid();
    srv = await startServer({
      prepare: (data) => fs.writeFileSync(path.join(data, '.console.lock'), JSON.stringify({ pid: stalePid, port: 1, startedAt: '2020-01-01T00:00:00.000Z' }))
    });
  });
  after(async () => { if (srv) await srv.stop(); });

  it('starts over a lock whose pid is dead and takes the lock over', async () => {
    assert.ok(srv.alive());
    assert.equal((await srv.get('/api/scenarios')).status, 200);
    const lock = readJsonFile(srv.file('.console.lock'));
    assert.equal(lock.pid, srv.proc.pid);
    assert.notEqual(lock.pid, stalePid);
  });
});

describe('a damaged lock file', () => {
  let srv;
  before(async () => {
    srv = await startServer({ prepare: (data) => fs.writeFileSync(path.join(data, '.console.lock'), '{ not json') });
  });
  after(async () => { if (srv) await srv.stop(); });

  it('does not block a start', async () => {
    assert.equal((await srv.get('/api/scenarios')).status, 200);
    assert.equal(readJsonFile(srv.file('.console.lock')).pid, srv.proc.pid);
  });
});

describe('a busy port', () => {
  it('makes the console exit with a message naming the port', async () => {
    const holder = await startServer();
    try {
      const other = path.join(holder.root, 'other-data');
      fs.mkdirSync(other);
      fs.writeFileSync(path.join(other, 'settings.json'), fs.readFileSync(holder.file('settings.json')));
      const r = await runServerToExit({ data: other, env: hermeticEnv(holder.root), port: holder.port });
      assert.notEqual(r.code, 0);
      assert.match(r.stderr, new RegExp(`Port ${holder.port} is busy`));
      assert.ok(holder.alive());
    } finally { await holder.stop(); }
  });
});
