'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { sdkTool, parseNodes, parseTouchPanel, pinchEvents, Device } = require('../../lib/adb');

const W = (s) => s.split('/').join('\\');
const only = (...files) => (f) => files.includes(f);

test('sdkTool on win32: ANDROID_HOME first, .exe added', () => {
  const env = { ANDROID_HOME: W('D:/sdk'), ANDROID_SDK_ROOT: W('E:/sdk'), LOCALAPPDATA: W('C:/L') };
  const exists = only(W('D:/sdk/platform-tools/adb.exe'), W('E:/sdk/platform-tools/adb.exe'), W('C:/L/Android/Sdk/platform-tools/adb.exe'));
  assert.equal(sdkTool('adb', { platform: 'win32', env, exists, home: W('C:/Users/u') }), W('D:/sdk/platform-tools/adb.exe'));
});

test('sdkTool on win32: ANDROID_SDK_ROOT, then the LOCALAPPDATA SDK, then Path, then the bare name', () => {
  const env = { ANDROID_HOME: W('D:/missing'), ANDROID_SDK_ROOT: W('E:/sdk'), LOCALAPPDATA: W('C:/L'), Path: W('C:/Windows;"C:/tools/pt"') };
  const opts = (exists) => ({ platform: 'win32', env, exists, home: W('C:/Users/u') });
  assert.equal(sdkTool('adb', opts(only(W('E:/sdk/platform-tools/adb.exe'), W('C:/L/Android/Sdk/platform-tools/adb.exe')))), W('E:/sdk/platform-tools/adb.exe'));
  assert.equal(sdkTool('adb', opts(only(W('C:/L/Android/Sdk/platform-tools/adb.exe'), W('C:/tools/pt/adb.exe')))), W('C:/L/Android/Sdk/platform-tools/adb.exe'));
  // a quoted Path entry is unquoted
  assert.equal(sdkTool('adb', opts(only(W('C:/tools/pt/adb.exe')))), W('C:/tools/pt/adb.exe'));
  assert.equal(sdkTool('adb', opts(() => false)), 'adb.exe');
  assert.equal(sdkTool('emulator', opts(only(W('E:/sdk/emulator/emulator.exe')))), W('E:/sdk/emulator/emulator.exe'));
});

test('sdkTool on darwin: env roots, ~/Library/Android/sdk, PATH, bare name without .exe', () => {
  const home = '/Users/u';
  assert.equal(sdkTool('adb', { platform: 'darwin', env: { ANDROID_SDK_ROOT: '/opt/sdk' }, exists: only('/opt/sdk/platform-tools/adb', '/Users/u/Library/Android/sdk/platform-tools/adb'), home }), '/opt/sdk/platform-tools/adb');
  assert.equal(sdkTool('adb', { platform: 'darwin', env: { PATH: '/usr/bin' }, exists: only('/Users/u/Library/Android/sdk/platform-tools/adb'), home }), '/Users/u/Library/Android/sdk/platform-tools/adb');
  assert.equal(sdkTool('adb', { platform: 'darwin', env: { PATH: '/usr/bin:/opt/homebrew/bin' }, exists: only('/opt/homebrew/bin/adb'), home }), '/opt/homebrew/bin/adb');
  assert.equal(sdkTool('emulator', { platform: 'darwin', env: {}, exists: only('/Users/u/Library/Android/sdk/emulator/emulator'), home }), '/Users/u/Library/Android/sdk/emulator/emulator');
  assert.equal(sdkTool('adb', { platform: 'darwin', env: { PATH: '/usr/bin' }, exists: () => false, home }), 'adb');
});

test('sdkTool on linux: ANDROID_HOME, ~/Android/Sdk, PATH, bare name', () => {
  const home = '/home/u';
  assert.equal(sdkTool('adb', { platform: 'linux', env: { ANDROID_HOME: '/sdk' }, exists: only('/sdk/platform-tools/adb'), home }), '/sdk/platform-tools/adb');
  assert.equal(sdkTool('adb', { platform: 'linux', env: { PATH: '/usr/bin' }, exists: only('/home/u/Android/Sdk/platform-tools/adb', '/usr/bin/adb'), home }), '/home/u/Android/Sdk/platform-tools/adb');
  assert.equal(sdkTool('adb', { platform: 'linux', env: { PATH: '/usr/local/bin::/usr/bin' }, exists: only('/usr/bin/adb'), home }), '/usr/bin/adb');
  assert.equal(sdkTool('adb', { platform: 'linux', env: {}, exists: () => false, home }), 'adb');
});

test('sdkTool uses the platform separator whatever the host is', () => {
  const win = sdkTool('adb', { platform: 'win32', env: { ANDROID_HOME: 'D:\\sdk' }, exists: () => true, home: '' });
  assert.ok(!win.includes('/'), win);
  const nix = sdkTool('adb', { platform: 'linux', env: { ANDROID_HOME: '/sdk' }, exists: () => true, home: '' });
  assert.equal(nix, path.posix.join('/sdk', 'platform-tools', 'adb'));
});

test('parseNodes reads text, id, bounds centre and decodes entities', () => {
  const xml = '<hierarchy><node text="A &amp; B &quot;x&quot;" resource-id="pkg:id/btn" content-desc="d" clickable="true" class="android.widget.Button" bounds="[10,20][30,60]" />'
    + '<node text="no bounds" /></hierarchy>';
  const nodes = parseNodes(xml);
  assert.equal(nodes.length, 1);
  assert.deepEqual(nodes[0], { text: 'A & B "x"', desc: 'd', id: 'pkg:id/btn', clickable: true, focused: false, cls: 'android.widget.Button', x: 20, y: 40, w: 20, h: 40 });
});

test('typeText escapes the device shell specials one character at a time', async () => {
  const dev = new Device({ adbPath: 'adb', serial: 'fake-serial' });
  const sent = [];
  dev.shell = async (cmd) => { sent.push(cmd); return ''; };
  await dev.typeText('a "$`\\(');
  assert.deepEqual(sent, ['input text "a"', 'input text "%s"', 'input text "\\""', 'input text "\\$"', 'input text "\\`"', 'input text "\\\\"', 'input text "("']);
});

test('typeText pastes non-ASCII text instead of typing it', async () => {
  const dev = new Device({ adbPath: 'adb', serial: 'fake-serial' });
  const pasted = [];
  dev.shell = async () => { throw new Error('must not type'); };
  dev.pasteText = async (t) => { pasted.push(t); };
  await dev.typeText('Привет');
  assert.deepEqual(pasted, ['Привет']);
});

test('parseTouchPanel picks the first device with both MT axes, by label or bare code', () => {
  const out = [
    'add device 1: /dev/input/event5',
    '  name:     "gpio-keys"',
    '    KEY (0001): KEY_VOLUMEDOWN',
    'add device 2: /dev/input/event2',
    '  name:     "virtio_input_multi_touch_1"',
    '    ABS_MT_SLOT           : value 0, min 0, max 10, fuzz 0, flat 0, resolution 0',
    '    ABS_MT_POSITION_X     : value 0, min 0, max 32767, fuzz 0, flat 0, resolution 0',
    '    ABS_MT_POSITION_Y     : value 0, min 0, max 32767, fuzz 0, flat 0, resolution 0'
  ].join('\n');
  assert.deepEqual(parseTouchPanel(out), { path: '/dev/input/event2', minX: 0, maxX: 32767, minY: 0, maxY: 32767 });
  // a getevent without -l labels prints bare hex codes
  const bare = 'add device 1: /dev/input/event3\n    0035  : value 0, min 0, max 1079, fuzz 0, flat 0, resolution 0\n    0036  : value 0, min 0, max 2399, fuzz 0, flat 0, resolution 0';
  assert.deepEqual(parseTouchPanel(bare), { path: '/dev/input/event3', minX: 0, maxX: 1079, minY: 0, maxY: 2399 });
  assert.equal(parseTouchPanel('add device 1: /dev/input/event5\n  name: "keys"'), null);
});

test('pinchEvents: protocol B — two slots down, frames of movement with SYN, lift with tracking -1', () => {
  const panel = { path: '/dev/input/event2', minX: 0, maxX: 32767, minY: 0, maxY: 32767 };
  const ev = pinchEvents(panel, { w: 1080, h: 2400 }, 'out', 4);
  const SLOT = 47, TRACK = 57, X = 53, Y = 54, SYN = 0, BTN = 330;
  // down: slot 0 + id, position; slot 1 + id, position; BTN_TOUCH; SYN
  assert.deepEqual(ev.slice(0, 4).map((e) => e[1]), [SLOT, TRACK, X, Y]);
  assert.deepEqual(ev.slice(4, 8).map((e) => e[1]), [SLOT, TRACK, X, Y]);
  assert.deepEqual(ev[8], [1, BTN, 1]);
  assert.deepEqual(ev[9], [0, SYN, 0]);
  // every movement frame ends with SYN_REPORT; the lift ends the list
  const syns = ev.filter((e) => e[0] === 0).length;
  assert.equal(syns, 1 + 4 + 1); // down + 4 frames + lift
  const lift = ev.slice(-6);
  assert.deepEqual(lift.map((e) => e[1]), [SLOT, TRACK, SLOT, TRACK, BTN, SYN]);
  assert.equal(lift[1][2], -1);
  assert.equal(lift[3][2], -1);
  assert.deepEqual(lift[4], [1, BTN, 0]);
  // coordinates are scaled into the panel's axis range
  for (const e of ev) if (e[1] === X || e[1] === Y) assert.ok(e[2] >= 0 && e[2] <= 32767, String(e[2]));
});

test('pinch sends one shell call of sendevent commands for the panel', async () => {
  const dev = new Device({ adbPath: 'adb', serial: 'fake-serial' });
  const sent = [];
  dev._touchPanel = { path: '/dev/input/event2', minX: 0, maxX: 32767, minY: 0, maxY: 32767 };
  dev._size = { w: 1080, h: 2400 };
  dev.shell = async (cmd) => { sent.push(cmd); return ''; };
  await dev.pinch('in', { durationMs: 300 });
  assert.equal(sent.length, 1);
  assert.ok(sent[0].startsWith('sendevent /dev/input/event2 3 47 0;'), sent[0].slice(0, 60));
  assert.ok(sent[0].endsWith('sendevent /dev/input/event2 0 0 0'));
  assert.ok(sent[0].includes(' 3 57 -1;'), 'lifts the fingers');
});
