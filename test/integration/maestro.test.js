'use strict';
// lib/maestro.js against a fake Maestro CLI: a small Node script behind maestro.bat (Windows) or a shell
// script (macOS, Linux) that records its argv, working folder and environment, and writes the report
// Maestro would write. Nothing here needs Java, Maestro, adb or a device.
const { describe, it, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const maestro = require('../../lib/maestro');
const { tempRoot, removeDir } = require('./helpers');

const WIN = process.platform === 'win32';

// The fake CLI. `mode.txt` next to it picks the outcome: pass, fail-last (the last command fails) or crash.
const FAKE = `'use strict';
const fs = require('fs');
const path = require('path');
const here = __dirname;
const args = process.argv.slice(2);
if (args.includes('--version')) { console.log('WARNING: a JVM notice 2.0.1'); console.log('1.41.0'); process.exit(0); }
const pathKey = Object.keys(process.env).find((k) => k.toUpperCase() === 'PATH');
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => /^MAESTRO_/i.test(k) || k === 'JAVA_HOME'));
fs.writeFileSync(path.join(here, 'dump.json'), JSON.stringify({ argv: args, cwd: process.cwd(), env, path: process.env[pathKey] }));
const mode = fs.existsSync(path.join(here, 'mode.txt')) ? fs.readFileSync(path.join(here, 'mode.txt'), 'utf8').trim() : 'pass';
if (mode === 'crash') { console.log('Something went wrong'); console.log('Device emulator-0000 not found'); process.exit(3); }
const flow = fs.readFileSync(path.join(process.cwd(), 'flow.yaml'), 'utf8').split('\\n---\\n')[1] || '';
const n = flow.split('\\n').filter((l) => /^- /.test(l)).length;
const report = Array.from({ length: n }, (_, i) => {
  const failed = mode === 'fail-last' && i === n - 1;
  return { command: { someCommand: {} }, metadata: { depth: 0, status: failed ? 'FAILED' : 'COMPLETED', timestamp: Date.now(), duration: 10, ...(failed ? { error: { message: 'Element not found: Pay' } } : {}) } };
});
fs.mkdirSync(path.join(process.cwd(), 'debug'), { recursive: true });
fs.writeFileSync(path.join(process.cwd(), 'debug', 'commands.json'), JSON.stringify(report));
console.log('fake maestro ran ' + n + ' commands');
process.exit(mode === 'fail-last' ? 1 : 0);
`;

function makeFake(root) {
  const bin = path.join(root, 'fake maestro', 'bin');
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, 'fake-maestro.js'), FAKE);
  let exe;
  if (WIN) {
    exe = path.join(bin, 'maestro.bat');
    fs.writeFileSync(exe, `@"${process.execPath}" "%~dp0fake-maestro.js" %*\r\n`);
  } else {
    exe = path.join(bin, 'maestro');
    fs.writeFileSync(exe, `#!/bin/sh\nexec "${process.execPath}" "$(dirname "$0")/fake-maestro.js" "$@"\n`);
    fs.chmodSync(exe, 0o755);
  }
  // a JDK folder is recognised by bin/java alone; it is never run
  const jdk = path.join(root, 'fake-jdk');
  fs.mkdirSync(path.join(jdk, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(jdk, 'bin', WIN ? 'java.exe' : 'java'), '');
  return { exe, bin, jdk };
}

describe('Maestro through a fake CLI', () => {
  let root;
  let fake;
  let settings;
  const dump = () => JSON.parse(fs.readFileSync(path.join(fake.bin, 'dump.json'), 'utf8'));
  const setMode = (m) => fs.writeFileSync(path.join(fake.bin, 'mode.txt'), m);
  before(() => {
    root = tempRoot('e2e-it-maestro-');
    fake = makeFake(root);
    settings = { maestro: { path: fake.exe, javaHome: fake.jdk }, adbPath: path.join(root, 'no-such-sdk', WIN ? 'adb.exe' : 'adb'), package: 'org.example.app' };
  });
  beforeEach(() => {
    for (const f of ['dump.json', 'mode.txt']) fs.rmSync(path.join(fake.bin, f), { force: true });
    // a leftover from a parent console must not reach the flow
    process.env.MAESTRO_E2E_V9 = 'leftover-from-parent';
  });
  afterEach(() => { delete process.env.MAESTRO_E2E_V9; });
  after(() => { if (root) removeDir(root); });

  it('resolves the configured CLI and Java home', () => {
    assert.deepEqual(maestro.resolve(settings), { bin: fake.exe, javaHome: fake.jdk });
  });

  it('reads the version from the line that is only a version', async () => {
    assert.equal(await maestro.version(settings), '1.41.0');
  });

  it('runs the flow with the device serial on the command line and the variables in the environment, intact', async () => {
    const NASTY = 'a&b|c%PATH%^d"e<f>g';
    const CANARY = 'x&echo INJECTED>pwned.txt&rem ';
    const r = await maestro.runGroups({
      settings, serial: 'emulator-0000', dir: path.join(root, 'run-1'), name: 'probe',
      groups: [{ key: 's1', commands: [{ inputText: '${NASTY}' }] }, { key: 's2', commands: ['back', { pressKey: 'Enter' }] }],
      env: { NASTY, CANARY, EMPTY: '', TOKEN_LIKE: 'tok-dummy-secret', nested: { a: 1 }, 'bad name': 'x' }
    });
    const d = dump();
    assert.deepEqual(d.argv, ['--device', 'emulator-0000', 'test', 'flow.yaml', '--debug-output', 'debug', '--flatten-debug-output', '--no-ansi']);
    assert.equal(fs.realpathSync(d.cwd), fs.realpathSync(path.join(root, 'run-1', 'maestro', 'probe')));
    const values = Object.entries(d.env).filter(([k]) => /^MAESTRO_E2E_V/i.test(k)).map(([, v]) => v).sort();
    assert.deepEqual(values, [CANARY, NASTY, 'tok-dummy-secret'].sort(), 'only the run variables, each intact, and no leftover');
    assert.equal(d.env.JAVA_HOME, fake.jdk);
    assert.equal(d.env.MAESTRO_CLI_NO_ANALYTICS, '1');
    assert.ok(d.path.startsWith(path.join(fake.jdk, 'bin') + path.delimiter), 'Java home first on PATH');
    assert.match(r.out, /fake maestro ran 3 commands/);
    assert.equal(r.code, 0);
    assert.deepEqual(r.results.map((x) => [x.key, x.status]), [['s1', 'passed'], ['s2', 'passed']]);
    assert.equal(r.results[1].ms, 20);
  });

  it('writes a flow whose header maps the variables to environment names and carries no values', async () => {
    const r = await maestro.runGroups({
      settings, serial: 'emulator-0000', dir: path.join(root, 'run-2'), name: 'probe',
      groups: [{ key: 's1', commands: [{ inputText: '${TOKEN_LIKE}' }] }],
      env: { TOKEN_LIKE: 'tok-dummy-secret', EMPTY: '' }
    });
    const flow = fs.readFileSync(r.flowFile, 'utf8');
    assert.ok(!flow.includes('tok-dummy-secret'));
    assert.match(flow, /appId: org\.example\.app/);
    assert.match(flow, /TOKEN_LIKE: \$\{MAESTRO_E2E_V0\}/);
    assert.match(flow, /EMPTY: ""/);
    assert.equal(fs.readFileSync(path.join(root, 'run-2', 'maestro', 'probe', 'maestro.out.txt'), 'utf8'), r.out);
  });

  it('runs no host command hidden in a variable value', async () => {
    await maestro.runGroups({ settings, serial: 'emulator-0000', dir: path.join(root, 'run-3'), name: 'probe', groups: [{ key: 's1', commands: ['back'] }], env: { CANARY: 'x&echo INJECTED>pwned.txt&rem ', OTHER: '$(echo INJECTED>pwned.txt)' } });
    const found = [];
    const walk = (dir) => { for (const e of fs.readdirSync(dir, { withFileTypes: true })) { const p = path.join(dir, e.name); if (e.isDirectory()) walk(p); else if (e.name === 'pwned.txt') found.push(p); } };
    walk(root);
    assert.deepEqual(found, []);
  });

  it('maps a failed command back to its step with Maestro\'s message', async () => {
    setMode('fail-last');
    const r = await maestro.runGroups({
      settings, serial: 'emulator-0000', dir: path.join(root, 'run-4'), name: 'probe',
      groups: [{ key: 's1', commands: ['back'] }, { key: 's2', commands: [{ tapOn: 'Pay' }] }]
    });
    assert.deepEqual(r.results.map((x) => x.status), ['passed', 'failed']);
    assert.equal(r.results[1].error, 'Element not found: Pay');
  });

  it('reports a CLI that dies before writing its report on the first step', async () => {
    setMode('crash');
    const r = await maestro.runGroups({
      settings, serial: 'emulator-0000', dir: path.join(root, 'run-5'), name: 'probe',
      groups: [{ key: 's1', commands: ['back'] }, { key: 's2', commands: ['back'] }]
    });
    assert.equal(r.code, 3);
    assert.equal(r.results[0].status, 'failed');
    assert.match(r.results[0].error, /^Maestro did not start: [\s\S]*Device emulator-0000 not found/);
    assert.equal(r.results[1].status, 'skipped');
  });

  it('refuses a serial that cmd.exe would expand, before starting anything', { skip: !WIN && 'cmd.exe quoting applies on Windows only' }, async () => {
    await assert.rejects(
      maestro.runGroups({ settings, serial: 'emu%PATH%', dir: path.join(root, 'run-6'), name: 'probe', groups: [{ key: 's1', commands: ['back'] }] }),
      /cannot pass "emu%PATH%" to Maestro safely/
    );
    assert.equal(fs.existsSync(path.join(fake.bin, 'dump.json')), false);
  });

  it('says Maestro was not found when the configured path does not exist', async () => {
    const missing = { ...settings, maestro: { path: path.join(root, 'nowhere', 'maestro'), javaHome: fake.jdk } };
    // a Maestro installed under ~/.maestro or on PATH would be found instead: hide both for this check
    const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, PATH: process.env.PATH };
    const empty = path.join(root, 'empty-home');
    fs.mkdirSync(empty, { recursive: true });
    try {
      process.env.HOME = empty;
      process.env.USERPROFILE = empty;
      process.env.PATH = empty;
      assert.equal(maestro.resolve(missing).bin, '');
      await assert.rejects(maestro.version(missing), /Maestro not found/);
    } finally {
      for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    }
  });
});
