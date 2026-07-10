/** @typedef {{ location: { lat: number, lng: number }, name: { zh: string, en: string } }} FareStopEntry */

const ROUTE_FARE_LIST_URL = 'https://data.hkbus.app/routeFareList.min.json';
const IDB_NAME = 'homedashboard-fare-db';
const IDB_STORE = 'routeFare';
const IDB_KEY = 'current';
const IDB_VERSION = 1;

/** @type {import('./route-fare-db.js').RouteFareDb | null} */
let cachedDb = null;
/** @type {Promise<import('./route-fare-db.js').RouteFareDb> | null} */
let loadPromise = null;
/** @type {Promise<void> | null} */
let backgroundRefreshPromise = null;

/**
 * @typedef {{
 *   routeList: Record<string, unknown>,
 *   stopList: Record<string, FareStopEntry>,
 * }} RouteFareDb
 */

function parseServiceType(value) {
  if (value == null || value === '') return 1;
  const parsed = parseInt(String(value), 10);
  return Number.isFinite(parsed) ? parsed : 1;
}

/**
 * @returns {Promise<IDBDatabase>}
 */
function openIdb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, IDB_VERSION);
    req.onerror = () => reject(req.error);
    req.onsuccess = () => resolve(req.result);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(IDB_STORE)) {
        req.result.createObjectStore(IDB_STORE);
      }
    };
  });
}

/**
 * @returns {Promise<{ routeList: Record<string, unknown>, stopList: Record<string, FareStopEntry>, savedAt?: number } | null>}
 */
async function readIdb() {
  try {
    const db = await openIdb();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, 'readonly');
      const req = tx.objectStore(IDB_STORE).get(IDB_KEY);
      req.onsuccess = () => resolve(req.result ?? null);
      req.onerror = () => reject(req.error);
    });
  } catch {
    return null;
  }
}

/**
 * @param {{ routeList: Record<string, unknown>, stopList: Record<string, FareStopEntry> }} data
 */
async function writeIdb(data) {
  try {
    const db = await openIdb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, 'readwrite');
      tx.objectStore(IDB_STORE).put({ ...data, savedAt: Date.now() }, IDB_KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    /* ignore quota / private mode */
  }
}

/**
 * @returns {Promise<RouteFareDb>}
 */
async function fetchRouteFareDbFromNetwork() {
  const res = await fetch(ROUTE_FARE_LIST_URL);
  if (!res.ok) throw new Error('路線データの取得に失敗しました');
  const json = await res.json();
  const db = {
    routeList: json.routeList ?? {},
    stopList: json.stopList ?? {},
  };
  cachedDb = db;
  await writeIdb(db);
  return db;
}

function refreshRouteFareDbInBackground() {
  if (backgroundRefreshPromise) return backgroundRefreshPromise;
  backgroundRefreshPromise = fetchRouteFareDbFromNetwork()
    .catch(() => {})
    .finally(() => {
      backgroundRefreshPromise = null;
    });
  return backgroundRefreshPromise;
}

/**
 * @returns {Promise<RouteFareDb>}
 */
export function ensureRouteFareDb() {
  if (cachedDb) return Promise.resolve(cachedDb);
  if (loadPromise) return loadPromise;

  loadPromise = (async () => {
    const idbData = await readIdb();
    if (idbData?.routeList && idbData?.stopList) {
      cachedDb = {
        routeList: idbData.routeList,
        stopList: idbData.stopList,
      };
      refreshRouteFareDbInBackground();
      return cachedDb;
    }
    return fetchRouteFareDbFromNetwork();
  })().catch((err) => {
    loadPromise = null;
    throw err;
  });

  return loadPromise;
}

/**
 * @param {string} stopId
 * @returns {FareStopEntry | null}
 */
export function getFareStop(stopId) {
  return cachedDb?.stopList?.[stopId] ?? null;
}

/**
 * hkbus routeFareList `seq` is the stop count, not etagmb `route_seq`.
 * @param {string | undefined} bound
 * @returns {number}
 */
export function gmbRouteSeqFromBound(bound) {
  if (bound === 'I' || bound === 'IO') return 2;
  return 1;
}

/**
 * @param {string[]} stopIds
 * @param {Record<string, FareStopEntry>} [stopList]
 * @param {(name: string) => string} [formatName]
 * @returns {{ seq: number, stopId: string, name: string, lat: number | null, lng: number | null }[]}
 */
export function buildRouteStopsFromFareStopIds(stopIds, stopList = cachedDb?.stopList, formatName = (n) => n) {
  /** @type {{ seq: number, stopId: string, name: string, lat: number | null, lng: number | null }[]} */
  const stops = [];
  let seq = 0;
  for (const rawId of stopIds) {
    seq += 1;
    const stopId = String(rawId);
    const fareStop = stopList?.[stopId];
    stops.push({
      seq,
      stopId,
      name: formatName(fareStop?.name?.zh ?? stopId),
      lat: fareStop?.location?.lat ?? null,
      lng: fareStop?.location?.lng ?? null,
    });
  }
  return stops;
}

/**
 * @param {import('./transit-api.js').RouteStopConfig} routeStop
 * @param {Record<string, unknown>} [routeList]
 * @returns {Record<string, unknown> | null}
 */
function findRouteFareEntry(routeStop, routeList = cachedDb?.routeList) {
  if (!routeStop?.type) return null;
  switch (routeStop.type) {
    case 'kmb':
      return findKmbRouteEntry(routeStop.route, routeStop.bound, routeStop.service_type ?? 1, routeList);
    case 'nwfb':
      return findCtbRouteEntry(routeStop.route, routeStop.dir, routeList);
    case 'gmb':
      return findGmbRouteEntry(routeStop.realRouteId, routeStop.routeSeq, routeList);
    case 'mtr':
      return findLrtfeederRouteEntry(routeStop.stopId, routeList);
    default:
      return null;
  }
}

/**
 * @param {import('./transit-api.js').RouteStopConfig} routeStop
 * @returns {string | null}
 */
function operatorCoKey(routeStop) {
  switch (routeStop.type) {
    case 'kmb': return 'kmb';
    case 'nwfb': return 'ctb';
    case 'gmb': return 'gmb';
    case 'mtr': return 'lrtfeeder';
    default: return null;
  }
}

/**
 * @param {import('./transit-api.js').RouteStopConfig} routeStop
 * @param {{ seq: number, stopId: string, name: string, lat: number | null, lng: number | null, fare?: string, fareHoliday?: string | null }[]} stops
 * @returns {Promise<typeof stops>}
 */
export async function attachFaresToRouteStops(routeStop, stops) {
  await ensureRouteFareDb();
  const entry = findRouteFareEntry(routeStop);
  const coKey = operatorCoKey(routeStop);
  if (!entry || !coKey) return stops;

  const stopIds = entry.stops?.[coKey];
  const fares = entry.fares;
  const faresHoliday = entry.faresHoliday;
  if (!Array.isArray(stopIds) || !Array.isArray(fares)) return stops;

  /** @type {Map<string, { fare?: string, fareHoliday?: string | null }>} */
  const fareByStopId = new Map();
  stopIds.forEach((id, i) => {
    const fare = fares[i];
    const fareHoliday = Array.isArray(faresHoliday) ? faresHoliday[i] : null;
    if (fare == null && fareHoliday == null) return;
    fareByStopId.set(String(id), { fare, fareHoliday });
  });

  return stops.map((stop) => {
    const row = fareByStopId.get(stop.stopId);
    if (!row?.fare && !row?.fareHoliday) return stop;
    return {
      ...stop,
      fare: row.fare,
      fareHoliday: row.fareHoliday ?? null,
    };
  });
}

/**
 * @param {string} route
 * @param {string | undefined} bound
 * @param {number} [serviceType]
 * @param {Record<string, unknown>} [routeList]
 * @returns {Record<string, unknown> | null}
 */
export function findKmbRouteEntry(route, bound, serviceType = 1, routeList = cachedDb?.routeList) {
  if (!routeList || !route) return null;
  const wantBound = bound === 'I' ? 'I' : 'O';
  const wantService = parseServiceType(serviceType);

  for (const entry of Object.values(routeList)) {
    if (!entry.co?.includes('kmb') || entry.route !== route) continue;
    if ((entry.bound?.kmb ?? 'O') !== wantBound) continue;
    if (parseServiceType(entry.serviceType) !== wantService) continue;
    const stops = entry.stops?.kmb;
    if (Array.isArray(stops) && stops.length) return entry;
  }
  return null;
}

/**
 * @param {string} route
 * @param {string | undefined} dir
 * @param {Record<string, unknown>} [routeList]
 * @returns {Record<string, unknown> | null}
 */
export function findCtbRouteEntry(route, dir, routeList = cachedDb?.routeList) {
  if (!routeList || !route) return null;
  const wantDir = dir === 'I' ? 'I' : 'O';

  for (const entry of Object.values(routeList)) {
    if (!entry.co?.includes('ctb') || entry.route !== route) continue;
    if ((entry.bound?.ctb ?? 'O') !== wantDir) continue;
    const stops = entry.stops?.ctb;
    if (Array.isArray(stops) && stops.length) return entry;
  }
  return null;
}

/**
 * @param {string | number} realRouteId
 * @param {number} routeSeq
 * @param {Record<string, unknown>} [routeList]
 * @returns {Record<string, unknown> | null}
 */
function findGmbRouteEntry(realRouteId, routeSeq, routeList = cachedDb?.routeList) {
  if (!routeList || realRouteId == null) return null;

  for (const entry of Object.values(routeList)) {
    if (!entry.co?.includes('gmb')) continue;
    if (String(entry.gtfsId) !== String(realRouteId)) continue;
    if (gmbRouteSeqFromBound(entry.bound?.gmb) !== routeSeq) continue;
    return entry;
  }
  return null;
}

/**
 * @param {string | number} realRouteId
 * @param {number} routeSeq
 * @returns {string}
 */
export function getGmbRouteDest(realRouteId, routeSeq) {
  const entry = findGmbRouteEntry(realRouteId, routeSeq);
  return entry?.dest?.zh?.trim() ?? '';
}

/**
 * Match hkbus: MTR bus uses co "lrtfeeder" with stop IDs like K51-U010.
 * @param {string} stopId
 * @param {Record<string, unknown>} [routeList]
 * @returns {Record<string, unknown> | null}
 */
export function findLrtfeederRouteEntry(stopId, routeList = cachedDb?.routeList) {
  if (!routeList || !stopId) return null;

  const route = stopId.split('-')[0];
  const wantOutbound = stopId.includes('-U');

  /** @type {{ entry: Record<string, unknown>, score: number } | null} */
  let best = null;

  for (const entry of Object.values(routeList)) {
    if (!entry.co?.includes('lrtfeeder') || entry.route !== route) continue;

    const stops = entry.stops?.lrtfeeder;
    if (!Array.isArray(stops) || !stops.includes(stopId)) continue;

    const bound = entry.bound?.lrtfeeder;
    const allowsOutbound = bound === 'O' || bound === 'OI';
    const allowsInbound = bound === 'I' || bound === 'IO';
    // U-prefix stops only appear on outbound routes in the fare DB.
    if (wantOutbound && allowsInbound && !allowsOutbound) continue;

    const serviceType = parseServiceType(entry.serviceType);
    const score = serviceType * 1000 + stops.indexOf(stopId);
    if (!best || score < best.score) best = { entry, score };
  }

  return best?.entry ?? null;
}
