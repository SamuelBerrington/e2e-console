'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { sdkTool, parseNodes, Device } = require('../../lib/adb');

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
