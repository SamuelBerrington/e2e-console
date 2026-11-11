'use strict';
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { startServer } = require('./helpers');

describe('request guard', () => {
  let srv;
  before(async () => { srv = await startServer(); });
  after(async () => { if (srv) await srv.stop(); });

  it('refuses a request with a foreign Host header', async () => {
    const r = await srv.get('/api/scenarios', { headers: { host: 'evil.example' } });
    assert.equal(r.status, 403);
    assert.match(r.json.error, /127\.0\.0\.1/);
  });

  it('refuses a localhost Host header with another port (DNS rebinding through a proxy)', async () => {
    const r = await srv.get('/api/scenarios', { headers: { host: `localhost:${srv.port + 1}` } });
    assert.equal(r.status, 403);
  });

  it('refuses a foreign Host header for the web UI too', async () => {
    const r = await srv.get('/', { headers: { host: 'evil.example' } });
    assert.equal(r.status, 403);
  });

  it('answers when Host is localhost with its own port', async () => {
    const r = await srv.get('/api/scenarios', { headers: { host: `localhost:${srv.port}` } });
    assert.equal(r.status, 200);
  });

  it('refuses a POST with a foreign Origin and stores nothing', async () => {
    const r = await srv.post('/api/scenarios', { name: 'From evil' }, { headers: { origin: 'http://evil.example' } });
    assert.equal(r.status, 403);
    assert.match(r.json.error, /other sites/);
    assert.deepEqual(fs.readdirSync(srv.file('scenarios')), []);
  });

  it('refuses Origin "null" (a sandboxed frame or a file:// page)', async () => {
    const r = await srv.post('/api/scenarios', { name: 'From null' }, { headers: { origin: 'null' } });
    assert.equal(r.status, 403);
  });

  it('refuses a request marked Sec-Fetch-Site: cross-site, even a GET', async () => {
    const r = await srv.get('/api/settings', { headers: { 'sec-fetch-site': 'cross-site' } });
    assert.equal(r.status, 403);
    const p = await srv.post('/api/scenarios', { name: 'x' }, { headers: { 'sec-fetch-site': 'same-site' } });
    assert.equal(p.status, 403);
  });

  it('refuses a POST whose body is text/plain with 415', async () => {
    const r = await srv.request('POST', '/api/scenarios', { rawBody: JSON.stringify({ name: 'Plain' }), headers: { 'content-type': 'text/plain' } });
    assert.equal(r.status, 415);
    assert.deepEqual(fs.readdirSync(srv.file('scenarios')), []);
  });

  it('refuses a body over 5 MB with 413', async () => {
    const r = await srv.request('POST', '/api/scenarios', { rawBody: '"' + 'x'.repeat(5.2e6) + '"', headers: { 'content-type': 'application/json' } });
    assert.equal(r.status, 413);
    assert.deepEqual(fs.readdirSync(srv.file('scenarios')), []);
  });

  it('answers 400 on a JSON body that does not parse', async () => {
    const r = await srv.request('POST', '/api/scenarios', { rawBody: '{"name":', headers: { 'content-type': 'application/json' } });
    assert.equal(r.status, 400);
  });

  it('accepts a same-origin JSON POST', async () => {
    const r = await srv.post('/api/scenarios', { name: 'Same origin' }, { headers: { origin: srv.base, 'sec-fetch-site': 'same-origin' } });
    assert.equal(r.status, 201);
    assert.equal(r.json.id, 'same-origin');
    assert.ok(fs.existsSync(srv.file('scenarios', 'same-origin.json')));
  });

  it('accepts a POST from the CLI or curl (no Origin, no Sec-Fetch-Site)', async () => {
    const r = await srv.post('/api/scenarios', { name: 'From cli' });
    assert.equal(r.status, 201);
  });

  it('serves the web UI and refuses a path that climbs out of public/', async () => {
    const page = await srv.get('/');
    assert.equal(page.status, 200);
    assert.match(page.headers['content-type'], /text\/html/);
    const out = await srv.get('/..%2f..%2fserver.js');
    assert.notEqual(out.status, 200);
  });

  it('answers 404 for an unknown API method', async () => {
    const r = await srv.get('/api/no-such-thing');
    assert.equal(r.status, 404);
  });
});
