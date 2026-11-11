'use strict';
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const YAML = require('yaml');
const { startServer, EXE } = require('./helpers');

// recognisable dummies: what a keyless export must never carry, and what the export with keys carries
const MACHINE = {
  adbPath: 'DUMMYPATH-adb',
  emulatorPath: 'DUMMYPATH-emulator',
  apkPath: 'DUMMYPATH-apk',
  avd: 'DUMMYAVD-pixel',
  serial: 'DUMMYSERIAL-0001',
  device: 'DUMMYSERIAL-0002',
  maestroPath: 'DUMMYPATH-maestro',
  javaHome: 'DUMMYPATH-java',
  browserPath: 'DUMMYPATH-browser',
  kubeconfig: 'DUMMYPATH-kubeconfig'
};
const PERSONAL = {
  buyerPhone: '+10000000077',
  buyerOtp: 'DUMMYOTP-111111',
  buyerToken: 'DUMMYTOKEN-buyer-access',
  buyerRefresh: 'DUMMYTOKEN-buyer-refresh',
  sellerPhone: '+10000000088',
  apiToken: 'DUMMYTOKEN-api',
  sellerToken: 'DUMMYTOKEN-seller',
  figmaToken: 'DUMMYTOKEN-figma',
  varPhone: '+10000000099',
  varOtp: 'DUMMYOTP-222222',
  varSecret: 'DUMMYTOKEN-var-secret'
};

function fullSettings(root) {
  // the machine paths are real-looking paths that do not exist, so nothing ever runs them
  const p = (name) => path.join(root, 'nowhere', name);
  return {
    adbPath: p(MACHINE.adbPath + EXE),
    emulatorPath: p(MACHINE.emulatorPath),
    apkPath: p(MACHINE.apkPath + '.apk'),
    avd: MACHINE.avd,
    serial: MACHINE.serial,
    devices: [{ serial: MACHINE.device, platform: 'android', name: 'Test phone' }],
    package: 'org.example.app',
    activity: '.Main',
    bundleId: 'org.example.ios',
    appName: 'Sample',
    envName: 'stage',
    apiBase: 'http://127.0.0.1:9/api',
    engine: 'adb',
    webUrl: 'http://127.0.0.1:9/site',
    autoToken: true,
    apiToken: PERSONAL.apiToken,
    sellerToken: PERSONAL.sellerToken,
    figmaToken: PERSONAL.figmaToken,
    accounts: {
      buyer: { phone: PERSONAL.buyerPhone, otp: PERSONAL.buyerOtp, token: PERSONAL.buyerToken, refreshToken: PERSONAL.buyerRefresh },
      seller: { phone: PERSONAL.sellerPhone }
    },
    vars: { region: 'north-open', phone: PERSONAL.varPhone, otp: PERSONAL.varOtp, apiSecret: PERSONAL.varSecret, contact: '+1 000 000 0055' },
    templates: { greeting: 'hello' },
    maestro: { path: p(MACHINE.maestroPath), javaHome: p(MACHINE.javaHome) },
    web: { browserPath: p(MACHINE.browserPath + EXE), headless: false, width: 1000, height: 700, locale: 'de-DE' },
    auth: { plugin: path.join(root, 'nowhere', 'DUMMYPATH-plugin.js'), appAccount: 'buyer' },
    logs: { enabled: true, kubeconfig: p(MACHINE.kubeconfig), namespace: 'ns-open', service: 'svc-open', port: 9428, filter: '', limit: 10 },
    appNet: { tag: 'NetTag' },
    runs: { screenshots: 'latest' },
    emulatorHygiene: ['stop vendor.dummy'],
    allowStatus: [418],
    tabs: [{ id: 'smoke', name: 'Smoke', kind: 'tests' }],
    perf: { k: { app: 1.5 }, reference: { serial: MACHINE.serial } }
  };
}

const LIBRARY = '# shared blocks\nclose-banner:\n  steps:\n    - tap: Close\nsign-in:\n  params: [phone]\n  steps:\n    - tap: Sign in\n    - input: "{{phone}}"\n';

describe('export', () => {
  let srv;
  before(async () => {
    srv = await startServer();
    const r = await srv.put('/api/settings', fullSettings(srv.root));
    assert.equal(r.status, 200);
    await srv.put('/api/blocks', { text: LIBRARY });
    await srv.post('/api/scenarios', { name: 'Export one', steps: [{ type: 'launch' }, { type: 'use', use: 'close-banner' }] });
  });
  after(async () => { if (srv) await srv.stop(); });

  it('the keyless export carries no machine paths, serials, phones, OTPs or tokens', async () => {
    const r = await srv.get('/api/export');
    assert.equal(r.status, 200);
    assert.match(r.headers['content-disposition'], /e2e-bundle\.yaml/);
    for (const [k, v] of Object.entries({ ...MACHINE, ...PERSONAL, plugin: 'DUMMYPATH-plugin' })) assert.ok(!r.text.includes(v), `${k} (${v}) leaked into the keyless export`);
    assert.ok(!r.text.includes('0055'), 'a phone-like variable leaked');
    assert.ok(!/secrets:/.test(r.text));
  });

  it('the keyless export carries the portable settings, the role names, the open variables and the whole library', async () => {
    const doc = YAML.parse((await srv.get('/api/export')).text);
    assert.equal(doc.kind, 'e2e-console/bundle');
    assert.equal(doc.settings.package, 'org.example.app');
    assert.equal(doc.settings.apiBase, 'http://127.0.0.1:9/api');
    assert.deepEqual(doc.settings.accounts, { buyer: {}, seller: {} });
    assert.deepEqual(doc.settings.vars, { region: 'north-open' });
    assert.deepEqual(doc.settings.web, { headless: false, width: 1000, height: 700 });
    assert.deepEqual(doc.settings.logs, { enabled: true, namespace: 'ns-open', service: 'svc-open', port: 9428, limit: 10 });
    assert.deepEqual(doc.settings.auth, { appAccount: 'buyer' }, 'an absolute plugin path stays on this machine');
    assert.deepEqual(Object.keys(doc.blocks).sort(), ['close-banner', 'sign-in']);
    assert.deepEqual(doc.scenarios.map((s) => s.id), ['export-one']);
  });

  it('the export with keys carries phones, OTPs and tokens but still no machine paths or serials', async () => {
    const r = await srv.get('/api/export?secrets=1');
    assert.match(r.headers['content-disposition'], /with-keys/);
    for (const [k, v] of Object.entries(PERSONAL)) assert.ok(r.text.includes(v), `${k} is missing from the export with keys`);
    for (const [k, v] of Object.entries(MACHINE)) assert.ok(!r.text.includes(v), `${k} (${v}) leaked into the export with keys`);
    const doc = YAML.parse(r.text);
    assert.equal(doc.secrets.accounts.buyer.refreshToken, PERSONAL.buyerRefresh);
    assert.equal(doc.secrets.vars.phone, PERSONAL.varPhone);
  });

  it('an export of chosen ids carries only the blocks they use', async () => {
    const doc = YAML.parse((await srv.get('/api/export?ids=export-one')).text);
    assert.deepEqual(Object.keys(doc.blocks), ['close-banner']);
  });
});

describe('import of a bundle with blocks', () => {
  let srv;
  const bundle = (blocks) => YAML.stringify({ kind: 'e2e-console/bundle', version: 1, blocks, scenarios: [{ id: 'imported-one', name: 'Imported one', steps: [{ launch: 'clear' }, { use: 'brand-new' }] }] });
  const blocks = {
    'close-banner': { steps: [{ tap: 'Close' }] },
    'sign-in': { params: ['phone'], steps: [{ tap: 'Log in' }] },
    'brand-new': { steps: [{ wait: 1 }] }
  };
  before(async () => {
    srv = await startServer();
    await srv.put('/api/blocks', { text: LIBRARY });
  });
  after(async () => { if (srv) await srv.stop(); });

  it('previews each block as new, same or changed and writes nothing', async () => {
    const libBefore = fs.readFileSync(srv.file('blocks', 'library.yaml'), 'utf8');
    const r = await srv.post('/api/import', { files: [{ name: 'bundle.yaml', content: bundle(blocks) }] });
    assert.equal(r.status, 200);
    assert.equal(r.json.preview, true);
    const st = Object.fromEntries(r.json.blocks.map((b) => [b.name, b.status]));
    assert.deepEqual(st, { 'close-banner': 'same', 'sign-in': 'changed', 'brand-new': 'new' });
    assert.equal(fs.readFileSync(srv.file('blocks', 'library.yaml'), 'utf8'), libBefore);
    assert.deepEqual(fs.readdirSync(srv.file('scenarios')), []);
  });

  it('adds the new block, leaves the same one alone and keeps the changed one with a warning', async () => {
    const r = await srv.post('/api/import', { files: [{ name: 'bundle.yaml', content: bundle(blocks) }], apply: true });
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.blocksSaved, ['brand-new']);
    assert.deepEqual(r.json.blocksKept, ['sign-in']);
    assert.ok(r.json.warnings.some((w) => /block "sign-in" differs/.test(w)));
    const lib = (await srv.get('/api/blocks')).json;
    assert.deepEqual(Object.keys(lib.blocks).sort(), ['brand-new', 'close-banner', 'sign-in']);
    assert.equal(lib.blocks['sign-in'].steps, 2, 'the local version stays');
    assert.ok(lib.text.startsWith('# shared blocks'), 'the comments of the library survive the write');
    assert.deepEqual(r.json.saved.map((s) => s.id), ['imported-one']);
  });

  it('replaces the changed block when replace is chosen for it', async () => {
    const r = await srv.post('/api/import', { files: [{ name: 'bundle.yaml', content: bundle(blocks) }], apply: true, blocks: { 'sign-in': 'replace' } });
    assert.deepEqual(r.json.blocksSaved, ['sign-in']);
    const lib = (await srv.get('/api/blocks')).json;
    assert.equal(lib.blocks['sign-in'].steps, 1);
    assert.deepEqual(r.json.saved.map((s) => s.id), ['imported-one-2'], 'a scenario id clash makes a copy by default');
  });

  it('replaces a scenario with the same id when onConflict is replace', async () => {
    const r = await srv.post('/api/import', { files: [{ name: 'bundle.yaml', content: bundle(blocks) }], apply: true, onConflict: 'replace' });
    assert.deepEqual(r.json.saved.map((s) => [s.id, s.replaced]), [['imported-one', true]]);
  });

  it('refuses an import with no files', async () => {
    const r = await srv.post('/api/import', { files: [] });
    assert.equal(r.status, 400);
  });
});

describe('keyless export into a second console', () => {
  let a;
  let b;
  before(async () => {
    a = await startServer();
    await a.put('/api/settings', { package: 'org.example.app', accounts: { buyer: { phone: PERSONAL.buyerPhone, token: PERSONAL.buyerToken } }, vars: { region: 'north-open' } });
    await a.put('/api/blocks', { text: LIBRARY });
    await a.post('/api/scenarios', { name: 'First', description: 'one', tags: ['tests'], steps: [{ type: 'launch', clear: true }, { type: 'use', use: 'sign-in', with: { phone: '{{phone}}' } }, { type: 'assertText', text: 'Done' }] });
    await a.post('/api/scenarios', { name: 'Second', engine: 'web', steps: [{ type: 'launch', url: '/' }, { type: 'if', if: { visible: 'Banner' }, then: [{ type: 'use', use: 'close-banner' }] }] });
    b = await startServer();
  });
  after(async () => {
    if (a) await a.stop();
    if (b) await b.stop();
  });

  it('reproduces the scenarios and the blocks', async () => {
    const text = (await a.get('/api/export')).text;
    const r = await b.post('/api/import', { files: [{ name: 'e2e-bundle.yaml', content: text }], apply: true });
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(r.json.warnings, []);
    const strip = (list) => list.map(({ order, ...s }) => s).sort((x, y) => x.id.localeCompare(y.id));
    assert.deepEqual(strip((await b.get('/api/scenarios')).json), strip((await a.get('/api/scenarios')).json));
    const la = (await a.get('/api/blocks')).json.blocks;
    const lb = (await b.get('/api/blocks')).json.blocks;
    assert.deepEqual(lb, la);
    const sb = (await b.get('/api/settings')).json;
    assert.equal(sb.package, 'org.example.app');
    assert.deepEqual(sb.accounts, { buyer: {} }, 'the role comes over without its phone or token');
    assert.equal(sb.vars.region, 'north-open');
    assert.ok(sb.adbPath.includes('no-such-sdk'), 'the second console keeps its own adb path');
  });

  it('a second import of the same bundle reports every block as the same', async () => {
    const text = (await a.get('/api/export')).text;
    const r = await b.post('/api/import', { files: [{ name: 'e2e-bundle.yaml', content: text }] });
    assert.ok(r.json.blocks.every((x) => x.status === 'same'), JSON.stringify(r.json.blocks));
    assert.deepEqual(r.json.scenarios.map((s) => s.conflict).sort(), ['first', 'second']);
  });
});
