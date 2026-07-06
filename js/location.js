/** @type {GeolocationPosition | null} */
let userPosition = null;

const GEO_OPTIONS = { enableHighAccuracy: true, timeout: 10000, maximumAge: 15000 };

export function getUserPosition() {
  return userPosition;
}

export function requestUserPosition() {
  if (!navigator.geolocation) return Promise.resolve(null);
  return new Promise((resolve) => {
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        userPosition = pos;
        resolve(pos);
      },
      () => resolve(userPosition),
      GEO_OPTIONS,
    );
  });
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
