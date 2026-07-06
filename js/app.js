import { loadWeatherSection, startWeatherRefresh } from './weather.js';
import { distanceM, formatDistance, getUserPosition, requestUserPosition } from './location.js';
import { escapeHtml, escapeAttr } from './utils.js';

const REFRESH_INTERVAL_MS = 15_000;
const LOCATION_THRESHOLD_M = 700;
const flatView = document.documentElement.hasAttribute('data-flat-view');
const maxEtasPerGroup = (() => {
  const raw = document.documentElement.dataset.maxEtas;
  if (!raw) return Infinity;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : Infinity;
})();

const MTR_DEST = {
  FT: '富泰',
  TL: '大欖',
  SKWT: '掃管笏',
  SKW_CIR: '掃管笏',
};

const SOCIF_GEO = {
  '281-1-1': { lat: 22.373628, lng: 113.991213 },
};

const MTR_GEO = {
  'K51-D100': { lat: 22.373628, lng: 113.991213 },
  'K51A-D080': { lat: 22.373628, lng: 113.991213 },
  'K53-D060': { lat: 22.373653, lng: 113.991237 },
  'K51-U090': { lat: 22.39153, lng: 113.9755 },
  'K51A-U090': { lat: 22.39153, lng: 113.9755 },
  'K53-U020': { lat: 22.391543, lng: 113.975435 },
  'K51-U100': { lat: 22.3906, lng: 113.9788 },
  'K51A-U100': { lat: 22.3906, lng: 113.9788 },
  'K53-U030': { lat: 22.390622, lng: 113.978751 },
  'K51-U080': { lat: 22.39494, lng: 113.9746 },
  'K51A-U080': { lat: 22.39494, lng: 113.9746 },
  'K53-U010': { lat: 22.394225, lng: 113.973358 },
  'K51-U070': { lat: 22.39834, lng: 113.9752 },
  'K51A-U070': { lat: 22.39834, lng: 113.9752 },
};

/** @type {{ groups: Group[] }} */
let config;
/** @type {Date} */
let lastRefresh = new Date();
/** @type {number | null} */
let refreshTimerId = null;
/** @type {Map<string, { lat: number, lng: number }>} */
const stopGeo = new Map();
/** @type {Map<string, object[]>} */
const mtrCache = new Map();
/** @type {Map<string, string>} */
const gmbDestCache = new Map();

// Moved to top-level to avoid TDZ confusion (previously declared after first use)
/** @type {Map<number, EtaRow[]>} */
const groupEtas = new Map();
/** @type {Map<number, string>} */
const groupState = new Map();
/** @type {Set<number>} */
const groupShowAllEtas = new Set();

/** @typedef {{ title: string, open: boolean, routeStops: RouteStop[] }} Group */
/** @typedef {{ type: string, [key: string]: unknown }} RouteStop */
/** @typedef {{ routeId: string, operator: string, express: string, expressClass: string, routeClass: string, time: string, dest: string, mins: number, remark: string, etaClass: string, etaTime: Date }} EtaRow */

async function loadConfig() {
  const res = await fetch('config.json');
  if (!res.ok) throw new Error('設定ファイルを読み込めません');
  config = await res.json();
  applyGroupFilter();
  if (flatView) config.groups.forEach((g) => { g.open = true; });
}

function applyGroupFilter() {
  const filter = document.documentElement.dataset.groupFilter;
  if (!filter) return;
  const titles = new Set(filter.split('|').map((s) => s.trim()).filter(Boolean));
  config.groups = config.groups.filter((g) => titles.has(g.title));
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
    } else if (rs.type === 'mtr' && MTR_GEO[rs.stopId]) {
      stopGeo.set(rs.stopId, MTR_GEO[rs.stopId]);
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

function firstRouteStopId(rs) {
  if (rs.type === 'kmb' || rs.type === 'nwfb') return rs.stop;
  if (rs.type === 'socif') return `${rs.route}-${rs.routeSeq}-${rs.stopSeq}`;
  return rs.stopId;
}

function groupGeo(group) {
  const rs = group.routeStops[0];
  if (!rs) return null;
  return stopGeo.get(firstRouteStopId(rs)) ?? null;
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

function updateLocation({ autoOpenNearby = false } = {}) {
  return requestUserPosition().then((pos) => {
    if (!pos) return;
    if (autoOpenNearby) autoExpandNearby();
    updateAllGroups();
    if (autoOpenNearby) refreshOpenGroups();
  });
}

function operatorClass(op) {
  return { kmb: 'color-kmb', mtr: 'color-mtr', gmb: 'color-gmb', nwfb: 'color-nwfb', socif: 'color-socif' }[op] ?? '';
}

function isAirport(routeId) {
  return routeId.startsWith('A');
}

function expressInfo(routeId, operator) {
  if (isAirport(routeId)) return { text: '空港', cls: 'bg-airport' };
  if (operator === 'kmb') {
    return routeId.includes('X')
      ? { text: '特急', cls: 'bg-kmb-express' }
      : { text: '各停', cls: 'bg-kmb-local' };
  }
  if (operator === 'mtr') return { text: '各停', cls: 'bg-mtr' };
  if (operator === 'gmb') return { text: '準急', cls: 'bg-gmb' };
  if (operator === 'socif') return { text: '穿梭', cls: 'bg-socif' };
  return { text: 'ﾌﾂｳ', cls: 'bg-nwfb' };
}

function translateRemark(operator, raw, isScheduled) {
  if (operator === 'kmb') {
    if (raw === '原定班次') return '時刻通り';
    return raw;
  }
  if (operator === 'gmb' || operator === 'socif') {
    if (raw === '未開出') return '発車待ち';
    return raw ?? '';
  }
  if (operator === 'mtr') {
    if (raw === '受交通擠塞影響，到站時間可能稍為延遲') {
      return '渋滞により、到着時間が若干遅れる場合があります。';
    }
    if (isScheduled && !raw) return '時刻通り';
    return raw ?? '';
  }
  return raw ?? '';
}

function etaColorClass(isScheduled, remark) {
  if (isScheduled) return 'eta-scheduled';
  if (remark) return 'eta-error';
  return 'eta-normal';
}

function formatTime(date) {
  return date.toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
}

function mtrRouteFromStopId(stopId) {
  return stopId.split('-')[0];
}

function mtrDestFromLineRef(lineRef) {
  const suffix = lineRef.split('_').slice(1).join('_');
  return MTR_DEST[suffix] ?? suffix;
}

async function fetchKmbEtas(routeStop) {
  const serviceType = routeStop.service_type ?? 1;
  const url = `https://data.etabus.gov.hk/v1/transport/kmb/eta/${routeStop.stop}/${routeStop.route}/${serviceType}`;
  const res = await fetch(url);
  const json = await res.json();
  return (json.data ?? [])
    .filter((e) => e.eta)
    .map((e) => ({
      routeId: e.route,
      operator: 'kmb',
      express: expressInfo(e.route, 'kmb'),
      routeClass: operatorClass('kmb'),
      time: formatTime(new Date(e.eta)),
      dest: e.dest_tc,
      mins: Math.max(0, Math.round((new Date(e.eta) - Date.now()) / 60000)),
      remark: translateRemark('kmb', e.rmk_tc, e.rmk_en === 'Scheduled Bus'),
      etaClass: etaColorClass(e.rmk_en === 'Scheduled Bus', e.rmk_tc),
      etaTime: new Date(e.eta),
    }));
}

async function fetchNwfbEtas(routeStop) {
  const url = `https://rt.data.gov.hk/v1.1/transport/citybus-nwfb/eta/CTB/${routeStop.stop}/${routeStop.route}`;
  const res = await fetch(url);
  const json = await res.json();
  return (json.data ?? [])
    .filter((e) => e.eta)
    .map((e) => ({
      routeId: e.route,
      operator: 'nwfb',
      express: expressInfo(e.route, 'nwfb'),
      routeClass: operatorClass('nwfb'),
      time: formatTime(new Date(e.eta)),
      dest: e.dest_tc,
      mins: Math.max(0, Math.round((new Date(e.eta) - Date.now()) / 60000)),
      remark: translateRemark('nwfb', e.rmk_tc, false),
      etaClass: etaColorClass(false, e.rmk_tc),
      etaTime: new Date(e.eta),
    }));
}

async function fetchMtrSchedule(route) {
  if (mtrCache.has(route)) return mtrCache.get(route);
  const res = await fetch('https://rt.data.gov.hk/v1/transport/mtr/bus/getSchedule', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ language: 'zh', routeName: route }),
  });
  const json = await res.json();
  const stops = json.busStop ?? [];
  mtrCache.set(route, stops);
  return stops;
}

async function fetchMtrEtas(routeStop) {
  const route = mtrRouteFromStopId(routeStop.stopId);
  const stops = await fetchMtrSchedule(route);
  const stop = stops.find((s) => s.busStopId === routeStop.stopId);
  if (!stop?.bus?.length) return [];
  const now = Date.now();
  return stop.bus.map((bus) => {
    const secs = parseInt(bus.departureTimeInSecond, 10);
    const etaTime = new Date(now + secs * 1000);
    const isScheduled = bus.isScheduled === '1' || bus.isScheduled === 1;
    const remark = translateRemark('mtr', bus.busRemark, isScheduled);
    const routeId = bus.lineRef.split('_')[0];
    return {
      routeId,
      operator: 'mtr',
      express: expressInfo(routeId, 'mtr'),
      routeClass: operatorClass('mtr'),
      time: formatTime(etaTime),
      dest: mtrDestFromLineRef(bus.lineRef),
      mins: Math.max(0, Math.round(secs / 60)),
      remark,
      etaClass: etaColorClass(isScheduled, bus.busRemark),
      etaTime,
    };
  });
}

async function gmbDestination(realRouteId, routeSeq) {
  const key = `${realRouteId}-${routeSeq}`;
  if (gmbDestCache.has(key)) return gmbDestCache.get(key);
  try {
    const res = await fetch(`https://data.etagmb.gov.hk/route/${realRouteId}`);
    const json = await res.json();
    const dir = json.data?.[0]?.directions?.find((d) => d.route_seq === routeSeq);
    const dest = dir?.dest_tc?.trim() ?? '';
    gmbDestCache.set(key, dest);
    return dest;
  } catch {
    return '';
  }
}

async function fetchSocifEtas(routeStop) {
  const url = `https://360-api.socif.co/api/eta/route-stop/${routeStop.route}/${routeStop.routeSeq}`;
  const res = await fetch(url);
  const json = await res.json();
  const stopEta = (json.data?.eta ?? []).find((s) => s.stopSeq === routeStop.stopSeq);
  if (!stopEta?.eta?.length) return [];
  const dest = routeStop.dest ?? '';
  const displayRoute = routeStop.routeId ?? String(routeStop.route);
  return stopEta.eta.map((e) => {
    const isScheduled = e.remarks_en === 'Scheduled';
    const remark = translateRemark('socif', e.remarks_tc, isScheduled);
    const etaTime = new Date(e.timestamp);
    return {
      routeId: displayRoute,
      operator: 'socif',
      express: expressInfo(displayRoute, 'socif'),
      routeClass: operatorClass('socif'),
      time: formatTime(etaTime),
      dest,
      mins: e.diff ?? Math.max(0, Math.round((etaTime - Date.now()) / 60000)),
      remark,
      etaClass: etaColorClass(isScheduled, e.remarks_tc),
      etaTime,
    };
  });
}

async function fetchGmbEtas(routeStop) {
  const url = `https://data.etagmb.gov.hk/eta/stop/${routeStop.stopId}`;
  const res = await fetch(url);
  const json = await res.json();
  const realId = parseInt(routeStop.realRouteId, 10);
  const entry = (json.data ?? []).find((d) => d.route_id === realId && d.route_seq === routeStop.routeSeq);
  if (!entry?.eta?.length) return [];
  const dest = await gmbDestination(routeStop.realRouteId, routeStop.routeSeq);
  const displayRoute = routeStop.routeId || String(realId);
  return entry.eta
    .filter((e) => e.timestamp)
    .map((e) => {
      const isScheduled = e.remarks_en === 'Scheduled';
      const remark = translateRemark('gmb', e.remarks_tc, isScheduled);
      return {
        routeId: displayRoute,
        operator: 'gmb',
        express: expressInfo(displayRoute, 'gmb'),
        routeClass: operatorClass('gmb'),
        time: formatTime(new Date(e.timestamp)),
        dest,
        mins: e.diff ?? Math.max(0, Math.round((new Date(e.timestamp) - Date.now()) / 60000)),
        remark,
        etaClass: etaColorClass(isScheduled, e.remarks_tc),
        etaTime: new Date(e.timestamp),
      };
    });
}

async function fetchGroupEtas(group) {
  const tasks = group.routeStops.map(async (rs) => {
    try {
      switch (rs.type) {
        case 'kmb': return fetchKmbEtas(rs);
        case 'nwfb': return fetchNwfbEtas(rs);
        case 'mtr': return fetchMtrEtas(rs);
        case 'gmb': return fetchGmbEtas(rs);
        case 'socif': return fetchSocifEtas(rs);
        default: return [];
      }
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

function createEtaRowElement(row) {
  const tr = document.createElement('tr');
  tr.className = 'eta-row';
  tr.innerHTML = `
    <td class="route-id ${row.routeClass}"></td>
    <td class="express-cell ${row.express.cls}"></td>
    <td class="eta-time ${row.etaClass}"></td>
    <td class="dest-cell"></td>
    <td class="eta-mins ${row.etaClass}"></td>
    <td class="remark-cell"></td>`;
  patchEtaRow(tr, row);
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

function patchEtaRow(tr, row) {
  const [routeTd, expressTd, timeTd, destTd, minsTd, remarkTd] = tr.children;

  setCellClass(routeTd, `route-id ${row.routeClass}`);
  setCellText(routeTd, row.routeId);

  setCellClass(expressTd, `express-cell ${row.express.cls}`);
  setCellText(expressTd, row.express.text);

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
    if (existing[i]) patchEtaRow(existing[i], eta);
    else tbody.appendChild(createEtaRowElement(eta));
  });
  existing.slice(displayEtas.length).forEach((tr) => tr.remove());

  syncShowMoreButton(body, index, etas);
  setupScrollSpans(body);
}

function buildGroupsShell() {
  const container = document.getElementById('groups');
  container.innerHTML = config.groups
    .map((group, i) => {
      if (flatView) {
        return `
      <section class="group open group-flat" data-index="${i}">
        <div class="group-header">
          <span class="group-title">${escapeHtml(group.title)}</span>
          <span class="group-trailing">
            <span class="group-distance" hidden></span>
          </span>
        </div>
        <div class="group-body"></div>
      </section>`;
      }
      return `
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
      </section>`;
    })
    .join('');

  if (flatView) return;

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

  if (flatView) {
    section.classList.add('open');
    const distEl = section.querySelector('.group-distance');
    const dist = distanceToGroup(group);
    if (dist != null) {
      // Reuse formatDistance from location.js (fixes bug: was showing 0.5km instead of 500m)
      distEl.textContent = formatDistance(dist);
      distEl.hidden = false;
    } else {
      distEl.hidden = true;
    }
    syncGroupBody(index);
    return;
  }

  section.classList.toggle('open', group.open);
  section.querySelector('.group-header').setAttribute('aria-expanded', String(group.open));

  const distEl = section.querySelector('.group-distance');
  const dist = distanceToGroup(group);
  if (dist != null) {
    // Reuse formatDistance from location.js (fixes bug: was showing 0.5km instead of 500m)
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
    if (!flatView && !config.groups[index]?.open) continue;
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
  if (!flatView && !group.open) return;

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
  mtrCache.clear();
  const open = flatView
    ? config.groups.map((_, i) => i)
    : config.groups.map((g, i) => (g.open ? i : -1)).filter((i) => i >= 0);
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

async function init() {
  try {
    await loadConfig();
    await loadStopGeo();
    renderGroups();
    await updateLocation({ autoOpenNearby: !flatView });
    // Intentionally not awaited — runs in parallel with bus data refresh
    loadWeatherSection();
    startWeatherRefresh();
    if (flatView || !config.groups.some((g) => g.open)) refreshOpenGroups();
    startRefreshTimer();
    setInterval(updateRefreshTimer, 1000);
    setInterval(updateLiveMinutes, 30_000);
    updateRefreshTimer();

    document.getElementById('refresh-btn').addEventListener('click', async (e) => {
      const btn = e.currentTarget;
      btn.classList.add('spinning');
      await Promise.all([
        updateLocation(),
        refreshOpenGroups({ silent: true }),
        loadWeatherSection(),
      ]);
      btn.classList.remove('spinning');
    });
  } catch (err) {
    document.getElementById('groups').innerHTML = `<div class="error-msg">${escapeHtml(err.message)}</div>`;
  }
}

init();
