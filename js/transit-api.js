/** @typedef {{ type: string, [key: string]: unknown }} RouteStopConfig */
/** @typedef {{ seq: number, stopId: string, name: string, lat: number | null, lng: number | null, fare?: string, fareHoliday?: string | null }} RouteStopInfo */
/** @typedef {{ routeId: string, operator: string, express: { text: string, cls: string }, routeClass: string, time: string, dest: string, mins: number, remark: string, etaClass: string, etaTime: Date, etaSeq?: number, busLat?: number | null, busLng?: number | null, busStopSeq?: number | null, busStopName?: string | null, busStopsLeft?: number | null, busAwaitingDepart?: boolean, routeStop?: RouteStopConfig }} EtaRow */
/** @typedef {{ seq: number, eta_seq: number, eta: string, dir?: string }} RouteWideEtaRow */

import { distanceM } from './location.js';
import {
  formatLocaleTime,
  isAwaitingDepartRemark,
  isEnglish,
  pickLocalized,
  t,
} from './locale.js';
import {
  attachFaresToRouteStops,
  buildRouteStopsFromFareStopIds,
  ensureRouteFareDb,
  findCtbRouteEntry,
  findKmbRouteEntry,
  findLrtfeederRouteEntry,
  getFareStop,
  getGmbRouteDest,
} from './route-fare-db.js';

const MTR_DEST = {
  FT: { zh: '富泰', en: 'Fu Tai' },
  TL: { zh: '大欖', en: 'Tai Lam' },
  SKWT: { zh: '掃管笏', en: 'So Kwun Wat' },
  SKW_CIR: { zh: '掃管笏', en: 'So Kwun Wat' },
};

export const SOCIF_GEO = {
  '281-1-1': { lat: 22.373628, lng: 113.991213 },
};

export const MTR_GEO = {
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

/** @type {Map<string, { rows: RouteWideEtaRow[], fetchedAt: number }>} */
const routeWideEtaCache = new Map();
/** @type {Map<string, Promise<RouteWideEtaRow[]>>} */
const routeWideEtaInflight = new Map();
const ROUTE_WIDE_ETA_TTL_MS = 30_000;
const EMPTY_ROUTE_WIDE_ETA_TTL_MS = 5 * 60_000;
const MTR_SCHEDULE_TTL_MS = 60_000;
const SOCIF_ROUTE_ETA_TTL_MS = 30_000;
/** @type {Map<string, { stops: object[], fetchedAt: number }>} */
const mtrCache = new Map();
/** @type {Map<string, string>} */
const gmbDestCache = new Map();
/** @type {Map<string, { data: unknown, fetchedAt: number }>} */
const socifRouteEtaCache = new Map();
/** @type {Map<string, { lat: number, lng: number, name: string }>} */
const stopDetailCache = new Map();
/** @type {Map<string, any>} */
const socifRouteCache = new Map();
/** @type {Map<string, any[]>} */
const socifWeekdayScheduleCache = new Map();

export function operatorClass(op) {
  return { kmb: 'color-kmb', mtr: 'color-mtr', gmb: 'color-gmb', nwfb: 'color-nwfb', socif: 'color-socif' }[op] ?? '';
}

function isAirport(routeId) {
  return routeId.startsWith('A');
}

export function expressInfo(routeId, operator) {
  if (isAirport(routeId)) return { text: t('express.airport'), cls: 'bg-airport' };
  if (operator === 'kmb') {
    return routeId.includes('X')
      ? { text: t('express.express'), cls: 'bg-kmb-express' }
      : { text: t('express.local'), cls: 'bg-kmb-local' };
  }
  if (operator === 'mtr') return { text: t('express.local'), cls: 'bg-mtr' };
  if (operator === 'gmb') return { text: t('express.semiExpress'), cls: 'bg-gmb' };
  if (operator === 'socif') return { text: t('express.shuttle'), cls: 'bg-socif' };
  return { text: t('express.normal'), cls: 'bg-nwfb' };
}

export function translateRemark(operator, raw, isScheduled) {
  if (operator === 'kmb') {
    if (raw === '原定班次') return t('remark.scheduled');
    return raw;
  }
  if (operator === 'gmb' || operator === 'socif') {
    if (raw === '未開出') return t('remark.awaitingDepart');
    return raw ?? '';
  }
  if (operator === 'mtr') {
    if (raw === '受交通擠塞影響，到站時間可能稍為延遲') {
      return t('remark.trafficDelay');
    }
    if (isScheduled && !raw) return t('remark.scheduled');
    return raw ?? '';
  }
  return raw ?? '';
}

export function etaColorClass(isScheduled, remark) {
  if (isScheduled) return 'eta-scheduled';
  if (remark) return 'eta-error';
  return 'eta-normal';
}

export function formatTime(date) {
  return formatLocaleTime(date);
}

export function mtrRouteFromStopId(stopId) {
  return stopId.split('-')[0];
}

function mtrDestFromLineRef(lineRef) {
  const suffix = lineRef.split('_').slice(1).join('_');
  const entry = MTR_DEST[suffix];
  if (entry) return pickLocalized(entry.zh, entry.en);
  return suffix;
}

async function fetchMtrSchedule(route) {
  const cached = mtrCache.get(route);
  if (cached && Date.now() - cached.fetchedAt < MTR_SCHEDULE_TTL_MS) {
    return cached.stops;
  }
  const res = await fetch('https://rt.data.gov.hk/v1/transport/mtr/bus/getSchedule', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ language: isEnglish() ? 'en' : 'zh', routeName: route }),
  });
  const json = await res.json();
  const stops = json.busStop ?? [];
  mtrCache.set(route, { stops, fetchedAt: Date.now() });
  return stops;
}

export function clearRouteWideEtaCache() {
  routeWideEtaCache.clear();
}

async function gmbDestination(realRouteId, routeSeq) {
  const key = `${realRouteId}-${routeSeq}`;
  if (gmbDestCache.has(key)) return gmbDestCache.get(key);
  const dest = getGmbRouteDest(realRouteId, routeSeq);
  gmbDestCache.set(key, dest);
  return dest;
}

async function fetchSocifRouteEtaData(route, routeSeq) {
  const key = `${route}:${routeSeq}`;
  const cached = socifRouteEtaCache.get(key);
  if (cached && Date.now() - cached.fetchedAt < SOCIF_ROUTE_ETA_TTL_MS) {
    return cached.data;
  }
  const res = await fetch(`https://360-api.socif.co/api/eta/route-stop/${route}/${routeSeq}`);
  const json = await res.json();
  const data = json.data ?? {};
  socifRouteEtaCache.set(key, { data, fetchedAt: Date.now() });
  return data;
}

const KMB_STOP_CODE_SUFFIX = /\s*\([A-Z0-9]+\)\s*$/;

function stopNameFromFare(fareStop, stopId) {
  return formatKmbStopName(pickLocalized(fareStop?.name?.zh, fareStop?.name?.en) || stopId);
}

function formatKmbStopName(name) {
  return String(name ?? '').replace(KMB_STOP_CODE_SUFFIX, '').trim();
}

async function fetchKmbStop(stopId) {
  const cached = stopDetailCache.get(`kmb:${stopId}`);
  if (cached) return cached;
  const res = await fetch(`https://data.etabus.gov.hk/v1/transport/kmb/stop/${stopId}`);
  const json = await res.json();
  const d = json.data;
  const info = {
    lat: parseFloat(d.lat),
    lng: parseFloat(d.long),
    name: pickLocalized(formatKmbStopName(d.name_tc), formatKmbStopName(d.name_en)),
  };
  stopDetailCache.set(`kmb:${stopId}`, info);
  return info;
}

async function fetchNwfbStop(stopId) {
  const cached = stopDetailCache.get(`nwfb:${stopId}`);
  if (cached) return cached;
  const res = await fetch(`https://rt.data.gov.hk/v1.1/transport/citybus-nwfb/stop/${stopId}`);
  const json = await res.json();
  const d = json.data;
  const info = {
    lat: parseFloat(d.lat),
    lng: parseFloat(d.long),
    name: pickLocalized(d.name_tc, d.name_en),
  };
  stopDetailCache.set(`nwfb:${stopId}`, info);
  return info;
}

async function fetchGmbStop(stopId) {
  const cached = stopDetailCache.get(`gmb:${stopId}`);
  if (cached) return cached;
  const res = await fetch(`https://data.etagmb.gov.hk/stop/${stopId}`);
  const json = await res.json();
  const d = json.data.coordinates.wgs84;
  const info = {
    lat: parseFloat(d.latitude),
    lng: parseFloat(d.longitude),
    name: pickLocalized(json.data.name_tc, json.data.name_en),
  };
  stopDetailCache.set(`gmb:${stopId}`, info);
  return info;
}

async function fetchSocifStop(stopId) {
  const cached = stopDetailCache.get(`socif:${stopId}`);
  if (cached) return cached;
  const res = await fetch(`https://360-api.socif.co/api/stop/${stopId}`);
  const json = await res.json();
  const d = json.data.coordinates.wgs84;
  const info = {
    lat: parseFloat(d.latitude),
    lng: parseFloat(d.longitude),
    name: json.data.name_tc,
  };
  stopDetailCache.set(`socif:${stopId}`, info);
  return info;
}

export async function fetchSocifRoute(routeId) {
  const key = String(routeId);
  if (socifRouteCache.has(key)) return socifRouteCache.get(key);
  const res = await fetch(`https://360-api.socif.co/api/route/${routeId}`);
  const json = await res.json();
  const route = json.data?.[0] ?? null;
  socifRouteCache.set(key, route);
  return route;
}

/** @param {number | string} routeId @param {number} routeSeq */
export async function getSocifDirection(routeId, routeSeq) {
  const routeData = await fetchSocifRoute(routeId);
  return routeData?.directions?.find((d) => d.route_seq === routeSeq) ?? null;
}

/** @param {{ dest_tc?: string, dest_en?: string } | null | undefined} direction @param {string} [fallback] */
export function socifDestFromDirection(direction, fallback = '') {
  if (!direction) return fallback;
  return pickLocalized(direction.dest_tc, direction.dest_en) || fallback;
}

export async function fetchSocifWeekdaySchedule(routeId, weekdayIndex) {
  const key = `${routeId}:${weekdayIndex}`;
  if (socifWeekdayScheduleCache.has(key)) return socifWeekdayScheduleCache.get(key);
  const res = await fetch(`https://360-api.socif.co/api/weekdaySchedule/${routeId}/${weekdayIndex}`);
  const json = await res.json();
  const schedules = json.data ?? [];
  socifWeekdayScheduleCache.set(key, schedules);
  return schedules;
}

/** @param {string} stopId */
export async function getMtrStopGeo(stopId) {
  await ensureRouteFareDb();
  const stop = getFareStop(stopId);
  if (stop?.location) return { lat: stop.location.lat, lng: stop.location.lng };
  return MTR_GEO[stopId] ?? null;
}

function isNotDepartedRemark(remark) {
  return isAwaitingDepartRemark(remark);
}

function findNearestRouteStop(routeStops, lat, lng) {
  let best = null;
  let bestDist = Infinity;
  const point = { lat, lng };
  for (const stop of routeStops) {
    if (!Number.isFinite(stop.lat) || !Number.isFinite(stop.lng)) continue;
    const dist = distanceM(point, { lat: stop.lat, lng: stop.lng });
    if (dist < bestDist) {
      bestDist = dist;
      best = stop;
    }
  }
  return best;
}

function routeOriginStop(routeStops) {
  const withCoords = routeStops.filter((stop) => Number.isFinite(stop.lat) && Number.isFinite(stop.lng));
  if (!withCoords.length) return null;
  return withCoords.reduce((best, stop) => (!best || stop.seq < best.seq ? stop : best));
}

/**
 * @param {RouteStopInfo[]} routeStops
 * @param {BusLocationEstimate} location
 * @param {number} etaMins
 * @param {RouteStopInfo} targetStop
 * @returns {BusLocationEstimate}
 */
function labelBusLocation(routeStops, location, etaMins, targetStop) {
  if (etaMins <= 1) {
    return {
      ...location,
      name: targetStop.name,
      awaitingDepart: false,
      stopSeq: targetStop.seq,
      stopsLeft: 0,
    };
  }
  const origin = routeOriginStop(routeStops);
  const upstream = routeStops.filter((stop) =>
    stop.seq <= targetStop.seq && Number.isFinite(stop.lat) && Number.isFinite(stop.lng));
  let workingLocation = location;
  const nearest = findNearestRouteStop(upstream, workingLocation.lat, workingLocation.lng);
  if (origin && nearest?.stopId === origin.stopId && etaMins > 2) {
    const fallback = estimateBackwardFromTarget(routeStops, targetStop, etaMins);
    if (fallback) workingLocation = fallback;
  }
  const nearestFinal = findNearestRouteStop(upstream, workingLocation.lat, workingLocation.lng);
  if (origin && nearestFinal?.stopId === origin.stopId) {
    if (etaMins > 2) {
      const stopsLeft = estimateStopsLeftFromEta(routeStops, targetStop, etaMins);
      if (stopsLeft != null && stopsLeft > 0) {
        const fallback = estimateBackwardFromTarget(routeStops, targetStop, etaMins);
        const nearestBack = fallback
          ? findNearestRouteStop(upstream, fallback.lat, fallback.lng)
          : nearestFinal;
        return {
          ...(fallback ?? workingLocation),
          name: nearestBack?.name ?? null,
          awaitingDepart: false,
          stopSeq: nearestBack?.seq ?? null,
          stopsLeft,
        };
      }
    }
    return {
      ...workingLocation,
      name: null,
      awaitingDepart: true,
      stopSeq: nearestFinal?.seq ?? null,
      stopsLeft: null,
    };
  }
  const stopsLeft = nearestFinal ? Math.max(0, targetStop.seq - nearestFinal.seq) : null;
  return {
    ...workingLocation,
    name: nearestFinal?.name ?? null,
    awaitingDepart: false,
    stopSeq: nearestFinal?.seq ?? null,
    stopsLeft,
  };
}

/** @param {unknown[]} rows */
function normalizeRouteWideEtas(rows) {
  /** @type {RouteWideEtaRow[]} */
  const out = [];
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const item = /** @type {Record<string, unknown>} */ (row);
    const eta = item.eta ?? item.timestamp;
    if (!eta) continue;
    const seq = parseInt(String(item.seq ?? item.stopSeq ?? ''), 10);
    const etaSeq = parseInt(String(item.eta_seq ?? ''), 10);
    if (!Number.isFinite(seq) || !Number.isFinite(etaSeq)) continue;
    out.push({
      seq,
      eta_seq: etaSeq,
      eta: String(eta),
      dir: item.dir ? String(item.dir) : undefined,
    });
  }
  return out;
}

/** @param {RouteStopConfig} routeStop */
function routeWideEtaCacheKey(routeStop) {
  if (routeStop.type === 'gmb') {
    return `gmb:${routeStop.realRouteId}:${routeStop.stopId}`;
  }
  if (routeStop.type === 'nwfb') {
    return `nwfb:${routeStop.route}:${routeStop.dir ?? 'O'}`;
  }
  return `${routeStop.type}:${JSON.stringify({
    route: routeStop.route ?? routeStop.routeId,
    routeSeq: routeStop.routeSeq,
    service_type: routeStop.service_type ?? 1,
  })}`;
}

function routeWideEtaCacheValid(cached) {
  const ttl = cached.rows.length ? ROUTE_WIDE_ETA_TTL_MS : EMPTY_ROUTE_WIDE_ETA_TTL_MS;
  return Date.now() - cached.fetchedAt < ttl;
}

/** @param {RouteStopConfig} routeStop @returns {Promise<RouteWideEtaRow[]>} */
async function loadRouteWideEtas(routeStop) {
  /** @type {RouteWideEtaRow[]} */
  let rows = [];
  switch (routeStop.type) {
    case 'kmb': {
      const serviceType = routeStop.service_type ?? 1;
      const res = await fetch(`https://data.etabus.gov.hk/v1/transport/kmb/route-eta/${routeStop.route}/${serviceType}`);
      const json = await res.json();
      rows = normalizeRouteWideEtas(json.data ?? []);
      break;
    }
    case 'nwfb': {
      const dir = routeStop.dir ?? null;
      for (const url of [
        `https://rt.data.gov.hk/v2/transport/citybus/eta/CTB/route/${routeStop.route}`,
        `https://rt.data.gov.hk/v1.1/transport/citybus-nwfb/eta/CTB/route/${routeStop.route}`,
      ]) {
        const res = await fetch(url);
        const json = await res.json();
        rows = normalizeRouteWideEtas(json.data ?? []);
        if (dir) rows = rows.filter((row) => !row.dir || row.dir === dir);
        if (rows.length) break;
      }
      break;
    }
    case 'socif': {
      const data = await fetchSocifRouteEtaData(routeStop.route, routeStop.routeSeq);
      const flat = [];
      for (const stop of data.eta ?? []) {
        for (const eta of stop.eta ?? []) {
          flat.push({ ...eta, stopSeq: stop.stopSeq });
        }
      }
      rows = normalizeRouteWideEtas(flat);
      break;
    }
    case 'gmb': {
      if (!routeStop.stopId) break;
      try {
        const res = await fetch(
          `https://data.etagmb.gov.hk/eta/route-stop/${routeStop.realRouteId}/${routeStop.stopId}`,
        );
        const json = await res.json();
        rows = normalizeRouteWideEtas((json.data ?? []).flatMap((entry) =>
          (entry.eta ?? [])
            .filter((e) => e.timestamp)
            .map((e) => ({ ...e, seq: entry.stop_seq })),
        ));
      } catch {
        rows = [];
      }
      break;
    }
    default:
      break;
  }

  return rows;
}

/** @param {RouteStopConfig} routeStop @returns {Promise<RouteWideEtaRow[]>} */
async function fetchRouteWideEtas(routeStop) {
  const cacheKey = routeWideEtaCacheKey(routeStop);
  const cached = routeWideEtaCache.get(cacheKey);
  if (cached && routeWideEtaCacheValid(cached)) {
    return cached.rows;
  }

  const inflight = routeWideEtaInflight.get(cacheKey);
  if (inflight) return inflight;

  const promise = loadRouteWideEtas(routeStop)
    .then((rows) => {
      routeWideEtaCache.set(cacheKey, { rows, fetchedAt: Date.now() });
      return rows;
    })
    .finally(() => {
      routeWideEtaInflight.delete(cacheKey);
    });
  routeWideEtaInflight.set(cacheKey, promise);
  return promise;
}

function interpolateCoords(a, b, t) {
  const ratio = Math.min(1, Math.max(0, t));
  return {
    lat: a.lat + (b.lat - a.lat) * ratio,
    lng: a.lng + (b.lng - a.lng) * ratio,
  };
}

/** @typedef {{ seq: number, etaTime: number, stop: RouteStopInfo }} EtaTimelinePoint */
/** @typedef {{ lat: number, lng: number, name: string | null, awaitingDepart?: boolean, stopSeq?: number | null, stopsLeft?: number | null }} BusLocationEstimate */

/**
 * @param {RouteWideEtaRow[]} routeWideEtas
 * @param {{ etaSeq: number, targetSeq: number, bound?: string | null, dir?: string | null, routeStops: RouteStopInfo[] }} options
 * @returns {EtaTimelinePoint[]}
 */
function buildEtaTimeline(routeWideEtas, { etaSeq, targetSeq, bound, dir, routeStops }) {
  const routeSeqSet = new Set(routeStops.map((stop) => stop.seq));
  return routeWideEtas
    .filter((row) => row.eta_seq === etaSeq && row.seq <= targetSeq && routeSeqSet.has(row.seq))
    .filter((row) => !bound || row.dir === bound)
    .filter((row) => !dir || row.dir === dir)
    .map((row) => ({
      seq: row.seq,
      etaTime: new Date(row.eta).getTime(),
      stop: routeStops.find((stop) => stop.seq === row.seq),
    }))
    .filter((item) => item.stop && Number.isFinite(item.stop.lat) && Number.isFinite(item.stop.lng))
    .sort((a, b) => a.seq - b.seq);
}

function segmentTravelMinutes(a, b) {
  const dist = distanceM(a, b);
  return Math.max(0.75, dist / 350);
}

/**
 * @param {RouteStopInfo[]} routeStops
 * @param {RouteStopInfo} targetStop
 * @param {number} etaMins
 * @returns {number | null}
 */
function estimateStopsLeftFromEta(routeStops, targetStop, etaMins) {
  if (etaMins <= 1) return 0;
  const stops = routeStops
    .filter((stop) => stop.seq <= targetStop.seq && Number.isFinite(stop.lat) && Number.isFinite(stop.lng))
    .sort((a, b) => a.seq - b.seq);
  const targetIdx = stops.findIndex((stop) => stop.stopId === targetStop.stopId);
  if (targetIdx < 0) return null;

  let remaining = etaMins;
  let idx = targetIdx;
  while (idx > 0 && remaining > 0) {
    const segmentMins = segmentTravelMinutes(stops[idx - 1], stops[idx]);
    if (remaining <= segmentMins) {
      return Math.max(0, targetStop.seq - stops[idx - 1].seq);
    }
    remaining -= segmentMins;
    idx -= 1;
  }
  return Math.max(0, targetStop.seq - stops[0].seq);
}

/**
 * @param {RouteStopInfo[]} routeStops
 * @param {RouteStopInfo} targetStop
 * @param {number} etaMins
 * @returns {BusLocationEstimate | null}
 */
function estimateBackwardFromTarget(routeStops, targetStop, etaMins) {
  const stops = routeStops
    .filter((stop) => stop.seq <= targetStop.seq && Number.isFinite(stop.lat) && Number.isFinite(stop.lng))
    .sort((a, b) => a.seq - b.seq);
  const targetIdx = stops.findIndex((stop) => stop.stopId === targetStop.stopId);
  if (targetIdx < 0) return null;
  if (etaMins <= 1) {
    return { lat: targetStop.lat, lng: targetStop.lng, name: targetStop.name };
  }

  let remaining = etaMins;
  let idx = targetIdx;
  while (idx > 0 && remaining > 0) {
    const segmentMins = segmentTravelMinutes(stops[idx - 1], stops[idx]);
    if (remaining <= segmentMins) {
      const t = segmentMins > 0 ? 1 - (remaining / segmentMins) : 0;
      return interpolateCoords(stops[idx - 1], stops[idx], t);
    }
    remaining -= segmentMins;
    idx -= 1;
  }

  const first = stops[0];
  const second = stops[Math.min(1, stops.length - 1)];
  if (idx === 0 && first && second && first.stopId !== second.stopId) {
    const t = Math.max(0, 1 - (remaining / segmentTravelMinutes(first, second)));
    return interpolateCoords(first, second, t);
  }

  return { lat: first.lat, lng: first.lng, name: null };
}

/**
 * @param {EtaTimelinePoint} a
 * @param {EtaTimelinePoint} b
 * @param {RouteStopInfo} targetStop
 * @param {number} etaMins
 */
function isPlausibleTimelineSegment(a, b, targetStop, etaMins) {
  if (b.etaTime < a.etaTime) return false;

  const bMinsFromNow = (b.etaTime - Date.now()) / 60000;
  if (bMinsFromNow > etaMins + 4) return false;

  const maxStopsBack = Math.max(3, Math.ceil(etaMins / 1.5));
  if (b.seq < targetStop.seq - maxStopsBack) return false;

  return true;
}

/**
 * @param {EtaTimelinePoint[]} timeline
 * @param {RouteStopInfo} targetStop
 * @param {number} etaMins
 * @returns {BusLocationEstimate | null}
 */
function estimateBusLocationFromTimeline(timeline, targetStop, etaMins) {
  if (!timeline.length) return null;
  if (etaMins <= 1) {
    return { lat: targetStop.lat, lng: targetStop.lng, name: targetStop.name };
  }

  const now = Date.now();
  const sorted = [...timeline].sort((a, b) => a.seq - b.seq);
  /** @type {{ a: EtaTimelinePoint, b: EtaTimelinePoint } | null} */
  let best = null;

  for (let i = 0; i < sorted.length - 1; i += 1) {
    const a = sorted[i];
    const b = sorted[i + 1];
    if (b.seq > targetStop.seq) break;
    if (a.etaTime > now || now > b.etaTime) continue;
    if (!isPlausibleTimelineSegment(a, b, targetStop, etaMins)) continue;
    if (!best || b.seq > best.b.seq) best = { a, b };
  }

  if (!best) return null;

  const { a, b } = best;
  const span = b.etaTime - a.etaTime;
  const t = span > 0 ? (now - a.etaTime) / span : 0;
  return interpolateCoords(a.stop, b.stop, t);
}

/**
 * @param {RouteWideEtaRow[]} routeWideEtas
 * @param {{ targetStop: RouteStopInfo, eta: EtaRow, routeStops: RouteStopInfo[], bound?: string | null, dir?: string | null, notDeparted?: boolean }} options
 * @returns {BusLocationEstimate | null}
 */
function estimateBusLocation(routeWideEtas, { targetStop, eta, routeStops, bound, dir, notDeparted }) {
  if (notDeparted) {
    const first = routeOriginStop(routeStops);
    if (!first) return null;
    return { lat: first.lat, lng: first.lng, name: null, awaitingDepart: true };
  }

  const timeline = buildEtaTimeline(routeWideEtas, {
    etaSeq: eta.etaSeq ?? 1,
    targetSeq: targetStop.seq,
    bound,
    dir,
    routeStops,
  });

  const location = estimateBusLocationFromTimeline(timeline, targetStop, eta.mins)
    ?? estimateBackwardFromTarget(routeStops, targetStop, eta.mins);
  return location ? labelBusLocation(routeStops, location, eta.mins, targetStop) : null;
}

function estimateMtrBusLocation(routeStops, targetStop, eta) {
  if (eta.busLat != null && eta.busLng != null) {
    const location = { lat: eta.busLat, lng: eta.busLng, name: null };
    return labelBusLocation(routeStops, location, eta.mins, targetStop);
  }

  const location = estimateBackwardFromTarget(routeStops, targetStop, eta.mins);
  return location ? labelBusLocation(routeStops, location, eta.mins, targetStop) : null;
}

/**
 * @param {EtaRow[]} etas
 * @param {RouteStopConfig} routeStop
 * @param {RouteStopInfo} targetStop
 * @param {RouteStopInfo[]} routeStops
 */
export async function enrichEtasWithBusLocation(etas, routeStop, targetStop, routeStops) {
  if (!etas.length) return etas;

  if (routeStop.type === 'mtr') {
    return etas.map((eta) => {
      const location = estimateMtrBusLocation(routeStops, targetStop, eta);
      return {
        ...eta,
        busLat: location?.lat ?? null,
        busLng: location?.lng ?? null,
        busStopSeq: location?.stopSeq ?? null,
        busStopName: location?.name ?? null,
        busStopsLeft: location?.stopsLeft ?? null,
        busAwaitingDepart: location?.awaitingDepart ?? false,
      };
    });
  }

  if (routeStop.type !== 'kmb' && routeStop.type !== 'nwfb' && routeStop.type !== 'socif' && routeStop.type !== 'gmb') {
    return etas;
  }

  const routeWideEtas = await fetchRouteWideEtas(routeStop);
  return etas.map((eta) => {
    const notDeparted = isNotDepartedRemark(eta.remark);
    const location = estimateBusLocation(routeWideEtas, {
      targetStop,
      eta,
      routeStops,
      bound: /** @type {string | null | undefined} */ (routeStop.bound),
      dir: /** @type {string | null | undefined} */ (routeStop.dir),
      notDeparted,
    });
    return {
      ...eta,
      busLat: location?.lat ?? null,
      busLng: location?.lng ?? null,
      busStopSeq: location?.stopSeq ?? null,
      busStopName: notDeparted ? null : location?.name ?? null,
      busStopsLeft: notDeparted ? null : location?.stopsLeft ?? null,
      busAwaitingDepart: notDeparted || (location?.awaitingDepart ?? false),
    };
  });
}

async function fetchKmbEtas(routeStop) {
  const serviceType = routeStop.service_type ?? 1;
  const bound = routeStop.bound ?? null;
  const url = `https://data.etabus.gov.hk/v1/transport/kmb/eta/${routeStop.stop}/${routeStop.route}/${serviceType}`;
  const res = await fetch(url);
  const json = await res.json();
  return (json.data ?? [])
    .filter((e) => e.eta)
    .filter((e) => !bound || e.dir === bound)
    .map((e) => ({
      routeId: e.route,
      operator: 'kmb',
      express: expressInfo(e.route, 'kmb'),
      routeClass: operatorClass('kmb'),
      time: formatTime(new Date(e.eta)),
      dest: pickLocalized(e.dest_tc, e.dest_en),
      mins: Math.max(0, Math.round((new Date(e.eta) - Date.now()) / 60000)),
      remark: translateRemark('kmb', e.rmk_tc, e.rmk_en === 'Scheduled Bus'),
      etaClass: etaColorClass(e.rmk_en === 'Scheduled Bus', e.rmk_tc),
      etaTime: new Date(e.eta),
      etaSeq: e.eta_seq,
      routeStop,
    }));
}

async function fetchNwfbEtas(routeStop) {
  const dir = routeStop.dir ?? null;
  const url = `https://rt.data.gov.hk/v1.1/transport/citybus-nwfb/eta/CTB/${routeStop.stop}/${routeStop.route}`;
  const res = await fetch(url);
  const json = await res.json();
  return (json.data ?? [])
    .filter((e) => e.eta)
    .filter((e) => !dir || e.dir === dir)
    .map((e) => ({
      routeId: e.route,
      operator: 'nwfb',
      express: expressInfo(e.route, 'nwfb'),
      routeClass: operatorClass('nwfb'),
      time: formatTime(new Date(e.eta)),
      dest: pickLocalized(e.dest_tc, e.dest_en),
      mins: Math.max(0, Math.round((new Date(e.eta) - Date.now()) / 60000)),
      remark: translateRemark('nwfb', e.rmk_tc, false),
      etaClass: etaColorClass(false, e.rmk_tc),
      etaTime: new Date(e.eta),
      etaSeq: e.eta_seq,
      routeStop,
    }));
}

async function fetchMtrEtas(routeStop) {
  const route = mtrRouteFromStopId(routeStop.stopId);
  const stops = await fetchMtrSchedule(route);
  const stop = stops.find((s) => s.busStopId === routeStop.stopId);
  if (!stop?.bus?.length) return [];
  const now = Date.now();
  return stop.bus.map((bus, index) => {
    const secs = parseInt(bus.departureTimeInSecond, 10);
    const etaTime = new Date(now + secs * 1000);
    const isScheduled = bus.isScheduled === '1' || bus.isScheduled === 1;
    const remark = translateRemark('mtr', bus.busRemark, isScheduled);
    const routeId = bus.lineRef.split('_')[0];
    const lat = parseFloat(bus.busLocation?.latitude);
    const lng = parseFloat(bus.busLocation?.longitude);
    const hasGps = Number.isFinite(lat) && Number.isFinite(lng) && lat !== 0 && lng !== 0;
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
      etaSeq: index + 1,
      busLat: hasGps ? lat : null,
      busLng: hasGps ? lng : null,
      routeStop,
    };
  });
}

async function fetchSocifEtas(routeStop) {
  const data = await fetchSocifRouteEtaData(routeStop.route, routeStop.routeSeq);
  const stopEta = (data.eta ?? []).find((s) => s.stopSeq === routeStop.stopSeq);
  if (!stopEta?.eta?.length) return [];
  const direction = await getSocifDirection(routeStop.route, routeStop.routeSeq);
  const dest = socifDestFromDirection(direction, routeStop.dest ?? '');
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
      etaSeq: e.eta_seq,
      routeStop,
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
        etaSeq: e.eta_seq,
        routeStop,
      };
    });
}

export async function fetchEtas(routeStop) {
  switch (routeStop.type) {
    case 'kmb': return fetchKmbEtas(routeStop);
    case 'nwfb': return fetchNwfbEtas(routeStop);
    case 'mtr': return fetchMtrEtas(routeStop);
    case 'gmb': return fetchGmbEtas(routeStop);
    case 'socif': return fetchSocifEtas(routeStop);
    default: return [];
  }
}

async function fetchKmbRouteStops(routeStop) {
  const db = await ensureRouteFareDb();
  const entry = findKmbRouteEntry(
    routeStop.route,
    routeStop.bound,
    routeStop.service_type ?? 1,
    db.routeList,
  );
  const stopIds = entry?.stops?.kmb;
  if (Array.isArray(stopIds) && stopIds.length) {
    const stops = buildRouteStopsFromFareStopIds(stopIds, db.stopList, (name, fareStop) =>
      fareStop ? stopNameFromFare(fareStop, name) : formatKmbStopName(name));
    const missingCoords = stops.filter((s) => s.lat == null || s.lng == null).map((s) => s.stopId);
    if (missingCoords.length) {
      const details = await Promise.all(
        missingCoords.map((stopId) => fetchKmbStop(stopId).catch(() => null)),
      );
      const detailById = new Map(missingCoords.map((id, i) => [id, details[i]]));
      for (const stop of stops) {
        if (stop.lat != null && stop.lng != null) continue;
        const detail = detailById.get(stop.stopId);
        if (!detail) continue;
        stop.lat = detail.lat;
        stop.lng = detail.lng;
        if (!stop.name || stop.name === stop.stopId) stop.name = detail.name;
      }
    }
    return stops;
  }

  const bound = routeStop.bound === 'I' ? 'inbound' : 'outbound';
  const serviceType = routeStop.service_type ?? 1;
  const url = `https://data.etabus.gov.hk/v1/transport/kmb/route-stop/${routeStop.route}/${bound}/${serviceType}`;
  const res = await fetch(url);
  const json = await res.json();
  const items = json.data ?? [];
  const stops = await Promise.all(items.map(async (item) => {
    const detail = await fetchKmbStop(item.stop);
    return {
      seq: parseInt(item.seq, 10),
      stopId: item.stop,
      name: detail.name,
      lat: detail.lat,
      lng: detail.lng,
    };
  }));
  return stops.sort((a, b) => a.seq - b.seq);
}

async function fetchNwfbRouteStops(routeStop) {
  const db = await ensureRouteFareDb();
  const entry = findCtbRouteEntry(routeStop.route, routeStop.dir, db.routeList);
  const stopIds = entry?.stops?.ctb;
  if (Array.isArray(stopIds) && stopIds.length) {
    const stops = buildRouteStopsFromFareStopIds(stopIds, db.stopList, (name, fareStop) =>
      fareStop ? stopNameFromFare(fareStop, name) : name);
    const missingCoords = stops.filter((s) => s.lat == null || s.lng == null).map((s) => s.stopId);
    if (missingCoords.length) {
      const details = await Promise.all(
        missingCoords.map((stopId) => fetchNwfbStop(stopId).catch(() => null)),
      );
      const detailById = new Map(missingCoords.map((id, i) => [id, details[i]]));
      for (const stop of stops) {
        if (stop.lat != null && stop.lng != null) continue;
        const detail = detailById.get(stop.stopId);
        if (!detail) continue;
        stop.lat = detail.lat;
        stop.lng = detail.lng;
        if (!stop.name || stop.name === stop.stopId) stop.name = detail.name;
      }
    }
    return stops;
  }

  const dir = routeStop.dir === 'I' ? 'inbound' : 'outbound';
  const url = `https://rt.data.gov.hk/v1.1/transport/citybus-nwfb/route-stop/CTB/${routeStop.route}/${dir}`;
  const res = await fetch(url);
  const json = await res.json();
  const items = json.data ?? [];
  const stops = await Promise.all(items.map(async (item) => {
    const detail = await fetchNwfbStop(item.stop);
    return {
      seq: parseInt(item.seq, 10),
      stopId: item.stop,
      name: detail.name,
      lat: detail.lat,
      lng: detail.lng,
    };
  }));
  return stops.sort((a, b) => a.seq - b.seq);
}

async function fetchMtrRouteStops(routeStop) {
  const db = await ensureRouteFareDb();
  const entry = findLrtfeederRouteEntry(routeStop.stopId, db.routeList);
  const stopIds = entry?.stops?.lrtfeeder;
  if (!Array.isArray(stopIds) || !stopIds.length) {
    throw new Error(t('error.mtrStops'));
  }

  /** @type {RouteStopInfo[]} */
  const stops = [];
  let seq = 0;
  for (const stopId of stopIds) {
    seq += 1;
    const fareStop = db.stopList[stopId];
    const geo = fareStop?.location ?? MTR_GEO[stopId];
    stops.push({
      seq,
      stopId,
      name: stopNameFromFare(fareStop, stopId),
      lat: geo?.lat ?? null,
      lng: geo?.lng ?? null,
    });
  }
  return stops;
}

async function fetchGmbRouteStops(routeStop) {
  const url = `https://data.etagmb.gov.hk/route-stop/${routeStop.realRouteId}/${routeStop.routeSeq}`;
  const [res, db] = await Promise.all([
    fetch(url),
    ensureRouteFareDb(),
  ]);
  const json = await res.json();
  const items = json.data?.route_stops ?? [];
  /** @type {RouteStopInfo[]} */
  const stops = [];
  /** @type {string[]} */
  const missingCoords = [];

  for (const item of items) {
    const stopId = String(item.stop_id);
    const fareStop = db.stopList[stopId];
    const lat = fareStop?.location?.lat ?? null;
    const lng = fareStop?.location?.lng ?? null;
    if (lat == null || lng == null) missingCoords.push(stopId);
    stops.push({
      seq: item.stop_seq,
      stopId,
      name: pickLocalized(item.name_tc ?? fareStop?.name?.zh, item.name_en ?? fareStop?.name?.en) || stopId,
      lat,
      lng,
    });
  }

  if (missingCoords.length) {
    const details = await Promise.all(
      missingCoords.map((stopId) => fetchGmbStop(stopId).catch(() => null)),
    );
    const detailById = new Map(missingCoords.map((id, i) => [id, details[i]]));
    for (const stop of stops) {
      if (stop.lat != null && stop.lng != null) continue;
      const detail = detailById.get(stop.stopId);
      if (!detail) continue;
      stop.lat = detail.lat;
      stop.lng = detail.lng;
      if (!stop.name || stop.name === stop.stopId) stop.name = detail.name;
    }
  }

  return stops.sort((a, b) => a.seq - b.seq);
}

async function fetchSocifRouteStops(routeStop) {
  const url = `https://360-api.socif.co/api/route-stop/${routeStop.route}/${routeStop.routeSeq}`;
  const res = await fetch(url);
  const json = await res.json();
  const items = json.data?.route_stops ?? [];
  /** @type {RouteStopInfo[]} */
  const stops = [];
  /** @type {{ item: object, stopId: string, geoKey: string }[]} */
  const needGeo = [];

  for (const item of items) {
    const stopId = String(item.stop_id);
    const geoKey = `${routeStop.route}-${routeStop.routeSeq}-${item.stop_seq}`;
    if (SOCIF_GEO[geoKey]) {
      stops.push({
        seq: item.stop_seq,
        stopId,
        name: pickLocalized(item.name_tc, item.name_en),
        lat: SOCIF_GEO[geoKey].lat,
        lng: SOCIF_GEO[geoKey].lng,
      });
    } else {
      needGeo.push({ item, stopId, geoKey });
    }
  }

  if (needGeo.length) {
    const details = await Promise.all(
      needGeo.map(({ stopId }) => fetchSocifStop(stopId).catch(() => null)),
    );
    for (let i = 0; i < needGeo.length; i += 1) {
      const { item, stopId } = needGeo[i];
      const detail = details[i];
      stops.push({
        seq: item.stop_seq,
        stopId,
        name: pickLocalized(item.name_tc, item.name_en),
        lat: detail?.lat ?? null,
        lng: detail?.lng ?? null,
      });
    }
  }

  return stops.sort((a, b) => a.seq - b.seq);
}

export async function fetchRouteStops(routeStop) {
  /** @type {RouteStopInfo[]} */
  let stops;
  switch (routeStop.type) {
    case 'kmb': stops = await fetchKmbRouteStops(routeStop); break;
    case 'nwfb': stops = await fetchNwfbRouteStops(routeStop); break;
    case 'mtr': stops = await fetchMtrRouteStops(routeStop); break;
    case 'gmb': stops = await fetchGmbRouteStops(routeStop); break;
    case 'socif': stops = await fetchSocifRouteStops(routeStop); break;
    default: return [];
  }
  return attachFaresToRouteStops(routeStop, stops);
}

export function routeStopId(routeStop) {
  switch (routeStop.type) {
    case 'kmb':
    case 'nwfb':
      return routeStop.stop;
    case 'socif':
      return `${routeStop.route}-${routeStop.routeSeq}-${routeStop.stopSeq}`;
    default:
      return routeStop.stopId;
  }
}

export function serializeRouteStop(routeStop) {
  const p = new URLSearchParams({ type: routeStop.type });
  switch (routeStop.type) {
    case 'kmb':
      p.set('route', routeStop.route);
      p.set('bound', routeStop.bound);
      p.set('stop', routeStop.stop);
      if (routeStop.service_type != null) p.set('service_type', String(routeStop.service_type));
      break;
    case 'nwfb':
      p.set('route', routeStop.route);
      p.set('dir', routeStop.dir);
      p.set('stop', routeStop.stop);
      break;
    case 'mtr':
      p.set('stopId', routeStop.stopId);
      break;
    case 'gmb':
      p.set('routeId', routeStop.routeId);
      p.set('realRouteId', routeStop.realRouteId);
      p.set('stopId', routeStop.stopId);
      p.set('routeSeq', String(routeStop.routeSeq));
      break;
    case 'socif':
      p.set('route', String(routeStop.route));
      p.set('routeSeq', String(routeStop.routeSeq));
      p.set('stopSeq', String(routeStop.stopSeq));
      if (routeStop.routeId) p.set('routeId', routeStop.routeId);
      if (routeStop.dest) p.set('dest', routeStop.dest);
      break;
    default:
      break;
  }
  return p.toString();
}

/** @param {URLSearchParams} params */
export function parseRouteStop(params) {
  const type = params.get('type');
  if (!type) return null;
  switch (type) {
    case 'kmb':
      return {
        type: 'kmb',
        route: params.get('route'),
        bound: params.get('bound'),
        stop: params.get('stop'),
        service_type: params.has('service_type') ? parseInt(params.get('service_type'), 10) : 1,
      };
    case 'nwfb':
      return {
        type: 'nwfb',
        route: params.get('route'),
        dir: params.get('dir'),
        stop: params.get('stop'),
      };
    case 'mtr':
      return { type: 'mtr', stopId: params.get('stopId') };
    case 'gmb':
      return {
        type: 'gmb',
        routeId: params.get('routeId'),
        realRouteId: params.get('realRouteId'),
        stopId: params.get('stopId'),
        routeSeq: parseInt(params.get('routeSeq'), 10),
      };
    case 'socif':
      return {
        type: 'socif',
        route: parseInt(params.get('route'), 10),
        routeSeq: parseInt(params.get('routeSeq'), 10),
        stopSeq: parseInt(params.get('stopSeq'), 10),
        routeId: params.get('routeId') ?? undefined,
        dest: params.get('dest') ?? undefined,
      };
    default:
      return null;
  }
}

/** Immediate title from URL params — no network. */
export function routeTitleHint(routeStop) {
  if (!routeStop?.type) return '';
  switch (routeStop.type) {
    case 'kmb':
    case 'nwfb':
      return routeStop.route ? String(routeStop.route) : '';
    case 'mtr':
      return routeStop.stopId ? mtrRouteFromStopId(routeStop.stopId) : '';
    case 'gmb':
      return routeStop.routeId ?? routeStop.realRouteId ?? '';
    case 'socif':
      return routeStop.routeId ?? (routeStop.route != null ? String(routeStop.route) : '');
    default:
      return '';
  }
}

export async function routeTitle(routeStop, stops) {
  const lastName = stops.at(-1)?.name ?? '';
  switch (routeStop.type) {
    case 'kmb': {
      await ensureRouteFareDb();
      const entry = findKmbRouteEntry(
        routeStop.route,
        routeStop.bound,
        routeStop.service_type ?? 1,
      );
      const dest = pickLocalized(entry?.dest?.zh, entry?.dest?.en) || lastName;
      return `${routeStop.route} - ${dest}`;
    }
    case 'mtr':
      return `${mtrRouteFromStopId(routeStop.stopId)} - ${lastName}`;
    case 'gmb':
      return `${routeStop.routeId ?? routeStop.realRouteId} - ${getGmbRouteDest(routeStop.realRouteId, routeStop.routeSeq) || lastName}`;
    case 'nwfb': {
      await ensureRouteFareDb();
      const entry = findCtbRouteEntry(routeStop.route, routeStop.dir);
      const dest = pickLocalized(entry?.dest?.zh, entry?.dest?.en) || lastName;
      return `${routeStop.route} - ${dest}`;
    }
    case 'socif': {
      const direction = await getSocifDirection(routeStop.route, routeStop.routeSeq);
      const dest = socifDestFromDirection(direction, routeStop.dest ?? lastName);
      return `${routeStop.routeId ?? routeStop.route} - ${dest}`;
    }
    default:
      return '';
  }
}
