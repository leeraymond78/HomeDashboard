import { loadWeatherSection, startWeatherRefresh } from './weather.js';
import { distanceM, formatDistance, bootstrapLocation, geolocationBlockReason, getLastGeoError, getUserPosition, requestUserPosition } from './location.js';
import { escapeHtml } from './utils.js';
import { initPullToRefresh } from './pull-to-refresh.js';
import { initDashboardThemeToggle } from './theme.js';
import { ensureRouteSearchIndex } from './route-search-api.js';
import { ensureRouteFareDb, getFareStop } from './route-fare-db.js';
import {
  SOCIF_GEO,
  enrichEtasWithBusLocation,
  fetchEtas,
  fetchRouteStops,
  getMtrStopGeo,
  parseRouteStop,
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
/** @type {Map<string, import('./transit-api.js').RouteStopInfo[]>} */
const routeStopsCache = new Map();
/** @type {Set<number>} */
const refreshInFlight = new Set();
/** @type {Set<number>} */
const refreshPending = new Set();

async function loadConfig() {
  const res = await fetch('config.json');
  if (!res.ok) throw new Error('Failed to load config');
  config = await res.json();
}

async function loadStopGeo() {
  // Ensure fare DB is loaded once before processing all stops.
  await ensureRouteFareDb();
  const firstStops = config.groups.map((g) => g.routeStops[0]).filter(Boolean);
  await Promise.all(firstStops.map(loadRouteStopGeo));
}

async function loadRouteStopGeo(rs) {
  try {
    if (rs.type === 'kmb' || rs.type === 'nwfb') {
      const stopId = rs.stop;
      const stop = getFareStop(stopId);
      if (stop?.location) {
        stopGeo.set(stopId, { lat: stop.location.lat, lng: stop.location.lng });
        return;
      }
    } else if (rs.type === 'mtr') {
      const geo = await getMtrStopGeo(rs.stopId);
      if (geo) stopGeo.set(rs.stopId, geo);
      return;
    } else if (rs.type === 'gmb') {
      const stop = getFareStop(rs.stopId);
      if (stop?.location) {
        stopGeo.set(rs.stopId, { lat: stop.location.lat, lng: stop.location.lng });
        return;
      }
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
    btn.textContent = 'Location access denied. Please enable in Settings.';
    return;
  }
  if (status === 'unavailable') {
    btn.disabled = false;
    btn.textContent = 'Could not get location. Please try again.';
    return;
  }
  if (status === 'unsupported') {
    btn.textContent = 'Location is not supported on this device.';
    btn.disabled = true;
    return;
  }
  if (status === 'insecure') {
    btn.textContent = 'HTTPS is required for location access.';
    btn.disabled = true;
    return;
  }
  btn.disabled = false;
  btn.textContent = 'Show nearby stops (allow location)';
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

function routeStopsCacheKey(rs) {
  if (rs.type === 'gmb') return `gmb:${rs.realRouteId}:${rs.routeSeq}`;
  if (rs.type === 'mtr') return `mtr:${rs.stopId}`;
  if (rs.type === 'socif') return `socif:${rs.route}:${rs.routeSeq}`;
  return `${rs.type}:${rs.route ?? rs.routeId}:${rs.bound ?? rs.dir ?? ''}:${rs.service_type ?? 1}`;
}

/** @param {import('./transit-api.js').RouteStopInfo[]} routeStops @param {RouteStop} rs */
function findTargetStop(routeStops, rs) {
  if (!routeStops.length) return null;
  if (rs.type === 'socif') return routeStops.find((s) => s.seq === rs.stopSeq) ?? null;
  if (rs.type === 'kmb' || rs.type === 'nwfb') return routeStops.find((s) => s.stopId === rs.stop) ?? null;
  return routeStops.find((s) => s.stopId === rs.stopId) ?? null;
}

async function getRouteStops(rs) {
  const key = routeStopsCacheKey(rs);
  const cached = routeStopsCache.get(key);
  if (cached) return cached;
  try {
    const stops = await fetchRouteStops(rs);
    routeStopsCache.set(key, stops);
    return stops;
  } catch {
    return [];
  }
}

/** @type {Map<number, number>} */
const enrichGeneration = new Map();

function etaIdentity(row) {
  const rs = row.routeStop;
  const routeStopKey = rs ? serializeRouteStop(rs) : '';
  return `${routeStopKey}|${row.routeId}|${row.etaTime.getTime()}|${row.etaSeq ?? ''}`;
}

function mergeBasicRefreshForRoute(index, rs, fresh) {
  const routeKey = serializeRouteStop(rs);
  const current = groupEtas.get(index) ?? [];
  const prevForRoute = new Map(
    current
      .filter((row) => row.routeStop && serializeRouteStop(row.routeStop) === routeKey)
      .map((row) => [etaIdentity(row), row]),
  );
  const others = current.filter((row) => !row.routeStop || serializeRouteStop(row.routeStop) !== routeKey);
  const merged = fresh.map((row) => {
    const prev = prevForRoute.get(etaIdentity(row));
    if (!prev) return row;
    return {
      ...row,
      busLat: prev.busLat,
      busLng: prev.busLng,
      busStopSeq: prev.busStopSeq,
      busStopName: prev.busStopName,
      busStopsLeft: prev.busStopsLeft,
      busAwaitingDepart: prev.busAwaitingDepart,
    };
  });
  groupEtas.set(index, [...others, ...merged].sort((a, b) => a.etaTime - b.etaTime));
}

function applyEnrichedEtas(index, enriched) {
  const byId = new Map(enriched.map((row) => [etaIdentity(row), row]));
  const current = groupEtas.get(index) ?? [];
  let changed = false;
  const updated = current.map((row) => {
    const next = byId.get(etaIdentity(row));
    if (!next) return row;
    if (
      next.busStopsLeft === row.busStopsLeft
      && next.busAwaitingDepart === row.busAwaitingDepart
      && next.remark === row.remark
    ) {
      return row;
    }
    changed = true;
    return next;
  });
  if (!changed) return;
  groupEtas.set(index, updated.sort((a, b) => a.etaTime - b.etaTime));
  updateGroup(index);
}

async function enrichRouteStopEtas(index, rs, gen) {
  if (enrichGeneration.get(index) !== gen) return;
  try {
    const current = groupEtas.get(index) ?? [];
    const routeKey = serializeRouteStop(rs);
    const etasForRoute = current.filter((row) =>
      row.routeStop && serializeRouteStop(row.routeStop) === routeKey);
    if (!etasForRoute.length) return;

    const routeStops = await getRouteStops(rs);
    const targetStop = findTargetStop(routeStops, rs);
    if (!targetStop) return;

    const enriched = await enrichEtasWithBusLocation(etasForRoute, rs, targetStop, routeStops);
    if (enrichGeneration.get(index) !== gen) return;
    applyEnrichedEtas(index, enriched);
  } catch {
    /* ignore enrichment errors */
  }
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
  setEtaRowNavigation(tr, row.routeStop);
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
    span?.remove();
    return;
  }
  if (!span) {
    span = document.createElement('span');
    span.className = className;
    td.appendChild(span);
  }
  if (span.textContent !== next) {
    span.textContent = next;
    span.classList.remove('scroll');
    span.style.removeProperty('--scroll-offset');
  }
}

function etaStopsLeft(row) {
  if (row.busAwaitingDepart || row.remark === '發車待機') return null;
  if (row.busStopsLeft != null && row.busStopsLeft > 0) return row.busStopsLeft;
  return null;
}

function remarkCellText(row) {
  const stopsLeft = etaStopsLeft(row);
  if (stopsLeft != null) return `${stopsLeft} stops away`;
  return String(row.remark ?? '');
}

function setRemarkCell(td, row) {
  const text = remarkCellText(row);
  setScrollText(td, text, 'remark-scroll');
  if (!text) td.replaceChildren();
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

  setRemarkCell(remarkTd, row);
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

function groupBodyInner(section) {
  return section.querySelector('.group-body-inner');
}

function scheduleGroupBodyClear(index) {
  const section = document.querySelector(`.group[data-index="${index}"]`);
  if (!section) return;

  const panel = section.querySelector('.group-body');
  const inner = groupBodyInner(section);
  if (!panel || !inner) {
    inner?.replaceChildren();
    return;
  }

  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    inner.replaceChildren();
    return;
  }

  const onEnd = (e) => {
    if (e.target !== panel || e.propertyName !== 'grid-template-rows') return;
    panel.removeEventListener('transitionend', onEnd);
    if (!config.groups[index]?.open) inner.replaceChildren();
  };
  panel.addEventListener('transitionend', onEnd);
}

function setEtaRowNavigation(tr, routeStop) {
  if (!routeStop) {
    tr.classList.remove('eta-row-clickable');
    delete tr.dataset.routeStop;
    return;
  }
  tr.classList.add('eta-row-clickable');
  tr.dataset.routeStop = serializeRouteStop(routeStop);
}

function bindEtaRowNavigation(tbody) {
  if (tbody.dataset.navBound) return;
  tbody.dataset.navBound = '1';
  tbody.addEventListener('click', (e) => {
    const tr = e.target.closest('.eta-row-clickable');
    if (!tr?.dataset.routeStop) return;
    const rs = parseRouteStop(new URLSearchParams(tr.dataset.routeStop));
    if (rs) navigateToBusDetail(rs);
  });
}

function ensureEtaTable(body) {
  let table = body.querySelector('.eta-table');
  if (table) {
    const tbody = table.querySelector('tbody');
    bindEtaRowNavigation(tbody);
    return tbody;
  }

  body.replaceChildren();
  table = document.createElement('table');
  table.className = 'eta-table';
  table.innerHTML = `${ETA_TABLE_COLGROUP}<tbody></tbody>`;
  body.appendChild(table);
  const tbody = table.querySelector('tbody');
  bindEtaRowNavigation(tbody);
  return tbody;
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

  const label = `Show more (${hiddenCount} more)`;
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

  const body = groupBodyInner(section);
  if (!body) return;
  const etas = groupEtas.get(index) ?? [];
  const state = groupState.get(index) ?? 'loading';
  const displayEtas = etas.slice(0, etasLimitForGroup(index));

  if (!displayEtas.length) {
    if (state === 'loading') {
      showGroupMessage(body, 'loading', 'Loading...');
      return;
    }
    if (state === 'error') {
      showGroupMessage(body, 'error-msg', 'Failed to load data');
      return;
    }
    showGroupMessage(body, 'empty', 'No upcoming buses');
    return;
  }

  const tbody = ensureEtaTable(body);
  const existing = [...tbody.querySelectorAll('.eta-row')];

  displayEtas.forEach((eta, i) => {
    if (existing[i]) {
      patchEtaRow(existing[i], eta);
      setEtaRowNavigation(existing[i], eta.routeStop);
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
        <div class="group-body"><div class="group-body-inner"></div></div>
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

  const inner = groupBodyInner(section);
  if (!inner) return;
  if (!group.open) {
    inner.toggleAttribute('inert', true);
    inner.setAttribute('aria-hidden', 'true');
    scheduleGroupBodyClear(index);
    return;
  }

  inner.toggleAttribute('inert', false);
  inner.setAttribute('aria-hidden', 'false');
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
    // Skip recalculation if width has not changed since last measure.
    const prevWidth = el.dataset.cellWidth;
    const currentWidth = String(cell.clientWidth);
    if (prevWidth === currentWidth && el.classList.contains('scroll')) return;
    el.dataset.cellWidth = currentWidth;
    if (el.scrollWidth > cell.clientWidth) {
      el.classList.add('scroll');
      el.style.setProperty('--scroll-offset', `${cell.clientWidth - el.scrollWidth}px`);
    } else {
      el.classList.remove('scroll');
      el.style.removeProperty('--scroll-offset');
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

  if (refreshInFlight.has(index)) {
    refreshPending.add(index);
    return;
  }

  refreshInFlight.add(index);
  try {
    const gen = (enrichGeneration.get(index) ?? 0) + 1;
    enrichGeneration.set(index, gen);

    const isFirstLoad = !groupEtas.has(index);
    if (!silent && isFirstLoad) {
      groupState.set(index, 'loading');
      groupEtas.set(index, []);
      updateGroup(index);
    }

    let hadError = false;
    const tasks = group.routeStops.map(async (rs) => {
      if (enrichGeneration.get(index) !== gen) return;
      try {
        const etas = await fetchEtas(rs);
        if (enrichGeneration.get(index) !== gen) return;

        if (silent && groupEtas.has(index)) {
          mergeBasicRefreshForRoute(index, rs, etas);
        } else {
          const current = groupEtas.get(index) ?? [];
          groupEtas.set(index, [...current, ...etas].sort((a, b) => a.etaTime - b.etaTime));
        }

        groupState.set(index, 'ok');
        lastRefresh = new Date();
        updateGroup(index);
        // Fire-and-forget: enrichment runs in the background and does not
        // block the main ETA render or delay subsequent route stops.
        enrichRouteStopEtas(index, rs, gen).catch(() => {});
      } catch {
        hadError = true;
      }
    });

    await Promise.all(tasks);

    if (hadError && isFirstLoad && !(groupEtas.get(index)?.length)) {
      groupState.set(index, 'error');
      updateGroup(index);
    }
  } finally {
    refreshInFlight.delete(index);
    if (refreshPending.has(index)) {
      refreshPending.delete(index);
      void refreshGroup(index, { silent: true });
    }
  }
}

function refreshOpenGroups({ silent = true } = {}) {
  const open = config.groups.map((g, i) => (g.open ? i : -1)).filter((i) => i >= 0);
  return Promise.all(open.map((i) => refreshGroup(i, { silent })));
}

function startRefreshTimer() {
  if (refreshTimerId) clearInterval(refreshTimerId);
  refreshTimerId = setInterval(() => {
    if (document.hidden) return;
    refreshOpenGroups();
  }, REFRESH_INTERVAL_MS);

  // When the page becomes visible again, refresh immediately instead of
  // waiting up to REFRESH_INTERVAL_MS for the next tick.
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) refreshOpenGroups();
  });
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

function showBuildStamp(el, build) {
  if (Number.isFinite(build) && build > 0) el.textContent = `build ${build}`;
}

async function loadBuildStamp() {
  const el = document.getElementById('build-stamp');
  if (!el) return;

  const inline = Number(el.dataset.build);
  if (Number.isFinite(inline) && inline > 0) {
    showBuildStamp(el, inline);
    return;
  }

  try {
    const res = await fetch('build-info.json', { cache: 'no-store' });
    if (!res.ok) return;
    const info = await res.json();
    showBuildStamp(el, Number(info.build));
  } catch {
    /* ignore */
  }
}

async function init() {
  initDashboardThemeToggle();
  loadBuildStamp();
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
    const prefetchSearch = () => ensureRouteSearchIndex().catch(() => {});
    if ('requestIdleCallback' in window) {
      requestIdleCallback(prefetchSearch, { timeout: 5000 });
    } else {
      setTimeout(prefetchSearch, 1500);
    }
  } catch (err) {
    document.getElementById('groups').innerHTML = `<div class="error-msg">${escapeHtml(err.message)}</div>`;
  }
}

init();
