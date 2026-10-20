// 手机号加密（PRD 12：安全 — 手机号加密存储）
// AES-256-GCM + HMAC 盲索引（用于登录时查找，不解密全表）
const crypto = require('node:crypto');
const { dataKey, indexKey } = require('./secrets');

// C1 修复：密钥统一由 secrets.js 提供，不再有源码内公开兜底值
const KEY = dataKey();
const IDX_KEY = indexKey();

function encryptPhone(phone) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', KEY, iv);
  const enc = Buffer.concat([c.update(String(phone), 'utf8'), c.final()]);
  const tag = c.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString('base64');
}

function decryptPhone(blob) {
  if (!blob) return '';
  const buf = Buffer.from(blob, 'base64');
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const enc = buf.subarray(28);
  const d = crypto.createDecipheriv('aes-256-gcm', KEY, iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(enc), d.final()]).toString('utf8');
}

function phoneIndex(phone) {
  return crypto.createHmac('sha256', IDX_KEY).update(String(phone)).digest('hex');
}

function maskPhone(phone) {
  const s = String(phone || '');
  if (s.length < 7) return s;
  return s.slice(0, 3) + '****' + s.slice(-4);
}

function randomId(prefix = '') {
  const s = crypto.randomBytes(9).toString('base64url').replace(/[-_]/g, '');
  return prefix ? `${prefix}_${s}` : s;
}

// 短链 token：不可枚举（PRD 7.9）
function randomToken(len = 16) {
  const alphabet = 'abcdefghijkmnpqrstuvwxyz23456789';
  const bytes = crypto.randomBytes(len);
  let out = '';
  for (let i = 0; i < len; i++) out += alphabet[bytes[i] % alphabet.length];
  return out;
}

function hashPasswordlessToken(t) {
  return crypto.createHash('sha256').update(t).digest('hex');
}

module.exports = { encryptPhone, decryptPhone, phoneIndex, maskPhone, randomId, randomToken, hashPasswordlessToken };
