import { t } from './locale.js';

const STORAGE_KEY = 'homedashboard-theme';

const THEME_META = {
  dark: '#000000',
  lcd: '#b8c4ae',
};

/** @returns {'dark' | 'lcd'} */
export function getTheme() {
  return document.documentElement.dataset.theme === 'lcd' ? 'lcd' : 'dark';
}

/** @param {'dark' | 'lcd'} theme */
export function applyTheme(theme) {
  const next = theme === 'lcd' ? 'lcd' : 'dark';
  document.documentElement.dataset.theme = next;
  try {
    localStorage.setItem(STORAGE_KEY, next);
  } catch {
    /* ignore */
  }
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', THEME_META[next]);
  updateThemeButton();
}

export function toggleTheme() {
  applyTheme(getTheme() === 'lcd' ? 'dark' : 'lcd');
}

function updateThemeButton() {
  const btn = document.getElementById('theme-btn');
  if (!btn) return;
  const lcd = getTheme() === 'lcd';
  btn.setAttribute('aria-pressed', lcd ? 'true' : 'false');
  btn.setAttribute('aria-label', lcd ? t('theme.toDark') : t('theme.toLcd'));
  btn.textContent = lcd ? t('theme.led') : t('theme.lcd');
}

export function initDashboardThemeToggle() {
  applyTheme(getTheme());
  document.getElementById('theme-btn')?.addEventListener('click', toggleTheme);
  window.addEventListener('localechange', updateThemeButton);
}
