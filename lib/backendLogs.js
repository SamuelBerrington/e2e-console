'use strict';
// Backend logs for a run's time window, read from a VictoriaLogs service in Kubernetes through a
// kubectl port-forward. Off until `logs.enabled`, `logs.namespace` and `logs.service` are set.
const { spawn } = require('node:child_process');
const path = require('node:path');

const LOCAL_PORT = 19428;
let forward = null;

function kubeEnv(settings) {
  const home = process.env.USERPROFILE || process.env.HOME || '';
  return {
    ...process.env,
    KUBECONFIG: (settings.logs.kubeconfig || '').replace(/^~(?=[\\/]|$)/, home) || process.env.KUBECONFIG || path.join(home, '.kube', 'config'),
    PATH: process.env.PATH + path.delimiter + path.join(home, 'bin')
  };
}

async function reachable() {
  try {
    const r = await fetch(`http://127.0.0.1:${LOCAL_PORT}/health`, { signal: AbortSignal.timeout(2000) });
    return r.ok;
  } catch {
    return false;
  }
}

// The cluster's API server drops a port-forward upgrade now and then ("error upgrading connection: EOF");
// a second attempt a few seconds later goes through.
async function ensureForward(settings) {
  let last;
  for (let attempt = 0; attempt < 3; attempt++) {
    try { return await openForward(settings); } catch (e) { last = e; await new Promise((r) => setTimeout(r, 3000)); }
  }
  throw last;
}

async function openForward(settings) {
  if (forward && !forward.exited && (await reachable())) return;
  if (forward && !forward.exited) forward.kill();
  const l = settings.logs;
  if (!l.namespace || !l.service) throw new Error('backend logs: VictoriaLogs namespace and service are not set in the settings');
  const child = spawn('kubectl', ['-n', l.namespace, 'port-forward', `svc/${l.service}`, `${LOCAL_PORT}:${Number(l.port) || 9428}`],
    { env: kubeEnv(settings), windowsHide: true });
  let stderr = '';
  child.stderr.on('data', (c) => { stderr += c; });
  child.on('exit', () => { child.exited = true; });
  // no kubectl on PATH (ENOENT) is an 'error' event: unheard, it would take the whole console down
  child.on('error', (e) => { child.exited = true; stderr += (e.code === 'ENOENT' ? 'kubectl is not installed or not on PATH' : e.message); });
  forward = child;
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 500));
    if (child.exited) throw new Error('kubectl port-forward failed: ' + (stderr.trim() || 'no access to the cluster'));
    if (await reachable()) return;
  }
  throw new Error('VictoriaLogs did not answer through port-forward');
}

function stop() {
  if (forward && !forward.exited) forward.kill();
}

const DROP = 'kubernetes.*, file, cluster, _stream, _stream_id, source_type, log_type, stream';

async function fetchLogs(settings, from, to) {
  await ensureForward(settings);
  const limit = Number(settings.logs.limit) || 5000;
  const q = `_time:[${new Date(from).toISOString()}, ${new Date(to).toISOString()}) ${settings.logs.filter} | copy kubernetes.container_name as container | delete ${DROP} | sort by (_time)`;
  const res = await fetch(`http://127.0.0.1:${LOCAL_PORT}/select/logsql/query?limit=${limit}&query=${encodeURIComponent(q)}`, { signal: AbortSignal.timeout(30000) });
  const text = await res.text();
  if (!res.ok) throw new Error('VictoriaLogs: ' + text.slice(0, 300));
  return text.split('\n').filter(Boolean).map((l) => {
    const o = JSON.parse(l);
    const { _time, _msg, level, service, container, logger, thread, ...rest } = o;
    const line = { t: _time, msg: _msg || '', level: (level || '').toUpperCase(), service: container || service || '', logger: logger || '', extra: Object.keys(rest).length ? rest : undefined };
    return httpAccess(line);
  });
}

// Access-log lines carry their whole record as JSON in the message and no level;
// show them as "METHOD path → status" and take the level from the status code.
function httpAccess(line) {
  if (!line.msg.startsWith('{"log_type":"http"')) return line;
  let a;
  try { a = JSON.parse(line.msg); } catch { return line; }
  const err = a.error_code ? ` ${a.error_code}` : '';
  line.msg = `${a.method} ${a.path} → ${a.status}${err} · ${a.duration} ms${a.caller ? ' · from ' + a.caller : ''}`;
  line.level = a.status >= 500 ? 'ERROR' : a.status >= 400 ? 'WARN' : 'INFO';
  line.logger = 'http ' + (a.direction || '');
  line.extra = { ...(line.extra || {}), ...a };
  return line;
}

process.on('exit', stop);

module.exports = { fetchLogs, stop };
