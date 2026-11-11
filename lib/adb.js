'use strict';
// Thin adb wrapper: device selection, UI tree, taps, text, screenshots, logcat.
const { execFile, spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function run(adbPath, args, { timeoutMs = 30000, binary = false } = {}) {
  return new Promise((resolve, reject) => {
    execFile(adbPath, args, { timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024, encoding: binary ? 'buffer' : 'utf8', windowsHide: true },
      (err, stdout, stderr) => {
        if (err) {
          // no adb at that path is the user's setup, not a server fault: say what to do and answer 409, not 500
          if (err.code === 'ENOENT') {
            const e = new Error(`adb not found at "${adbPath}" — install the Android SDK platform-tools or set the adb path in the settings`);
            e.status = 409; e.code = 'ENOENT';
            return reject(e);
          }
          err.message = `adb ${args.join(' ')}: ${err.message}${stderr ? ' — ' + String(stderr).trim() : ''}`;
          return reject(err);
        }
        resolve(stdout);
      });
  });
}

// Where an Android SDK tool ('adb', 'emulator') lives. A pure function of the platform, the environment and an
// exists-check, so the Mac and Linux answers can be checked from any host. Order: ANDROID_HOME →
// ANDROID_SDK_ROOT → the platform's standard SDK folder → the tool on PATH → the bare name (left to PATH at run time).
// An explicit adbPath / emulatorPath in the settings wins over this default.
const SDK_SUBDIR = { adb: 'platform-tools', emulator: 'emulator' };
function sdkTool(tool, { platform = process.platform, env = process.env, exists = fs.existsSync, home = os.homedir() } = {}) {
  const win = platform === 'win32';
  const p = win ? path.win32 : path.posix;
  const file = win ? tool + '.exe' : tool;
  const roots = [env.ANDROID_HOME, env.ANDROID_SDK_ROOT];
  if (win) roots.push(env.LOCALAPPDATA && p.join(env.LOCALAPPDATA, 'Android', 'Sdk'));
  else if (platform === 'darwin') roots.push(home && p.join(home, 'Library', 'Android', 'sdk'));
  else roots.push(home && p.join(home, 'Android', 'Sdk'));
  for (const r of roots) {
    if (!r) continue;
    const f = p.join(r, SDK_SUBDIR[tool] || '', file);
    if (exists(f)) return f;
  }
  // Windows names the variable Path; process.env ignores the case there, a plain object does not
  const PATH = env.PATH || env.Path || '';
  for (const dir of PATH.split(win ? ';' : ':')) {
    if (!dir) continue;
    const f = p.join(dir.replace(/^"|"$/g, ''), file);
    if (exists(f)) return f;
  }
  return file;
}

// Puts text on the host clipboard (the emulator mirrors it into the guest). Windows: PowerShell, with base64
// keeping the text out of the console code page; macOS: pbcopy; Linux: wl-copy (Wayland), else xclip (X11).
// The text goes through stdin, never through a command line.
function clipboardCommands(platform = process.platform) {
  if (platform === 'win32') return [];
  if (platform === 'darwin') return [['pbcopy', []]];
  return [['wl-copy', []], ['xclip', ['-selection', 'clipboard']]];
}
function hostClipboard(text) {
  if (process.platform === 'win32') {
    const b64 = Buffer.from(text, 'utf8').toString('base64');
    const cmd = `Set-Clipboard -Value ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64}')))`;
    return new Promise((resolve, reject) => {
      const ps = spawn('powershell.exe', ['-NoProfile', '-Command', cmd], { windowsHide: true, stdio: 'ignore' });
      ps.on('error', reject);
      ps.on('exit', (code) => (code === 0 ? resolve() : reject(new Error('could not put the text on the clipboard'))));
    });
  }
  const tryOne = ([bin, args]) => new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ['pipe', 'ignore', 'ignore'] });
    child.on('error', reject);
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${bin} exited with ${code}`))));
    child.stdin.end(text, 'utf8');
  });
  return clipboardCommands().reduce((p, c) => p.catch(() => tryOne(c)), Promise.reject(new Error('none')))
    .catch(() => { throw new Error(`could not put non-ASCII text on the clipboard: install ${process.platform === 'darwin' ? 'pbcopy' : 'wl-clipboard or xclip'}`); });
}

async function devices(adbPath) {
  const out = await run(adbPath, ['devices']);
  return out.split(/\r?\n/).slice(1)
    .map((l) => l.trim().split(/\s+/))
    .filter((p) => p.length >= 2 && p[1] === 'device')
    .map((p) => p[0]);
}

function decode(s) {
  return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#10;/g, '\n').replace(/&amp;/g, '&');
}

function parseNodes(xml) {
  const nodes = [];
  const re = /<node\b([^>]*?)\/?>/g;
  let m;
  while ((m = re.exec(xml))) {
    const attrs = {};
    m[1].replace(/([\w-]+)="([^"]*)"/g, (_, k, v) => { attrs[k] = decode(v); return ''; });
    const b = /\[(\d+),(\d+)\]\[(\d+),(\d+)\]/.exec(attrs.bounds || '');
    if (!b) continue;
    const [x1, y1, x2, y2] = b.slice(1).map(Number);
    nodes.push({
      text: attrs.text || '',
      desc: attrs['content-desc'] || '',
      id: attrs['resource-id'] || '',
      clickable: attrs.clickable === 'true',
      focused: attrs.focused === 'true',
      cls: attrs.class || '',
      x: Math.round((x1 + x2) / 2), y: Math.round((y1 + y2) / 2),
      w: x2 - x1, h: y2 - y1
    });
  }
  return nodes;
}

class Device {
  constructor({ adbPath, serial }) {
    this.adbPath = adbPath;
    this.serial = serial;
    this.platform = 'android'; // the runner's ANR guard and screen choice read it, like IosDevice / WebDevice's
  }

  adb(args, opts) {
    return run(this.adbPath, ['-s', this.serial, ...args], opts);
  }

  shell(cmd, opts) {
    return this.adb(['shell', cmd], opts);
  }

  async dumpUi() {
    let lastErr;
    for (let i = 0; i < 3; i++) {
      try {
        const out = await this.adb(['exec-out', 'uiautomator', 'dump', '/dev/tty'], { timeoutMs: 20000 });
        const end = out.lastIndexOf('</hierarchy>');
        if (end > 0) return out.slice(out.indexOf('<?xml') >= 0 ? out.indexOf('<?xml') : 0, end + '</hierarchy>'.length);
        lastErr = new Error('empty screen dump: ' + out.trim().slice(0, 200));
      } catch (e) {
        lastErr = e;
      }
      await sleep(700);
    }
    throw lastErr;
  }

  async nodes() {
    return parseNodes(await this.dumpUi());
  }

  async screenText() {
    return (await this.nodes()).map((n) => n.text || n.desc).filter(Boolean);
  }

  async tap(x, y) {
    await this.shell(`input tap ${x} ${y}`);
  }

  async typeText(text) {
    // `input text` only takes ASCII, and masked fields drop characters typed in one burst,
    // so ASCII goes one character at a time; anything else is pasted through the host
    // clipboard, which the emulator mirrors into the guest.
    if (/[^\x20-\x7e]/.test(text)) return this.pasteText(text);
    for (const ch of text) {
      // inside the device shell's double quotes only $ ` " \ are special; a backslash before anything else
      // (`\(`, `\!`) reaches `input text` and is typed
      const arg = ch === ' ' ? '%s' : ch.replace(/([\\"`$])/g, '\\$1');
      await this.shell(`input text "${arg}"`);
      await sleep(120);
    }
  }

  async pasteText(text) {
    await hostClipboard(text);
    await sleep(800);
    await this.key(279); // KEYCODE_PASTE
    await sleep(400);
  }

  async key(code) {
    await this.shell(`input keyevent ${code}`);
  }

  async screenSize() {
    if (this._size) return this._size;
    const size = await this.shell('wm size');
    const m = /(\d+)x(\d+)/.exec(size.split('\n').pop() || size) || /(\d+)x(\d+)/.exec(size);
    this._size = { w: m ? Number(m[1]) : 1080, h: m ? Number(m[2]) : 2400 };
    return this._size;
  }

  // up/down scroll the screen; left/right swipe a row at height `atY` (e.g. to reveal row actions).
  // `fast` is a fling: a short stroke over most of the screen, the load test for lists.
  async swipe(direction, atY, { fast = false, durationMs } = {}) {
    const { w, h } = await this.screenSize();
    const ms = Number(durationMs) || (fast ? 80 : 300);
    if (direction === 'left' || direction === 'right') {
      const y = Math.round(atY || h / 2);
      const [x1, x2] = direction === 'left' ? [w * 0.85, w * 0.2] : [w * 0.2, w * 0.85];
      await this.shell(`input swipe ${Math.round(x1)} ${y} ${Math.round(x2)} ${y} ${ms}`);
      return;
    }
    const cx = Math.round(w / 2);
    const [lo, hi] = fast ? [0.2, 0.85] : [0.3, 0.75];
    const [y1, y2] = direction === 'up' ? [h * lo, h * hi] : [h * hi, h * lo];
    await this.shell(`input swipe ${cx} ${Math.round(y1)} ${cx} ${Math.round(y2)} ${ms}`);
  }

  async openLink(pkg, url) {
    await this.shell(`am start -W -a android.intent.action.VIEW -d "${url.replace(/"/g, '')}" ${pkg}`, { timeoutMs: 40000 });
  }

  async screenshot(file) {
    const buf = await this.adb(['exec-out', 'screencap', '-p'], { binary: true, timeoutMs: 20000 });
    fs.writeFileSync(file, buf);
  }

  // returns `am start -W`'s report: LaunchState and TotalTime (process start → first frame)
  async launch(pkg, activity, { clear = false } = {}) {
    await this.shell(`am force-stop ${pkg}`);
    if (clear) {
      try {
        await this.shell(`pm clear ${pkg}`);
      } catch (e) {
        // MIUI/HyperOS lets adb clear app data only with «USB debugging (Security settings)» on
        if (/CLEAR_APP_USER_DATA|SecurityException/.test(e.message)) throw new Error('the phone does not allow clearing app data over adb. On Xiaomi/POCO turn on "Developer options → USB debugging (Security settings)" (it asks for a Mi account) — or run scenarios without "cleared data" on it: they do not touch the app sign-in');
        throw e;
      }
    }
    return this.shell(`am start -W -n ${pkg}/${activity}`, { timeoutMs: 40000 });
  }

  // ---- measurement (lib/perf.js) ----
  async pid(pkg) {
    return (await this.shell(`pidof ${pkg}`).catch(() => '')).trim().split(/\s+/)[0] || '';
  }

  framestats(pkg) {
    return this.shell(`dumpsys gfxinfo ${pkg} framestats`, { timeoutMs: 15000 });
  }

  gfxReset(pkg) {
    return this.shell(`dumpsys gfxinfo ${pkg} reset`).catch(() => '');
  }

  // memory pages and per-thread CPU ticks of the process, in one round trip
  procStat(pid) {
    return this.shell(`cat /proc/${pid}/statm; echo ---; cat /proc/${pid}/task/*/stat`);
  }

  async appVersion(pkg) {
    const out = await this.shell(`dumpsys package ${pkg}`);
    const name = /versionName=(\S+)/.exec(out), code = /versionCode=(\d+)/.exec(out);
    return { versionName: name ? name[1] : undefined, versionCode: code ? Number(code[1]) : undefined };
  }

  // what the numbers were measured on; `emulator` says whether they describe a phone at all
  async info() {
    const props = ['ro.product.manufacturer', 'ro.product.model', 'ro.soc.manufacturer', 'ro.soc.model', 'ro.product.cpu.abi', 'ro.build.version.sdk', 'ro.build.version.release', 'ro.kernel.qemu', 'ro.product.marketname', 'ro.board.platform', 'ro.hardware'];
    const out = await this.shell(props.map((p) => `getprop ${p}`).join('; ') + "; getconf CLK_TCK; getconf PAGESIZE; nproc; dumpsys display | grep -m1 -o 'fps=[0-9.]*'");
    const l = out.split(/\r?\n/).map((x) => x.trim());
    const fps = /fps=([\d.]+)/.exec(out);
    return {
      manufacturer: l[0], model: l[8] || l[1], device: l[1], soc: [l[2], l[3]].filter(Boolean).join(' '), socModel: l[3], platform: l[9], hardware: l[10],
      abi: l[4], sdk: Number(l[5]) || undefined, android: l[6],
      emulator: l[7] === '1', clkTck: Number(l[11]) || 100, pageSize: Number(l[12]) || 4096, cores: Number(l[13]) || undefined,
      refreshHz: fps ? Math.round(Number(fps[1])) : undefined
    };
  }

  async clearLogcat() {
    await this.adb(['logcat', '-c']).catch(() => {});
  }

  async logcat(pkg, lines = 150) {
    const pid = (await this.shell(`pidof ${pkg}`).catch(() => '')).trim().split(/\s+/)[0];
    const args = ['logcat', '-d', '-t', String(lines), '-v', 'time'];
    if (pid) args.push(`--pid=${pid}`);
    return (await this.adb(args).catch((e) => e.message)).trim();
  }

  // The app's network log since the last call, then cleared so the next step starts empty.
  async takeNetLog(tag) {
    if (!tag) return '';
    const out = await this.adb(['logcat', '-d', '-v', 'epoch', '-s', tag + ':D'], { timeoutMs: 30000 }).catch(() => '');
    await this.clearLogcat();
    return out;
  }

  async install(apkPath) {
    return this.adb(['install', '-r', '-d', apkPath], { timeoutMs: 180000 });
  }
}

// resolves once the emulator process has started; rejects when it cannot start (a wrong path: ENOENT).
// The no-op listener stays so an 'error' after that can never take the console down.
function startEmulator(emulatorPath, avd) {
  return new Promise((resolve, reject) => {
    let child;
    try { child = spawn(emulatorPath, ['-avd', avd], { detached: true, stdio: 'ignore', windowsHide: true }); } catch (e) { return reject(e); }
    child.on('error', () => {});
    child.once('error', (e) => reject(new Error(`could not start the emulator (${emulatorPath}): ${e.message}`)));
    child.once('spawn', () => { child.unref(); resolve(child.pid); });
  });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// Wi-Fi debugging (Android 11+): `adb pair host:port code` once, then `adb connect host:port`; the connect
// port is a different one, shown on the phone's main «Wireless debugging» screen or found over mDNS.
async function pair(adbPath, address, code) {
  return run(adbPath, ['pair', address, code], { timeoutMs: 30000 });
}
async function connect(adbPath, address) {
  return run(adbPath, ['connect', address], { timeoutMs: 20000 });
}
async function disconnect(adbPath, address) {
  return run(adbPath, ['disconnect', address], { timeoutMs: 10000 }).catch((e) => e.message);
}
// phones advertising their connect port on this network: [{ name, address }]
async function mdnsConnectable(adbPath) {
  const out = await run(adbPath, ['mdns', 'services'], { timeoutMs: 10000 }).catch(() => '');
  return out.split(/\r?\n/).map((l) => l.trim().split(/\s+/)).filter((p) => p.length >= 3 && /_adb-tls-connect/.test(p[1])).map((p) => ({ name: p[0], address: p[2] }));
}

module.exports = { sdkTool, Device, devices, parseNodes, startEmulator, sleep, run, pair, connect, disconnect, mdnsConnectable };
