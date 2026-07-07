import { distanceM, getUserPosition, requestUserPosition } from './location.js';
import { escapeAttr, escapeHtml } from './utils.js';
import {
  clearMtrCache,
  fetchEtas,
  fetchRouteStops,
  formatTime,
  operatorClass,
  parseRouteStop,
  routeTitle,
} from './transit-api.js';

const REFRESH_INTERVAL_MS = 15_000;

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

function initMap() {
  if (map) return;
  map = L.map('bus-map', {
    zoomControl: false,
    attributionControl: false,
  });
  L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
    maxZoom: 19,
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
    map.setView([focus.lat, focus.lng], 14);
    if (coords.length > 1) {
      map.fitBounds(L.latLngBounds(coords), { padding: [24, 24], maxZoom: 15 });
    }
  }
}

function renderEtaList(etas) {
  if (!etas.length) {
    return '<div class="bus-stop-empty">情報なし</div>';
  }
  return etas.map((eta) => `
    <div class="bus-eta-item ${eta.etaClass}">
      <span class="bus-eta-mins">${eta.mins > 0 ? `${eta.mins}分` : '到着'}</span>
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
      map?.setView([stop.lat, stop.lng], 15, { animate: true });
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
      row.mins = Math.max(0, Math.round((row.etaTime - now) / 60000));
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

  if (!routeStop?.type) {
    document.getElementById('bus-title').textContent = '路線が見つかりません';
    document.getElementById('bus-stops').innerHTML = '<div class="error-msg">無効なリンクです</div>';
    return;
  }

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
