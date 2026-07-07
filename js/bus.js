import { distanceM, getUserPosition, requestUserPosition } from './location.js';
import { escapeAttr, escapeHtml } from './utils.js';
import {
  clearMtrCache,
  fetchEtas,
  fetchRouteStops,
  fetchSocifRoute,
  fetchSocifWeekdaySchedule,
  formatTime,
  operatorClass,
  parseRouteStop,
  routeTitle,
  serializeRouteStop,
} from './transit-api.js';

const REFRESH_INTERVAL_MS = 15_000;
const STOP_MAP_ZOOM = 15;
const LANDSD_MAP_API = 'https://mapapi.geodata.gov.hk/gs/api/v1.0.0/xyz';
const LANDSD_ATTRIBUTION =
  '<img src="https://www.landsd.gov.hk/images/landsd_logo.svg" alt="" width="14" height="14"> Map from <a href="https://www.landsd.gov.hk/">Lands Department</a>';
const TD_HEADWAY_BASE_URL = 'https://static.data.gov.hk/td/pt-headway-tc';
const TD_HEADWAY_URLS = {
  routes: `${TD_HEADWAY_BASE_URL}/routes.txt`,
  trips: `${TD_HEADWAY_BASE_URL}/trips.txt`,
  frequencies: `${TD_HEADWAY_BASE_URL}/frequencies.txt`,
  calendar: `${TD_HEADWAY_BASE_URL}/calendar.txt`,
  calendarDates: `${TD_HEADWAY_BASE_URL}/calendar_dates.txt`,
};
const TD_OPERATOR_AGENCIES = {
  kmb: new Set(['KMB', 'KMB+CTB']),
  nwfb: new Set(['CTB', 'KMB+CTB', 'LWB+CTB']),
};
const TD_HEADWAY_CACHE_NAME = 'td-headway-tc-v1';
const TD_HEADWAY_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

/** @type {import('./transit-api.js').RouteStopConfig | null} */
let routeStop = null;
/** @type {import('./transit-api.js').RouteStopInfo[]} */
let routeStops = [];
/** @type {Date} */
let lastRefresh = new Date();
/** @type {number | null} */
let refreshTimerId = null;
/** @type {Set<string>} */
const expandedStops = new Set();
/** @type {Map<string, import('./transit-api.js').EtaRow[]>} */
const stopEtas = new Map();
/** @type {L.Map | null} */
let map = null;
/** @type {L.Polyline | null} */
let routeLine = null;
/** @type {Map<string, L.Marker>} */
const markers = new Map();
const tdHeadwayTextPromises = new Map();
const tdHeadwayRoutePromises = new Map();
let matchedHeadwayVariant = null;
let timetableVisible = false;
let headwayLoadPromise = null;

function stopMatchesConfigured(stop) {
  if (!routeStop) return false;
  if (routeStop.type === 'socif') return stop.seq === routeStop.stopSeq;
  if (routeStop.type === 'kmb' || routeStop.type === 'nwfb') return stop.stopId === routeStop.stop;
  return stop.stopId === routeStop.stopId;
}

function findCurrentStopIndex() {
  const idx = routeStops.findIndex((s) => stopMatchesConfigured(s));
  return idx >= 0 ? idx : 0;
}

function findClosestStopIndex(userPos) {
  if (!userPos) return -1;
  const origin = { lat: userPos.coords.latitude, lng: userPos.coords.longitude };
  let bestIdx = -1;
  let bestDist = Infinity;
  routeStops.forEach((stop, i) => {
    if (!isValidCoord(stop.lat, stop.lng)) return;
    const d = distanceM(origin, { lat: stop.lat, lng: stop.lng });
    if (d < bestDist) {
      bestDist = d;
      bestIdx = i;
    }
  });
  return bestIdx;
}

function stopKey(stop) {
  return `${stop.seq}:${stop.stopId}`;
}

function operatorForRouteStop() {
  return routeStop?.type ?? 'kmb';
}

function initBackLink() {
  const params = new URLSearchParams(window.location.search);
  const back = params.get('back');
  const link = document.getElementById('back-link');
  if (!back || back.includes('://') || back.startsWith('//')) {
    link.href = './';
    return;
  }
  link.href = back === 'index.html' || back === 'all.html' ? './' : back;
}

function routeHeadwayKey() {
  if (!routeStop) return null;
  if (routeStop.type === 'socif') return `socif:${routeStop.route}:${routeStop.routeSeq}`;
  if (routeStop.type !== 'kmb' && routeStop.type !== 'nwfb') return null;
  return `${routeStop.type}:${routeStop.route}`;
}

function initTimetableButton() {
  const btn = document.getElementById('timetable-btn');
  if (!btn) return;
  if (btn.dataset.bound) return;
  btn.dataset.bound = '1';
  btn.hidden = true;
  btn.addEventListener('click', async () => {
    await ensureHeadwayFeatures();
    timetableVisible = !timetableVisible;
    renderTimetablePanel();
  });
}

function scheduleHeadwayFeatures() {
  if (!routeHeadwayKey() || !routeStops.length) return;
  const run = () => {
    headwayLoadPromise ??= initHeadwayFeatures();
  };
  if ('requestIdleCallback' in globalThis) {
    requestIdleCallback(run, { timeout: 4000 });
  } else {
    setTimeout(run, 800);
  }
}

function ensureHeadwayFeatures() {
  if (!headwayLoadPromise) {
    headwayLoadPromise = initHeadwayFeatures();
  }
  return headwayLoadPromise;
}

async function loadTdHeadwayData() {
  const key = routeHeadwayKey();
  if (!key) return null;
  if (!tdHeadwayRoutePromises.has(key)) {
    tdHeadwayRoutePromises.set(key, routeStop?.type === 'socif' ? buildSocifRouteData() : buildTdHeadwayRouteData(key));
  }
  return tdHeadwayRoutePromises.get(key);
}

async function readTdHeadwayCache(url) {
  if (!('caches' in globalThis)) return null;
  try {
    const cache = await caches.open(TD_HEADWAY_CACHE_NAME);
    const cached = await cache.match(url);
    if (!cached) return null;
    const cachedAt = Number(cached.headers.get('x-cached-at'));
    if (!Number.isFinite(cachedAt) || Date.now() - cachedAt > TD_HEADWAY_CACHE_TTL_MS) {
      await cache.delete(url);
      return null;
    }
    return cached.text();
  } catch {
    return null;
  }
}

async function writeTdHeadwayCache(url, text) {
  if (!('caches' in globalThis)) return;
  try {
    const cache = await caches.open(TD_HEADWAY_CACHE_NAME);
    const headers = new Headers({
      'Content-Type': 'text/plain',
      'x-cached-at': String(Date.now()),
    });
    await cache.put(url, new Response(text, { headers }));
  } catch {
    /* ignore quota / private-mode errors */
  }
}

async function fetchTdHeadwayText(url) {
  if (!tdHeadwayTextPromises.has(url)) {
    tdHeadwayTextPromises.set(url, (async () => {
      const cached = await readTdHeadwayCache(url);
      if (cached != null) return cached;
      const res = await fetch(url);
      if (!res.ok) throw new Error(`班次データを読み込めません: ${url}`);
      const text = await res.text();
      await writeTdHeadwayCache(url, text);
      return text;
    })());
  }
  return tdHeadwayTextPromises.get(url);
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (ch !== '\r') {
      field += ch;
    }
  }
  if (field || row.length) {
    row.push(field);
    rows.push(row);
  }
  const [header = [], ...body] = rows;
  return body
    .filter((cols) => cols.length && cols.some((value) => value !== ''))
    .map((cols) => Object.fromEntries(header.map((name, idx) => [name, cols[idx] ?? ''])));
}

async function readTdCsv(name) {
  const text = await fetchTdHeadwayText(TD_HEADWAY_URLS[name]);
  return parseCsv(text);
}

function parseCsvFiltered(text, predicate) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  let header = null;

  const flushRow = () => {
    row.push(field);
    if (!header) {
      header = row;
    } else if (row.length && row.some((value) => value !== '')) {
      const record = Object.fromEntries(header.map((name, idx) => [name, row[idx] ?? '']));
      if (predicate(record)) rows.push(record);
    }
    row = [];
    field = '';
  };

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n') {
      flushRow();
    } else if (ch !== '\r') {
      field += ch;
    }
  }
  if (field || row.length) flushRow();
  return rows;
}

async function readTdCsvFiltered(name, predicate) {
  const text = await fetchTdHeadwayText(TD_HEADWAY_URLS[name]);
  return parseCsvFiltered(text, predicate);
}

function tdOperatorMatches(type, agencyId) {
  return TD_OPERATOR_AGENCIES[type]?.has(agencyId) ?? false;
}

function buildCalendarMap(rows) {
  return Object.fromEntries(rows.map((row) => [row.service_id, {
    monday: row.monday === '1',
    tuesday: row.tuesday === '1',
    wednesday: row.wednesday === '1',
    thursday: row.thursday === '1',
    friday: row.friday === '1',
    saturday: row.saturday === '1',
    sunday: row.sunday === '1',
    startDate: row.start_date,
    endDate: row.end_date,
  }]));
}

function buildCalendarExceptionsMap(rows) {
  const out = new Map();
  for (const row of rows) {
    const list = out.get(row.service_id) ?? [];
    list.push({ date: row.date, exceptionType: parseInt(row.exception_type, 10) });
    out.set(row.service_id, list);
  }
  return out;
}

async function buildTdHeadwayRouteData(key) {
  if (!routeStop) return null;
  const [type, route] = key.split(':');
  const routesRows = await readTdCsv('routes');
  const selectedRoutes = routesRows.filter((row) => row.route_short_name === route && tdOperatorMatches(type, row.agency_id));
  if (!selectedRoutes.length) return null;
  const selectedRouteIds = new Set(selectedRoutes.map((row) => row.route_id));
  const routeLongNameById = new Map(selectedRoutes.map((row) => [row.route_id, row.route_long_name]));

  const tripsRows = await readTdCsvFiltered('trips', (row) => selectedRouteIds.has(row.route_id));
  const selectedTripIds = new Set(tripsRows.map((row) => row.trip_id));
  const [filteredFrequencies, calendarRows, calendarDateRows] = await Promise.all([
    readTdCsvFiltered('frequencies', (row) => selectedTripIds.has(row.trip_id)),
    readTdCsv('calendar'),
    readTdCsv('calendarDates'),
  ]);

  const calendars = buildCalendarMap(calendarRows);
  const calendarExceptions = buildCalendarExceptionsMap(calendarDateRows);

  const tripsByRoute = new Map();
  for (const row of tripsRows) {
    const list = tripsByRoute.get(row.route_id) ?? [];
    list.push(row);
    tripsByRoute.set(row.route_id, list);
  }

  const frequenciesByTrip = new Map();
  for (const row of filteredFrequencies) {
    const list = frequenciesByTrip.get(row.trip_id) ?? [];
    list.push({
      startTime: row.start_time,
      endTime: row.end_time,
      headwaySecs: parseInt(row.headway_secs, 10),
    });
    frequenciesByTrip.set(row.trip_id, list);
  }

  /** @type {{variants: any[]}|null} */
  let bestRouteData = null;
  for (const routeRow of selectedRoutes) {
    const variants = new Map();
    for (const trip of tripsByRoute.get(routeRow.route_id) ?? []) {
      const parts = trip.trip_id.split('-');
      if (parts.length < 4) continue;
      const gtfsBound = parts[1];
      const variant = variants.get(gtfsBound) ?? {
        gtfsBound,
        routeLongName: routeLongNameById.get(routeRow.route_id) ?? '',
        serviceIds: new Set(),
        timetableByServiceId: new Map(),
      };
      variant.serviceIds.add(trip.service_id);
      const freqRows = frequenciesByTrip.get(trip.trip_id) ?? [];
      if (freqRows.length) {
        const current = variant.timetableByServiceId.get(trip.service_id) ?? [];
        current.push(...freqRows);
        variant.timetableByServiceId.set(trip.service_id, current);
      }
      variants.set(gtfsBound, variant);
    }

    const normalizedVariants = [...variants.values()].map((variant) => ({
      gtfsBound: variant.gtfsBound,
      routeLongName: variant.routeLongName,
      serviceIds: [...variant.serviceIds].sort(),
      calendar: Object.fromEntries([...variant.serviceIds].filter((id) => calendars[id]).map((id) => [id, calendars[id]])),
      calendarExceptions: Object.fromEntries([...variant.serviceIds].filter((id) => calendarExceptions.has(id)).map((id) => [id, calendarExceptions.get(id)])),
      timetableByServiceId: Object.fromEntries([...variant.timetableByServiceId.entries()].map(([serviceId, rows]) => [serviceId, rows.sort((a, b) => a.startTime.localeCompare(b.startTime))])),
    })).filter((variant) => Object.values(variant.timetableByServiceId).some((rows) => rows.length));

    if (!bestRouteData || normalizedVariants.length > bestRouteData.variants.length) {
      bestRouteData = { variants: normalizedVariants };
    }
  }

  return bestRouteData;
}

function socifWeekdayIndex(date) {
  const day = date.getDay();
  return day === 0 ? 7 : day;
}

async function buildSocifRouteData() {
  if (!routeStop || routeStop.type !== 'socif') return null;
  const today = new Date();
  const weekdayIndex = socifWeekdayIndex(today);
  const [routeData, scheduleRows] = await Promise.all([
    fetchSocifRoute(routeStop.route),
    fetchSocifWeekdaySchedule(routeStop.route, weekdayIndex),
  ]);
  const direction = routeData?.directions?.find((item) => item.route_seq === routeStop.routeSeq) ?? null;
  const todaySchedule = (scheduleRows ?? []).find((item) => item.route_seq === routeStop.routeSeq);
  return {
    timetableKind: 'departure',
    hasTimetable: Boolean(direction?.headways?.length || todaySchedule?.schedules?.length),
    rows: (todaySchedule?.schedules ?? []).map((value) => ({ kind: 'departure', time: value })),
  };
}

function stripGtfsMarkup(value) {
  return String(value)
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/\[[^\]]+\]\s*/g, '')
    .replace(/[|]/g, ' ')
    .replace(/\([^)]*\)/g, '')
    .replace(/（[^）]*）/g, '')
    .replace(/,/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeStopName(value) {
  return stripGtfsMarkup(value)
    .replace(/[ 　]/g, '')
    .replace(/[・･]/g, '')
    .replace(/[－-]/g, '')
    .toLowerCase();
}

function gtfsNameCandidates(value) {
  return String(value)
    .split('|')
    .map((part) => normalizeStopName(part))
    .filter(Boolean);
}

function stopNameScore(appName, gtfsName) {
  const target = normalizeStopName(appName);
  if (!target) return 0;
  let best = 0;
  for (const candidate of gtfsNameCandidates(gtfsName)) {
    if (!candidate) continue;
    if (candidate === target) best = Math.max(best, 4);
    else if (candidate.includes(target) || target.includes(candidate)) best = Math.max(best, 2);
  }
  return best;
}

function variantMatchScore(variant) {
  const [orig = '', dest = ''] = String(variant.routeLongName ?? '').split(/\s*-\s*/);
  const appBound = routeStop?.bound ?? routeStop?.dir;
  const startName = routeStops[0]?.name ?? '';
  const endName = routeStops.at(-1)?.name ?? '';
  let score = Object.values(variant.timetableByServiceId ?? {}).reduce((total, rows) => total + rows.length, 0);

  const outboundFit = stopNameScore(startName, orig) + stopNameScore(endName, dest);
  const inboundFit = stopNameScore(startName, dest) + stopNameScore(endName, orig);
  if (appBound === 'O') score += outboundFit * 5;
  else if (appBound === 'I') score += inboundFit * 5;
  else score += Math.max(outboundFit, inboundFit) * 3;

  if (appBound === 'O' && variant.gtfsBound === '1') score += 4;
  if (appBound === 'I' && variant.gtfsBound === '2') score += 4;

  return score;
}

function isServiceActive(service, exceptions, date) {
  if (!service) return false;
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  const dateKey = `${y}${m}${d}`;
  const override = (exceptions ?? []).find((item) => item.date === dateKey);
  if (override) return override.exceptionType === 1;
  if (dateKey < service.startDate || dateKey > service.endDate) return false;
  return service[['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'][date.getDay()]];
}

function formatScheduleTime(value) {
  const [hh = '00', mm = '00'] = String(value).split(':');
  const totalHours = parseInt(hh, 10);
  const hours = String(totalHours % 24).padStart(2, '0');
  return `${hours}${mm}`;
}

function timetableRowsForToday() {
  if (!matchedHeadwayVariant) return [];
  if (matchedHeadwayVariant.timetableKind === 'departure') return matchedHeadwayVariant.rows ?? [];
  const today = new Date();
  const rows = [];
  for (const serviceId of matchedHeadwayVariant.serviceIds ?? []) {
    const service = matchedHeadwayVariant.calendar?.[serviceId];
    const exceptions = matchedHeadwayVariant.calendarExceptions?.[serviceId] ?? [];
    if (!isServiceActive(service, exceptions, today)) continue;
    rows.push(...(matchedHeadwayVariant.timetableByServiceId?.[serviceId] ?? []));
  }
  rows.sort((a, b) => a.startTime.localeCompare(b.startTime));
  return rows;
}

function variantHasTimetableData(variant) {
  if (variant?.timetableKind === 'departure') {
    return Boolean(variant.hasTimetable || variant.rows?.length);
  }
  if (!variant?.timetableByServiceId) return false;
  return Object.values(variant.timetableByServiceId).some((rows) => Array.isArray(rows) && rows.length > 0);
}

function timetableDayLabel() {
  const day = new Date().getDay();
  if (day === 6) return '土曜';
  if (day === 0) return '日祝';
  return '平日';
}

function renderTimetablePanel() {
  const panel = document.getElementById('bus-timetable-panel');
  const subtitle = document.getElementById('bus-timetable-subtitle');
  const body = document.getElementById('bus-timetable-body');
  const button = document.getElementById('timetable-btn');
  if (!panel || !subtitle || !body || !button) return;

  const hasRouteTimetable = variantHasTimetableData(matchedHeadwayVariant);
  const rows = hasRouteTimetable ? timetableRowsForToday() : [];
  if (!hasRouteTimetable) timetableVisible = false;
  button.hidden = !hasRouteTimetable;
  button.textContent = timetableVisible ? '時刻表を閉じる' : '時刻表';
  button.setAttribute('aria-pressed', String(timetableVisible));
  panel.hidden = !hasRouteTimetable || !timetableVisible;
  if (!hasRouteTimetable) return;

  subtitle.textContent = `${timetableDayLabel()}ダイヤ`;
  if (!rows.length) {
    body.innerHTML = '<div class="bus-stop-empty">本日の時刻表データがありません</div>';
    return;
  }
  body.innerHTML = `<div class="bus-timetable-list">${rows.map((row) => `
    <div class="bus-timetable-row">
      ${row.kind === 'departure'
    ? `<span class="bus-timetable-range">${formatScheduleTime(row.time)}</span>`
    : `<span class="bus-timetable-range">${formatScheduleTime(row.startTime)} - ${formatScheduleTime(row.endTime)}</span>
      <span class="bus-timetable-headway">${Math.round(row.headwaySecs / 60)}分間隔</span>`}
    </div>`).join('')}</div>`;
}

async function initHeadwayFeatures() {
  matchedHeadwayVariant = null;
  const key = routeHeadwayKey();
  if (!key || !routeStops.length) {
    renderTimetablePanel();
    return;
  }

  try {
    const routeData = await loadTdHeadwayData();
    if (!routeData) {
      renderTimetablePanel();
      return;
    }
    if (routeData.timetableKind === 'departure') {
      matchedHeadwayVariant = routeData;
      renderTimetablePanel();
      return;
    }
    if (!routeData.variants?.length) {
      renderTimetablePanel();
      return;
    }

    matchedHeadwayVariant = routeData.variants
      .map((variant) => ({ variant, score: variantMatchScore(variant) }))
      .sort((a, b) => b.score - a.score)[0]?.variant ?? null;
  } catch {
    matchedHeadwayVariant = null;
  }

  renderTimetablePanel();
}

async function reverseRouteStopConfig() {
  if (!routeStop) return null;
  switch (routeStop.type) {
    case 'kmb':
      return { ...routeStop, bound: routeStop.bound === 'I' ? 'O' : 'I' };
    case 'nwfb':
      return { ...routeStop, dir: routeStop.dir === 'I' ? 'O' : 'I' };
    case 'socif': {
      const routeData = await fetchSocifRoute(routeStop.route);
      const reversed = routeData?.directions?.find((direction) => direction.route_seq !== routeStop.routeSeq);
      if (!reversed) return null;
      return {
        ...routeStop,
        routeId: routeStop.routeId ?? routeData?.route_code ?? String(routeStop.route),
        routeSeq: reversed.route_seq,
        dest: reversed.dest_tc ?? routeStop.dest,
      };
    }
    default:
      return null;
  }
}

function bestReverseStop(stops, currentStop) {
  if (!stops.length) return null;
  if (!currentStop) return stops[0];

  const exact = stops.find((stop) => stop.stopId === currentStop.stopId);
  if (exact) return exact;

  const sameName = stops.find((stop) => stop.name === currentStop.name);
  if (sameName) return sameName;

  if (!isValidCoord(currentStop.lat, currentStop.lng)) return stops[0];

  let bestStop = stops[0];
  let bestDistance = Infinity;
  for (const stop of stops) {
    if (!isValidCoord(stop.lat, stop.lng)) continue;
    const distance = distanceM(currentStop, stop);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestStop = stop;
    }
  }
  return bestStop;
}

async function flipBound() {
  const reversed = await reverseRouteStopConfig();
  if (!reversed) return;

  const btn = document.getElementById('flip-bound-btn');
  btn.disabled = true;
  try {
    const currentStop = routeStops[findCurrentStopIndex()] ?? routeStops[0] ?? null;
    const reversedStops = await fetchRouteStops(reversed);
    const targetStop = bestReverseStop(reversedStops, currentStop);
    if (targetStop) {
      if (reversed.type === 'kmb' || reversed.type === 'nwfb') reversed.stop = targetStop.stopId;
      else if (reversed.type === 'socif') reversed.stopSeq = targetStop.seq;
      else reversed.stopId = targetStop.stopId;
    }
    const params = serializeRouteStop(reversed);
    const currentParams = new URLSearchParams(window.location.search);
    const back = currentParams.get('back');
    window.location.href = `bus.html?${params}${back ? `&back=${encodeURIComponent(back)}` : ''}`;
  } finally {
    btn.disabled = false;
  }
}

async function initFlipBoundButton() {
  const btn = document.getElementById('flip-bound-btn');
  if (!btn) return;
  btn.hidden = true;
  if (btn.dataset.bound) return;
  const reversed = await reverseRouteStopConfig();
  if (!reversed) {
    if (btn) btn.hidden = true;
    return;
  }
  btn.dataset.bound = '1';
  btn.hidden = false;
  btn.addEventListener('click', () => {
    flipBound();
  });
}

function initMap() {
  if (map) return;
  map = L.map('bus-map', {
    zoomControl: false,
    minZoom: 10,
  });
  L.tileLayer(`${LANDSD_MAP_API}/basemap/WGS84/{z}/{x}/{y}.png`, {
    minZoom: 10,
    maxZoom: 20,
    maxNativeZoom: 20,
    attribution: LANDSD_ATTRIBUTION,
  }).addTo(map);
  L.tileLayer(`${LANDSD_MAP_API}/label/hk/tc/WGS84/{z}/{x}/{y}.png`, {
    minZoom: 10,
    maxZoom: 20,
    maxNativeZoom: 20,
  }).addTo(map);
}

function isValidCoord(lat, lng) {
  return Number.isFinite(lat) && Number.isFinite(lng);
}

function updateMap({ currentIdx, closestIdx }) {
  if (!map) return;

  markers.forEach((m) => m.remove());
  markers.clear();
  routeLine?.remove();
  routeLine = null;

  const coords = routeStops
    .filter((s) => isValidCoord(s.lat, s.lng))
    .map((s) => [s.lat, s.lng]);

  if (!coords.length) {
    map.getContainer().style.display = 'none';
    return;
  }

  map.getContainer().style.display = '';

  const op = operatorForRouteStop();
  const colorClass = operatorClass(op);

  routeStops.forEach((stop, index) => {
    if (!isValidCoord(stop.lat, stop.lng)) return;
    const isCurrent = index === currentIdx;
    const isClosest = index === closestIdx && closestIdx !== currentIdx;
    const icon = L.divIcon({
      className: 'bus-marker-wrap',
      html: `<span class="bus-marker ${isCurrent ? 'bus-marker-current' : ''} ${isClosest ? 'bus-marker-closest' : ''} ${colorClass}">${stop.seq}</span>`,
      iconSize: [32, 32],
      iconAnchor: [16, 16],
    });
    const marker = L.marker([stop.lat, stop.lng], { icon })
      .bindTooltip(escapeHtml(stop.name), { direction: 'top', opacity: 0.9 })
      .addTo(map);
    marker.on('click', () => {
      const el = document.querySelector(`[data-stop-key="${stopKey(stop)}"]`);
      el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      toggleStop(stop, true);
    });
    markers.set(stopKey(stop), marker);
  });

  if (coords.length > 1) {
    routeLine = L.polyline(coords, {
      color: '#1e64ff',
      weight: 3,
      opacity: 0.85,
    }).addTo(map);
  }

  const focusIdx = currentIdx >= 0 ? currentIdx : 0;
  const focus = routeStops[focusIdx];
  if (focus?.lat != null && focus?.lng != null && isValidCoord(focus.lat, focus.lng)) {
    map.setView([focus.lat, focus.lng], STOP_MAP_ZOOM);
  }
}

function formatEtaMinsLabel(eta) {
  const diffMins = (eta.etaTime - Date.now()) / 60000;
  if (diffMins > 0) return `${Math.round(diffMins)}分`;
  if (diffMins <= -1) return '遅刻';
  return '到着';
}

function renderEtaList(etas) {
  if (!etas.length) {
    return '<div class="bus-stop-empty">情報なし</div>';
  }
  return etas.map((eta) => `
    <div class="bus-eta-item ${eta.etaClass}">
      <span class="bus-eta-mins">${formatEtaMinsLabel(eta)}</span>
      ${eta.remark ? `<span class="bus-eta-remark">${escapeHtml(eta.remark)}</span>` : ''}
      <span class="bus-eta-time">${escapeHtml(eta.time)}</span>
    </div>`).join('');
}

function renderStops({ currentIdx, closestIdx }) {
  const container = document.getElementById('bus-stops');
  if (!routeStops.length) {
    container.innerHTML = '<div class="empty">停留所データがありません</div>';
    return;
  }

  container.innerHTML = routeStops.map((stop, index) => {
    const isCurrent = index === currentIdx;
    const isClosest = index === closestIdx && closestIdx !== currentIdx;
    const isNext = index === currentIdx + 1;
    const key = stopKey(stop);
    const expanded = expandedStops.has(key);
    const etas = stopEtas.get(key) ?? [];
    const rowClass = [
      'bus-stop',
      isCurrent ? 'bus-stop-current' : '',
      isClosest ? 'bus-stop-closest' : '',
      isNext && !isClosest ? 'bus-stop-next' : '',
      expanded ? 'open' : '',
    ].filter(Boolean).join(' ');

    const badges = [];
    if (isCurrent) badges.push('<span class="bus-stop-badge bus-stop-badge-current">現在</span>');
    if (isClosest) badges.push('<span class="bus-stop-badge bus-stop-badge-closest">最寄り</span>');
    else if (isNext) badges.push('<span class="bus-stop-badge bus-stop-badge-next">つぎは</span>');

    const markerClass = isCurrent
      ? 'bus-stop-num-current'
      : (isClosest ? 'bus-stop-num-closest' : (isNext ? 'bus-stop-num-next' : ''));

    return `
      <section class="${rowClass}" data-stop-key="${escapeAttr(key)}" data-index="${index}">
        <button class="bus-stop-header" type="button" aria-expanded="${expanded}">
          <span class="bus-stop-num ${markerClass}">${stop.seq}</span>
          <span class="bus-stop-info">
            ${badges.length ? `<span class="bus-stop-badges">${badges.join('')}</span>` : ''}
            <span class="bus-stop-name">${escapeHtml(stop.name)}</span>
          </span>
          <svg class="bus-stop-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
            <polyline points="6 9 12 15 18 9"/>
          </svg>
        </button>
        <div class="bus-stop-body" ${expanded ? '' : 'hidden'}>
          ${renderEtaList(etas)}
        </div>
      </section>`;
  }).join('');

}

function bindStopClicks() {
  const container = document.getElementById('bus-stops');
  if (container.dataset.bound) return;
  container.dataset.bound = '1';
  container.addEventListener('click', (e) => {
    const btn = e.target.closest('.bus-stop-header');
    if (!btn) return;
    const section = btn.closest('.bus-stop');
    const index = parseInt(section.dataset.index, 10);
    toggleStop(routeStops[index]);
  });
}

async function fetchStopEtas(stop) {
  if (!routeStop) return [];
  const rs = { ...routeStop };
  switch (rs.type) {
    case 'kmb':
    case 'nwfb':
      rs.stop = stop.stopId;
      break;
    case 'mtr':
      rs.stopId = stop.stopId;
      break;
    case 'gmb':
      rs.stopId = stop.stopId;
      break;
    case 'socif':
      rs.stopSeq = stop.seq;
      break;
    default:
      break;
  }
  try {
    return await fetchEtas(rs);
  } catch {
    return [];
  }
}

async function toggleStop(stop, forceOpen = false) {
  const key = stopKey(stop);
  const open = forceOpen || !expandedStops.has(key);
  if (open) {
    expandedStops.add(key);
    if (!stopEtas.has(key)) {
      const etas = await fetchStopEtas(stop);
      stopEtas.set(key, etas);
    }
    const marker = markers.get(key);
    if (marker && stop.lat != null && stop.lng != null) {
      map?.setView([stop.lat, stop.lng], STOP_MAP_ZOOM, { animate: true });
      marker.openTooltip();
    }
  } else {
    expandedStops.delete(key);
  }
  const userPos = getUserPosition();
  renderStops({
    currentIdx: findCurrentStopIndex(),
    closestIdx: findClosestStopIndex(userPos),
  });
}

async function refresh({ silent = false } = {}) {
  if (!routeStop) return;

  if (!silent) {
    const configured = routeStops[findCurrentStopIndex()];
    if (configured) await toggleStop(configured, true);
  }

  const keysToRefresh = new Set(expandedStops);
  const configured = routeStops[findCurrentStopIndex()];
  if (configured) keysToRefresh.add(stopKey(configured));

  await Promise.all([...keysToRefresh].map(async (key) => {
    const stop = routeStops.find((s) => stopKey(s) === key);
    if (!stop) return;
    const etas = await fetchStopEtas(stop);
    stopEtas.set(key, etas);
  }));

  clearMtrCache();
  lastRefresh = new Date();
  const userPos = getUserPosition();
  renderStops({
    currentIdx: findCurrentStopIndex(),
    closestIdx: findClosestStopIndex(userPos),
  });
}

function startRefreshTimer() {
  if (refreshTimerId) clearInterval(refreshTimerId);
  refreshTimerId = setInterval(() => refresh({ silent: true }), REFRESH_INTERVAL_MS);
}

function updateRefreshTimer() {
  const el = document.getElementById('refresh-timer');
  const secs = Math.floor((Date.now() - lastRefresh.getTime()) / 1000);
  el.textContent = `${secs}s`;
}

function updateLiveMinutes() {
  const now = Date.now();
  for (const etas of stopEtas.values()) {
    for (const row of etas) {
      row.mins = Math.round((row.etaTime - now) / 60000);
      row.time = formatTime(row.etaTime);
    }
  }
  document.querySelectorAll('.bus-stop.open').forEach((section) => {
    const key = section.dataset.stopKey;
    const etas = stopEtas.get(key) ?? [];
    const body = section.querySelector('.bus-stop-body');
    if (body) body.innerHTML = renderEtaList(etas);
  });
}

async function init() {
  initBackLink();
  bindStopClicks();
  const params = new URLSearchParams(window.location.search);
  routeStop = parseRouteStop(params);
  initTimetableButton();

  if (!routeStop?.type) {
    document.getElementById('bus-title').textContent = '路線が見つかりません';
    document.getElementById('bus-stops').innerHTML = '<div class="error-msg">無効なリンクです</div>';
    return;
  }

  await initFlipBoundButton();

  initMap();

  try {
    routeStops = await fetchRouteStops(routeStop);
    const title = await routeTitle(routeStop, routeStops);
    document.getElementById('bus-title').textContent = title;

    const currentIdx = findCurrentStopIndex();
    const closestIdx = findClosestStopIndex(getUserPosition());
    updateMap({ currentIdx, closestIdx });

    const configured = routeStops[currentIdx];
    if (configured) {
      expandedStops.add(stopKey(configured));
      const etas = await fetchStopEtas(configured);
      stopEtas.set(stopKey(configured), etas);
    }

    renderStops({ currentIdx, closestIdx });
    lastRefresh = new Date();
    scheduleHeadwayFeatures();

    requestAnimationFrame(() => {
      map?.invalidateSize();
      updateMap({ currentIdx, closestIdx });
      document.querySelector('.bus-stop-current')?.scrollIntoView({ block: 'center' });
    });

    startRefreshTimer();
    setInterval(updateRefreshTimer, 1000);
    setInterval(updateLiveMinutes, 15_000);
    updateRefreshTimer();

    document.getElementById('refresh-btn').addEventListener('click', async () => {
      const btn = document.getElementById('refresh-btn');
      btn.classList.add('spinning');
      try {
        await requestUserPosition();
        await refresh({ silent: true });
        const userPos = getUserPosition();
        const currentIdx = findCurrentStopIndex();
        const closestIdx = findClosestStopIndex(userPos);
        updateMap({ currentIdx, closestIdx });
        renderStops({ currentIdx, closestIdx });
      } finally {
        btn.classList.remove('spinning');
      }
    });
  } catch (err) {
    document.getElementById('bus-title').textContent = '読み込みエラー';
    document.getElementById('bus-stops').innerHTML = `<div class="error-msg">${escapeHtml(err.message)}</div>`;
  }
}

init();
