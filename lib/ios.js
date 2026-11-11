'use strict';
// iOS simulators through `xcrun simctl` (macOS only). The screen itself is driven by Maestro: this
// covers what the runner needs around a flow — launching, links, screenshots, the device list.
// Written without a Mac at hand: the commands are simctl's documented ones, check on first use.
const { execFile } = require('node:child_process');
const fs = require('node:fs');

function run(args, { timeoutMs = 30000, binary = false } = {}) {
  return new Promise((resolve, reject) => {
    execFile('xcrun', ['simctl', ...args], { timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024, encoding: binary ? 'buffer' : 'utf8' },
      (err, stdout, stderr) => {
        if (err) { err.message = `xcrun simctl ${args.join(' ')}: ${err.message}${stderr ? ' — ' + String(stderr).trim() : ''}`; return reject(err); }
        resolve(stdout);
      });
  });
}

// booted simulators → [{ serial: udid, name, platform: 'ios' }]
async function devices() {
  if (process.platform !== 'darwin') return [];
  try {
    const j = JSON.parse(await run(['list', 'devices', 'booted', '-j']));
    return Object.values(j.devices || {}).flat().filter((d) => d.state === 'Booted').map((d) => ({ serial: d.udid, name: d.name, platform: 'ios' }));
  } catch { return []; }
}

class IosDevice {
  constructor({ serial }) {
    this.serial = serial;
    this.platform = 'ios';
  }

  async launch(bundleId, _activity, { clear = false } = {}) {
    await run(['terminate', this.serial, bundleId]).catch(() => {});
    // simctl has no «clear app data»: reinstalling the app is the equivalent (needs the .app path)
    if (clear) throw new Error('iOS: clearing app data is done by Maestro (launchApp clearState) — set the Maestro engine');
    await run(['launch', this.serial, bundleId], { timeoutMs: 40000 });
  }

  async openLink(_bundleId, url) {
    await run(['openurl', this.serial, url], { timeoutMs: 40000 });
  }

  async screenshot(file) {
    await run(['io', this.serial, 'screenshot', file], { timeoutMs: 20000 });
    if (!fs.existsSync(file)) throw new Error('screenshot not taken');
  }

  async install(appPath) {
    return run(['install', this.serial, appPath], { timeoutMs: 180000 });
  }

  // not available without a UI-tree source: the adb driver's screen steps go to Maestro on iOS
  async nodes() { throw new Error('iOS: only Maestro reads the screen tree — the adb driver cannot run this step'); }
  async screenText() { return []; }
  async tap() { throw new Error('iOS: taps only through Maestro'); }
  async typeText() { throw new Error('iOS: typing only through Maestro'); }
  async key() { throw new Error('iOS: keys only through Maestro'); }
  async swipe() { throw new Error('iOS: swipes only through Maestro'); }
  async shell() { return ''; }
  async clearLogcat() {}
  async logcat() { return ''; }
  async takeNetLog() { return ''; }
}

module.exports = { IosDevice, devices };
