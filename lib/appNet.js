'use strict';
// The app's own HTTP traffic, read from its network logcat lines (tag: `appNet.tag` in the settings), and the backend's view of the
// same requests, joined by the correlation id the app sends as `baggage: correlation_id=…`.

// `adb logcat -v epoch -s <tag>:D` lines: "<epoch.ms>  <pid>  <tid> D <tag>  : <message>"
const lineRe = (tag) => new RegExp('^\\s*(\\d+\\.\\d+)\\s+\\d+\\s+\\d+\\s+\\w\\s+' + String(tag).replace(/[.*+?^${}()|[\]\\/]/g, '\\$&') + '\\s*:\\s?(.*)$');
const ID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';

function pathOf(url) {
  try { const u = new URL(url); return u.pathname + (u.search || ''); } catch { return url; }
}

// Requests are logged as REQUEST/METHOD/…/baggage, responses as RESPONSE/METHOD/FROM/…/x-correlation-id,
// and "sensitive" exchanges (commerce, auth) only as one line with method, status and correlation — no URL.
// A sensitive exchange carries the session's correlation id, shared by many requests, so each one is
// its own call rather than being merged by id.
function parse(text, tag) {
  if (!tag) return [];
  const LINE = lineRe(tag);
  const calls = new Map();
  const sensitive = [];
  const call = (id) => { if (!calls.has(id)) calls.set(id, { corr: id }); return calls.get(id); };
  let req = null, res = null;
  for (const raw of String(text || '').split(/\r?\n/)) {
    const m = LINE.exec(raw);
    if (!m) continue;
    const t = new Date(Number(m[1]) * 1000).toISOString();
    const msg = m[2];
    let x;
    if ((x = /^REQUEST: (\S+)/.exec(msg))) { req = { t, url: x[1] }; res = null; continue; }
    if ((x = /^RESPONSE: (\d{3})/.exec(msg))) { res = { t, status: Number(x[1]) }; req = null; continue; }
    if ((x = /^METHOD: (\w+)/.exec(msg))) { (req || res || {}).method = x[1]; continue; }
    if ((x = /^FROM: (\S+)/.exec(msg)) && res) { res.url = x[1]; continue; }
    if ((x = new RegExp(`baggage: .*correlation_id=(${ID})`).exec(msg)) && req) {
      const c = call(x[1]);
      Object.assign(c, { t: c.t || req.t, method: req.method || c.method, path: pathOf(req.url) });
      req = null; continue;
    }
    if ((x = new RegExp(`x-correlation-id: (${ID})`).exec(msg)) && res) {
      const c = call(x[1]);
      Object.assign(c, { t: c.t || res.t, method: c.method || res.method, path: c.path || pathOf(res.url || ''), status: res.status });
      res = null; continue;
    }
    if ((x = new RegExp(`HTTP sensitive exchange: method=(\\w+) status=(\\d{3}) correlation=(${ID})`).exec(msg))) {
      sensitive.push({ corr: x[3], t, method: x[1], status: Number(x[2]), sensitive: true });
    }
  }
  return [...calls.values(), ...sensitive].sort((a, b) => String(a.t).localeCompare(String(b.t)));
}

// Fills in what the app did not log (the path of a sensitive call, the error code, the service) from
// the backend's access log lines with the same correlation id, and lists what deserves attention.
function enrich(steps, backendLines, ignore = []) {
  const byCorr = new Map();
  for (const l of backendLines) {
    const c = l.extra && l.extra.correlation_id;
    if (!c) continue;
    if (!byCorr.has(c)) byCorr.set(c, []);
    byCorr.get(c).push(l);
  }
  const ignores = ignore.map((p) => { try { return new RegExp(p, 'i'); } catch { return null; } }).filter(Boolean);
  const used = new Set();
  let total = 0;
  steps.forEach((s, i) => {
    if (!s.startedAt) return;
    if (!s.appCalls) { s.backendIssues = [...(s.appIssues || [])]; total += s.backendIssues.length; return; }
    // enrich runs again on every live pull: start from what the app itself logged
    s.appCalls = s.appCalls.filter((c) => !c.fromBackend);
    // The step's window on the server clock: the emulator's clock drifts, the run's does not.
    const from = new Date(s.startedAt).getTime() - 1000;
    const next = steps.slice(i + 1).find((x) => x.startedAt);
    const to = (next ? new Date(next.startedAt).getTime() : from + (s.ms || 0) + 2000) + 5000;
    const issues = [...(s.appIssues || [])];
    for (const c of s.appCalls) {
      const lines = (byCorr.get(c.corr) || []).filter((l) => { const t = new Date(l.t).getTime(); return t >= from && t <= to; });
      // Access logs sample successes, so a 2xx may have no line; an error always has one.
      const edge = lines.find((l) => !used.has(l) && l.logger.startsWith('http') && l.extra && l.extra.caller === 'public'
        && (!c.method || l.extra.method === c.method) && (!c.status || l.extra.status === c.status));
      if (edge) {
        used.add(edge);
        c.path = c.path || edge.extra.path;
        c.service = edge.service;
        c.status = c.status || edge.extra.status;
        if (edge.extra.error_code) c.errorCode = edge.extra.error_code;
        c.ms = edge.extra.duration;
      }
      const backendErrors = c.sensitive ? [] : lines.filter((l) => l.level === 'ERROR' || l.level === 'FATAL').map((l) => `${l.service}: ${l.msg.slice(0, 200)}`);
      const label = `${c.method || '?'} ${c.path || '(path hidden)'} → ${c.status || '?'}${c.errorCode ? ' ' + c.errorCode : ''}`;
      const allowed = (s.allowStatus || []).includes(c.status) || ignores.some((r) => r.test(label));
      if (!allowed && c.status >= 400) issues.push({ corr: c.corr, level: c.status >= 500 ? 'error' : 'warn', text: label });
      for (const e of backendErrors) issues.push({ corr: c.corr, level: 'error', text: e });
    }
    // Error answers to the app's ids in this window that the app's own log did not show.
    const ids = new Set(s.appCalls.map((c) => c.corr));
    for (const id of ids) {
      for (const l of byCorr.get(id) || []) {
        const t = new Date(l.t).getTime();
        if (used.has(l) || t < from || t > to || !l.logger.startsWith('http') || !l.extra || l.extra.caller !== 'public' || !(l.extra.status >= 400)) continue;
        used.add(l);
        const label = `${l.extra.method} ${l.extra.path} → ${l.extra.status}${l.extra.error_code ? ' ' + l.extra.error_code : ''}`;
        if ((s.allowStatus || []).includes(l.extra.status) || ignores.some((r) => r.test(label))) continue;
        s.appCalls.push({ corr: id, t: l.t, method: l.extra.method, path: l.extra.path, status: l.extra.status, errorCode: l.extra.error_code, service: l.service, ms: l.extra.duration, fromBackend: true });
        issues.push({ corr: id, level: l.extra.status >= 500 ? 'error' : 'warn', text: label });
      }
    }
    s.backendIssues = issues;
    total += issues.length;
  });
  return total;
}

module.exports = { parse, enrich };
