import { escapeHtml } from './utils.js';
import { applyStaticI18n, initLocale, initLocaleToggle, LOCALE_CHANGE, pickLocalized, t } from './locale.js';
import { initDashboardThemeToggle } from './theme.js';
import { operatorClass, serializeRouteStop } from './transit-api.js';
import {
  ensureRouteSearchIndex,
  getAlphabetCandidates,
  isRouteSearchIndexReady,
  resolveRouteStop,
  searchRoutes,
  setRouteSearchProgressCallback,
} from './route-search-api.js';

const NUMERIC_KEYS = [
  ['1', '2', '3'],
  ['4', '5', '6'],
  ['7', '8', '9'],
];

const BACKSPACE_ICON = `<svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
  <path d="M22 3H7c-.69 0-1.23.35-1.59.88L0 12l5.41 8.11c.36.53.9.89 1.59.89h15c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm-3 12.59L17.59 17 14 13.41 10.41 17 9 15.59 12.59 12 9 8.41 10.41 7 14 10.59 17.59 7 19 8.41 15.41 12 19 15.59z"/>
</svg>`;

const OPERATOR_LABEL = {
  kmb: () => t('operator.kmb'),
  nwfb: () => t('operator.nwfb'),
  mtr: () => t('operator.mtr'),
  gmb: () => t('operator.gmb'),
};
const SEARCH_STATE_KEY = 'homedashboard-route-search-state';
const SEARCH_RESTORE_KEY = 'homedashboard-route-search-restore';

/** @type {string} */
let query = '';
/** @type {ReturnType<typeof setTimeout> | null} */
let searchTimer = null;
/** @type {boolean} */
let indexReady = false;

let inputEl;
let resultsEl;
let alphaPadEl;
let keyboardEl;
/** @type {number} */
let restoredScrollTop = 0;

function readSearchState() {
  try {
    const raw = sessionStorage.getItem(SEARCH_STATE_KEY);
    if (!raw) return null;
    const state = JSON.parse(raw);
    if (typeof state.query !== 'string') return null;
    return {
      query: state.query,
      scrollTop: Number(state.scrollTop) || 0,
    };
  } catch {
    return null;
  }
}

function saveSearchState() {
  try {
    sessionStorage.setItem(SEARCH_STATE_KEY, JSON.stringify({
      query,
      scrollTop: resultsEl?.scrollTop ?? 0,
    }));
  } catch {
    /* ignore quota / private mode */
  }
}

function markSearchForRestore() {
  try {
    sessionStorage.setItem(SEARCH_RESTORE_KEY, '1');
  } catch {
    /* ignore quota / private mode */
  }
}

function clearSearchState() {
  try {
    sessionStorage.removeItem(SEARCH_STATE_KEY);
    sessionStorage.removeItem(SEARCH_RESTORE_KEY);
  } catch {
    /* ignore quota / private mode */
  }
}

function consumeRestoreFlag() {
  try {
    const shouldRestore = sessionStorage.getItem(SEARCH_RESTORE_KEY) === '1';
    sessionStorage.removeItem(SEARCH_RESTORE_KEY);
    return shouldRestore;
  } catch {
    return false;
  }
}

function restoreResultsScroll(scrollTop) {
  if (!scrollTop || !resultsEl) return;
  const apply = () => {
    resultsEl.scrollTop = scrollTop;
  };
  apply();
  requestAnimationFrame(apply);
}

function operatorLabel(type) {
  return OPERATOR_LABEL[type]?.() ?? type;
}

function formatMatchDest(match) {
  const dest = pickLocalized(match.dest, match.destEn);
  if (dest) return t('search.dest', { dest });
  return match.label.replace(/^[^\s]+\s*/, '');
}

function isSpecialService(match) {
  if (match.type === 'kmb') return match.service_type != null && match.service_type !== 1;
  if (match.type === 'nwfb') return Boolean(match.nwfbSpecial);
  if (match.type === 'mtr') return Boolean(match.mtrSpecial);
  if (match.type === 'gmb') return Boolean(match.gmbSpecial);
  return false;
}

function formatMatchOrig(match) {
  return pickLocalized(match.orig, match.origEn);
}

function navigateToBus(routeStop) {
  saveSearchState();
  markSearchForRestore();
  const back = encodeURIComponent('search.html');
  window.location.href = `bus.html?${serializeRouteStop(routeStop)}&nearest=1&back=${back}`;
}

function setKeyboardEnabled(enabled) {
  if (!keyboardEl) return;
  if (enabled) {
    keyboardEl.removeAttribute('inert');
    keyboardEl.classList.remove('route-search-keyboard--disabled');
  } else {
    keyboardEl.setAttribute('inert', '');
    keyboardEl.classList.add('route-search-keyboard--disabled');
  }
}

function renderLoadProgress({ phase }) {
  const text = phase === 'cache' ? t('search.load.cache') : t('search.load.routes');
  renderResultsHint(text);
}

function renderInput() {
  inputEl.textContent = query || t('search.placeholder');
  inputEl.classList.toggle('route-search-input--empty', !query);
  updateAlphaKeyboard();
}

function updateAlphaKeyboard() {
  if (!alphaPadEl) return;
  const candidates = indexReady ? getAlphabetCandidates(query) : [];
  alphaPadEl.innerHTML = '';
  alphaPadEl.classList.toggle('route-search-keyboard-alpha--empty', candidates.length === 0);

  for (const key of candidates) {
    alphaPadEl.appendChild(createKey(key, '', () => appendChar(key)));
  }
}

function renderResultsHint(text) {
  resultsEl.innerHTML = `<li class="route-search-hint">${escapeHtml(text)}</li>`;
}

function renderResults(matches) {
  if (!query) {
    renderResultsHint(t('search.hint.empty'));
    return;
  }
  if (!matches.length) {
    renderResultsHint(t('search.hint.none'));
    return;
  }

  resultsEl.innerHTML = matches.map((match, i) => `
    <li>
      <button
        class="route-search-result"
        type="button"
        data-index="${i}"
        role="option"
        aria-selected="false"
      >
        <span class="route-search-result-id">
          <span class="route-search-result-route ${operatorClass(match.type)}">${escapeHtml(match.routeId)}</span>
          <span class="route-search-result-op">${escapeHtml(operatorLabel(match.type))}</span>
        </span>
        <span class="route-search-result-meta">
          <span class="route-search-result-dest-row">
            <span class="route-search-result-dest">${escapeHtml(formatMatchDest(match))}</span>
            ${isSpecialService(match) ? `<span class="route-search-result-tag">${escapeHtml(t('search.special'))}</span>` : ''}
          </span>
          ${formatMatchOrig(match) ? `<span class="route-search-result-orig">${escapeHtml(formatMatchOrig(match))}</span>` : ''}
        </span>
      </button>
    </li>`).join('');

  resultsEl.querySelectorAll('.route-search-result').forEach((btn) => {
    btn.addEventListener('click', () => {
      const index = parseInt(btn.getAttribute('data-index'), 10);
      selectMatch(matches[index], btn);
    });
  });
}

function runSearch() {
  renderInput();

  if (!indexReady) return;

  if (!query) {
    renderResults([]);
    saveSearchState();
    return;
  }

  renderResults(searchRoutes(query));
  saveSearchState();
}

function scheduleSearch() {
  if (searchTimer) clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    searchTimer = null;
    runSearch();
  }, 80);
}

function appendChar(char) {
  if (!indexReady || query.length >= 8) return;
  query += char;
  scheduleSearch();
}

function backspace() {
  if (!indexReady || !query) return;
  query = query.slice(0, -1);
  scheduleSearch();
}

function clearQuery() {
  if (!indexReady || !query) return;
  query = '';
  scheduleSearch();
}

async function selectMatch(match, buttonEl) {
  if (!match || buttonEl.disabled) return;
  buttonEl.disabled = true;
  buttonEl.classList.add('route-search-result--loading');

  try {
    const routeStop = await resolveRouteStop(match);
    navigateToBus(routeStop);
  } catch (err) {
    buttonEl.disabled = false;
    buttonEl.classList.remove('route-search-result--loading');
    renderResultsHint(err instanceof Error ? err.message : t('search.openFail'));
  }
}

function createKey(label, className, onClick) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = `route-search-key${className ? ` ${className}` : ''}`;
  if (label.includes('<svg')) {
    btn.innerHTML = label;
    btn.setAttribute('aria-label', t('search.delete'));
  } else {
    btn.textContent = label;
  }
  btn.addEventListener('click', onClick);
  return btn;
}

function buildKeyboard(container) {
  const numPad = document.createElement('div');
  numPad.className = 'route-search-keyboard-num';

  for (const row of NUMERIC_KEYS) {
    for (const key of row) {
      numPad.appendChild(createKey(key, '', () => appendChar(key)));
    }
  }

  numPad.appendChild(createKey(t('search.clear'), 'route-search-key--clear', clearQuery));
  numPad.appendChild(createKey('0', '', () => appendChar('0')));
  numPad.appendChild(createKey(BACKSPACE_ICON, 'route-search-key--backspace', backspace));

  alphaPadEl = document.createElement('div');
  alphaPadEl.className = 'route-search-keyboard-alpha route-search-keyboard-alpha--empty';

  container.append(numPad, alphaPadEl);
}

async function loadIndex() {
  setRouteSearchProgressCallback(renderLoadProgress);
  setKeyboardEnabled(false);
  renderLoadProgress({ phase: 'routes', loaded: 0, total: 1 });

  try {
    await ensureRouteSearchIndex();
    indexReady = isRouteSearchIndexReady();
    setKeyboardEnabled(true);
    renderInput();
    if (query) {
      const scrollTop = restoredScrollTop;
      restoredScrollTop = 0;
      await runSearch();
      restoreResultsScroll(scrollTop);
    } else {
      renderResultsHint(t('search.hint.empty'));
    }
  } catch {
    renderResultsHint(t('search.hint.loadFail'));
  } finally {
    setRouteSearchProgressCallback(null);
  }
}

function syncKeyboardViewport() {
  const vv = window.visualViewport;
  if (!vv || !document.body.classList.contains('route-search-page')) return;
  const gap = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
  document.body.style.setProperty('--route-search-viewport-bottom', `${gap}px`);
}

function bindViewportSync() {
  const sync = () => syncKeyboardViewport();
  window.visualViewport?.addEventListener('resize', sync);
  window.visualViewport?.addEventListener('scroll', sync);
  window.addEventListener('resize', sync);
  window.addEventListener('orientationchange', sync);
  window.addEventListener('pageshow', sync);
  sync();
  let frames = 0;
  const settle = () => {
    sync();
    if (++frames < 12) requestAnimationFrame(settle);
  };
  requestAnimationFrame(settle);
}

function bindHomeLink() {
  const link = document.querySelector('.route-search-page .page-nav-link--back');
  link?.addEventListener('click', clearSearchState);
}

function onLocaleChange() {
  applyStaticI18n();
  renderInput();
  if (indexReady) runSearch();
  const clearBtn = keyboardEl?.querySelector('.route-search-key--clear');
  if (clearBtn) clearBtn.textContent = t('search.clear');
}

function init() {
  initLocale();
  initLocaleToggle();
  initDashboardThemeToggle();
  applyStaticI18n();
  window.addEventListener(LOCALE_CHANGE, onLocaleChange);

  inputEl = document.getElementById('route-search-input');
  resultsEl = document.getElementById('route-search-results');
  keyboardEl = document.getElementById('route-search-keyboard');

  if (!inputEl || !resultsEl || !keyboardEl) return;

  if (consumeRestoreFlag()) {
    const saved = readSearchState();
    if (saved?.query) {
      query = saved.query;
      restoredScrollTop = saved.scrollTop;
    }
  } else {
    clearSearchState();
  }

  bindHomeLink();
  resultsEl.addEventListener('scroll', saveSearchState, { passive: true });

  bindViewportSync();
  buildKeyboard(keyboardEl);
  renderInput();
  loadIndex();
}

init();
