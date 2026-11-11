'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { lint, jsonSchema, varsIn } = require('../../lib/lint');

const sc = (steps, extra = {}) => ({ name: 'Lint fixture', steps, ...extra });
const has = (list, re) => list.some((x) => re.test(x));

test('a clean scenario lints without errors or warnings', () => {
  const r = lint(sc([{ type: 'launch' }, { type: 'tap', target: 'Go' }, { type: 'assertText', text: 'Done' }]));
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.warnings, []);
  assert.equal(r.steps, 3);
});

test('an unknown condition key is an error', () => {
  const r = lint(sc([{ type: 'tap', target: 'A', when: { visibel: 'X' } }]));
  assert.ok(has(r.errors, /unknown condition field "visibel"/), r.errors.join('\n'));
});

test('an empty {} condition is an error', () => {
  assert.ok(has(lint(sc([{ type: 'tap', target: 'A', when: {} }])).errors, /empty condition/));
  assert.ok(has(lint(sc([{ type: 'if', if: {}, then: [{ type: 'back' }] }])).errors, /empty condition/));
});

test('a non-object condition is an error', () => {
  assert.ok(has(lint(sc([{ type: 'tap', target: 'A', when: 'visible' }])).errors, /must be an object/));
  assert.ok(has(lint(sc([{ type: 'tap', target: 'A', when: ['x'] }])).errors, /must be an object/));
  assert.ok(has(lint(sc([{ type: 'repeat', until: 'gone', steps: [{ type: 'back' }] }])).errors, /until: the condition must be an object/));
});

test('conditions are checked at every level: nested if, use when, not', () => {
  const library = { b: { steps: [{ type: 'back' }] } };
  const r = lint(sc([
    { type: 'if', if: { visible: 'O' }, then: [{ type: 'if', if: { bogus: 1 }, then: [{ type: 'back' }] }] },
    { type: 'use', use: 'b', when: { alsoBogus: 1 } },
    { type: 'tap', target: 'x', when: { not: { wrong: 1 } } }
  ]), { library });
  assert.ok(has(r.errors, /unknown condition field "bogus"/));
  assert.ok(has(r.errors, /unknown condition field "alsoBogus"/));
  assert.ok(has(r.errors, /not: unknown condition field "wrong"/));
});

test('a condition shared by an if/else group is reported once', () => {
  const r = lint(sc([{ type: 'if', if: { bogus: 1 }, then: [{ type: 'back' }, { type: 'back' }], else: [{ type: 'back' }] }]));
  assert.equal(r.errors.filter((e) => /unknown condition field "bogus"/.test(e)).length, 1);
});

test('equals without var is an error', () => {
  assert.ok(has(lint(sc([{ type: 'back', when: { visible: 'x', equals: 1 } }])).errors, /equals\/matches need var/));
});

test('an unknown step field is a warning, a wrongly typed one an error', () => {
  const r = lint(sc([{ type: 'tap', target: 'A', colour: 'red' }, { type: 'wait', seconds: 'soon' }]));
  assert.ok(has(r.warnings, /field "colour" does nothing on a tap step/));
  assert.ok(has(r.errors, /field "seconds" has the wrong type/));
});

test('a per-platform text with keys other than android/ios is an error', () => {
  const r = lint(sc([{ type: 'tap', target: { '{ x }': null } }]));
  assert.ok(has(r.errors, /field "target" has the wrong type/), JSON.stringify(r));
});

test('an unknown step type and a missing required field are errors', () => {
  const r = lint(sc([{ type: 'teleport' }, { type: 'tap' }]));
  assert.ok(has(r.errors, /unknown step type "teleport"/));
  assert.ok(has(r.errors, /lacks the required field "target"/));
});

test('an unknown block in use: is an error', () => {
  assert.ok(has(lint(sc([{ type: 'use', use: 'nowhere' }])).errors, /block "nowhere" not found/));
});

test('a role that does not exist in settings is an error; none and described roles pass', () => {
  const settings = { accounts: { seller: {} } };
  assert.ok(has(lint(sc([{ type: 'api', url: 'x', auth: 'courier' }]), { settings }).errors, /role "courier" is not described/));
  assert.deepEqual(lint(sc([{ type: 'api', url: 'x', auth: 'seller' }]), { settings }).errors, []);
  assert.deepEqual(lint(sc([{ type: 'api', url: 'x', auth: 'none' }]), { settings }).errors, []);
  // without auth: the default role (here the first account) is used
  assert.deepEqual(lint(sc([{ type: 'api', url: 'x' }]), { settings }).errors, []);
});

test('variables: unknown ones warn, save and matrix and role fields make them known', () => {
  const settings = { accounts: { buyer: {} } };
  const r = lint(sc([
    { type: 'api', url: 'a', save: { orderId: 'id' } },
    { type: 'tap', target: '{{orderId}} {{size}} {{buyer.phone}} {{uuid}}' },
    { type: 'tap', target: '{{mystery}}' }
  ], { matrix: { size: ['S'] } }), { settings });
  assert.deepEqual(r.warnings.filter((w) => /variable/.test(w)).length, 1);
  assert.ok(has(r.warnings, /variable "mystery"/));
});

test('a block parameter not passed via with is an error', () => {
  const library = { b: { params: ['product'], steps: [{ type: 'link', url: 'p/{{product}}' }] } };
  assert.ok(has(lint(sc([{ type: 'use', use: 'b' }]), { library }).errors, /block parameter "product" is not passed/));
});

test('scenario-level checks: no steps, unknown field, bad engine, bad measure, bad variants', () => {
  assert.ok(has(lint({ name: 'x', steps: [] }).errors, /no steps/));
  assert.deepEqual(lint(null).errors, ['the scenario is empty']);
  const r = lint(sc([{ type: 'back' }], { colour: 1, engine: 'robot', measure: { iterations: 50 }, variants: { a: [] } }));
  assert.ok(has(r.warnings, /scenario field "colour" does nothing/));
  assert.ok(has(r.errors, /unknown engine "robot"/));
  assert.ok(has(r.errors, /measure.iterations/));
  assert.ok(has(r.errors, /variant "a"/));
});

test('a body that is not JSON after placeholder substitution warns', () => {
  const ok = lint(sc([{ type: 'api', url: 'x', auth: 'none', body: '{"context": {{context}}}' }]), { settings: { templates: { context: '{}' } } });
  assert.deepEqual(ok.warnings, []);
  assert.ok(has(lint(sc([{ type: 'api', url: 'x', auth: 'none', body: '{"a": }' }])).warnings, /does not look like JSON/));
});

test('lastRun: a save path missing from the last recorded response warns', () => {
  const lastRun = { steps: [{ type: 'api', status: 'passed', title: 'GET api/cart', response: JSON.stringify({ items: [{ id: 1 }] }) }] };
  const r = lint(sc([{ type: 'api', url: 'api/cart', auth: 'none', save: { a: 'items.0.id', b: 'itemz.0.id' } }]), { lastRun });
  assert.ok(has(r.warnings, /no field "itemz.0.id"/));
  assert.ok(!has(r.warnings, /no field "items.0.id"/));
});

test('varsIn collects placeholders from nested values', () => {
  assert.deepEqual([...varsIn({ a: '{{x}} {{ y.z }}', b: ['{{x}}'] })].sort(), ['x', 'y.z']);
});

test('jsonSchema lists every step type and requires steps', () => {
  const s = jsonSchema();
  assert.deepEqual(s.required, ['steps']);
  assert.ok(s.definitions.step.oneOf[1].properties.type.enum.includes('repeat'));
  assert.ok(s.definitions.condition.properties.visible);
});

test('a falsy when (false, 0) is a broken condition, not "no condition"', () => {
  for (const when of [false, 0]) {
    const r = lint(sc([{ type: 'tap', target: 'Buy', when }]));
    assert.ok(has(r.errors, /the condition must be an object/), JSON.stringify({ when, errors: r.errors }));
  }
  // an empty field left by the editor still means "no condition"
  for (const when of ['', null]) assert.deepEqual(lint(sc([{ type: 'tap', target: 'Buy', when }])).errors, []);
});
