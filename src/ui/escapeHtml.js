// src/ui/escapeHtml.js
/** Escapes text before it goes into an innerHTML template. */
export const escapeHtml = (s) =>
  String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** Colours reach style attributes, so only plain hex values are allowed through. */
export const safeColor = (c, fallback = '#888888') =>
  (typeof c === 'string' && /^#[0-9a-f]{3,8}$/i.test(c) ? c : fallback);
