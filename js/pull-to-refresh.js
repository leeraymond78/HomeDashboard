const PULL_THRESHOLD = 72;
const PULL_MAX = 100;

const REFRESH_ICON = `
  <svg class="pull-refresh-icon" width="22" height="22" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <path d="M17.65 6.35A7.958 7.958 0 0 0 12 4c-4.42 0-7.99 3.58-7.99 8s3.57 8 7.99 8c3.73 0 6.84-2.55 7.73-6h-2.08A5.99 5.99 0 0 1 12 18c-3.31 0-6-2.69-6-6s2.69-6 6-6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z"/>
  </svg>`;

/**
 * @param {() => Promise<void>} onRefresh
 */
export function initPullToRefresh(onRefresh) {
  const indicator = document.createElement('div');
  indicator.id = 'pull-refresh';
  indicator.className = 'pull-refresh';
  indicator.setAttribute('aria-hidden', 'true');
  indicator.innerHTML = REFRESH_ICON;
  document.body.prepend(indicator);

  let startY = 0;
  let tracking = false;
  let pulling = false;
  let distance = 0;
  let refreshing = false;

  const setPull = (next) => {
    distance = next;
    const deg = Math.min(180, (next / PULL_THRESHOLD) * 180);
    indicator.style.setProperty('--pull-deg', `${deg}deg`);
    document.body.style.setProperty('--pull-offset', `${next}px`);
    indicator.classList.toggle('visible', next > 0);
    indicator.classList.toggle('ready', next >= PULL_THRESHOLD);
    document.body.classList.toggle('pull-active', next > 0);
  };

  const reset = ({ animate = true } = {}) => {
    if (animate) document.body.classList.add('pull-release');
    setPull(0);
    pulling = false;
    tracking = false;
    window.setTimeout(() => {
      document.body.classList.remove('pull-active', 'pull-release');
      document.body.style.removeProperty('--pull-offset');
    }, animate ? 180 : 0);
  };

  const runRefresh = async () => {
    refreshing = true;
    indicator.classList.add('refreshing');
    document.body.classList.add('pull-refreshing');
    try {
      await onRefresh();
    } finally {
      refreshing = false;
      indicator.classList.remove('refreshing');
      document.body.classList.remove('pull-refreshing');
      reset({ animate: true });
    }
  };

  document.addEventListener('touchstart', (e) => {
    if (refreshing || e.touches.length !== 1) return;
    if (window.scrollY > 2) return;
    startY = e.touches[0].clientY;
    tracking = true;
  }, { passive: true });

  document.addEventListener('touchmove', (e) => {
    if (!tracking || refreshing) return;
    if (window.scrollY > 2) {
      if (pulling) reset({ animate: false });
      return;
    }

    const dy = e.touches[0].clientY - startY;
    if (dy <= 0) {
      if (pulling) reset({ animate: false });
      return;
    }

    pulling = true;
    setPull(Math.min(dy * 0.5, PULL_MAX));
    e.preventDefault();
  }, { passive: false });

  const onTouchEnd = async () => {
    if (!tracking) return;
    const shouldRefresh = pulling && distance >= PULL_THRESHOLD;
    tracking = false;

    if (shouldRefresh) {
      setPull(PULL_THRESHOLD);
      await runRefresh();
      return;
    }

    if (pulling) reset({ animate: true });
  };

  document.addEventListener('touchend', onTouchEnd, { passive: true });
  document.addEventListener('touchcancel', onTouchEnd, { passive: true });
}
