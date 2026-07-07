/** @typedef {{ type: string, [key: string]: unknown }} RouteStopConfig */
/** @typedef {{ seq: number, stopId: string, name: string, lat: number | null, lng: number | null }} RouteStopInfo */
/** @typedef {{ routeId: string, operator: string, express: { text: string, cls: string }, routeClass: string, time: string, dest: string, mins: number, remark: string, etaClass: string, etaTime: Date, routeStop?: RouteStopConfig }} EtaRow */

export const MTR_DEST = {
  FT: '富泰',
  TL: '大欖',
  SKWT: '掃管笏',
  SKW_CIR: '掃管笏',
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

/** @type {Map<string, object>} */
const mtrCache = new Map();
/** @type {Map<string, string>} */
const gmbDestCache = new Map();
/** @type {Map<string, { lat: number, lng: number, name: string }>} */
const stopDetailCache = new Map();
/** @type {Map<string, { nameChi: string, lat: number, lng: number, direction: string, seq: number }> | null} */
let mtrCsvByStopId = null;

export function operatorClass(op) {
  return { kmb: 'color-kmb', mtr: 'color-mtr', gmb: 'color-gmb', nwfb: 'color-nwfb', socif: 'color-socif' }[op] ?? '';
}

function isAirport(routeId) {
  return routeId.startsWith('A');
}

export function expressInfo(routeId, operator) {
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

export function translateRemark(operator, raw, isScheduled) {
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

export function etaColorClass(isScheduled, remark) {
  if (isScheduled) return 'eta-scheduled';
  if (remark) return 'eta-error';
  return 'eta-normal';
}

export function formatTime(date) {
  return date.toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
}

export function mtrRouteFromStopId(stopId) {
  return stopId.split('-')[0];
}

function mtrDirectionFromStopId(stopId) {
  return stopId.includes('-D') ? 'I' : 'O';
}

function mtrDestFromLineRef(lineRef) {
  const suffix = lineRef.split('_').slice(1).join('_');
  return MTR_DEST[suffix] ?? suffix;
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

export function clearMtrCache() {
  mtrCache.clear();
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

async function fetchKmbStop(stopId) {
  const cached = stopDetailCache.get(`kmb:${stopId}`);
  if (cached) return cached;
  const res = await fetch(`https://data.etabus.gov.hk/v1/transport/kmb/stop/${stopId}`);
  const json = await res.json();
  const d = json.data;
  const info = { lat: parseFloat(d.lat), lng: parseFloat(d.long), name: d.name_tc };
  stopDetailCache.set(`kmb:${stopId}`, info);
  return info;
}

async function fetchNwfbStop(stopId) {
  const cached = stopDetailCache.get(`nwfb:${stopId}`);
  if (cached) return cached;
  const res = await fetch(`https://rt.data.gov.hk/v1.1/transport/citybus-nwfb/stop/${stopId}`);
  const json = await res.json();
  const d = json.data;
  const info = { lat: parseFloat(d.lat), lng: parseFloat(d.long), name: d.name_tc };
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
    name: json.data.name_tc,
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

async function loadMtrStops() {
  if (mtrCsvByStopId) return mtrCsvByStopId;
  const res = await fetch('data/mtr-bus-stops.json');
  if (!res.ok) throw new Error('MTR停留所データを読み込めません');
  const data = await res.json();
  mtrCsvByStopId = new Map(Object.entries(data));
  return mtrCsvByStopId;
}

export async function fetchKmbEtas(routeStop) {
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
      routeStop,
    }));
}

export async function fetchNwfbEtas(routeStop) {
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
      routeStop,
    }));
}

export async function fetchMtrEtas(routeStop) {
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
      routeStop,
    };
  });
}

export async function fetchSocifEtas(routeStop) {
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
      routeStop,
    };
  });
}

export async function fetchGmbEtas(routeStop) {
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

export async function fetchKmbRouteStops(routeStop) {
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

export async function fetchNwfbRouteStops(routeStop) {
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

export async function fetchMtrRouteStops(routeStop) {
  const route = mtrRouteFromStopId(routeStop.stopId);
  const direction = mtrDirectionFromStopId(routeStop.stopId);
  const dirPrefix = direction === 'I' ? '-D' : '-U';
  const csv = await loadMtrStops();
  const schedule = await fetchMtrSchedule(route);
  const orderedIds = schedule
    .map((s) => s.busStopId)
    .filter((id) => id.includes(dirPrefix));

  /** @type {RouteStopInfo[]} */
  const stops = [];
  let seq = 0;
  for (const stopId of orderedIds) {
    seq += 1;
    const csvRow = csv.get(stopId);
    const geo = MTR_GEO[stopId];
    stops.push({
      seq,
      stopId,
      name: csvRow?.nameChi ?? stopId,
      lat: csvRow?.lat ?? geo?.lat ?? null,
      lng: csvRow?.lng ?? geo?.lng ?? null,
    });
  }
  return stops;
}

export async function fetchGmbRouteStops(routeStop) {
  const url = `https://data.etagmb.gov.hk/route-stop/${routeStop.realRouteId}/${routeStop.routeSeq}`;
  const res = await fetch(url);
  const json = await res.json();
  const items = json.data?.route_stops ?? [];
  /** @type {RouteStopInfo[]} */
  const stops = [];
  for (const item of items) {
    const stopId = String(item.stop_id);
    const detail = await fetchGmbStop(stopId);
    stops.push({
      seq: item.stop_seq,
      stopId,
      name: item.name_tc || detail.name,
      lat: detail.lat,
      lng: detail.lng,
    });
  }
  return stops.sort((a, b) => a.seq - b.seq);
}

export async function fetchSocifRouteStops(routeStop) {
  const url = `https://360-api.socif.co/api/route-stop/${routeStop.route}/${routeStop.routeSeq}`;
  const res = await fetch(url);
  const json = await res.json();
  const items = json.data?.route_stops ?? [];
  /** @type {RouteStopInfo[]} */
  const stops = [];
  for (const item of items) {
    const stopId = String(item.stop_id);
    let lat = null;
    let lng = null;
    const geoKey = `${routeStop.route}-${routeStop.routeSeq}-${item.stop_seq}`;
    if (SOCIF_GEO[geoKey]) {
      lat = SOCIF_GEO[geoKey].lat;
      lng = SOCIF_GEO[geoKey].lng;
    } else {
      try {
        const detail = await fetchSocifStop(stopId);
        lat = detail.lat;
        lng = detail.lng;
      } catch {
        /* ignore */
      }
    }
    stops.push({
      seq: item.stop_seq,
      stopId,
      name: item.name_tc,
      lat,
      lng,
    });
  }
  return stops.sort((a, b) => a.seq - b.seq);
}

export async function fetchRouteStops(routeStop) {
  switch (routeStop.type) {
    case 'kmb': return fetchKmbRouteStops(routeStop);
    case 'nwfb': return fetchNwfbRouteStops(routeStop);
    case 'mtr': return fetchMtrRouteStops(routeStop);
    case 'gmb': return fetchGmbRouteStops(routeStop);
    case 'socif': return fetchSocifRouteStops(routeStop);
    default: return [];
  }
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

export async function routeTitle(routeStop, stops) {
  const lastName = stops.at(-1)?.name ?? '';
  switch (routeStop.type) {
    case 'kmb': {
      try {
        const bound = routeStop.bound === 'I' ? 'inbound' : 'outbound';
        const serviceType = routeStop.service_type ?? 1;
        const res = await fetch(`https://data.etabus.gov.hk/v1/transport/kmb/route/${routeStop.route}/${bound}/${serviceType}`);
        const json = await res.json();
        const dest = json.data?.dest_tc ?? lastName;
        return `${routeStop.route} - ${dest}`;
      } catch {
        return `${routeStop.route} - ${lastName}`;
      }
    }
    case 'mtr':
      return `${mtrRouteFromStopId(routeStop.stopId)} - ${lastName}`;
    case 'gmb':
    case 'nwfb':
    case 'socif':
      return `${routeStop.routeId ?? routeStop.route} - ${routeStop.dest ?? lastName}`;
    default:
      return '';
  }
}
