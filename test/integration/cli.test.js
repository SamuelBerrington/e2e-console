'use strict';
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const YAML = require('yaml');
const { startServer, runCli, freePort } = require('./helpers');

const FIXTURES = path.join(__dirname, '..', 'fixtures', 'integration');

describe('CLI against a console', () => {
  let srv;
  const cli = (args, o) => runCli(args, { base: srv.base, ...o });
  before(async () => {
    srv = await startServer();
    await srv.post('/api/scenarios', { name: 'Cli good', engine: 'adb', steps: [{ type: 'launch' }, { type: 'tap', target: 'OK' }] });
    await srv.post('/api/scenarios', { name: 'Cli other', steps: [{ type: 'launch' }] });
  });
  after(async () => { if (srv) await srv.stop(); });

  it('list prints every scenario id with its step count', async () => {
    const r = await cli(['list']);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /^cli-good\s+2 steps\s+adb\s+Cli good$/m);
    assert.match(r.stdout, /^cli-other\s+1 steps/m);
  });

  it('lint all exits 0 when every scenario is clean', async () => {
    const r = await cli(['lint', 'all']);
    assert.equal(r.code, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /^cli-good: ok/m);
  });

  it('lint exits 1 and prints the errors when a scenario has errors', async () => {
    await srv.post('/api/scenarios', { name: 'Cli bad', steps: [{ type: 'if', if: { visibel: 'x' }, then: [{ type: 'back' }] }] });
    try {
      const all = await cli(['lint', 'all']);
      assert.equal(all.code, 1);
      assert.match(all.stdout, /^cli-bad: errors \d+/m);
      assert.match(all.stdout, /unknown condition field "visibel"/);
      const one = await cli(['lint', 'cli-good']);
      assert.equal(one.code, 0);
    } finally {
      await srv.del('/api/scenarios/cli-bad');
    }
  });

  it('lint of a missing scenario exits 2 with the server\'s error', async () => {
    const r = await cli(['lint', 'no-such']);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /no such scenario/);
  });

  it('export prints the keyless bundle to stdout', async () => {
    const r = await cli(['export']);
    assert.equal(r.code, 0, r.stderr);
    const doc = YAML.parse(r.stdout);
    assert.equal(doc.kind, 'e2e-console/bundle');
    assert.deepEqual(doc.scenarios.map((s) => s.id).sort(), ['cli-good', 'cli-other']);
    assert.equal(doc.secrets, undefined);
  });

  it('export of one scenario writes a file with --out', async () => {
    const out = path.join(srv.root, 'cli-out');
    const r = await cli(['export', 'cli-good', '--format', 'json', '--out', out]);
    assert.equal(r.code, 0, r.stderr);
    const file = path.join(out, 'cli-good.json');
    assert.equal(r.stdout.trim(), file);
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).id, 'cli-good');
  });

  it('import --dry previews a file and changes nothing', async () => {
    const r = await cli(['import', path.join(FIXTURES, 'bundle.yaml'), '--dry']);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /scenario "Fixture checkout": 3 steps/);
    assert.match(r.stdout, /block "fixture-close": new/);
    assert.deepEqual((await srv.get('/api/scenarios')).json.map((s) => s.id).sort(), ['cli-good', 'cli-other']);
    assert.equal(fs.existsSync(srv.file('blocks', 'library.yaml')), false);
  });

  it('import adds the scenarios and blocks of a file', async () => {
    const r = await cli(['import', path.join(FIXTURES, 'bundle.yaml')]);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /added: fixture-checkout/);
    assert.match(r.stdout, /blocks written: fixture-close/);
    assert.equal((await srv.get('/api/scenarios/fixture-checkout')).status, 200);
  });

  it('import of a folder with nothing importable exits 2', async () => {
    const empty = path.join(srv.root, 'empty-import');
    fs.mkdirSync(empty, { recursive: true });
    fs.writeFileSync(path.join(empty, 'notes.txt'), 'nothing');
    const r = await cli(['import', empty]);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /no \.yaml/);
  });

  it('run without scenario ids exits 2 instead of looking like a pass', async () => {
    const r = await cli(['run']);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /name at least one scenario id/);
  });

  it('run --force <id> keeps the id: the server is asked and refuses for lack of a device', async () => {
    for (const args of [['run', '--force', 'cli-good'], ['run', '--measure', '--no-flashlight', 'cli-good'], ['run', 'cli-good', '--force']]) {
      const r = await cli(args);
      assert.equal(r.code, 2, args.join(' '));
      assert.doesNotMatch(r.stderr, /name at least one scenario id/, args.join(' '));
      assert.match(r.stderr, /no emulator or phone connected/, args.join(' '));
    }
    assert.deepEqual(fs.readdirSync(srv.file('runs')), []);
  });

  it('a value flag without a value is an error, also when the next word is a flag', async () => {
    for (const args of [['run', 'cli-good', '--engine'], ['run', '--device', '--force', 'cli-good'], ['export', 'all', '--out']]) {
      const r = await cli(args);
      assert.equal(r.code, 2, args.join(' '));
      assert.match(r.stderr, /--(engine|device|out) needs a value/, args.join(' '));
    }
    assert.deepEqual(fs.readdirSync(srv.file('runs')), []);
  });

  it('prints the usage for an unknown command', async () => {
    const r = await cli(['help']);
    assert.equal(r.code, 0);
    assert.match(r.stdout, /node tools\/e2e\.js list/);
  });
});

describe('CLI without a console', () => {
  it('exits 2 with "cannot reach the console" when nothing listens', async () => {
    const port = await freePort();
    const r = await runCli(['list'], { base: `http://127.0.0.1:${port}` });
    assert.equal(r.code, 2);
    assert.match(r.stderr, new RegExp(`cannot reach the console at http://127\\.0\\.0\\.1:${port}`));
    assert.match(r.stderr, /ECONNREFUSED/);
  });
});
