'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { flowEnv, cmdLine, toCommands, contains, exact, substDeep, rawCommands } = require('../../lib/maestro');

test('flowEnv puts values into numbered MAESTRO_E2E_V<n> names and maps the original names in the header', () => {
  const nasty = 'a&calc|b%PATH%^c"d';
  const { header, childEnv } = flowEnv({ PAY_URL: 'https://x.test/?a=1&b=2', NASTY: nasty, count: 3 });
  assert.deepEqual(childEnv, { MAESTRO_E2E_V0: 'https://x.test/?a=1&b=2', MAESTRO_E2E_V1: nasty, MAESTRO_E2E_V2: '3' });
  assert.deepEqual(header, { PAY_URL: '${MAESTRO_E2E_V0}', NASTY: '${MAESTRO_E2E_V1}', count: '${MAESTRO_E2E_V2}' });
  // no value reaches the header itself
  assert.ok(!JSON.stringify(header).includes('calc'));
});

test('flowEnv writes an empty value into the header as an empty string and skips it in the environment', () => {
  const { header, childEnv } = flowEnv({ EMPTY: '', NEXT: 'v' });
  assert.deepEqual(header, { EMPTY: '', NEXT: '${MAESTRO_E2E_V0}' });
  assert.deepEqual(childEnv, { MAESTRO_E2E_V0: 'v' });
});

test('flowEnv skips invalid names, null and object values', () => {
  const { header, childEnv } = flowEnv({ 'bad-name': 'x', '1st': 'x', nothing: null, undef: undefined, obj: { a: 1 }, ok: false });
  assert.deepEqual(header, { ok: '${MAESTRO_E2E_V0}' });
  assert.deepEqual(childEnv, { MAESTRO_E2E_V0: 'false' });
  assert.deepEqual(flowEnv(undefined), { header: {}, childEnv: {} });
});

test('cmdLine quotes every argument', () => {
  assert.equal(cmdLine('C:\\m\\maestro.bat', ['--device', 'emulator-5554', 'test', 'flow.yaml']), '"C:\\m\\maestro.bat" "--device" "emulator-5554" "test" "flow.yaml"');
  // cmd.exe takes & | < > ^ literally inside quotes
  assert.equal(cmdLine('m', ['a&b|c<d>e^f']), '"m" "a&b|c<d>e^f"');
});

test('cmdLine refuses a quote, a percent sign, line breaks and a trailing backslash', () => {
  for (const bad of ['a"b', '1%PATH%', 'a\nb', 'a\rb', 'C:\\dir\\']) assert.throws(() => cmdLine('m', ['--device', bad]), /cannot pass/, JSON.stringify(bad));
  assert.throws(() => cmdLine('C:\\bad%dir\\maestro.bat', []), /cannot pass/);
  // a backslash inside is fine
  assert.doesNotThrow(() => cmdLine('C:\\a\\b.bat', ['x\\y']));
});

test('contains and exact escape regex specials and match any kind of space', () => {
  assert.equal(exact('1 250 ₽'), '1[\\s\\u00A0\\u202F]+250[\\s\\u00A0\\u202F]+₽');
  assert.equal(contains('a.b'), '(?s).*a\\.b.*');
  const re = new RegExp('^' + exact('1 000 (x)') + '$', 's');
  assert.ok(re.test('1\u00a0000\u202f(x)'));
});

test('toCommands: a tap becomes one decision, an offset tap and a fling fall back to adb', () => {
  const cmds = toCommands({ type: 'tap', target: 'Buy' }, { package: 'com.example.fake' });
  assert.equal(cmds.filter((c) => c.runFlow).length, 2);
  assert.ok(cmds.some((c) => c.evalScript === '${output.e2eTapped = false}'));
  assert.equal(toCommands({ type: 'tap', target: 'X', dx: 5 }, {}), null);
  assert.equal(toCommands({ type: 'swipe', direction: 'down', fast: true }, {}), null);
  assert.equal(toCommands({ type: 'link', url: 'x' }, {}), null);
  assert.equal(toCommands({ type: 'assertText', text: 'x', count: 2 }, {}), null);
  assert.deepEqual(toCommands({ type: 'launch' }, { package: 'p', bundleId: 'b' }, 'ios')[0], { launchApp: { appId: 'b', stopApp: true } });
});

test('rawCommands and substDeep handle raw Maestro steps', () => {
  assert.deepEqual(rawCommands({ yaml: '- back\n- tapOn: A' }), ['back', { tapOn: 'A' }]);
  assert.deepEqual(rawCommands({ yaml: 'back' }), ['back']);
  assert.deepEqual(rawCommands({}), []);
  assert.deepEqual(substDeep({ a: ['x{{v}}', 1] }, (s) => s.replace('{{v}}', 'Y')), { a: ['xY', 1] });
});
