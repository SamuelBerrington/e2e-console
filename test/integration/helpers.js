'use strict';
// Starts `node server.js` on a free port and a fresh temp data folder, and talks to it over plain HTTP.
// Every server is hermetic: settings.json points adb and the browser at paths that do not exist, and the
// Android SDK variables point at an empty temp folder, so a developer's phone or Chrome is never touched.
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const REPO = path.resolve(__dirname, '..', '..');
const SERVER = path.join(REPO, 'server.js');
const CLI = path.join(REPO, 'tools', 'e2e.js');
const EXE = process.platform === 'win32' ? '.exe' : '';

// 1x1 transparent PNG
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');

const live = new Set();
// a crashed test file must not leave a server behind
process.on('exit', () => { for (const p of live) { try { p.kill('SIGKILL'); } catch { /* gone */ } } });

function tempRoot(prefix = 'e2e-it-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function removeDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

// settings every test server starts with unless told otherwise
function hermeticSettings(root) {
  return {
    adbPath: path.join(root, 'no-such-sdk', 'adb' + EXE),
    emulatorPath: path.join(root, 'no-such-sdk', 'emulator' + EXE),
    web: { browserPath: path.join(root, 'no-such-browser', 'chrome' + EXE) }
  };
}

function hermeticEnv(root, extra = {}) {
  const sdk = path.join(root, 'empty-sdk');
  fs.mkdirSync(sdk, { recursive: true });
  const env = { ...process.env, ANDROID_HOME: sdk, ANDROID_SDK_ROOT: sdk, ...extra };
  delete env.E2E_DATA;
  delete env.PORT;
  delete env.E2E_CONSOLE;
  return env;
}

function request(port, method, url, { body, rawBody, headers = {}, timeoutMs = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    const h = { ...headers };
    let payload = null;
    if (body !== undefined) {
      payload = Buffer.from(JSON.stringify(body));
      if (!Object.keys(h).some((k) => k.toLowerCase() === 'content-type')) h['content-type'] = 'application/json';
    } else if (rawBody !== undefined) payload = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody));
    if (payload) h['content-length'] = payload.length;
    const req = http.request({ host: '127.0.0.1', port, method, path: url, headers: h, timeout: timeoutMs }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        const text = buf.toString('utf8');
        let json;
        try { json = JSON.parse(text); } catch { json = undefined; }
        resolve({ status: res.statusCode, headers: res.headers, text, json, buf });
      });
    });
    req.on('timeout', () => req.destroy(new Error(`${method} ${url}: no answer in ${timeoutMs} ms`)));
    req.on('error', reject);
    if (payload) req.end(payload); else req.end();
  });
}

async function waitFor(check, { timeoutMs = 15000, intervalMs = 50, what = 'condition' } = {}) {
  const until = Date.now() + timeoutMs;
  let last;
  for (;;) {
    try { const v = await check(); if (v) return v; } catch (e) { last = e; }
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}${last ? ': ' + last.message : ''}`);
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

function spawnServer({ port, data, env }) {
  const proc = spawn(process.execPath, [SERVER, '--port', String(port), '--data', data], { cwd: REPO, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  live.add(proc);
  const out = { stdout: '', stderr: '' };
  proc.stdout.on('data', (c) => { out.stdout += c; });
  proc.stderr.on('data', (c) => { out.stderr += c; });
  const exited = new Promise((resolve) => proc.on('exit', (code, signal) => { live.delete(proc); resolve({ code, signal }); }));
  return { proc, out, exited };
}

// Runs a server that is expected to refuse to start; resolves with its exit code and output.
async function runServerToExit({ data, env, port, timeoutMs = 15000 }) {
  const p = port || await freePort();
  const s = spawnServer({ port: p, data, env });
  const timer = setTimeout(() => s.proc.kill('SIGKILL'), timeoutMs);
  const { code, signal } = await s.exited;
  clearTimeout(timer);
  return { code, signal, stdout: s.out.stdout, stderr: s.out.stderr, port: p };
}

/**
 * Starts a console. Options:
 *   settings      object merged over the hermetic settings and written as settings.json (false = write no file)
 *   settingsText  raw text written as settings.json (wins over settings)
 *   prepare(data) called before the start, to craft files in the data folder
 *   root / data   reuse an existing temp root or data folder (the caller then owns the cleanup if keepFiles)
 *   env           extra environment
 */
async function startServer(opts = {}) {
  const root = opts.root || tempRoot();
  const data = opts.data || path.join(root, 'data');
  let env;
  try {
    fs.mkdirSync(data, { recursive: true });
    if (opts.settingsText !== undefined) fs.writeFileSync(path.join(data, 'settings.json'), opts.settingsText);
    else if (opts.settings !== false) {
      const base = hermeticSettings(root);
      const s = { ...base, ...(opts.settings || {}) };
      s.web = { ...base.web, ...((opts.settings || {}).web || {}) };
      fs.writeFileSync(path.join(data, 'settings.json'), JSON.stringify(s, null, 2));
    }
    if (opts.prepare) await opts.prepare(data, root);
    env = hermeticEnv(root, opts.env);
  } catch (e) {
    if (!opts.keepFiles) removeDir(root);
    throw e;
  }

  let s, port, lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    port = await freePort();
    s = spawnServer({ port, data, env });
    try {
      // the banner first: on Windows a connect to a port nobody listens on yet takes about two seconds to fail
      await Promise.race([
        waitFor(() => s.out.stdout.includes(`localhost:${port}`), { what: 'the console banner', intervalMs: 20 })
          .then(() => waitFor(async () => (await request(port, 'GET', '/api/queue', { timeoutMs: 5000 })).status === 200, { what: 'the console to answer' })),
        s.exited.then(({ code }) => { throw new Error(`the console exited with ${code}: ${s.out.stderr || s.out.stdout}`); })
      ]);
      lastErr = null;
      break;
    } catch (e) {
      lastErr = e;
      await kill(s);
      // another process took the port between freePort() and the start: try another one
      if (!/busy/.test(s.out.stderr)) break;
    }
  }
  if (lastErr) { if (!opts.keepFiles) removeDir(root); throw lastErr; }

  const srv = {
    port, root, data, env,
    base: `http://127.0.0.1:${port}`,
    proc: s.proc,
    exited: s.exited,
    output: () => s.out.stdout + s.out.stderr,
    request: (method, url, o) => request(port, method, url, o),
    get: (url, o) => request(port, 'GET', url, o),
    put: (url, body, o) => request(port, 'PUT', url, { ...o, body }),
    post: (url, body, o) => request(port, 'POST', url, { ...o, body }),
    del: (url, o) => request(port, 'DELETE', url, o),
    file: (...p) => path.join(data, ...p),
    alive: () => s.proc.exitCode === null && s.proc.signalCode === null,
    async stop({ keepFiles = opts.keepFiles } = {}) {
      await kill(s);
      if (!keepFiles) removeDir(root);
    }
  };
  return srv;
}

async function kill(s) {
  if (s.proc.exitCode !== null || s.proc.signalCode !== null) return;
  s.proc.kill('SIGTERM');
  const t = setTimeout(() => { try { s.proc.kill('SIGKILL'); } catch { /* gone */ } }, 3000);
  await s.exited;
  clearTimeout(t);
}

// a finished run folder: runs/<id>/run.json plus the PNGs named in `pngs`
function writeRun(data, run, { pngs = [] } = {}) {
  const dir = path.join(data, 'runs', run.id);
  fs.mkdirSync(dir, { recursive: true });
  const full = { scenarioId: 'scenario-a', scenarioName: 'Scenario A', status: 'passed', startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), device: 'emulator-0000', engine: 'adb', steps: [], ...run };
  fs.writeFileSync(path.join(dir, 'run.json'), JSON.stringify(full, null, 2));
  for (const p of pngs) {
    fs.mkdirSync(path.dirname(path.join(dir, p)), { recursive: true });
    fs.writeFileSync(path.join(dir, p), PNG);
  }
  return dir;
}

function readJsonFile(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

// runs tools/e2e.js against a console; resolves with { code, stdout, stderr }
function runCli(args, { base, env = {}, timeoutMs = 30000, cwd = REPO } = {}) {
  return new Promise((resolve, reject) => {
    const e = { ...process.env, ...env };
    if (base) e.E2E_CONSOLE = base;
    const proc = spawn(process.execPath, [CLI, ...args], { cwd, env: e, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    live.add(proc);
    let stdout = '', stderr = '';
    proc.stdout.on('data', (c) => { stdout += c; });
    proc.stderr.on('data', (c) => { stderr += c; });
    const timer = setTimeout(() => { proc.kill('SIGKILL'); reject(new Error(`e2e.js ${args.join(' ')}: no exit in ${timeoutMs} ms\n${stdout}\n${stderr}`)); }, timeoutMs);
    proc.on('error', reject);
    proc.on('exit', (code) => { clearTimeout(timer); live.delete(proc); resolve({ code, stdout, stderr }); });
  });
}

module.exports = {
  REPO, SERVER, CLI, EXE, PNG,
  tempRoot, removeDir, freePort, hermeticSettings, hermeticEnv, request, waitFor,
  startServer, runServerToExit, spawnServer, writeRun, readJsonFile, runCli
};
