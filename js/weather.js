import { distanceM, formatDistance, getUserPosition, requestUserPosition } from './location.js';
import { escapeHtml } from './utils.js';

const HKO_API = 'https://data.weather.gov.hk/weatherAPI/opendata/weather.php';
const HKO_LANG = 'tc';

const WEATHER = {
  missing: '--',
  refreshMs: 10 * 60 * 1000,
  defaultStation: '香港天文台',
};

const ENDPOINTS = {
  current: 'rhrread',
  forecast: 'fnd',
  local: 'flw',
  warnings: 'warnsum',
};

/** HKO rhrread station coordinates (HKO CIS / data.gov.hk) */
const HKO_STATIONS = {
  京士柏: { lat: 22.3119, lng: 114.1728, en: "King's Park" },
  香港天文台: { lat: 22.3019, lng: 114.1742, en: 'Hong Kong Observatory' },
  黃竹坑: { lat: 22.2478, lng: 114.1736, en: 'Wong Chuk Hang' },
  打鼓嶺: { lat: 22.5286, lng: 114.1567, en: 'Ta Kwu Ling' },
  流浮山: { lat: 22.4689, lng: 113.9836, en: 'Lau Fau Shan' },
  大埔: { lat: 22.4461, lng: 114.1789, en: 'Tai Po' },
  沙田: { lat: 22.4025, lng: 114.2100, en: 'Sha Tin' },
  屯門: { lat: 22.3858, lng: 113.9642, en: 'Tuen Mun' },
  將軍澳: { lat: 22.3158, lng: 114.2556, en: 'Tseung Kwan O' },
  西貢: { lat: 22.3756, lng: 114.2744, en: 'Sai Kung' },
  長洲: { lat: 22.2011, lng: 114.0267, en: 'Cheung Chau' },
  赤鱲角: { lat: 22.3094, lng: 113.9220, en: 'Chek Lap Kok' },
  青衣: { lat: 22.3442, lng: 114.1100, en: 'Tsing Yi' },
  荃灣可觀: { lat: 22.3836, lng: 114.1078, en: 'Tsuen Wan Ho Koon' },
  荃灣城門谷: { lat: 22.3756, lng: 114.1267, en: 'Tsuen Wan Shing Mun Valley' },
  香港公園: { lat: 22.2783, lng: 114.1622, en: 'Hong Kong Park' },
  筲箕灣: { lat: 22.2817, lng: 114.2361, en: 'Shau Kei Wan' },
  九龍城: { lat: 22.3350, lng: 114.1847, en: 'Kowloon City' },
  跑馬地: { lat: 22.2706, lng: 114.1836, en: 'Happy Valley' },
  黃大仙: { lat: 22.3394, lng: 114.2053, en: 'Wong Tai Sin' },
  赤柱: { lat: 22.2142, lng: 114.2186, en: 'Stanley' },
  觀塘: { lat: 22.3186, lng: 114.2247, en: 'Kwun Tong' },
  深水埗: { lat: 22.3358, lng: 114.1369, en: 'Sham Shui Po' },
  啟德跑道公園: { lat: 22.3047, lng: 114.2169, en: 'Kai Tak Runway Park' },
  元朗公園: { lat: 22.4408, lng: 114.0183, en: 'Yuen Long Park' },
  大美督: { lat: 22.4753, lng: 114.2375, en: 'Tai Mei Tuk' },
};

/** rhrread temperature station → rainfall.data district */
const STATION_TO_RAINFALL_DISTRICT = {
  京士柏: '油尖旺',
  香港天文台: '油尖旺',
  黃竹坑: '南區',
  打鼓嶺: '北區',
  流浮山: '元朗',
  將軍澳: '西貢',
  長洲: '離島區',
  赤鱲角: '離島區',
  青衣: '葵青',
  荃灣可觀: '荃灣',
  荃灣城門谷: '荃灣',
  香港公園: '中西區',
  筲箕灣: '東區',
  跑馬地: '灣仔',
  啟德跑道公園: '九龍城',
  元朗公園: '元朗',
  大美督: '大埔',
  赤柱: '南區',
};

const RAINSTORM_LABELS = {
  WRAINA: '黃雨',
  WRAINR: '紅雨',
  WRAINB: '黑雨',
};

const TYPHOON_LABELS = {
  TC1: '一號',
  TC3: '三號',
  TC8NE: '八號東北',
  TC8SE: '八號東南',
  TC8SW: '八號西南',
  TC8NW: '八號西北',
  TC9: '九號',
  TC10: '十號',
  TC8: '八號',
};

/** @type {number | null} */
let weatherRefreshId = null;
let weatherExpanded = false;

const CHEVRON_SVG = `
  <svg class="chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
    <polyline points="6 9 12 15 18 9"/>
  </svg>`;

const HKO_APP_LINK = `
  <a class="weather-hko-btn" href="myobservatory://">開啟「我的天文台」App 查看更多</a>`;

function hkoUrl(dataType) {
  return `${HKO_API}?dataType=${dataType}&lang=${HKO_LANG}`;
}

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function resolvePosition() {
  const cached = getUserPosition();
  if (cached) return cached;
  return requestUserPosition();
}

function availableStations(rhrread) {
  return new Set((rhrread?.temperature?.data ?? []).map((row) => row.place));
}

function resolveNearestStation(position, rhrread) {
  const places = availableStations(rhrread);
  const candidates = Object.entries(HKO_STATIONS)
    .filter(([place]) => places.has(place))
    .map(([place, geo]) => ({ place, ...geo }));

  if (!candidates.length) return null;

  const fallbackPlace = places.has(WEATHER.defaultStation)
    ? WEATHER.defaultStation
    : candidates[0].place;
  const fallback = candidates.find((c) => c.place === fallbackPlace) ?? candidates[0];

  if (!position?.coords) {
    return { ...fallback, distanceM: null, usedGps: false };
  }

  const user = { lat: position.coords.latitude, lng: position.coords.longitude };
  let nearest = null;
  let minDist = Infinity;

  for (const station of candidates) {
    const dist = distanceM(user, station);
    if (dist < minDist) {
      minDist = dist;
      nearest = { ...station, distanceM: dist, usedGps: true };
    }
  }

  return nearest ?? { ...fallback, distanceM: null, usedGps: false };
}

function buildLocationNote(station) {
  if (!station) return '';
  if (station.usedGps && station.distanceM != null) {
    return `依您目前位置，最近氣象站為${station.place}（約 ${formatDistance(station.distanceM)}）`;
  }
  return `無法取得定位，使用預設氣象站（${station.place}）`;
}

function pickTemperature(data, place) {
  const rows = data?.temperature?.data ?? [];
  const match = rows.find((row) => row.place === place);
  if (match?.value != null) {
    return { value: match.value, unit: match.unit ?? 'C', place: match.place };
  }
  return null;
}

function pickHumidity(data) {
  const rows = data?.humidity?.data ?? [];
  const match = rows.find((row) => row.value != null);
  if (!match) return null;
  return { value: match.value, unit: match.unit ?? 'percent', place: match.place ?? '' };
}

function rainfallDistrictForStation(stationPlace, rhrread) {
  const rows = rhrread?.rainfall?.data ?? [];
  const places = new Set(rows.map((row) => row.place));
  if (places.has(stationPlace)) return stationPlace;
  const mapped = STATION_TO_RAINFALL_DISTRICT[stationPlace];
  if (mapped && places.has(mapped)) return mapped;
  return null;
}

function pickRainfall(rhrread, stationPlace) {
  const district = rainfallDistrictForStation(stationPlace, rhrread);
  if (!district) return null;
  const match = rhrread.rainfall.data.find((row) => row.place === district);
  if (match?.max == null) return null;
  return {
    max: match.max,
    min: match.min,
    unit: match.unit ?? 'mm',
    place: match.place,
  };
}

function formatRainfall(rainfall) {
  if (!rainfall) return WEATHER.missing;
  const unit = rainfall.unit || 'mm';
  if (rainfall.min != null && rainfall.min !== rainfall.max) {
    return `${rainfall.min}–${rainfall.max}${unit}`;
  }
  return `${rainfall.max}${unit}`;
}

function hkoDateKey(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}${m}${d}`;
}

function tomorrowKey() {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  return hkoDateKey(d);
}

function findForecastDay(forecast, dateKey) {
  return (forecast?.weatherForecast ?? []).find((day) => day.forecastDate === dateKey) ?? null;
}

function formatTempRange(max, min) {
  const hi = max?.value;
  const lo = min?.value;
  if (hi == null && lo == null) return WEATHER.missing;
  if (hi != null && lo != null) return `${lo}–${hi}°C`;
  if (hi != null) return `${hi}°C`;
  return `${lo}°C`;
}

function formatUpdateTime(iso) {
  if (!iso) return WEATHER.missing;
  try {
    return new Date(iso).toLocaleString('zh-HK', {
      month: 'numeric',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
  } catch {
    return WEATHER.missing;
  }
}

function warningPreviewLabel({ code, name }) {
  if (code === 'WRAINA') return '🟡黃雨';
  if (code === 'WRAINR') return '🔴紅雨';
  if (code === 'WRAINB') return '⚫黑雨';
  if (code === 'WTS') return '⚡️雷暴';
  if (TYPHOON_LABELS[code]) return `🌀${TYPHOON_LABELS[code]}`;
  if (name) return name.replace(/(警告|信號)+$/g, '');
  return code || WEATHER.missing;
}

function warningLabel(code, name) {
  if (RAINSTORM_LABELS[code]) return `暴雨警告：${RAINSTORM_LABELS[code]}`;
  if (TYPHOON_LABELS[code]) return `颱風信號：${TYPHOON_LABELS[code]}`;
  return name || code || WEATHER.missing;
}

function isSevereWarning(code) {
  return code === 'WRAINR' || code === 'WRAINB' || code === 'TC9' || code === 'TC10'
    || code?.startsWith('TC8');
}

function parseWarnings(warnsum) {
  if (!warnsum || typeof warnsum !== 'object') return [];
  return Object.entries(warnsum)
    .filter(([, item]) => item && item.actionCode !== 'CANCEL')
    .map(([, item]) => ({
      code: item.code ?? '',
      name: item.name ?? '',
      label: warningLabel(item.code, item.name),
      severe: isSevereWarning(item.code),
      issueTime: item.issueTime ?? item.updateTime ?? '',
    }))
    .sort((a, b) => a.label.localeCompare(b.label, 'zh-Hant'));
}

function warningSummary(warnings) {
  if (!warnings.length) return '';
  return warnings.map((w) => warningPreviewLabel(w)).join(' ');
}

function buildWeatherViewModel({ rhrread, fnd, flw, warnsum, errors, station }) {
  const temp = station ? pickTemperature(rhrread, station.place) : null;
  const humidity = pickHumidity(rhrread);
  const todayKey = hkoDateKey();
  const todayForecast = findForecastDay(fnd, todayKey);
  const tomorrowForecast = findForecastDay(fnd, tomorrowKey());
  const firstForecast = fnd?.weatherForecast?.[0] ?? null;
  const todayTemps = todayForecast ?? (firstForecast?.forecastDate === todayKey ? firstForecast : null);
  const rainfall = station ? pickRainfall(rhrread, station.place) : null;

  const warnings = parseWarnings(warnsum);
  const typhoonInfo = (flw?.tcInfo ?? '').trim();
  const otherAlerts = [
    ...warnings.map((w) => w.label),
    ...(typhoonInfo && !warnings.some((w) => w.code?.startsWith('TC'))
      ? [`熱帶氣旋：${typhoonInfo}`]
      : []),
  ];

  const humidityNote = humidity?.place && humidity.place !== station?.place
    ? `濕度資料來自${humidity.place}`
    : '';
  const rainfallNote = rainfall?.place && rainfall.place !== station?.place
    ? `雨量資料來自${rainfall.place}`
    : '';

  const updateCandidates = [
    rhrread?.updateTime,
    rhrread?.rainfall?.endTime,
    fnd?.updateTime,
    flw?.updateTime,
    ...warnings.map((w) => w.issueTime),
  ].filter(Boolean);

  const dataNote = [buildLocationNote(station), humidityNote, rainfallNote].filter(Boolean).join('；');

  return {
    headerTitle: `${station?.place ?? WEATHER.missing} · ${temp?.value != null ? `${temp.value}°C` : WEATHER.missing}`,
    location: station?.place ?? WEATHER.missing,
    locationEn: station?.en ?? '',
    dataNote,
    temperature: temp?.value != null ? `${temp.value}°C` : WEATHER.missing,
    weatherDesc: (flw?.forecastDesc ?? '').trim() || WEATHER.missing,
    humidity: humidity?.value != null ? `${humidity.value}%` : WEATHER.missing,
    rainfall: formatRainfall(rainfall),
    todayHighLow: formatTempRange(todayTemps?.forecastMaxtemp, todayTemps?.forecastMintemp),
    tomorrowSummary: tomorrowForecast
      ? `${tomorrowForecast.week} ${tomorrowForecast.forecastWeather}`.trim()
      : WEATHER.missing,
    warnings,
    warningSummary: warningSummary(warnings),
    typhoonInfo: typhoonInfo || WEATHER.missing,
    otherAlerts,
    updateTime: formatUpdateTime(updateCandidates.sort().pop()),
    errors,
    partial: Boolean(errors.length),
  };
}

function renderStat(label, value, { emphasis = false } = {}) {
  return `
    <div class="weather-stat${emphasis ? ' weather-stat-emphasis' : ''}">
      <div class="weather-stat-label">${escapeHtml(label)}</div>
      <div class="weather-stat-value">${escapeHtml(value)}</div>
    </div>`;
}

function syncWeatherOpen(root) {
  root.classList.toggle('open', weatherExpanded);
  const header = root.querySelector('.weather-header');
  if (header) header.setAttribute('aria-expanded', String(weatherExpanded));
  const inner = root.querySelector('.group-body-inner');
  if (inner) {
    inner.toggleAttribute('inert', !weatherExpanded);
    inner.setAttribute('aria-hidden', String(!weatherExpanded));
  }
}

function bindWeatherToggle(root) {
  if (root.dataset.toggleBound) return;
  root.addEventListener('click', (e) => {
    const btn = e.target.closest('.weather-header');
    if (!btn) return;
    weatherExpanded = !weatherExpanded;
    syncWeatherOpen(root);
  });
  root.dataset.toggleBound = '1';
}

function renderWeatherSection(root, vm, { state = 'ready' } = {}) {
  if (!root) return;

  root.className = 'weather-section group';

  if (state === 'loading') {
    root.innerHTML = `
      <button class="group-header weather-header" type="button" aria-expanded="false" disabled>
        <span class="group-title">天氣</span>
        <span class="group-trailing">
          <span class="weather-preview">載入中…</span>
          ${CHEVRON_SVG}
        </span>
      </button>`;
    syncWeatherOpen(root);
    return;
  }

  if (state === 'error' && !vm) {
    root.innerHTML = `
      <button class="group-header weather-header" type="button" aria-expanded="false">
        <span class="group-title">天氣</span>
        <span class="group-trailing">
          <span class="weather-preview weather-preview-severe">無法取得</span>
          ${CHEVRON_SVG}
        </span>
      </button>
      <div class="group-body weather-body">
        <div class="group-body-inner">
          <div class="weather-error error-msg">天氣資料暫時無法取得</div>
          ${HKO_APP_LINK}
        </div>
      </div>`;
    bindWeatherToggle(root);
    syncWeatherOpen(root);
    return;
  }

  const warnChips = vm.warnings.length
    ? vm.warnings.map((w) => `
        <span class="weather-warn-chip${w.severe ? ' weather-warn-chip-severe' : ''}">${escapeHtml(w.label)}</span>
      `).join('')
    : '<span class="weather-warn-chip weather-warn-chip-clear">無生效警告</span>';

  const alertLines = vm.otherAlerts
    .filter((line) => line && line !== WEATHER.missing)
    .map((line) => `<li>${escapeHtml(line)}</li>`)
    .join('');

  const previewClass = vm.warnings.some((w) => w.severe)
    ? 'weather-preview weather-preview-severe'
    : 'weather-preview';

  root.innerHTML = `
    <button class="group-header weather-header" type="button" aria-expanded="false">
      <span class="group-title">${escapeHtml(vm.headerTitle)}</span>
      <span class="group-trailing">
        <span class="${previewClass}">${escapeHtml(vm.warningSummary)}</span>
        ${CHEVRON_SVG}
      </span>
    </button>
    <p class="weather-desc">${escapeHtml(vm.weatherDesc)}</p>
    <div class="group-body weather-body">
      <div class="group-body-inner">
        ${vm.dataNote ? `<p class="weather-note">${escapeHtml(vm.dataNote)}</p>` : ''}
        <div class="weather-summary" role="list">
          ${renderStat('相對濕度', vm.humidity)}
          ${renderStat('降雨量', vm.rainfall)}
        </div>
        <div class="weather-details">
          <div class="weather-detail-row">
            <span class="weather-detail-label">今日最高／最低</span>
            <span class="weather-detail-value">${escapeHtml(vm.todayHighLow)}</span>
          </div>
          <div class="weather-detail-row">
            <span class="weather-detail-label">明天</span>
            <span class="weather-detail-value">${escapeHtml(vm.tomorrowSummary)}</span>
          </div>
          ${vm.warnings.length || alertLines ? `
          <div class="weather-warnings">
            <div class="weather-detail-label">生效警告</div>
            <div class="weather-warn-chips">${warnChips}</div>
            ${alertLines ? `<ul class="weather-alert-list">${alertLines}</ul>` : ''}
          </div>` : ''}
        </div>
        ${HKO_APP_LINK}
      </div>
    </div>`;

  bindWeatherToggle(root);
  syncWeatherOpen(root);
}

async function fetchWeatherSources() {
  const tasks = Object.entries(ENDPOINTS).map(async ([key, dataType]) => {
    try {
      const data = await fetchJson(hkoUrl(dataType));
      return { key, data, error: null };
    } catch (err) {
      return { key, data: null, error: err };
    }
  });
  return Promise.all(tasks);
}

export async function loadWeatherSection() {
  const root = document.getElementById('weather-section');
  if (!root) return;

  renderWeatherSection(root, null, { state: 'loading' });

  const position = await resolvePosition();
  const results = await fetchWeatherSources();
  const byKey = Object.fromEntries(results.map((r) => [r.key, r]));
  const errors = results.filter((r) => r.error).map((r) => r.key);

  const hasAnyData = results.some((r) => r.data);
  if (!hasAnyData) {
    renderWeatherSection(root, null, { state: 'error' });
    return;
  }

  const station = resolveNearestStation(position, byKey.current?.data);
  const vm = buildWeatherViewModel({
    rhrread: byKey.current?.data,
    fnd: byKey.forecast?.data,
    flw: byKey.local?.data,
    warnsum: byKey.warnings?.data,
    errors,
    station,
  });

  renderWeatherSection(root, vm, { state: 'ready' });
}

export function startWeatherRefresh() {
  if (weatherRefreshId) clearInterval(weatherRefreshId);
  weatherRefreshId = setInterval(() => {
    loadWeatherSection();
  }, WEATHER.refreshMs);
}
