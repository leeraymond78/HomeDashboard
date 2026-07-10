import { distanceM, bootstrapLocation, geolocationBlockReason, getUserPosition, requestUserPosition } from './location.js';
import { escapeAttr, escapeHtml } from './utils.js';
import {
  clearRouteWideEtaCache,
  enrichEtasWithBusLocation,
  fetchEtas,
  fetchRouteStops,
  fetchSocifRoute,
  fetchSocifWeekdaySchedule,
  formatTime,
  operatorClass,
  parseRouteStop,
  routeTitle,
  routeTitleHint,
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
/** @type {L.Marker | null} */
let userMarker = null;
/** @type {L.Polyline | null} */
let routeLine = null;
/** @type {Map<string, L.Marker>} */
const markers = new Map();
/** @type {L.LayerGroup | null} */
let busMarkersLayer = null;
/** @type {L.LayerGroup | null} */
let busApproachLayer = null;
const tdHeadwayTextPromises = new Map();
const tdHeadwayRoutePromises = new Map();
let matchedHeadwayVariant = null;
let timetableVisible = false;
let headwayLoadPromise = null;

function preferNearestAnchor() {
  return new URLSearchParams(window.location.search).get('nearest') === '1';
}

function stopMatchesConfigured(stop) {
  if (!routeStop) return false;
  if (routeStop.type === 'socif') return stop.seq === routeStop.stopSeq;
  if (routeStop.type === 'kmb' || routeStop.type === 'nwfb') return stop.stopId === routeStop.stop;
  return stop.stopId === routeStop.stopId;
}

function findCurrentStopIndex() {
  if (preferNearestAnchor()) {
    const closest = findClosestStopIndex(getUserPosition());
    if (closest >= 0) return closest;
  }
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

async function applyNearestAnchorView({ loadEtas = false } = {}) {
  if (!preferNearestAnchor() || !routeStops.length) return;
  const currentIdx = findCurrentStopIndex();
  const closestIdx = findClosestStopIndex(getUserPosition());
  const configured = routeStops[currentIdx];
  if (configured) {
    expandedStops.clear();
    expandedStops.add(stopKey(configured));
  }
  updateMap({ currentIdx, closestIdx });
  renderStops({ currentIdx, closestIdx });
  updateBusLocationMarkers();
  if (!loadEtas || !configured) return;
  const key = stopKey(configured);
  if (stopEtas.has(key)) return;
  const etas = await fetchStopEtas(configured);
  stopEtas.set(key, etas);
  renderStops({ currentIdx, closestIdx });
  updateBusLocationMarkers();
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
  const dialog = document.getElementById('bus-timetable-dialog');
  if (!btn || !dialog) return;
  if (btn.dataset.bound) return;
  btn.dataset.bound = '1';
  btn.hidden = true;

  const closeDialog = () => {
    if (dialog.open) dialog.close();
  };

  btn.addEventListener('click', async () => {
    await ensureHeadwayFeatures();
    if (dialog.open) {
      closeDialog();
      return;
    }
    renderTimetablePanel();
    dialog.showModal();
    focusCurrentTimetableRow();
    timetableVisible = true;
    btn.setAttribute('aria-expanded', 'true');
  });

  dialog.addEventListener('close', () => {
    timetableVisible = false;
    btn.setAttribute('aria-expanded', 'false');
  });

  dialog.addEventListener('toggle', () => {
    if (dialog.open) focusCurrentTimetableRow();
  });

  dialog.addEventListener('click', (event) => {
    if (event.target === dialog) closeDialog();
  });

  dialog.querySelectorAll('[data-timetable-close]').forEach((el) => {
    el.addEventListener('click', closeDialog);
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

function isServiceInCalendarRange(service, date) {
  if (!service) return false;
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  const dateKey = `${y}${m}${d}`;
  return dateKey >= service.startDate && dateKey <= service.endDate;
}

function hasWeekdayService(service) {
  return service.monday || service.tuesday || service.wednesday || service.thursday || service.friday;
}

const TIMETABLE_SECTION_DEFS = [
  { id: 'weekday', label: '平日' },
  { id: 'saturday', label: '土曜' },
  { id: 'sundayHoliday', label: '日曜・祝日' },
];

function serviceBelongsToSection(service, sectionId) {
  if (!service) return false;
  const weekday = hasWeekdayService(service);
  const sat = service.saturday;
  const sun = service.sunday;
  switch (sectionId) {
    case 'weekday':
      return weekday;
    case 'saturday':
      return sat && !sun;
    case 'sundayHoliday':
      return sun && !weekday;
    default:
      return false;
  }
}

function dedupeFrequencyRows(rows) {
  const seen = new Set();
  return rows.filter((row) => {
    const key = `${row.startTime}|${row.endTime}|${row.headwaySecs}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).sort((a, b) => a.startTime.localeCompare(b.startTime));
}

function isServiceActiveOnDate(service, date = new Date()) {
  if (!service) return false;
  const dayKeys = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  return Boolean(service[dayKeys[date.getDay()]]);
}

function serviceGroupLabel(service) {
  if (!service) return '';
  if (service.monday && service.tuesday && service.wednesday && service.thursday && service.friday
    && !service.saturday && !service.sunday) {
    return '';
  }
  if (service.monday && service.tuesday && service.wednesday && service.thursday
    && !service.friday && !service.saturday && !service.sunday) {
    return '月〜木曜';
  }
  if (service.friday && !service.monday && !service.tuesday && !service.wednesday && !service.thursday
    && !service.saturday && !service.sunday) {
    return '金曜';
  }
  if (service.saturday && !service.sunday && !hasWeekdayService(service)) return '';
  if (service.sunday && !service.saturday && !hasWeekdayService(service)) return '';
  const specs = [
    ['monday', '月'], ['tuesday', '火'], ['wednesday', '水'], ['thursday', '木'],
    ['friday', '金'], ['saturday', '土'], ['sunday', '日'],
  ];
  return specs.filter(([key]) => service[key]).map(([, label]) => label).join('・');
}

function timetableGroupsForSection(variant, sectionId) {
  const groups = [];
  const today = new Date();
  for (const serviceId of variant.serviceIds ?? []) {
    const service = variant.calendar?.[serviceId];
    if (!serviceBelongsToSection(service, sectionId)) continue;
    if (!isServiceInCalendarRange(service, today)) continue;
    const rows = dedupeFrequencyRows(variant.timetableByServiceId?.[serviceId] ?? []);
    if (!rows.length) continue;
    groups.push({ serviceId, service, label: serviceGroupLabel(service), rows });
  }
  return groups;
}

function timetableSections(variant) {
  if (!variant) return [];
  if (variant.timetableKind === 'departure') {
    const rows = variant.rows ?? [];
    if (!rows.length) return [];
    return [{ id: 'today', label: timetableDayLabel(), groups: [{ label: '', rows }] }];
  }
  return TIMETABLE_SECTION_DEFS
    .map(({ id, label }) => {
      const groups = timetableGroupsForSection(variant, id);
      if (!groups.length) return null;
      return { id, label, groups };
    })
    .filter(Boolean);
}

function gtfsTimeToMinutes(value) {
  const parts = String(value).split(':');
  const hh = parseInt(parts[0], 10) || 0;
  const mm = parseInt(parts[1], 10) || 0;
  const ss = parseInt(parts[2], 10) || 0;
  return hh * 60 + mm + ss / 60;
}

function nowAsGtfsMinutes(date = new Date()) {
  let mins = date.getHours() * 60 + date.getMinutes() + date.getSeconds() / 60;
  if (date.getHours() < 4) mins += 24 * 60;
  return mins;
}

function currentTimetableSectionId(date = new Date()) {
  const day = date.getDay();
  if (day === 6) return 'saturday';
  if (day === 0) return 'sundayHoliday';
  return 'weekday';
}

function isCurrentHeadwayRow(row, nowGtfs = nowAsGtfsMinutes()) {
  const start = gtfsTimeToMinutes(row.startTime);
  const end = gtfsTimeToMinutes(row.endTime);
  if (end > start) return nowGtfs >= start && nowGtfs < end;
  return nowGtfs >= start || nowGtfs < end;
}

function isCurrentDepartureRow(row, rows, nowGtfs = nowAsGtfsMinutes()) {
  const times = rows.map((r) => gtfsTimeToMinutes(r.time)).sort((a, b) => a - b);
  const current = gtfsTimeToMinutes(row.time);
  const idx = times.indexOf(current);
  const next = times[idx + 1];
  if (next == null) return nowGtfs >= current;
  return nowGtfs >= current && nowGtfs < next;
}

function isCurrentTimetableRow(row, { sectionId, activeSection, rows, service, today = new Date() }) {
  if (sectionId !== activeSection && sectionId !== 'today') return false;
  if (service && !isServiceActiveOnDate(service, today)) return false;
  if (row.kind === 'departure') return isCurrentDepartureRow(row, rows);
  return isCurrentHeadwayRow(row);
}

function renderTimetableRow(row, context) {
  const isCurrent = isCurrentTimetableRow(row, context);
  const cls = isCurrent ? ' bus-timetable-row--current' : '';
  if (row.kind === 'departure') {
    return `<div class="bus-timetable-row${cls}"><span class="bus-timetable-range">${formatScheduleTime(row.time)}</span></div>`;
  }
  const minutes = Math.round(row.headwaySecs / 60);
  return `<div class="bus-timetable-row${cls}">
    <span class="bus-timetable-range">${formatScheduleTime(row.startTime)} - ${formatScheduleTime(row.endTime)}</span>
    <span class="bus-timetable-headway">${minutes}分鐘</span>
  </div>`;
}

function renderTimetableSectionsHtml(sections) {
  const activeSection = currentTimetableSectionId();
  const today = new Date();
  return sections.map((section) => {
    const showSubgroupLabels = section.groups.length > 1 || section.groups.some((group) => group.label);
    return `
    <section class="bus-timetable-section">
      ${section.label ? `<h3 class="bus-timetable-section-title">${escapeHtml(section.label)}</h3>` : ''}
      ${section.groups.map((group) => `
        ${showSubgroupLabels && group.label ? `<h4 class="bus-timetable-subsection-title">${escapeHtml(group.label)}</h4>` : ''}
        <div class="bus-timetable-list">${group.rows.map((row) => renderTimetableRow(row, {
      sectionId: section.id,
      activeSection,
      rows: group.rows,
      service: group.service,
      today,
    })).join('')}</div>
      `).join('')}
    </section>`;
  }).join('');
}

function scrollCurrentTimetableRowIntoView(body) {
  const row = body?.querySelector('.bus-timetable-row--current');
  if (!row || !body) return;

  const scroll = () => {
    const bodyRect = body.getBoundingClientRect();
    const rowRect = row.getBoundingClientRect();
    const nextTop = body.scrollTop + (rowRect.top - bodyRect.top) - (body.clientHeight - row.offsetHeight) / 2;
    body.scrollTop = Math.max(0, nextTop);
  };

  requestAnimationFrame(() => {
    requestAnimationFrame(scroll);
  });
}

function focusCurrentTimetableRow() {
  const body = document.getElementById('bus-timetable-body');
  if (!body) return;
  scrollCurrentTimetableRowIntoView(body);
}

function formatScheduleTime(value) {
  const [hh = '00', mm = '00'] = String(value).split(':');
  const totalHours = parseInt(hh, 10);
  const hours = String(totalHours % 24).padStart(2, '0');
  return `${hours}${mm}`;
}

function timetableDayLabel() {
  const day = new Date().getDay();
  if (day === 6) return '土曜';
  if (day === 0) return '日祝';
  return '平日';
}

function variantHasTimetableData(variant) {
  if (variant?.timetableKind === 'departure') {
    return Boolean(variant.hasTimetable || variant.rows?.length);
  }
  if (!variant?.timetableByServiceId) return false;
  return Object.values(variant.timetableByServiceId).some((rows) => Array.isArray(rows) && rows.length > 0);
}

function renderTimetablePanel() {
  const dialog = document.getElementById('bus-timetable-dialog');
  const subtitle = document.getElementById('bus-timetable-subtitle');
  const body = document.getElementById('bus-timetable-body');
  const button = document.getElementById('timetable-btn');
  if (!dialog || !subtitle || !body || !button) return;

  const hasRouteTimetable = variantHasTimetableData(matchedHeadwayVariant);
  const sections = hasRouteTimetable ? timetableSections(matchedHeadwayVariant) : [];
  if (!hasRouteTimetable) {
    timetableVisible = false;
    if (dialog.open) dialog.close();
  }
  button.hidden = !hasRouteTimetable;
  button.textContent = '時刻表';
  button.setAttribute('aria-expanded', String(dialog.open));
  timetableVisible = dialog.open;
  if (!hasRouteTimetable) return;

  const routeName = matchedHeadwayVariant?.routeLongName ?? '';
  subtitle.textContent = routeName;
  subtitle.hidden = !routeName;

  if (!sections.length) {
    body.innerHTML = '<div class="bus-stop-empty">時刻表データがありません</div>';
    return;
  }
  body.innerHTML = renderTimetableSectionsHtml(sections);
  if (dialog.open) focusCurrentTimetableRow();
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
    let href = `bus.html?${params}`;
    if (back) href += `&back=${encodeURIComponent(back)}`;
    if (preferNearestAnchor()) href += '&nearest=1';
    window.location.href = href;
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
  const container = document.getElementById('bus-map');
  map = L.map(container, {
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

  const syncMapSize = () => map?.invalidateSize();
  window.addEventListener('resize', syncMapSize);
  if (window.ResizeObserver && container) {
    new ResizeObserver(syncMapSize).observe(container);
  }
}

function userLocationIcon() {
  return L.divIcon({
    className: 'bus-user-marker-wrap',
    html: '<span class="bus-user-marker"></span>',
    iconSize: [16, 16],
    iconAnchor: [8, 8],
  });
}

function setUserMapMarker(pos) {
  if (!map || !pos) return;
  const { latitude, longitude } = pos.coords;
  if (!isValidCoord(latitude, longitude)) return;
  const latlng = [latitude, longitude];
  if (userMarker) {
    userMarker.setLatLng(latlng);
  } else {
    userMarker = L.marker(latlng, { icon: userLocationIcon(), zIndexOffset: 1000 }).addTo(map);
  }
}

function panToUserLocation(pos) {
  if (!map || !pos) return false;
  const { latitude, longitude } = pos.coords;
  if (!isValidCoord(latitude, longitude)) return false;
  map.setView([latitude, longitude], STOP_MAP_ZOOM, { animate: true });
  setUserMapMarker(pos);
  return true;
}

function syncLocateButton(visible) {
  const btn = document.getElementById('bus-locate-btn');
  if (!btn) return;
  btn.hidden = !visible || !!geolocationBlockReason();
}

function bindLocateButton() {
  const btn = document.getElementById('bus-locate-btn');
  if (!btn || btn.dataset.bound) return;
  btn.dataset.bound = '1';
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    try {
      const pos = await requestUserPosition();
      panToUserLocation(pos ?? getUserPosition());
    } finally {
      btn.disabled = false;
    }
  });
}

function isValidCoord(lat, lng) {
  return Number.isFinite(lat) && Number.isFinite(lng);
}

function closeAllMarkerTooltips() {
  markers.forEach((marker) => marker.closeTooltip());
}

function syncExpandedMarkerTooltip() {
  closeAllMarkerTooltips();
  const key = [...expandedStops][0];
  if (key) markers.get(key)?.openTooltip();
}

function formatBusArrivalLocation(eta) {
  if (eta.busAwaitingDepart || eta.remark === '発車待ち') {
    return { show: true, location: '発車待ち', stopsLeft: null };
  }
  if (!eta.busStopName) return { show: false, location: null, stopsLeft: null };
  const stopsLeft = eta.busStopsLeft != null && eta.busStopsLeft > 0 ? eta.busStopsLeft : null;
  return { show: true, location: `${eta.busStopName}へ到着`, stopsLeft };
}

function formatBusArrivalLabel(eta) {
  const { location, stopsLeft } = formatBusArrivalLocation(eta);
  if (!location) return '走行中';
  if (stopsLeft == null) return location;
  return `${location} · ${stopsLeft}駅`;
}

function busLocationIcon(etaClass, index) {
  return L.divIcon({
    className: 'bus-vehicle-marker-wrap',
    html: `<span class="bus-vehicle-marker ${etaClass}" aria-label="バス${index + 1}">
      <svg class="bus-vehicle-icon" viewBox="0 0 24 24" aria-hidden="true">
        <path d="M4 16c0 .88.39 1.67 1 2.22V20c0 .55.45 1 1 1h1c.55 0 1-.45 1-1v-1h8v1c0 .55.45 1 1 1h1c.55 0 1-.45 1-1v-1.78c.61-.55 1-1.34 1-2.22V6c0-2.21-1.79-4-4-4H8C5.79 2 4 3.79 4 6v10zm2-10h12v9H6V6z"/>
        <circle cx="7.5" cy="16.5" r="1.4"/>
        <circle cx="16.5" cy="16.5" r="1.4"/>
      </svg>
      <span class="bus-vehicle-num">${index + 1}</span>
    </span>`,
    iconSize: [30, 30],
    iconAnchor: [15, 15],
  });
}

function clearBusLocationMarkers() {
  busMarkersLayer?.remove();
  busApproachLayer?.remove();
  busMarkersLayer = null;
  busApproachLayer = null;
}

function updateBusLocationMarkers() {
  if (!map) return;
  clearBusLocationMarkers();

  const expandedKey = [...expandedStops][0];
  if (!expandedKey) return;

  const targetStop = routeStops.find((stop) => stopKey(stop) === expandedKey);
  const etas = stopEtas.get(expandedKey) ?? [];
  if (!targetStop || !etas.length) return;

  busMarkersLayer = L.layerGroup().addTo(map);
  busApproachLayer = L.layerGroup().addTo(map);

  etas.forEach((eta, index) => {
    if (!isValidCoord(eta.busLat, eta.busLng)) return;
    if (!isValidCoord(targetStop.lat, targetStop.lng)) return;

    L.polyline(
      [[eta.busLat, eta.busLng], [targetStop.lat, targetStop.lng]],
      {
        color: index === 0 ? '#ffb020' : '#6b8cff',
        weight: 2,
        opacity: 0.75,
        dashArray: '6 6',
      },
    ).addTo(busApproachLayer);

    const label = formatBusArrivalLabel(eta);
    L.marker([eta.busLat, eta.busLng], {
      icon: busLocationIcon(eta.etaClass, index),
      zIndexOffset: 800 + index,
    })
      .bindTooltip(escapeHtml(label), {
        direction: 'top',
        opacity: 0.9,
        offset: [0, -18],
        className: 'bus-stop-tooltip',
      })
      .addTo(busMarkersLayer);
  });
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
    syncLocateButton(false);
    return;
  }

  map.getContainer().style.display = '';
  syncLocateButton(true);

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
      .bindTooltip(escapeHtml(stop.name), {
        direction: 'top',
        opacity: 0.9,
        offset: [0, -26],
        className: 'bus-stop-tooltip',
      })
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

  syncExpandedMarkerTooltip();
}

function formatEtaMinsLabel(eta) {
  const diffMins = (eta.etaTime - Date.now()) / 60000;
  if (diffMins > 0) return `${Math.round(diffMins)}分`;
  if (diffMins <= -1) return '遅刻';
  return '到着';
}

function renderEtaList(etas, { loading = false } = {}) {
  if (loading) {
    return '<div class="bus-stop-empty">読み込み中…</div>';
  }
  if (!etas.length) {
    return '<div class="bus-stop-empty">情報なし</div>';
  }
  return etas.map((eta) => {
    const arrival = formatBusArrivalLocation(eta);
    return `
    <div class="bus-eta-item ${eta.etaClass}">
      <span class="bus-eta-mins">${formatEtaMinsLabel(eta)}</span>
      ${eta.remark ? `<span class="bus-eta-remark">${escapeHtml(eta.remark)}</span>` : ''}
      ${arrival.show ? `<span class="bus-eta-location">${escapeHtml(arrival.location ?? '走行中')}</span>` : ''}
      ${arrival.stopsLeft != null ? `<span class="bus-eta-stops-left" title="あと${arrival.stopsLeft}駅">${arrival.stopsLeft}駅</span>` : ''}
      <span class="bus-eta-time">${escapeHtml(eta.time)}</span>
    </div>`;
  }).join('');
}

function findStopSection(key) {
  const container = document.getElementById('bus-stops');
  if (!container) return null;
  return [...container.querySelectorAll('.bus-stop')].find((section) => section.dataset.stopKey === key) ?? null;
}

function syncBusStopOpen(section, isOpen) {
  if (!section) return;
  section.classList.toggle('open', isOpen);
  const header = section.querySelector('.bus-stop-header');
  if (header) header.setAttribute('aria-expanded', String(isOpen));
  const inner = section.querySelector('.bus-stop-body-inner');
  if (inner) {
    inner.toggleAttribute('inert', !isOpen);
    inner.setAttribute('aria-hidden', String(!isOpen));
    if (!isOpen) scheduleBusStopBodyClear(section);
  }
}

function scheduleBusStopBodyClear(section) {
  const panel = section.querySelector('.bus-stop-body');
  const inner = section.querySelector('.bus-stop-body-inner');
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
    if (!section.classList.contains('open')) inner.replaceChildren();
  };
  panel.addEventListener('transitionend', onEnd);
}

function updateStopEtaBody(section, etas) {
  const inner = section?.querySelector('.bus-stop-body-inner');
  if (inner) inner.innerHTML = renderEtaList(etas);
}

function formatFare(value) {
  const amount = parseFloat(String(value));
  if (!Number.isFinite(amount)) return '';
  return Number.isInteger(amount) ? `$${amount}` : `$${amount.toFixed(1)}`;
}

function stopFareLabel(stop) {
  if (!stop.fare && !stop.fareHoliday) return '';
  const weekday = stop.fare ? formatFare(stop.fare) : '';
  if (stop.fareHoliday && stop.fareHoliday !== stop.fare) {
    const holiday = formatFare(stop.fareHoliday);
    return weekday ? `${weekday} / 假日 ${holiday}` : `假日 ${holiday}`;
  }
  return weekday;
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
    const etas = stopEtas.get(key);
    const etaLoading = expanded && !stopEtas.has(key);
    const rowClass = [
      'bus-stop',
      isCurrent ? 'bus-stop-current' : '',
      isClosest ? 'bus-stop-closest' : '',
      isNext && !isClosest ? 'bus-stop-next' : '',
    ].filter(Boolean).join(' ');

    const badges = [];
    if (isCurrent) badges.push('<span class="bus-stop-badge bus-stop-badge-current">現在</span>');
    if (isClosest) badges.push('<span class="bus-stop-badge bus-stop-badge-closest">最寄り</span>');
    else if (isNext) badges.push('<span class="bus-stop-badge bus-stop-badge-next">つぎは</span>');

    const markerClass = isCurrent
      ? 'bus-stop-num-current'
      : (isClosest ? 'bus-stop-num-closest' : (isNext ? 'bus-stop-num-next' : ''));
    const fareLabel = stopFareLabel(stop);

    return `
      <section class="${rowClass}" data-stop-key="${escapeAttr(key)}" data-index="${index}">
        <button class="bus-stop-header" type="button" aria-expanded="${expanded}">
          <span class="bus-stop-num ${markerClass}">${stop.seq}</span>
          <span class="bus-stop-info">
            ${badges.length ? `<span class="bus-stop-badges">${badges.join('')}</span>` : ''}
            <span class="bus-stop-title-row">
              <span class="bus-stop-name">${escapeHtml(stop.name)}</span>
              ${fareLabel ? `<span class="bus-stop-fare">${escapeHtml(fareLabel)}</span>` : ''}
            </span>
          </span>
          <svg class="bus-stop-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
            <polyline points="6 9 12 15 18 9"/>
          </svg>
        </button>
        <div class="bus-stop-body">
          <div class="bus-stop-body-inner">
            ${renderEtaList(etas ?? [], { loading: etaLoading })}
          </div>
        </div>
      </section>`;
  }).join('');

  container.querySelectorAll('.bus-stop').forEach((section) => {
    syncBusStopOpen(section, expandedStops.has(section.dataset.stopKey));
  });
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
    const etas = await fetchEtas(rs);
    return enrichEtasWithBusLocation(etas, rs, stop, routeStops);
  } catch {
    return [];
  }
}

async function toggleStop(stop, forceOpen = false) {
  const key = stopKey(stop);
  const opening = forceOpen || !expandedStops.has(key);

  if (opening) {
    document.querySelectorAll('.bus-stop.open').forEach((section) => {
      syncBusStopOpen(section, false);
    });
    expandedStops.clear();
    expandedStops.add(key);
    renderStops({
      currentIdx: findCurrentStopIndex(),
      closestIdx: findClosestStopIndex(getUserPosition()),
    });

    const etas = await fetchStopEtas(stop);
    stopEtas.set(key, etas);

    const section = findStopSection(key);
    updateStopEtaBody(section, etas);
    syncBusStopOpen(section, true);

    const marker = markers.get(key);
    if (marker && stop.lat != null && stop.lng != null) {
      map?.setView([stop.lat, stop.lng], STOP_MAP_ZOOM, { animate: true });
      syncExpandedMarkerTooltip();
    }
  } else {
    expandedStops.delete(key);
    syncBusStopOpen(findStopSection(key), false);
    markers.get(key)?.closeTooltip();
    clearBusLocationMarkers();
  }

  updateBusLocationMarkers();
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

  clearRouteWideEtaCache();
  lastRefresh = new Date();
  const userPos = getUserPosition();
  renderStops({
    currentIdx: findCurrentStopIndex(),
    closestIdx: findClosestStopIndex(userPos),
  });
  updateBusLocationMarkers();
}

function startRefreshTimer() {
  if (refreshTimerId) clearInterval(refreshTimerId);
  refreshTimerId = setInterval(() => {
    if (document.hidden) return;
    refresh({ silent: true });
  }, REFRESH_INTERVAL_MS);
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
    updateStopEtaBody(section, etas);
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

  const titleHint = routeTitleHint(routeStop);
  if (titleHint) document.getElementById('bus-title').textContent = titleHint;

  initMap();
  bindLocateButton();
  window.addEventListener('userposition', (event) => {
    setUserMapMarker(/** @type {CustomEvent<GeolocationPosition>} */ (event).detail);
    void applyNearestAnchorView({ loadEtas: true });
  });

  void initFlipBoundButton();

  try {
    if (preferNearestAnchor()) {
      await bootstrapLocation();
    }
    routeStops = await fetchRouteStops(routeStop);
    const title = routeTitleHint(routeStop) || await routeTitle(routeStop, routeStops);
    document.getElementById('bus-title').textContent = title;

    const currentIdx = findCurrentStopIndex();
    const closestIdx = findClosestStopIndex(getUserPosition());
    updateMap({ currentIdx, closestIdx });

    const configured = routeStops[currentIdx];
    if (configured) expandedStops.add(stopKey(configured));

    renderStops({ currentIdx, closestIdx });
    updateBusLocationMarkers();
    lastRefresh = new Date();
    scheduleHeadwayFeatures();

    requestAnimationFrame(() => {
      map?.invalidateSize();
      updateMap({ currentIdx, closestIdx });
      updateBusLocationMarkers();
      document.querySelector('.bus-stop-current')?.scrollIntoView({ block: 'center' });
    });

    startRefreshTimer();
    setInterval(updateRefreshTimer, 1000);
    setInterval(updateLiveMinutes, 15_000);
    updateRefreshTimer();

    if (configured) {
      void (async () => {
        const etas = await fetchStopEtas(configured);
        stopEtas.set(stopKey(configured), etas);
        renderStops({ currentIdx, closestIdx });
        updateBusLocationMarkers();
        const refinedTitle = await routeTitle(routeStop, routeStops);
        if (refinedTitle) document.getElementById('bus-title').textContent = refinedTitle;
      })();
    }

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
        updateBusLocationMarkers();
      } finally {
        btn.classList.remove('spinning');
      }
    });
  } catch (err) {
    if (!titleHint) document.getElementById('bus-title').textContent = '読み込みエラー';
    document.getElementById('bus-stops').innerHTML = `<div class="error-msg">${escapeHtml(err.message)}</div>`;
  }
}

init();
