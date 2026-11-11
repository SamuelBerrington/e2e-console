'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const YAML = require('yaml');
const F = require('../../lib/formats');

const ROOT = path.join(__dirname, '..', '..');
const EXAMPLES = path.join(ROOT, 'examples');
const FIXTURES = path.join(__dirname, '..', 'fixtures', 'unit');
const file = (p) => ({ name: path.basename(p), content: fs.readFileSync(p, 'utf8') });
const clone = (x) => JSON.parse(JSON.stringify(x));

// ---------- native YAML round trip ----------
for (const name of ['scenario.yaml', 'scenario-advanced.yaml']) {
  test(`YAML round trip of examples/${name} is lossless`, () => {
    const first = F.parseImport([file(path.join(EXAMPLES, name))]);
    assert.deepEqual(first.warnings, []);
    assert.equal(first.scenarios.length, 1);
    const sc = first.scenarios[0];
    const yaml = F.exportScenario(sc);
    const second = F.parseImport([{ name: 'again.yaml', content: yaml }]);
    assert.deepEqual(second.warnings, []);
    assert.deepEqual(second.scenarios[0], sc);
    // the exported text is accepted by the strict editor save too (its header comment is ignored)
    assert.deepEqual(F.parseImport([{ name: 'again.yaml', content: yaml }], { strict: true }).errors, []);
  });
}

test('examples/scenario-advanced.yaml keeps every language feature through the trip', () => {
  const sc = F.parseImport([file(path.join(EXAMPLES, 'scenario-advanced.yaml'))]).scenarios[0];
  assert.deepEqual(Object.keys(sc.matrix), ['delivery', 'payment']);
  assert.deepEqual(sc.rules, { noServerErrors: true, allowStatus: [503] });
  assert.deepEqual(sc.blocks['pick-delivery'].params, ['kind']);
  assert.equal(sc.setup[0].type, 'use');
  const types = sc.steps.map((s) => s.type);
  for (const t of ['use', 'if', 'repeat', 'assertScreen', 'api']) assert.ok(types.includes(t), t);
  assert.deepEqual(sc.steps.find((s) => s.type === 'tap' && s.when).when, { var: 'promo' });
  assert.equal(sc.teardown[0].type, 'if');
});

test('YAML round trip of examples/blocks.yaml is lossless', () => {
  const first = F.parseImport([file(path.join(EXAMPLES, 'blocks.yaml'))]);
  assert.deepEqual(first.warnings, []);
  assert.deepEqual(first.files.map((f) => f.mode), ['blocks']);
  assert.deepEqual(Object.keys(first.blocks), ['reset-cart', 'add-to-cart', 'open-order', 'wait-shipment-state']);
  const bundle = F.exportBundle({ scenarios: [], settings: {}, withSecrets: false, library: first.blocks, allBlocks: true });
  const second = F.parseImport([{ name: 'bundle.yaml', content: bundle }]);
  assert.deepEqual(second.warnings, []);
  assert.deepEqual(second.blocks, first.blocks);
});

test('the advanced example lints clean against the example block library', () => {
  const { lint } = require('../../lib/lint');
  const library = F.parseImport([file(path.join(EXAMPLES, 'blocks.yaml'))]).blocks;
  const sc = F.parseImport([file(path.join(EXAMPLES, 'scenario-advanced.yaml'))]).scenarios[0];
  const r = lint(sc, { library, settings: { accounts: { buyer: {}, courier: {} }, templates: { context: '{}' }, vars: { promo: '' } } });
  assert.deepEqual(r.errors, []);
});

test('short step forms normalise to full steps', () => {
  const steps = F.normalizeSteps(['launch', 'back', { input: 'hello' }, { wait: '2' }, { launch: 'clear' }, { tap: { target: 'A', after: 3 } },
    { browser: [{ tap: 'B' }] }, { repeat: [{ wait: 1 }], times: 2 }, 'hideKeyboard', { maestro: '- back' }]);
  assert.deepEqual(steps, [
    { type: 'launch' }, { type: 'back' }, { type: 'type', text: 'hello' }, { type: 'wait', seconds: 2 }, { type: 'launch', clear: true },
    { type: 'tap', target: 'A', after: 3 }, { type: 'browser', steps: [{ type: 'tap', target: 'B' }] },
    { type: 'repeat', steps: [{ type: 'wait', seconds: 1 }], times: 2 }, { type: 'maestro', commands: ['hideKeyboard'] }, { type: 'maestro', yaml: '- back' }
  ]);
});

// ---------- strict import ----------
test('strict parseImport names the line of a comment, an unknown top-level key and an unclear step', () => {
  const text = ['name: Strict', 'foo: 1', 'steps:', '  # a note', '  - launch', '  - tapp: Login', '  - zork', ''].join('\n');
  const r = F.parseImport([{ name: 's.yaml', content: text }], { strict: true });
  assert.ok(r.errors.some((e) => /^line 4: comment "# a note" would be lost/.test(e)), r.errors.join('\n'));
  assert.ok(r.errors.some((e) => /^line 2: .*unknown key "foo"/.test(e)), r.errors.join('\n'));
  assert.ok(r.errors.some((e) => /^line 6: .*unclear step \{"tapp":"Login"\}/.test(e)), r.errors.join('\n'));
  assert.ok(r.errors.some((e) => /^line 7: .*unclear step "zork"/.test(e)), r.errors.join('\n'));
  assert.equal(r.errors.length, 4);
});

test('strict parseImport names an unknown key inside a variant and a trailing comment', () => {
  const text = 'name: V\nsteps:\n  - launch   # trailing\nvariants:\n  v1: { title: V, colour: red }\n';
  const r = F.parseImport([{ name: 'v.yaml', content: text }], { strict: true });
  assert.ok(r.errors.some((e) => /^line 3: comment "# trailing"/.test(e)), r.errors.join('\n'));
  assert.ok(r.errors.some((e) => /^line 5: .*variant "v1": unknown key "colour"/.test(e)), r.errors.join('\n'));
});

test('non-strict parseImport drops what it cannot keep with a warning and has no errors field', () => {
  const r = F.parseImport([{ name: 's.yaml', content: 'name: S\nfoo: 1\nsteps: [launch, zork]\n' }]);
  assert.equal(r.errors, undefined);
  assert.equal(r.scenarios[0].foo, undefined);
  assert.deepEqual(r.scenarios[0].steps, [{ type: 'launch' }]);
  assert.equal(r.warnings.length, 2);
});

test('a YAML syntax error imports nothing and hints at unquoted {{variables}}', () => {
  const r = F.parseImport([{ name: 'bad.yaml', content: 'name: B\nsteps:\n  - api: { url: a/{{id}}/b }\n' }]);
  assert.deepEqual(r.scenarios, []);
  assert.match(r.warnings[0], /YAML error.*must be quoted/);
});

// `{ target: {{x}} }` is valid YAML: a map whose key is the map {x}. It imports as an object target with no warning
// (lint accepts it too, since a per-platform target is an object), so the run taps on "[object Object]".
test('an unquoted {{var}} that is a whole value inside { … } is reported, not imported as a map key', () => {
  const r = F.parseImport([{ name: 'bad.yaml', content: 'name: B\nsteps:\n  - tap: { target: {{x}}, after: 1 }\n' }]);
  assert.ok(r.warnings.length > 0 || !r.scenarios.length, JSON.stringify(r.scenarios));
});

// ---------- Maestro ----------
test('Maestro flow import of examples/maestro translates what it can and keeps the script', () => {
  const dir = path.join(EXAMPLES, 'maestro');
  const flow = file(path.join(dir, 'catalog.yaml'));
  const script = { name: 'scripts/cart-has-lines.js', content: fs.readFileSync(path.join(dir, 'scripts', 'cart-has-lines.js'), 'utf8') };
  const r = F.parseImport([flow, script]);
  assert.deepEqual(r.warnings, []);
  assert.deepEqual(r.files.map((f) => f.mode), ['maestro', 'script for runScript']);
  const sc = r.scenarios[0];
  assert.equal(sc.engine, 'maestro');
  assert.deepEqual(sc.vars, { PRODUCT: 'demo-123' });
  assert.deepEqual(sc.steps.map((s) => s.type), ['launch', 'tap', 'assertText', 'maestro', 'link', 'tap', 'assertText', 'maestro']);
  assert.equal(sc.steps[4].url, 'https://shop.example.com/p/{{PRODUCT}}');
  assert.equal(sc.steps[6].timeout, 10);
  assert.equal(sc.steps[7].files['scripts/cart-has-lines.js'], script.content);
});

test('Maestro import without the runScript file warns that the step will fail', () => {
  const r = F.parseImport([file(path.join(EXAMPLES, 'maestro', 'catalog.yaml'))]);
  assert.ok(r.warnings.some((w) => /runScript "scripts\/cart-has-lines.js": the file is not among the uploads/.test(w)));
});

test('Maestro import inlines a runFlow subflow and merges tapOn + inputText', () => {
  const main = { name: 'main.yaml', content: 'appId: com.example.fake\n---\n- runFlow: login.yaml\n- pressKey: Back\n' };
  const sub = { name: 'login.yaml', content: 'appId: com.example.fake\n---\n- tapOn: Phone\n- inputText: "000"\n- pressKey: Enter\n' };
  const r = F.parseImport([main, sub]);
  assert.equal(r.scenarios.length, 1);
  assert.deepEqual(r.files.map((f) => f.mode), ['maestro', 'maestro (subflow)']);
  assert.deepEqual(r.scenarios[0].steps, [{ type: 'type', target: 'Phone', text: '000', clear: false, enter: true }, { type: 'back' }]);
});

test('detect tells env, maestro and native apart', () => {
  assert.equal(F.detect('keys.env', 'A=1'), 'env');
  assert.equal(F.detect('x.txt', 'API_BASE=x\nOTHER=y'), 'env');
  assert.equal(F.detect('f.yaml', 'appId: a\n---\n- launchApp\n'), 'maestro');
  assert.equal(F.detect('f.yaml', '- tapOn: A\n- assertVisible: B\n'), 'maestro');
  // a bare list that also has one of our step names (back) stays ours
  assert.equal(F.detect('f.yaml', '- tapOn: A\n- back\n'), 'native');
  assert.equal(F.detect('f.yaml', 'name: x\nsteps: [launch]\n'), 'native');
  assert.equal(F.detect('f.json', '{"steps": []}'), 'native');
});

test('exportMaestro wraps a conditional step in runFlow.when and writes a backend script', () => {
  const sc = { name: 'Flow: a/b', vars: { P: 'x' }, steps: [{ type: 'tap', target: 'A', _cond: undefined, when: { visible: 'Promo' } }, { type: 'api', url: 'api/v1/cart', auth: 'seller' }] };
  const { files } = F.exportMaestro(sc, { package: 'com.example.fake' });
  assert.deepEqual(files.map((f) => f.name), ['flow.yaml', 'scripts/01-get-v1-cart.js']);
  const [header, body] = files[0].content.split('---\n');
  const h = YAML.parse(header);
  assert.equal(h.appId, 'com.example.fake');
  assert.ok(!/[<>:"/\\|?*]/.test(h.name), h.name);
  const cmds = YAML.parse(body);
  assert.deepEqual(cmds[0], { runFlow: { when: { visible: 'Promo' }, commands: [{ tapOn: 'A' }] } });
  assert.match(files[1].content, /'Bearer ' \+ SELLER_TOKEN/);
});

test('exportMaestro expands a settings template in a backend script and hard-codes no request envelope', () => {
  const sc = { name: 'T', steps: [{ type: 'api', method: 'POST', url: 'api/v1/things', headers: { 'x-request-context': '{{envelope}}' }, body: '{"id":"{{uuid}}","note":"{{missing}}"}' }] };
  const templates = { envelope: { request_id: '{{uuid}}', sent_at: '{{now}}', nested: '{{inner}}' }, inner: 'plain-{{hex64}}' };
  const withTemplates = F.exportMaestro(sc, { package: 'com.example.fake', templates }).files[1].content;
  assert.match(withTemplates, /request_id/);
  assert.match(withTemplates, /uuid\(\)/);
  assert.match(withTemplates, /new Date\(\)\.toISOString\(\)/);
  assert.match(withTemplates, /hex\(64\)/, 'a template inside a template is expanded too');
  // the script must be valid JavaScript
  assert.doesNotThrow(() => new Function('http', 'json', 'output', 'API_BASE', 'BUYER_TOKEN', withTemplates));
  // no template in the settings: the placeholder stays a variable the user passes to Maestro, and nothing is invented
  const bare = F.exportMaestro(sc, { package: 'com.example.fake' }).files[1].content;
  assert.match(bare, /typeof envelope !== 'undefined'/);
  assert.ok(!/function ctx\(/.test(bare), 'no built-in request envelope');
});

// ---------- .env ----------
test('.env import of examples/keys.env.example fills settings and wipes nothing with empty values', () => {
  const r = F.parseImport([file(path.join(EXAMPLES, 'keys.env.example'))]);
  assert.deepEqual(r.files.map((f) => f.mode), ['env']);
  assert.deepEqual(r.settings, {
    appName: 'My App · E2E', package: 'com.example.app', activity: 'com.example.app.MainActivity', bundleId: 'com.example.app',
    avd: 'Pixel_8_API_35', apiBase: 'https://api.example.com', envName: 'staging', engine: 'adb'
  });
});

test('.env import maps <ROLE>_PHONE/_TOKEN/_REFRESH_TOKEN/_OTP into accounts and the rest into settings or vars', () => {
  const r = F.parseImport([file(path.join(FIXTURES, 'roles.env'))]);
  assert.deepEqual(r.warnings, []);
  assert.deepEqual(r.settings, {
    apiBase: 'https://api.example.test',
    package: 'com.example.fake',
    envName: 'qa-fake',
    accounts: {
      buyer: { token: 'fake-buyer-token-0001' },
      seller: { token: 'fake-seller-token-0002' },
      courier: { phone: '+10000000003', refreshToken: 'fake-courier-refresh-0003', otp: '000000' }
    },
    auth: { plugin: 'plugins/fake-auth.js' },
    appNet: { tag: 'FakeNet' },
    maestro: { javaHome: '/opt/fake-jdk' },
    vars: { PRODUCT_SLUG: 'fake-product' }
  });
});

test('.env import moves old flat token keys into accounts', () => {
  const r = F.parseImport([{ name: 'old.env', content: 'apiToken=fake-a\nsellerRefreshToken=fake-b\nrefreshToken=\n' }]);
  assert.deepEqual(r.settings, { accounts: { buyer: { token: 'fake-a' }, seller: { refreshToken: 'fake-b' } } });
});

// ---------- export without keys ----------
// every field carries a recognisable dummy; the machine's and the person's ones must not leave in a keyless export
const MACHINE_OR_PERSONAL = {
  adbPath: '/DUMMY-ADB-PATH/adb', emulatorPath: '/DUMMY-EMU-PATH/emulator', avd: 'DUMMY-AVD-NAME', serial: 'DUMMY-SERIAL-5554',
  apkPath: '/DUMMY-APK-PATH/app.apk', apiToken: 'DUMMY-API-TOKEN', sellerToken: 'DUMMY-SELLER-TOKEN', figmaToken: 'DUMMY-FIGMA-TOKEN',
  refreshToken: 'DUMMY-REFRESH-TOKEN', sellerRefreshToken: 'DUMMY-SELLER-REFRESH',
  maestro: { path: '/DUMMY-MAESTRO-PATH/maestro', javaHome: '/DUMMY-JAVA-HOME' },
  web: { browserPath: '/DUMMY-BROWSER-PATH/chrome' },
  logs: { kubeconfig: '/DUMMY-KUBECONFIG' },
  devices: [{ serial: 'DUMMY-DEVICE-SERIAL', platform: 'android', name: 'DUMMY-DEVICE-NAME' }],
  perf: { reference: { name: 'DUMMY-PERF-PHONE', score: 1000 }, k: { app: 0.5 } },
  auth: { plugin: '/DUMMY-ABS-PLUGIN/auth.js' },
  accounts: {
    buyer: { phone: '+10000000001', otp: 'DUMMY-OTP-ONE', token: 'DUMMY-ACC-TOKEN-1', refreshToken: 'DUMMY-ACC-REFRESH-1' },
    courier: { phone: '+10000000002', token: 'DUMMY-ACC-TOKEN-2' }
  },
  vars: { phone: '+10000000004', sellerPhone: 'DUMMY-SELLER-PHONE', otp: 'DUMMY-VAR-OTP', apiKey: 'DUMMY-VAR-APIKEY', userPassword: 'DUMMY-VAR-PASSW',
    contactNumber: '+1 (000) 000-0005', clientSecret: 'DUMMY-VAR-SECRET' }
};
const PORTABLE = {
  package: 'com.portable.pkg', activity: 'com.portable.Main', bundleId: 'com.portable.ios', appName: 'Portable App', envName: 'portable-env',
  apiBase: 'https://portable.example.test', engine: 'maestro', webUrl: 'https://web.portable.example.test', autoToken: true,
  templates: { context: '{"portable":1}' }, allowStatus: [599], screenIgnore: [[1, 2, 3, 4]], backendIgnore: ['portable-ignore'],
  emulatorHygiene: ['stop portable.service'], tabs: [{ id: 'portable-tab', name: 'Portable tab' }],
  appNet: { tag: 'PortableTag' }, runs: { screenshots: 'latest' },
  web: { headless: false, width: 1111, height: 2222 },
  logs: { enabled: true, namespace: 'portable-ns', service: 'portable-svc', port: 9999, filter: 'portable-filter', limit: 77 },
  auth: { appAccount: 'courier' },
  vars: { product: 'portable-product', count: '12' }
};
const dummySettings = () => {
  const s = clone(MACHINE_OR_PERSONAL);
  for (const [k, v] of Object.entries(clone(PORTABLE))) s[k] = v && typeof v === 'object' && !Array.isArray(v) && s[k] ? { ...s[k], ...v } : v;
  return s;
};
const leaves = (o, out = []) => {
  if (o && typeof o === 'object') Object.values(o).forEach((v) => leaves(v, out));
  else if (typeof o === 'string') out.push(o);
  return out;
};

test('a keyless export carries no machine paths, serials, phones, OTPs or tokens', () => {
  const settings = dummySettings();
  const text = F.exportBundle({ scenarios: [], settings, withSecrets: false });
  for (const v of leaves(MACHINE_OR_PERSONAL)) assert.ok(!text.includes(v), `leaked: ${v}`);
  const doc = YAML.parse(text);
  assert.equal(doc.secrets, undefined);
  assert.equal(doc.kind, 'e2e-console/bundle');
});

test('a keyless export carries the portable settings and the account names', () => {
  const doc = YAML.parse(F.exportBundle({ scenarios: [], settings: dummySettings(), withSecrets: false }));
  const s = doc.settings;
  for (const k of ['package', 'activity', 'bundleId', 'appName', 'envName', 'apiBase', 'engine', 'webUrl', 'autoToken', 'templates', 'allowStatus',
    'screenIgnore', 'backendIgnore', 'emulatorHygiene', 'tabs', 'appNet', 'runs']) assert.deepEqual(s[k], PORTABLE[k], k);
  assert.deepEqual(s.web, PORTABLE.web);
  assert.deepEqual(s.logs, PORTABLE.logs);
  assert.deepEqual(s.auth, { appAccount: 'courier' });
  assert.deepEqual(s.vars, PORTABLE.vars);
  assert.deepEqual(s.accounts, { buyer: {}, courier: {} });
});

test('a relative auth plugin path travels in a keyless export', () => {
  const doc = YAML.parse(F.exportBundle({ scenarios: [], settings: { auth: { plugin: 'plugins/auth.js' } }, withSecrets: false }));
  assert.deepEqual(doc.settings.auth, { plugin: 'plugins/auth.js' });
});

test('an export with keys carries the tokens, account secrets and personal vars, and imports back', () => {
  // settings on disk are migrated at start (no flat apiToken & co.), so the bundle is made from migrated ones
  const settings = dummySettings();
  for (const k of ['apiToken', 'sellerToken', 'refreshToken', 'sellerRefreshToken']) delete settings[k];
  const text = F.exportBundle({ scenarios: [], settings, withSecrets: true });
  const doc = YAML.parse(text);
  assert.equal(doc.secrets.figmaToken, 'DUMMY-FIGMA-TOKEN');
  assert.deepEqual(doc.secrets.accounts, MACHINE_OR_PERSONAL.accounts);
  assert.deepEqual(Object.keys(doc.secrets.vars).sort(), Object.keys(MACHINE_OR_PERSONAL.vars).sort());
  // machine paths stay out even with keys
  assert.ok(!text.includes('/DUMMY-ADB-PATH/adb'));
  assert.ok(!text.includes('DUMMY-DEVICE-SERIAL'));
  const back = F.parseImport([{ name: 'b.yaml', content: text }]).settings;
  assert.deepEqual(back.accounts.buyer, MACHINE_OR_PERSONAL.accounts.buyer);
  assert.equal(back.figmaToken, 'DUMMY-FIGMA-TOKEN');
  assert.equal(back.vars.product, 'portable-product');
  assert.equal(back.vars.apiKey, 'DUMMY-VAR-APIKEY');
});

test('personal vars are told apart by name and by a phone-like value', () => {
  const vars = { phone: 'x', OTP_CODE: 'x', myToken: 'x', db_passwd: 'x', API_KEY: 'x', digits: '+1 (000) 000-0000', shortNumber: '12345', name: 'Ann' };
  const doc = YAML.parse(F.exportBundle({ scenarios: [], settings: { vars }, withSecrets: true }));
  assert.deepEqual(Object.keys(doc.settings.vars).sort(), ['name', 'shortNumber']);
  assert.deepEqual(Object.keys(doc.secrets.vars).sort(), ['API_KEY', 'OTP_CODE', 'db_passwd', 'digits', 'myToken', 'phone']);
});

// ---------- blocks in a bundle ----------
test('usedBlocks follows nested use: through the library and ignores shadowed and unknown blocks', () => {
  const library = {
    a: { steps: [{ type: 'use', use: 'b' }] }, b: { steps: [{ type: 'if', if: { visible: 'x' }, then: [{ type: 'use', use: 'c' }] }] },
    c: { steps: [] }, own: { steps: [{ type: 'use', use: 'd' }] }, d: { steps: [] }, unused: { steps: [] }, v: { steps: [] }
  };
  const scenarios = [{ blocks: { own: { steps: [] } }, steps: [{ type: 'use', use: 'a' }, { type: 'use', use: 'own' }, { type: 'use', use: 'ghost' }],
    variants: { lite: { setup: [{ type: 'repeat', steps: [{ type: 'use', use: 'v' }] }] } } }];
  assert.deepEqual(F.usedBlocks(scenarios, library), ['a', 'b', 'c', 'v']);
});

test('exportBundle carries only the used blocks unless allBlocks is set', () => {
  const library = { used: { steps: [{ type: 'back' }] }, idle: { steps: [{ type: 'back' }] } };
  const scenarios = [{ name: 'S', steps: [{ type: 'use', use: 'used' }] }];
  assert.deepEqual(Object.keys(YAML.parse(F.exportBundle({ scenarios, settings: {}, library })).blocks), ['used']);
  assert.deepEqual(Object.keys(YAML.parse(F.exportBundle({ scenarios, settings: {}, library, allBlocks: true })).blocks), ['idle', 'used']);
});

// ---------- migrateLegacy ----------
test('migrateLegacy returns a falsy value when there is nothing to migrate', () => {
  assert.ok(!F.migrateLegacy({ accounts: { buyer: { token: 't' } }, vars: { phone: '+10000000000' } }));
  assert.ok(!F.migrateLegacy({}));
  assert.ok(!F.migrateLegacy(null));
});

test('migrateLegacy moves flat tokens into accounts and removes them', () => {
  const saved = { apiToken: 'fake-at', refreshToken: 'fake-rt', sellerToken: 'fake-st', sellerRefreshToken: 'fake-srt', vars: { phone: '+10000000001', sellerPhone: '+10000000002', otp: '000000' }, appName: 'keep' };
  const before = clone(saved);
  const next = F.migrateLegacy(saved);
  assert.deepEqual(saved, before, 'the input is not mutated');
  for (const k of ['apiToken', 'refreshToken', 'sellerToken', 'sellerRefreshToken']) assert.ok(!(k in next), k);
  assert.deepEqual(next.accounts, {
    buyer: { phone: '+10000000001', token: 'fake-at', refreshToken: 'fake-rt', otp: '000000' },
    seller: { phone: '+10000000002', token: 'fake-st', refreshToken: 'fake-srt', otp: '000000' }
  });
  assert.equal(next.appName, 'keep');
});

test('migrateLegacy fills only empty fields: existing account values win', () => {
  const next = F.migrateLegacy({ apiToken: 'fake-old', refreshToken: 'fake-old-rt', accounts: { buyer: { token: 'fake-current', refreshToken: '' } } });
  assert.deepEqual(next.accounts.buyer, { token: 'fake-current', refreshToken: 'fake-old-rt' });
  assert.ok(!('apiToken' in next) && !('refreshToken' in next));
});

test('migrateLegacy does not resurrect a deleted role when accounts exist', () => {
  const next = F.migrateLegacy({ sellerToken: 'fake-leftover', accounts: { buyer: { token: 'fake-b' } } });
  assert.deepEqual(next.accounts, { buyer: { token: 'fake-b' } });
  assert.ok(!('sellerToken' in next));
});

test('migrateLegacy drops empty flat keys without creating accounts for them', () => {
  const next = F.migrateLegacy({ apiToken: '', sellerToken: '' });
  assert.ok(next);
  assert.deepEqual(next, { accounts: {} });
});

test('splitAccounts keeps role names in the plain part and non-empty values in the secret part', () => {
  assert.deepEqual(F.splitAccounts({ a: { token: 't', phone: '' }, b: {}, c: null }), { plain: { a: {}, b: {} }, secret: { a: { token: 't' } } });
  assert.deepEqual(F.splitAccounts(undefined), {});
});
