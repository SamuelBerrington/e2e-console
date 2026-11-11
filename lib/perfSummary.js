'use strict';
// The performance history: measured runs folded into one score per device and build, the way a
// benchmark does it — scenario (and variant) → section → total.
//
//   scenario score  = median of the run scores of that scenario+variant on that device and build
//   section score   = mean of its scenarios' scores (0–100)
//   total           = sum of section scores, out of sections × 100 — so a device's number grows as
//                     sections are added, and a weak section is visible as a hole, not averaged away
//
// Next to every median goes the spread it came from (min–max over the runs, and the run count): repeated
// runs of one build differ by 4–13 points on a phone and up to 34 on an emulator, so a difference between
// builds is only a difference when it is wider than that. A section's range is [mean of its scenarios' mins,
// mean of their maxes] and a total's is the sum of its sections' — each median lies inside them.
//
// Only passed runs count; a device is the emulator or a phone model; a build is what was installed: the
// version name and code plus the APK digest when the run recorded it (perf.identity), else the APK file name
// (runs recorded before 2026-11-11 have no digest and group by file name, version name and code).
const { score: scoreOf, SCORE_FORMULA } = require('./perf');

const med = (xs) => { const s = xs.filter((x) => x != null && Number.isFinite(x)).sort((a, b) => a - b); if (!s.length) return null; const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const r1 = (x) => (x == null ? null : Math.round(x * 10) / 10);
const range = (xs) => { const s = xs.filter((x) => x != null && Number.isFinite(x)); return s.length ? [Math.min(...s), Math.max(...s)] : null; };

function deviceOf(run) {
  const d = (run.perf || {}).device || {};
  return d.emulator ? { key: 'emulator', name: 'Emulator', emulator: true, model: d.model } : { key: d.model || run.device || '?', name: d.model || run.device || '?', emulator: false, chip: d.soc };
}
function buildOf(run) {
  const d = (run.perf || {}).device || {};
  const apk = String(run.build || '—').replace(/\.apk$/, '');
  const code = d.versionCode != null ? String(d.versionCode) : '';
  // the file name comes from settings, not from the device: with a digest it is only a label
  const id = d.apkMd5 ? `md5:${d.apkMd5}` : `apk:${apk}`;
  return { key: `${d.versionName || ''}|${code}|${id}`, apk, version: d.versionName || '', versionCode: code, apkMd5: d.apkMd5 || '' };
}
// a stored score is from the formula of its day; a run scored by another formula is rescored from its frames
function runScore(r) {
  if (r.perf.formula === SCORE_FORMULA) return r.perf.score;
  const s = scoreOf(r.perf.frames);
  return s == null ? r.perf.score : s;
}

// runs: the runs list (with perf summaries); scenarios: current scenario files (section, name)
function summarize(runs, scenarios) {
  const byId = new Map(scenarios.map((s) => [s.id, s]));
  const devices = new Map();
  for (const r of runs) {
    if (r.status !== 'passed' || !r.perf || r.perf.score == null || !r.perf.frames) continue;
    const dev = deviceOf(r), build = buildOf(r);
    const sc = byId.get(r.scenarioId);
    const section = (sc && sc.section) || r.section || 'Other';
    const itemKey = `${r.scenarioId}|${r.variant || ''}`;
    if (!devices.has(dev.key)) devices.set(dev.key, { ...dev, builds: new Map() });
    const D = devices.get(dev.key);
    if (!D.builds.has(build.key)) D.builds.set(build.key, { ...build, items: new Map(), lastAt: '' });
    const B = D.builds.get(build.key);
    if (r.startedAt > B.lastAt) B.lastAt = r.startedAt;
    if (!B.items.has(itemKey)) B.items.set(itemKey, { scenarioId: r.scenarioId, name: (sc && sc.name) || r.scenarioName, variant: r.variant || null, variantTitle: r.variantTitle || r.variant || null, section, runs: [] });
    B.items.get(itemKey).runs.push(r);
  }
  const out = [];
  for (const D of devices.values()) {
    const builds = [];
    for (const B of D.builds.values()) {
      const sections = new Map();
      for (const it of B.items.values()) {
        const rs = it.runs.slice().sort((a, b) => b.startedAt.localeCompare(a.startedAt));
        const scores = rs.map(runScore);
        const p95s = rs.map((x) => x.perf.frames.app && x.perf.frames.app.p95);
        const janks = rs.map((x) => x.perf.frames.jank);
        const starts = rs.map((x) => x.perf.startMs);
        const item = {
          scenarioId: it.scenarioId, name: it.name, variant: it.variant, variantTitle: it.variantTitle, section: it.section,
          score: Math.round(med(scores)),
          p95: r1(med(p95s)),
          jank: med(janks),
          startMs: med(starts),
          flashlight: med(rs.map((x) => x.perf.flashlight && x.perf.flashlight.score)),
          // min–max of the runs behind each median: the noise a difference has to beat
          range: { score: range(scores), p95: range(p95s), jank: range(janks), startMs: range(starts) },
          rescored: rs.filter((x) => x.perf.formula !== SCORE_FORMULA).length,
          runs: rs.length, lastRunId: rs[0].id, lastAt: rs[0].startedAt
        };
        if (!sections.has(it.section)) sections.set(it.section, { name: it.section, items: [] });
        sections.get(it.section).items.push(item);
      }
      const secs = [...sections.values()].map((s) => {
        const n = s.items.length;
        const mean = (f) => Math.round(s.items.reduce((a, x) => a + f(x), 0) / n);
        return {
          ...s,
          score: mean((x) => x.score),
          range: [mean((x) => (x.range.score ? x.range.score[0] : x.score)), mean((x) => (x.range.score ? x.range.score[1] : x.score))],
          minRuns: Math.min(...s.items.map((x) => x.runs)),
          items: s.items.sort((a, b) => a.name.localeCompare(b.name) || String(a.variant).localeCompare(String(b.variant)))
        };
      }).sort((a, b) => a.name.localeCompare(b.name));
      builds.push({
        key: B.key, apk: B.apk, version: B.version, versionCode: B.versionCode, apkMd5: B.apkMd5, lastAt: B.lastAt,
        total: secs.reduce((a, s) => a + s.score, 0), max: secs.length * 100,
        range: [secs.reduce((a, s) => a + s.range[0], 0), secs.reduce((a, s) => a + s.range[1], 0)],
        minRuns: secs.length ? Math.min(...secs.map((s) => s.minRuns)) : 0,
        runs: [...B.items.values()].reduce((a, it) => a + it.runs.length, 0), sections: secs
      });
    }
    builds.sort((a, b) => b.lastAt.localeCompare(a.lastAt));
    out.push({ key: D.key, name: D.name, emulator: D.emulator, chip: D.chip, builds, lastAt: builds[0] ? builds[0].lastAt : '' });
  }
  // phones first, newest first
  out.sort((a, b) => (a.emulator - b.emulator) || b.lastAt.localeCompare(a.lastAt));
  return { devices: out, sections: [...new Set(out.flatMap((d) => d.builds.flatMap((b) => b.sections.map((s) => s.name))))].sort(), formula: SCORE_FORMULA };
}

module.exports = { summarize, deviceOf, buildOf, runScore };
