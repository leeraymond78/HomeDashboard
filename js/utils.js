/**
 * Shared utility functions used across app.js and weather.js.
 */

/**
 * Escape a string for safe HTML insertion.
 * @param {unknown} s
 * @returns {string}
 */
export function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Escape a string for safe use inside an HTML attribute value.
 * @param {unknown} s
 * @returns {string}
 */
export function escapeAttr(s) {
  return escapeHtml(s).replace(/'/g, '&#39;');
}
