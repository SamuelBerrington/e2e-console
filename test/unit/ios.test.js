'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { devices } = require('../../lib/ios');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const simctl = (list) => JSON.stringify({ devices: { 'com.apple.CoreSimulator.SimRuntime.iOS-18-0': list } });
const booted = { udid: 'FAKE-UDID-0001', name: 'iPhone Fake', state: 'Booted' };

test('devices is empty off macOS and never calls simctl there', async () => {
  let called = false;
  assert.deepEqual(await devices({ platform: 'linux', list: () => { called = true; return simctl([booted]); } }), []);
  assert.equal(called, false);
});

test('devices lists booted simulators only', async () => {
  const out = await devices({ platform: 'darwin', list: async () => simctl([booted, { udid: 'FAKE-UDID-0002', name: 'iPad Fake', state: 'Shutdown' }]) });
  assert.deepEqual(out, [{ serial: 'FAKE-UDID-0001', name: 'iPhone Fake', platform: 'ios' }]);
});

test('a slow simctl does not hold the device list: the caller gets the last known list and the result arrives later', async () => {
  // start from a known empty list
  assert.deepEqual(await devices({ platform: 'darwin', list: async () => simctl([]) }), []);
  let calls = 0;
  const slow = async () => { calls++; await sleep(600); return simctl([booted]); };
  const started = Date.now();
  const first = await devices({ platform: 'darwin', list: slow, waitMs: 20 });
  assert.deepEqual(first, []);
  assert.ok(Date.now() - started < 400, 'returned before simctl answered');
  // a second caller while the first call is still running does not start another simctl
  await devices({ platform: 'darwin', list: slow, waitMs: 20 });
  assert.equal(calls, 1);
  await sleep(800);
  const later = await devices({ platform: 'darwin', list: async () => { calls++; return simctl([booted]); }, waitMs: 20 });
  assert.deepEqual(later, [{ serial: 'FAKE-UDID-0001', name: 'iPhone Fake', platform: 'ios' }]);
});

test('a failing or garbled simctl gives an empty list, not an error', async () => {
  assert.deepEqual(await devices({ platform: 'darwin', list: async () => { throw new Error('xcrun: not found'); } }), []);
  assert.deepEqual(await devices({ platform: 'darwin', list: async () => 'not json' }), []);
});
