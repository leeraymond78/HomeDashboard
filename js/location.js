/** @type {GeolocationPosition | null} */
let userPosition = null;
/** @type {GeolocationPositionError | null} */
let lastGeoError = null;

const GEO_OPTIONS = { enableHighAccuracy: true, timeout: 15000, maximumAge: 30000 };

export function getUserPosition() {
  return userPosition;
}

export function getLastGeoError() {
  return lastGeoError;
}

/** @returns {'unsupported' | 'insecure' | null} */
export function geolocationBlockReason() {
  if (!navigator.geolocation) return 'unsupported';
  if (!window.isSecureContext) return 'insecure';
  return null;
}

export function canUseGeolocation() {
  return geolocationBlockReason() === null;
}

/** @returns {Promise<'granted' | 'denied' | 'prompt' | 'unknown'>} */
export async function getGeolocationPermission() {
  if (!navigator.permissions?.query) return 'unknown';
  try {
    const result = await navigator.permissions.query({ name: 'geolocation' });
    return /** @type {'granted' | 'denied' | 'prompt'} */ (result.state);
  } catch {
    return 'unknown';
  }
}

/**
 * Request the device position. On iOS, the first permission prompt only appears
 * when this is called from a user gesture (tap, pull-to-refresh, etc.).
 * @returns {Promise<GeolocationPosition | null>}
 */
export function requestUserPosition() {
  if (!canUseGeolocation()) return Promise.resolve(null);
  return new Promise((resolve) => {
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        userPosition = pos;
        lastGeoError = null;
        window.dispatchEvent(new CustomEvent('userposition', { detail: pos }));
        resolve(pos);
      },
      (err) => {
        lastGeoError = err;
        resolve(userPosition);
      },
      GEO_OPTIONS,
    );
  });
}

/**
 * Load location when permission is already granted; otherwise leave prompting to the UI.
 * @returns {Promise<'granted' | 'denied' | 'prompt' | 'unsupported' | 'unavailable'>}
 */
export async function bootstrapLocation() {
  const block = geolocationBlockReason();
  if (block) return block;

  const perm = await getGeolocationPermission();
  if (perm === 'denied') return 'denied';

  // iOS often reports "prompt" or "unknown" even when permission is already granted,
  // so always try getCurrentPosition unless the user has explicitly denied access.
  const pos = await requestUserPosition();
  if (pos) return 'granted';
  if (perm === 'prompt' || perm === 'unknown') return 'prompt';
  return 'unavailable';
}

export function distanceM(a, b) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

export function formatDistance(m) {
  if (m == null) return '';
  return m < 1000 ? `${Math.round(m)}m` : `${(m / 1000).toFixed(1)}km`;
}
