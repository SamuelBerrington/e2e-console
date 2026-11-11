'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const appNet = require('../../lib/appNet');

const ID1 = '11111111-2222-4333-8444-555555555555';
const ID2 = '66666666-7777-4888-9999-aaaaaaaaaaaa';
const line = (t, msg, tag = 'FakeNet') => `${t}  1234  5678 D ${tag}  : ${msg}`;

test('appNet.parse joins a request and its response by correlation id', () => {
  const text = [
    line('1700000000.000', 'REQUEST: https://api.example.test/v1/cart?x=1'),
    line('1700000000.001', 'METHOD: GET'),
    line('1700000000.002', `baggage: foo=bar,correlation_id=${ID1}`),
    line('1700000000.500', 'RESPONSE: 409'),
    line('1700000000.501', 'METHOD: GET'),
    line('1700000000.502', 'FROM: https://api.example.test/v1/cart?x=1'),
    line('1700000000.503', `x-correlation-id: ${ID1}`),
    line('1700000000.600', 'REQUEST: https://api.example.test/other'),
    line('1700000000.601', `baggage: correlation_id=${ID2}`, 'OtherTag')
  ].join('\r\n');
  const calls = appNet.parse(text, 'FakeNet');
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], { corr: ID1, t: new Date(1700000000000).toISOString(), method: 'GET', path: '/v1/cart?x=1', status: 409 });
});

test('appNet.parse keeps each sensitive exchange as its own call, sorted by time', () => {
  const text = [
    line('1700000002.000', `HTTP sensitive exchange: method=POST status=201 correlation=${ID2}`),
    line('1700000001.000', `HTTP sensitive exchange: method=POST status=500 correlation=${ID2}`)
  ].join('\n');
  const calls = appNet.parse(text, 'FakeNet');
  assert.deepEqual(calls.map((c) => [c.status, c.sensitive]), [[500, true], [201, true]]);
});

test('appNet.parse escapes the tag and returns nothing without one', () => {
  assert.deepEqual(appNet.parse(line('1.0', `HTTP sensitive exchange: method=GET status=200 correlation=${ID1}`, 'a.b'), ''), []);
  assert.equal(appNet.parse(line('1.0', `HTTP sensitive exchange: method=GET status=200 correlation=${ID1}`, 'a.b'), 'a.b').length, 1);
  assert.equal(appNet.parse(line('1.0', `HTTP sensitive exchange: method=GET status=200 correlation=${ID1}`, 'aXb'), 'a.b').length, 0);
});

test('appNet.enrich fills the path of a sensitive call from the backend line and reports errors', () => {
  const t0 = '2026-01-01T00:00:00.000Z';
  const steps = [{ startedAt: t0, ms: 1000, appCalls: [{ corr: ID1, t: t0, method: 'POST', status: 409, sensitive: true }] }];
  const backend = [{ t: '2026-01-01T00:00:00.300Z', logger: 'http.access', service: 'cart', level: 'INFO', msg: '',
    extra: { correlation_id: ID1, caller: 'public', method: 'POST', status: 409, path: '/v1/cart/items', error_code: 'FAKE_CONFLICT', duration: 12 } }];
  const total = appNet.enrich(steps, backend);
  assert.equal(total, 1);
  assert.equal(steps[0].appCalls[0].path, '/v1/cart/items');
  assert.equal(steps[0].appCalls[0].service, 'cart');
  assert.deepEqual(steps[0].backendIssues, [{ corr: ID1, level: 'warn', text: 'POST /v1/cart/items → 409 FAKE_CONFLICT' }]);
  // allowed statuses and ignore patterns silence it
  steps[0].allowStatus = [409];
  assert.equal(appNet.enrich(steps, backend), 0);
  delete steps[0].allowStatus;
  assert.equal(appNet.enrich(steps, backend, ['FAKE_CONFLICT']), 0);
});
