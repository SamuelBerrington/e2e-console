'use strict';
// Performance measurement around steps (Android): what a screen costs the app, as opposed to how it
// looks on this particular device.
//
//   frames   — `dumpsys gfxinfo <pkg> framestats`, one row per frame with the timestamps of every phase.
//              ui     = main thread: input, animation, layout, draw recording   (SyncQueued − HandleInputStart)
//              render = RenderThread without the wait for a buffer                (SwapBuffers − SyncStart − DequeueBufferDuration)
//              app    = ui + render — the cost the app brings to any phone
//              total  = IntendedVsync → FrameCompleted — what this device showed (on an emulator this is
//                       bound by the host's display path, which is why it is not the number we score)
//              jank   = share of frames whose app cost does not fit the frame interval (16.7 ms at 60 Hz)
//   cpu/ram  — /proc/<pid>/task/*/stat (per-thread jiffies) and /proc/<pid>/statm, before and after a step
//   start    — `am start -W` TotalTime: process start → first frame, measured by the framework itself
//   settle   — from the frame that handled the input to the end of the first burst of frames: how long
//              the screen kept moving after a tap or a swipe
//
// The score is for the device the run was on: 0–100 from jank share and p95 app cost, thresholds in
// README («Производительность»). The samples per step are kept so a run and a build can be aggregated.
const { sleep } = require('./adb');

const NS = 1e6; // ns → ms
const MIN_FRAMES = 20; // fewer frames than this do not make a score
const BURST_GAP_MS = 250; // a pause this long ends the transition after a tap

function parseFramestats(text) {
  const frames = [];
  let win = '';
  let inTable = false;
  let cols = null;
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const w = /^Window:\s*(.+)$/.exec(line);
    if (w) { win = w[1]; continue; }
    if (line === '---PROFILEDATA---') { inTable = !inTable; cols = null; continue; }
    if (!inTable) continue;
    if (!cols) { cols = line.replace(/,$/, '').split(','); continue; }
    const v = line.replace(/,$/, '').split(',').map(Number);
    if (v.length < cols.length || v.some(Number.isNaN)) continue;
    const f = {};
    cols.forEach((c, i) => { f[c] = v[i]; });
    const frame = deriveFrame(f, win);
    if (frame) frames.push(frame);
  }
  return frames;
}

// A row → one frame with the numbers above. Rows with the «window layout changed» flag (the first frame
// of a surface) and incomplete rows are dropped, as Macrobenchmark does.
function deriveFrame(f, win) {
  const flags = f.Flags || 0;
  if (flags & 1) return null;
  const vsync = f.IntendedVsync, input = f.HandleInputStart, queued = f.SyncQueued, syncStart = f.SyncStart, swap = f.SwapBuffers, done = f.FrameCompleted;
  if (!vsync || !input || !queued || !syncStart || !swap || !done || done < vsync) return null;
  // Android 12–14 print the header as «FrameInterval,FrameStartTime» but write the values the other way
  // round (seen on a POCO X5 Pro, Android 14): an "interval" that is a timestamp means the columns are swapped.
  let intervalNs = f.FrameInterval;
  if (intervalNs > 1e8 && f.FrameStartTime > 0 && f.FrameStartTime < 1e8) intervalNs = f.FrameStartTime;
  const interval = intervalNs > 2e6 && intervalNs < 1e8 ? intervalNs / NS : 16.667;
  const dequeue = (f.DequeueBufferDuration || 0) / NS;
  const ui = Math.max(0, (queued - input) / NS);
  const render = Math.max(0, (swap - syncStart) / NS - dequeue);
  const gpu = f.GpuCompleted && f.GpuCompleted > swap ? (f.GpuCompleted - swap) / NS : null;
  const total = (done - vsync) / NS;
  const missed = f.FrameDeadline ? done > f.FrameDeadline : total > interval;
  return { win, key: `${win}|${vsync}`, t: vsync, end: done, ui, render, app: ui + render, gpu, total, interval, missed, input: !!f.InputEventId };
}

// Keeps polling framestats while a step runs: the device holds only the last ~120 frames per window.
class FrameSampler {
  constructor(device, pkg, { everyMs = 600 } = {}) {
    this.device = device;
    this.pkg = pkg;
    this.everyMs = everyMs;
    this.seen = new Set();
    this.frames = [];
    this.timer = null;
    this.busy = false;
    this.error = null;
  }

  async poll() {
    if (this.busy) return;
    this.busy = true;
    try {
      const text = await this.device.framestats(this.pkg);
      for (const fr of parseFramestats(text)) {
        if (this.seen.has(fr.key)) continue;
        this.seen.add(fr.key);
        if (this.started) this.frames.push(fr);
      }
    } catch (e) {
      this.error = e.message;
    } finally {
      this.busy = false;
    }
  }

  // what is on the device now is the past: remembered so only new frames count
  async start() {
    await this.poll();
    this.started = true;
    this.timer = setInterval(() => this.poll(), this.everyMs);
  }

  async stop() {
    clearInterval(this.timer);
    this.timer = null;
    while (this.busy) await sleep(50);
    await this.poll();
    return this.frames.sort((a, b) => a.t - b.t);
  }
}

function percentile(sorted, p) {
  if (!sorted.length) return null;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[i];
}
const r1 = (x) => (x == null ? null : Math.round(x * 10) / 10);

function dist(values) {
  const s = values.slice().sort((a, b) => a - b);
  return { p50: r1(percentile(s, 50)), p90: r1(percentile(s, 90)), p95: r1(percentile(s, 95)), max: r1(s[s.length - 1]) };
}

// per-step and per-run statistics over frames (or over saved samples: { app, total, interval })
// jank   — share of frames costing more than a 60 fps frame (16.7 ms): the same yardstick on every device
// jankHz — share costing more than this display's own frame interval (stricter on 90/120 Hz phones)
const BUDGET_60 = 16.667;
function frameStats(frames) {
  if (!frames.length) return { count: 0 };
  const app = frames.map((f) => f.app), total = frames.map((f) => f.total);
  const jank = frames.filter((f) => f.app > BUDGET_60).length / frames.length;
  const jankHz = frames.filter((f) => f.app > (f.interval || BUDGET_60)).length / frames.length;
  const missed = frames.filter((f) => f.missed).length / frames.length;
  const out = { count: frames.length, app: dist(app), total: dist(total), jank: Math.round(jank * 1000) / 1000, jankHz: Math.round(jankHz * 1000) / 1000, missed: Math.round(missed * 1000) / 1000 };
  if (frames[0].ui !== undefined) { out.ui = dist(frames.map((f) => f.ui)); out.render = dist(frames.map((f) => f.render)); }
  const gpu = frames.map((f) => f.gpu).filter((x) => x != null);
  if (gpu.length) out.gpu = dist(gpu);
  return out;
}

// From the first frame that handled input (or the first frame at all) to the end of the first
// uninterrupted burst: the transition the user watched.
function settleMs(frames) {
  if (!frames.length) return null;
  let i = frames.findIndex((f) => f.input);
  if (i < 0) i = 0;
  let end = frames[i].end;
  for (let k = i + 1; k < frames.length; k++) {
    if ((frames[k].t - end) / NS > BURST_GAP_MS) break;
    end = Math.max(end, frames[k].end);
  }
  return Math.round((end - frames[i].t) / NS);
}

// compact per-step samples kept in run.json so a run and a build can be aggregated later
function samplesOf(frames) {
  return { app: frames.map((f) => r1(f.app)), total: frames.map((f) => r1(f.total)), interval: r1(frames[0] ? frames[0].interval : 16.667), missed: frames.filter((f) => f.missed).length };
}
function framesOfSamples(s) {
  if (!s || !Array.isArray(s.app)) return [];
  const missed = s.missed || 0;
  return s.app.map((app, i) => ({ app, total: s.total ? s.total[i] : app, interval: s.interval || 16.667, missed: i < missed }));
}

// 0–100 for the device the run was on: half jank share (0 % → 100, 30 % → 0), half p95 app cost
// (≤ 8 ms → 100, ≥ 33 ms → 0). ≥ 85 «плавно», ≥ 60 «нормально», below — «тормозит».
// Stamped on every run summary (since 2026-11-11). A run without the stamp, or with another one, was scored by
// an older formula: the history rescores it from its stored frame statistics instead of mixing formulas.
const SCORE_FORMULA = '2026-11-08';
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
function score(st) {
  if (!st || !st.count || st.count < MIN_FRAMES) return null;
  const jankScore = 100 * clamp(1 - st.jank / 0.3, 0, 1);
  const costScore = 100 * clamp((33 - st.app.p95) / 25, 0, 1);
  return Math.round(0.5 * jankScore + 0.5 * costScore);
}
function verdict(sc) {
  if (sc == null) return null;
  return sc >= 85 ? 'smooth' : sc >= 60 ? 'fine' : 'laggy';
}

// ---------- /proc ----------
// `cat /proc/<pid>/statm; echo ---; cat /proc/<pid>/task/*/stat`
function parseProc(text, pid) {
  const [statm, tasks] = String(text || '').split(/\r?\n---\r?\n/);
  const pages = Number((statm || '').trim().split(/\s+/)[1]) || 0;
  const threads = {};
  for (const line of (tasks || '').split(/\r?\n/)) {
    const m = /^(\d+) \((.*)\) \S (.*)$/.exec(line.trim());
    if (!m) continue;
    const rest = m[3].split(/\s+/);
    const jiffies = (Number(rest[10]) || 0) + (Number(rest[11]) || 0);
    const name = m[1] === String(pid) ? 'UI Thread' : m[2];
    threads[name] = (threads[name] || 0) + jiffies;
  }
  // a process that vanished mid-read gives an empty listing: no snapshot rather than zeros
  if (!Object.keys(threads).length) return null;
  return { at: Date.now(), rssPages: pages, threads };
}

// CPU between two snapshots of the same process: ms of CPU, share of one core, and the threads that ate it
function cpuDelta(a, b, clkTck, pageSize) {
  const perTick = 1000 / (clkTck || 100);
  const wall = Math.max(1, b.at - a.at);
  const threads = [];
  let totalMs = 0;
  for (const [name, j] of Object.entries(b.threads)) {
    const ms = Math.max(0, j - (a.threads[name] || 0)) * perTick;
    totalMs += ms;
    if (ms > 0) threads.push({ name, ms: Math.round(ms) });
  }
  threads.sort((x, y) => y.ms - x.ms);
  return { ms: Math.round(totalMs), pct: Math.round((totalMs / wall) * 100), threads: threads.slice(0, 6), ramMb: Math.round((b.rssPages * (pageSize || 4096)) / 1048576) };
}

// `am start -W` output → { totalMs, state }
function parseAmStart(out) {
  const total = /TotalTime:\s*(\d+)/.exec(out || '');
  const state = /LaunchState:\s*(\w+)/.exec(out || '');
  return total ? { totalMs: Number(total[1]), state: state ? state[1] : undefined } : null;
}

// Flashlight measures (500 ms each) that fall into a step's window → averages
function flashlightSlice(measures, t0, t1) {
  const inWin = measures.filter((m) => m.at >= t0 && m.at <= t1 + 600);
  if (!inWin.length) return null;
  const fps = inWin.map((m) => m.m.fps).filter((x) => typeof x === 'number');
  const cpu = inWin.map((m) => Object.values(m.m.cpu.perName).reduce((s, x) => s + x, 0));
  const ui = inWin.map((m) => m.m.cpu.perName['UI Thread'] || 0);
  const ram = inWin.map((m) => m.m.ram).filter((x) => typeof x === 'number');
  const avg = (xs) => (xs.length ? Math.round((xs.reduce((s, x) => s + x, 0) / xs.length) * 10) / 10 : null);
  return { n: inWin.length, fps: avg(fps), cpu: avg(cpu), uiCpu: avg(ui), ramMb: ram.length ? Math.round(Math.max(...ram)) : null };
}

// ---------- the session of one run ----------
const MEASURED_TYPES = new Set(['launch', 'link', 'tap', 'type', 'swipe', 'pinch', 'back', 'wait', 'assertText', 'repeat', 'maestro']);

class PerfSession {
  constructor({ device, pkg, flashlight = null }) {
    this.device = device;
    this.pkg = pkg;
    this.fl = flashlight; // a FlashlightCollector or null
    this.info = {};
    this.clk = 100;
    this.pageSize = 4096;
  }

  async open() {
    try {
      this.info = await this.device.info();
      this.clk = Number(this.info.clkTck) || 100;
      this.pageSize = Number(this.info.pageSize) || 4096;
      const v = await this.device.appVersion(this.pkg).catch(() => ({}));
      this.info.versionName = v.versionName;
      this.info.versionCode = v.versionCode;
      Object.assign(this.info, await this.identity().catch(() => ({})));
    } catch (e) {
      this.info.error = e.message;
    }
  }

  // What was measured, beyond the version: a debug build keeps versionName/versionCode across rebuilds, so the
  // installed APK's digest tells builds apart; the system image's fingerprint (and the AVD name) tells a
  // calibration's emulator from another one. One round trip; md5 of a ~100 MB APK takes about a second.
  async identity() {
    if (typeof this.device.shell !== 'function') return {};
    const out = await this.device.shell(`getprop ro.build.fingerprint; getprop ro.boot.qemu.avd_name; getprop ro.kernel.qemu.avd_name; echo ---; p=$(pm path ${this.pkg} | head -n 1); md5sum "\${p#package:}" 2>/dev/null`, { timeoutMs: 20000 });
    const [props, sum] = String(out || '').split(/\r?\n---\r?\n?/);
    const l = (props || '').split(/\r?\n/).map((x) => x.trim());
    const md5 = /^([0-9a-f]{32})\s/.exec((sum || '').trim());
    const id = {};
    if (l[0]) id.buildFingerprint = l[0];
    if (l[1] || l[2]) id.avd = l[1] || l[2];
    if (md5) id.apkMd5 = md5[1].slice(0, 12);
    return id;
  }

  async begin() {
    const pid = await this.device.pid(this.pkg);
    await this.device.gfxReset(this.pkg);
    const sampler = new FrameSampler(this.device, this.pkg);
    await sampler.start();
    const proc = pid ? parseProc(await this.device.procStat(pid).catch(() => ''), pid) : null;
    if (this.fl && pid && !this.fl.started) this.fl.start(this.pkg).catch(() => {});
    return { pid, sampler, proc, t0: Date.now() };
  }

  async end(p, rec = {}) {
    const frames = await p.sampler.stop();
    const t1 = Date.now();
    const out = { ms: t1 - p.t0, frames: frameStats(frames), samples: samplesOf(frames) };
    const settle = settleMs(frames);
    if (settle != null) out.settleMs = settle;
    if (p.sampler.error) out.framesError = p.sampler.error;
    const pid = await this.device.pid(this.pkg);
    const proc = pid ? parseProc(await this.device.procStat(pid).catch(() => ''), pid) : null;
    if (proc) {
      if (p.proc && pid === p.pid) out.cpu = cpuDelta(p.proc, proc, this.clk, this.pageSize);
      else out.cpu = { ramMb: Math.round((proc.rssPages * this.pageSize) / 1048576), restarted: true };
    }
    if (rec.launch && rec.launch.totalMs) out.startMs = rec.launch.totalMs;
    if (this.fl) { const fl = flashlightSlice(this.fl.measures, p.t0, t1); if (fl) out.flashlight = fl; }
    out.score = score(out.frames);
    return out;
  }

  // run summary over the main-phase steps that were measured
  async close(stepRecs) {
    const main = stepRecs.filter((r) => r.perf && (!r.phase || r.phase === 'main'));
    const measured = main.length ? main : stepRecs.filter((r) => r.perf);
    const frames = measured.flatMap((r) => framesOfSamples(r.perf.samples));
    const st = frameStats(frames);
    const sc = score(st);
    const cpuSteps = measured.filter((r) => r.perf.cpu && r.perf.cpu.pct != null);
    const wall = cpuSteps.reduce((s, r) => s + r.perf.ms, 0);
    const cpuPct = wall ? Math.round(cpuSteps.reduce((s, r) => s + r.perf.cpu.pct * r.perf.ms, 0) / wall) : null;
    const ram = measured.map((r) => r.perf.cpu && r.perf.cpu.ramMb).filter((x) => x != null);
    const starts = stepRecs.filter((r) => r.perf && r.perf.startMs).map((r) => ({ phase: r.phase || 'main', ms: r.perf.startMs }));
    const start = starts.find((s) => s.phase === 'main') || starts[0];
    const out = {
      steps: measured.map((r) => r.n),
      frames: st,
      score: sc,
      verdict: verdict(sc),
      cpuPct,
      ramMaxMb: ram.length ? Math.max(...ram) : null,
      startMs: start ? start.ms : null,
      formula: SCORE_FORMULA,
      device: this.info
    };
    if (this.fl) {
      const windows = measured.map((r) => [new Date(r.startedAt).getTime(), new Date(r.startedAt).getTime() + (r.perf.ms || 0) + 600]);
      const inRun = this.fl.measures.filter((m) => windows.some(([a, b]) => m.at >= a && m.at <= b));
      out.flashlight = this.fl.report(inRun) || { error: this.fl.error || 'Flashlight produced no measures' };
      await this.fl.stop().catch(() => {});
    }
    return out;
  }
}

function normalizeMeasure(fromScenario, override) {
  if (!fromScenario && !override) return null;
  const sc = fromScenario && typeof fromScenario === 'object' ? fromScenario : {};
  const ov = override && typeof override === 'object' ? override : {};
  const iterations = Math.max(1, Math.min(20, Number(ov.iterations || sc.iterations) || 1));
  const flashlight = ov.flashlight !== undefined ? !!ov.flashlight : sc.flashlight !== undefined ? !!sc.flashlight : true;
  return { iterations, flashlight, iteration: ov.iteration || 1 };
}

// ---------- calibration: emulator numbers → a phone ----------
// K = phone cost / emulator cost, per step (median over steps both runs measured with enough frames).
// With a reference phone of known chip score S, a frame costing X ms on the emulator costs X·K on it and
// about X·K·S/S' on a phone of score S'. «Нормально» is a p95 within 12 ms (60 Hz with headroom),
// «плавно» within 7 ms (120 Hz).
const BUDGET_OK = 12, BUDGET_SMOOTH = 7;
const medianOf = (xs) => { const s = xs.filter((x) => x != null && Number.isFinite(x)).sort((a, b) => a - b); if (!s.length) return null; const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

// The forecast is about p95, so K is the ratio of p95s (an emulator's distribution is much wider than a
// phone's; a p50 ratio would overstate the tail). The p50 ratio is kept for reference.
function calibrate(phoneRun, emuRun) {
  const pairs = [];
  for (const ps of phoneRun.steps || []) {
    const es = (emuRun.steps || []).find((x) => x.n === ps.n);
    const pf = ps.perf && ps.perf.frames, ef = es && es.perf && es.perf.frames;
    if (!pf || !ef || pf.count < 5 || ef.count < 5) continue;
    pairs.push({ n: ps.n, app: pf.app.p95 / ef.app.p95, app50: pf.app.p50 / ef.app.p50, ui: pf.ui && ef.ui ? pf.ui.p95 / ef.ui.p95 : null, render: pf.render && ef.render ? pf.render.p95 / ef.render.p95 : null });
  }
  let k;
  if (pairs.length >= 2) k = { app: medianOf(pairs.map((p) => p.app)), app50: medianOf(pairs.map((p) => p.app50)), ui: medianOf(pairs.map((p) => p.ui)), render: medianOf(pairs.map((p) => p.render)), steps: pairs.length };
  else {
    const pf = phoneRun.perf && phoneRun.perf.frames, ef = emuRun.perf && emuRun.perf.frames;
    if (!pf || !ef || !pf.count || !ef.count) return null;
    k = { app: pf.app.p95 / ef.app.p95, app50: pf.app.p50 / ef.app.p50, steps: 0 };
  }
  for (const key of ['app', 'app50', 'ui', 'render']) if (k[key] != null) k[key] = Math.round(k[key] * 1000) / 1000;
  return k;
}

// ---------- what a calibration is worth ----------
// K describes one emulator in one state against one phone on one build. It is only usable while that holds,
// so a calibration records where it came from and every forecast is checked against it.
const CAL_MAX_DAYS = 14; // an emulator's state (host load, image updates, HAL services) drifts within weeks
const K_PLAUSIBLE = [0.1, 3]; // a phone 10x faster than a sane emulator means the emulator was not sane
const EMU_DRIFT = 2; // the same scenario costing 2x more or less on the emulator than at calibration

// the identity of the system the numbers came from (stored with a calibration, compared with a run's device)
function deviceIdentity(d = {}) {
  const out = { model: d.model, sdk: d.sdk, abi: d.abi, avd: d.avd, buildFingerprint: d.buildFingerprint, versionName: d.versionName, versionCode: d.versionCode, apkMd5: d.apkMd5 };
  for (const k of Object.keys(out)) if (out[k] == null || out[k] === '') delete out[k];
  return out;
}
// same emulator image: model, sdk and abi always; AVD name and system fingerprint when both sides recorded them
function sameImage(a = {}, b = {}) {
  for (const k of ['model', 'sdk', 'abi']) if (a[k] != null && b[k] != null && String(a[k]) !== String(b[k])) return false;
  for (const k of ['avd', 'buildFingerprint']) if (a[k] && b[k] && a[k] !== b[k]) return false;
  return true;
}
// same installed build: versionName and versionCode always, the APK digest when both sides have it
function sameBuild(a = {}, b = {}) {
  if (String(a.versionName || '') !== String(b.versionName || '') || String(a.versionCode ?? '') !== String(b.versionCode ?? '')) return false;
  return !(a.apkMd5 && b.apkMd5 && a.apkMd5 !== b.apkMd5);
}

// what the calibration endpoint stores next to K
function calibrationOrigin(phoneRun, emuRun) {
  const ef = (emuRun.perf || {}).frames || {};
  return {
    phone: deviceIdentity((phoneRun.perf || {}).device),
    emulator: { ...deviceIdentity((emuRun.perf || {}).device), p95: ef.app ? ef.app.p95 : undefined },
    variant: phoneRun.variant || undefined, emuVariant: emuRun.variant || undefined
  };
}

// Is the stored calibration fit for this emulator run? Reasons are codes (the UI words them):
//   no-reference  — only a bare K is stored (no reference phone, no date): nothing to forecast with
//   unknown-age   — no calibration date
//   no-origin     — calibrated before the console recorded which emulator and builds it compared
//   stale         — older than CAL_MAX_DAYS
//   other-image   — the run is on another emulator image than the calibration
//   build-mismatch — at calibration the phone and the emulator ran different builds (or variants)
//   k-implausible — K outside K_PLAUSIBLE
//   emu-drift     — the calibration scenario now costs EMU_DRIFT× more or less on the emulator
function calibrationCheck(cal, run, now = Date.now()) {
  const reasons = [];
  const ref = (cal && cal.reference) || null;
  const k = cal && cal.k && cal.k.app;
  if (!ref || !ref.score) reasons.push('no-reference');
  const at = ref && ref.at ? Date.parse(ref.at) : NaN;
  const ageDays = Number.isFinite(at) ? Math.floor((now - at) / 864e5) : null;
  if (ageDays == null) reasons.push('unknown-age');
  else if (ageDays > CAL_MAX_DAYS) reasons.push('stale');
  if (ref && !ref.emulator) {
    reasons.push('no-origin');
    // older calibrations kept at least the two version names
    if (ref.phoneVersion && ref.emuVersion && ref.phoneVersion !== ref.emuVersion) reasons.push('build-mismatch');
  }
  if (ref && ref.emulator) {
    const dev = ((run || {}).perf || {}).device || {};
    if (!sameImage(ref.emulator, dev)) reasons.push('other-image');
    if (!ref.phone || !sameBuild(ref.phone, ref.emulator) || (ref.variant || '') !== (ref.emuVariant || '')) reasons.push('build-mismatch');
    const p95 = run && run.perf && run.perf.frames && run.perf.frames.app && run.perf.frames.app.p95;
    if (run && run.scenarioId === ref.scenarioId && (run.variant || '') === (ref.emuVariant || '') && ref.emulator.p95 && p95) {
      const ratio = p95 / ref.emulator.p95;
      if (ratio > EMU_DRIFT || ratio < 1 / EMU_DRIFT) reasons.push('emu-drift');
    }
  }
  if (k && (k < K_PLAUSIBLE[0] || k > K_PLAUSIBLE[1])) reasons.push('k-implausible');
  return { ok: !reasons.length, reasons, at: ref ? ref.at : undefined, ageDays, maxDays: CAL_MAX_DAYS };
}

// For a run on the emulator: what it means on the reference phone and up and down the chip scale. The phone
// numbers are given only when the calibration passes calibrationCheck; otherwise only why not, so no stale K
// can be read as a measurement (the API and the CLI see the same thing as the page).
function forecast(summary, cal, examples = [], run = null, now = Date.now()) {
  if (!summary || !summary.frames || summary.frames.count < MIN_FRAMES || !cal || !cal.k || !cal.k.app) return null;
  const ref = cal.reference || {};
  const trust = calibrationCheck(cal, run || { perf: summary }, now);
  const head = {
    k: cal.k.app,
    steps: cal.k.steps,
    versions: ref.phoneVersion || ref.emuVersion ? { phone: ref.phoneVersion, emulator: ref.emuVersion } : undefined,
    at: ref.at,
    trust
  };
  if (!trust.ok) return { ...head, reference: ref.name ? { name: ref.name, chip: ref.chip, score: ref.score } : undefined };
  const p95 = summary.frames.app.p95 * cal.k.app;
  const at = (score) => { const ms = p95 * ref.score / score; return { ms: r1(ms), verdict: ms <= BUDGET_SMOOTH ? 'smooth' : ms <= BUDGET_OK ? 'fine' : 'laggy' }; };
  return {
    ...head,
    reference: { name: ref.name, chip: ref.chip, score: ref.score, ...at(ref.score) },
    needOk: Math.round(ref.score * p95 / BUDGET_OK),
    needSmooth: Math.round(ref.score * p95 / BUDGET_SMOOTH),
    phones: examples.map((e) => ({ name: e.name, score: e.score, ...at(e.score) })).sort((a, b) => a.score - b.score)
  };
}

module.exports = { parseFramestats, FrameSampler, frameStats, settleMs, score, verdict, parseProc, cpuDelta, parseAmStart, flashlightSlice, PerfSession, MEASURED_TYPES, normalizeMeasure, framesOfSamples, MIN_FRAMES, calibrate, forecast, BUDGET_OK, BUDGET_SMOOTH,
  SCORE_FORMULA, CAL_MAX_DAYS, deviceIdentity, sameImage, sameBuild, calibrationOrigin, calibrationCheck };
