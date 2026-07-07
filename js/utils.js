/**
 * @module utils
 * Shared utility functions used across app.js, weather.js and bus.js.
 */

/**
 * Escape a string for safe HTML insertion.
 * Handles &, <, >, and " characters.
 * @param {unknown} s - Value to escape; non-strings are coerced via String().
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
 * Escape a string for safe use inside an HTML attribute value (e.g. data-* or href).
 * Extends escapeHtml by also escaping single quotes.
 * @param {unknown} s - Value to escape; non-strings are coerced via String().
 * @returns {string}
 */
export function escapeAttr(s) {
  return escapeHtml(s).replace(/'/g, '&#39;');
}
