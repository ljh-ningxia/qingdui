// 密钥统一出口（C1 修复）
//
// 原实现的问题：`process.env.QD_SECRET || 'qingdui-local-dev-secret'` 在三个
// 文件里重复出现，未配置环境变量时会静默退回一个**写在源码里、随代码公开**的常量。
// 攻击者用这个公开常量自签一个 token 就能冒充任意用户（/api/me 返回 200）。
//
// 现在的策略：
//   - 生产必须显式提供 QD_SECRET，缺失则启动即抛错（fail fast，绝不带病运行）
//   - 本地开发未配置时**随机生成**一个进程内密钥，并在控制台显著告警
//     随机密钥意味着重启后旧 token 失效，这是刻意的：宁可让开发者重新登录，
//     也不允许在任何人只要读过源码就能伪造会话的状态下运行。
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const MIN_LENGTH = 32;
const DEV_KEY_FILE = path.join(__dirname, '..', '..', '.qd-dev-secret');

let cached = null;

function isProduction() {
  return process.env.NODE_ENV === 'production' || process.env.QD_ENV === 'production';
}

/**
 * 开发模式下把随机密钥落到本地文件，重启后复用，避免每次重启都掉登录态。
 * 该文件已在 .gitignore 中排除，不会进仓库。
 */
function readOrCreateDevSecret() {
  try {
    if (fs.existsSync(DEV_KEY_FILE)) {
      const saved = fs.readFileSync(DEV_KEY_FILE, 'utf8').trim();
      if (saved.length >= MIN_LENGTH) return saved;
    }
  } catch { /* 读不到就当不存在 */ }

  const fresh = crypto.randomBytes(32).toString('base64url');
  try {
    fs.writeFileSync(DEV_KEY_FILE, fresh, { mode: 0o600 });
  } catch { /* 写不了（只读文件系统 / 沙箱）就用进程内的，重启失效可接受 */ }
  return fresh;
}

function resolveSecret() {
  const fromEnv = (process.env.QD_SECRET || '').trim();

  if (fromEnv) {
    if (fromEnv.length < MIN_LENGTH) {
      throw new Error(
        `[轻队] QD_SECRET 太短（当前 ${fromEnv.length} 字符，至少需要 ${MIN_LENGTH}）。\n` +
        '请生成一个足够长的随机密钥，例如：\n' +
        '  node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'base64url\'))"'
      );
    }
    return fromEnv;
  }

  if (isProduction()) {
    throw new Error(
      '[轻队] 生产环境必须设置 QD_SECRET，已拒绝启动。\n' +
      '原因：缺省密钥会让任何人都能伪造登录凭证。\n' +
      '请执行：node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'base64url\'))"\n' +
      '然后把结果写入环境变量 QD_SECRET。'
    );
  }

  const dev = readOrCreateDevSecret();
  process.emitWarning(
    '[轻队] 未设置 QD_SECRET，已自动生成本地开发密钥（.qd-dev-secret，不入库）。' +
    '重启后保持有效。生产部署必须显式配置 QD_SECRET。',
    { code: 'QD_DEV_SECRET' }
  );
  return dev;
}

function secret() {
  if (!cached) cached = resolveSecret();
  return cached;
}

const sessionKey = () => crypto.createHash('sha256').update(secret() + ':session').digest();
const dataKey = () => crypto.createHash('sha256').update(secret() + ':data').digest();
const indexKey = () => crypto.createHash('sha256').update(secret() + ':idx').digest();

module.exports = {
  sessionKey,
  dataKey,
  indexKey,
  isProduction,
  MIN_LENGTH,
  // 仅供测试断言使用：确认当前密钥来源不是公开常量
  _sourceIsEnv: () => !!(process.env.QD_SECRET || '').trim(),
  _reset: () => { cached = null; },
};
