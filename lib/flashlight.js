'use strict';
// Flashlight (bamlab/flashlight) as a second opinion next to our own frame costs: its profiler runs in
// lib/flashlight-worker.js, its reporter turns the measures of a run into the 0–100 score Flashlight
// shows in its own reports (average CPU, FPS, time with a thread above 90 % CPU).
//
// Everything stays on this machine: the profiler talks to the device over adb; nothing is uploaded.
const path = require('node:path');
const { fork } = require('node:child_process');

let reporter;
function available() {
  try { require.resolve('@perf-profiler/profiler'); require.resolve('@perf-profiler/reporter'); return true; } catch { return false; }
}

class FlashlightCollector {
  constructor({ adbPath, serial }) {
    this.adbPath = adbPath;
    this.serial = serial;
    this.measures = []; // { at, m }
    this.started = false;
    this.error = null;
    this.log = [];
    this.child = null;
  }

  start(pkg) {
    if (this.started) return Promise.resolve();
    this.started = true;
    if (!available()) { this.error = 'Flashlight is not installed: run npm install in the console folder'; return Promise.resolve(); }
    const env = { ...process.env, ANDROID_SERIAL: this.serial };
    if (this.adbPath) env.PATH = path.dirname(this.adbPath) + path.delimiter + (env.PATH || env.Path || '');
    this.child = fork(path.join(__dirname, 'flashlight-worker.js'), [], { env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true });
    const keep = (buf) => { for (const l of String(buf).split(/\r?\n/)) if (l.trim()) { this.log.push(l.trim()); if (this.log.length > 30) this.log.shift(); } };
    this.child.stdout.on('data', keep);
    this.child.stderr.on('data', keep);
    this.child.on('message', (msg) => {
      if (msg.type === 'measure') this.measures.push({ at: msg.at, m: msg.m });
      else if (msg.type === 'error') this.error = msg.message;
    });
    this.child.on('exit', () => { this.child = null; });
    this.child.on('error', (e) => { this.error = e.message; this.child = null; });
    this.child.send({ type: 'start', pkg });
    return Promise.resolve();
  }

  stop() {
    const child = this.child;
    if (!child) return Promise.resolve();
    return new Promise((resolve) => {
      const done = () => { clearTimeout(t); resolve(); };
      const t = setTimeout(() => { try { child.kill(); } catch { /* gone */ } done(); }, 4000);
      child.once('exit', done);
      try { child.send({ type: 'stop' }); } catch { done(); }
    });
  }

  // Flashlight's own report over a set of measures: { score, fps, cpu, ramMb, highCpuMs, threads }
  report(measures) {
    if (!measures || measures.length < 2) return null;
    try {
      reporter = reporter || require('@perf-profiler/reporter');
      const result = { name: 'run', status: 'SUCCESS', iterations: [{ time: measures.length * 500, measures: measures.map((x) => x.m), status: 'SUCCESS' }] };
      const rep = new reporter.Report(result);
      const m = rep.getAverageMetrics();
      return {
        score: rep.score,
        fps: m.fps == null ? null : Math.round(m.fps * 10) / 10,
        cpu: Math.round(m.cpu * 10) / 10,
        ramMb: m.ram == null ? null : Math.round(m.ram),
        highCpuMs: Math.round(m.totalHighCpuTime || 0),
        threads: (m.averageCpuUsagePerProcess || []).slice(0, 6).map((t) => ({ name: t.processName, pct: t.cpuUsage })),
        n: measures.length
      };
    } catch (e) {
      return { error: 'Flashlight report: ' + e.message };
    }
  }
}

module.exports = { FlashlightCollector, available };
