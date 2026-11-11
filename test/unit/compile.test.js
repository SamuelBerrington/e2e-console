'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { compile, condChain, substParams, matrixRows, rowLabel, variantsOf, defaultRole, screenOf } = require('../../lib/compile');

const whens = (step) => condChain(step).map((c) => c.when);

test('a step with when gets a _cond and loses the when field', () => {
  const { steps } = compile({ steps: [{ type: 'tap', target: 'A', when: { var: 'promo' } }] });
  assert.equal(steps.length, 1);
  assert.equal(steps[0].when, undefined);
  assert.deepEqual(steps[0]._cond.when, { var: 'promo' });
  assert.equal(steps[0]._cond.negate, false);
  assert.equal(steps[0]._phase, 'main');
});

test('condChain lists conditions outermost first and is empty without conditions', () => {
  const step = { _cond: { id: 3, when: 'inner', parent: { id: 2, when: 'middle', parent: { id: 1, when: 'outer' } } } };
  assert.deepEqual(condChain(step).map((c) => c.when), ['outer', 'middle', 'inner']);
  assert.deepEqual(condChain({}), []);
  assert.deepEqual(condChain(null), []);
});

test('if/else: both branches share one condition id, else is negated', () => {
  const { steps } = compile({ steps: [{ type: 'if', if: { visible: 'X' }, then: [{ type: 'tap', target: 'A' }], else: [{ type: 'tap', target: 'B' }, { type: 'back' }] }] });
  assert.deepEqual(steps.map((s) => s.target || s.type), ['A', 'B', 'back']);
  assert.equal(new Set(steps.map((s) => s._cond.id)).size, 1);
  assert.deepEqual(steps.map((s) => s._cond.negate), [false, true, true]);
  for (const s of steps) assert.deepEqual(s._cond.when, { visible: 'X' });
});

test('an if inside an if keeps both conditions, the outer one as parent', () => {
  const { steps } = compile({ steps: [{ type: 'if', if: { visible: 'Outer' }, then: [
    { type: 'if', if: { visible: 'Inner' }, then: [{ type: 'tap', target: 'deep' }], else: [{ type: 'tap', target: 'deep-else' }] }
  ] }] });
  assert.equal(steps.length, 2);
  assert.deepEqual(whens(steps[0]), [{ visible: 'Outer' }, { visible: 'Inner' }]);
  assert.deepEqual(condChain(steps[1]).map((c) => c.negate), [false, true]);
  // each step has its own copy of the chain
  assert.notEqual(steps[0]._cond, steps[1]._cond);
});

test('a when on a step inside an if keeps the if as its parent', () => {
  const { steps } = compile({ steps: [{ type: 'if', if: { visible: 'O' }, then: [{ type: 'tap', target: 'A', when: { var: 'v' } }] }] });
  assert.deepEqual(whens(steps[0]), [{ visible: 'O' }, { var: 'v' }]);
});

test('a when on the if itself sits above the if condition', () => {
  const { steps } = compile({ steps: [{ type: 'if', when: { platform: 'android' }, if: { visible: 'X' }, then: [{ type: 'back' }], else: [{ type: 'back' }] }] });
  for (const s of steps) assert.deepEqual(whens(s), [{ platform: 'android' }, { visible: 'X' }]);
  assert.equal(steps[0]._cond.parent.id, steps[1]._cond.parent.id);
});

test('use: expands a block, fills params from with and defaults, records _from', () => {
  const library = { open: { params: { tab: 'Active', number: '' }, steps: [{ type: 'tap', target: '{{tab}}' }, { type: 'assertText', text: 'No {{ number }} {{other}}' }] } };
  const { steps, errors, warnings } = compile({ steps: [{ type: 'use', use: 'open', with: { number: 42 } }] }, { library });
  assert.deepEqual(errors, []);
  assert.deepEqual(warnings, []);
  assert.equal(steps[0].target, 'Active');
  assert.equal(steps[1].text, 'No 42 {{other}}');
  assert.equal(steps[0]._from, 'open');
});

test('use: a list of params without defaults leaves unset ones as placeholders', () => {
  const library = { b: { params: ['product'], steps: [{ type: 'link', url: 'p/{{product}}' }] } };
  assert.equal(compile({ steps: [{ type: 'use', use: 'b' }] }, { library }).steps[0].url, 'p/{{product}}');
});

test('use: scenario blocks shadow the library and nested use records the path', () => {
  const library = { inner: { steps: [{ type: 'tap', target: 'lib' }] }, outer: { steps: [{ type: 'use', use: 'inner' }] } };
  const sc = { blocks: { inner: { steps: [{ type: 'tap', target: 'own' }] } }, steps: [{ type: 'use', use: 'outer' }] };
  const { steps } = compile(sc, { library });
  assert.equal(steps[0].target, 'own');
  assert.equal(steps[0]._from, 'outer → inner');
});

test('use: an unknown block, an undeclared param and self-recursion are reported', () => {
  assert.match(compile({ steps: [{ type: 'use', use: 'ghost' }] }).errors[0], /block "ghost" not found/);
  const r2 = compile({ steps: [{ type: 'use', use: 'b', with: { extra: 1 } }] }, { library: { b: { params: ['p'], steps: [] } } });
  assert.match(r2.warnings[0], /parameter "extra" is not declared/);
  const r3 = compile({ steps: [{ type: 'use', use: 'self' }] }, { library: { self: { steps: [{ type: 'use', use: 'self' }] } } });
  assert.ok(r3.errors.some((e) => /nesting too deep/.test(e)));
});

test('when on use: gates every step of the block, above the block steps own conditions', () => {
  const library = { b: { steps: [{ type: 'tap', target: 'A' }, { type: 'tap', target: 'B', when: { var: 'inner' } }] } };
  const { steps } = compile({ steps: [{ type: 'use', use: 'b', when: { var: 'outer' } }] }, { library });
  assert.deepEqual(whens(steps[0]), [{ var: 'outer' }]);
  assert.deepEqual(whens(steps[1]), [{ var: 'outer' }, { var: 'inner' }]);
  assert.equal(steps[0]._cond.id, steps[1]._cond.parent.id);
});

test('when on repeat gates the whole repeat; the body is compiled', () => {
  const { steps } = compile({ steps: [{ type: 'repeat', when: { var: 'x' }, times: 2, steps: [{ type: 'wait', seconds: 1, when: { var: 'y' } }] }] });
  assert.equal(steps.length, 1);
  assert.equal(steps[0].when, undefined);
  assert.deepEqual(steps[0]._cond.when, { var: 'x' });
  assert.deepEqual(steps[0].steps[0]._cond.when, { var: 'y' });
  assert.equal(steps[0].times, 2);
});

test('setup, main and teardown are tagged; variant setup runs first, variant teardown last', () => {
  const sc = { setup: [{ type: 'tap', target: 's' }], steps: [{ type: 'tap', target: 'm' }], teardown: [{ type: 'tap', target: 't' }] };
  const variant = { name: 'lite', setup: [{ type: 'tap', target: 'vs' }], teardown: [{ type: 'tap', target: 'vt' }] };
  const { steps } = compile(sc, { variant });
  assert.deepEqual(steps.map((s) => `${s._phase}:${s.target}`), ['setup:vs', 'setup:s', 'main:m', 'teardown:t', 'teardown:vt']);
});

test('engine web puts steps on the web screen; phone groups and on: override it', () => {
  const sc = { engine: 'web', steps: [{ type: 'tap', target: 'a' }, { type: 'phone', steps: [{ type: 'tap', target: 'b' }] }, { type: 'tap', target: 'c', on: 'mobile' }] };
  const { steps } = compile(sc);
  assert.deepEqual(steps.map((s) => s._on), ['web', 'phone', 'phone']);
  assert.ok(steps.every((s) => s.on === undefined));
  assert.match(compile({ steps: [{ type: 'tap', target: 'x', on: 'tv' }] }).warnings[0], /unknown screen "tv"/);
  assert.equal(screenOf('Browser'), 'web');
  assert.equal(screenOf(''), null);
});

test('substParams substitutes deep inside objects and arrays, leaves unknown names and non-strings', () => {
  const v = substParams({ a: '{{x}}-{{ y }}', b: ['{{x}}', 5, null], c: { d: '{{z}}' } }, { x: 1, y: 'two' });
  assert.deepEqual(v, { a: '1-two', b: ['1', 5, null], c: { d: '{{z}}' } });
});

test('matrixRows: an object of lists is the cartesian product, a list is used as is', () => {
  assert.deepEqual(matrixRows({ a: [1, 2], b: ['x', 'y'] }), [{ a: 1, b: 'x' }, { a: 1, b: 'y' }, { a: 2, b: 'x' }, { a: 2, b: 'y' }]);
  assert.deepEqual(matrixRows([{ a: 1 }, null, 'junk', { a: 2 }]), [{ a: 1 }, { a: 2 }]);
  assert.deepEqual(matrixRows(null), []);
  assert.deepEqual(matrixRows({ a: 'not a list' }), []);
  assert.deepEqual(compile({ steps: [], matrix: { k: ['v'] } }).rows, [{ k: 'v' }]);
});

test('rowLabel joins key=value pairs and stringifies objects', () => {
  assert.equal(rowLabel({ a: 1, b: 'x', c: { d: 2 } }), 'a=1, b=x, c={"d":2}');
  assert.equal(rowLabel({}), '');
});

test('variantsOf: one unnamed variant without variants, defaults filled otherwise', () => {
  assert.deepEqual(variantsOf({}), [{ name: null }]);
  assert.deepEqual(variantsOf({ variants: [] }), [{ name: null }]);
  assert.deepEqual(variantsOf({ variants: { bad: 'x' } }), [{ name: null }]);
  assert.deepEqual(variantsOf({ variants: { lite: { vars: { a: 1 } }, full: { title: 'Full' } } }), [
    { name: 'lite', title: 'lite', vars: { a: 1 }, setup: [], teardown: [] },
    { name: 'full', title: 'Full', vars: {}, setup: [], teardown: [] }
  ]);
});

test('defaultRole: the app account when described, else the first account, buyer only as the last fallback', () => {
  assert.equal(defaultRole({ accounts: { seller: {}, courier: {} }, auth: { appAccount: 'courier' } }), 'courier');
  assert.equal(defaultRole({ accounts: { seller: {}, courier: {} }, auth: { appAccount: 'ghost' } }), 'seller');
  assert.equal(defaultRole({ accounts: { seller: {} } }), 'seller');
  assert.equal(defaultRole({ auth: { appAccount: 'tester' } }), 'tester');
  assert.equal(defaultRole({}), 'buyer');
  assert.equal(defaultRole(undefined), 'buyer');
});
