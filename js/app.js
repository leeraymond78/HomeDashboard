import { loadWeatherSection, startWeatherRefresh } from './weather.js';
import { distanceM, formatDistance, bootstrapLocation, geolocationBlockReason, getGeolocationPermission, getLastGeoError, getUserPosition, requestUserPosition } from './location.js';
import { escapeHtml, escapeAttr } from './utils.js';
import { initPullToRefresh } from './pull-to-refresh.js';
import {
  SOCIF_GEO,
  clearMtrCache,
  fetchEtas,
  getMtrStopGeo,
  routeStopId,
  serializeRouteStop,
} from './transit-api.js';

const REFRESH_INTERVAL_MS = 15_000;
const LOCATION_THRESHOLD_M = 700;

const maxEtasPerGroup = (() => {
  const raw = document.documentElement.dataset.maxEtas;
  if (!raw) return Infinity;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : Infinity;
})();

/** @type {{ groups: Group[] }} */
let config;
/** @type {Date} */
let lastRefresh = new Date();
/** @type {number | null} */
let refreshTimerId = null;
/** @type {Map<string, { lat: number, lng: number }>} */
const stopGeo = new Map();

/** @typedef {{ title: string, open: boolean, routeStops: RouteStop[] }} Group */
/** @typedef {{ type: string, [key: string]: unknown }} RouteStop */
/** @typedef {import('./transit-api.js').EtaRow} EtaRow */

/** @type {Map<number, EtaRow[]>} */
const groupEtas = new Map();
/** @type {Map<number, string>} */
const groupState = new Map();
/** @type {Set<number>} */
const groupShowAllEtas = new Set();

async function loadConfig() {
  const res = await fetch('config.json');
  if (!res.ok) throw new Error('設定ファイルを読み込めません');
  config = await res.json();
}

async function loadStopGeo() {
  const firstStops = config.groups.map((g) => g.routeStops[0]).filter(Boolean);
  await Promise.all(firstStops.map(loadRouteStopGeo));
}

async function loadRouteStopGeo(rs) {
  try {
    if (rs.type === 'kmb') {
      const res = await fetch(`https://data.etabus.gov.hk/v1/transport/kmb/stop/${rs.stop}`);
      const json = await res.json();
      const d = json.data;
      stopGeo.set(rs.stop, { lat: parseFloat(d.lat), lng: parseFloat(d.long) });
    } else if (rs.type === 'mtr') {
      const geo = await getMtrStopGeo(rs.stopId);
      if (geo) stopGeo.set(rs.stopId, geo);
    } else if (rs.type === 'nwfb') {
      const res = await fetch(`https://rt.data.gov.hk/v1.1/transport/citybus-nwfb/stop/${rs.stop}`);
      const json = await res.json();
      const d = json.data;
      stopGeo.set(rs.stop, { lat: parseFloat(d.lat), lng: parseFloat(d.long) });
    } else if (rs.type === 'gmb') {
      const res = await fetch(`https://data.etagmb.gov.hk/stop/${rs.stopId}`);
      const json = await res.json();
      const d = json.data.coordinates.wgs84;
      stopGeo.set(rs.stopId, { lat: parseFloat(d.latitude), lng: parseFloat(d.longitude) });
    } else if (rs.type === 'socif') {
      const key = `${rs.route}-${rs.routeSeq}-${rs.stopSeq}`;
      if (SOCIF_GEO[key]) stopGeo.set(key, SOCIF_GEO[key]);
    }
  } catch {
    /* ignore */
  }
}

function groupGeo(group) {
  const rs = group.routeStops[0];
  if (!rs) return null;
  return stopGeo.get(routeStopId(rs)) ?? null;
}

function distanceToGroup(group) {
  const userPosition = getUserPosition();
  if (!userPosition || !group.routeStops.length) return null;
  const geo = groupGeo(group);
  if (!geo) return null;
  return distanceM(
    { lat: userPosition.coords.latitude, lng: userPosition.coords.longitude },
    geo,
  );
}

function autoExpandNearby() {
  for (const group of config.groups) {
    const dist = distanceToGroup(group);
    if (dist != null && dist < LOCATION_THRESHOLD_M) group.open = true;
  }
}

function sortGroupsByDistance() {
  config.groups = config.groups
    .map((group, i) => ({ group, i, dist: distanceToGroup(group) }))
    .sort((a, b) => {
      const aNear = a.dist != null && a.dist < LOCATION_THRESHOLD_M;
      const bNear = b.dist != null && b.dist < LOCATION_THRESHOLD_M;
      if (aNear !== bNear) return aNear ? -1 : 1;
      if (a.dist != null && b.dist != null && a.dist !== b.dist) return a.dist - b.dist;
      return a.i - b.i;
    })
    .map(({ group }) => group);
}

function applyLocationSort() {
  sortGroupsByDistance();
  autoExpandNearby();
}

function updateLocation({ resort = false } = {}) {
  return requestUserPosition().then((pos) => {
    if (pos) hideLocationPrompt();
    if (!pos) return;
    if (resort) {
      groupEtas.clear();
      groupState.clear();
      groupShowAllEtas.clear();
      applyLocationSort();
      renderGroups();
    }
    updateAllGroups();
    refreshOpenGroups();
  });
}

function hideLocationPrompt() {
  document.getElementById('location-prompt')?.setAttribute('hidden', '');
}

async function showLocationPrompt(status) {
  const prompt = document.getElementById('location-prompt');
  const btn = document.getElementById('location-prompt-btn');
  if (!prompt || !btn) return;

  if (status === 'granted' || getUserPosition()) {
    hideLocationPrompt();
    return;
  }

  prompt.hidden = false;
  if (status === 'denied') {
    btn.textContent = '設定で位置情報を許可してください';
    return;
  }
  if (status === 'unavailable') {
    btn.disabled = false;
    btn.textContent = '位置情報を取得できませんでした。もう一度お試しください';
    return;
  }
  if (status === 'unsupported') {
    btn.textContent = 'この端末では位置情報を利用できません';
    btn.disabled = true;
    return;
  }
  if (status === 'insecure') {
    btn.textContent = 'HTTPS接続が必要です（http://192.168… では位置情報を利用できません）';
    btn.disabled = true;
    return;
  }
  btn.disabled = false;
  btn.textContent = '近くの停留所を表示（位置情報を許可）';
}

function applyLocationFromPosition(pos) {
  if (!pos) return false;
  hideLocationPrompt();
  applyLocationSort();
  renderGroups();
  updateAllGroups();
  refreshOpenGroups();
  return true;
}

function setupLocationPrompt() {
  window.addEventListener('userposition', () => {
    applyLocationFromPosition(getUserPosition());
  });

  document.getElementById('location-prompt-btn')?.addEventListener('click', () => {
    const block = geolocationBlockReason();
    if (block) {
      showLocationPrompt(block);
      return;
    }
    // Call getCurrentPosition synchronously from the tap handler (required on iOS).
    requestUserPosition().then((pos) => {
      if (applyLocationFromPosition(pos)) return;
      const err = getLastGeoError();
      if (err?.code === 1) showLocationPrompt('denied');
      else showLocationPrompt('unavailable');
    });
  });
}

async function fetchGroupEtas(group) {
  const tasks = group.routeStops.map(async (rs) => {
    try {
      return fetchEtas(rs);
    } catch {
      return [];
    }
  });
  const results = await Promise.all(tasks);
  return results.flat().sort((a, b) => a.etaTime - b.etaTime);
}

function scrollSpan(text, className) {
  const safe = escapeHtml(text);
  if (!text) return '';
  return `<span class="${className}" data-text="${escapeAttr(text)}">${safe}</span>`;
}

function navigateToBusDetail(routeStop) {
  const back = encodeURIComponent(window.location.pathname.split('/').pop() || 'index.html');
  window.location.href = `bus.html?${serializeRouteStop(routeStop)}&back=${back}`;
}

function createEtaRowElement(row) {
  const tr = document.createElement('tr');
  tr.className = 'eta-row eta-row-clickable';
  tr.innerHTML = `
    <td class="route-id ${row.routeClass}"></td>
    <td class="express-cell"><span class="express-badge"></span></td>
    <td class="eta-time ${row.etaClass}"></td>
    <td class="dest-cell"></td>
    <td class="eta-mins ${row.etaClass}"></td>
    <td class="remark-cell"></td>`;
  patchEtaRow(tr, row);
  if (row.routeStop) {
    tr.dataset.hasNav = '1';
    tr.addEventListener('click', () => navigateToBusDetail(row.routeStop));
  }
  return tr;
}

function setCellClass(td, className) {
  if (td.className !== className) td.className = className;
}

function setCellText(td, text) {
  const next = String(text ?? '');
  if (td.textContent !== next) td.textContent = next;
}

function setScrollText(td, text, className) {
  const next = String(text ?? '');
  let span = td.querySelector(`.${className}`);
  if (!next) {
    if (td.childElementCount) td.replaceChildren();
    return;
  }
  if (!span) {
    td.innerHTML = scrollSpan(next, className);
    return;
  }
  if (span.textContent !== next) {
    span.textContent = next;
    span.classList.remove('scroll');
    span.style.removeProperty('--scroll-offset');
  }
}

function expressBadge(expressTd) {
  let badge = expressTd.querySelector('.express-badge');
  if (!badge) {
    badge = document.createElement('span');
    badge.className = 'express-badge';
    expressTd.replaceChildren(badge);
  }
  return badge;
}

function patchEtaRow(tr, row) {
  const [routeTd, expressTd, timeTd, destTd, minsTd, remarkTd] = tr.children;

  setCellClass(routeTd, `route-id ${row.routeClass}`);
  setCellText(routeTd, row.routeId);

  setCellClass(expressTd, 'express-cell');
  const badge = expressBadge(expressTd);
  setCellClass(badge, `express-badge ${row.express.cls}`);
  setCellText(badge, row.express.text);

  setCellClass(timeTd, `eta-time ${row.etaClass}`);
  setCellText(timeTd, row.time);

  setScrollText(destTd, row.dest, 'dest-scroll');

  setCellClass(minsTd, `eta-mins ${row.etaClass}`);
  setCellText(minsTd, row.mins);

  setScrollText(remarkTd, row.remark, 'remark-scroll');
}

const ETA_TABLE_COLGROUP = `
  <colgroup>
    <col class="col-route">
    <col class="col-express">
    <col class="col-time">
    <col class="col-dest">
    <col class="col-mins">
    <col class="col-remark">
  </colgroup>`;

function ensureEtaTable(body) {
  let table = body.querySelector('.eta-table');
  if (table) return table.querySelector('tbody');

  body.replaceChildren();
  table = document.createElement('table');
  table.className = 'eta-table';
  table.innerHTML = `${ETA_TABLE_COLGROUP}<tbody></tbody>`;
  body.appendChild(table);
  return table.querySelector('tbody');
}

function showGroupMessage(body, className, text) {
  let msg = body.querySelector(`.${className}`);
  if (msg) {
    if (msg.textContent !== text) msg.textContent = text;
    return;
  }
  body.replaceChildren();
  msg = document.createElement('div');
  msg.className = className;
  msg.textContent = text;
  body.appendChild(msg);
}

function etasLimitForGroup(index) {
  if (!Number.isFinite(maxEtasPerGroup)) return Infinity;
  if (groupShowAllEtas.has(index)) return Infinity;
  return maxEtasPerGroup;
}

function syncShowMoreButton(body, index, etas) {
  const hiddenCount = etas.length - maxEtasPerGroup;
  const visible = Number.isFinite(maxEtasPerGroup)
    && hiddenCount > 0
    && !groupShowAllEtas.has(index);

  let btn = body.querySelector('.show-more-btn');
  if (!visible) {
    btn?.remove();
    return;
  }

  const label = `もっと見る（あと${hiddenCount}本）`;
  if (!btn) {
    btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'show-more-btn';
    btn.addEventListener('click', () => {
      groupShowAllEtas.add(index);
      syncGroupBody(index);
    });
    body.appendChild(btn);
  }
  if (btn.textContent !== label) btn.textContent = label;
}

function syncGroupBody(index) {
  const section = document.querySelector(`.group[data-index="${index}"]`);
  if (!section) return;

  const body = section.querySelector('.group-body');
  const etas = groupEtas.get(index) ?? [];
  const state = groupState.get(index) ?? 'loading';
  const displayEtas = etas.slice(0, etasLimitForGroup(index));

  if (!displayEtas.length) {
    if (state === 'loading') {
      showGroupMessage(body, 'loading', '読み込み中…');
      return;
    }
    if (state === 'error') {
      showGroupMessage(body, 'error-msg', 'データを取得できませんでした');
      return;
    }
    showGroupMessage(body, 'empty', '到着予定のバスはありません');
    return;
  }

  const tbody = ensureEtaTable(body);
  const existing = [...tbody.querySelectorAll('.eta-row')];

  displayEtas.forEach((eta, i) => {
    if (existing[i]) {
      patchEtaRow(existing[i], eta);
      if (eta.routeStop && !existing[i].dataset.hasNav) {
        existing[i].classList.add('eta-row-clickable');
        existing[i].dataset.hasNav = '1';
        existing[i].addEventListener('click', () => navigateToBusDetail(eta.routeStop));
      }
    } else {
      tbody.appendChild(createEtaRowElement(eta));
    }
  });
  existing.slice(displayEtas.length).forEach((tr) => tr.remove());

  syncShowMoreButton(body, index, etas);
  setupScrollSpans(body);
}

function buildGroupsShell() {
  const container = document.getElementById('groups');
  container.innerHTML = config.groups
    .map((group, i) => `
      <section class="group" data-index="${i}">
        <button class="group-header" type="button" aria-expanded="false">
          <span class="group-title">${escapeHtml(group.title)}</span>
          <span class="group-trailing">
            <span class="group-distance" hidden></span>
            <svg class="chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
              <polyline points="6 9 12 15 18 9"/>
            </svg>
          </span>
        </button>
        <div class="group-body"></div>
      </section>`)
    .join('');
}

function bindGroupClicks() {
  const container = document.getElementById('groups');
  if (!container || container.dataset.bound) return;
  container.dataset.bound = '1';
  container.addEventListener('click', (e) => {
    const btn = e.target.closest('.group-header');
    if (!btn) return;
    const index = parseInt(btn.closest('.group').dataset.index, 10);
    const group = config.groups[index];
    group.open = !group.open;
    if (group.open) {
      if (groupEtas.has(index)) {
        updateGroup(index);
        refreshGroup(index, { silent: true });
      } else {
        refreshGroup(index, { silent: false });
      }
    } else {
      updateGroup(index);
    }
  });
}

function updateGroup(index) {
  const group = config.groups[index];
  const section = document.querySelector(`.group[data-index="${index}"]`);
  if (!section) return;

  section.classList.toggle('open', group.open);
  section.querySelector('.group-header').setAttribute('aria-expanded', String(group.open));

  const distEl = section.querySelector('.group-distance');
  const dist = distanceToGroup(group);
  if (dist != null) {
    distEl.textContent = formatDistance(dist);
    distEl.hidden = false;
  } else {
    distEl.hidden = true;
  }

  const body = section.querySelector('.group-body');
  if (!group.open) {
    body.replaceChildren();
    return;
  }

  syncGroupBody(index);
}

function updateAllGroups() {
  config.groups.forEach((_, i) => updateGroup(i));
}

function renderGroups() {
  buildGroupsShell();
  bindGroupClicks();
  updateAllGroups();
}

function setupScrollSpans(root) {
  root.querySelectorAll('.dest-scroll, .remark-scroll').forEach((el) => {
    const cell = el.closest('td');
    if (!cell || !el.textContent) return;
    if (el.scrollWidth > cell.clientWidth) {
      el.classList.add('scroll');
      el.style.setProperty('--scroll-offset', `${cell.clientWidth - el.scrollWidth}px`);
    }
  });
}

function updateLiveMinutes() {
  const now = Date.now();
  for (const [index, etas] of groupEtas.entries()) {
    if (!config.groups[index]?.open) continue;
    const rows = document.querySelectorAll(`.group[data-index="${index}"] .eta-row`);
    const displayEtas = etas.slice(0, etasLimitForGroup(index));
    displayEtas.forEach((row, i) => {
      const mins = Math.max(0, Math.round((row.etaTime - now) / 60000));
      if (row.mins === mins) return;
      row.mins = mins;
      const cell = rows[i]?.querySelector('.eta-mins');
      if (cell) cell.textContent = mins;
    });
  }
}

async function refreshGroup(index, { silent = false } = {}) {
  const group = config.groups[index];
  if (!group.open) return;

  if (!silent && !groupEtas.has(index)) {
    groupState.set(index, 'loading');
    updateGroup(index);
  }

  try {
    const etas = await fetchGroupEtas(group);
    groupEtas.set(index, etas);
    groupState.set(index, 'ok');
    lastRefresh = new Date();
  } catch {
    if (!silent || !groupEtas.has(index)) groupState.set(index, 'error');
  }

  updateGroup(index);
}

function refreshOpenGroups({ silent = true } = {}) {
  clearMtrCache();
  const open = config.groups.map((g, i) => (g.open ? i : -1)).filter((i) => i >= 0);
  return Promise.all(open.map((i) => refreshGroup(i, { silent })));
}

function startRefreshTimer() {
  if (refreshTimerId) clearInterval(refreshTimerId);
  refreshTimerId = setInterval(() => refreshOpenGroups(), REFRESH_INTERVAL_MS);
}

function updateRefreshTimer() {
  const el = document.getElementById('refresh-timer');
  const secs = Math.floor((Date.now() - lastRefresh.getTime()) / 1000);
  el.textContent = `${secs}s`;
}

async function refreshAll({ spinButton = false } = {}) {
  const btn = document.getElementById('refresh-btn');
  if (spinButton) btn?.classList.add('spinning');
  try {
    await Promise.all([
      updateLocation({ resort: true }),
      loadWeatherSection(),
    ]);
  } finally {
    if (spinButton) btn?.classList.remove('spinning');
  }
}

async function init() {
  try {
    await loadConfig();
    await loadStopGeo();
    renderGroups();

    const locStatus = await bootstrapLocation();
    await loadWeatherSection();
    if (!applyLocationFromPosition(getUserPosition())) {
      await showLocationPrompt(locStatus);
      updateAllGroups();
      refreshOpenGroups();
    }
    setupLocationPrompt();
    startWeatherRefresh();
    startRefreshTimer();
    setInterval(updateRefreshTimer, 1000);
    setInterval(updateLiveMinutes, 30_000);
    updateRefreshTimer();

    document.getElementById('refresh-btn').addEventListener('click', () => refreshAll({ spinButton: true }));
    initPullToRefresh(() => refreshAll());
  } catch (err) {
    document.getElementById('groups').innerHTML = `<div class="error-msg">${escapeHtml(err.message)}</div>`;
  }
}

init();
