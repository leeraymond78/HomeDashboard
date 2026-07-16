import { escapeHtml } from './utils.js';
import { isEnglish, t } from './locale.js';

const LANDSD_MAP_API = 'https://mapapi.geodata.gov.hk/gs/api/v1.0.0/xyz';
const LANDSD_ATTRIBUTION =
  '<img src="https://www.landsd.gov.hk/images/landsd_logo.svg" alt="" width="14" height="14"> Map from <a href="https://www.landsd.gov.hk/">Lands Department</a>';
const CENTERLINE_QUERY =
  'https://portal.csdi.gov.hk/server/rest/services/common/td_rcd_1638949160594_2844/MapServer/10/query';
const LEAFLET_CSS = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css';
const LEAFLET_JS = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js';

const SPEED = {
  slowMax: 25,
  moderateMax: 45,
};

/** @type {import('leaflet').Map | null} */
let map = null;
/** @type {import('leaflet').LayerGroup | null} */
let layerGroup = null;
/** @type {AbortController | null} */
let fetchAbort = null;
let leafletLoading = null;

/**
 * @param {'good' | 'moderate' | 'bad' | 'unknown'} level
 */
function levelColor(level) {
  if (level === 'good') return '#7dff9a';
  if (level === 'moderate') return '#e0b84a';
  if (level === 'bad') return '#ff6b6b';
  return '#8a8a8a';
}

/**
 * @param {number | null | undefined} speed
 * @returns {'good' | 'moderate' | 'bad' | 'unknown'}
 */
function speedLevel(speed) {
  if (speed == null || !Number.isFinite(speed)) return 'unknown';
  if (speed < SPEED.slowMax) return 'bad';
  if (speed < SPEED.moderateMax) return 'moderate';
  return 'good';
}

function ensureDialog() {
  let dialog = document.getElementById('traffic-map-dialog');
  if (dialog) return /** @type {HTMLDialogElement} */ (dialog);

  dialog = document.createElement('dialog');
  dialog.id = 'traffic-map-dialog';
  dialog.className = 'traffic-map-dialog';
  dialog.innerHTML = `
    <div class="traffic-map-sheet">
      <header class="traffic-map-head">
        <div class="traffic-map-titles">
          <h2 id="traffic-map-title" class="traffic-map-title"></h2>
          <p id="traffic-map-sub" class="traffic-map-sub"></p>
        </div>
        <button type="button" class="traffic-map-close" id="traffic-map-close" aria-label="">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
            <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
          </svg>
        </button>
      </header>
      <div class="traffic-map-legend" aria-hidden="true">
        <span class="traffic-level-good">${escapeHtml(t('traffic.level.good'))}</span>
        <span class="traffic-level-moderate">${escapeHtml(t('traffic.level.moderate'))}</span>
        <span class="traffic-level-bad">${escapeHtml(t('traffic.level.bad'))}</span>
      </div>
      <div id="traffic-map" class="traffic-map" role="presentation"></div>
      <div id="traffic-map-status" class="traffic-map-status" aria-live="polite"></div>
      <ul id="traffic-map-hotspots" class="traffic-map-hotspots"></ul>
    </div>`;
  document.body.appendChild(dialog);

  const close = () => {
    fetchAbort?.abort();
    dialog.close();
  };
  dialog.querySelector('#traffic-map-close')?.addEventListener('click', close);
  dialog.addEventListener('click', (e) => {
    if (e.target === dialog) close();
  });
  dialog.addEventListener('close', () => {
    fetchAbort?.abort();
  });
  return /** @type {HTMLDialogElement} */ (dialog);
}

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const existing = document.querySelector(`script[src="${src}"]`);
    if (existing) {
      if (window.L) resolve();
      else existing.addEventListener('load', () => resolve(), { once: true });
      return;
    }
    const el = document.createElement('script');
    el.src = src;
    el.async = true;
    el.onload = () => resolve();
    el.onerror = () => reject(new Error(`Failed to load ${src}`));
    document.head.appendChild(el);
  });
}

function loadCss(href) {
  if (document.querySelector(`link[href="${href}"]`)) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const el = document.createElement('link');
    el.rel = 'stylesheet';
    el.href = href;
    el.onload = () => resolve();
    el.onerror = () => reject(new Error(`Failed to load ${href}`));
    document.head.appendChild(el);
  });
}

function ensureLeaflet() {
  if (window.L) return Promise.resolve();
  if (!leafletLoading) {
    leafletLoading = Promise.all([loadCss(LEAFLET_CSS), loadScript(LEAFLET_JS)]);
  }
  return leafletLoading;
}

function initMap() {
  const L = window.L;
  const container = document.getElementById('traffic-map');
  if (!L || !container) return;
  if (map) {
    map.invalidateSize();
    return;
  }
  map = L.map(container, { zoomControl: false, minZoom: 10 });
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
  layerGroup = L.layerGroup().addTo(map);
  L.control.zoom({ position: 'bottomright' }).addTo(map);
}

/**
 * @param {number[]} rids
 * @param {number} size
 */
function chunk(rids, size) {
  /** @type {number[][]} */
  const out = [];
  for (let i = 0; i < rids.length; i += size) out.push(rids.slice(i, i + size));
  return out;
}

/**
 * @param {number[]} rids
 * @param {AbortSignal} signal
 */
async function fetchCenterlines(rids, signal) {
  if (!rids.length) return [];
  const where = rids.map((id) => `ROUTE_ID=${id}`).join(' OR ');
  const params = new URLSearchParams({
    where,
    outFields: 'ROUTE_ID,STREET_CNAME,STREET_ENAME',
    returnGeometry: 'true',
    outSR: '4326',
    f: 'geojson',
  });
  const res = await fetch(`${CENTERLINE_QUERY}?${params}`, { signal });
  if (!res.ok) throw new Error(`centerline ${res.status}`);
  const data = await res.json();
  return Array.isArray(data.features) ? data.features : [];
}

/**
 * Prefer congested segments first so the map shows 塞車 quickly.
 * @param {number[]} rids
 * @param {Map<number, number>} speedByRid
 */
function prioritizeRids(rids, speedByRid) {
  const unique = [...new Set(rids)];
  const rank = (id) => {
    const level = speedLevel(speedByRid.get(id));
    if (level === 'bad') return 0;
    if (level === 'moderate') return 1;
    if (level === 'good') return 2;
    return 3;
  };
  return unique.sort((a, b) => rank(a) - rank(b) || a - b);
}

/**
 * @param {any[]} features
 * @param {Map<number, number>} speedByRid
 */
function drawFeatures(features, speedByRid) {
  const L = window.L;
  if (!L || !layerGroup || !map) return;
  /** @type {import('leaflet').LatLngBounds | null} */
  let bounds = null;

  for (const feature of features) {
    const rid = Number(feature?.properties?.ROUTE_ID);
    const speed = speedByRid.get(rid);
    const level = speedLevel(speed);
    const color = levelColor(level);
    const street = isEnglish()
      ? (feature.properties?.STREET_ENAME || feature.properties?.STREET_CNAME || '')
      : (feature.properties?.STREET_CNAME || feature.properties?.STREET_ENAME || '');
    const speedLabel = speed != null ? `${Math.round(speed)} km/h` : '—';
    const tip = [street, speedLabel].filter(Boolean).join(' · ');

    const layer = L.geoJSON(feature, {
      style: {
        color,
        weight: level === 'bad' ? 7 : level === 'moderate' ? 5 : 4,
        opacity: level === 'unknown' ? 0.45 : 0.9,
        lineCap: 'round',
        lineJoin: 'round',
      },
    });
    if (tip) layer.bindTooltip(tip, { sticky: true, className: 'traffic-map-tooltip' });
    layer.addTo(layerGroup);
    const b = layer.getBounds?.();
    if (b?.isValid()) bounds = bounds ? bounds.extend(b) : b;
  }

  if (bounds?.isValid()) {
    map.fitBounds(bounds, { padding: [28, 28], maxZoom: 15 });
  }
}

/**
 * @param {number[]} rids
 * @param {Map<number, number>} speedByRid
 */
function renderHotspots(rids, speedByRid) {
  const list = document.getElementById('traffic-map-hotspots');
  if (!list) return;

  const rows = [...new Set(rids)]
    .map((rid) => ({ rid, speed: speedByRid.get(rid) }))
    .filter((r) => r.speed != null && speedLevel(r.speed) === 'bad')
    .sort((a, b) => (a.speed ?? 99) - (b.speed ?? 99))
    .slice(0, 8);

  if (!rows.length) {
    list.innerHTML = `<li class="traffic-map-hotspot-empty">${escapeHtml(t('traffic.map.noHotspots'))}</li>`;
    return;
  }

  list.innerHTML = rows.map((r) => `
    <li>
      <span class="traffic-level-bad">${escapeHtml(t('traffic.map.slowSegment', { speed: Math.round(/** @type {number} */ (r.speed)) }))}</span>
      <span class="traffic-map-hotspot-id">#${r.rid}</span>
    </li>`).join('');
}

/**
 * Update hotspot street names after geometries load.
 * @param {any[]} features
 * @param {Map<number, number>} speedByRid
 */
function enrichHotspots(features, speedByRid) {
  const list = document.getElementById('traffic-map-hotspots');
  if (!list) return;
  /** @type {Map<string, { street: string, speed: number }>} */
  const byStreet = new Map();
  for (const f of features) {
    const rid = Number(f?.properties?.ROUTE_ID);
    const speed = speedByRid.get(rid);
    if (speed == null || speedLevel(speed) !== 'bad') continue;
    const street = isEnglish()
      ? (f.properties?.STREET_ENAME || f.properties?.STREET_CNAME || `#${rid}`)
      : (f.properties?.STREET_CNAME || f.properties?.STREET_ENAME || `#${rid}`);
    const prev = byStreet.get(street);
    if (!prev || speed < prev.speed) byStreet.set(street, { street, speed });
  }

  const rows = [...byStreet.values()]
    .sort((a, b) => a.speed - b.speed)
    .slice(0, 8);

  if (!rows.length) {
    renderHotspots([], speedByRid);
    return;
  }

  list.innerHTML = rows.map((r) => `
    <li>
      <span class="traffic-map-hotspot-name">${escapeHtml(r.street)}</span>
      <span class="traffic-level-bad">${escapeHtml(t('traffic.map.slowSegment', { speed: Math.round(r.speed) }))}</span>
    </li>`).join('');
}

/**
 * @param {{
 *   title: string,
 *   subtitle?: string,
 *   rids: number[],
 *   speedByRid: Map<number, number>,
 *   waypoints?: { lat: number, long: number }[],
 * }} options
 */
export async function openTrafficMap(options) {
  const dialog = ensureDialog();
  const titleEl = dialog.querySelector('#traffic-map-title');
  const subEl = dialog.querySelector('#traffic-map-sub');
  const statusEl = dialog.querySelector('#traffic-map-status');
  const closeBtn = dialog.querySelector('#traffic-map-close');

  if (titleEl) titleEl.textContent = options.title;
  if (subEl) subEl.textContent = options.subtitle || t('traffic.map.hint');
  if (closeBtn) closeBtn.setAttribute('aria-label', t('traffic.map.close'));
  if (statusEl) statusEl.textContent = t('traffic.map.loading');
  renderHotspots(options.rids, options.speedByRid);

  // Refresh legend labels for locale
  const legend = dialog.querySelector('.traffic-map-legend');
  if (legend) {
    legend.innerHTML = `
      <span class="traffic-level-good">${escapeHtml(t('traffic.level.good'))}</span>
      <span class="traffic-level-moderate">${escapeHtml(t('traffic.level.moderate'))}</span>
      <span class="traffic-level-bad">${escapeHtml(t('traffic.level.bad'))}</span>`;
  }

  if (!dialog.open) dialog.showModal();

  try {
    await ensureLeaflet();
    initMap();
    layerGroup?.clearLayers();
    map?.invalidateSize();

    const L = window.L;
    if (L && layerGroup && options.waypoints?.length) {
      const latlngs = options.waypoints.map((p) => [p.lat, p.long]);
      L.polyline(latlngs, {
        color: '#4d9fff',
        weight: 2,
        opacity: 0.55,
        dashArray: '6 8',
      }).addTo(layerGroup);
      options.waypoints.forEach((p, i) => {
        L.circleMarker([p.lat, p.long], {
          radius: 5,
          color: '#4d9fff',
          weight: 2,
          fillColor: '#fff',
          fillOpacity: 0.9,
        }).addTo(layerGroup).bindTooltip(`${i + 1}`, { permanent: false });
      });
    }

    fetchAbort?.abort();
    fetchAbort = new AbortController();
    const { signal } = fetchAbort;

    const ordered = prioritizeRids(options.rids, options.speedByRid);
    if (!ordered.length) {
      if (statusEl) statusEl.textContent = t('traffic.map.noSegments');
      return;
    }

    /** @type {any[]} */
    const allFeatures = [];
    const batches = chunk(ordered, 18);
    let done = 0;

    for (const batch of batches) {
      if (signal.aborted) return;
      try {
        const features = await fetchCenterlines(batch, signal);
        allFeatures.push(...features);
        drawFeatures(features, options.speedByRid);
      } catch (err) {
        if (signal.aborted) return;
        console.warn('traffic map batch failed', err);
      }
      done += 1;
      if (statusEl) {
        statusEl.textContent = t('traffic.map.progress', {
          loaded: String(Math.min(ordered.length, done * 18)),
          total: String(ordered.length),
        });
      }
    }

    enrichHotspots(allFeatures, options.speedByRid);
    if (statusEl) {
      const slow = allFeatures.filter((f) => speedLevel(options.speedByRid.get(Number(f.properties?.ROUTE_ID))) === 'bad').length;
      statusEl.textContent = allFeatures.length
        ? t('traffic.map.ready', { count: String(allFeatures.length), slow: String(slow) })
        : t('traffic.map.noSegments');
    }
    requestAnimationFrame(() => map?.invalidateSize());
  } catch (err) {
    if (statusEl) statusEl.textContent = t('traffic.map.error');
    console.warn(err);
  }
}
