'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const chips = require('../../lib/chips');

test('chips.lookup matches ro.soc.model exactly, then the longest prefix', () => {
  assert.deepEqual(chips.lookup({ soc: 'SM8650' }), { name: 'Snapdragon 8 Gen 3', score: 2200, via: 'SM8650' });
  // SM8250-AC is the 870, not the 865 whose code is a shorter prefix
  assert.equal(chips.lookup({ soc: 'SM8250-AC-x' }).name, 'Snapdragon 870');
  assert.equal(chips.lookup({ soc: 'sm8250' }).name, 'Snapdragon 865');
  assert.equal(chips.lookup({ platform: 'kalama' }).name, 'Snapdragon 8 Gen 2');
  assert.equal(chips.lookup({ hardware: 'Qualcomm Technologies, Inc SM7325' }).name, 'Snapdragon 778G');
});

test('chips.lookup: unknown devices give null, extra entries extend the table', () => {
  assert.equal(chips.lookup({ soc: 'NOPE123' }), null);
  assert.equal(chips.lookup(null), null);
  assert.deepEqual(chips.lookup({ soc: 'FAKE9000' }, [{ code: 'FAKE9000', name: 'Fake Chip', score: 1234 }, { name: 'no score' }]), { name: 'Fake Chip', score: 1234, via: 'FAKE9000' });
});

test('chips.examples lists the scale points in order, overridable by extra', () => {
  const ex = chips.examples();
  assert.equal(ex.length, 4);
  assert.deepEqual(ex.map((e) => e.name), ['Snapdragon 685', 'Snapdragon 695', 'Dimensity 8300', 'Snapdragon 8 Gen 3']);
  assert.equal(chips.examples([{ name: 'Snapdragon 685', score: 1, code: 'X' }])[0].score, 480);
});
