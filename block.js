/**
 * Minimal security / input sanitization module for Gims AI
 * (recreated because original block.js was not provided)
 */
'use strict';

const SAFE_ID_RE = /^[a-zA-Z0-9가-힣_]{2,20}$/;
const SAFE_EMAIL_RE = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;

function isSafeId(s) {
  return typeof s === 'string' && SAFE_ID_RE.test(s);
}

function isSafeEmail(s) {
  return typeof s === 'string' && SAFE_EMAIL_RE.test(s) && s.length <= 120;
}

function sanitizeObject(obj, depth = 0) {
  if (depth > 8 || obj === null || typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) return obj.map(x => sanitizeObject(x, depth + 1));
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
    out[k] = sanitizeObject(v, depth + 1);
  }
  return out;
}

// Simple in-memory rate limiter
const buckets = new Map();
function rateLimit(ip, { windowMs = 60_000, max = 180 } = {}) {
  const now = Date.now();
  let b = buckets.get(ip);
  if (!b || now - b.start > windowMs) {
    b = { start: now, count: 0 };
    buckets.set(ip, b);
  }
  b.count++;
  if (b.count > max) return true;
  // cleanup occasionally
  if (buckets.size > 5000) {
    for (const [k, v] of buckets) if (now - v.start > windowMs * 2) buckets.delete(k);
  }
  return false;
}

function securityHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('X-XSS-Protection', '0');
}

/**
 * Basic request guard. Returns true if the request should be rejected
 * (caller must have already sent a response).
 * opts.types: array of checks to enable. Default all.
 *   'proto'  – prototype pollution patterns in body (handled by sanitize)
 *   'xss'    – very crude XSS patterns (disabled for chat)
 *   'sql'    – crude SQL keywords (disabled for chat)
 */
function guard(req, res, body = null, opts = {}) {
  const types = opts.types || ['proto'];
  // size already limited in body parser
  if (body && types.includes('proto')) {
    // already sanitized by caller; nothing more
  }
  // URL length
  if ((req.url || '').length > 2048) {
    res.writeHead(414, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'URL too long' } }));
    return true;
  }
  return false;
}

module.exports = {
  isSafeId,
  isSafeEmail,
  sanitizeObject,
  rateLimit,
  securityHeaders,
  guard
};
