'use strict';
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { startServer, readJsonFile, tempRoot, EXE } = require('./helpers');

describe('settings defaults', () => {
  let srv;
  let sdk;
  // no settings.json at all; ANDROID_HOME points at an SDK folder whose adb is only an empty file
  before(async () => {
    const root = tempRoot();
    sdk = path.join(root, 'fake-sdk');
    fs.mkdirSync(path.join(sdk, 'platform-tools'), { recursive: true });
    fs.writeFileSync(path.join(sdk, 'platform-tools', 'adb' + EXE), '');
    srv = await startServer({ root, settings: false, env: { ANDROID_HOME: sdk, ANDROID_SDK_ROOT: '' } });
  });
  after(async () => { if (srv) await srv.stop(); });

  it('returns the defaults on an empty data folder without creating settings.json', async () => {
    const r = await srv.get('/api/settings');
    assert.equal(r.status, 200);
    const s = r.json;
    assert.deepEqual(s.runs, { screenshots: 'all' });
    assert.equal(s.engine, 'adb');
    assert.deepEqual(s.accounts, {});
    assert.deepEqual(s.tabs, []);
    assert.deepEqual(s.web, { browserPath: '', headless: true, width: 1280, height: 800, locale: '' });
    assert.equal(s.logs.enabled, false);
    assert.equal(fs.existsSync(srv.file('settings.json')), false);
  });

  it('resolves the default adbPath from ANDROID_HOME/platform-tools', async () => {
    const s = (await srv.get('/api/settings')).json;
    assert.equal(s.adbPath, path.join(sdk, 'platform-tools', 'adb' + EXE));
  });
});

describe('settings updates', () => {
  let srv;
  before(async () => { srv = await startServer(); });
  after(async () => { if (srv) await srv.stop(); });

  it('merges nested groups key by key on PUT', async () => {
    let r = await srv.put('/api/settings', { web: { width: 1024 }, logs: { namespace: 'ns-a' }, runs: { screenshots: 'latest' } });
    assert.equal(r.status, 200);
    r = await srv.put('/api/settings', { web: { height: 600 }, logs: { service: 'svc-a' } });
    const s = r.json;
    assert.equal(s.web.width, 1024);
    assert.equal(s.web.height, 600);
    assert.equal(s.web.headless, true);
    assert.ok(s.web.browserPath.includes('no-such-browser'), 'the hermetic browser path survives the merge');
    assert.equal(s.logs.namespace, 'ns-a');
    assert.equal(s.logs.service, 'svc-a');
    assert.equal(s.logs.port, 9428);
    assert.equal(s.runs.screenshots, 'latest');
    const disk = readJsonFile(srv.file('settings.json'));
    assert.deepEqual(disk.web.width, 1024);
    assert.equal(disk.logs.namespace, 'ns-a');
  });

  it('keeps flat keys it was not sent', async () => {
    await srv.put('/api/settings', { appName: 'Sample App', package: 'org.example.sample' });
    const s = (await srv.put('/api/settings', { envName: 'stage-x' })).json;
    assert.equal(s.appName, 'Sample App');
    assert.equal(s.package, 'org.example.sample');
    assert.equal(s.envName, 'stage-x');
  });

  it('keeps a role\'s refreshToken when the role is renamed with renamedFrom', async () => {
    await srv.put('/api/settings', { accounts: { alpha: { phone: '+10000000001', refreshToken: 'rt-dummy-alpha' } }, auth: { appAccount: 'alpha' } });
    // the UI table does not show refreshToken: it sends the renamed row without it
    const s = (await srv.put('/api/settings', { accounts: { beta: { phone: '+10000000001', renamedFrom: 'alpha' } } })).json;
    assert.deepEqual(Object.keys(s.accounts), ['beta']);
    assert.equal(s.accounts.beta.refreshToken, 'rt-dummy-alpha');
    assert.equal(s.accounts.beta.renamedFrom, undefined);
    assert.equal(s.auth.appAccount, 'beta', 'the app account follows its role');
  });

  it('deletes a role left out of the accounts table, and it stays deleted', async () => {
    await srv.put('/api/settings', { accounts: { one: { phone: '+10000000002' }, two: { phone: '+10000000003' } } });
    await srv.put('/api/settings', { accounts: { one: { phone: '+10000000002' } } });
    await srv.put('/api/settings', { envName: 'unrelated change' });
    const s = (await srv.get('/api/settings')).json;
    assert.deepEqual(Object.keys(s.accounts), ['one']);
    assert.equal(readJsonFile(srv.file('settings.json')).accounts.two, undefined);
  });
});

describe('a damaged settings.json', () => {
  const GARBAGE = '{ "accounts": { "buyer": { "token": "tok-dummy" } }, oops this is not json';
  let srv;
  before(async () => { srv = await startServer({ settingsText: GARBAGE }); });
  after(async () => { if (srv) await srv.stop(); });

  it('does not stop the console from starting', () => {
    assert.ok(srv.alive());
  });

  it('makes GET /api/settings answer an error naming the file', async () => {
    const r = await srv.get('/api/settings');
    assert.equal(r.status, 500);
    assert.match(r.json.error, /settings\.json is damaged/);
  });

  it('refuses PUT /api/settings and leaves the file as it was', async () => {
    const r = await srv.put('/api/settings', { envName: 'x' });
    assert.equal(r.status, 500);
    assert.equal(fs.readFileSync(srv.file('settings.json'), 'utf8'), GARBAGE);
  });

  it('refuses an import that carries settings and leaves the file as it was', async () => {
    const content = 'kind: e2e-console/bundle\nversion: 1\nsettings:\n  envName: imported\nscenarios: []\n';
    const r = await srv.post('/api/import', { files: [{ name: 'b.yaml', content }], apply: true });
    assert.equal(r.status, 500);
    assert.equal(fs.readFileSync(srv.file('settings.json'), 'utf8'), GARBAGE);
  });

  it('logged that the legacy migration could not read the file', () => {
    assert.match(srv.output(), /could not migrate/);
  });

  it('answers again once the file is repaired, without a restart', async () => {
    fs.writeFileSync(srv.file('settings.json'), JSON.stringify({ envName: 'repaired', adbPath: path.join(srv.root, 'no-such-sdk', 'adb' + EXE) }));
    const r = await srv.get('/api/settings');
    assert.equal(r.status, 200);
    assert.equal(r.json.envName, 'repaired');
  });

  it('answers an error when the file is damaged between requests', async () => {
    const bad = '{"envName": "half';
    fs.writeFileSync(srv.file('settings.json'), bad);
    assert.equal((await srv.get('/api/settings')).status, 500);
    assert.equal((await srv.put('/api/settings', { envName: 'y' })).status, 500);
    assert.equal(fs.readFileSync(srv.file('settings.json'), 'utf8'), bad);
  });
});

describe('legacy settings migration at start', () => {
  let srv;
  before(async () => {
    srv = await startServer({
      settings: {
        apiToken: 'tok-dummy-buyer',
        refreshToken: 'rt-dummy-buyer',
        sellerToken: 'tok-dummy-seller',
        sellerRefreshToken: 'rt-dummy-seller',
        vars: { phone: '+10000000010', sellerPhone: '+10000000011', otp: '000000', region: 'north' }
      }
    });
  });
  after(async () => { if (srv) await srv.stop(); });

  it('moves the flat buyer/seller keys into accounts on disk', () => {
    const disk = readJsonFile(srv.file('settings.json'));
    for (const k of ['apiToken', 'refreshToken', 'sellerToken', 'sellerRefreshToken']) assert.equal(k in disk, false, `${k} left the file`);
    assert.deepEqual(disk.accounts.buyer, { phone: '+10000000010', token: 'tok-dummy-buyer', refreshToken: 'rt-dummy-buyer', otp: '000000' });
    assert.deepEqual(disk.accounts.seller, { phone: '+10000000011', token: 'tok-dummy-seller', refreshToken: 'rt-dummy-seller', otp: '000000' });
    assert.equal(disk.vars.region, 'north');
    assert.ok(disk.adbPath.includes('no-such-sdk'), 'other keys stay');
    assert.match(srv.output(), /moved into accounts/);
  });

  it('serves the migrated accounts through the API', async () => {
    const s = (await srv.get('/api/settings')).json;
    assert.deepEqual(Object.keys(s.accounts).sort(), ['buyer', 'seller']);
  });
});

describe('legacy migration with an accounts table', () => {
  let srv;
  before(async () => {
    srv = await startServer({
      settings: { apiToken: 'tok-dummy-old', sellerToken: 'tok-dummy-gone', accounts: { buyer: { phone: '+10000000020', token: 'tok-dummy-new' } } }
    });
  });
  after(async () => { if (srv) await srv.stop(); });

  it('fills only the roles listed, never brings back a deleted one, and keeps filled fields', () => {
    const disk = readJsonFile(srv.file('settings.json'));
    assert.equal('apiToken' in disk, false);
    assert.equal('sellerToken' in disk, false);
    assert.deepEqual(Object.keys(disk.accounts), ['buyer']);
    assert.equal(disk.accounts.buyer.token, 'tok-dummy-new');
  });
});
