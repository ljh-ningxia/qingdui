// 会话：无状态签名 token（HMAC），不依赖 cookie session 存储
const crypto = require('node:crypto');
const { one } = require('./db');
const { sessionKey } = require('./secrets');

// C1 修复：密钥不再有源码内公开兜底值，缺失时的行为见 secrets.js
const SECRET = sessionKey();

const TTL = 30 * 24 * 3600 * 1000;

function sign(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const mac = crypto.createHmac('sha256', SECRET).update(body).digest('base64url');
  return `${body}.${mac}`;
}

function verify(token) {
  if (!token || typeof token !== 'string') return null;
  const idx = token.lastIndexOf('.');
  if (idx < 0) return null;
  const body = token.slice(0, idx);
  const mac = token.slice(idx + 1);
  const expect = crypto.createHmac('sha256', SECRET).update(body).digest('base64url');
  const a = Buffer.from(mac);
  const b = Buffer.from(expect);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  let payload;
  try { payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')); } catch { return null; }
  if (!payload.exp || payload.exp < Date.now()) return null;
  return payload;
}

function issue(userId) {
  return sign({ uid: userId, exp: Date.now() + TTL });
}

function userFromRequest(req) {
  const h = req.headers['authorization'] || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : (cookies(req).qd_session || '');
  const p = verify(token);
  if (!p) return null;
  const u = one('SELECT * FROM users WHERE id = ? AND deleted_at IS NULL', p.uid);
  return u || null;
}

function cookies(req) {
  const out = {};
  const raw = req.headers['cookie'] || '';
  raw.split(';').forEach((pair) => {
    const i = pair.indexOf('=');
    if (i > 0) out[pair.slice(0, i).trim()] = decodeURIComponent(pair.slice(i + 1).trim());
  });
  return out;
}

module.exports = { issue, verify, userFromRequest, cookies };
