'use strict';
// UI strings are Russian wrapped in t(); texts recorded by the server go through tt(). Both live in i18n.js.
const $app = document.getElementById('app');
const $device = document.getElementById('device');
const $toast = document.getElementById('toast');

const STATUS_RU = { passed: 'Прошёл', warned: 'Прошёл с оговоркой', failed: 'Упал', running: 'Идёт', paused: 'Ждёт действия', queued: 'В очереди', stopped: 'Остановлен', skipped: 'Не выполнялся', pending: 'Ждёт' };
const STATUS = new Proxy(STATUS_RU, { get: (o, k) => (k in o ? t(o[k]) : undefined) });
const MARK = { passed: '✓', warned: '⚠', failed: '✕', running: '…', paused: '⏸', queued: '…', skipped: '–', pending: '·' };
const LIVE = ['running', 'paused', 'queued'];
const STEP_TYPES = [
  ['launch', 'Открыть приложение'],
  ['link', 'Открыть ссылку'],
  ['tap', 'Нажать'],
  ['type', 'Ввести текст'],
  ['swipe', 'Пролистать'],
  ['back', 'Назад'],
  ['wait', 'Подождать'],
  ['assertText', 'Проверить экран'],
  ['assertScreen', 'Сравнить с эталоном'],
  ['api', 'Проверить бэкенд'],
  ['use', 'Блок'],
  ['if', 'Если'],
  ['repeat', 'Повторять'],
  ['ai', 'Описать словами'],
  ['maestro', 'Команды Maestro'],
  ['browser', 'В браузере'],
  ['phone', 'На телефоне']
];
let blockNames = [];
let roleNames = [];
// the role an api step without `auth:` runs as — the same rule as defaultRole() in lib/compile.js
let defaultRoleName = 'buyer';
function setRoles(s) {
  roleNames = Object.keys(s.accounts || {});
  const app = (s.auth || {}).appAccount;
  defaultRoleName = app && (!roleNames.length || roleNames.includes(app)) ? app : roleNames[0] || app || 'buyer';
}
let pickedDevice = 'any';
const ENGINES = { adb: 'свой (adb)', maestro: 'Maestro', web: 'браузер' };
const engineName = (e) => t(ENGINES[e] || e || 'adb');
const engineChip = (e) => `<span class="engine ${h(e || 'adb')}">${h(engineName(e))}</span>`;
// which screen a step ran on: the phone (adb / Maestro) or the browser (Playwright)
const SCREENS = { web: 'браузер', phone: 'телефон' };
const screenChip = (sc) => (sc ? `<span class="engine ${sc === 'web' ? 'web' : 'phone-chip'}">${sc === 'web' ? '🖥 ' : '📱 '}${h(t(SCREENS[sc] || sc))}</span>` : '');
// the two shelves a console starts with; the user's own tabs live in settings.tabs
const DEFAULT_TABS = [{ id: 'tests', name: 'Тесты', kind: 'tests' }, { id: 'perf', name: 'Нагрузка', kind: 'perf' }];
const tabsOfSettings = (s) => (Array.isArray(s.tabs) && s.tabs.length ? s.tabs : DEFAULT_TABS.map((x) => ({ ...x, builtin: true })));
let defaultEngine = 'adb';
let editMode = 'form';

let timer = null;
let draft = null;
let selStep = null;
let lastRunJson = '';
// Backend logs of the open run: loaded once per change of its line count, filtered client-side.
const logView = { runId: null, total: -1, lines: [], scope: 'step', level: 'all', service: '', q: '', open: new Set() };
let curRun = null;

function h(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
// only http(s) and same-origin paths may become an href / src: a scenario or run file is not trusted
function safeUrl(u) {
  const s = String(u ?? '').trim();
  return /^(https?:\/\/|\/)/i.test(s) ? s : '#';
}
async function api(method, url, body) {
  // every write says it is JSON (the server refuses other bodies); a GET has nothing to describe
  const res = await fetch(url, { method, headers: body || method !== 'GET' ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(tt(data.error) || 'HTTP ' + res.status);
  return data;
}
function toast(msg) {
  $toast.textContent = msg;
  $toast.classList.add('show');
  clearTimeout(toast.t);
  toast.t = setTimeout(() => $toast.classList.remove('show'), 3500);
}
function when(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const today = new Date();
  const y = new Date(); y.setDate(today.getDate() - 1);
  const tm = d.toLocaleTimeString(LOCALE, { hour: '2-digit', minute: '2-digit' });
  if (d.toDateString() === today.toDateString()) return t('сегодня') + ' ' + tm;
  if (d.toDateString() === y.toDateString()) return t('вчера') + ' ' + tm;
  return d.toLocaleDateString(LOCALE, { day: '2-digit', month: '2-digit' }) + ' ' + tm;
}
function dur(r) {
  if (!r.startedAt) return '';
  const ms = new Date(r.finishedAt || Date.now()) - new Date(r.startedAt);
  const s = Math.max(0, Math.round(ms / 1000));
  return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
}
function badge(r) {
  if (!r) return `<span class="badge none">${t('Не запускался')}</span>`;
  const text = r.status === 'failed' && r.failedStep ? t('Упал на шаге {n}', { n: r.failedStep }) : STATUS[r.status] || r.status;
  return `<span class="badge ${h(r.status)}">${h(text)}</span>`;
}
function poll(fn, ms) {
  clearInterval(timer);
  timer = setInterval(fn, ms);
}

async function refreshDevice() {
  try {
    const [d, s] = await Promise.all([api('GET', '/api/device'), api('GET', '/api/settings')]);
    defaultEngine = s.engine || 'adb';
    const name = s.appName || 'E2E Console';
    document.getElementById('app-name').textContent = name;
    document.title = name;
    const apk = (s.apkPath || '').split(/[\\/]/).pop();
    $device.innerHTML = `
      ${apk ? `<span class="chip mono" title="${h(s.apkPath)}">${h(apk.replace(/\.apk$/, ''))}</span>` : `<a class="chip" href="#/settings">${t('APK не указан')}</a>`}
      <span class="chip">${h(t('Стенд: {env}', { env: s.envName || '—' }))}</span>
      <a class="chip" href="#/settings" title="${t('Движок по умолчанию')}">${h(t('Движок: {e}', { e: engineName(s.engine) }))}</a>
      ${d.devices.length > 1 ? `<label class="chip">${t('Устройство: ')}<select id="dev-pick" style="border:0;background:transparent;font:inherit">${[['any', t('любое свободное')], ...(d.details || []).map((x) => [x.serial, `${x.name}${x.platform === 'ios' ? ' (iOS)' : ''}`]), ['all', t('все сразу')]].map(([v, tx]) => `<option value="${h(v)}" ${pickedDevice === v ? 'selected' : ''}>${h(tx)}</option>`).join('')}</select></label>`
        : d.devices.length ? `<span class="chip">${t('Устройство: ')}${h(d.devices.join(', '))}</span>`
        : `${s.avd ? `<button class="btn small" data-act="emulator">${h(t('Запустить эмулятор {avd}', { avd: s.avd }))}</button>` : `<a class="chip" href="#/settings">${t('Нет устройства — укажи эмулятор (AVD)')}</a>`}`}
      ${d.devices.length && s.apkPath ? `<button class="btn small" data-act="install">${t('Установить APK')}</button>` : ''}
      ${d.browser && d.browser.ok ? `<span class="chip" title="${t('Движок web: Playwright поверх установленного браузера')}">🖥 ${h(d.browser.name)}</span>` : ''}
      <a class="chip" href="#/connect" title="${t('Телефон по Wi-Fi: сопряжение по коду и подключение')}">${t('+ телефон')}</a>
      ${d.queued ? `<span class="chip">${h(t('В очереди: {n}', { n: d.queued }))}</span>` : ''}
      <button class="chip lang" data-act="lang" title="${t('Переключить язык интерфейса')}">${LANG === 'ru' ? 'EN' : 'RU'}</button>`;
    setRoles(s);
    const pick = document.getElementById('dev-pick');
    if (pick) pick.onchange = () => { pickedDevice = pick.value; };
  } catch (e) {
    $device.innerHTML = `<span class="chip bad-ink">${h(e.message)}</span>`;
  }
}

// ---------- list ----------
// the tab shown on the list page, remembered per browser; `tabEdit` = the tab being renamed, or 'new'
let listTab = (() => { try { return localStorage.getItem('e2e.listTab') || ''; } catch { return ''; } })();
let tabEdit = null;
// what the list was last drawn from; the 4 s poll redraws only when it changed
let listSig = '';
// the user is busy on the list: typing, a select or a menu open, a tab being edited — a redraw would wipe it
function listBusy() {
  if (tabEdit) return true;
  if ($app.querySelector('details[open]')) return true;
  const a = document.activeElement;
  return !!(a && $app.contains(a) && a.matches('input, textarea, select'));
}
async function viewList({ poll = false } = {}) {
  const [scenarios, runs, sets] = await Promise.all([api('GET', '/api/scenarios'), api('GET', '/api/runs'), api('GET', '/api/settings').catch(() => ({}))]);
  const sig = JSON.stringify([scenarios, runs, sets.tabs || null, listTab, tabEdit]);
  if (poll && (sig === listSig || listBusy())) return;
  listSig = sig;
  // an empty console opens on the guide, not on an empty table
  if (!scenarios.length) { clearInterval(timer); await viewStart(); return; }
  const week = Date.now() - 7 * 864e5;
  const recent = runs.filter((r) => new Date(r.startedAt) > week);
  const done = recent.filter((r) => ['passed', 'failed'].includes(r.status));
  const ok = done.filter((r) => r.status === 'passed').length;
  const pctOk = done.length ? Math.round((ok / done.length) * 100) : 0;
  const byScenario = (id) => runs.filter((r) => r.scenarioId === id);
  // Tabs. The user makes their own («+»); a scenario names its tab (`tab:`), otherwise it lands by its
  // nature: `measure` or the tag `perf` → the first load tab, everything without `measure` plus anything
  // tagged `tests` → the first tests tab. A load tab shows scores and runs with the measurement on.
  const tags = (s) => (Array.isArray(s.tags) ? s.tags : []);
  const tabs = tabsOfSettings(sets);
  const kindOf = (tb) => tb.kind || 'tests';
  // no tab of that kind left (its only tab was deleted): the scenario falls back to the first tab, never to nowhere
  const firstKind = (k) => (tabs.find((x) => kindOf(x) === k) || tabs[0] || {}).id;
  const tabsOf = (s) => {
    const out = [];
    const own = s.tab ? tabs.find((x) => x.id === s.tab || x.name === s.tab) : null;
    if (own) out.push(own.id);
    // a scenario tagged `perf` keeps its place on the load tab even when it names a tab of its own
    if ((s.measure && !own) || tags(s).includes('perf')) out.push(firstKind('perf'));
    if (!own && (!s.measure || tags(s).includes('tests'))) out.push(firstKind('tests'));
    return [...new Set(out.filter(Boolean))];
  };
  const cur = tabs.find((x) => x.id === listTab) || tabs[0];
  listTab = cur.id;
  const inTab = (tb) => scenarios.filter((s) => tabsOf(s).includes(tb.id));
  const isPerfTab = kindOf(cur) === 'perf';
  const perfList = isPerfTab ? inTab(cur) : [];
  const testList = isPerfTab ? [] : inTab(cur);
  const allPerf = scenarios.filter((s) => s.measure || tags(s).includes('perf')).length;
  const allTests = scenarios.length - scenarios.filter((s) => s.measure && !tags(s).includes('tests')).length;
  const stepsOf = (s) => (s.steps || []).length + (s.setup || []).length + (s.teardown || []).length;
  // a scenario moves to another tab right from its row
  const tabPick = (s) => `<select class="row-tab" data-act="row-tab" data-id="${h(s.id)}" title="${t('Вкладка')}">${tabs.map((tb) => `<option value="${h(tb.id)}" ${tabsOf(s)[0] === tb.id ? 'selected' : ''}>${h(t(tb.name))}</option>`).join('')}</select>`;
  const testRows = testList.map((s) => {
    const rs = byScenario(s.id).filter((r) => !r.measure);
    const last = rs[0];
    const fin = rs.filter((r) => ['passed', 'failed'].includes(r.status));
    const rate = fin.length ? Math.round(fin.filter((r) => r.status === 'passed').length / fin.length * 100) : null;
    return `<tr>
      <td><div class="name">${h(s.name)} ${s.engine ? engineChip(s.engine) : ''}</div><div class="sub">${h(s.description || '')}</div></td>
      <td class="sub">${h(stepsOf(s))}</td>
      <td>${badge(last)}${last ? `<div class="sub">${h(when(last.startedAt))} · ${h(dur(last))}</div>` : ''}</td>
      <td>${rate === null ? '<span class="sub">—</span>' : `<div class="rate"><span class="bar"><i style="width:${rate}%"></i></span>${h(t('{p}% из {n}', { p: rate, n: fin.length }))}</div>`}</td>
      <td class="actions">
        ${tabPick(s)}
        ${last ? `<a href="#/run/${h(last.id)}">${t('Скриншоты')}</a>` : ''}
        <a href="#/edit/${h(s.id)}">${t('Изменить')}</a>
        <button class="btn small" data-act="run" data-id="${h(s.id)}">${t('▶ Запустить')}</button>
      </td></tr>`;
  }).join('');
  // a measured scenario's cells: last measurement (any status) and the latest passed score, for one variant or all
  const measuredCells = (runsOf) => {
    const last = runsOf[0];
    const scored = runsOf.filter((r) => r.status === 'passed' && r.perf && r.perf.score != null);
    return `<td>${last ? `${badge(last)}<div class="sub">${h(when(last.startedAt))}${last.device ? ' · ' + h(last.device) : ''}</div>` : `<span class="badge none">${t('Не мерялся')}</span>`}</td>
      <td>${scored.length ? `${scoreBadge(scored[0].perf.score, tt(scored[0].perf.verdict) || '')} <span class="sub" style="display:inline">· ${h(t('замеров {n}', { n: scored.length }))}</span>` : '<span class="sub">—</span>'}</td>`;
  };
  const perfRows = perfList.map((s) => {
    const measured = byScenario(s.id).filter((r) => r.measure);
    const variants = s.variants && typeof s.variants === 'object' ? Object.entries(s.variants).map(([name, v]) => ({ name, title: (v && v.title) || name })) : [];
    const iters = s.measure && typeof s.measure === 'object' && s.measure.iterations > 1 ? s.measure.iterations : 1;
    const main = `<tr>
      <td><div class="name">${h(s.name)}</div><div class="sub">${s.section ? `<span class="tag">${h(tt(s.section))}</span> ` : ''}${variants.length ? `<span class="tag">${h(t('{n} вариант(а)', { n: variants.length }))}</span> ` : ''}${iters > 1 ? `<span class="tag">×${h(iters)}</span> ` : ''}${h(s.description || '')}</div></td>
      <td class="sub">${h(stepsOf(s))}</td>
      ${measuredCells(measured)}
      <td class="actions">
        ${tabPick(s)}
        ${measured[0] ? `<a href="#/run/${h(measured[0].id)}">${t('Отчёт')}</a>` : ''}
        <a href="#/edit/${h(s.id)}">${t('Изменить')}</a>
        <button class="btn small" data-act="measure" data-id="${h(s.id)}" title="${h(t('Замер: кадры, CPU, память на каждом шаге') + (variants.length ? t('; по серии на каждый вариант') : ''))}">⏱ ${variants.length ? t('Все варианты') : t('Замерить')}</button>
      </td></tr>`;
    // one sub-row per variant: its own last measurement, score and «⏱» for just that variant
    const subs = variants.map((v) => {
      const mine = measured.filter((r) => r.variant === v.name);
      return `<tr class="variant-row">
        <td><div class="sub" style="margin:0;padding-left:14px">↳ ${t('вариант')} <b>${h(v.title)}</b>${v.title !== v.name ? ` <span class="mono">${h(v.name)}</span>` : ''}</div></td>
        <td></td>
        ${measuredCells(mine)}
        <td class="actions">
          ${mine[0] ? `<a href="#/run/${h(mine[0].id)}">${t('Отчёт')}</a>` : ''}
          <button class="btn small" data-act="measure" data-id="${h(s.id)}" data-variant="${h(v.name)}" title="${t('Замерить только этот вариант')}">⏱</button>
        </td></tr>`;
    }).join('');
    return main + subs;
  }).join('');

  $app.innerHTML = `
    <div class="stats">
      <div class="card stat"><div class="k">${t('Сценариев')}</div><div class="v">${scenarios.length} <small>· ${h(t('тестов {a}, нагрузки {b}', { a: allTests, b: allPerf }))}</small></div></div>
      <div class="card stat"><div class="k">${t('Прогонов за неделю')}</div><div class="v">${recent.length}</div></div>
      <div class="card stat"><div class="k">${t('Успешно')}</div><div class="v ok-ink">${ok} <small>· ${pctOk}%</small></div></div>
      <div class="card stat"><div class="k">${t('Упало')}</div><div class="v bad-ink">${done.length - ok}</div></div>
    </div>
    <div class="split">
      <section class="card main">
        <div class="card-head" style="align-items:center">
          <div class="tabs" style="margin:0">
            ${tabs.map((tb) => `<button class="tab ${tb.id === cur.id ? 'on' : ''}" data-act="list-tab" data-tab="${h(tb.id)}">${h(t(tb.name))}<small>${h(t('{n} сценар.', { n: inTab(tb).length }))}${kindOf(tb) === 'perf' ? ' · ⏱' : ''}</small></button>`).join('')}
            <button class="tab tab-add" data-act="tab-edit" data-tab="new" title="${t('Новая вкладка')}">+</button>
            <button class="icon" data-act="tab-edit" data-tab="${h(cur.id)}" title="${t('Переименовать вкладку')}">✎</button>
          </div>
          ${!isPerfTab ? `<div style="display:flex;gap:8px;flex-wrap:wrap">
            <a class="btn small" href="#/import">${t('Импорт')}</a>
            <details class="menu"><summary class="btn small">${t('Экспорт')}</summary><div class="menu-items">
              <a href="/api/export" download>${t('Все сценарии + настройки (YAML)')}<small>${t('без ключей и токенов')}</small></a>
              <a href="/api/export?secrets=1" download>${t('То же с ключами')}<small>${t('Figma, refresh-токены — не коммить')}</small></a>
            </div></details>
            <button class="btn primary small" data-act="run-all" data-ids="${h(testList.map((s) => s.id).join(','))}" ${testList.length ? '' : 'disabled'}>${t('Прогнать все тесты')}</button></div>`
          : `<div style="display:flex;gap:8px;flex-wrap:wrap">
            <a class="btn small" href="#/perf">${t('История и баллы')}</a>
            <button class="btn primary small" data-act="run-all-perf" data-ids="${h(perfList.map((s) => s.id).join(','))}" ${perfList.length ? '' : 'disabled'}>${t('Замерить всё')}</button></div>`}
        </div>
        ${tabEdit ? `<div class="tab-form">
            <input type="text" id="tab-name" placeholder="${t('Название вкладки')}" value="${h(tabEdit === 'new' ? '' : cur.name)}" autocomplete="off">
            <select id="tab-kind"><option value="tests" ${(tabEdit === 'new' ? 'tests' : kindOf(cur)) === 'tests' ? 'selected' : ''}>${t('тесты')}</option><option value="perf" ${tabEdit !== 'new' && kindOf(cur) === 'perf' ? 'selected' : ''}>${t('нагрузка (замеры)')}</option></select>
            <button class="btn small primary" data-act="tab-save" data-tab="${h(tabEdit)}">${t('Сохранить')}</button>
            ${tabEdit !== 'new' && tabs.length > 1 ? `<button class="btn small danger" data-act="tab-del" data-tab="${h(cur.id)}">${t('Удалить вкладку')}</button>` : ''}
            <button class="btn small" data-act="tab-edit" data-tab="">${t('Отмена')}</button>
          </div>` : ''}
        ${!isPerfTab
          ? (testList.length ? `<div class="scroll-x"><table style="min-width: 720px">
              <thead><tr><th>${t('Сценарий')}</th><th>${t('Шагов')}</th><th>${t('Последний прогон')}</th><th>${t('Успешность')}</th><th></th></tr></thead>
              <tbody>${testRows}</tbody></table></div>`
            : `<div class="empty">${t('В этой вкладке пока нет сценариев. Перенеси сюда сценарий селектором «Вкладка» в строке или в редакторе.')} <a href="#/edit/new">${t('Создать первый')}</a></div>`)
          : (perfList.length ? `<div class="scroll-x"><table style="min-width: 720px">
              <thead><tr><th>${t('Сценарий')}</th><th>${t('Шагов')}</th><th>${t('Последний замер')}</th><th>${t('Балл')}</th><th></th></tr></thead>
              <tbody>${perfRows}</tbody></table></div>`
            : `<div class="empty">${t('Нагрузочных сценариев нет: добавь сценарию <span class="mono">measure: true</span> или тег <span class="mono">perf</span>.')}</div>`)}
      </section>
      <aside class="card side">
        <div class="card-head" style="align-items:center"><h2>${t('Последние прогоны')}</h2>${runs.length ? `<details class="menu"><summary class="btn small">${t('Очистить')}</summary><div class="menu-items">
          <button data-act="runs-prune" data-keep="1">${t('Оставить по одному последнему прогону')}<small>${t('на каждый сценарий; остальные удалить')}</small></button>
          <button data-act="runs-prune" data-keep="5">${t('Оставить по пять последних')}<small>${t('на каждый сценарий; остальные удалить')}</small></button>
          <button data-act="runs-prune" data-days="7">${t('Удалить прогоны старше недели')}</button>
          <button data-act="runs-prune" data-keep="1" data-what="screenshots">${t('Удалить только старые скриншоты')}<small>${t('история прогонов останется; у последнего прогона сценария скриншоты целы')}</small></button>
        </div></details>` : ''}</div>
        <div class="runs-list">${runs.slice(0, 12).map((r) => `
          <a href="#/run/${h(r.id)}${r.backendIssues ? '/issues' : ''}"><span class="dot ${h(r.status)}" aria-hidden="true"></span>
            <span><span class="name" style="font-weight:500">${h(tt(r.scenarioName))}</span>
            <span class="sub" style="display:block">#${h(r.number || '')} · ${r.status === 'failed' ? h(t('упал на шаге {n}', { n: r.failedStep || '?' })) : h(STATUS[r.status]) + (r.total ? ' · ' + h(r.passedSteps) + '/' + h(r.total) : '')}${r.perf && r.perf.score != null ? ' · ' + h(t('балл {n}', { n: r.perf.score })) : ''}${r.device ? ' · ' + h(r.device) : ''} · ${h(when(r.startedAt))}${r.backendIssues ? ` · <span class="bad-ink" data-issues="${h(r.id)}">${h(t('замечаний к бэкенду {n} →', { n: r.backendIssues }))}</span>` : ''}${r.logs && r.logs.errors ? ` · <span class="bad-ink">${h(t('ошибок в логах {n}', { n: r.logs.errors }))}</span>` : ''}</span></span></a>`).join('')
          || `<div class="empty">${t('Прогонов ещё не было')}</div>`}</div>
      </aside>
    </div>`;
}

// ---------- backend logs ----------
const ERR = new Set(['ERROR', 'FATAL']);
const WARN = new Set(['WARN', 'WARNING']);

// A line belongs to the step that was running when it was written; anything before the
// first step goes to step 1, anything after the last step to the last one that ran.
function stepOfLine(steps, tm) {
  const ts = new Date(tm).getTime();
  let idx = 0;
  steps.forEach((s, i) => { if (s.startedAt && new Date(s.startedAt).getTime() <= ts) idx = i; });
  return idx;
}
async function loadLogs(r) {
  const total = r.logs ? r.logs.total : 0;
  if (logView.runId === r.id && logView.total === total) return;
  logView.lines = total ? await api('GET', `/api/runs/${encodeURIComponent(r.id)}/logs`) : [];
  logView.lines.forEach((l, i) => { l.i = i; l.step = stepOfLine(r.steps, l.t); });
  if (logView.runId !== r.id) { logView.open.clear(); logView.service = ''; logView.q = ''; }
  logView.runId = r.id;
  logView.total = total;
}
function stepErrorCounts() {
  const c = {};
  for (const l of logView.lines) if (ERR.has(l.level)) c[l.step] = (c[l.step] || 0) + 1;
  return c;
}
function logsBlock(r) {
  const L = r.logs;
  const services = [...new Set(logView.lines.map((l) => l.service))].sort();
  const state = !L ? t('Логи бэкенда для этого прогона не собирались.')
    : L.status === 'live' ? t('Собираю логи во время прогона…')
    : L.status === 'collecting' ? t('Прогон закончился, дособираю хвост логов (около 15 с)…')
    : L.status === 'error' ? t('Логи не собраны: {e}', { e: tt(L.error) }) : '';
  return `
    <section class="card" id="logs-card">
      <div class="card-head">
        <h2>${t('Логи бэкенда')} <span class="sub" style="display:inline">· ${L ? h(t('{n} строк, ошибок {e}, предупреждений {w}', { n: L.total, e: L.errors, w: L.warns })) : '—'}</span></h2>
        <div class="row" style="display:flex;gap:8px;flex-wrap:wrap">
          ${r.finishedAt ? `<button class="btn small" data-act="logs-refresh" data-id="${h(r.id)}">${t('Обновить логи')}</button>` : ''}
        </div>
      </div>
      ${state ? `<div class="note ${L && L.status === 'error' ? 'failed' : 'running'}" style="margin:16px 20px 0">${h(state)}</div>` : ''}
      <div class="log-tools">
        <div class="seg" role="group" aria-label="${t('Какие логи показать')}">
          <button class="${logView.scope === 'step' ? 'on' : ''}" data-act="log-scope" data-v="step">${h(t('Шаг {n}', { n: selStep + 1 }))}</button>
          <button class="${logView.scope === 'all' ? 'on' : ''}" data-act="log-scope" data-v="all">${t('Весь прогон')}</button>
        </div>
        <label class="field">${t('Уровень')}<select id="log-level">
          <option value="all" ${logView.level === 'all' ? 'selected' : ''}>${t('все')}</option>
          <option value="warn" ${logView.level === 'warn' ? 'selected' : ''}>${t('WARN и ERROR')}</option>
          <option value="error" ${logView.level === 'error' ? 'selected' : ''}>${t('только ERROR')}</option>
          <option value="nodebug" ${logView.level === 'nodebug' ? 'selected' : ''}>${t('без DEBUG')}</option>
        </select></label>
        <label class="field">${t('Сервис')}<select id="log-service"><option value="">${t('все')}</option>${services.map((s) => `<option value="${h(s)}" ${logView.service === s ? 'selected' : ''}>${h(s.replace(/^core-/, ''))}</option>`).join('')}</select></label>
        <label class="field" style="flex:1 1 220px">${t('Поиск')}<input type="text" id="log-q" value="${h(logView.q)}" placeholder="${t('order_id, текст ошибки…')}"></label>
      </div>
      <div id="log-list"></div>
    </section>`;
}
function renderLogList() {
  const box = document.getElementById('log-list');
  if (!box) return;
  const q = logView.q.trim().toLowerCase();
  const rows = logView.lines.filter((l) =>
    (logView.scope === 'all' || l.step === selStep)
    && (logView.level === 'all'
      || (logView.level === 'warn' && (ERR.has(l.level) || WARN.has(l.level)))
      || (logView.level === 'error' && ERR.has(l.level))
      || (logView.level === 'nodebug' && l.level !== 'DEBUG' && l.level !== 'TRACE'))
    && (!logView.service || l.service === logView.service)
    && (!q || (l.msg + ' ' + l.logger + ' ' + JSON.stringify(l.extra || '')).toLowerCase().includes(q)));
  const shown = rows.slice(0, 1000);
  box.innerHTML = rows.length ? `
    <div class="hint" style="padding:8px 20px">${h(t('Показано {a} из {b}', { a: shown.length, b: rows.length }))}</div>
    <div class="log-rows">${shown.map((l) => `
      <button class="log-row lv-${h(l.level.toLowerCase())}" data-act="log-open" data-i="${l.i}">
        <span class="lt">${h(new Date(l.t).toLocaleTimeString(LOCALE, { hour12: false }))}.${String(new Date(l.t).getMilliseconds()).padStart(3, '0')}</span>
        <span class="ls">${h(l.service.replace(/^core-/, ''))}</span>
        <span class="ll">${h(l.level || '—')}</span>
        <span class="lm">${h(logView.open.has(l.i) ? l.msg : l.msg.slice(0, 260))}${logView.scope === 'all' ? ` <span class="hint">· ${h(t('шаг {n}', { n: l.step + 1 }))}</span>` : ''}</span>
      </button>
      ${logView.open.has(l.i) ? `<pre class="log-detail">${h([l.logger && 'logger: ' + l.logger, l.extra && JSON.stringify(l.extra, null, 2)].filter(Boolean).join('\n') || t('больше полей нет'))}</pre>` : ''}`).join('')}</div>`
    : `<div class="empty">${t('Нет строк под эти фильтры')}</div>`;
}

// Backend checks have no screen: their frame shows what was asked and what came back.
function shortPath(title) {
  const m = /(GET|POST|PUT|PATCH|DELETE) (\S+)/.exec(title || '');
  if (!m) return '';
  const parts = m[2].replace(/^\/?api\/v\d+\//, '').split('?')[0].split('/').filter((p) => !/^\{\{|^[0-9a-f-]{20,}$/.test(p));
  return m[1] + ' ' + parts.slice(-2).join('/');
}
function apiThumb(s) {
  if (s.type !== 'api') return h(tt(s.label));
  const named = (s.title || '').includes(' · ');
  const result = s.status === 'failed' ? t('не прошло') : s.status === 'passed' ? (s.detail || '').split(',').slice(-1)[0].trim() : '';
  return `<span class="api-thumb"><b>API</b>${named ? `<span>${h(tt(s.title.split(' · ')[0]))}</span>` : ''}<span class="mono">${h(shortPath(s.title))}</span>${result ? `<span class="mono res-${h(s.status)}">${h(result)}</span>` : ''}</span>`;
}
function apiPanel(s) {
  return `<div class="api-panel">
    <div class="k">${t('Запрос к бэкенду')}</div>
    <pre>${h(s.request || (s.title || '').split(' · ').slice(-1)[0])}</pre>
    <div class="k">${t('Результат')}</div>
    <pre class="${s.status === 'failed' ? 'bad-ink' : ''}">${h(s.status === 'failed' ? tt(s.error) : tt(s.detail) || STATUS[s.status])}</pre>
    ${s.response ? `<div class="k">${t('Ответ')}</div><pre>${h(prettyJson(s.response))}</pre>` : ''}
  </div>`;
}
function prettyJson(x) {
  try { return JSON.stringify(JSON.parse(x), null, 2); } catch { return x; }
}

// ---------- the app's own requests on this step ----------
function appCallsBlock(s) {
  if (!s.appCalls || !s.appCalls.length) return '';
  const bad = new Set((s.backendIssues || []).map((i) => i.corr));
  const rows = s.appCalls.slice().sort((a, b) => (bad.has(b.corr) - bad.has(a.corr)) || String(a.t).localeCompare(String(b.t)));
  const issues = s.backendIssues || [];
  return `
    <section class="card" id="calls-card">
      <div class="card-head"><h2>${t('Запросы приложения на этом шаге')} <span class="sub" style="display:inline">· ${s.appCalls.length}</span></h2>
        ${issues.length ? `<span class="badge paused">${h(t('{n} замеч.', { n: issues.length }))}</span>` : `<span class="badge passed">${t('без ошибок')}</span>`}</div>
      ${issues.length ? `<div class="issues">${issues.map((i) => `<div class="issue ${h(i.level)}">${h(tt(i.text))}</div>`).join('')}</div>` : ''}
      <div class="scroll-x"><table class="calls" style="min-width:640px">
        <thead><tr><th>${t('Время')}</th><th>${t('Запрос')}</th><th>${t('Ответ')}</th><th>${t('Сервис')}</th><th></th></tr></thead>
        <tbody>${rows.map((c) => `<tr class="${bad.has(c.corr) ? 'bad' : ''}">
          <td class="mono">${h(c.t ? new Date(c.t).toLocaleTimeString(LOCALE, { hour12: false }) : '')}</td>
          <td class="mono">${h((c.method || '?') + ' ' + (c.path || t('(путь скрыт приложением)')))}</td>
          <td class="mono">${h(String(c.status || '?'))}${c.errorCode ? ' ' + h(c.errorCode) : ''}${c.ms != null ? ` · ${h(c.ms)} ${t('мс')}` : ''}</td>
          <td class="sub">${h((c.service || '').replace(/^core-/, ''))}</td>
          <td><button class="btn small" data-act="logs-corr" data-corr="${h(c.corr)}" title="${t('Показать логи бэкенда по этому запросу')}">${t('Логи')}</button></td>
        </tr>`).join('')}</tbody></table></div>
    </section>`;
}

// Selects the next step after the current one that has remarks (wrapping around) and scrolls to them.
async function showIssue(first) {
  const idx = curRun.steps.map((s, i) => ((s.backendIssues || []).length ? i : -1)).filter((i) => i >= 0);
  if (!idx.length) return;
  selStep = first ? idx[0] : (idx.find((i) => i > selStep) ?? idx[0]);
  viewRun.follow = false;
  lastRunJson = '';
  await viewRun(curRun.id);
  const card = document.getElementById('calls-card');
  if (card) { card.scrollIntoView({ behavior: 'smooth', block: 'start' }); card.classList.add('flash'); setTimeout(() => card.classList.remove('flash'), 1500); }
  const frame = document.querySelector('.frame.sel');
  if (frame) frame.scrollIntoView({ block: 'nearest', inline: 'center' });
}

// ---------- design (secondary to the backend checks) ----------
const figmaCache = new Map(); // url → { src } | { error }

function designBlock(r, s) {
  const d = s.design || {};
  const verdict = d.verdict === 'ok' ? `<span class="badge passed">${t('Соответствует макету')}</span>`
    : d.verdict === 'mismatch' ? `<span class="badge failed">${t('Не соответствует макету')}</span>`
    : `<span class="badge none">${t('Не сверено')}</span>`;
  return `
    <details class="card design" ${s.figma || d.verdict ? 'open' : ''}>
      <summary><span>${t('Соответствие макету Figma')}</span>${verdict}</summary>
      <div class="design-body">
        ${s.figma ? `
          <div class="design-link"><a href="${h(safeUrl(s.figma))}" target="_blank" rel="noopener">${t('Открыть кадр в Figma')}</a>
            <button class="btn small" data-act="figma-refresh">${t('Обновить макет')}</button></div>
          <div id="figma-img" class="figma-img"><span class="hint">${t('Загружаю макет…')}</span></div>`
          : `<label class="field">${t('Ссылка на кадр Figma для этого экрана')}<input type="text" id="figma-url" placeholder="https://www.figma.com/design/…?node-id=…"></label>
             <div><button class="btn small" data-act="figma-save">${t('Привязать макет')}</button></div>`}
        <label class="field">${t('Комментарий')}<input type="text" id="design-note" value="${h(d.note || '')}" placeholder="${t('что отличается')}"></label>
        <div class="row" style="display:flex;gap:8px;flex-wrap:wrap">
          <button class="btn small" data-act="design" data-v="ok">${t('✓ Соответствует')}</button>
          <button class="btn small" data-act="design" data-v="mismatch">${t('✕ Не соответствует')}</button>
          ${d.verdict || d.note ? `<button class="btn small" data-act="design" data-v="">${t('Сбросить')}</button>` : ''}
        </div>
      </div>
    </details>`;
}
async function loadFigma(url, refresh) {
  const box = () => document.getElementById('figma-img');
  let got = !refresh && figmaCache.get(url);
  if (!got) {
    try { got = await api('GET', '/api/figma/image?url=' + encodeURIComponent(url) + (refresh ? '&refresh=1' : '')); }
    catch (e) { got = { error: e.message }; }
    figmaCache.set(url, got);
  }
  const b = box();
  if (!b) return;
  b.innerHTML = got.src ? `<a class="zoom" href="${h(safeUrl(got.src))}" target="_blank" rel="noopener"><img src="${h(safeUrl(got.src))}" alt="${t('Макет экрана из Figma')}"></a>`
    : `<span class="hint">${h(got.error)}</span>`;
}
function designSummary(r) {
  const ok = r.steps.filter((s) => s.design && s.design.verdict === 'ok').length;
  const bad = r.steps.filter((s) => s.design && s.design.verdict === 'mismatch').length;
  return ok || bad ? `<span>${h(t('Макет: {ok} ✓ · {bad} ✕', { ok, bad }))}</span>` : '';
}

// ---------- performance ----------
// run.perf and step.perf come from lib/perf.js: frame cost (UI + RenderThread per frame), jank share,
// what this device showed, cold start, CPU / RAM, Flashlight's own numbers.
let perfRuns = null; // the runs list, loaded once per finished measured run for the per-build history
let perfRunsFor = '';
const fmtMs = (x) => (x == null ? '—' : (x >= 100 ? String(Math.round(x)) : Number(x).toFixed(1).replace('.', LANG === 'ru' ? ',' : '.')) + ' ' + t('мс'));
const pct = (x) => (x == null ? '—' : Math.round(x * 100) + ' %');
function scoreBadge(sc, title = '') {
  if (sc == null) return `<span class="score none" title="${t('мало кадров для оценки')}">—</span>`;
  return `<span class="score ${sc >= 85 ? 'good' : sc >= 60 ? 'ok' : 'bad'}" title="${h(title)}">${h(sc)}</span>`;
}
function median(xs) {
  const s = xs.filter((x) => x != null).sort((a, b) => a - b);
  if (!s.length) return null;
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
function perfLine(s) {
  const p = s.perf;
  if (!p) return s.launch && s.launch.totalMs ? `<div class="perf-line"><span>${t('старт')} <b>${fmtMs(s.launch.totalMs)}</b></span></div>` : '';
  if (p.error) return `<div class="perf-line"><span class="bad-ink">${h(t('замер не удался: {e}', { e: tt(p.error) }))}</span></div>`;
  const f = p.frames || {};
  const parts = [`${t('кадров')} <b>${h(f.count || 0)}</b>`];
  if (f.count) parts.push(`${t('стоимость p50')} <b>${fmtMs(f.app.p50)}</b> · p95 <b>${fmtMs(f.app.p95)}</b>`, `jank <b>${pct(f.jank)}</b>`, `${t('на экране p95')} <b>${fmtMs(f.total.p95)}</b>`);
  if (p.startMs) parts.push(`${t('старт')} <b>${fmtMs(p.startMs)}</b>`);
  else if (p.settleMs != null) parts.push(`${t('переход')} <b>${fmtMs(p.settleMs)}</b>`);
  if (p.cpu && p.cpu.pct != null) parts.push(`CPU <b>${h(p.cpu.pct)} %</b>${p.cpu.threads && p.cpu.threads.length ? ` <span title="${h(p.cpu.threads.map((th) => `${th.name}: ${th.ms} ${t('мс')}`).join('\n'))}">(${h(p.cpu.threads.slice(0, 2).map((th) => th.name).join(', '))})</span>` : ''}`);
  if (p.cpu && p.cpu.ramMb != null) parts.push(`RAM <b>${h(p.cpu.ramMb)} ${t('МБ')}</b>`);
  if (p.flashlight) parts.push(`Flashlight: ${p.flashlight.fps != null ? `<b>${h(p.flashlight.fps)} fps</b> · ` : ''}CPU <b>${h(p.flashlight.cpu)} %</b>`);
  if (p.steps) parts.push(h(t('шаги {a}–{b} одним окном', { a: p.steps[0], b: p.steps[p.steps.length - 1] })));
  return `<div class="perf-line">${scoreBadge(p.score)}${parts.map((x) => `<span>${x}</span>`).join('')}</div>`;
}
function perfHistory(r) {
  if (!perfRuns) return '';
  const mine = perfRuns.filter((x) => x.scenarioId === r.scenarioId && x.perf && x.perf.score != null && x.status === 'passed');
  // one row per build AND device: a phone's numbers never average with the emulator's
  const devOf = (x) => { const d = (x.perf || {}).device || {}; return d.emulator ? t('эмулятор') : d.model || x.device || '?'; };
  // the installed build: version name, versionCode and the APK digest; runs before 2026-11-11 have no digest
  // and keep grouping by the APK file name
  const verOf = (x) => { const d = (x.perf || {}).device || {}; return [d.versionName, d.versionCode != null ? `(${d.versionCode})` : '', d.apkMd5 ? `#${d.apkMd5.slice(0, 6)}` : ''].filter(Boolean).join(' '); };
  const keyOf = (x) => { const d = (x.perf || {}).device || {}; return `${d.apkMd5 ? 'md5:' + d.apkMd5 : x.build || '—'}|${verOf(x)}|${devOf(x)}`; };
  const groups = new Map();
  for (const x of mine) { const k = keyOf(x); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(x); }
  const rows = [...groups.entries()].map(([key, xs]) => ({ key, xs, last: xs.map((x) => x.startedAt).sort().pop() })).sort((a, b) => b.last.localeCompare(a.last)).slice(0, 8);
  if (!rows.length) return '';
  const med = (xs, f) => median(xs.map(f));
  const rng = (xs, f) => { const v = xs.map(f).filter((x) => x != null); return v.length > 1 ? [Math.min(...v), Math.max(...v)] : null; };
  return `<div class="pad" style="padding-top:0"><div class="sub" style="margin-bottom:6px">${t('По сборкам и устройствам — медиана прошедших замеров этого сценария')} · ${t('мелким — мин–макс; по одному замеру сборки не сравнить')}</div>
    <div class="scroll-x"><table class="perf"><thead><tr><th>${t('Сборка')}</th><th>${t('Устройство')}</th><th>${t('Замеров')}</th><th>${t('Балл')}</th><th>p95</th><th>Jank</th><th>${t('Старт')}</th><th>Flashlight</th></tr></thead><tbody>${rows.map((row) => {
      const x0 = row.xs[0];
      const fl = med(row.xs, (x) => x.perf.flashlight && x.perf.flashlight.score);
      return `<tr class="${row.key === keyOf(r) ? 'cur' : ''}"><td style="font-family:var(--mono);font-size:12px">${h((x0.build || '—').replace(/\.apk$/, ''))}${verOf(x0) ? `<br><span class="sub">${h(t('версия {v}', { v: verOf(x0) }))}</span>` : ''}</td><td>${h(devOf(x0))}</td><td>${row.xs.length}</td><td>${scoreBadge(Math.round(med(row.xs, (x) => x.perf.score)))}${spread(rng(row.xs, (x) => x.perf.score))}</td><td>${fmtMs(med(row.xs, (x) => x.perf.frames && x.perf.frames.app && x.perf.frames.app.p95))}${spread(rng(row.xs, (x) => x.perf.frames && x.perf.frames.app && x.perf.frames.app.p95), fmtMs)}</td><td>${pct(med(row.xs, (x) => x.perf.frames && x.perf.frames.jank))}${spread(rng(row.xs, (x) => x.perf.frames && x.perf.frames.jank), pct)}</td><td>${fmtMs(med(row.xs, (x) => x.perf.startMs))}</td><td>${fl == null ? '—' : Math.round(fl)}</td></tr>`;
    }).join('')}</tbody></table></div></div>`;
}
// emulator run: the forecast for phones from the calibration; phone run: its chip and the «make reference» button
function forecastBlock(r) {
  const p = r.perf, f = p.forecast, cls = (v) => (['smooth', 'плавно'].includes(v) ? 'good' : ['fine', 'нормально'].includes(v) ? 'ok' : 'bad');
  if (p.device && !p.device.emulator) {
    return `<div class="pad" style="padding-top:0;display:flex;gap:12px;align-items:center;flex-wrap:wrap"><span class="sub">${p.chip ? t('Чип: <b>{name}</b> · {score} баллов шкалы', { name: h(p.chip.name), score: h(p.chip.score) }) : t('чип «{soc}» не в таблице — при калибровке спрошу балл', { soc: h(p.device.soc || p.device.platform || '?') })}</span>
      ${r.status === 'passed' ? `<button class="btn small" data-act="calibrate" data-id="${h(r.id)}" title="${t('K = стоимость кадра на этом телефоне ÷ на эмуляторе, по этому же сценарию')}">${t('Сделать эталоном калибровки')}</button>` : ''}</div>`;
  }
  if (!f) return p.calibration === 'none' ? `<div class="pad" style="padding-top:0"><div class="note pending">${t('Прогноза на телефоны пока нет: подключи телефон («+ телефон» в шапке), прогони на нём этот сценарий с замером и нажми на его странице «Сделать эталоном калибровки».')}</div></div>` : '';
  // a calibration the server found unfit (stale, unknown origin, another emulator image or build, odd K)
  // comes without phone numbers: say why and how to recalibrate instead of showing a number to mistake for real
  if (f.trust && !f.trust.ok) {
    const why = {
      'no-reference': t('сохранён только коэффициент K — без эталонного телефона и даты'),
      'unknown-age': t('дата калибровки неизвестна'),
      stale: t('калибровке {d} дн. — старше {max} дн., эмулятор за это время мог измениться', { d: f.trust.ageDays, max: f.trust.maxDays }),
      'no-origin': t('калибровка снята старой версией консоли: не записано, на каком образе эмулятора и на каких сборках'),
      'other-image': t('этот прогон на другом образе эмулятора, чем калибровка'),
      'build-mismatch': t('при калибровке телефон и эмулятор гоняли разные сборки или варианты ({p} / {e}) — K сравнивает сборки, а не устройства', { p: (f.versions && f.versions.phone) || '?', e: (f.versions && f.versions.emulator) || '?' }),
      'k-implausible': t('K = {k} вне правдоподобных 0,1–3: эмулятор при калибровке, скорее всего, был перегружен', { k: f.k }),
      'emu-drift': t('этот сценарий на эмуляторе сейчас стоит в 2+ раза больше или меньше, чем при калибровке')
    };
    return `<div class="pad" style="padding-top:0"><div class="note warned"><b>${t('Прогноза на телефоны нет: калибровка не годится для этого прогона')}</b>${f.at ? ` <span class="sub" style="display:inline">· ${h(t('калибровка от {when}, K = {k}', { when: when(f.at), k: f.k }))}</span>` : ''}
      <ul style="margin:6px 0 6px 18px;padding:0">${f.trust.reasons.map((x) => `<li>${h(why[x] || x)}</li>`).join('')}</ul>
      ${t('Перекалибруй: прогони этот сценарий с замером на эмуляторе и на телефоне одной и той же сборкой, затем на странице прогона телефона нажми «Сделать эталоном калибровки».')}</div></div>`;
  }
  const rows = [...f.phones, { ...f.reference, ref: true }].sort((a, b) => a.score - b.score);
  return `<div class="pad" style="padding-top:0">
    <div class="sub" style="margin-bottom:6px">${t('Прогноз на телефонах · калибровка по <b>{name}</b> ({chip}, K = {k} по {n} шагам{v}): p95 стоимости кадра с эмулятора × K, дальше по баллу чипа', { name: h(f.reference.name), chip: h(f.reference.chip || ''), k: h(f.k), n: h(f.steps || 0), v: f.versions ? t(', сборки: телефон {p} / эмулятор {e}', { p: h(f.versions.phone || '?'), e: h(f.versions.emulator || '?') }) : '' })}${f.at ? ` · ${h(t('калибровка от {when} — пересчитано по ней, а не по калибровке на день прогона', { when: when(f.at) }))}` : ''}</div>
    <div class="perf-grid" style="padding:0 0 10px">
      <div><div class="k">${t('Нужен чип для «нормально»')}</div><div class="v">≥ ${h(f.needOk)} <small>${t('баллов · p95 ≤ 12 мс')}</small></div></div>
      <div><div class="k">${t('Для «плавно»')}</div><div class="v">≥ ${h(f.needSmooth)} <small>${t('баллов · p95 ≤ 7 мс, 120 Гц')}</small></div></div>
    </div>
    <div class="scroll-x"><table class="perf"><thead><tr><th>${t('Телефон')}</th><th>${t('Баллы')}</th><th>${t('p95 стоимости')}</th><th>${t('Оценка')}</th></tr></thead><tbody>
      ${rows.map((x) => `<tr class="${x.ref ? 'cur' : ''}"><td>${h(x.name)}${x.ref ? ` <span class="sub" style="display:inline">· ${t('эталон')}</span>` : ''}</td><td>${h(x.score)}</td><td>${fmtMs(x.ms)}</td><td><span class="score ${cls(x.verdict)}" style="font-size:12px">${h(tt(x.verdict))}</span></td></tr>`).join('')}
    </tbody></table></div></div>`;
}
function perfBlock(r) {
  const p = r.perf;
  if (!p) return '';
  if (p.error) return `<section class="card pad"><h2 style="margin-bottom:8px">${t('Производительность')}</h2><div class="note warned">${h(tt(p.error))}</div></section>`;
  const f = p.frames || {}, d = p.device || {}, fl = p.flashlight;
  const dev = [d.model, d.soc, p.chip ? `${p.chip.name} (${p.chip.score})` : '', d.android ? 'Android ' + d.android : '', d.refreshHz ? d.refreshHz + ' ' + t('Гц') : '', d.emulator ? t('эмулятор') : ''].filter(Boolean).join(' · ');
  const rows = r.steps.filter((s) => s.perf && !s.perf.error).map((s) => {
    const q = s.perf, g = q.frames || {};
    return `<tr data-act="sel" data-i="${s.n - 1}" class="${selStep === s.n - 1 ? 'cur' : ''}"><td>${h(s.n)}${q.steps ? '–' + h(q.steps[q.steps.length - 1]) : ''}</td><td style="font-weight:500">${h(tt(s.title))}</td><td>${h(g.count || 0)}</td><td>${g.count ? fmtMs(g.app.p95) : '—'}</td><td>${g.count ? pct(g.jank) : '—'}</td><td>${q.startMs ? t('старт') + ' ' + fmtMs(q.startMs) : q.settleMs != null ? fmtMs(q.settleMs) : '—'}</td><td>${q.cpu && q.cpu.pct != null ? h(q.cpu.pct) + ' %' : '—'}</td><td>${q.cpu && q.cpu.ramMb != null ? h(q.cpu.ramMb) + ' ' + t('МБ') : '—'}</td><td>${q.flashlight && q.flashlight.fps != null ? h(q.flashlight.fps) : '—'}</td><td>${scoreBadge(q.score)}</td></tr>`;
  }).join('');
  return `<section class="card" aria-label="${t('Производительность')}">
    <div class="card-head"><h2 style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">${t('Производительность')} ${scoreBadge(p.score, tt(p.verdict) || '')}<span class="sub" style="display:inline;font-weight:400">${p.verdict ? h(tt(p.verdict)) + ' · ' : ''}${t('на этом устройстве')}${d.emulator ? t(' — эмулятор: стоимость кадра переносима на телефоны, время на экране нет') : ''}</span></h2>
      <span class="sub">${h(dev)}${d.versionName ? ` · ${h(t('версия {v}', { v: d.versionName }))}` : ''}</span></div>
    <div class="perf-grid">
      <div><div class="k">${t('Стоимость кадра p50 / p95')}</div><div class="v">${fmtMs(f.app && f.app.p50)} <small>/ ${fmtMs(f.app && f.app.p95)}</small></div></div>
      <div><div class="k">${t('Jank — дороже кадра 60 fps')}</div><div class="v">${pct(f.jank)} <small>${h(t('из {n} кадров', { n: f.count || 0 }))}${f.jankHz != null && d.refreshHz > 60 ? ` · ${h(t('при {hz} Гц {p}', { hz: d.refreshHz, p: pct(f.jankHz) }))}` : ''}</small></div></div>
      <div><div class="k">${t('На экране p95 · пропущено')}</div><div class="v">${fmtMs(f.total && f.total.p95)} <small>· ${pct(f.missed)}</small></div></div>
      <div><div class="k">${t('Холодный старт')}</div><div class="v">${p.startMs ? fmtMs(p.startMs) : '—'}</div></div>
      <div><div class="k">${t('CPU · память')}</div><div class="v">${p.cpuPct != null ? h(p.cpuPct) + ' %' : '—'} <small>· ${p.ramMaxMb != null ? h(p.ramMaxMb) + ' ' + t('МБ') : '—'}</small></div></div>
      <div><div class="k">Flashlight</div><div class="v">${fl && fl.score != null ? scoreBadge(fl.score, t('балл Flashlight: средний CPU, FPS, время с потоком выше 90 %')) : '—'} <small>${fl && fl.fps != null ? h(fl.fps) + ' fps · ' : ''}${fl && fl.cpu != null ? 'CPU ' + h(fl.cpu) + ' %' : ''}${fl && fl.error ? h(tt(fl.error)) : ''}</small></div></div>
    </div>
    ${forecastBlock(r)}
    ${perfHistory(r)}
    <div class="scroll-x"><table class="perf"><thead><tr><th>${t('Шаг')}</th><th></th><th>${t('Кадров')}</th><th>${t('Стоимость p95')}</th><th>Jank</th><th>${t('Переход')}</th><th>CPU</th><th>RAM</th><th>fps (Flashlight)</th><th>${t('Балл')}</th></tr></thead><tbody>${rows}</tbody></table></div>
  </section>`;
}

// ---------- run ----------
async function viewRun(id) {
  const r = await api('GET', '/api/runs/' + encodeURIComponent(id));
  curRun = r;
  await loadLogs(r).catch(() => {});
  if (r.perf && !LIVE.includes(r.status) && perfRunsFor !== r.id) { perfRuns = await api('GET', '/api/runs').catch(() => null); perfRunsFor = r.id; }
  const json = JSON.stringify(r);
  if (json === lastRunJson && $app.dataset.view === 'run:' + id) return r;
  lastRunJson = json;
  $app.dataset.view = 'run:' + id;
  const steps = r.steps;
  if (selStep === null || selStep >= steps.length) {
    const fail = steps.findIndex((s) => s.status === 'failed' || s.status === 'running' || s.status === 'paused');
    selStep = fail >= 0 ? fail : Math.max(0, steps.filter((s) => s.screenshot).length - 1);
  }
  const live = LIVE.includes(r.status);
  if (live) {
    const cur = steps.findIndex((s) => s.status === 'running' || s.status === 'paused');
    if (cur >= 0 && viewRun.follow !== false) selStep = cur;
  }
  const cur = steps[selStep];
  const errCounts = stepErrorCounts();
  const img = (s) => `/runs/${encodeURIComponent(r.id)}/${encodeURIComponent(s.screenshot)}?v=${encodeURIComponent(s.ms || '')}`;
  const statusLine = r.status === 'failed'
    ? t('Упал на шаге {n} из {m}', { n: (steps.find((s) => s.status === 'failed') || {}).n || '?', m: steps.length })
    : r.status === 'passed' ? t('Прошёл, {n} из {m}', { n: steps.length, m: steps.length }) + (steps.some((s) => s.status === 'warned') ? t(' · с оговорками') : '') : STATUS[r.status];
  // a run over the phone AND the browser: the film is split into labelled stretches, browser frames are wide
  const mixed = new Set(steps.map((s) => s.screen).filter(Boolean)).size > 1;
  const lastScreen = (i) => { for (let k = i - 1; k >= 0; k--) if (steps[k].screen) return steps[k].screen; return null; };
  const isWeb = cur && cur.screen === 'web' && cur.type !== 'api';
  // the live poll redraws the page: what the user is typing (the resume note, a design note) survives it
  const restore = keepInputs({ 'resume-note': `${r.id}|pending|${r.pending ? r.pending.n : ''}`, 'design-note': `${r.id}|${selStep}`, 'figma-url': `${r.id}|${selStep}`, 'log-q': r.id });

  $app.innerHTML = `
    <div class="col" style="gap:10px">
      <div class="crumbs"><a href="#/">${t('Сценарии')}</a> / ${h(tt(r.scenarioName))} / ${h(t('прогон #{n}', { n: r.number || '' }))}</div>
      <div class="title-row">
        <h1>${h(tt(r.scenarioName))}</h1>
        <span class="badge ${h(r.status)}">${h(statusLine)}</span>
        ${r.backendIssues ? `<button class="badge paused badge-btn" data-act="next-issue" title="${t('Показать следующее замечание')}">${h(t('Бэкенд: {n} замеч. →', { n: r.backendIssues }))}</button>` : ''}
        <a class="btn" href="#/edit/${h(r.scenarioId)}">${t('Изменить сценарий')}</a>
        ${live ? `<button class="btn danger" data-act="stop" data-id="${h(r.id)}">${t('Остановить')}</button>`
          : `<button class="btn primary" data-act="run" data-id="${h(r.scenarioId)}" data-measure="${r.measure ? 1 : 0}">${t('Перезапустить')}</button>${r.measure ? '' : `<button class="btn" data-act="measure" data-id="${h(r.scenarioId)}" title="${t('Прогнать ещё раз, собирая кадры, CPU и память на каждом шаге')}">${t('⏱ Замерить')}</button>`}<button class="btn danger" data-act="run-del" data-id="${h(r.id)}" title="${t('Удалить этот прогон со скриншотами и логами')}">${t('Удалить прогон')}</button>`}
      </div>
      <div class="meta"><span>${h(when(r.startedAt))} · ${h(dur(r))}</span>${r.build ? `<span style="font-family:var(--mono)">${h(r.build)}</span>` : ''}<span>${h(r.env)} · ${r.device === 'web' ? h(t('браузер')) : h(r.device)}</span><span>${t('Движок: {e}', { e: '' })}${engineChip(r.engine)}</span>${r.platform === 'ios' ? '<span>iOS</span>' : ''}${r.measure ? `<span>${t('Замер')}${r.measure.iterations > 1 ? ` ${h(r.measure.iteration)}/${h(r.measure.iterations)}` : ''}</span>` : ''}${r.variantTitle ? `<span>${t('Вариант: ')}<b>${h(r.variantTitle)}</b></span>` : ''}${r.matrix ? `<span class="mono" title="${t('Переменные из matrix')}">${h(Object.entries(r.matrix).map(([k, v]) => k + '=' + v).join(', '))}</span>` : ''}${designSummary(r)}</div>
    </div>
    ${r.error ? `<div class="note failed">${h(tt(r.error))}</div>` : ''}
    ${r.screenshotsDropped ? `<div class="note pending">${h(t('Скриншоты этого прогона удалены {d}; шаги, время и логи остались.', { d: when(r.screenshotsDropped) }))}</div>` : ''}
    ${r.status === 'queued' ? `<div class="note pending">${t('Ждёт свободного устройства')}</div>` : ''}
    ${r.status === 'paused' && r.pending ? `
      <div class="pending-box">
        <b>${h(t('Шаг {n} ждёт Claude или тебя: {text}', { n: r.pending.n, text: r.pending.text }))}</b>
        <span class="hint">${t('Сделай это на эмуляторе (или скажи Claude) и нажми «Готово».')}</span>
        <input type="text" id="resume-note" placeholder="${t('Комментарий (необязательно)')}">
        <div class="row"><button class="btn primary" data-act="resume" data-id="${h(r.id)}" data-ok="1">${t('Готово')}</button>
        <button class="btn danger" data-act="resume" data-id="${h(r.id)}" data-ok="0">${t('Не получилось')}</button></div>
      </div>` : ''}
    ${perfBlock(r)}
    <section class="card" aria-label="${t('Шаги')}"><div class="film">${steps.map((s, i) => `
      ${mixed && s.screen && lastScreen(i) !== s.screen ? `<span class="film-sep ${h(s.screen)}">${s.screen === 'web' ? '🖥' : '📱'}<small>${h(t(SCREENS[s.screen]))}</small></span>` : ''}
      <button class="frame ${h(s.status)} ${s.screen === 'web' ? 'web' : ''} ${i === selStep ? 'sel' : ''}" data-act="sel" data-i="${i}" aria-label="${h(t('Шаг {n}', { n: s.n }))}">
        <span class="thumb ${s.screenshot ? '' : 'thumb-api'}">${s.screenshot ? `<img src="${img(s)}" alt="" loading="lazy">` : apiThumb(s)}</span>
        <span class="lbl"><span class="mark-${h(s.status)}">${h(Object.hasOwn(MARK, s.status) ? MARK[s.status] : '')}</span>${s.phase ? `<span class="phase ${h(s.phase)}" title="${h(s.phase)}">${s.phase === 'setup' ? 'S' : 'T'}</span>` : ''}${h(t('Шаг {n}', { n: s.n }))}${s.backendIssues && s.backendIssues.length ? `<span class="warn-badge" title="${h(t('Замечаний к запросам приложения: {n}', { n: s.backendIssues.length }))}">${h(s.backendIssues.length)}</span>` : ''}${s.design && s.design.verdict === 'mismatch' ? `<span class="design-badge" title="${t('Не соответствует макету')}">≠</span>` : ''}${errCounts[i] ? `<span class="err-badge" title="${h(t('Ошибок в логах бэкенда: {n}', { n: errCounts[i] }))}">${errCounts[i]}</span>` : ''}</span>
      </button>`).join('')}</div></section>
    <div class="split">
      <section class="card side phone-wrap ${isWeb ? 'web' : ''}">
        ${cur && !cur.screenshot && cur.type === 'api' ? apiPanel(cur)
          : isWeb ? `<div class="browser"><div class="browser-bar"><i></i><i></i><i></i><span class="url">${h(cur.url || '')}</span></div>${cur.screenshot ? `<a class="zoom" data-step="${selStep}" href="${img(cur)}" target="_blank" rel="noopener"><img src="${img(cur)}" alt="${h(t('Скриншот шага {n}', { n: cur.n }))}"></a>` : `<div class="empty">${t('Скриншота нет')}</div>`}</div>`
          : `<div class="phone">${cur && cur.screenshot ? `<a class="zoom" data-step="${selStep}" href="${img(cur)}" target="_blank" rel="noopener"><img src="${img(cur)}" alt="${h(t('Скриншот шага {n}', { n: cur.n }))}"></a>` : `<span style="padding:24px">${cur ? t('Скриншота нет') : ''}</span>`}</div>`}
        <div class="row" style="display:flex;gap:8px">
          <button class="btn" data-act="sel" data-i="${Math.max(0, selStep - 1)}">${t('← Назад')}</button>
          <button class="btn" data-act="sel" data-i="${Math.min(steps.length - 1, selStep + 1)}">${t('Вперёд →')}</button>
        </div>
      </section>
      <div class="main col">${cur ? `
        <section class="card step-card">
          <div class="sub">${h(t('Шаг {n} из {m}', { n: cur.n, m: steps.length }))} · ${h(tt(cur.label))}${cur.ms ? ' · ' + (cur.ms / 1000).toFixed(1) + ' ' + t('с') : ''}${cur.screen && cur.type !== 'api' ? ' · ' + screenChip(cur.screen) : ''}${cur.driver === 'maestro' ? ' · ' + engineChip(cur.driver) : ''}${cur.phase ? ` · <span class="phase ${h(cur.phase)}">${h(cur.phase)}</span>` : ''}${cur.from ? ` · ${t('блок <b>{b}</b>', { b: h(cur.from) })}` : ''}${cur.cond ? ` · ${h(tt(cur.cond))}` : ''}</div>
          <h2>${h(tt(cur.title))}</h2>
          ${perfLine(cur)}
          <div class="note ${h(cur.status)}">${cur.status === 'failed' ? h(tt(cur.error)) : cur.status === 'passed' ? t('Шаг прошёл.') + (cur.detail ? '\n' + h(tt(cur.detail)) : '') : cur.status === 'warned' ? t('Прошёл с оговоркой.') + '\n' + h(tt(cur.detail || '')) : h(STATUS[cur.status]) + (cur.detail ? '\n' + h(tt(cur.detail)) : '')}</div>
          ${cur.diff ? `<div class="row" style="display:flex;gap:10px;align-items:center;flex-wrap:wrap"><a class="zoom" href="/runs/${h(r.id)}/${h(cur.diff)}" target="_blank" rel="noopener"><img src="/runs/${h(r.id)}/${h(cur.diff)}" alt="${t('Разница с эталоном')}" style="height:160px;border-radius:8px;border:1px solid var(--line)"></a><span class="hint">${h(t('Расхождение {p}% · эталон «{b}»', { p: ((cur.mismatch || 0) * 100).toFixed(2), b: cur.baseline || '' }))}</span><button class="btn small" data-act="baseline" data-n="${h(cur.n)}">${t('Принять этот экран как эталон')}</button></div>` : ''}
          ${cur.maestroFlow ? `<div class="hint">Maestro: <a href="/runs/${h(r.id)}/${h(cur.maestroFlow)}/flow.yaml" target="_blank" rel="noopener">flow.yaml</a> · <a href="/runs/${h(r.id)}/${h(cur.maestroFlow)}/maestro.out.txt" target="_blank" rel="noopener">${t('вывод Maestro')}</a></div>` : ''}
        </section>
        ${appCallsBlock(cur)}
        ${cur.type === 'api' ? '' : designBlock(r, cur)}
        ${cur.logcat ? `<section class="logs"><div class="k">${h(t('Логи приложения (logcat) на шаге {n}', { n: cur.n }))}</div><pre>${h(cur.logcat)}</pre></section>` : ''}` : ''}
        ${Object.keys(r.vars || {}).length ? `<section class="card pad"><h2 style="margin-bottom:8px">${t('Переменные прогона')}</h2><pre style="margin:0;font:12px/1.6 var(--mono)">${h(JSON.stringify(r.vars, null, 2))}</pre></section>` : ''}
      </div>
    </div>
    ${logsBlock(r)}`;
  renderLogList();
  restore();
  if (cur && cur.figma) loadFigma(cur.figma);
  return r;
}
// Remembers the value, focus and caret of inputs by id across a redraw. Each id has a key (which run / step it
// belongs to); an input comes back only when it was edited and its key is the same after the redraw.
let inputKeys = {};
function keepInputs(keys) {
  const prevKeys = inputKeys;
  inputKeys = keys;
  if (viewRun.fresh) { viewRun.fresh = false; return () => {}; }
  const a = document.activeElement;
  const saved = Object.keys(keys).map((id) => {
    const el = document.getElementById(id);
    if (!el || prevKeys[id] !== keys[id]) return null;
    const focus = a === el;
    if (!focus && el.value === el.defaultValue) return null;
    return { id, value: el.value, focus, start: el.selectionStart, end: el.selectionEnd };
  }).filter(Boolean);
  return () => saved.forEach((x) => {
    const el = document.getElementById(x.id);
    if (!el) return;
    el.value = x.value;
    if (x.focus) { el.focus(); try { el.setSelectionRange(x.start, x.end); } catch { /* not a text input */ } }
  });
}

// ---------- editor ----------
function stepFields(s, i) {
  const f = (key, label, extra = '') => `<label class="field ${extra}">${label}<input type="text" data-f="${key}" data-i="${i}" value="${h(s[key] ?? '')}"></label>`;
  const num = (key, label, ph) => `<label class="field">${label}<input type="number" min="0" step="1" data-f="${key}" data-i="${i}" value="${h(s[key] ?? '')}" placeholder="${h(ph)}"></label>`;
  const chk = (key, label) => `<label class="field check"><input type="checkbox" data-f="${key}" data-i="${i}" ${(key === 'byId' ? s.by === 'id' : s[key]) ? 'checked' : ''}>${label}</label>`;
  const sel = (key, label, opts) => `<label class="field">${label}<select data-f="${key}" data-i="${i}">${opts.map(([v, tx]) => `<option value="${h(v)}" ${String(s[key] ?? opts[0][0]) === v ? 'selected' : ''}>${h(tx)}</option>`).join('')}</select></label>`;
  switch (s.type) {
    case 'launch': return chk('clear', t('Сбросить данные приложения (выйти из аккаунта)')) + num('settle', t('Подождать после запуска, с'), '3')
      + ((draft.engine === 'web' || s.on === 'web' || s.on === 'browser') ? f('url', t('Страница: полный адрес или путь от «Адреса сайта» в настройках, напр. /shipment'), 'wide') : '');
    case 'tap': return f('target', t('Текст на экране (или id элемента)'), 'wide') + num('timeout', t('Ждать появления, с'), '10')
      + chk('optional', t('Если не появилось — пропустить')) + chk('byId', t('Это id элемента, не текст'))
      + `<label class="field">${t('Сдвиг от текста по X / Y, px')}<span style="display:flex;gap:6px"><input type="number" data-f="dx" data-i="${i}" value="${h(s.dx ?? '')}" placeholder="0"><input type="number" data-f="dy" data-i="${i}" value="${h(s.dy ?? '')}" placeholder="0"></span></label>`;
    case 'type': return f('target', t('Поле (текст или подсказка), можно пусто')) + f('text', t('Что ввести')) + chk('enter', t('Нажать Enter'));
    case 'link': return f('url', t('Ссылка, напр. https://example.com/p/{{product}} или myapp://screen'), 'wide');
    case 'swipe': return sel('direction', t('Куда'), [['down', t('Вниз (листать дальше)')], ['up', t('Вверх')], ['left', t('Смахнуть строку влево')], ['right', t('Смахнуть строку вправо')]])
      + f('target', t('Строка (текст на ней) — для влево/вправо'));
    case 'back': return `<span class="hint" style="padding-top:9px">${t('Системная кнопка «Назад»')}</span>`;
    case 'wait': return num('seconds', t('Секунд'), '1');
    case 'assertText': return f('text', t('Текст, который должен быть на экране (или id элемента)'), 'wide') + chk('absent', t('Наоборот: текста быть не должно')) + num('timeout', t('Ждать, с'), '10')
      + chk('byId', t('Это id элемента')) + chk('regex', t('Текст — регулярное выражение')) + num('count', t('Ровно столько совпадений'), '—');
    case 'assertScreen': return f('baseline', t('Имя эталона (пусто = по номеру шага)')) + num('threshold', t('Допустимое расхождение, доля (0.01 = 1%)'), '0.01')
      + `<span class="hint" style="padding-top:9px">${t('Первый прогон сохраняет экран как эталон (data/baselines), дальше сравнивает. На странице прогона можно принять новый эталон.')}</span>`;
    case 'use': return `<label class="field">${t('Блок')}<input list="blocks-list" type="text" data-f="use" data-i="${i}" value="${h(s.use ?? '')}"><datalist id="blocks-list">${blockNames.map((b) => `<option value="${h(b)}">`).join('')}</datalist></label>`
      + `<label class="field wide">${t('Параметры (имя=значение, через запятую)')}<input type="text" data-f="withText" data-i="${i}" value="${h(pairsOut(s.with))}"></label>`
      + `<span class="hint">${t('Блоки — в настройках («Библиотека блоков») или в YAML сценария (blocks:). Шаги блока подставятся при запуске.')}</span>`;
    case 'if': return `<label class="field wide">${t('Условие (JSON: {"visible": "…"}, {"notVisible": "…"}, {"var": "x", "equals": "1"}, {"platform": "ios"})')}<input type="text" class="mono" data-f="ifJson" data-i="${i}" value="${h(JSON.stringify(s.if || {}))}"></label>`
      + `<label class="field wide">${t('Тогда — шаги (JSON-список)')}<textarea class="code" data-f="thenJson" data-i="${i}" spellcheck="false">${h(JSON.stringify(s.then || [], null, 1))}</textarea></label>`
      + `<label class="field wide">${t('Иначе — шаги (JSON-список, можно пусто)')}<textarea class="code" data-f="elseJson" data-i="${i}" spellcheck="false">${h(s.else ? JSON.stringify(s.else, null, 1) : '')}</textarea></label><span class="hint">${t('В режиме YAML это пишется короче: - if: {visible: …} then: […] else: […]')}</span>`;
    case 'repeat': return `<label class="field wide">${t('Пока не станет (условие JSON, пусто = просто N раз)')}<input type="text" class="mono" data-f="untilJson" data-i="${i}" value="${h(s.until ? JSON.stringify(s.until) : '')}"></label>`
      + num('times', t('Ровно раз'), '—') + num('max', t('Не больше раз'), '10')
      + `<label class="field wide">${t('Шаги повтора (JSON-список)')}<textarea class="code" data-f="stepsJson" data-i="${i}" spellcheck="false">${h(JSON.stringify(s.steps || [], null, 1))}</textarea></label>`;
    case 'browser': case 'phone': return `<label class="field wide">${t('Шаги группы (JSON-список)')}<textarea class="code" data-f="stepsJson" data-i="${i}" spellcheck="false">${h(JSON.stringify(s.steps || [], null, 1))}</textarea></label>`
      + `<span class="hint">${t('В YAML короче: - browser: [ …шаги… ] — все шаги внутри идут в браузере; - phone: […] — на телефоне.')}</span>`;
    case 'api': return f('title', t('Название шага (необязательно)'), 'wide')
      + sel('auth', t('От чьего имени (роль из настроек)'), [['', t('по умолчанию ({r})', { r: defaultRoleName })], ...roleNames.map((r) => [r, r]), ['none', t('без токена')]])
      + sel('method', t('Метод'), [['GET', 'GET'], ['POST', 'POST'], ['PUT', 'PUT'], ['PATCH', 'PATCH'], ['DELETE', 'DELETE']])
      + f('url', t('Адрес (от «Адреса API» в настройках или полный)'), 'wide')
      + `<label class="field wide">${t('Тело запроса (JSON, можно пусто)')}<textarea data-f="body" data-i="${i}">${h(typeof s.body === 'object' ? JSON.stringify(s.body, null, 2) : s.body ?? '')}</textarea></label>`
      + f('expectPath', t('Поле ответа, напр. status')) + f('expectValue', t('Должно быть равно')) + num('poll', t('Опрашивать, пока не совпадёт, до … с'), '5')
      + `<label class="field wide">${t('Сохранить в переменные (имя=поле, через запятую)')}<input type="text" data-f="saveText" data-i="${i}" value="${h(pairsOut(s.save))}"></label>`;
    case 'ai': return `<label class="field wide">${t('Что сделать (выполнит Claude или ты вручную)')}<textarea data-f="text" data-i="${i}">${h(s.text ?? '')}</textarea></label>`;
    case 'maestro': return f('title', t('Название шага (необязательно)'), 'wide')
      + `<label class="field wide">${t('Команды Maestro (YAML-список, как в flow после «---»). Переменные: {{имя}} или ${имя}')}<textarea class="code" data-f="yaml" data-i="${i}" spellcheck="false" placeholder="- tapOn: &quot;Каталог&quot;&#10;- scrollUntilVisible:&#10;    element: &quot;В корзину&quot;">${h(s.yaml ?? (s.commands ? JSON.stringify(s.commands, null, 2) : ''))}</textarea><span class="hint">${t('Выполняется через Maestro при любом движке. JSON тоже подходит.')}</span></label>`;
    default: return '';
  }
}
function renderEditor() {
  const d = draft;
  // in YAML mode name, description, engine and tab live in the text: the header only shows them
  const lock = editMode === 'yaml' ? `disabled title="${h(YAML_HEADER_HINT())}"` : '';
  $app.innerHTML = `
    <div class="col" style="gap:10px">
      <div class="crumbs"><a href="#/">${t('Сценарии')}</a> / ${t('редактор')}</div>
      <div class="title-row">
        <label class="field" style="flex-grow:1;min-width:240px">${t('Название сценария')}<input class="title-input" type="text" id="sc-name" value="${h(d.name)}" ${lock}></label>
        ${d.id ? `<button class="btn danger" data-act="delete">${t('Удалить')}</button>` : ''}
        ${d.id ? `<details class="menu"><summary class="btn">${t('Экспорт')}</summary><div class="menu-items">
          <a href="/api/scenarios/${h(d.id)}/export?format=yaml" download>${t('YAML консоли')}<small>${t('полный: шаги, API, макеты')}</small></a>
          <a href="/api/scenarios/${h(d.id)}/export?format=maestro" download>${t('Maestro flow')}<small>${t('API-проверки — через evalScript')}</small></a>
          <a href="/api/scenarios/${h(d.id)}/export?format=json" download>JSON</a></div></details>` : ''}
        <button class="btn" data-act="save">${t('Сохранить')}</button>
        <button class="btn primary" data-act="save-run">${t('▶ Сохранить и запустить')}</button>
      </div>
      <div style="display:flex;gap:16px;flex-wrap:wrap;align-items:flex-end">
        <label class="field" style="flex:1 1 320px">${t('Описание')}<input type="text" id="sc-desc" value="${h(d.description || '')}" placeholder="${t('коротко, что проверяем')}" ${lock}></label>
        <label class="field">${t('Движок экрана')}<select id="sc-engine" ${lock}>
          <option value="" ${!d.engine ? 'selected' : ''}>${h(t('по умолчанию ({e})', { e: engineName(defaultEngine) }))}</option>
          <option value="adb" ${d.engine === 'adb' ? 'selected' : ''}>${t('adb — свой драйвер, быстрее')}</option>
          <option value="maestro" ${d.engine === 'maestro' ? 'selected' : ''}>Maestro</option>
          <option value="web" ${d.engine === 'web' ? 'selected' : ''}>${t('Браузер (Playwright)')}</option></select></label>
        <label class="field">${t('Вкладка')}<select id="sc-tab" ${lock}>
          <option value="" ${!d.tab ? 'selected' : ''}>${t('по типу сценария')}</option>
          ${editorTabs.map((tb) => `<option value="${h(tb.id)}" ${d.tab === tb.id || d.tab === tb.name ? 'selected' : ''}>${h(t(tb.name))}</option>`).join('')}</select></label>
        <div class="seg" role="group" aria-label="${t('Как редактировать')}">
          <button class="${editMode === 'form' ? 'on' : ''}" data-act="edit-mode" data-v="form">${t('Форма')}</button>
          <button class="${editMode === 'yaml' ? 'on' : ''}" data-act="edit-mode" data-v="yaml">YAML</button>
        </div>
      </div>
    </div>
    ${lintBox(d.lint)}
    ${editMode === 'yaml' ? `<section class="card pad col">
      <div class="hint">${t('Весь сценарий текстом. Шаги: launch, link, tap, input, swipe, back, wait, assertText, api, ai, maestro — коротко (`- tap: Каталог`) или с полями. Команды Maestro можно писать прямо среди шагов (`- tapOn: …`). «Сохранить» применит текст.')} <b>${h(YAML_HEADER_HINT())}</b></div>
      <textarea class="code tall" id="sc-yaml" spellcheck="false">${h(d.yamlText || '')}</textarea>
    </section>` : `<section class="card">
      ${d.setup || d.teardown || d.blocks || d.matrix || d.rules ? `<div class="hint" style="padding:10px 16px 0">${t('У сценария есть {what} — они редактируются в режиме YAML.', { what: h([d.setup && 'setup (' + d.setup.length + ')', d.teardown && 'teardown (' + d.teardown.length + ')', d.blocks && t('свои блоки: ') + Object.keys(d.blocks).join(', '), d.matrix && 'matrix', d.rules && 'rules'].filter(Boolean).join(', ')) })}</div>` : ''}
      <div class="card-head"><h2>${t('Шаги')}</h2><span class="hint">${t('Подстановки: переменные из настроек и сохранённые шагом «Проверить бэкенд»; шаблоны из настроек (напр. {{context}}) и {{uuid}}, {{hex64}}, {{now}} — новые на каждый вызов')}</span></div>
      <ol class="steps">${d.steps.map((s, i) => `
        <li>
          <span class="num">${i + 1}</span>
          <div class="body">
            <label class="field">${t('Действие')}<select data-type="${i}">${STEP_TYPES.map(([v, tx]) => `<option value="${v}" ${s.type === v ? 'selected' : ''}>${h(t(tx))}</option>`).join('')}</select></label>
            ${stepFields(s, i)}
            ${s.type === 'tap' && (s.dx || s.dy) && (d.engine || defaultEngine) === 'maestro' ? `<span class="hint">${t('Со сдвигом этот шаг выполнит adb: в Maestro сдвига от элемента нет')}</span>` : ''}
            <label class="field check"><input type="checkbox" data-f="noShot" data-i="${i}" ${s.screenshot === false ? '' : 'checked'}>${t('Скриншот после шага')}</label>
            <details class="policy ${s.retry || s.flaky || (s.optional && s.type !== 'tap') || s.when || s.on ? 'on' : ''}"><summary class="hint">${t('Политика шага')}${s.retry ? ' · retry ' + h(s.retry) : ''}${s.flaky ? ' · flaky' : ''}${s.optional && s.type !== 'tap' ? t(' · необязательный') : ''}${s.when ? t(' · условие') : ''}${s.on === 'web' || s.on === 'browser' ? t(' · браузер') : s.on === 'phone' ? t(' · телефон') : ''}</summary>
              <div class="form-grid">
                ${['api', 'ai', 'use', 'if', 'browser', 'phone'].includes(s.type) ? '' : `<label class="field">${t('Где выполнять')}<select data-f="on" data-i="${i}"><option value="" ${!s.on ? 'selected' : ''}>${t('как весь сценарий')}</option><option value="web" ${s.on === 'web' || s.on === 'browser' ? 'selected' : ''}>${t('в браузере')}</option><option value="phone" ${s.on === 'phone' ? 'selected' : ''}>${t('на телефоне')}</option></select></label>`}
                <label class="field">${t('Повторить при неудаче, раз')}<input type="number" min="0" data-f="retry" data-i="${i}" value="${h(s.retry ?? '')}" placeholder="0"></label>
                <label class="field check"><input type="checkbox" data-f="flaky" data-i="${i}" ${s.flaky ? 'checked' : ''}>${t('Нестабильный (две попытки, с пометкой)')}</label>
                ${s.type === 'tap' ? '' : `<label class="field check"><input type="checkbox" data-f="optional" data-i="${i}" ${s.optional ? 'checked' : ''}>${t('Необязательный: неудача не роняет прогон')}</label>`}
                <label class="field wide">${t('Выполнять только если (условие JSON, пусто = всегда)')}<input type="text" class="mono" data-f="whenJson" data-i="${i}" value="${h(s.when ? JSON.stringify(s.when) : '')}"></label>
              </div></details>
            ${s.type === 'api' ? '' : `<label class="field wide">${t('Макет Figma для этого экрана (ссылка на кадр, необязательно)')}<input type="text" data-f="figma" data-i="${i}" value="${h(s.figma ?? '')}" placeholder="https://www.figma.com/design/…?node-id=…"></label>`}
          </div>
          <div class="tools">
            <button class="icon" data-act="up" data-i="${i}" aria-label="${t('Выше')}">↑</button>
            <button class="icon" data-act="down" data-i="${i}" aria-label="${t('Ниже')}">↓</button>
            <button class="icon" data-act="del" data-i="${i}" aria-label="${t('Удалить шаг')}">✕</button>
          </div>
        </li>`).join('') || `<li class="empty" style="display:block">${t('Добавь первый шаг кнопками ниже')}</li>`}
      </ol>
      <div class="add-row"><span class="hint">${t('Добавить шаг:')}</span>${STEP_TYPES.map(([v, tx]) => `<button class="btn small" data-act="add" data-type="${v}">${h(t(tx))}</button>`).join('')}</div>
    </section>`}`;
}
function lintBox(l) {
  if (!l || (!l.errors.length && !l.warnings.length)) return l ? `<div class="note passed" style="margin:0 0 4px">${t('Проверка: ошибок нет')}${l.rows ? ` · matrix × ${h(l.rows)}` : ''} · ${h(t('{n} шагов после раскрытия блоков', { n: l.steps }))}</div>` : '';
  return `<div class="note ${l.errors.length ? 'failed' : 'paused'}" style="margin:0 0 4px"><b>${t('Проверка сценария')}</b>${l.errors.map((e) => '\n✕ ' + h(tt(e))).join('')}${l.warnings.map((w) => '\n! ' + h(tt(w))).join('')}</div>`;
}
let editorTabs = DEFAULT_TABS;
const YAML_HEADER_HINT = () => t('В режиме YAML название, описание, движок и вкладка задаются в тексте (name:, description:, engine:, tab:).');
// the editor draft differs from what the server has: leaving the page asks first
let dirty = false;
const LEAVE_Q = () => t('В сценарии есть несохранённые изменения. Уйти и потерять их?');
// the header fields go into the draft as they are typed, so a re-render (add / move / delete a step) keeps them
const HEADER_FIELDS = { 'sc-name': 'name', 'sc-desc': 'description', 'sc-engine': 'engine', 'sc-tab': 'tab' };
function readHeaderField(el) {
  if (!draft || editMode === 'yaml') return false;
  const k = HEADER_FIELDS[el.id];
  if (!k) return false;
  draft[k] = el.value;
  dirty = true;
  return true;
}
// Fields each step type edits; on a type change the step keeps the ones the new type also has.
const STEP_KEYS = {
  launch: ['clear', 'settle', 'url'], link: ['url'], tap: ['target', 'timeout', 'optional', 'by', 'dx', 'dy'], type: ['target', 'text', 'enter'],
  swipe: ['direction', 'target'], back: [], wait: ['seconds'], assertText: ['text', 'absent', 'timeout', 'by', 'regex', 'count'],
  assertScreen: ['baseline', 'threshold'], api: ['title', 'auth', 'method', 'url', 'body', 'expectPath', 'expectValue', 'poll', 'save'],
  use: ['use', 'with'], if: ['if', 'then', 'else'], repeat: ['until', 'times', 'max', 'steps'], ai: ['text'],
  maestro: ['title', 'yaml', 'commands'], browser: ['steps'], phone: ['steps']
};
const STEP_POLICY = ['screenshot', 'retry', 'flaky', 'optional', 'when', 'on', 'figma'];
function retypeStep(old, type) {
  const keys = new Set([...(STEP_KEYS[type] || []), ...STEP_POLICY]);
  if (['api', 'ai', 'use', 'if', 'browser', 'phone'].includes(type)) keys.delete('on');
  if (type === 'api') keys.delete('figma');
  const s = { type };
  for (const [k, v] of Object.entries(old)) if (k !== 'type' && keys.has(k)) s[k] = v;
  // the text on screen: a tap's target is an assertText's text and back
  if (s.target === undefined && keys.has('target') && !keys.has('text') && typeof old.text === 'string') s.target = old.text;
  if (s.text === undefined && keys.has('text') && !keys.has('target') && typeof old.target === 'string') s.text = old.target;
  return s;
}
// "a=1, b=x,y, c=items[status=paid]" → pairs: split on a comma outside brackets/quotes that starts the next "key="
// (a comma glued to a URL query, as in ?a=1,b=2, stays in the value), then each pair on its first '='. Values the user did not touch keep their original type.
function splitPairs(text) {
  const parts = [];
  let cur = '', depth = 0, q = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === q) q = ''; }
    else if (c === '"' || c === "'") q = c;
    else if ('([{'.includes(c)) depth++;
    else if (')]}'.includes(c)) depth = Math.max(0, depth - 1);
    else if (c === ',' && depth === 0 && (/^\s/.test(text.slice(i + 1)) || !cur.includes('?')) && /^\s*[\w.$-]+\s*=/.test(text.slice(i + 1))) { parts.push(cur); cur = ''; continue; }
    cur += c;
  }
  parts.push(cur);
  return parts.map((p) => { const k = p.indexOf('='); return k < 0 ? [p.trim(), ''] : [p.slice(0, k).trim(), p.slice(k + 1).trim()]; });
}
const pairText = (v) => (v !== null && typeof v === 'object' ? JSON.stringify(v) : String(v));
function readPairs(text, prev) {
  return Object.fromEntries(splitPairs(text).filter(([k]) => k).map(([k, v]) => [k, prev && prev[k] !== undefined && pairText(prev[k]) === v ? prev[k] : v]));
}
const pairsOut = (o) => Object.entries(o || {}).map(([k, v]) => k + '=' + pairText(v)).join(', ');
async function viewEditor(id) {
  editMode = 'form';
  const [b, s] = await Promise.all([api('GET', '/api/blocks').catch(() => ({ blocks: {} })), api('GET', '/api/settings').catch(() => ({}))]);
  setRoles(s);
  editorTabs = tabsOfSettings(s);
  draft = id === 'new' ? { name: t('Новый сценарий'), description: '', steps: [{ type: 'launch' }] } : await api('GET', '/api/scenarios/' + encodeURIComponent(id));
  blockNames = [...Object.keys(b.blocks || {}), ...Object.keys(draft.blocks || {})];
  if (draft.id) draft.lint = await api('GET', '/api/scenarios/' + encodeURIComponent(draft.id) + '/lint').catch(() => null);
  dirty = false;
  renderEditor();
}
function readDraftField(el) {
  dirty = true;
  const i = Number(el.dataset.i);
  const s = draft.steps[i];
  const k = el.dataset.f;
  if (k === 'noShot') { if (el.checked) delete s.screenshot; else s.screenshot = false; return; }
  if (k === 'byId') { if (el.checked) s.by = 'id'; else delete s.by; return; }
  if (k === 'withText') { s.with = readPairs(el.value, s.with); if (!Object.keys(s.with).length) delete s.with; return; }
  if (['ifJson', 'thenJson', 'elseJson', 'untilJson', 'stepsJson', 'whenJson'].includes(k)) {
    const key = k.replace('Json', '');
    const txt = el.value.trim();
    if (!txt) { delete s[key]; el.classList.remove('bad'); return; }
    try { s[key] = JSON.parse(txt); el.classList.remove('bad'); } catch { el.classList.add('bad'); }
    return;
  }
  if (k === 'yaml') { s.yaml = el.value; delete s.commands; return; }
  if (k === 'on') { if (el.value) s.on = el.value; else delete s.on; return; }
  if (el.type === 'checkbox') { s[k] = el.checked; return; }
  if (k === 'saveText') {
    s.save = Object.fromEntries(Object.entries(readPairs(el.value, s.save)).filter(([, v]) => v !== ''));
    return;
  }
  if (el.type === 'number') { if (el.value === '') delete s[k]; else s[k] = Number(el.value); return; }
  s[k] = el.value;
}
async function saveDraft() {
  const engine = document.getElementById('sc-engine').value;
  if (editMode === 'yaml') {
    if (!draft.id) draft = await api('POST', '/api/scenarios', { name: document.getElementById('sc-name').value.trim() || t('Новый сценарий'), steps: [] });
    const area = document.getElementById('sc-yaml');
    const old = document.getElementById('sc-yaml-errors');
    if (old) old.remove();
    let r;
    try {
      r = await api('PUT', '/api/scenarios/' + encodeURIComponent(draft.id) + '/yaml', { text: area.value });
    } catch (e) {
      // nothing was saved: the lines the server could not keep stay listed under the text until the next save
      area.insertAdjacentHTML('afterend', `<div class="issues" id="sc-yaml-errors">${String(e.message).split('\n').map((l) => `<div class="issue error">${h(l)}</div>`).join('')}</div>`);
      throw e;
    }
    draft = r.scenario;
    draft.lint = r.lint;
    if (r.warnings && r.warnings.length) toast(r.warnings.map(tt).join('; '));
    await loadYamlText();
    dirty = false;
    return draft;
  }
  draft.name = document.getElementById('sc-name').value.trim() || t('Без названия');
  draft.description = document.getElementById('sc-desc').value.trim();
  // an empty value tells the server to drop the field (a PUT merges over the saved scenario)
  draft.engine = engine || '';
  draft.tab = (document.getElementById('sc-tab') || {}).value || '';
  for (const s of draft.steps) {
    if (s.type === 'api' && typeof s.body === 'string' && s.body.trim()) {
      try { s.body = JSON.parse(s.body); } catch { /* keep as text with placeholders */ }
    }
  }
  delete draft.yamlText;
  const bad = document.querySelector('[data-f].bad');
  if (bad) throw new Error(t('В шаге есть поле с неправильным JSON — исправь перед сохранением'));
  const saved = draft.id ? await api('PUT', '/api/scenarios/' + encodeURIComponent(draft.id), draft) : await api('POST', '/api/scenarios', draft);
  draft = saved;
  dirty = false;
  if (draft.lint && draft.lint.errors.length) toast(t('Сценарий сохранён, но есть ошибки: {e}', { e: tt(draft.lint.errors[0]) }));
  return saved;
}

async function loadYamlText() {
  const res = await fetch('/api/scenarios/' + encodeURIComponent(draft.id) + '/export?format=yaml');
  draft.yamlText = (await res.text()).replace(/^#.*\n\n?/, '');
}

// ---------- import ----------
let importFiles = [];
async function viewImport() {
  $app.innerHTML = `
    <div class="crumbs"><a href="#/">${t('Сценарии')}</a> / ${t('импорт')}</div>
    <section class="card pad col">
      <h2>${t('Импорт сценариев, настроек и ключей')}</h2>
      <div class="hint">${t('Понимает: YAML и JSON консоли (сценарий, список шагов, библиотеку блоков или пакет с settings / secrets / blocks / scenarios), flow Maestro (подпотоки runFlow подставятся, если загрузить их вместе), .env с ключами (API_BASE, FIGMA_TOKEN, AUTH_PLUGIN, &lt;РОЛЬ&gt;_PHONE / _OTP / _TOKEN / _REFRESH_TOKEN… — остальное станет переменными). Из терминала: <span class="mono">node tools/e2e.js import &lt;файлы или папка&gt;</span>')}</div>
      <label class="drop" id="drop" tabindex="0">${t('Перетащи файлы сюда или нажми, чтобы выбрать (.yaml, .yml, .json, .env)')}
        <input type="file" id="imp-files" multiple accept=".yaml,.yml,.json,.env,.js,text/plain" hidden></label>
      <div id="imp-chosen" class="hint"></div>
      <label class="field">${t('…или вставь текст')}<textarea class="code" id="imp-text" spellcheck="false" placeholder="appId: com.example.app&#10;---&#10;- launchApp&#10;- tapOn: &quot;Каталог&quot;"></textarea></label>
      <div style="display:flex;gap:12px;flex-wrap:wrap;align-items:flex-end">
        <label class="field">${t('Формат')}<select id="imp-mode">
          <option value="auto">${t('определить сам')}</option><option value="native">${t('YAML / JSON консоли')}</option>
          <option value="maestro">${t('Maestro flow')}</option><option value="env">${t('.env (ключи и переменные)')}</option></select></label>
        <button class="btn primary" data-act="imp-check">${t('Проверить')}</button>
        <button class="btn" data-act="imp-clear">${t('Очистить')}</button>
      </div>
    </section>
    <div id="imp-result"></div>`;
  renderImportChosen();
}
function renderImportChosen() {
  const el = document.getElementById('imp-chosen');
  if (el) el.textContent = importFiles.length ? t('Выбрано: {f}', { f: importFiles.map((f) => f.name).join(', ') }) : '';
}
function readImportInputs() {
  const files = importFiles.slice();
  const text = document.getElementById('imp-text').value;
  if (text.trim()) files.push({ name: t('вставленный текст'), content: text });
  return files;
}
function renderImportPreview(r) {
  const box = document.getElementById('imp-result');
  const sc = r.scenarios || [];
  const settingsRows = r.settings ? Object.entries(r.settings).map(([k, v]) => `<div class="mono">${h(k)}: ${h(typeof v === 'object' ? JSON.stringify(v) : v)}</div>`).join('') : '';
  box.innerHTML = `
    <section class="card pad col">
      <h2>${t('Что будет импортировано')}</h2>
      <div class="hint">${(r.files || []).map((f) => `${h(f.name)} — ${h(f.mode)}`).join(' · ')}</div>
      ${r.warnings && r.warnings.length ? `<div class="issues">${r.warnings.map((w) => `<div class="issue warn">${h(tt(w))}</div>`).join('')}</div>` : ''}
      ${sc.length ? `<div class="imp-list">${sc.map((x, i) => {
        const raw = x.steps.filter((st) => st.type === 'maestro').length;
        return `<label class="imp-row"><input type="checkbox" data-imp="${i}" checked>
          <span><b>${h(x.name)}</b> ${engineChip(x.engine || defaultEngine)}
          <div class="sub">${h(t('{n} шагов', { n: x.steps.length }))}${raw ? h(t(' · из них {n} — команды Maestro как есть', { n: raw })) : ''}${x.conflict ? h(t(' · уже есть сценарий {id}', { id: x.conflict })) : ''}</div></span></label>`;
      }).join('')}</div>
      <label class="field" style="max-width:360px">${t('Если такой сценарий уже есть')}<select id="imp-conflict"><option value="copy">${t('добавить копию')}</option><option value="replace">${t('заменить')}</option></select></label>` : `<div class="hint">${t('Сценариев в файлах нет.')}</div>`}
      ${importBlocksHtml(r.blocks || [])}
      ${settingsRows ? `<div><h2 style="font-size:15px;margin:6px 0">${t('Настройки и ключи')}</h2>${settingsRows}</div>
        <label class="field check"><input type="checkbox" id="imp-settings" checked>${t('Применить настройки и ключи')}</label>` : ''}
      <div><button class="btn primary" data-act="imp-apply" ${sc.length || settingsRows || (r.blocks || []).some((b) => b.status !== 'same') ? '' : 'disabled'}>${t('Импортировать')}</button></div>
    </section>`;
}
// Shared blocks in the files, by name against the library: a new one is added (untick to skip), the same one
// needs nothing, a different one stays yours unless «заменить» is chosen.
function importBlocksHtml(list) {
  if (!list.length) return '';
  const params = (b) => (b.params.length ? ' · ' + t('параметры: {p}', { p: b.params.join(', ') }) : '');
  return `<div><h2 style="font-size:15px;margin:6px 0">${t('Блоки')}</h2><div class="imp-list">${list.map((b) => {
    if (b.status === 'new') return `<label class="imp-row"><input type="checkbox" data-imp-block="${h(b.name)}" checked><span><b>${h(b.name)}</b> <span class="chip">${t('новый')}</span><div class="sub">${h(t('{n} шагов', { n: b.steps }) + params(b))}</div></span></label>`;
    if (b.status === 'same') return `<div class="imp-row"><span><b>${h(b.name)}</b> <span class="chip">${t('уже есть, такой же')}</span></span></div>`;
    return `<div class="imp-row"><span><b>${h(b.name)}</b> <span class="chip">${t('отличается от вашего')}</span>
      <div class="sub">${h(t('у вас: {a} шагов ({f}) · в файле: {b} шагов', { a: b.mineSteps, f: b.file, b: b.steps }) + params(b))}</div>
      <select data-imp-block="${h(b.name)}"><option value="keep">${t('оставить мой')}</option><option value="replace">${t('заменить')}</option></select></span></div>`;
  }).join('')}</div></div>`;
}

// ---------- performance history ----------
// /api/perf/summary: devices → builds → sections → scenarios (+variants); medians over the passed measured runs.
const perfView = { device: null, build: null, compare: null };
// a change between two numbers; `lowerIsBetter` for milliseconds and shares. Repeated runs of one build
// differ by 4–13 points on a phone and up to 34 on an emulator, so a change is coloured only when both sides
// have 2+ runs (`n` — the smaller count) and it is wider than the spread of either side (`noise`).
function delta(a, b, { lowerIsBetter = false, suffix = '', digits = 0, noise = null, n = null } = {}) {
  if (a == null || b == null) return '';
  const d = Math.round((b - a) * 10 ** digits) / 10 ** digits;
  if (d === 0) return '<span class="delta zero">±0</span>';
  const txt = `${d > 0 ? '+' : ''}${h(d)}${suffix}`;
  if (n != null && n < 2) return `<span class="delta zero" title="${t('С одной из сторон один замер: разброс неизвестен, это не сравнение. Замерь ещё 2–4 раза.')}">${txt} · ${t('1 замер')}</span>`;
  if (noise != null && Math.abs(d) <= noise) return `<span class="delta zero" title="${h(t('Разница не больше разброса повторных замеров (до {s}{u}) — от шума не отличить', { s: Math.round(noise * 10 ** digits) / 10 ** digits, u: suffix }))}">${txt} · ${t('в шуме')}</span>`;
  const better = lowerIsBetter ? d < 0 : d > 0;
  return `<span class="delta ${better ? 'good' : 'bad'}">${txt}</span>`;
}
// the spread behind a median: «min–max» over the runs, nothing for one run or no spread
function spread(rng, fmt = (x) => h(x)) {
  return rng && rng[0] !== rng[1] ? ` <small class="sub" style="display:inline" title="${t('мин–макс по замерам')}">${fmt(rng[0])}–${fmt(rng[1])}</small>` : '';
}
// the noise a change between two medians has to beat: the wider of the two min–max ranges
const noiseOf = (ra, rb, scale = 1) => (ra && rb ? Math.max(ra[1] - ra[0], rb[1] - rb[0]) * scale : null);
async function viewPerf() {
  const sum = await api('GET', '/api/perf/summary');
  const devices = sum.devices || [];
  if (!devices.length) {
    $app.innerHTML = `<div class="crumbs"><a href="#/">${t('Сценарии')}</a> / ${t('история')}</div><div class="empty">${t('Замеров ещё не было. На главной в разделе «Нагрузка» нажми «⏱ Замерить» у сценария — или «Замерить всё».')}</div>`;
    return;
  }
  const dev = devices.find((d) => d.key === perfView.device) || devices[0];
  perfView.device = dev.key;
  const build = dev.builds.find((b) => b.key === perfView.build) || dev.builds[0];
  perfView.build = build.key;
  const ratio = build.max ? build.total / build.max : 0;
  const cls = ratio >= 0.85 ? 'good' : ratio >= 0.6 ? 'ok' : 'bad';
  const sections = sum.sections || [];
  const trend = dev.builds.slice(0, 10);
  // the build to compare with: chosen, else the one measured right before this one on this device
  const idx = dev.builds.findIndex((b) => b.key === build.key);
  const base = dev.builds.find((b) => b.key === perfView.compare && b.key !== build.key) || dev.builds[idx + 1] || dev.builds.find((b) => b.key !== build.key) || null;
  // Δ of totals only over the sections both builds have; a different set of sections is flagged, not averaged
  const totalDelta = (p, b) => {
    const common = b.sections.filter((s) => p.sections.some((x) => x.name === s.name));
    const sumB = common.reduce((a, s) => a + s.score, 0), sumA = common.reduce((a, s) => a + p.sections.find((x) => x.name === s.name).score, 0);
    const same = common.length === b.sections.length && common.length === p.sections.length;
    // the totals' noise: the wider of the two sums of section ranges over the common sections
    const width = (bb) => common.reduce((a, s) => { const x = bb.sections.find((y) => y.name === s.name); return a + (x.range ? x.range[1] - x.range[0] : 0); }, 0);
    const n = Math.min(...common.map((s) => Math.min(s.minRuns ?? 1, (p.sections.find((x) => x.name === s.name).minRuns ?? 1))));
    return common.length ? delta(sumA, sumB, { noise: Math.max(width(p), width(b)), n }) + (same ? '' : ` <span class="sub" title="${t('наборы разделов различаются: Δ по общим разделам')}">≠</span>`) : '<span class="sub">—</span>';
  };
  const secDelta = (a, b) => (a && b ? delta(a.score, b.score, { noise: noiseOf(a.range, b.range), n: Math.min(a.minRuns ?? 1, b.minRuns ?? 1) }) : '');
  const itemsOf = (b) => new Map(b.sections.flatMap((s) => s.items.map((it) => [`${it.scenarioId}|${it.variant || ''}`, { ...it, section: s.name }])));
  const prevOf = (i) => dev.builds[i + 1] || null;
  // a build is what was installed: version name, versionCode and the APK digest (runs before 2026-11-11 have none)
  const verOf = (b) => [b.version, b.versionCode ? `(${b.versionCode})` : '', b.apkMd5 ? `#${b.apkMd5.slice(0, 6)}` : ''].filter(Boolean).join(' ');
  const buildOpt = (b) => `${h(b.apk)}${verOf(b) ? ` · ${h(verOf(b))}` : ''} — ${h(b.total)}/${h(b.max)} · ${h(when(b.lastAt))}`;
  $app.innerHTML = `
    <div class="crumbs"><a href="#/">${t('Сценарии')}</a> / ${t('история производительности')}</div>
    <div class="tabs">${devices.map((d) => `<button class="tab ${d.key === dev.key ? 'on' : ''}" data-act="perf-dev" data-key="${h(d.key)}">${h(tt(d.name))}${d.chip ? `<small>${h(d.chip)}</small>` : d.emulator ? `<small>${t('хост этого ПК')}</small>` : ''}</button>`).join('')}</div>
    <section class="card pad total-card">
      <div class="total ${cls}"><div class="k">${t('Итого на этом устройстве')}</div><div class="v">${h(build.total)}<small> ${h(t('из {m}', { m: build.max }))}</small>${spread(build.range)}</div><div class="sub">${h(t('{n} раздел(а/ов) по 100 · {r} замеров · {when}', { n: build.sections.length, r: build.runs, when: when(build.lastAt) }))}</div></div>
      <div class="col" style="gap:8px;flex:1 1 260px">
        <label class="field">${t('Сборка')}<select data-act="perf-build">${dev.builds.map((b) => `<option value="${h(b.key)}" ${b.key === build.key ? 'selected' : ''}>${buildOpt(b)}</option>`).join('')}</select></label>
        <div class="hint">${t('Балл сценария — медиана его замеров на этой сборке и устройстве; балл раздела — среднее по его сценариям; итого — сумма разделов, поэтому растёт с числом разделов, а слабый раздел виден дырой, а не размазывается.')}</div>
        <div class="hint">${t('Мелким рядом с медианой — мин–макс по замерам. Повторные замеры одной сборки расходятся на 4–13 баллов на телефоне и до 34 на эмуляторе, поэтому разница меньше разброса помечена «в шуме», а при одном замере — «1 замер». Для сравнения сборок нужно 3–5 замеров каждой.')}</div>
      </div>
    </section>
    <div class="sections">${build.sections.map((s) => `
      <section class="card">
        <div class="card-head"><h2>${h(tt(s.name))} ${scoreBadge(s.score)}${spread(s.range)}</h2><span class="sub">${h(t('{n} сценар.', { n: s.items.length }))}</span></div>
        <div class="scroll-x"><table class="perf"><thead><tr><th>${t('Сценарий')}</th><th>${t('Балл')}</th><th>p95</th><th>Jank</th><th>${t('Старт')}</th><th>Flashlight</th><th>${t('Замеров')}</th><th></th></tr></thead><tbody>
          ${s.items.map((it) => `<tr><td><b>${h(it.name)}</b>${it.variant ? ` <span class="tag">${h(it.variantTitle || it.variant)}</span>` : ''}</td><td>${scoreBadge(it.score)}${spread(it.range && it.range.score)}</td><td>${fmtMs(it.p95)}${spread(it.range && it.range.p95, fmtMs)}</td><td>${pct(it.jank)}${spread(it.range && it.range.jank, pct)}</td><td>${it.startMs ? fmtMs(it.startMs) : '—'}</td><td>${it.flashlight == null ? '—' : Math.round(it.flashlight)}</td><td>${h(it.runs)}${it.rescored ? ` <span class="sub" style="display:inline" title="${h(t('{n} из замеров записаны без отметки формулы балла — их балл пересчитан из сохранённых кадров по текущей формуле', { n: it.rescored }))}">*</span>` : ''}</td><td class="actions"><a href="#/run/${h(it.lastRunId)}">${t('Отчёт')}</a><button class="btn small" data-act="measure" data-id="${h(it.scenarioId)}" data-variant="${h(it.variant || '')}" title="${t('Замерить ещё раз')}">⏱</button></td></tr>`).join('')}
        </tbody></table></div>
      </section>`).join('')}</div>
    ${base ? (() => {
      const A = itemsOf(base), B = itemsOf(build);
      const keys = [...new Set([...A.keys(), ...B.keys()])].sort((x, y) => { const a = A.get(x) || B.get(x), b = A.get(y) || B.get(y); return a.section.localeCompare(b.section) || a.name.localeCompare(b.name) || String(a.variant).localeCompare(String(b.variant)); });
      const secA = new Map(base.sections.map((s) => [s.name, s])), secB = new Map(build.sections.map((s) => [s.name, s]));
      const secNames = [...new Set([...secA.keys(), ...secB.keys()])].sort();
      const pp = t('п.п.');
      return `<section class="card" style="margin-bottom:16px">
        <div class="card-head" style="align-items:center"><h2>${t('Сравнение сборок')}</h2>
          <label class="field" style="margin:0;min-width:260px">${t('База')}<select data-act="perf-compare">${dev.builds.filter((b) => b.key !== build.key).map((b) => `<option value="${h(b.key)}" ${b.key === base.key ? 'selected' : ''}>${buildOpt(b)}</option>`).join('')}</select></label></div>
        <div class="pad" style="padding-top:0"><div class="compare-head"><span class="sub">${h(base.apk)}${verOf(base) ? ` · ${h(verOf(base))}` : ''}</span><b>${h(base.total)}</b>${spread(base.range)}<span class="arrow">→</span><b>${h(build.total)}</b>${spread(build.range)}<span class="sub">${h(build.apk)}${verOf(build) ? ` · ${h(verOf(build))}` : ''}</span>${totalDelta(base, build)}
          <span class="sub" style="margin-left:12px">${t('разделы: ')}${secNames.map((n) => `${h(tt(n))} ${secA.has(n) ? h(secA.get(n).score) : '—'} → ${secB.has(n) ? h(secB.get(n).score) : '—'} ${secDelta(secA.get(n), secB.get(n))}`).join(' · ')}</span></div></div>
        <div class="scroll-x"><table class="perf"><thead><tr><th>${t('Раздел')}</th><th>${t('Сценарий')}</th><th>${t('Балл')}</th><th>${t('p95 стоимости')}</th><th>Jank</th><th>${t('Старт')}</th><th>${t('Замеров')}</th></tr></thead><tbody>
          ${keys.map((k) => { const a = A.get(k), b = B.get(k); const it = b || a;
            // every Δ carries the noise of its own metric and the smaller run count of the two sides
            const nz = (f, scale = 1) => ({ noise: noiseOf(a && a.range && a.range[f], b && b.range && b.range[f], scale), n: a && b ? Math.min(a.runs, b.runs) : null });
            const cell = (f, opts, fmt) => `${a ? fmt(a[f]) : '—'} → ${b ? fmt(b[f]) : '—'} ${a && b ? delta(a[f], b[f], { ...opts, ...nz(f) }) : ''}`;
            return `<tr><td class="sub">${h(tt(it.section))}</td><td><b>${h(it.name)}</b>${it.variant ? ` <span class="tag">${h(it.variantTitle || it.variant)}</span>` : ''}${!a ? ` <span class="tag">${t('новый')}</span>` : !b ? ` <span class="tag">${t('не мерялся')}</span>` : ''}</td>
              <td>${cell('score', {}, (x) => h(x))}</td><td>${cell('p95', { lowerIsBetter: true, suffix: ' ' + t('мс'), digits: 1 }, fmtMs)}</td><td>${a && b ? `${pct(a.jank)} → ${pct(b.jank)} ${delta(Math.round(a.jank * 100), Math.round(b.jank * 100), { lowerIsBetter: true, suffix: ' ' + pp, ...nz('jank', 100) })}` : `${a ? pct(a.jank) : '—'} → ${b ? pct(b.jank) : '—'}`}</td><td>${cell('startMs', { lowerIsBetter: true, suffix: ' ' + t('мс') }, (x) => (x == null ? '—' : fmtMs(x)))}</td><td class="sub">${h(a ? a.runs : 0)} → ${h(b ? b.runs : 0)}</td></tr>`; }).join('')}
        </tbody></table></div>
      </section>`;
    })() : ''}
    <section class="card">
      <div class="card-head"><h2>${t('По сборкам')}</h2><span class="sub">${h(tt(dev.name))} · ${h(t('последние {n} · Δ — к предыдущей сборке на этом устройстве', { n: trend.length }))}</span></div>
      <div class="scroll-x"><table class="perf"><thead><tr><th>${t('Сборка')}</th><th>${t('Итого')}</th><th>Δ</th>${sections.map((n) => `<th>${h(tt(n))}</th>`).join('')}<th>${t('Замеров')}</th><th>${t('Когда')}</th></tr></thead><tbody>
        ${trend.map((b) => { const p = prevOf(dev.builds.indexOf(b)); return `<tr class="${b.key === build.key ? 'cur' : ''}" data-act="perf-build-row" data-key="${h(b.key)}" style="cursor:pointer"><td style="font-family:var(--mono);font-size:12px">${h(b.apk)}${verOf(b) ? `<br><span class="sub">${h(t('версия {v}', { v: verOf(b) }))}</span>` : ''}</td><td><b>${h(b.total)}</b> <span class="sub" style="display:inline">/ ${h(b.max)}</span>${spread(b.range)}</td><td>${p ? totalDelta(p, b) : '<span class="sub">—</span>'}</td>${sections.map((n) => { const s = b.sections.find((x) => x.name === n); const ps = p && p.sections.find((x) => x.name === n); return `<td>${s ? scoreBadge(s.score) : '<span class="sub">—</span>'}${s && ps ? ` <small>${secDelta(ps, s)}</small>` : ''}</td>`; }).join('')}<td>${h(b.runs)}</td><td class="sub">${h(when(b.lastAt))}</td></tr>`; }).join('')}
      </tbody></table></div>
    </section>`;
}

// ---------- getting started ----------
// A live checklist from /api/setup: tools → device → app → backend → first scenario. The bare console opens here.
async function viewStart() {
  const x = await api('GET', '/api/setup');
  const ok = (b) => (b ? '<span class="mark ok">✓</span>' : '<span class="mark bad">✕</span>');
  const opt = (b) => (b ? '<span class="mark ok">✓</span>' : '<span class="mark off">○</span>');
  const android = x.devices.filter((d) => d.platform === 'android');
  const stepDone = [x.adb.ok, android.length > 0, !!x.app.package && x.app.installed !== false, true, x.scenarios > 0];
  $app.innerHTML = `
    <div class="crumbs"><a href="#/">${t('Сценарии')}</a> / ${t('как начать')}</div>
    <div class="start">
      <section class="card pad start-step ${stepDone[0] ? 'done' : ''}">
        <h2>${ok(x.adb.ok)} ${t('1. Инструменты Android')}</h2>
        <p>${t('Консоль управляет устройством через <b>adb</b> и запускает эмулятор через <b>emulator</b> из Android SDK. Ставятся вместе с Android Studio (SDK Manager → Android SDK Platform-Tools и Android Emulator).')}</p>
        <div class="kv"><span>adb</span><span class="mono">${h(x.adb.path || '—')}</span><span>${x.adb.ok ? h(x.adb.version || t('найден')) : t('не найден')}</span></div>
        <div class="kv"><span>emulator</span><span class="mono">${h(x.emulator.path || '—')}</span><span>${x.emulator.ok ? h(t('найден · AVD: {a}', { a: x.emulator.avds.length ? x.emulator.avds.join(', ') : t('ни одного') })) : t('не найден')}</span></div>
        <div class="kv"><span>${t('Браузер')}</span><span class="mono">${h((x.browser || {}).path || '—')}</span><span>${x.browser && x.browser.ok ? h(t('найден: {n} — шаги в браузере доступны', { n: x.browser.name })) : h(tt((x.browser || {}).error || ''))}</span></div>
        ${x.adb.ok ? '' : `<div class="note warned">${t('Укажи пути в <a href="#/settings">настройках</a> или поставь Android SDK. Без adb ничего не поедет.')}</div>`}
      </section>
      <section class="card pad start-step ${stepDone[1] ? 'done' : ''}">
        <h2>${ok(android.length)} ${t('2. Устройство')}</h2>
        <p>${t('Нужен запущенный эмулятор или телефон с включённой отладкой по USB. Подключённые сейчас: {d}.', { d: x.devices.length ? x.devices.map((d) => `<b>${h(d.name)}</b>${d.platform === 'ios' ? ' (iOS)' : ''}`).join(', ') : `<b>${t('никого')}</b>` })}</p>
        <div class="start-row">
          ${x.emulator.ok && x.emulator.avds.length ? `<label class="field" style="margin:0">${t('Эмулятор')}<select id="start-avd">${x.emulator.avds.map((a) => `<option ${a === x.emulator.avd ? 'selected' : ''}>${h(a)}</option>`).join('')}</select></label><button class="btn" data-act="start-emulator">${t('Запустить эмулятор')}</button>` : x.emulator.ok ? `<span class="hint">${t('AVD нет — создай в Android Studio → Device Manager')}</span>` : ''}
          <a class="btn" href="#/connect">${t('+ телефон (кабель или Wi-Fi)')}</a>
        </div>
      </section>
      <section class="card pad start-step ${stepDone[2] ? 'done' : ''}">
        <h2>${ok(x.app.package && x.app.installed !== false)} ${t('3. Приложение')}</h2>
        <p>${t('Консоли нужно знать пакет и стартовый экран приложения: шаг «Открыть приложение» запускает именно их. Проще всего открыть приложение на устройстве и нажать «Взять с экрана».')}</p>
        <div class="form-grid">
          <label class="field">${t('Пакет')}<input type="text" id="start-package" value="${h(x.app.package || '')}" placeholder="com.example.app"></label>
          <label class="field">${t('Стартовый экран (activity)')}<input type="text" id="start-activity" value="${h(x.app.activity || '')}" placeholder="com.example.app.MainActivity"></label>
          <label class="field">${t('Путь к APK')}<input type="text" id="start-apk" value="${h(x.app.apkPath || '')}" placeholder="C:\\…\\app-debug.apk"><span class="hint">${x.app.apkPath ? (x.app.apkOk ? t('файл есть') : t('файла нет по этому пути')) : t('необязательно: нужен для кнопки «Установить APK»')}</span></label>
          <label class="field">${t('Название в шапке')}<input type="text" id="start-appname" value="${h(x.app.appName || '')}" placeholder="${t('Моё приложение · покупатель')}"></label>
        </div>
        <div class="start-row">
          <button class="btn" data-act="start-foreground" ${android.length ? '' : `disabled title="${t('нет устройства')}"`}>${t('Взять с экрана устройства')}</button>
          <button class="btn primary" data-act="start-save-app">${t('Сохранить')}</button>
          ${x.app.apkOk && android.length ? `<button class="btn" data-act="start-install">${t('Установить APK')}</button>` : ''}
          <span class="hint">${x.app.package ? (x.app.installed === null ? t('установлено ли — проверю, когда появится устройство') : x.app.installed ? h(t('{p} установлено на устройстве', { p: x.app.package })) : h(t('{p} на устройстве нет — установи APK', { p: x.app.package }))) : ''}</span>
        </div>
      </section>
      <section class="card pad start-step">
        <h2>${opt(x.backend.apiBase)} ${t('4. Бэкенд — по желанию')}</h2>
        <p>${t('Шаги «Проверить бэкенд» ходят в API стенда от имени настроенных ролей — аккаунтов со своими токенами и правами. Без этого сценарии всё равно работают: тапы, проверки экрана, замеры.')}</p>
        <div class="kv"><span>API</span><span class="mono">${h(x.backend.apiBase || '—')}</span><span>${x.backend.envName ? h(t('стенд {e}', { e: x.backend.envName })) : ''}</span></div>
        <div class="kv"><span>${t('Роли')}</span><span>${x.backend.accounts.length ? h(x.backend.accounts.join(', ')) : '—'}</span><span></span></div>
        <div class="kv"><span>${t('Плагин входа')}</span><span class="mono">${h(x.backend.plugin || '—')}</span><span>${x.backend.plugin ? (x.backend.pluginOk ? t('найден') : t('файла нет')) : t('токены можно вписать руками в настройках')}</span></div>
        <div class="hint">${t('Всё это — в <a href="#/settings">настройках</a>. Пример плагина входа, который сам получает токены по номеру и коду: <span class="mono">examples/auth-plugin.js</span>.')}</div>
      </section>
      <section class="card pad start-step ${stepDone[4] ? 'done' : ''}">
        <h2>${ok(x.scenarios > 0)} ${t('5. Первый сценарий')}</h2>
        <p>${t('Сценарий — список шагов: открыть приложение, нажать кнопку, проверить, что на экране появился нужный текст. Пишется формой или YAML, конфиг собирается сам. Сейчас сценариев: <b>{s}</b>, блоков в библиотеке: <b>{b}</b>.', { s: h(x.scenarios), b: h(x.blocks) })}</p>
        <div class="row" style="display:flex;gap:10px;flex-wrap:wrap">
          <a class="btn primary" href="#/edit/new">${t('Создать сценарий')}</a>
          <a class="btn" href="#/import">${t('Импортировать готовые')}</a>
        </div>
        <div class="hint" style="margin-top:8px">${t('Готовый набор под своё приложение удобно держать пресетом — один YAML с настройками, блоками и сценариями, его импорт настраивает консоль целиком. Примеры: <span class="mono">examples/scenario.yaml</span>, <span class="mono">examples/scenario-advanced.yaml</span>, <span class="mono">examples/blocks.yaml</span>. Дальше: «▶ Запустить» у сценария — прогон со скриншотами по шагам; «⏱» — то же с замером скорости; «История» — баллы по сборкам.')}</div>
      </section>
    </div>`;
}

// ---------- connect a phone over Wi-Fi ----------
async function viewConnect() {
  const [d, s] = await Promise.all([api('GET', '/api/device'), api('GET', '/api/settings')]);
  const known = new Map((s.devices || []).map((x) => [x.serial, x]));
  const phones = (d.details || []).filter((x) => x.platform === 'android');
  $app.innerHTML = `
    <div class="crumbs"><a href="#/">${t('Сценарии')}</a> / ${t('подключить телефон')}</div>
    <div class="split">
      <section class="card pad col main">
        <h2>${t('Телефон по кабелю или Wi-Fi')}</h2>
        <div class="note passed">${t('<b>Проще всего — кабель.</b> На телефоне «Для разработчиков → Отладка по USB», подключить, на телефоне разрешить отладку с этого компьютера («Всегда»). Телефон сразу появится справа; кнопка «Перевести на Wi-Fi» там же отвяжет его от провода. Wi-Fi без кабеля — по шагам ниже.')}</div>
        <ol class="help">
          <li>${t('<b>Настройки → О телефоне</b> → 7 раз нажать на номер версии → «Вы стали разработчиком».')}</li>
          <li>${t('<b>Для разработчиков</b> (в «Расширенных настройках») → включить <b>Беспроводную отладку</b>. Телефон и этот компьютер — в одной Wi-Fi сети. На Xiaomi/POCO там же включи <b>Установку через USB</b> (иначе APK не поставится) и <b>Отладку по USB (Настройки безопасности)</b> — без неё сценарии с «чистыми данными» падают на очистке приложения; пункт просит Mi-аккаунт.')}</li>
          <li>${t('Открыть пункт <b>Беспроводная отладка</b> → <b>Подключить устройство с помощью кода</b>. На экране — 6-значный код и адрес <span class="mono">IP:порт</span>. <b>Не закрывай это окно</b>, пока не нажмёшь «Подключить»: код живёт, пока оно открыто.')}</li>
        </ol>
        <div class="form-grid">
          <label class="field">${t('Адрес сопряжения — из окна с кодом')}<input type="text" id="pair-addr" placeholder="192.168.1.23:41235" autocomplete="off"></label>
          <label class="field">${t('Код сопряжения')}<input type="text" id="pair-code" placeholder="123456" inputmode="numeric" autocomplete="off"></label>
          <label class="field">${t('Адрес подключения — с главного экрана «Беспроводная отладка», порт другой')}<input type="text" id="pair-connect" placeholder="${t('пусто — найду сам (mDNS)')}" autocomplete="off"><span class="hint">${t('Сопряжение делается один раз. В следующий раз хватит этого поля: порт меняется при каждом включении беспроводной отладки.')}</span></label>
        </div>
        <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap"><button class="btn primary" data-act="pair-go">${t('Подключить')}</button><span class="hint" id="pair-state"></span></div>
        <pre id="pair-log" class="code" style="display:none;margin:0;font:12px/1.5 var(--mono);white-space:pre-wrap"></pre>
      </section>
      <aside class="card pad col side">
        <h2>${t('Подключённые устройства')}</h2>
        ${phones.length ? `<div class="col" style="gap:10px">${phones.map((p) => `<div class="note skipped" style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
            <span style="flex:1 1 140px"><b>${h((known.get(p.serial) || {}).name || p.name)}</b><br><span class="sub mono">${h(p.serial)}</span></span>
            ${s.apkPath ? `<button class="btn small" data-act="pair-install" data-serial="${h(p.serial)}">${t('Поставить APK')}</button>` : ''}
            ${/:\d+$/.test(p.serial) ? `<button class="btn small" data-act="pair-disconnect" data-serial="${h(p.serial)}">${t('Отключить')}</button>`
              : /^emulator-/.test(p.serial) ? `<button class="btn small" data-act="pair-hygiene" data-serial="${h(p.serial)}" title="${t('adb root и команды гигиены из настроек, затем нагрузка гостя')}">${t('Подготовить к замеру')}</button>` : `<button class="btn small" data-act="pair-wifi" data-serial="${h(p.serial)}" title="${t('adb tcpip 5555: тот же телефон по Wi-Fi, кабель можно отключить')}">${t('Перевести на Wi-Fi')}</button>`}
          </div>`).join('')}</div>` : `<div class="empty">${t('Пока только то, что видит adb: ничего.')}</div>`}
        <div class="hint">${t('Подключённый телефон появляется в выборе устройства в шапке; у любого сценария «⏱» запускает замер на нём. Для калибровки телефон должен быть залогинен тем же покупателем, что и эмулятор, — или прогони на нём «Вход по номеру».')}</div>
      </aside>
    </div>`;
}

// ---------- settings ----------
function accountRow(role, a) {
  return `<tr data-acc data-acc-was="${h(role)}"><td><input type="text" data-acc-f="role" value="${h(role)}" placeholder="${t('роль')}"></td><td><input type="text" data-acc-f="phone" value="${h((a || {}).phone || '')}"></td><td><input type="text" data-acc-f="otp" value="${h((a || {}).otp || '')}" style="width:80px"></td><td><input type="password" data-acc-f="token" value="${h((a || {}).token || '')}" autocomplete="off" placeholder="${(a || {}).refreshToken ? t('refresh-токен сохранён') : ''}"></td><td><button class="icon" data-act="acc-del" aria-label="${t('Убрать роль')}">✕</button></td></tr>`;
}
async function viewSettings() {
  const s = await api('GET', '/api/settings');
  const blocksText = (await api('GET', '/api/blocks').catch(() => ({ text: '' }))).text || '';
  const val = (k) => k.split('.').reduce((o, p) => (o == null ? undefined : o[p]), s);
  const field = (k, label, hint = '', type = 'text') => `<label class="field">${label}<input type="${type}" data-s="${k}" value="${h(val(k) ?? '')}" ${type === 'password' ? 'autocomplete="off"' : ''}>${hint ? `<span class="hint">${hint}</span>` : ''}</label>`;
  const check = (k, label, hint = '') => `<label class="field check"><input type="checkbox" data-s="${k}" ${val(k) ? 'checked' : ''}>${label}${hint ? ` <span class="hint">${hint}</span>` : ''}</label>`;
  $app.innerHTML = `
    <div class="crumbs"><a href="#/">${t('Сценарии')}</a> / ${t('настройки')}</div>
    <section class="card pad col">
      <h2>${t('Приложение и устройство')}</h2>
      <div class="form-grid">
        ${field('appName', t('Название в шапке'), t('пусто = E2E Console'))}
        ${field('apkPath', t('Путь к APK'), t('кнопка «Установить APK» ставит этот файл'))}
        ${field('package', t('Пакет приложения (Android)'), `<button class="btn small" data-act="settings-foreground" type="button">${t('Взять с экрана устройства')}</button>`)}
        ${field('activity', t('Стартовый экран (activity)'), t('заполняется той же кнопкой'))}
        ${field('bundleId', t('Bundle id (iOS)'), t('симулятор iOS ведёт Maestro; только на macOS'))}
        ${field('avd', t('Эмулятор (AVD)'))}
        ${field('serial', t('Серийный номер устройства'), t('пусто = любое свободное; при нескольких устройствах выбор есть в шапке'))}
        ${field('adbPath', t('Путь к adb'))}
      </div>
      <label class="field">${t('Известные устройства (JSON-список: serial, platform android|ios, name)')}<textarea class="code" id="devices" spellcheck="false" style="min-height:60px">${h((s.devices || []).length ? JSON.stringify(s.devices, null, 1) : '')}</textarea></label>
      <label class="field">${t('Гигиена эмулятора перед замером — shell-команды, по одной в строке (кнопка «Подготовить» на странице «+ телефон»; сначала пробуется adb root)')}<textarea class="code" id="hygiene" spellcheck="false" style="min-height:60px" placeholder="stop vendor.radio-ranchu">${h((s.emulatorHygiene || []).join('\n'))}</textarea></label>
      <h2>${t('Бэкенд')}</h2>
      <div class="form-grid">
        ${field('envName', t('Название стенда'))}
        ${field('apiBase', t('Адрес API'), t('к нему прибавляются адреса из шагов «Проверить бэкенд»'))}
        ${field('auth.plugin', t('Плагин входа'), t('JS-модуль с freshToken(): путь от папки консоли или абсолютный. Пусто — токены из таблицы ниже'))}
        ${check('autoToken', t('Обновлять токены плагином перед прогоном'))}
        <label class="field">${t('Аккаунт самого приложения')}<select data-s="auth.appAccount">${(setRoles(s), roleNames).map((r) => `<option value="${h(r)}" ${r === defaultRoleName ? 'selected' : ''}>${h(r)}</option>`).join('')}</select><span class="hint">${t('для этой роли новый вход делается только сценариями с очисткой данных')}</span></label>
      </div>
      <h2>${t('Роли (аккаунты для шагов «Проверить бэкенд»)')}</h2>
      <div class="hint">${t('В шаге: <span class="mono">auth: &lt;роль&gt;</span>; по умолчанию — аккаунт самого приложения. Токен — если плагина входа нет; номер и код — для плагина. В шагах доступны {{роль.phone}}, {{роль.token}}.')}</div>
      <table class="accounts" id="accounts"><thead><tr><th>${t('Роль')}</th><th>${t('Номер')}</th><th>${t('Код (OTP)')}</th><th>${t('Токен (Bearer)')}</th><th></th></tr></thead><tbody>
        ${Object.entries(s.accounts || {}).map(([role, a]) => accountRow(role, a)).join('')}
      </tbody></table>
      <div><button class="btn small" data-act="acc-add">${t('+ Роль')}</button></div>
      <h2>${t('Сеть приложения и логи бэкенда')}</h2>
      <div class="form-grid">
        ${field('appNet.tag', t('Тег сетевого лога в logcat'), t('строки REQUEST/RESPONSE/x-correlation-id; пусто = выключено'))}
        ${check('logs.enabled', t('Собирать логи бэкенда (VictoriaLogs через kubectl)'))}
        ${field('logs.kubeconfig', 'kubeconfig', t('пусто = KUBECONFIG или ~/.kube/config'))}
        ${field('logs.namespace', t('Namespace VictoriaLogs'))}
        ${field('logs.service', t('Service VictoriaLogs'))}
        ${field('logs.port', t('Порт сервиса'), t('9428 по умолчанию'))}
        ${field('logs.filter', t('Фильтр LogsQL'), t('какие поды и контейнеры брать'))}
      </div>
      <h2>${t('Библиотека блоков')}</h2>
      <label class="field">${t('YAML: имя блока → { params, steps }. Доступны всем сценариям через <span class="mono">use: имя</span>. Файл: data/blocks/library.yaml')}<textarea class="code tall" id="blocks" spellcheck="false" placeholder="open-order:&#10;  params: [number]&#10;  steps:&#10;    - tap: Orders&#10;    - tap: '№{{number}}'">${h(blocksText)}</textarea></label>
      <h2>${t('Правила прогона')}</h2>
      <div class="form-grid">
        ${field('allowStatus', t('Терпимые HTTP-статусы для правила noServerErrors'), t('через запятую, напр. 502,503'))}
        <label class="field">${t('Скриншоты старых прогонов')}<select data-s="runs.screenshots"><option value="all" ${(s.runs || {}).screenshots !== 'latest' ? 'selected' : ''}>${t('хранить все')}</option><option value="latest" ${(s.runs || {}).screenshots === 'latest' ? 'selected' : ''}>${t('удалять при новом запуске сценария')}</option></select><span class="hint">${t('во втором режиме новый запуск сценария стирает скриншоты его прежних прогонов; статусы, время и баллы остаются')}</span></label>
      </div>
      <h2>${t('Шаблоны')}</h2>
      <label class="field">${t('JSON-объект: имя → текст или объект. В шагах пиши {{имя}}; {{uuid}} и {{now}} внутри шаблона новые на каждый вызов.')}<textarea id="templates" class="code" spellcheck="false" style="min-height:110px">${h(Object.keys(s.templates || {}).length ? JSON.stringify(s.templates, null, 2) : '')}</textarea></label>
      <h2>${t('Движок экрана')}</h2>
      <div class="form-grid">
        <label class="field">${t('По умолчанию')}<select data-s="engine"><option value="adb" ${(s.engine || 'adb') === 'adb' ? 'selected' : ''}>${t('adb — свой драйвер (быстрее)')}</option><option value="maestro" ${s.engine === 'maestro' ? 'selected' : ''}>Maestro</option><option value="web" ${s.engine === 'web' ? 'selected' : ''}>${t('Браузер (Playwright)')}</option></select><span class="hint">${t('У сценария можно выбрать свой. Проверки бэкенда, продавец, стенд и логи работают одинаково при любом.')}</span></label>
        <label class="field">Maestro CLI<input type="text" data-s="maestro.path" value="${h((s.maestro || {}).path || '')}" placeholder="${t('сам найдёт ~/.maestro/maestro/bin/maestro.bat')}"></label>
        <label class="field">${t('Java 17+ для Maestro (JAVA_HOME)')}<input type="text" data-s="maestro.javaHome" value="${h((s.maestro || {}).javaHome || '')}" placeholder="${t('сам найдёт в ~/.gradle/jdks')}"></label>
      </div>
      <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap"><button class="btn small" data-act="maestro-check">${t('Проверить Maestro')}</button><span class="hint" id="maestro-state"></span></div>
      <h2>${t('Браузер')}</h2>
      <div class="hint">${t('Шаги в браузере (движок web, группа <span class="mono">browser:</span> или <span class="mono">on: web</span> у шага) выполняет Playwright в установленном Chrome или Edge. Вкладки списка сценариев делаются на главной кнопкой «+».')}</div>
      <div class="form-grid">
        ${field('webUrl', t('Адрес сайта для шагов в браузере'), t('шаг «Открыть» с относительным url (/shipment) откроет страницу этого сайта'))}
        ${field('web.browserPath', t('Путь к браузеру'), t('пусто — найдётся установленный Chrome или Edge'))}
        ${check('web.headless', t('Без окна (headless)'), t('сними, чтобы видеть окно браузера во время прогона'))}
        ${field('web.width', t('Ширина окна, px'), '1280')}
        ${field('web.height', t('Высота окна, px'), '800')}
        ${field('web.locale', t('Язык страницы (locale)'), t('например en-US или ru-RU; пусто — язык этого компьютера'))}
      </div>
      <h2>${t('Импорт и экспорт')}</h2>
      <div style="display:flex;gap:8px;flex-wrap:wrap"><a class="btn small" href="#/import">${t('Импорт ключей / сценариев')}</a><a class="btn small" href="/api/export" download>${t('Экспорт без ключей')}</a><a class="btn small" href="/api/export?secrets=1" download>${t('Экспорт с ключами')}</a></div>
      <h2>${t('Макеты')}</h2>
      <div class="form-grid">
        <label class="field">${t('Личный токен Figma')}<input type="password" data-s="figmaToken" value="${h(s.figmaToken ?? '')}" autocomplete="off"><span class="hint">${t('Figma → Settings → Security → Personal access tokens, право «File content: read». Нужен, чтобы показывать кадр макета рядом со скриншотом.')}</span></label>
      </div>
      <h2>${t('Переменные')}</h2>
      <label class="field">${t('Одна на строку: имя=значение. В шагах пиши {{имя}}.')}<textarea id="vars" style="min-height:120px;font-family:var(--mono)">${h(Object.entries(s.vars || {}).map(([k, v]) => k + '=' + v).join('\n'))}</textarea></label>
      <div><button class="btn primary" data-act="save-settings">${t('Сохранить')}</button></div>
    </section>`;
}

// ---------- router & events ----------
async function route() {
  clearInterval(timer);
  lastRunJson = '';
  delete $app.dataset.view;
  const [, page, id, sub] = location.hash.replace(/^#/, '').split('/');
  try {
    if (page === 'run' && id) {
      selStep = null;
      viewRun.follow = true;
      const r = await viewRun(id);
      if (sub === 'issues') await showIssue(true);
      poll(async () => {
        const x = await viewRun(id).catch(() => null);
        if (x && !LIVE.includes(x.status)) { clearInterval(timer); refreshDevice(); }
      }, 1000);
      if (!LIVE.includes(r.status)) clearInterval(timer);
    } else if (page === 'edit' && id) {
      await viewEditor(id);
    } else if (page === 'settings') {
      await viewSettings();
    } else if (page === 'connect') {
      await viewConnect();
    } else if (page === 'start') {
      await viewStart();
    } else if (page === 'perf') {
      await viewPerf();
    } else if (page === 'import') {
      await viewImport();
    } else {
      await viewList();
      poll(() => viewList({ poll: true }).catch(() => {}), 4000);
    }
  } catch (e) {
    $app.innerHTML = `<div class="note failed">${h(e.message)}</div>`;
  }
}

// «Run all tests»: one scenario after another. The page follows the series only while the user stays on the
// page it showed last (the list at the start, then each run); anywhere else the series goes on in the background.
let series = null; // { stop, runId, i, n, name }
function renderSeriesBar() {
  let bar = document.getElementById('series-bar');
  if (!series) { if (bar) bar.remove(); return; }
  if (!bar) { bar = document.createElement('div'); bar.id = 'series-bar'; bar.className = 'series-bar'; bar.setAttribute('role', 'status'); document.body.appendChild(bar); }
  bar.innerHTML = `<span>${h(t('Серия: {i} из {n} — {name}', { i: series.i, n: series.n, name: series.name }))}</span>`
    + (series.stop ? `<span class="hint">${t('останавливаю…')}</span>` : `<button class="btn small danger" data-act="series-stop">${t('Остановить серию')}</button>`);
}
async function runSeries(list) {
  series = { stop: false, runId: null, i: 0, n: list.length, name: '' };
  toast(t('Запускаю по очереди: {n}', { n: list.length }));
  const start = location.hash; // the page the series may move on from: this one, then the run it showed last
  let prev = null;
  const isOn = (runId) => location.hash === '#/run/' + runId || location.hash === '#/run/' + runId + '/issues';
  try {
    for (const s of list) {
      if (series.stop) break;
      series.i++; series.name = s.name; series.runId = null;
      renderSeriesBar();
      const r = await runScenario(s.id, { quiet: true }).catch((e) => { toast(s.name + ': ' + e.message); return null; });
      if (!r) continue;
      series.runId = r.id;
      if (prev ? isOn(prev) : location.hash === start) location.hash = '#/run/' + r.id;
      prev = r.id;
      let x = null;
      while (!series.stop) {
        await new Promise((res) => setTimeout(res, 1500));
        x = await api('GET', '/api/runs/' + encodeURIComponent(r.id)).catch(() => null);
        if (x && !LIVE.includes(x.status)) break;
      }
      if (x && !isOn(r.id)) toast(`${s.name}: ${STATUS[x.status] || x.status}`);
    }
    if (!series.stop && series.runId && isOn(series.runId)) location.hash = '#/';
  } finally {
    series = null;
    renderSeriesBar();
  }
}
async function runScenario(id, { measure = false, variant = '', quiet = false } = {}) {
  const pick = document.getElementById('dev-pick');
  const device = pick ? pick.value : 'any';
  const res = await fetch(`/api/scenarios/${encodeURIComponent(id)}/run?device=${encodeURIComponent(device)}${measure ? '&measure=1' : ''}${variant ? '&variant=' + encodeURIComponent(variant) : ''}`, { method: 'POST', headers: { 'content-type': 'application/json' } });
  const r = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (r.lint) toast(t('Не запущен: {e}', { e: r.lint.errors.slice(0, 2).map(tt).join('; ') }));
    throw new Error(tt(r.error) || 'HTTP ' + res.status);
  }
  if (r.runs && r.runs.length > 1) toast(t('Поставлено в очередь прогонов: {n}', { n: r.runs.length }));
  if (!quiet) location.hash = '#/run/' + r.id;
  return r;
}

// Screenshots and mockups open enlarged over the page; Ctrl/middle click still opens a new tab.
// A step screenshot opened this way pages through the run's other screenshots with ← / →.
let zoomStep = null;
function openZoom(src, alt, step = null) {
  closeZoom();
  zoomStep = step;
  const box = document.createElement('div');
  box.className = 'zoom-box';
  box.innerHTML = `<img src="${h(src)}" alt="${h(alt || '')}">${step !== null ? `<div class="zoom-cap"></div><button class="zoom-nav prev" aria-label="${t('Предыдущий скриншот')}">‹</button><button class="zoom-nav next" aria-label="${t('Следующий скриншот')}">›</button>` : ''}<button class="zoom-close" aria-label="${t('Закрыть')}">×</button>`;
  box.addEventListener('click', (ev) => {
    const nav = ev.target.closest('.zoom-nav');
    if (nav) return zoomMove(nav.classList.contains('next') ? 1 : -1);
    closeZoom();
  });
  document.body.appendChild(box);
  if (step !== null) zoomMove(0);
}
function zoomMove(dir) {
  const box = document.querySelector('.zoom-box');
  if (!box || zoomStep === null || !curRun) return;
  const steps = curRun.steps;
  let i = zoomStep + dir;
  while (dir && i >= 0 && i < steps.length && !steps[i].screenshot) i += dir;
  if (i < 0 || i >= steps.length || !steps[i].screenshot) return;
  zoomStep = i;
  const s = steps[i];
  box.querySelector('img').src = `/runs/${encodeURIComponent(curRun.id)}/${encodeURIComponent(s.screenshot)}?v=${encodeURIComponent(s.ms || '')}`;
  const shots = steps.map((x, k) => (x.screenshot ? k : -1)).filter((k) => k >= 0);
  box.querySelector('.zoom-cap').textContent = `${t('Шаг {n} из {m}', { n: s.n, m: steps.length })} · ${tt(s.title) || tt(s.label) || ''}`;
  box.querySelector('.prev').disabled = i === shots[0];
  box.querySelector('.next').disabled = i === shots[shots.length - 1];
  // keep the page on the same step, so closing the zoom lands where you were looking
  if (dir && selStep !== i) {
    selStep = i;
    viewRun.follow = false;
    lastRunJson = '';
    viewRun(curRun.id).catch(() => {});
  }
}
function closeZoom() { zoomStep = null; document.querySelectorAll('.zoom-box').forEach((b) => b.remove()); }
document.addEventListener('keydown', (ev) => {
  if (!document.querySelector('.zoom-box')) return;
  if (ev.key === 'Escape') closeZoom();
  else if (ev.key === 'ArrowRight' || ev.key === 'ArrowDown') { ev.preventDefault(); zoomMove(1); }
  else if (ev.key === 'ArrowLeft' || ev.key === 'ArrowUp') { ev.preventDefault(); zoomMove(-1); }
});

document.addEventListener('click', async (ev) => {
  const zoom = ev.target.closest('a.zoom');
  if (zoom && !ev.ctrlKey && !ev.metaKey && !ev.shiftKey && ev.button === 0) {
    ev.preventDefault();
    const im = zoom.querySelector('img');
    return openZoom(zoom.getAttribute('href'), im && im.alt, zoom.dataset.step !== undefined ? Number(zoom.dataset.step) : null);
  }
  const el = ev.target.closest('[data-act]');
  if (!el) return;
  const act = el.dataset.act;
  try {
    if (act === 'lang') setLang(LANG === 'ru' ? 'en' : 'ru');
    else if (act === 'run') await runScenario(el.dataset.id, { measure: el.dataset.measure === '1' });
    else if (act === 'measure') await runScenario(el.dataset.id, { measure: true, variant: el.dataset.variant || '' });
    else if (act === 'run-all-perf') {
      const ids = new Set((el.dataset.ids || '').split(',').filter(Boolean));
      const list = (await api('GET', '/api/scenarios')).filter((s) => (ids.size ? ids.has(s.id) : s.measure || (Array.isArray(s.tags) && s.tags.includes('perf'))));
      let n = 0;
      for (const s of list) { try { const r = await runScenario(s.id, { measure: true, quiet: true }); n += (r.runs || [r]).length; } catch (e) { toast(`${s.name}: ${e.message}`); } }
      toast(t('В очереди замеров: {n}', { n }));
      await viewList();
    }
    else if (act === 'list-tab') { listTab = el.dataset.tab; tabEdit = null; try { localStorage.setItem('e2e.listTab', listTab); } catch { /* private window */ } await viewList(); }
    else if (act === 'tab-edit') { tabEdit = el.dataset.tab || null; await viewList(); const inp = document.getElementById('tab-name'); if (inp) inp.focus(); }
    else if (act === 'tab-save') {
      // the user's tabs replace the built-in pair on the first change, so Tests / Load stay editable too
      const name = (document.getElementById('tab-name').value || '').trim();
      if (!name) throw new Error(t('Дай вкладке название'));
      const kind = document.getElementById('tab-kind').value === 'perf' ? 'perf' : 'tests';
      const sets = await api('GET', '/api/settings');
      const tabs = tabsOfSettings(sets).map(({ builtin, ...tb }) => tb);
      let id = el.dataset.tab;
      if (id === 'new') {
        const base = name.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '') || 'tab';
        id = base; for (let k = 2; tabs.some((tb) => tb.id === id); k++) id = base + '-' + k;
        tabs.push({ id, name, kind });
      } else { const tb = tabs.find((x) => x.id === id); if (tb) { tb.name = name; tb.kind = kind; } }
      await api('PUT', '/api/settings', { tabs });
      tabEdit = null; listTab = id; try { localStorage.setItem('e2e.listTab', id); } catch { /* private window */ }
      toast(t('Вкладка сохранена'));
      await viewList();
    }
    else if (act === 'run-del') {
      if (!confirm(t('Удалить этот прогон со скриншотами и логами? Вернуть его будет нельзя.'))) return;
      await api('DELETE', '/api/runs/' + encodeURIComponent(el.dataset.id));
      toast(t('Прогон удалён'));
      lastRunJson = '';
      if (location.hash === '#/' || location.hash === '') await viewList(); else location.hash = '#/';
    }
    else if (act === 'runs-prune') {
      const body = { what: el.dataset.what || 'runs' };
      if (el.dataset.keep) body.keep = Number(el.dataset.keep);
      if (el.dataset.days) body.olderThanDays = Number(el.dataset.days);
      const menu = el.closest('details'); if (menu) menu.open = false;
      const plan = await api('POST', '/api/runs/prune', { ...body, dryRun: true });
      if (!plan.runs && !plan.screenshots) { toast(t('Удалять нечего')); return; }
      const mb = (plan.bytes / 1048576).toFixed(plan.bytes > 10485760 ? 0 : 1).replace('.', LANG === 'ru' ? ',' : '.');
      const parts = [plan.runs ? t('прогонов целиком: {n}', { n: plan.runs }) : '', plan.screenshots ? t('прогонов, у которых уйдут только скриншоты: {n}', { n: plan.screenshots }) : ''].filter(Boolean).join('; ');
      if (!confirm(t('Будет удалено — {p}. Освободится {mb} МБ. Замеры не удаляются целиком: у них уходят только скриншоты, баллы остаются. Вернуть удалённое будет нельзя. Продолжить?', { p: parts, mb }))) return;
      const done = await api('POST', '/api/runs/prune', body);
      toast(t('Удалено: прогонов {a}, скриншоты у {b}', { a: done.runs, b: done.screenshots }));
      listSig = '';
      await viewList();
    }
    else if (act === 'tab-del') {
      const sets = await api('GET', '/api/settings');
      const tabs = tabsOfSettings(sets).map(({ builtin, ...tb }) => tb);
      const tb = tabs.find((x) => x.id === el.dataset.tab);
      if (!tb || !confirm(t('Удалить вкладку «{n}»? Сценарии останутся и вернутся на вкладку по своему типу.', { n: tb.name }))) return;
      await api('PUT', '/api/settings', { tabs: tabs.filter((x) => x.id !== tb.id) });
      tabEdit = null; listTab = '';
      await viewList();
    }
    else if (act === 'perf-dev') { perfView.device = el.dataset.key; perfView.build = null; await viewPerf(); }
    else if (act === 'perf-build-row') { perfView.build = el.dataset.key; await viewPerf(); }
    else if (act === 'run-all') {
      if (series) { toast(t('Серия уже идёт')); return; }
      if (dirty && draft && !confirm(LEAVE_Q())) return;
      const ids = new Set((el.dataset.ids || '').split(',').filter(Boolean));
      const list = (await api('GET', '/api/scenarios')).filter((s) => !ids.size || ids.has(s.id));
      await runSeries(list);
    }
    else if (act === 'series-stop') {
      if (!series) return;
      series.stop = true;
      if (series.runId) await api('POST', `/api/runs/${encodeURIComponent(series.runId)}/stop`).catch(() => {});
      toast(t('Серия остановлена'));
      renderSeriesBar();
    }
    else if (act === 'stop') { await api('POST', `/api/runs/${encodeURIComponent(el.dataset.id)}/stop`); toast(t('Останавливаю')); }
    else if (act === 'resume') {
      const note = (document.getElementById('resume-note') || {}).value || '';
      await api('POST', `/api/runs/${encodeURIComponent(el.dataset.id)}/resume`, { ok: el.dataset.ok === '1', note });
    }
    else if (act === 'sel') {
      selStep = Number(el.dataset.i);
      viewRun.follow = false;
      lastRunJson = '';
      const id = location.hash.split('/')[2];
      await viewRun(id);
    }
    else if (act === 'design' || act === 'figma-save') {
      const body = act === 'design'
        ? { verdict: el.dataset.v || null, note: el.dataset.v === '' ? '' : (document.getElementById('design-note') || {}).value || '' }
        : { figma: (document.getElementById('figma-url') || {}).value || '' };
      await api('POST', `/api/runs/${encodeURIComponent(curRun.id)}/steps/${selStep + 1}/design`, body);
      lastRunJson = ''; viewRun.fresh = true; await viewRun(curRun.id);
    }
    else if (act === 'baseline') { await api('POST', `/api/runs/${encodeURIComponent(curRun.id)}/steps/${el.dataset.n}/baseline`); toast(t('Эталон обновлён')); }
    else if (act === 'next-issue') { await showIssue(); }
    else if (act === 'logs-corr') {
      logView.scope = 'all'; logView.level = 'all'; logView.service = ''; logView.q = el.dataset.corr;
      lastRunJson = ''; await viewRun(curRun.id);
      const card = document.getElementById('logs-card'); if (card) card.scrollIntoView({ behavior: 'smooth' });
    }
    else if (act === 'figma-refresh') { await loadFigma(curRun.steps[selStep].figma, true); }
    else if (act === 'log-scope') { logView.scope = el.dataset.v; lastRunJson = ''; await viewRun(curRun.id); }
    else if (act === 'log-open') {
      const i = Number(el.dataset.i);
      if (logView.open.has(i)) logView.open.delete(i); else logView.open.add(i);
      renderLogList();
    }
    else if (act === 'logs-refresh') {
      el.disabled = true; toast(t('Перечитываю логи за время прогона…'));
      const s = await api('POST', `/api/runs/${encodeURIComponent(el.dataset.id)}/logs`);
      toast(t('Логи: {n} строк, ошибок {e}', { n: s.total, e: s.errors }));
      logView.total = -1; lastRunJson = ''; await viewRun(el.dataset.id);
    }
    else if (act === 'emulator') { await api('POST', '/api/device/emulator'); toast(t('Эмулятор запускается, это около минуты')); setTimeout(refreshDevice, 20000); setTimeout(refreshDevice, 60000); }
    else if (act === 'install') { el.disabled = true; toast(t('Ставлю APK…')); try { await api('POST', '/api/device/install?device=' + encodeURIComponent(pickedDevice)); toast(t('APK установлен')); } finally { el.disabled = false; } }
    else if (act === 'pair-install') { el.disabled = true; toast(t('Ставлю APK на телефон, по Wi-Fi это минута…')); try { await api('POST', '/api/device/install?device=' + encodeURIComponent(el.dataset.serial)); toast(t('APK установлен')); } finally { el.disabled = false; } }
    else if (act === 'pair-disconnect') { await api('POST', '/api/device/disconnect', { serial: el.dataset.serial }); toast(t('Отключил')); await refreshDevice(); await viewConnect(); }
    else if (act === 'start-foreground' || act === 'settings-foreground') {
      el.disabled = true;
      try {
        const r = await api('GET', '/api/device/foreground');
        const pk = document.getElementById('start-package') || document.querySelector('[data-s="package"]');
        const ac = document.getElementById('start-activity') || document.querySelector('[data-s="activity"]');
        if (pk) pk.value = r.package;
        if (ac) ac.value = r.activity;
        toast(t('На экране {s}: {p}', { s: r.serial, p: r.package }));
      } finally { el.disabled = false; }
    }
    else if (act === 'start-save-app') {
      const v = (id) => (document.getElementById(id) || {}).value || '';
      await api('PUT', '/api/settings', { package: v('start-package').trim(), activity: v('start-activity').trim(), apkPath: v('start-apk').trim(), appName: v('start-appname').trim() });
      toast(t('Сохранено'));
      await refreshDevice();
      await viewStart();
    }
    else if (act === 'start-emulator') {
      const avd = (document.getElementById('start-avd') || {}).value;
      if (avd) await api('PUT', '/api/settings', { avd });
      await api('POST', '/api/device/emulator');
      toast(t('Эмулятор запускается, это около минуты'));
      setTimeout(() => { refreshDevice(); if (location.hash === '#/start' || location.hash === '#/') viewStart(); }, 45000);
    }
    else if (act === 'start-install') { el.disabled = true; toast(t('Ставлю APK…')); try { await api('POST', '/api/device/install'); toast(t('APK установлен')); await viewStart(); } finally { el.disabled = false; } }
    else if (act === 'pair-hygiene') {
      el.disabled = true; toast(t('Готовлю эмулятор…'));
      try {
        const r = await api('POST', '/api/device/hygiene', { serial: el.dataset.serial });
        const log = document.getElementById('pair-log'), st = document.getElementById('pair-state');
        if (log) { log.style.display = ''; log.textContent = [...r.log, `load average: ${r.load}`, ...r.top.map((x) => `${String(x.cpu).padStart(6)} %  ${x.name}`)].join('\n'); }
        if (st) st.textContent = t('{r} · load average {l} — для замера хорошо, когда первое число ниже ~4', { r: r.rooted ? t('root есть') : t('без root'), l: r.load });
        toast(t('Эмулятор подготовлен'));
      } finally { el.disabled = false; }
    }
    else if (act === 'pair-wifi') {
      el.disabled = true; toast(t('Перевожу на Wi-Fi…'));
      try { const r = await api('POST', '/api/device/wifi', { serial: el.dataset.serial }); toast(t('По Wi-Fi: {n} ({a}) — кабель можно отключить', { n: r.name, a: r.connected })); await refreshDevice(); await viewConnect(); } finally { el.disabled = false; }
    }
    else if (act === 'calibrate') {
      el.disabled = true;
      try {
        let c;
        try { c = await api('POST', '/api/perf/calibrate', { phoneRun: el.dataset.id }); } catch (e) {
          if (!/не в таблице|not in the table/.test(e.message)) throw e;
          const score = prompt(e.message + '\n\n' + t('Балл чипа по шкале (Geekbench 6 single-core, например 1050 для Snapdragon 778G):'));
          if (!score) throw e;
          c = await api('POST', '/api/perf/calibrate', { phoneRun: el.dataset.id, score: Number(score) });
        }
        toast(t('Калибровка сохранена: K = {k}, эталон {n} ({c} {s})', { k: c.k.app, n: c.reference.name, c: c.reference.chip || '', s: c.reference.score })
          + (c.check && !c.check.ok ? ' — ' + t('но прогнозов по ней не будет: {r}', { r: c.check.reasons.join(', ') }) : ''));
        lastRunJson = '';
        await viewRun(curRun.id);
      } finally { el.disabled = false; }
    }
    else if (act === 'pair-go') {
      const v = (id) => (document.getElementById(id) || {}).value || '';
      const st = document.getElementById('pair-state'), log = document.getElementById('pair-log');
      st.textContent = t('Подключаю…');
      el.disabled = true;
      try {
        const r = await api('POST', '/api/device/pair', { pair: v('pair-addr'), code: v('pair-code'), connect: v('pair-connect') });
        log.style.display = ''; log.textContent = (r.log || []).join('\n\n');
        if (r.needConnect) {
          st.textContent = t('Сопряжение прошло, но адрес подключения не нашёлся сам. Закрой окно с кодом: на главном экране «Беспроводная отладка» под именем телефона написан IP:порт — впиши его в третье поле и нажми ещё раз.');
          document.getElementById('pair-connect').focus();
        } else {
          st.textContent = t('Подключено: {n} ({a})', { n: r.name, a: r.connected });
          toast(t('Телефон подключён'));
          await refreshDevice();
          const connected = r.connected;
          await viewConnect();
          document.getElementById('pair-state').textContent = t('Подключено: {n} ({a}). Теперь «Поставить APK» справа, потом ⏱ у сценария.', { n: r.name, a: connected });
        }
      } catch (e) {
        st.textContent = e.message;
        throw e;
      } finally { el.disabled = false; }
    }
    else if (act === 'add') { draft.steps.push({ type: el.dataset.type }); dirty = true; renderEditor(); }
    else if (act === 'del') { draft.steps.splice(Number(el.dataset.i), 1); dirty = true; renderEditor(); }
    else if (act === 'up' || act === 'down') {
      const i = Number(el.dataset.i), j = act === 'up' ? i - 1 : i + 1;
      if (j >= 0 && j < draft.steps.length) { [draft.steps[i], draft.steps[j]] = [draft.steps[j], draft.steps[i]]; dirty = true; renderEditor(); }
    }
    else if (act === 'save') {
      await saveDraft();
      toast(t('Сохранено'));
      // same page: re-render so the header shows what was saved (in YAML mode it comes from the text)
      if (location.hash === '#/edit/' + draft.id) renderEditor(); else location.hash = '#/edit/' + draft.id;
    }
    else if (act === 'save-run') { const s = await saveDraft(); await runScenario(s.id); }
    else if (act === 'delete') {
      if (confirm(t('Удалить сценарий «{n}»? Прогоны останутся.', { n: draft.name }))) { await api('DELETE', '/api/scenarios/' + encodeURIComponent(draft.id)); dirty = false; location.hash = '#/'; }
    }
    else if (act === 'edit-mode') {
      if (el.dataset.v === editMode) return;
      await saveDraft();
      editMode = el.dataset.v;
      if (editMode === 'yaml') await loadYamlText();
      else draft = await api('GET', '/api/scenarios/' + encodeURIComponent(draft.id));
      if (location.hash !== '#/edit/' + draft.id) history.replaceState(null, '', '#/edit/' + draft.id);
      curHash = location.hash;
      renderEditor();
    }
    else if (act === 'imp-clear') { importFiles = []; document.getElementById('imp-text').value = ''; document.getElementById('imp-result').innerHTML = ''; renderImportChosen(); }
    else if (act === 'imp-check') {
      const files = readImportInputs();
      if (!files.length) { toast(t('Выбери файлы или вставь текст')); return; }
      renderImportPreview(await api('POST', '/api/import', { files, mode: document.getElementById('imp-mode').value }));
    }
    else if (act === 'imp-apply') {
      const files = readImportInputs();
      const only = [...document.querySelectorAll('[data-imp]')].filter((x) => x.checked).map((x) => Number(x.dataset.imp));
      const set = document.getElementById('imp-settings');
      // per block: a new one ticked or not, a different one kept or replaced
      const blocks = Object.fromEntries([...document.querySelectorAll('[data-imp-block]')].map((x) => [x.dataset.impBlock, x.type === 'checkbox' ? (x.checked ? 'add' : 'skip') : x.value]));
      const r = await api('POST', '/api/import', { files, mode: document.getElementById('imp-mode').value, apply: true, only, blocks,
        onConflict: (document.getElementById('imp-conflict') || {}).value || 'copy', settings: set ? set.checked : false });
      toast(t('Импортировано сценариев: {n}', { n: r.saved.length }) + (r.settingsChanged.length ? t(', настройки: {s}', { s: r.settingsChanged.join(', ') }) : '')
        + ((r.blocksSaved || []).length ? t(', блоки: {b}', { b: r.blocksSaved.join(', ') }) : '') + ((r.blocksKept || []).length ? t(', оставлены ваши блоки: {b}', { b: r.blocksKept.join(', ') }) : ''));
      importFiles = [];
      location.hash = r.saved.length === 1 ? '#/edit/' + r.saved[0].id : '#/';
      refreshDevice();
    }
    else if (act === 'acc-add') { document.querySelector('#accounts tbody').insertAdjacentHTML('beforeend', accountRow('', {})); }
    else if (act === 'acc-del') { el.closest('tr').remove(); }
    else if (act === 'maestro-check') {
      const st = document.getElementById('maestro-state');
      st.textContent = t('Запускаю maestro --version (до минуты)…');
      const r = await api('GET', '/api/maestro?check=1');
      st.textContent = r.version ? `Maestro ${r.version} · ${r.bin} · Java: ${r.javaHome}` : t('Не работает: {e}', { e: tt(r.error) || t('нет ответа') });
    }
    else if (act === 'save-settings') {
      const body = {};
      document.querySelectorAll('[data-s]').forEach((i) => {
        const [k, sub] = i.dataset.s.split('.');
        const value = i.type === 'checkbox' ? i.checked : i.value.trim();
        if (sub) { body[k] = body[k] || {}; body[k][sub] = value; } else body[k] = value;
      });
      if (typeof body.allowStatus === 'string') body.allowStatus = body.allowStatus.split(',').map((x) => Number(x.trim())).filter((x) => x);
      const accounts = {};
      document.querySelectorAll('[data-acc]').forEach((tr) => {
        const g = (f) => (tr.querySelector(`[data-acc-f="${f}"]`) || {}).value || '';
        const role = g('role').trim();
        // a renamed row names its old role, so the server carries what the table does not show (refreshToken)
        const was = tr.dataset.accWas || '';
        if (role) accounts[role] = { phone: g('phone').trim(), otp: g('otp').trim(), token: g('token').trim(), ...(was && was !== role ? { renamedFrom: was } : {}) };
      });
      body.accounts = accounts;
      body.emulatorHygiene = document.getElementById('hygiene').value.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
      const devTxt = document.getElementById('devices').value.trim();
      try { body.devices = devTxt ? JSON.parse(devTxt) : []; } catch (e) { throw new Error(t('Устройства: это не JSON — {e}', { e: e.message })); }
      const blocksText = document.getElementById('blocks').value;
      await api('PUT', '/api/blocks', { text: blocksText });
      const tpl = document.getElementById('templates').value.trim();
      try { body.templates = tpl ? JSON.parse(tpl) : {}; } catch (e) { throw new Error(t('Шаблоны: это не JSON — {e}', { e: e.message })); }
      if (!body.templates || typeof body.templates !== 'object' || Array.isArray(body.templates)) throw new Error(t('Шаблоны: нужен JSON-объект { "имя": … }'));
      body.vars = Object.fromEntries(document.getElementById('vars').value.split(/\r?\n/).map((l) => { const k = l.indexOf('='); return k > 0 ? [l.slice(0, k).trim(), l.slice(k + 1).trim()] : null; }).filter(Boolean));
      await api('PUT', '/api/settings', body);
      toast(t('Настройки сохранены'));
      refreshDevice();
    }
  } catch (e) {
    toast(e.message);
    if (el.disabled) el.disabled = false;
  }
});

document.addEventListener('input', (ev) => {
  const el = ev.target;
  if (el.id === 'log-q') { logView.q = el.value; renderLogList(); return; }
  if (draft && el.id === 'sc-yaml') { dirty = true; return; }
  if (draft && readHeaderField(el)) return;
  if (draft && el.dataset.f !== undefined && el.dataset.i !== undefined) readDraftField(el);
});
document.addEventListener('change', (ev) => {
  const el = ev.target;
  if (el.id === 'log-level') { logView.level = el.value; renderLogList(); return; }
  if (el.id === 'log-service') { logView.service = el.value; renderLogList(); return; }
  if (el.dataset.act === 'perf-build') { perfView.build = el.value; viewPerf(); return; }
  if (el.dataset.act === 'perf-compare') { perfView.compare = el.value; viewPerf(); return; }
  if (el.dataset.act === 'row-tab') {
    api('PUT', '/api/scenarios/' + encodeURIComponent(el.dataset.id), { tab: el.value }).then(() => { toast(t('Сценарий перенесён')); return viewList(); }).catch((e) => toast(e.message));
    return;
  }
  if (!draft) return;
  if (readHeaderField(el)) return;
  if (el.dataset.type !== undefined && el.tagName === 'SELECT') {
    const i = Number(el.dataset.type);
    draft.steps[i] = retypeStep(draft.steps[i], el.value);
    dirty = true;
    renderEditor();
  } else if (el.dataset.f !== undefined) readDraftField(el);
});

// the page the router last showed; a refused «leave the editor» puts the address back without re-routing
let curHash = location.hash;
window.addEventListener('hashchange', () => {
  if (dirty && draft && location.hash !== curHash) {
    if (!confirm(LEAVE_Q())) { history.replaceState(null, '', curHash || '#/'); return; }
    dirty = false;
  }
  curHash = location.hash;
  if (!location.hash.startsWith('#/edit')) draft = null;
  route();
});
window.addEventListener('beforeunload', (ev) => { if (dirty && draft) { ev.preventDefault(); ev.returnValue = ''; } });
refreshDevice();
setInterval(refreshDevice, 15000);
route();

// ---------- import: picking files ----------
async function addImportFiles(list) {
  for (const f of list) importFiles.push({ name: f.name, content: await f.text() });
  renderImportChosen();
}
document.addEventListener('change', (ev) => { if (ev.target.id === 'imp-files') addImportFiles(ev.target.files); });
document.addEventListener('dragover', (ev) => { const d = ev.target.closest && ev.target.closest('#drop'); if (d) { ev.preventDefault(); d.classList.add('over'); } });
document.addEventListener('dragleave', (ev) => { const d = ev.target.closest && ev.target.closest('#drop'); if (d) d.classList.remove('over'); });
document.addEventListener('drop', (ev) => {
  const d = ev.target.closest && ev.target.closest('#drop');
  if (!d) return;
  ev.preventDefault(); d.classList.remove('over');
  addImportFiles(ev.dataTransfer.files);
});
