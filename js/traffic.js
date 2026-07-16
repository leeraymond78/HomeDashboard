import { escapeHtml } from './utils.js';
import { isEnglish, t } from './locale.js';
import { openTrafficMap } from './traffic-map.js';

const TDAS_ROUTE = 'https://tdas-api.hkemobility.gov.hk/tdas/api/route';
const SEGMENT_SPEED_URL = 'https://resource.data.one.gov.hk/td/traffic-detectors/irnAvgSpeed-all.xml';
const NEWS_URL = {
  en: 'https://resource.data.one.gov.hk/td/en/specialtrafficnews.xml',
  tc: 'https://resource.data.one.gov.hk/td/tc/specialtrafficnews.xml',
};
const CACHE_KEY = 'homedashboard-tdas-260x';
const TDAS_COOLDOWN_KEY = 'homedashboard-tdas-cooldown';

/**
 * Map waypoints follow 260X (outbound ≠ inbound in Kowloon).
 * Drive-time ETA is a single TDAS point-to-point (GC ⇄ Hung Hom) — not chained.
 */
const WAYPOINTS = {
  goldCoast: { lat: 22.3725, long: 113.9950 },
  tmBbiOut: { lat: 22.3629, long: 114.0155 },
  tmBbiIn: { lat: 22.3581, long: 114.0192 },
  cantonRoad: { lat: 22.2975, long: 114.1690 },
  // Inbound urban (KMB 260X inbound stop coords)
  hungHom: { lat: 22.303925, long: 114.182325 },
  middleRoad: { lat: 22.296050, long: 114.172172 },
  nathanMosque: { lat: 22.298903, long: 114.171945 },
  nathanParkLane: { lat: 22.301864, long: 114.171726 },
  nathanAustin: { lat: 22.303693, long: 114.171628 },
  jordanBattery: { lat: 22.305524, long: 114.168430 },
  jordanHsr: { lat: 22.305945, long: 114.166374 },
};

/** Outbound map path: GC → TM BBI → 廣東道 → Hung Hom */
const OUTBOUND_WAYPOINTS = [
  WAYPOINTS.goldCoast,
  WAYPOINTS.tmBbiOut,
  WAYPOINTS.cantonRoad,
  WAYPOINTS.hungHom,
];

/** Inbound map path: Hung Hom → 中間道 → 彌敦道 → 佐敦 → TM BBI → GC */
const INBOUND_WAYPOINTS = [
  WAYPOINTS.hungHom,
  WAYPOINTS.middleRoad,
  WAYPOINTS.nathanMosque,
  WAYPOINTS.nathanParkLane,
  WAYPOINTS.nathanAustin,
  WAYPOINTS.jordanBattery,
  WAYPOINTS.jordanHsr,
  WAYPOINTS.tmBbiIn,
  WAYPOINTS.goldCoast,
];

/** Fallback IRN ROUTE_IDs (GC→TST corridor) when TDAS/cache has no rids. */
const SEED_OUTBOUND_RIDS = [
  115997, 115996, 94155, 99319, 94045, 93954, 261504, 93955, 96964, 94070, 96972, 93909, 94913,
  94915, 93910, 94601, 95147, 95148, 96660, 95149, 94447, 94448, 260219, 260220, 95349, 279248,
  279247, 96634, 97116, 96632, 279252, 97118, 279251, 96957, 97119, 94706, 96626, 95356, 96625,
  279259, 96936, 279258, 279257, 279256, 279255, 96623, 96879, 96619, 93863, 96917, 96912, 96880,
  96612, 93803, 93804, 96606, 96816, 279265, 279264, 109126, 109125, 279283, 93425, 96580, 96577,
  96587, 96596, 163662, 163665, 163667, 163672, 59660, 57187, 9452, 8731, 9719, 296699, 7441, 7495,
  8807, 8149, 7710, 8680, 8045, 9319, 8320, 9642, 9662, 7407, 279748, 106833, 106832, 106841,
  107157, 106830, 106826, 279835, 105100, 104925, 105253, 105177, 104372, 104994, 105211, 105212,
  105091, 105093, 109940, 109939, 105094, 105064, 105068, 104601, 104602, 105066, 105079, 105144,
  104323, 105149, 104155, 104336, 104335, 104177, 104178, 104152, 109865, 105118, 105120,
];

/** Fallback IRN ROUTE_IDs (Hung Hom → GC, Middle Rd / Nathan inbound) when TDAS/cache has no rids. */
const SEED_INBOUND_RIDS = [
  164133, 104368, 104325, 104441, 104443, 104423, 104603, 109891, 119293, 105084, 109941, 109942,
  105083, 105095, 105240, 105252, 104924, 279836, 105099, 285647, 106710, 106881, 105507, 105494,
  285186, 285187, 105740, 284796, 284799, 284803, 284804, 106937, 106735, 106736, 107044, 106153,
  107062, 106233, 106185, 107060, 8030, 8691, 8659, 9619, 9384, 8034, 8340, 7480,
  9611, 7811, 8769, 8428, 8117, 9450, 7472, 9700, 8781, 9745, 9403, 8090,
  7735, 97225, 96035, 96852, 96604, 96607, 93851, 96893, 96920, 96618, 96888, 96622,
  165371, 279263, 279262, 279261, 279260, 97332, 96627, 97333, 165372, 96624, 95299, 94704,
  94712, 110902, 110672, 94698, 96043, 96044, 272746, 96047, 94940, 94938, 94939, 94935,
  94937, 94686, 94684, 94685, 272744, 94678, 94714, 94677, 94690, 272644, 272646, 94931,
  94932, 94924, 108592, 95082, 94923, 95351, 96630, 95352, 94920, 94922, 94921, 94918,
  260614, 260755, 260613, 96058,
];

/** @type {Record<'outbound' | 'inbound', number[]>} */
const SEED_RIDS = {
  outbound: SEED_OUTBOUND_RIDS,
  inbound: SEED_INBOUND_RIDS,
};

const TRAFFIC = {
  refreshMs: 5 * 60 * 1000,
  newsLimit: 4,
  slowMax: 25,
  moderateMax: 45,
  cacheMaxAgeMs: 6 * 60 * 60 * 1000,
  /** Gap between the two direction POSTs only */
  legGapMs: 600,
  tdasCooldownMs: 8 * 60 * 1000,
};
/**
 * News only for Gold Coast → 屯門公路巴士轉乘站, and 260X (屯門公路) corridor.
 * Exclude Kowloon urban / HK Island incidents.
 */
const NEWS_KEYWORDS = [
  // Gold Coast → BB Interchange (Castle Peak Road west)
  '黃金海岸', '黄金海岸', '掃管笏', '三聖', '青山灣', '小欖', '踏石角',
  '屯門公路巴士轉乘站', '屯門公路轉車站', '屯門公路轉乘',
  // 260X / Tuen Mun Road express corridor
  '屯門公路', '寶田', '大興', '良景', '山景', '建生', '兆康',
  'Tuen Mun Road', 'Gold Coast', 'So Kwun Wat',
  'Sam Shing', 'Po Tin', 'Tai Hing',
  // 260X urban approach
  '廣東道', 'Canton Road', '中間道', 'Middle Road',
  '彌敦道', 'Nathan Road', '佐敦', 'Jordan',
  '西九龍', 'West Kowloon', '紅磡站', 'Hung Hom Station',
];

const NEWS_EXCLUDE = [
  // Off-corridor / other modes
  '渡輪', '航線', 'ferry', '機場快綫', '東涌綫', '港鐵公司', 'MTR',
  '珀麗灣', 'Park Island', '馬灣', 'Ma Wan',
  // Off 260X path noise (keep 旺角／油麻地 — north of Jordan on Nathan)
  '漆咸', 'Chatham', '黃泥涌', 'Wong Nai Chung', '龍翔', 'Lung Cheung',
  '彩虹', 'Choi Hung', '海底隧道', 'Cross Harbour', '東區海底', '西區海底',
  '旺角', 'Mong Kok', '油麻地', 'Yau Ma Tei',
  '九龍公園徑', 'Kowloon Park Drive',
  '溫思勞', '暢行道', '港島', 'Hong Kong Island',
];

/** @type {number | null} */
let trafficRefreshId = null;
let trafficExpanded = false;

/** @type {{
 *   outbound: { label: string, rids: number[], etaMins: number | null, jSpeed: string, distU: string },
 *   inbound: { label: string, rids: number[], etaMins: number | null, jSpeed: string, distU: string },
 *   speedByRid: Map<number, number>,
 * } | null} */
let trafficMapState = null;

const CHEVRON_SVG = `
  <svg class="chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
    <polyline points="6 9 12 15 18 9"/>
  </svg>`;

/**
 * @param {'good' | 'moderate' | 'bad' | 'unknown'} level
 */
function levelClass(level) {
  if (level === 'good') return 'traffic-level-good';
  if (level === 'moderate') return 'traffic-level-moderate';
  if (level === 'bad') return 'traffic-level-bad';
  return 'traffic-level-unknown';
}

/**
 * @param {number} speed
 * @returns {'good' | 'moderate' | 'bad'}
 */
function speedLevel(speed) {
  if (speed < TRAFFIC.slowMax) return 'bad';
  if (speed < TRAFFIC.moderateMax) return 'moderate';
  return 'good';
}

/**
 * @param {string} eta
 * @returns {number | null}
 */
function parseEtaMinutes(eta) {
  if (!eta || typeof eta !== 'string') return null;
  const parts = eta.split(':').map((v) => parseInt(v, 10));
  if (parts.length < 2 || parts.some((n) => !Number.isFinite(n))) return null;
  if (parts.length === 3) return parts[0] * 60 + parts[1] + (parts[2] >= 30 ? 1 : 0);
  return parts[0] * 60 + parts[1];
}

/**
 * @param {number | null} mins
 */
function formatDuration(mins) {
  if (mins == null) return t('traffic.unavailable');
  if (mins < 60) return t('traffic.mins', { count: mins });
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m ? t('traffic.hoursMins', { hours: h, mins: m }) : t('traffic.hours', { hours: h });
}

/**
 * TDAS often returns Chinese units (公里 / 公里/小時) even when the UI is English.
 * Always reformat to SI labels for display.
 * @param {string} raw
 * @param {'dist' | 'speed'} kind
 */
function formatTdasMeasure(raw, kind) {
  if (!raw) return '';
  const num = String(raw).match(/[\d.]+/)?.[0];
  if (!num) return raw;
  return kind === 'dist' ? `${num} km` : `${num} km/h`;
}

/**
 * @param {unknown} body
 * @returns {{ eta: string, etaMins: number | null, distU: string, jSpeed: string, rids: number[] } | null}
 */
function parseTdasRoute(body) {
  if (!body || typeof body !== 'object') return null;
  const data = /** @type {Record<string, unknown>} */ (body);
  if (typeof data.Message === 'string' && !data.eta) return null;
  const eta = typeof data.eta === 'string' ? data.eta : '';
  if (!eta) return null;
  const distU = typeof data.distU === 'string' ? data.distU : '';
  const jSpeed = typeof data.jSpeed === 'string' ? data.jSpeed : '';
  /** @type {number[]} */
  const rids = [];
  const routes = Array.isArray(data.route) ? data.route : [];
  for (const route of routes) {
    if (!route || typeof route !== 'object') continue;
    const segments = Array.isArray(/** @type {Record<string, unknown>} */ (route).segment)
      ? /** @type {Record<string, unknown>} */ (route).segment
      : [];
    for (const seg of segments) {
      if (!seg || typeof seg !== 'object') continue;
      const ids = /** @type {Record<string, unknown>} */ (seg).rid;
      if (!Array.isArray(ids)) continue;
      for (const id of ids) {
        const n = Number(id);
        if (Number.isFinite(n)) rids.push(n);
      }
    }
  }
  return { eta, etaMins: parseEtaMinutes(eta), distU, jSpeed, rids };
}

/**
 * @param {{ lat: number, long: number }} start
 * @param {{ lat: number, long: number }} end
 */
function tdasOnCooldown() {
  try {
    const until = Number(localStorage.getItem(TDAS_COOLDOWN_KEY));
    return Number.isFinite(until) && Date.now() < until;
  } catch {
    return false;
  }
}

function markTdasCooldown() {
  try {
    localStorage.setItem(TDAS_COOLDOWN_KEY, String(Date.now() + TRAFFIC.tdasCooldownMs));
  } catch {
    /* ignore */
  }
}

function clearTdasCooldown() {
  try {
    localStorage.removeItem(TDAS_COOLDOWN_KEY);
  } catch {
    /* ignore */
  }
}

async function fetchTdasRoute(start, end) {
  const res = await fetch(TDAS_ROUTE, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      start,
      end,
      lang: isEnglish() ? 'en' : 'tc',
    }),
  });
  if (res.status === 403 || res.status === 429) {
    markTdasCooldown();
    throw new Error(`TDAS ${res.status}`);
  }
  if (!res.ok) throw new Error(`TDAS ${res.status}`);
  clearTdasCooldown();
  return parseTdasRoute(await res.json());
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * @param {number | null} mins
 */
function etaStringFromMins(mins) {
  if (mins == null || !Number.isFinite(mins)) return '';
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return `${h}:${String(m).padStart(2, '0')}:00`;
}

/**
 * One TDAS call; keep ETA/dist/speed only.
 * Route geometry follows car shortest path — map uses 260X waypoints + seed rids.
 * @param {{ lat: number, long: number }} start
 * @param {{ lat: number, long: number }} end
 */
async function fetchTdasEta(start, end) {
  if (tdasOnCooldown()) return null;
  try {
    const leg = await fetchTdasRoute(start, end);
    if (!leg) return null;
    return { ...leg, rids: [] };
  } catch {
    return null;
  }
}

/**
 * Point-to-point drive times: Gold Coast ⇄ Hung Hom (2 POSTs).
 * @returns {Promise<{ outbound: ReturnType<typeof parseTdasRoute>, inbound: ReturnType<typeof parseTdasRoute> }>}
 */
async function fetchTdasBothWays() {
  const outbound = await fetchTdasEta(WAYPOINTS.goldCoast, WAYPOINTS.hungHom);
  if (tdasOnCooldown()) return { outbound, inbound: null };
  await sleep(TRAFFIC.legGapMs);
  const inbound = await fetchTdasEta(WAYPOINTS.hungHom, WAYPOINTS.goldCoast);
  return { outbound, inbound };
}

/**
 * @param {string} xmlText
 * @returns {Map<number, number>}
 */
function parseSegmentSpeeds(xmlText) {
  const doc = new DOMParser().parseFromString(xmlText, 'application/xml');
  /** @type {Map<number, number>} */
  const map = new Map();
  for (const seg of doc.querySelectorAll('segment')) {
    const valid = seg.querySelector('valid')?.textContent?.trim();
    if (valid !== 'Y') continue;
    const id = Number(seg.querySelector('segment_id')?.textContent?.trim());
    const speed = Number(seg.querySelector('speed')?.textContent?.trim());
    if (!Number.isFinite(id) || !Number.isFinite(speed)) continue;
    map.set(id, speed);
  }
  return map;
}

/**
 * @param {number[]} rids
 * @param {Map<number, number>} speedByRid
 */
function summarizeCongestion(rids, speedByRid) {
  let good = 0;
  let moderate = 0;
  let bad = 0;
  let matched = 0;
  let minSpeed = Infinity;
  for (const rid of rids) {
    const speed = speedByRid.get(rid);
    if (speed == null) continue;
    matched += 1;
    if (speed < minSpeed) minSpeed = speed;
    const level = speedLevel(speed);
    if (level === 'good') good += 1;
    else if (level === 'moderate') moderate += 1;
    else bad += 1;
  }
  /** @type {'good' | 'moderate' | 'bad' | 'unknown'} */
  let overall = 'unknown';
  if (matched) {
    const badRatio = bad / matched;
    const modRatio = moderate / matched;
    // Ratio-only: an absolute "bad >= 3" falsely marks long corridors
    // as 渋滞 when only a few local segments are slow (e.g. 3%).
    if (badRatio >= 0.2) overall = 'bad';
    else if (badRatio >= 0.08 || modRatio + badRatio >= 0.3) overall = 'moderate';
    else overall = 'good';
  }
  return {
    good,
    moderate,
    bad,
    matched,
    minSpeed: Number.isFinite(minSpeed) ? minSpeed : null,
    overall,
  };
}

/**
 * @param {string} xmlText
 */
function parseTrafficNews(xmlText) {
  const doc = new DOMParser().parseFromString(xmlText, 'application/xml');
  const ns = 'http://data.one.gov.hk/td';
  const messages = [...doc.getElementsByTagNameNS(ns, 'message')];
  const list = (messages.length ? messages : [...doc.getElementsByTagName('message')])
    .map((msg) => {
      const eng = msg.getElementsByTagNameNS(ns, 'EngText')[0]?.textContent
        ?? msg.querySelector('EngText')?.textContent
        ?? '';
      const chin = msg.getElementsByTagNameNS(ns, 'ChinText')[0]?.textContent
        ?? msg.querySelector('ChinText')?.textContent
        ?? '';
      const text = (isEnglish() ? eng : chin) || eng || chin;
      return {
        text: text.replace(/\s+/g, ' ').trim(),
        blob: `${eng} ${chin}`,
      };
    })
    .filter((m) => m.text);

  const lowerIncludes = (blob, kw) => blob.toLowerCase().includes(kw.toLowerCase());

  return list
    .filter((m) => NEWS_KEYWORDS.some((kw) => lowerIncludes(m.blob, kw)))
    .filter((m) => !NEWS_EXCLUDE.some((kw) => lowerIncludes(m.blob, kw)))
    .slice(0, TRAFFIC.newsLimit);
}

/**
 * @param {{ overall: string, etaMins: number | null, jSpeed: string, stale?: boolean }} outbound
 */
function previewText(outbound) {
  const parts = [];
  if (outbound.etaMins != null) {
    parts.push(formatDuration(outbound.etaMins));
    if (outbound.stale) parts.push(t('traffic.stale'));
  }
  if (outbound.overall === 'good') parts.push(t('traffic.level.good'));
  else if (outbound.overall === 'moderate') parts.push(t('traffic.level.moderate'));
  else if (outbound.overall === 'bad') parts.push(t('traffic.level.bad'));
  else if (outbound.jSpeed) parts.push(outbound.jSpeed);
  return parts.join(' · ') || t('traffic.newsOnly');
}

/**
 * @param {{ good: number, moderate: number, bad: number, matched: number }} cong
 */
function renderCongestionBar(cong) {
  if (!cong.matched) {
    return `<p class="traffic-note">${escapeHtml(t('traffic.noSegmentSpeeds'))}</p>`;
  }
  const total = cong.matched;
  const pct = (n) => `${Math.round((n / total) * 100)}%`;
  return `
    <div class="traffic-cong" aria-hidden="true">
      <div class="traffic-cong-bar">
        ${cong.good ? `<span class="traffic-cong-good" style="flex:${cong.good}"></span>` : ''}
        ${cong.moderate ? `<span class="traffic-cong-moderate" style="flex:${cong.moderate}"></span>` : ''}
        ${cong.bad ? `<span class="traffic-cong-bad" style="flex:${cong.bad}"></span>` : ''}
      </div>
      <div class="traffic-cong-legend">
        <span class="traffic-level-good">${escapeHtml(t('traffic.level.good'))} ${pct(cong.good)}</span>
        <span class="traffic-level-moderate">${escapeHtml(t('traffic.level.moderate'))} ${pct(cong.moderate)}</span>
        <span class="traffic-level-bad">${escapeHtml(t('traffic.level.bad'))} ${pct(cong.bad)}</span>
      </div>
    </div>`;
}

/**
 * @param {{ label: string, etaMins: number | null, distU: string, jSpeed: string, overall: string, minSpeed: number | null, stale?: boolean, direction: 'outbound' | 'inbound' }} leg
 */
function renderLeg(leg) {
  const hasLevel = leg.overall === 'good' || leg.overall === 'moderate' || leg.overall === 'bad';
  const levelLabel =
    leg.overall === 'good' ? t('traffic.level.good')
      : leg.overall === 'moderate' ? t('traffic.level.moderate')
        : leg.overall === 'bad' ? t('traffic.level.bad')
          : '';
  const etaHtml = leg.etaMins != null
    ? `<span class="traffic-leg-eta ${levelClass(/** @type {'good'|'moderate'|'bad'|'unknown'} */ (leg.overall))}">${escapeHtml(
      `${formatDuration(leg.etaMins)}${leg.stale ? ` (${t('traffic.stale')})` : ''}`,
    )}</span>`
    : '';
  return `
    <button type="button" class="traffic-leg traffic-leg-btn" data-traffic-dir="${leg.direction}">
      <div class="traffic-leg-head">
        <span class="traffic-leg-label">${escapeHtml(leg.label)}</span>
        ${etaHtml}
      </div>
      <div class="traffic-leg-meta">
        ${leg.distU ? `<span>${escapeHtml(leg.distU)}</span>` : ''}
        ${leg.jSpeed ? `<span>${escapeHtml(leg.jSpeed)}</span>` : ''}
        ${hasLevel ? `<span class="${levelClass(/** @type {'good'|'moderate'|'bad'|'unknown'} */ (leg.overall))}">${escapeHtml(levelLabel)}</span>` : ''}
        ${leg.minSpeed != null ? `<span>${escapeHtml(t('traffic.minSpeed', { speed: Math.round(leg.minSpeed) }))}</span>` : ''}
        <span class="traffic-leg-map-hint">${escapeHtml(t('traffic.map.tap'))}</span>
      </div>
    </button>`;
}

/**
 * @param {{ text: string }[]} news
 */
function renderNews(news) {
  if (!news.length) {
    return `<p class="traffic-note">${escapeHtml(t('traffic.noNews'))}</p>`;
  }
  return `
    <ul class="traffic-news-list">
      ${news.map((n) => `<li>${escapeHtml(n.text)}</li>`).join('')}
    </ul>`;
}

function syncTrafficOpen(root) {
  root.classList.toggle('open', trafficExpanded);
  const header = root.querySelector('.traffic-header');
  if (header) header.setAttribute('aria-expanded', String(trafficExpanded));
  const inner = root.querySelector('.group-body-inner');
  if (inner) {
    inner.toggleAttribute('inert', !trafficExpanded);
    inner.setAttribute('aria-hidden', String(!trafficExpanded));
  }
}

function bindTrafficToggle(root) {
  if (root.dataset.toggleBound) return;
  root.addEventListener('click', (e) => {
    const mapBtn = e.target.closest('[data-traffic-dir]');
    if (mapBtn) {
      e.preventDefault();
      e.stopPropagation();
      const dir = mapBtn.getAttribute('data-traffic-dir');
      if (dir === 'outbound' || dir === 'inbound') openMapForDirection(dir);
      return;
    }
    const btn = e.target.closest('.traffic-header');
    if (!btn) return;
    trafficExpanded = !trafficExpanded;
    syncTrafficOpen(root);
  });
  root.dataset.toggleBound = '1';
}

/**
 * @param {'outbound' | 'inbound'} direction
 */
function openMapForDirection(direction) {
  if (!trafficMapState) return;
  const leg = trafficMapState[direction];
  if (!leg) return;
  const rids = leg.rids?.length ? leg.rids : SEED_RIDS[direction];
  const etaPart = leg.etaMins != null ? formatDuration(leg.etaMins) : '';
  const sub = [etaPart, leg.distU, leg.jSpeed].filter(Boolean).join(' · ');
  void openTrafficMap({
    title: leg.label,
    subtitle: sub || t('traffic.map.hint'),
    rids,
    speedByRid: trafficMapState.speedByRid,
    waypoints: direction === 'outbound' ? OUTBOUND_WAYPOINTS : INBOUND_WAYPOINTS,
  });
}

/**
 * @param {object | null} cache
 * @param {'outbound' | 'inbound'} key
 */
function cachedLeg(cache, key) {
  const leg = cache?.[key];
  if (!leg || typeof leg !== 'object') return null;
  const eta = typeof leg.eta === 'string' ? leg.eta : '';
  const etaMins = typeof leg.etaMins === 'number' && Number.isFinite(leg.etaMins)
    ? leg.etaMins
    : parseEtaMinutes(eta);
  return {
    eta,
    etaMins,
    distU: typeof leg.distU === 'string' ? leg.distU : '',
    jSpeed: typeof leg.jSpeed === 'string' ? leg.jSpeed : '',
    rids: Array.isArray(leg.rids) ? leg.rids.map(Number).filter(Number.isFinite) : [],
  };
}

function readCache() {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const data = JSON.parse(raw);
    if (!data || typeof data.ts !== 'number') return null;
    if (Date.now() - data.ts > TRAFFIC.cacheMaxAgeMs) return null;
    return data;
  } catch {
    return null;
  }
}

/**
 * @param {ReturnType<typeof parseTdasRoute>} outbound
 * @param {ReturnType<typeof parseTdasRoute>} inbound
 */
function writeCache(outbound, inbound) {
  if (!outbound && !inbound) return;
  try {
    const prev = readCache() || {};
    localStorage.setItem(CACHE_KEY, JSON.stringify({
      ts: Date.now(),
      outbound: outbound ? {
        eta: outbound.eta || etaStringFromMins(outbound.etaMins),
        etaMins: outbound.etaMins,
        distU: outbound.distU,
        jSpeed: outbound.jSpeed,
        rids: outbound.rids,
      } : prev.outbound,
      inbound: inbound ? {
        eta: inbound.eta || etaStringFromMins(inbound.etaMins),
        etaMins: inbound.etaMins,
        distU: inbound.distU,
        jSpeed: inbound.jSpeed,
        rids: inbound.rids,
      } : prev.inbound,
    }));
  } catch {
    /* ignore quota */
  }
}

/**
 * @param {HTMLElement | null} root
 * @param {object | null} vm
 * @param {{ state?: 'loading' | 'error' | 'ready' }} [opts]
 */
function renderTrafficSection(root, vm, { state = 'ready' } = {}) {
  if (!root) return;
  root.className = 'traffic-section group';

  if (state === 'loading') {
    root.innerHTML = `
      <button class="group-header traffic-header" type="button" aria-expanded="false" disabled>
        <span class="group-title">${escapeHtml(t('traffic.title'))}</span>
        <span class="group-trailing">
          <span class="traffic-preview">${escapeHtml(t('traffic.loading'))}</span>
          ${CHEVRON_SVG}
        </span>
      </button>`;
    syncTrafficOpen(root);
    return;
  }

  if (state === 'error' || !vm) {
    root.innerHTML = `
      <button class="group-header traffic-header" type="button" aria-expanded="false">
        <span class="group-title">${escapeHtml(t('traffic.title'))}</span>
        <span class="group-trailing">
          <span class="traffic-preview traffic-preview-severe">${escapeHtml(t('traffic.unavailable'))}</span>
          ${CHEVRON_SVG}
        </span>
      </button>
      <div class="group-body traffic-body">
        <div class="group-body-inner">
          <div class="traffic-error error-msg">${escapeHtml(t('traffic.error'))}</div>
        </div>
      </div>`;
    bindTrafficToggle(root);
    syncTrafficOpen(root);
    return;
  }

  const previewCls = vm.outbound.overall === 'bad'
    ? 'traffic-preview traffic-preview-severe'
    : 'traffic-preview';

  root.innerHTML = `
    <button class="group-header traffic-header" type="button" aria-expanded="false">
      <span class="group-title">${escapeHtml(t('traffic.title'))}</span>
      <span class="group-trailing">
        <span class="${previewCls}">${escapeHtml(vm.preview)}</span>
        ${CHEVRON_SVG}
      </span>
    </button>
    <p class="traffic-desc">${escapeHtml(t('traffic.corridor'))}</p>
    <div class="group-body traffic-body">
      <div class="group-body-inner">
        ${vm.tdasPartial ? `<p class="traffic-note traffic-note-pad">${escapeHtml(t('traffic.tdasPartial'))}</p>` : ''}
        ${renderLeg(vm.outbound)}
        ${renderLeg(vm.inbound)}
        <div class="traffic-details">
          <div class="traffic-detail-label">${escapeHtml(t('traffic.alongRoute'))}</div>
          ${renderCongestionBar(vm.outbound)}
        </div>
        <div class="traffic-details">
          <div class="traffic-detail-label">${escapeHtml(t('traffic.news'))}</div>
          ${renderNews(vm.news)}
        </div>
        <p class="traffic-source">${escapeHtml(t('traffic.source'))}</p>
      </div>
    </div>`;

  bindTrafficToggle(root);
  syncTrafficOpen(root);
}

/**
 * @param {ReturnType<typeof parseTdasRoute>} live
 * @param {ReturnType<typeof cachedLeg>} cached
 * @param {number[]} seedRids
 */
function resolveLeg(live, cached, seedRids = []) {
  if (live) {
    return {
      ...live,
      stale: false,
      rids: live.rids?.length ? live.rids : seedRids,
    };
  }
  if (cached) {
    return {
      ...cached,
      stale: true,
      rids: cached.rids?.length ? cached.rids : seedRids,
    };
  }
  return {
    eta: '',
    etaMins: null,
    distU: '',
    jSpeed: '',
    rids: seedRids,
    stale: false,
  };
}

export async function loadTrafficSection() {
  const root = document.getElementById('traffic-section');
  if (!root) return;

  renderTrafficSection(root, null, { state: 'loading' });

  try {
    const newsUrl = isEnglish() ? NEWS_URL.en : NEWS_URL.tc;
    const cache = readCache();

    const [speedXml, newsXml, tdas] = await Promise.all([
      fetch(SEGMENT_SPEED_URL).then((r) => (r.ok ? r.text() : '')).catch(() => ''),
      fetch(newsUrl).then((r) => (r.ok ? r.text() : '')).catch(() => ''),
      fetchTdasBothWays().catch(() => ({ outbound: null, inbound: null })),
    ]);

    if (tdas.outbound || tdas.inbound) writeCache(tdas.outbound, tdas.inbound);

    const outboundLive = resolveLeg(
      tdas.outbound,
      cachedLeg(cache, 'outbound'),
      SEED_OUTBOUND_RIDS,
    );
    const inboundLive = resolveLeg(
      tdas.inbound,
      cachedLeg(cache, 'inbound'),
      SEED_INBOUND_RIDS,
    );

    const speedByRid = speedXml ? parseSegmentSpeeds(speedXml) : new Map();
    const outCong = summarizeCongestion(outboundLive.rids, speedByRid);
    const inCong = summarizeCongestion(inboundLive.rids, speedByRid);
    const news = newsXml ? parseTrafficNews(newsXml) : [];

    const hasDrive = outboundLive.etaMins != null || inboundLive.etaMins != null;
    const hasCongestion = outCong.matched > 0 || inCong.matched > 0;
    // Soft-fail: speeds/news/seed map still useful when TDAS is rate-limited (403).
    if (!hasDrive && !hasCongestion && !news.length && !speedXml) {
      renderTrafficSection(root, null, { state: 'error' });
      return;
    }

    const outbound = {
      label: t('traffic.toTst'),
      direction: /** @type {const} */ ('outbound'),
      etaMins: outboundLive.etaMins,
      distU: formatTdasMeasure(outboundLive.distU, 'dist'),
      jSpeed: formatTdasMeasure(outboundLive.jSpeed, 'speed'),
      overall: outCong.overall,
      minSpeed: outCong.minSpeed,
      good: outCong.good,
      moderate: outCong.moderate,
      bad: outCong.bad,
      matched: outCong.matched,
      stale: Boolean(outboundLive.stale && outboundLive.etaMins != null),
    };
    const inbound = {
      label: t('traffic.toGoldCoast'),
      direction: /** @type {const} */ ('inbound'),
      etaMins: inboundLive.etaMins,
      distU: formatTdasMeasure(inboundLive.distU, 'dist'),
      jSpeed: formatTdasMeasure(inboundLive.jSpeed, 'speed'),
      overall: inCong.overall,
      minSpeed: inCong.minSpeed,
      stale: Boolean(inboundLive.stale && inboundLive.etaMins != null),
    };

    trafficMapState = {
      outbound: {
        label: outbound.label,
        rids: outboundLive.rids,
        etaMins: outbound.etaMins,
        jSpeed: outbound.jSpeed,
        distU: outbound.distU,
      },
      inbound: {
        label: inbound.label,
        rids: inboundLive.rids,
        etaMins: inbound.etaMins,
        jSpeed: inbound.jSpeed,
        distU: inbound.distU,
      },
      speedByRid,
    };

    renderTrafficSection(root, {
      preview: previewText(outbound),
      outbound,
      inbound,
      news,
      tdasPartial: outbound.etaMins == null && inbound.etaMins == null,
    }, { state: 'ready' });
  } catch {
    renderTrafficSection(root, null, { state: 'error' });
  }
}

export function startTrafficRefresh() {
  if (trafficRefreshId) clearInterval(trafficRefreshId);
  trafficRefreshId = setInterval(() => {
    if (document.hidden) return;
    loadTrafficSection();
  }, TRAFFIC.refreshMs);
}
