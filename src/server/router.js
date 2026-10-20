// 极简路由：pattern -> handler，支持 :param
const url = require('node:url');

const routes = [];
const RATE = new Map();

function add(method, pattern, handler, opts = {}) {
  const keys = [];
  const re = new RegExp('^' + pattern.replace(/\/:([a-zA-Z_]+)/g, (_, k) => {
    keys.push(k);
    return '/([^/]+)';
  }) + '/?$');
  routes.push({ method, re, keys, handler, opts });
}

const get = (p, h, o) => add('GET', p, h, o);
const post = (p, h, o) => add('POST', p, h, o);
const patch = (p, h, o) => add('PATCH', p, h, o);
const del = (p, h, o) => add('DELETE', p, h, o);

// 简单令牌桶：按 IP + 路由
function rateLimited(key, limit, windowMs) {
  const now = Date.now();
  let bucket = RATE.get(key);
  if (!bucket || bucket.reset < now) {
    bucket = { count: 0, reset: now + windowMs };
    RATE.set(key, bucket);
  }
  bucket.count += 1;
  return bucket.count > limit;
}

function match(method, pathname) {
  let pathMatched = false;
  for (const r of routes) {
    const m = pathname.match(r.re);
    if (!m) continue;
    pathMatched = true;
    if (r.method !== method) continue;
    const params = {};
    r.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });
    return { route: r, params };
  }
  return pathMatched ? { methodNotAllowed: true } : null;
}

function parseQuery(req) {
  return url.parse(req.url, true).query;
}

function resetRate() {
  RATE.clear();
}

module.exports = { get, post, patch, del, add, match, parseQuery, rateLimited, resetRate, routes };
