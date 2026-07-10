/** @typedef {'kmb' | 'nwfb' | 'mtr' | 'gmb'} RouteSearchType */

/** @typedef {{
 *   type: RouteSearchType,
 *   routeId: string,
 *   label: string,
 *   dest: string,
 *   orig?: string,
 *   route?: string,
 *   bound?: string,
 *   service_type?: number,
 *   dir?: string,
 *   stopId?: string,
 *   nwfbSpecial?: boolean,
 *   nwfbStopId?: string,
 *   mtrSpecial?: boolean,
 *   gmbSpecial?: boolean,
 *   realRouteId?: string | number,
 *   routeSeq?: number,
 *   gmbStopId?: string,
 *   kmbStopId?: string,
 * }} RouteSearchMatch */

/** @typedef {{ phase: string, loaded: number, total: number }} RouteSearchProgress */

import { ensureRouteFareDb, gmbRouteSeqFromBound } from './route-fare-db.js';

const CACHE_VERSION = 9;
const CACHE_KEY = 'homedashboard-route-search-v9';
const CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const SUPPORTED_FARE_CO = new Set(['kmb', 'ctb', 'gmb', 'lrtfeeder']);

/** @type {RouteSearchMatch[]} */
let kmbMatches = [];
/** @type {RouteSearchMatch[]} */
let nwfbMatches = [];
/** @type {RouteSearchMatch[]} */
let mtrMatches = [];
/** @type {RouteSearchMatch[]} */
let gmbMatches = [];
/** @type {Set<string> | null} */
let allRouteIds = null;
/** @type {boolean} */
let indexReady = false;
/** @type {Promise<void> | null} */
let indexLoadPromise = null;
/** @type {((progress: RouteSearchProgress) => void) | null} */
let progressCallback = null;

function reportProgress(phase, loaded, total) {
  progressCallback?.({ phase, loaded, total });
}

export function setRouteSearchProgressCallback(callback) {
  progressCallback = callback;
}

function normalizeQuery(query) {
  return String(query ?? '').toUpperCase().trim();
}

function routeSortKey(routeId) {
  return routeId.toUpperCase();
}

function parseServiceType(value) {
  if (value == null || value === '') return 1;
  const parsed = parseInt(String(value), 10);
  return Number.isFinite(parsed) ? parsed : 1;
}

function matchRank(routeId, query) {
  const id = routeSortKey(routeId);
  const q = normalizeQuery(query);
  if (!q) return Number.MAX_SAFE_INTEGER;
  if (id === q) return 0;
  if (id.startsWith(q)) return 1 + (id.length - q.length);
  return Number.MAX_SAFE_INTEGER;
}

function isMatchSpecial(match) {
  if (match.type === 'kmb') return match.service_type != null && match.service_type !== 1;
  if (match.type === 'nwfb') return Boolean(match.nwfbSpecial);
  if (match.type === 'mtr') return Boolean(match.mtrSpecial);
  if (match.type === 'gmb') return Boolean(match.gmbSpecial);
  return false;
}

function compareMatchesForQuery(query) {
  return (a, b) => {
    const rankCmp = matchRank(a.routeId, query) - matchRank(b.routeId, query);
    if (rankCmp !== 0) return rankCmp;

    const typeOrder = { kmb: 0, nwfb: 1, mtr: 2, gmb: 3 };
    const typeCmp = (typeOrder[a.type] ?? 9) - (typeOrder[b.type] ?? 9);
    if (typeCmp !== 0) return typeCmp;

    const routeCmp = routeSortKey(a.routeId).localeCompare(routeSortKey(b.routeId), undefined, { numeric: true });
    if (routeCmp !== 0) return routeCmp;

    const specialCmp = Number(isMatchSpecial(a)) - Number(isMatchSpecial(b));
    if (specialCmp !== 0) return specialCmp;

    return String(a.dest ?? '').localeCompare(String(b.dest ?? ''), 'zh-Hant');
  };
}

function rebuildRouteIdSet() {
  allRouteIds = new Set();
  for (const item of [...kmbMatches, ...nwfbMatches, ...mtrMatches, ...gmbMatches]) {
    allRouteIds.add(item.routeId.toUpperCase());
  }
}

/**
 * @param {Record<string, unknown>} entry
 * @param {'kmb' | 'ctb' | 'gmb' | 'lrtfeeder'} co
 * @returns {RouteSearchMatch | null}
 */
function buildMatchFromFareEntry(entry, co) {
  const route = String(entry.route ?? '').trim();
  if (!route) return null;

  const serviceType = parseServiceType(entry.serviceType);
  const orig = entry.orig?.zh ?? '';
  const dest = entry.dest?.zh ?? '';
  const label = `${route} 往${dest}`;

  if (co === 'kmb') {
    const kmbStops = entry.stops?.kmb;
    const firstStop = Array.isArray(kmbStops) ? kmbStops[0] : undefined;
    return {
      type: 'kmb',
      routeId: route,
      route,
      bound: entry.bound?.kmb ?? 'O',
      service_type: serviceType,
      orig,
      dest,
      kmbStopId: firstStop != null ? String(firstStop) : undefined,
      label,
    };
  }

  if (co === 'ctb') {
    const ctbStops = entry.stops?.ctb;
    const firstStop = Array.isArray(ctbStops) ? ctbStops[0] : undefined;
    return {
      type: 'nwfb',
      routeId: route,
      route,
      dir: entry.bound?.ctb ?? 'O',
      orig,
      dest,
      nwfbSpecial: serviceType >= 2,
      nwfbStopId: firstStop != null ? String(firstStop) : undefined,
      label,
    };
  }

  if (co === 'lrtfeeder') {
    const lrtStops = entry.stops?.lrtfeeder;
    const firstStop = Array.isArray(lrtStops) ? lrtStops[0] : undefined;
    if (!firstStop) return null;
    return {
      type: 'mtr',
      routeId: route,
      stopId: String(firstStop),
      orig,
      dest,
      mtrSpecial: serviceType >= 2,
      label,
    };
  }

  const gmbStops = entry.stops?.gmb;
  const firstStop = Array.isArray(gmbStops) ? gmbStops[0] : undefined;
  return {
    type: 'gmb',
    routeId: route,
    realRouteId: entry.gtfsId,
    routeSeq: gmbRouteSeqFromBound(entry.bound?.gmb),
    gmbStopId: firstStop != null ? String(firstStop) : undefined,
    orig,
    dest,
    gmbSpecial: serviceType >= 2,
    label,
  };
}

/**
 * @param {Record<string, unknown>} routeList
 * @returns {{ kmb: RouteSearchMatch[], nwfb: RouteSearchMatch[], mtr: RouteSearchMatch[], gmb: RouteSearchMatch[] }}
 */
function buildIndexFromRouteFareList(routeList) {
  /** @type {RouteSearchMatch[]} */
  const kmb = [];
  /** @type {RouteSearchMatch[]} */
  const nwfb = [];
  /** @type {RouteSearchMatch[]} */
  const mtr = [];
  /** @type {RouteSearchMatch[]} */
  const gmb = [];

  for (const entry of Object.values(routeList ?? {})) {
    for (const co of entry.co ?? []) {
      if (!SUPPORTED_FARE_CO.has(co)) continue;
      const match = buildMatchFromFareEntry(entry, co);
      if (!match) continue;
      if (co === 'kmb') kmb.push(match);
      else if (co === 'ctb') nwfb.push(match);
      else if (co === 'lrtfeeder') mtr.push(match);
      else gmb.push(match);
    }
  }

  return { kmb, nwfb, mtr, gmb };
}

async function loadFareListIndex() {
  reportProgress('routes', 0, 1);
  const db = await ensureRouteFareDb();
  const index = buildIndexFromRouteFareList(db.routeList);
  reportProgress('routes', 1, 1);
  return index;
}

function readCache({ allowStale = false } = {}) {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const cache = JSON.parse(raw);
    if (cache.version !== CACHE_VERSION) return null;
    const stale = Date.now() - cache.savedAt > CACHE_TTL_MS;
    if (stale && !allowStale) return null;
    if (
      !Array.isArray(cache.kmb)
      || !Array.isArray(cache.nwfb)
      || !Array.isArray(cache.mtr)
      || !Array.isArray(cache.gmb)
    ) {
      return null;
    }
    return {
      kmb: cache.kmb,
      nwfb: cache.nwfb,
      mtr: cache.mtr,
      gmb: cache.gmb,
      stale,
    };
  } catch {
    return null;
  }
}

function writeCache(kmb, nwfb, mtr, gmb) {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify({
      version: CACHE_VERSION,
      savedAt: Date.now(),
      kmb,
      nwfb,
      mtr,
      gmb,
    }));
  } catch {
    /* ignore quota / private mode */
  }
}

function applyIndex(kmb, nwfb, mtr, gmb) {
  kmbMatches = kmb;
  nwfbMatches = nwfb;
  mtrMatches = mtr;
  gmbMatches = gmb;
  rebuildRouteIdSet();
  indexReady = true;
}

async function fetchFreshIndex() {
  const fare = await loadFareListIndex();
  applyIndex(fare.kmb, fare.nwfb, fare.mtr, fare.gmb);
  writeCache(fare.kmb, fare.nwfb, fare.mtr, fare.gmb);
}

async function refreshIndexInBackground() {
  try {
    await fetchFreshIndex();
  } catch {
    /* keep serving stale index */
  }
}

async function loadIndex() {
  reportProgress('cache', 0, 1);
  const cached = readCache({ allowStale: true });

  if (cached) {
    applyIndex(cached.kmb, cached.nwfb, cached.mtr, cached.gmb);
    reportProgress('cache', 1, 1);
    if (cached.stale) refreshIndexInBackground();
    return;
  }

  reportProgress('cache', 1, 1);
  await fetchFreshIndex();
}

export function ensureRouteSearchIndex() {
  if (indexReady) return Promise.resolve();
  if (indexLoadPromise) return indexLoadPromise;
  indexLoadPromise = loadIndex().catch((err) => {
    indexLoadPromise = null;
    throw err;
  });
  return indexLoadPromise;
}

/**
 * @param {string} query
 * @returns {string[]}
 */
export function getAlphabetCandidates(query) {
  if (!allRouteIds) return [];
  const q = normalizeQuery(query);
  const letters = new Set();

  if (!q) {
    for (const routeId of allRouteIds) {
      const first = routeId[0];
      if (/[A-Z]/.test(first)) letters.add(first);
    }
    return [...letters].sort();
  }

  for (const routeId of allRouteIds) {
    if (!routeId.startsWith(q)) continue;
    if (routeId.length <= q.length) continue;
    const next = routeId[q.length];
    if (/[A-Z]/.test(next)) letters.add(next);
  }
  return [...letters].sort();
}

export function isRouteSearchIndexReady() {
  return indexReady;
}

/**
 * @param {string} query
 * @returns {RouteSearchMatch[]}
 */
export function searchRoutes(query) {
  const q = normalizeQuery(query);
  if (!q || !indexReady) return [];

  /** @type {RouteSearchMatch[]} */
  const results = [];
  for (const item of kmbMatches) {
    if (item.routeId.toUpperCase().startsWith(q)) results.push(item);
  }
  for (const item of nwfbMatches) {
    if (item.routeId.toUpperCase().startsWith(q)) results.push(item);
  }
  for (const item of mtrMatches) {
    if (item.routeId.toUpperCase().startsWith(q)) results.push(item);
  }
  for (const item of gmbMatches) {
    if (item.routeId.toUpperCase().startsWith(q)) results.push(item);
  }

  return results.sort(compareMatchesForQuery(q));
}

/**
 * @param {RouteSearchMatch} match
 * @returns {Promise<import('./transit-api.js').RouteStopConfig>}
 */
export async function resolveRouteStop(match) {
  switch (match.type) {
    case 'kmb': {
      const serviceType = match.service_type ?? 1;
      if (match.kmbStopId && match.route) {
        return {
          type: 'kmb',
          route: match.route,
          bound: match.bound,
          stop: match.kmbStopId,
          service_type: serviceType,
        };
      }
      const bound = match.bound === 'I' ? 'inbound' : 'outbound';
      const res = await fetch(
        `https://data.etabus.gov.hk/v1/transport/kmb/route-stop/${match.route}/${bound}/${serviceType}`,
      );
      const json = await res.json();
      const first = json.data?.[0];
      if (!first) throw new Error('停留所が見つかりません');
      return {
        type: 'kmb',
        route: match.route,
        bound: match.bound,
        stop: first.stop,
        service_type: serviceType,
      };
    }
    case 'nwfb': {
      if (match.nwfbStopId && match.route) {
        return {
          type: 'nwfb',
          route: match.route,
          dir: match.dir ?? 'O',
          stop: match.nwfbStopId,
        };
      }
      const dir = match.dir === 'I' ? 'inbound' : 'outbound';
      const res = await fetch(
        `https://rt.data.gov.hk/v1.1/transport/citybus-nwfb/route-stop/CTB/${match.route}/${dir}`,
      );
      const json = await res.json();
      const first = (json.data ?? []).sort((a, b) => parseInt(a.seq, 10) - parseInt(b.seq, 10))[0];
      if (!first) throw new Error('停留所が見つかりません');
      return {
        type: 'nwfb',
        route: match.route,
        dir: first.dir ?? match.dir ?? 'O',
        stop: first.stop,
      };
    }
    case 'mtr': {
      if (!match.stopId) throw new Error('停留所が見つかりません');
      return { type: 'mtr', stopId: match.stopId };
    }
    case 'gmb': {
      if (match.realRouteId == null || match.routeSeq == null || !match.gmbStopId) {
        throw new Error('路線情報が不足しています');
      }
      return {
        type: 'gmb',
        routeId: match.routeId,
        realRouteId: String(match.realRouteId),
        stopId: match.gmbStopId,
        routeSeq: match.routeSeq,
      };
    }
    default:
      throw new Error('未対応の路線です');
  }
}
