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
 *   gmbSpecial?: boolean,
 *   realRouteId?: string | number,
 *   routeSeq?: number,
 *   region?: string,
 * }} RouteSearchMatch */

/** @typedef {{ phase: string, loaded: number, total: number }} RouteSearchProgress */

const GMB_REGION_LABEL = { HKI: '香港島', KLN: '九龍', NT: '新界' };
const CACHE_VERSION = 5;
const CACHE_KEY = 'homedashboard-route-search-v5';
const GMB_DETAIL_CACHE_KEY = 'homedashboard-route-search-gmb-v6';
const NWFB_INTEGRATED_URL = 'https://transport-data.open-data.hk/integrated_routes.json';
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

function nextRouteBranch(routeId, query) {
  const id = routeSortKey(routeId);
  const q = normalizeQuery(query);
  if (!q || !id.startsWith(q) || id.length <= q.length) return '';
  return id[q.length];
}

function sortRouteBranches(branches) {
  return branches.sort((a, b) => {
    const aLetter = /[A-Z]/.test(a);
    const bLetter = /[A-Z]/.test(b);
    if (aLetter !== bLetter) return aLetter ? -1 : 1;
    return a.localeCompare(b, undefined, { numeric: true });
  });
}

function diversifyBranchBucket(bucket) {
  /** @type {Map<string, RouteSearchMatch[]>} */
  const byRouteId = new Map();
  for (const item of bucket) {
    const key = routeSortKey(item.routeId);
    if (!byRouteId.has(key)) byRouteId.set(key, []);
    byRouteId.get(key).push(item);
  }

  const routeIds = [...byRouteId.keys()].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  /** @type {RouteSearchMatch[]} */
  const diversified = [];
  let round = 0;
  while (diversified.length < bucket.length) {
    let added = false;
    for (const routeId of routeIds) {
      const items = byRouteId.get(routeId);
      if (!items || round >= items.length) continue;
      diversified.push(items[round]);
      added = true;
    }
    if (!added) break;
    round += 1;
  }
  return diversified;
}

/**
 * Keep short prefix searches representative across route branches (e.g. N -> NA*, N8).
 * @param {RouteSearchMatch[]} results
 * @param {string} query
 * @param {number} [limit]
 * @returns {RouteSearchMatch[]}
 */
function limitSearchResults(results, query, limit = 60) {
  const compare = compareMatchesForQuery(query);
  const sorted = [...results].sort(compare);
  if (sorted.length <= limit) return sorted;

  const q = normalizeQuery(query);
  if (q.length > 2) return sorted.slice(0, limit);

  /** @type {Map<string, RouteSearchMatch[]>} */
  const byBranch = new Map();
  for (const item of sorted) {
    const branch = nextRouteBranch(item.routeId, q) || '_';
    if (!byBranch.has(branch)) byBranch.set(branch, []);
    byBranch.get(branch).push(item);
  }

  for (const [branch, bucket] of byBranch) {
    byBranch.set(branch, diversifyBranchBucket(bucket));
  }

  if (byBranch.size <= 1) return sorted.slice(0, limit);

  /** @type {RouteSearchMatch[]} */
  const picked = [];
  const branches = sortRouteBranches([...byBranch.keys()]);
  let round = 0;
  while (picked.length < limit) {
    let added = false;
    for (const branch of branches) {
      const bucket = byBranch.get(branch);
      if (!bucket || round >= bucket.length) continue;
      picked.push(bucket[round]);
      added = true;
      if (picked.length >= limit) break;
    }
    if (!added) break;
    round += 1;
  }

  return picked;
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

function isCtbIntegratedEntry(item) {
  if (item.co?.includes('ctb')) return true;
  if (item.operator_routes?.some((routeRef) => routeRef.startsWith('ctb|'))) return true;
  if (String(item.stops_and_alignment ?? '').includes('ctb')) return true;
  return false;
}

function dirFromIntegratedEntry(item) {
  if (item.bound?.ctb) return item.bound.ctb;
  const operatorRoute = item.operator_routes?.[0];
  if (operatorRoute) return operatorRoute.split('|')[2] ?? 'O';
  return 'O';
}

function normalizeStopLabel(name) {
  return String(name ?? '').replace(/\s+/g, '').replace(/[(),（）]/g, '').toLowerCase();
}

function stopMatchesOrig(stopName, orig) {
  const normalizedStop = normalizeStopLabel(stopName);
  const normalizedOrig = normalizeStopLabel(orig);
  if (!normalizedStop || !normalizedOrig) return false;
  return normalizedStop.includes(normalizedOrig) || normalizedOrig.includes(normalizedStop);
}

function loadNwfbFromRouteList(items) {
  return items.map((item) => ({
    type: 'nwfb',
    routeId: item.route,
    route: item.route,
    dir: 'O',
    orig: item.orig_tc,
    dest: item.dest_tc,
    label: `${item.route} 往${item.dest_tc}`,
  }));
}

function buildNwfbMatchesFromIntegrated(integrated, routeItems) {
  /** @type {Map<string, { orig_tc: string, dest_tc: string }>} */
  const routeMeta = new Map();
  for (const item of routeItems) {
    routeMeta.set(item.route.toUpperCase(), item);
  }

  /** @type {RouteSearchMatch[]} */
  const matches = [];
  /** @type {Set<string>} */
  const seen = new Set();

  for (const [, item] of Object.entries(integrated ?? {})) {
    if (!isCtbIntegratedEntry(item)) continue;

    const route = item.route ?? '';
    if (!route) continue;

    const meta = routeMeta.get(route.toUpperCase());
    let dir = dirFromIntegratedEntry(item);
    let orig = item.orig?.tc ?? '';
    let dest = item.dest?.tc ?? '';
    const nwfbSpecial = item.serviceType === 1 && Boolean(orig);

    if (nwfbSpecial && meta && normalizeStopLabel(dest) === normalizeStopLabel(meta.orig_tc)) {
      dir = 'I';
    }

    if (!orig || !dest) {
      if (!meta) continue;
      if (dir === 'I') {
        orig = meta.dest_tc;
        dest = meta.orig_tc;
      } else {
        orig = meta.orig_tc;
        dest = meta.dest_tc;
      }
    }

    const dedupeKey = `${route}:${dir}:${orig}:${dest}:${nwfbSpecial ? 1 : 0}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);

    matches.push({
      type: 'nwfb',
      routeId: route,
      route,
      dir,
      orig,
      dest,
      nwfbSpecial,
      label: `${route} 往${dest}`,
    });
  }

  return matches;
}

async function loadNwfbIndex() {
  reportProgress('nwfb', 0, 2);
  const routeRes = await fetch('https://rt.data.gov.hk/v2/transport/citybus/route/CTB');
  const routeJson = await routeRes.json();
  const routeItems = routeJson.data ?? [];
  reportProgress('nwfb', 1, 2);

  try {
    const integratedRes = await fetch(NWFB_INTEGRATED_URL);
    const integrated = await integratedRes.json();
    const matches = buildNwfbMatchesFromIntegrated(integrated, routeItems);
    if (matches.length) {
      reportProgress('nwfb', 2, 2);
      return matches;
    }
  } catch {
    /* fall back to route list only */
  }

  reportProgress('nwfb', 2, 2);
  return loadNwfbFromRouteList(routeItems);
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

function isGmbSpecialRoute(routeData) {
  const tc = String(routeData.description_tc ?? '').trim();
  const en = String(routeData.description_en ?? '').trim();
  if (tc.includes('正常')) return false;
  if (tc.includes('特別')) return true;
  return /special/i.test(en) && !/normal/i.test(en);
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
      const gmbSpecial = isGmbSpecialRoute(routeData);
      for (const dir of routeData.directions ?? []) {
        entries.push({
          type: 'gmb',
          routeId: routeCode,
          realRouteId: routeData.route_id,
          routeSeq: dir.route_seq,
          region,
          orig: dir.orig_tc,
          dest: dir.dest_tc,
          gmbSpecial,
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

  return limitSearchResults(results, q);
}

/**
 * Refine inbound Citybus origin labels using route-stop data.
 * @param {RouteSearchMatch[]} instant
 * @returns {Promise<RouteSearchMatch[]>}
 */
export async function enrichNwfbResults(instant) {
  const routesToRefine = [...new Set(
    instant
      .filter((item) => item.type === 'nwfb' && item.dir === 'I' && !item.nwfbSpecial)
      .map((item) => item.route),
  )].slice(0, GMB_ENRICH_LIMIT);

  if (!routesToRefine.length) return instant;

  /** @type {Map<string, string>} */
  const refinedOrigins = new Map();
  await Promise.all(routesToRefine.map(async (route) => {
    try {
      const [inboundRes, outboundRes] = await Promise.all([
        fetch(`https://rt.data.gov.hk/v1.1/transport/citybus-nwfb/route-stop/CTB/${route}/inbound`),
        fetch(`https://rt.data.gov.hk/v1.1/transport/citybus-nwfb/route-stop/CTB/${route}/outbound`),
      ]);
      const inboundItems = (await inboundRes.json()).data ?? [];
      const outboundItems = (await outboundRes.json()).data ?? [];
      if (!inboundItems.length || !outboundItems.length) return;

      outboundItems.sort((a, b) => parseInt(a.seq, 10) - parseInt(b.seq, 10));
      inboundItems.sort((a, b) => parseInt(a.seq, 10) - parseInt(b.seq, 10));
      const terminalStopId = outboundItems[outboundItems.length - 1]?.stop;
      const startItem = inboundItems.find((item) => item.stop === terminalStopId) ?? inboundItems[0];
      if (!startItem) return;

      const stopRes = await fetch(`https://rt.data.gov.hk/v1.1/transport/citybus-nwfb/stop/${startItem.stop}`);
      const stopJson = await stopRes.json();
      const name = stopJson.data?.name_tc;
      if (name) refinedOrigins.set(route, name);
    } catch {
      /* keep placeholder origin */
    }
  }));

  if (!refinedOrigins.size) return instant;

  return instant.map((item) => {
    if (item.type !== 'nwfb' || item.dir !== 'I' || item.nwfbSpecial || !item.route) return item;
    const orig = refinedOrigins.get(item.route);
    if (!orig) return item;
    return { ...item, orig, label: `${item.routeId} 往${item.dest}` };
  });
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
  return limitSearchResults(merged, q);
}

/**
 * @param {string} query
 * @returns {Promise<RouteSearchMatch[]>}
 */
export async function searchRoutes(query) {
  const instant = searchRoutesInstant(query);
  const withNwfb = await enrichNwfbResults(instant);
  return enrichGmbResults(query, withNwfb);
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
      const items = (json.data ?? []).sort((a, b) => parseInt(a.seq, 10) - parseInt(b.seq, 10));
      if (!items.length) throw new Error('停留所が見つかりません');

      let selected = items[0];
      if (match.nwfbSpecial && match.orig) {
        const stopDetails = await Promise.all(items.map(async (item) => {
          const detailRes = await fetch(`https://rt.data.gov.hk/v1.1/transport/citybus-nwfb/stop/${item.stop}`);
          const detailJson = await detailRes.json();
          return { item, name: detailJson.data?.name_tc ?? '' };
        }));
        selected = stopDetails.find(({ name }) => stopMatchesOrig(name, match.orig))?.item ?? selected;
      }

      return {
        type: 'nwfb',
        route: match.route,
        dir: selected.dir ?? match.dir ?? 'O',
        stop: selected.stop,
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
