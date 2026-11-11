'use strict';
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { startServer, readJsonFile } = require('./helpers');

describe('scenarios API', () => {
  let srv;
  before(async () => { srv = await startServer(); });
  after(async () => { if (srv) await srv.stop(); });

  it('starts with an empty list', async () => {
    const r = await srv.get('/api/scenarios');
    assert.equal(r.status, 200);
    assert.deepEqual(r.json, []);
  });

  it('creates a scenario with an id made from its name and keeps the editor fields', async () => {
    const r = await srv.post('/api/scenarios', { name: 'Корзина: smoke', description: 'd', steps: [{ type: 'launch' }], tags: ['tests'], engine: 'web', tab: '', order: 3 });
    assert.equal(r.status, 201);
    assert.equal(r.json.id, 'korzina-smoke');
    const disk = readJsonFile(srv.file('scenarios', 'korzina-smoke.json'));
    assert.deepEqual(disk, { id: 'korzina-smoke', name: 'Корзина: smoke', description: 'd', steps: [{ type: 'launch' }], engine: 'web', tags: ['tests'], order: 3 });
  });

  it('gives a second scenario with the same name its own id', async () => {
    const r = await srv.post('/api/scenarios', { name: 'Корзина: smoke' });
    assert.equal(r.json.id, 'korzina-smoke-2');
    assert.equal(r.json.name, 'Корзина: smoke');
  });

  it('reads a scenario back and lists it', async () => {
    const one = await srv.get('/api/scenarios/korzina-smoke');
    assert.equal(one.status, 200);
    assert.equal(one.json.name, 'Корзина: smoke');
    const list = (await srv.get('/api/scenarios')).json.map((s) => s.id);
    assert.deepEqual(list.sort(), ['korzina-smoke', 'korzina-smoke-2']);
  });

  it('answers 404 for a missing scenario and 400 for a bad id', async () => {
    assert.equal((await srv.get('/api/scenarios/no-such')).status, 404);
    assert.equal((await srv.get('/api/scenarios/..%2Fsettings')).status, 400);
    assert.equal((await srv.get('/api/scenarios/-dash')).status, 400);
  });

  it('updates a scenario, keeps its id, and does not store lint or yamlText', async () => {
    const r = await srv.put('/api/scenarios/korzina-smoke', {
      id: 'something-else', name: 'Renamed', steps: [{ type: 'launch' }, { type: 'tap', target: 'OK' }],
      lint: { errors: ['stale'], warnings: [] }, yamlText: 'name: Renamed\n'
    });
    assert.equal(r.status, 200);
    assert.equal(r.json.id, 'korzina-smoke');
    assert.ok(r.json.lint && Array.isArray(r.json.lint.errors), 'the answer carries a fresh lint');
    assert.notDeepEqual(r.json.lint.errors, ['stale']);
    const disk = readJsonFile(srv.file('scenarios', 'korzina-smoke.json'));
    assert.equal(disk.name, 'Renamed');
    assert.equal(disk.steps.length, 2);
    assert.equal('lint' in disk, false);
    assert.equal('yamlText' in disk, false);
    assert.equal(disk.engine, 'web', 'fields not sent stay');
    assert.equal(fs.existsSync(srv.file('scenarios', 'something-else.json')), false);
  });

  it('drops optional fields the editor clears with null or an empty string', async () => {
    const r = await srv.put('/api/scenarios/korzina-smoke', { engine: null, tab: '' });
    assert.equal(r.status, 200);
    const disk = readJsonFile(srv.file('scenarios', 'korzina-smoke.json'));
    assert.equal('engine' in disk, false);
    assert.equal('tab' in disk, false);
  });

  it('deletes a scenario', async () => {
    assert.equal((await srv.del('/api/scenarios/korzina-smoke-2')).status, 200);
    assert.equal((await srv.get('/api/scenarios/korzina-smoke-2')).status, 404);
    assert.equal(fs.existsSync(srv.file('scenarios', 'korzina-smoke-2.json')), false);
  });

  it('exports a scenario as YAML, JSON and a Maestro flow', async () => {
    const y = await srv.get('/api/scenarios/korzina-smoke/export');
    assert.equal(y.status, 200);
    assert.match(y.headers['content-type'], /yaml/);
    assert.match(y.headers['content-disposition'], /korzina-smoke\.yaml/);
    assert.match(y.text, /name: Renamed/);
    const j = await srv.get('/api/scenarios/korzina-smoke/export?format=json');
    assert.equal(JSON.parse(j.text).id, 'korzina-smoke');
    const m = await srv.get('/api/scenarios/korzina-smoke/export?format=maestro');
    assert.equal(m.status, 200);
    assert.match(m.text, /tapOn/);
  });
});

describe('scenario YAML save', () => {
  let srv;
  let file;
  before(async () => {
    srv = await startServer();
    await srv.post('/api/scenarios', { name: 'Yaml target', description: 'before', steps: [{ type: 'launch' }, { type: 'tap', target: 'Start' }] });
    file = srv.file('scenarios', 'yaml-target.json');
  });
  after(async () => { if (srv) await srv.stop(); });

  it('refuses a text with a comment with 400 naming the line, and leaves the file byte-identical', async () => {
    const before = fs.readFileSync(file);
    const r = await srv.put('/api/scenarios/yaml-target/yaml', { text: 'name: Yaml target\nsteps:\n  # a note\n  - launch\n' });
    assert.equal(r.status, 400);
    assert.match(r.json.error, /line 3: comment/);
    assert.ok(fs.readFileSync(file).equals(before));
  });

  it('refuses an unknown top-level key with 400 and leaves the file byte-identical', async () => {
    const before = fs.readFileSync(file);
    const r = await srv.put('/api/scenarios/yaml-target/yaml', { text: 'name: Yaml target\nretries: 3\nsteps:\n  - launch\n' });
    assert.equal(r.status, 400);
    assert.match(r.json.error, /unknown key "retries"/);
    assert.ok(r.json.errors.some((e) => /^line 2:/.test(e)));
    assert.ok(fs.readFileSync(file).equals(before));
  });

  it('refuses an unclear step and broken YAML with 400', async () => {
    const before = fs.readFileSync(file);
    const unclear = await srv.put('/api/scenarios/yaml-target/yaml', { text: 'name: Yaml target\nsteps:\n  - launch\n  - jump: high\n' });
    assert.equal(unclear.status, 400);
    const broken = await srv.put('/api/scenarios/yaml-target/yaml', { text: 'name: [unclosed\nsteps:\n  - launch\n' });
    assert.equal(broken.status, 400);
    assert.ok(fs.readFileSync(file).equals(before));
  });

  it('round-trips the exported YAML text unchanged', async () => {
    const before = readJsonFile(file);
    const text = (await srv.get('/api/scenarios/yaml-target/export')).text;
    const r = await srv.put('/api/scenarios/yaml-target/yaml', { text });
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(r.json.scenario, before);
    assert.deepEqual(readJsonFile(file), before);
    assert.equal((await srv.get('/api/scenarios/yaml-target/export')).text, text);
  });

  it('saves an edited YAML text under the same id', async () => {
    const r = await srv.put('/api/scenarios/yaml-target/yaml', { text: 'id: ignored-id\nname: Edited in YAML\nsteps:\n  - launch: clear\n  - tap: Go\n  - wait: 2\n' });
    assert.equal(r.status, 200, r.text);
    const disk = readJsonFile(file);
    assert.equal(disk.id, 'yaml-target');
    assert.equal(disk.name, 'Edited in YAML');
    assert.deepEqual(disk.steps, [{ type: 'launch', clear: true }, { type: 'tap', target: 'Go' }, { type: 'wait', seconds: 2 }]);
    assert.equal(fs.existsSync(srv.file('scenarios', 'ignored-id.json')), false);
  });
});

describe('scenario lint', () => {
  let srv;
  before(async () => { srv = await startServer(); });
  after(async () => { if (srv) await srv.stop(); });

  it('reports an unknown condition key as an error', async () => {
    await srv.post('/api/scenarios', { name: 'Typo cond', steps: [{ type: 'launch' }, { type: 'if', if: { visibel: 'Banner' }, then: [{ type: 'tap', target: 'Close' }] }] });
    const r = await srv.get('/api/scenarios/typo-cond/lint');
    assert.equal(r.status, 200);
    assert.ok(r.json.errors.some((e) => /unknown condition field "visibel"/.test(e)), JSON.stringify(r.json.errors));
  });

  it('reports a clean scenario with no errors', async () => {
    await srv.post('/api/scenarios', { name: 'Clean', steps: [{ type: 'launch' }, { type: 'if', if: { visible: 'Banner' }, then: [{ type: 'tap', target: 'Close' }] }] });
    const r = await srv.get('/api/scenarios/clean/lint');
    assert.deepEqual(r.json.errors, []);
  });

  it('reports a scenario with no steps, an unknown step type and an unknown block', async () => {
    await srv.post('/api/scenarios', { name: 'Empty' });
    assert.ok((await srv.get('/api/scenarios/empty/lint')).json.errors.some((e) => /no steps/.test(e)));
    await srv.post('/api/scenarios', { name: 'Odd', steps: [{ type: 'teleport' }, { type: 'use', use: 'no-such-block' }] });
    const errs = (await srv.get('/api/scenarios/odd/lint')).json.errors.join('\n');
    assert.match(errs, /unknown step type "teleport"/);
    assert.match(errs, /no-such-block/);
  });

  it('answers 404 for the lint of a missing scenario', async () => {
    assert.equal((await srv.get('/api/scenarios/nope/lint')).status, 404);
  });

  it('serves the JSON schema', async () => {
    const r = await srv.get('/api/schema');
    assert.equal(r.status, 200);
    assert.ok(r.json.definitions && r.json.definitions.condition);
  });
});

describe('block library', () => {
  let srv;
  before(async () => { srv = await startServer(); });
  after(async () => { if (srv) await srv.stop(); });

  it('starts empty', async () => {
    const r = await srv.get('/api/blocks');
    assert.equal(r.status, 200);
    assert.equal(r.json.text, '');
    assert.deepEqual(r.json.blocks, {});
  });

  it('saves a library and reads it back with its params and step counts', async () => {
    const text = '# shared blocks\nsign-in:\n  params: [phone]\n  steps:\n    - tap: Sign in\n    - input: "{{phone}}"\nclose-banner:\n  - tap: Close\n';
    const r = await srv.put('/api/blocks', { text });
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.blocks.sort(), ['close-banner', 'sign-in']);
    const g = await srv.get('/api/blocks');
    assert.equal(g.json.text, text);
    assert.deepEqual(g.json.blocks['sign-in'], { params: ['phone'], steps: 2 });
    assert.deepEqual(g.json.blocks['close-banner'], { params: [], steps: 1 });
    assert.equal(fs.readFileSync(srv.file('blocks', 'library.yaml'), 'utf8'), text);
  });

  it('refuses a text that is not a map of blocks and keeps the file', async () => {
    const before = fs.readFileSync(srv.file('blocks', 'library.yaml'), 'utf8');
    for (const text of ['just a string', 'a: [unclosed']) {
      const r = await srv.put('/api/blocks', { text });
      assert.equal(r.status, 400, text);
      assert.match(r.json.error, /^block library:/);
    }
    assert.equal(fs.readFileSync(srv.file('blocks', 'library.yaml'), 'utf8'), before);
  });

  it('lets a scenario use a library block without lint errors', async () => {
    await srv.post('/api/scenarios', { name: 'Uses block', steps: [{ type: 'launch' }, { type: 'use', use: 'close-banner' }] });
    assert.deepEqual((await srv.get('/api/scenarios/uses-block/lint')).json.errors, []);
  });
});
