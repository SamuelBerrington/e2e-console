'use strict';
// Maestro as the UI driver: our screen steps become Maestro commands, consecutive screen steps run
// as one flow (the CLI costs ~15 s to start), and Maestro's per-command report is mapped back to steps.
// Backend checks, seller actions and log joins stay ours and run between the flows.
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const YAML = require('yaml');

const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// Prices are «1 250 ₽» with a no-break/narrow space; Java's \s does not cover those (11-06).
const spaces = (s) => s.replace(/\s+/g, '[\\s\\u00A0\\u202F]+');
const exact = (s) => spaces(esc(s));
const contains = (s) => '(?s).*' + spaces(esc(s)) + '.*';

// Waits that pass after `ms` whatever the screen shows: Maestro has no plain sleep.
const pause = (ms) => ({ extendedWaitUntil: { visible: { text: '__e2e_never__' }, timeout: Math.round(ms), optional: true } });
// Android's «приложение не отвечает» dialog: tap «Подождать» if it is up.
const anrGuard = () => ({ runFlow: { when: { visible: { text: 'Подождать|Wait' } }, commands: [{ tapOn: { text: 'Подождать|Wait' } }] } });

// One element by our rules: the exact text (or description, or id) first, then text containing it.
function tapCommands(target, { timeout = 10, optional = false, double = false, fallback = null, byId = false } = {}) {
  const tap = double ? 'doubleTapOn' : 'tapOn';
  if (byId || /^[\w.]+:id\/\w+$/.test(target)) {
    const id = { id: esc(target) };
    return [{ extendedWaitUntil: { visible: id, timeout: timeout * 1000, ...(optional ? { optional: true } : {}) } },
      { runFlow: { when: { visible: id }, commands: [{ [tap]: id }] } }];
  }
  const wait = { extendedWaitUntil: { visible: { text: contains(target) }, timeout: timeout * 1000, ...(optional || fallback ? { optional: true } : {}) } };
  // One decision, not two independent conditions: after the exact tap the next screen is up, and a
  // second «is it visible?» check would look at that screen (11-06, «Оформить заказ»). The flag in
  // Maestro's output says whether a tap already happened.
  const done = { evalScript: '${output.e2eTapped = true}' };
  const cmds = [
    { evalScript: '${output.e2eTapped = false}' },
    wait,
    { runFlow: { when: { visible: { text: exact(target) } }, commands: [{ [tap]: { text: exact(target) } }, done] } },
    { runFlow: { when: { true: '${!output.e2eTapped}', visible: { text: contains(target) } }, commands: [{ [tap]: { text: contains(target) } }, done] } }
  ];
  // WebView content is not always in the tree: tap the known point instead.
  if (fallback) cmds.push({ runFlow: { when: { true: '${!output.e2eTapped}' }, commands: [{ tapOn: { point: `${fallback[0]},${fallback[1]}` } }] } });
  // A mandatory tap fails on the wait when the element never shows; an optional one is a no-op.
  return cmds;
}

// Our step → Maestro commands, or null when Maestro cannot express it (then the adb driver runs it).
// Values are already substituted.
function appIdOf(s, platform) {
  return platform === 'ios' ? (s.bundleId || s.package) : s.package;
}
function toCommands(step, s, platform = 'android') {
  switch (step.type) {
    case 'launch':
      return [{ launchApp: { appId: appIdOf(s, platform), ...(step.clear ? { clearState: true } : {}), stopApp: true } },
        pause((Number(step.settle) || 3) * 1000), anrGuard()];
    case 'tap':
      if (step.dx || step.dy) return null; // offset from an element: Maestro taps elements or absolute points only
      return [...tapCommands(step.target, { timeout: Number(step.timeout) || 10, optional: !!step.optional, double: !!step.double, fallback: step.fallback, byId: step.by === 'id' }),
        pause(step.after != null ? Number(step.after) * 1000 : 800)];
    case 'type': {
      const cmds = [];
      if (step.target) cmds.push(...tapCommands(step.target, { timeout: Number(step.timeout) || 10, byId: step.by === 'id' }));
      if (step.clear !== false) cmds.push({ eraseText: 40 });
      cmds.push({ inputText: String(step.text ?? '') });
      if (step.enter) cmds.push({ pressKey: 'Enter' });
      return cmds;
    }
    case 'swipe': {
      const dir = step.direction || 'down';
      // Maestro swipes a row from its text's centre, too short to reveal the cart's «Удалить» (11-06);
      // adb swipes the whole row width at the text's height. Flings and series are adb's too.
      if ((dir === 'left' || dir === 'right') && step.target) return null;
      if (step.fast || Number(step.times) > 1 || step.duration) return null;
      // "down" scrolls the content down: the finger moves up.
      return [{ swipe: { direction: { down: 'UP', up: 'DOWN', left: 'LEFT', right: 'RIGHT' }[dir] } }, pause(800)];
    }
    case 'link':
      // Maestro's openLink goes through the system chooser on Android; adb targets the package directly
      return platform === 'ios' ? [{ openLink: step.url }, pause((Number(step.settle) || 4) * 1000)] : null;
    case 'back':
      return ['back', pause(600)];
    case 'wait':
      return [pause((Number(step.seconds) || 1) * 1000)];
    case 'assertText': {
      if (step.count != null) return null; // Maestro has no element count
      const byId = step.id || step.by === 'id';
      // a regex of ours is "somewhere in the text"; Maestro's selectors match the whole text
      const sel = byId ? { id: esc(step.id || step.text) } : step.regex ? { text: '(?s).*(' + step.text + ').*' } : { text: contains(step.text) };
      return [{ extendedWaitUntil: { [step.absent ? 'notVisible' : 'visible']: sel, timeout: (Number(step.timeout) || 10) * 1000 } }];
    }
    case 'maestro':
      return rawCommands(step);
    default:
      return null;
  }
}

function rawCommands(step) {
  if (Array.isArray(step.commands)) return step.commands;
  if (typeof step.yaml === 'string' && step.yaml.trim()) {
    const parsed = YAML.parse(step.yaml);
    return Array.isArray(parsed) ? parsed : [parsed];
  }
  return [];
}

// {{var}} and ${var} inside raw Maestro commands, before they are written to the flow.
function substDeep(value, fn) {
  if (typeof value === 'string') return fn(value);
  if (Array.isArray(value)) return value.map((v) => substDeep(v, fn));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, substDeep(v, fn)]));
  return value;
}

// ---------- locating the CLI and a Java it accepts ----------
// A JDK folder: java under bin/, or under Contents/Home on macOS (/Library/Java/JavaVirtualMachines/*.jdk)
function jdkHome(dir) {
  const java = process.platform === 'win32' ? 'java.exe' : 'java';
  if (!dir) return '';
  if (fs.existsSync(path.join(dir, 'bin', java))) return dir;
  const mac = path.join(dir, 'Contents', 'Home');
  return fs.existsSync(path.join(mac, 'bin', java)) ? mac : '';
}
function findJavaHome(configured) {
  if (jdkHome(configured)) return jdkHome(configured);
  if (jdkHome(process.env.JAVA_HOME) && !/1\.8|jre1?8|jdk1?8/i.test(process.env.JAVA_HOME)) return jdkHome(process.env.JAVA_HOME);
  // Gradle's provisioned toolchains (17+) are on most dev boxes; Android Studio's bundled JBR; the system JDKs.
  const home = os.homedir();
  const roots = [path.join(home, '.gradle', 'jdks'), path.join(home, '.jdks')];
  if (process.platform === 'win32') roots.push(path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Android', 'Android Studio', 'jbr'));
  else if (process.platform === 'darwin') roots.push('/Applications/Android Studio.app/Contents/jbr', path.join(home, 'Library', 'Java', 'JavaVirtualMachines'), '/Library/Java/JavaVirtualMachines', '/opt/homebrew/opt/openjdk', '/usr/local/opt/openjdk');
  else roots.push('/opt/android-studio/jbr', path.join(home, 'android-studio', 'jbr'), '/usr/lib/jvm');
  const major = (d) => Number((/(?:jdk|jbr|openjdk|java|-)-?(\d+)/i.exec(path.basename(d.replace(/[\\/]Contents[\\/]Home$/, ''))) || [])[1]) || 0;
  for (const r of roots) {
    if (jdkHome(r)) return jdkHome(r);
    if (!fs.existsSync(r)) continue;
    let entries = [];
    try { entries = fs.readdirSync(r); } catch { continue; }
    const dirs = entries.map((d) => jdkHome(path.join(r, d))).filter((d) => d && major(d) !== 8)
      .sort((a, b) => major(b) - major(a));
    if (dirs.length) return dirs[0];
  }
  return '';
}
// a file on PATH (Homebrew and the curl installer put maestro there on macOS / Linux)
function onPath(file) {
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    const f = dir && path.join(dir.replace(/^"|"$/g, ''), file);
    if (f && fs.existsSync(f)) return f;
  }
  return '';
}
function findMaestro(configured) {
  const exe = process.platform === 'win32' ? 'maestro.bat' : 'maestro';
  const candidates = [configured, path.join(os.homedir(), '.maestro', 'maestro', 'bin', exe), path.join(os.homedir(), '.maestro', 'bin', exe), onPath(exe)];
  return candidates.find((p) => p && fs.existsSync(p)) || '';
}

// Run variables reach Maestro through the child's environment, never through its command line: on Windows the
// CLI is a .bat, so cmd.exe would parse every `-e K=v` and run `&`, `|`, `%…%` in a value as host commands.
// Maestro injects every environment variable named MAESTRO_* into the flow under that same name, so the
// flow's header maps each original name onto one: `PAY_URL: ${MAESTRO_E2E_V0}`. Numbered names, because
// Windows environment names ignore case. Maestro drops empty variables, so an empty value is written as ''.
const ENV_PREFIX = 'MAESTRO_E2E_V';
function flowEnv(vars) {
  const header = {}, childEnv = {};
  let n = 0;
  for (const [k, v] of Object.entries(vars || {})) {
    if (!/^[A-Za-z_]\w*$/.test(k) || v == null || typeof v === 'object') continue;
    const s = String(v);
    if (s === '') { header[k] = ''; continue; }
    const name = ENV_PREFIX + n++;
    childEnv[name] = s;
    header[k] = '${' + name + '}';
  }
  return { header, childEnv };
}

// What still goes on the command line (the CLI path, flags, the device serial) is quoted for cmd.exe. Inside
// "…" cmd takes & | < > ^ literally, but still expands %…% and cannot escape a quote, so those are refused.
function cmdLine(bin, args) {
  for (const a of [bin, ...args]) {
    // a trailing backslash would escape the closing quote for the CLI's own argument parser
    if (/["%\r\n]|\\$/.test(String(a))) throw new Error(`cannot pass ${JSON.stringify(String(a))} to Maestro safely through cmd.exe (a quote, % or line break)`);
  }
  return [bin, ...args].map((a) => `"${a}"`).join(' ');
}
function resolve(settings) {
  const m = settings.maestro || {};
  return { bin: findMaestro(m.path), javaHome: findJavaHome(m.javaHome) };
}

function exec(settings, args, { cwd, timeoutMs = 15 * 60 * 1000, onLine, isStopped, extraEnv = {} } = {}) {
  const { bin, javaHome } = resolve(settings);
  if (!bin) return Promise.reject(new Error('Maestro not found: set the path in the settings (usually ~/.maestro/maestro/bin/maestro.bat)'));
  if (!javaHome) return Promise.reject(new Error('Maestro needs Java 17+: set JAVA_HOME in the settings'));
  const env = { ...process.env, JAVA_HOME: javaHome, MAESTRO_CLI_NO_ANALYTICS: '1', MAESTRO_CLI_ANALYSIS_NOTIFICATION_DISABLED: 'true', MAESTRO_DISABLE_UPDATE_CHECK: 'true' };
  // leftovers from a parent console must not leak into this flow's variables
  for (const k of Object.keys(env)) if (k.toUpperCase().startsWith(ENV_PREFIX)) delete env[k];
  Object.assign(env, extraEnv);
  // an adbPath that is a bare name (found on PATH at run time) adds no folder
  const adbDir = path.isAbsolute(settings.adbPath || '') ? path.dirname(settings.adbPath) : '';
  // one PATH key: a copied Windows environment spells it Path, and a second spelling makes the child's PATH a coin toss
  const pathKey = Object.keys(env).find((k) => k.toUpperCase() === 'PATH') || 'PATH';
  env[pathKey] = [path.join(javaHome, 'bin'), adbDir, env[pathKey] || ''].filter(Boolean).join(path.delimiter);
  const isWin = process.platform === 'win32';
  let line;
  try { line = isWin ? cmdLine(bin, args) : null; } catch (e) { return Promise.reject(e); }
  return new Promise((resolveP) => {
    const child = isWin
      ? spawn('cmd.exe', ['/d', '/s', '/c', `"${line}"`], { cwd, env, windowsHide: true, windowsVerbatimArguments: true })
      : spawn(bin, args, { cwd, env });
    let out = '';
    const take = (buf) => {
      const t = buf.toString('utf8');
      out += t;
      if (onLine) t.split(/\r?\n/).filter(Boolean).forEach(onLine);
    };
    child.stdout.on('data', take);
    child.stderr.on('data', take);
    const timer = setTimeout(() => kill(child), timeoutMs);
    const stopPoll = setInterval(() => { if (isStopped && isStopped()) kill(child); }, 500);
    child.on('close', (code) => { clearTimeout(timer); clearInterval(stopPoll); resolveP({ code, out }); });
    child.on('error', (e) => { clearTimeout(timer); clearInterval(stopPoll); resolveP({ code: -1, out: out + '\n' + e.message }); });
  });
}
function kill(child) {
  if (process.platform === 'win32') spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true });
  else child.kill('SIGTERM');
}

async function version(settings) {
  const r = await exec(settings, ['--version'], { timeoutMs: 120000 });
  // the JVM prints warnings with their own numbers first; the version is a line of its own
  const v = r.out.split(/\r?\n/).map((l) => l.trim()).filter((l) => /^\d+\.\d+\.\d+$/.test(l)).pop();
  if (!v) throw new Error('Maestro does not answer: ' + r.out.trim().slice(-300));
  return v;
}

// Runs one flow made of groups (one group per step) and says how each group ended.
// groups: [{ key, commands, screenshot }]; returns [{ key, status, startedAt, ms, error, screenshot }]
async function runGroups({ settings, serial, dir, name, groups, env = {}, isStopped, onLine, platform = 'android' }) {
  const work = path.join(dir, 'maestro', name);
  fs.rmSync(work, { recursive: true, force: true });
  fs.mkdirSync(work, { recursive: true });
  const commands = [];
  const owner = []; // top-level command index → group index
  groups.forEach((g, gi) => {
    for (const c of g.commands) { commands.push(c); owner.push(gi); }
    if (g.screenshot) { commands.push({ takeScreenshot: `shot-${g.key}` }); owner.push(gi); }
  });
  const vars = flowEnv(env);
  const header = { appId: appIdOf(settings, platform), name, ...(Object.keys(vars.header).length ? { env: vars.header } : {}) };
  const flow = YAML.stringify(header) + '---\n' + YAML.stringify(commands, { lineWidth: 0, aliasDuplicateObjects: false });
  // scripts that raw runScript commands point at, relative to the flow
  for (const g of groups) {
    for (const [rel, content] of Object.entries(g.files || {})) {
      const target = path.resolve(work, rel);
      if (!target.startsWith(path.resolve(work) + path.sep)) continue;
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, content);
    }
  }
  const flowFile = path.join(work, 'flow.yaml');
  fs.writeFileSync(flowFile, flow);
  const args = ['--device', serial, 'test', 'flow.yaml', '--debug-output', 'debug', '--flatten-debug-output', '--no-ansi'];
  const res = await exec(settings, args, { cwd: work, isStopped, onLine, extraEnv: vars.childEnv });
  fs.writeFileSync(path.join(work, 'maestro.out.txt'), res.out);

  // The report lands in debug/<flow name>/ whatever --flatten-debug-output says.
  const reportDir = [path.join(work, 'debug', name), path.join(work, 'debug')].find((d) => fs.existsSync(path.join(d, 'commands.json')));
  let report = [];
  try { report = JSON.parse(fs.readFileSync(path.join(reportDir, 'commands.json'), 'utf8')); } catch { /* the CLI died before writing it */ }
  const top = report.filter((c) => c.metadata && c.metadata.depth === 0
    && !c.command.defineVariablesCommand && !c.command.applyConfigurationCommand);
  const results = groups.map((g) => ({ key: g.key, status: 'skipped' }));
  top.forEach((c, i) => {
    const gi = owner[i];
    if (gi === undefined) return;
    const r = results[gi];
    const m = c.metadata;
    if (!r.startedAt) r.startedAt = new Date(m.timestamp).toISOString();
    r.ms = (r.ms || 0) + (m.duration || 0);
    const evaluated = m.evaluatedCommand ? Object.values(m.evaluatedCommand)[0] : null;
    // An optional command (our pauses, «если есть» taps) may fail without failing the step.
    if (m.status === 'FAILED' && !(evaluated && evaluated.optional)) { r.status = 'failed'; r.error = (m.error && m.error.message) || 'Maestro: the command failed'; }
    else if (r.status !== 'failed') r.status = 'passed';
    const shot = (m.artifacts || []).find((a) => a.type === 'TAKE_SCREENSHOT');
    if (shot) r.screenshot = path.join(reportDir, shot.path);
  });
  // A group whose last command never ran did not finish.
  let seen = 0;
  groups.forEach((g, gi) => {
    const n = owner.filter((o) => o === gi).length;
    const done = top.slice(seen, seen + n).length;
    if (results[gi].status === 'passed' && done < n) results[gi].status = 'failed', results[gi].error = results[gi].error || 'Maestro stopped in the middle of the step';
    seen += n;
  });
  if (!top.length && res.code !== 0) {
    const tail = res.out.split(/\r?\n/).filter((l) => l.trim() && !/WARNING|╭|╰|│/.test(l)).slice(-6).join('\n');
    results[0].status = 'failed';
    results[0].error = 'Maestro did not start: ' + tail;
  }
  return { results, code: res.code, flowFile, out: res.out };
}

module.exports = { toCommands, rawCommands, substDeep, runGroups, version, resolve, contains, exact, appIdOf, flowEnv, cmdLine };
