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
 *   realRouteId?: string | number,
 *   routeSeq?: number,
 *   region?: string,
 * }} RouteSearchMatch */

/** @typedef {{ phase: string, loaded: number, total: number }} RouteSearchProgress */

const GMB_REGION_LABEL = { HKI: '香港島', KLN: '九龍', NT: '新界' };
const CACHE_VERSION = 4;
const CACHE_KEY = 'homedashboard-route-search-v4';
const GMB_DETAIL_CACHE_KEY = 'homedashboard-route-search-gmb-v4';
const CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const GMB_DETAIL_MAX = 300;
const GMB_ENRICH_LIMIT = 30;

/** @type {RouteSearchMatch[]} */
let kmbMatches = [];
/** @type {RouteSearchMatch[]} */
let nwfbMatches = [];
/** @type {RouteSearchMatch[]} */
let mtrMatches = [];
/** @type {{ region: string, routeCode: string }[]} */
let gmbFlat = [];
/** @type {Set<string> | null} */
let allRouteIds = null;
/** @type {boolean} */
let indexReady = false;
/** @type {Promise<void> | null} */
let indexLoadPromise = null;
/** @type {Map<string, RouteSearchMatch[]>} */
const gmbDetailCache = new Map();
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

function compareMatches(a, b) {
  const typeOrder = { kmb: 0, nwfb: 1, mtr: 2, gmb: 3 };
  const typeCmp = (typeOrder[a.type] ?? 9) - (typeOrder[b.type] ?? 9);
  if (typeCmp !== 0) return typeCmp;
  return routeSortKey(a.routeId).localeCompare(routeSortKey(b.routeId), undefined, { numeric: true });
}

function rebuildRouteIdSet() {
  allRouteIds = new Set();
  for (const item of kmbMatches) allRouteIds.add(item.routeId.toUpperCase());
  for (const item of nwfbMatches) allRouteIds.add(item.routeId.toUpperCase());
  for (const item of mtrMatches) allRouteIds.add(item.routeId.toUpperCase());
  for (const item of gmbFlat) allRouteIds.add(item.routeCode.toUpperCase());
}

async function loadKmbIndex() {
  reportProgress('kmb', 0, 1);
  const res = await fetch('https://data.etabus.gov.hk/v1/transport/kmb/route/');
  const json = await res.json();
  reportProgress('kmb', 1, 1);
  return (json.data ?? []).map((item) => ({
    type: 'kmb',
    routeId: item.route,
    route: item.route,
    bound: item.bound,
    service_type: parseInt(item.service_type, 10) || 1,
    orig: item.orig_tc,
    dest: item.dest_tc,
    label: `${item.route} 往${item.dest_tc}`,
  }));
}

async function loadNwfbIndex() {
  reportProgress('nwfb', 0, 1);
  const res = await fetch('https://rt.data.gov.hk/v2/transport/citybus/route/CTB');
  const json = await res.json();
  reportProgress('nwfb', 1, 1);
  return (json.data ?? []).map((item) => ({
    type: 'nwfb',
    routeId: item.route,
    route: item.route,
    dir: 'O',
    orig: item.orig_tc,
    dest: item.dest_tc,
    label: `${item.route} 往${item.dest_tc}`,
  }));
}

async function loadMtrIndex() {
  reportProgress('mtr', 0, 1);
  const res = await fetch('data/mtr-bus-stops.json');
  const data = await res.json();
  /** @type {Map<string, { stopId: string, routeId: string, nameChi: string, seq: number }[]>} */
  const groups = new Map();

  for (const [stopId, stop] of Object.entries(data)) {
    const key = `${stop.routeId}:${stop.direction}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({
      stopId,
      routeId: stop.routeId,
      nameChi: stop.nameChi,
      seq: stop.seq,
    });
  }

  /** @type {RouteSearchMatch[]} */
  const matches = [];
  for (const stops of groups.values()) {
    stops.sort((a, b) => a.seq - b.seq);
    const first = stops[0];
    const last = stops[stops.length - 1];
    matches.push({
      type: 'mtr',
      routeId: first.routeId,
      stopId: first.stopId,
      orig: first.nameChi,
      dest: last.nameChi,
      label: `${first.routeId} 往${last.nameChi}`,
    });
  }

  reportProgress('mtr', 1, 1);
  return matches;
}

async function loadGmbFlatList() {
  reportProgress('gmb', 0, 1);
  const res = await fetch('https://data.etagmb.gov.hk/route');
  const json = await res.json();
  const routes = json.data?.routes ?? {};
  /** @type {{ region: string, routeCode: string }[]} */
  const flat = [];
  for (const [region, codes] of Object.entries(routes)) {
    for (const routeCode of codes) flat.push({ region, routeCode });
  }
  reportProgress('gmb', 1, 1);
  return flat;
}

/**
 * @param {{ region: string, routeCode: string }} item
 * @returns {Promise<RouteSearchMatch[]>}
 */
async function fetchGmbRouteEntries({ region, routeCode }) {
  const cacheKey = `${region}:${routeCode}`;
  if (gmbDetailCache.has(cacheKey)) return gmbDetailCache.get(cacheKey);

  try {
    const res = await fetch(`https://data.etagmb.gov.hk/route/${region}/${routeCode}`);
    const json = await res.json();
    /** @type {RouteSearchMatch[]} */
    const entries = [];
    for (const routeData of json.data ?? []) {
      for (const dir of routeData.directions ?? []) {
        entries.push({
          type: 'gmb',
          routeId: routeCode,
          realRouteId: routeData.route_id,
          routeSeq: dir.route_seq,
          region,
          orig: dir.orig_tc,
          dest: dir.dest_tc,
          label: `${routeCode} 往${dir.dest_tc}`,
        });
      }
    }
    if (!entries.length) {
      const regionLabel = GMB_REGION_LABEL[region] ?? region;
      entries.push({
        type: 'gmb',
        routeId: routeCode,
        region,
        dest: '',
        label: `${routeCode}（${regionLabel}）`,
      });
    }
    persistGmbDetail(cacheKey, entries);
    return entries;
  } catch {
    const regionLabel = GMB_REGION_LABEL[region] ?? region;
    const entries = [{
      type: 'gmb',
      routeId: routeCode,
      region,
      dest: '',
      label: `${routeCode}（${regionLabel}）`,
    }];
    persistGmbDetail(cacheKey, entries);
    return entries;
  }
}

/**
 * @param {{ region: string, routeCode: string }[]} flatMatches
 * @returns {Promise<RouteSearchMatch[]>}
 */
async function enrichGmbMatches(flatMatches) {
  const batchResults = await Promise.all(flatMatches.map(fetchGmbRouteEntries));
  return batchResults.flat();
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
      || !Array.isArray(cache.gmbFlat)
    ) {
      return null;
    }
    return { kmb: cache.kmb, nwfb: cache.nwfb, mtr: cache.mtr, gmbFlat: cache.gmbFlat, stale };
  } catch {
    return null;
  }
}

function writeCache(kmb, nwfb, mtr, gmbFlat) {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify({
      version: CACHE_VERSION,
      savedAt: Date.now(),
      kmb,
      nwfb,
      mtr,
      gmbFlat,
    }));
  } catch {
    /* ignore quota / private mode */
  }
}

function loadGmbDetailsFromStorage() {
  try {
    const raw = localStorage.getItem(GMB_DETAIL_CACHE_KEY);
    if (!raw) return;
    const store = JSON.parse(raw);
    if (store.version !== CACHE_VERSION || !store.entries) return;
    for (const [key, entries] of Object.entries(store.entries)) {
      if (Array.isArray(entries)) gmbDetailCache.set(key, entries);
    }
  } catch {
    /* ignore corrupt cache */
  }
}

function persistGmbDetail(cacheKey, entries) {
  gmbDetailCache.set(cacheKey, entries);
  try {
    const raw = localStorage.getItem(GMB_DETAIL_CACHE_KEY);
    const store = raw ? JSON.parse(raw) : { version: CACHE_VERSION, entries: {}, order: [] };
    if (store.version !== CACHE_VERSION) {
      store.version = CACHE_VERSION;
      store.entries = {};
      store.order = [];
    }
    if (!store.entries[cacheKey]) store.order.push(cacheKey);
    store.entries[cacheKey] = entries;
    while (store.order.length > GMB_DETAIL_MAX) {
      const oldKey = store.order.shift();
      delete store.entries[oldKey];
    }
    localStorage.setItem(GMB_DETAIL_CACHE_KEY, JSON.stringify(store));
  } catch {
  }
}

async function refreshIndexInBackground() {
  try {
    const [kmb, nwfb, flat, mtr] = await Promise.all([
      loadKmbIndex(),
      loadNwfbIndex(),
      loadGmbFlatList(),
      loadMtrIndex(),
    ]);
    kmbMatches = kmb;
    nwfbMatches = nwfb;
    gmbFlat = flat;
    mtrMatches = mtr;
    writeCache(kmb, nwfb, mtr, flat);
    rebuildRouteIdSet();
  } catch {
    /* keep serving stale index */
  }
}

function applyIndexCache(cached) {
  kmbMatches = cached.kmb;
  nwfbMatches = cached.nwfb;
  mtrMatches = cached.mtr;
  gmbFlat = cached.gmbFlat;
  rebuildRouteIdSet();
  indexReady = true;
}

async function loadIndex() {
  loadGmbDetailsFromStorage();

  reportProgress('cache', 0, 1);
  const cached = readCache({ allowStale: true });

  if (cached) {
    applyIndexCache(cached);
    reportProgress('cache', 1, 1);
    if (cached.stale) refreshIndexInBackground();
    return;
  }

  reportProgress('cache', 1, 1);
  const [kmb, nwfb, flat, mtr] = await Promise.all([
    loadKmbIndex(),
    loadNwfbIndex(),
    loadGmbFlatList(),
    loadMtrIndex(),
  ]);
  kmbMatches = kmb;
  nwfbMatches = nwfb;
  gmbFlat = flat;
  mtrMatches = mtr;
  writeCache(kmb, nwfb, mtr, flat);
  rebuildRouteIdSet();
  indexReady = true;
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

function gmbStub({ region, routeCode }) {
  const regionLabel = GMB_REGION_LABEL[region] ?? region;
  return {
    type: 'gmb',
    routeId: routeCode,
    region,
    dest: '',
    label: `${routeCode}（${regionLabel}）`,
  };
}

/**
 * Instant in-memory search — no network.
 * @param {string} query
 * @returns {RouteSearchMatch[]}
 */
export function searchRoutesInstant(query) {
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
  for (const item of gmbFlat) {
    if (item.routeCode.toUpperCase().startsWith(q)) {
      results.push(gmbStub(item));
    }
  }

  results.sort(compareMatches);
  return results.slice(0, 60);
}

/**
 * Replace GMB stubs in a result set with enriched direction details.
 * @param {string} query
 * @param {RouteSearchMatch[]} instant
 * @returns {Promise<RouteSearchMatch[]>}
 */
export async function enrichGmbResults(query, instant) {
  const q = normalizeQuery(query);
  if (!q || !indexReady) return instant;

  const gmbStubs = instant.filter((item) => item.type === 'gmb');
  if (!gmbStubs.length) return instant;

  const toEnrich = gmbStubs
    .slice(0, GMB_ENRICH_LIMIT)
    .map((item) => ({ region: item.region, routeCode: item.routeId }));

  const enriched = await enrichGmbMatches(toEnrich);
  const nonGmb = instant.filter((item) => item.type !== 'gmb');
  const merged = [...nonGmb, ...enriched];
  merged.sort(compareMatches);
  return merged.slice(0, 60);
}

/**
 * @param {string} query
 * @returns {Promise<RouteSearchMatch[]>}
 */
export async function searchRoutes(query) {
  const instant = searchRoutesInstant(query);
  return enrichGmbResults(query, instant);
}

/**
 * @param {RouteSearchMatch} match
 * @returns {Promise<import('./transit-api.js').RouteStopConfig>}
 */
export async function resolveRouteStop(match) {
  switch (match.type) {
    case 'kmb': {
      const bound = match.bound === 'I' ? 'inbound' : 'outbound';
      const serviceType = match.service_type ?? 1;
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
      const dir = match.dir === 'I' ? 'inbound' : 'outbound';
      const res = await fetch(
        `https://rt.data.gov.hk/v1.1/transport/citybus-nwfb/route-stop/CTB/${match.route}/${dir}`,
      );
      const json = await res.json();
      const first = json.data?.[0];
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
      if (match.realRouteId == null || match.routeSeq == null) {
        if (!match.region) throw new Error('路線情報が不足しています');
        const cacheKey = `${match.region}:${match.routeId}`;
        let entries = gmbDetailCache.get(cacheKey);
        if (!entries) {
          entries = await fetchGmbRouteEntries({ region: match.region, routeCode: match.routeId });
        }
        const routeData = entries.find((entry) => entry.realRouteId != null && entry.routeSeq != null);
        if (!routeData) throw new Error('停留所が見つかりません');
        match = {
          ...match,
          realRouteId: routeData.realRouteId,
          routeSeq: routeData.routeSeq,
        };
      }
      const res = await fetch(
        `https://data.etagmb.gov.hk/route-stop/${match.realRouteId}/${match.routeSeq}`,
      );
      const json = await res.json();
      const first = json.data?.route_stops?.[0];
      if (!first) throw new Error('停留所が見つかりません');
      return {
        type: 'gmb',
        routeId: match.routeId,
        realRouteId: String(match.realRouteId),
        stopId: String(first.stop_id),
        routeSeq: match.routeSeq,
      };
    }
    default:
      throw new Error('未対応の路線です');
  }
}
