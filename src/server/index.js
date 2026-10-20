const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const R = require('./router');
const { AppError } = require('./errors');
const S = require('./session');
const { openDb } = require('./db');
const Dom = require('./domain');
require('./api'); // 注册全部路由

const WEB_DIR = path.join(__dirname, '..', 'web');
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
  '.woff2': 'font/woff2', '.md': 'text/markdown; charset=utf-8',
};

function readBody(req, limit = 12 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new AppError(413, 'TOO_LARGE', '文件太大')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  res.end(body);
}

// 托管平台会在分享链接后面带 ?sharecode=xxx，静态资源的请求不会自动继承它，
// 直接请求 /style.css 会被平台网关拦成 403。所以这里把前端打成一个自包含的单文件，
// 只要页面本身能打开，样式和脚本都在里面，不再依赖第二次请求。
function inlineEntry() {
  const sources = {
    '/style.css': path.join(WEB_DIR, 'style.css'),
    '/app.js': path.join(WEB_DIR, 'app.js'),
    '/api.js': path.join(WEB_DIR, 'api.js'),
  };
  for (const f of Object.values(sources)) if (!fs.existsSync(f)) return null;
  const css = fs.readFileSync(sources['/style.css'], 'utf8');
  const api = fs.readFileSync(sources['/api.js'], 'utf8').replace(/^export\s+/gm, '');
  const appJs = fs.readFileSync(sources['/app.js'], 'utf8')
    .replace(/^import\s*\{[\s\S]*?\}\s*from\s*'\.\/api\.js';\s*/m, '')
    .replace(/^export\s+/gm, '');
  let html = fs.readFileSync(path.join(WEB_DIR, 'index.html'), 'utf8');
  html = html.replace('<link rel="stylesheet" href="/style.css">', '<style>\n' + css + '\n</style>');
  html = html.replace('<script type="module" src="/app.js"></script>',
    '<script type="module">\n' + api + '\n\n' + appJs + '\n</script>');
  return html;
}

function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel === '/' || rel === '') rel = '/index.html';
  // SPA 路由回退：/s/:token、/join/:token、/g/:id 等都交给 index.html
  if (!path.extname(rel)) rel = '/index.html';
  if (rel === '/index.html') {
    const page = inlineEntry();
    if (page) {
      res.writeHead(200, { 'content-type': MIME['.html'], 'cache-control': 'no-cache' });
      return res.end(page);
    }
  }
  const fp = path.join(WEB_DIR, rel);
  if (!fp.startsWith(WEB_DIR) || !fs.existsSync(fp) || fs.statSync(fp).isDirectory()) {
    const index = path.join(WEB_DIR, 'index.html');
    if (fs.existsSync(index)) {
      const b = fs.readFileSync(index);
      res.writeHead(200, { 'content-type': MIME['.html'], 'cache-control': 'no-cache' });
      return res.end(b);
    }
    res.writeHead(404); return res.end('Not Found');
  }
  const ext = path.extname(fp).toLowerCase();
  const buf = fs.readFileSync(fp);
  res.writeHead(200, {
    'content-type': MIME[ext] || 'application/octet-stream',
    'cache-control': ext === '.html' ? 'no-cache' : 'public, max-age=60',
    'content-length': buf.length,
  });
  res.end(buf);
}

async function handle(req, res) {
  const urlObj = new URL(req.url, 'http://localhost');
  const pathname = urlObj.pathname;

  if (!pathname.startsWith('/api/')) return serveStatic(req, res, pathname);

  const m = R.match(req.method, pathname);
  if (!m) return sendJson(res, 404, { error: { code: 'NOT_FOUND', message: '接口不存在' } });
  if (m.methodNotAllowed) return sendJson(res, 405, { error: { code: 'METHOD_NOT_ALLOWED', message: '这个操作不允许' } });

  const { route, params } = m;
  const ctx = { req, res, params, query: R.parseQuery(req), body: {}, user: null };

  try {
    if (req.method !== 'GET' && req.method !== 'DELETE') {
      const buf = await readBody(req);
      if (buf.length) {
        try { ctx.body = JSON.parse(buf.toString('utf8')); }
        catch { throw new AppError(400, 'BAD_JSON', '请求格式不对'); }
      }
    }

    // 登录态
    ctx.user = S.userFromRequest(req);

    if (route.opts.admin && ctx.body && ctx.body.enable === false) {
      throw new AppError(403, 'FORBIDDEN', '该操作已关闭');
    }
    if (route.opts.auth === true && !ctx.user) {
      throw new AppError(401, 'UNAUTHORIZED', '请先登录');
    }

    // 频率限制：写操作 240/min/IP
    if (req.method !== 'GET') {
      const ip = req.socket.remoteAddress || 'x';
      if (R.rateLimited(`${ip}:${pathname}`, 240, 60000)) {
        throw new AppError(429, 'TOO_MANY_REQUESTS', '操作太频繁，稍后再试');
      }
    }

    // C4 修复：解散后 30 天只读窗口由派发层统一兜底。
    // 所有 /api/groups/:id/** 的非 GET 请求，先判组是否 archived，再进 handler。
    // 这样新增的群组写接口不可能再因为"忘了加断言"而漏掉。
    if (req.method !== 'GET' && req.method !== 'HEAD' && params.id) {
      Dom.assertGroupWritable(params.id);
    }

    const result = await route.handler(ctx);

    if (ctx.raw) {
      const r = ctx.raw;
      if (r.file) {
        if (!fs.existsSync(r.file)) {
          res.writeHead(404); return res.end('文件不存在');
        }
        const stat = fs.statSync(r.file);
        res.writeHead(200, {
          'content-type': r.mime || 'application/octet-stream',
          'content-length': stat.size,
          'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(r.filename || 'file')}`,
          'cache-control': 'private, no-store',
        });
        return fs.createReadStream(r.file).pipe(res);
      }
      res.writeHead(200, {
        'content-type': r.mime || 'text/plain; charset=utf-8',
        'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(r.filename || 'download')}`,
        'cache-control': 'no-store',
      });
      return res.end(r.body);
    }

    if (result === null || result === undefined) {
      res.writeHead(204); return res.end();
    }
    return sendJson(res, 200, result);
  } catch (e) {
    if (e instanceof AppError) {
      return sendJson(res, e.status, {
        error: { code: e.code, message: e.message, ...(e.extra || {}) },
      });
    }
    console.error('[500]', req.method, pathname, e);
    return sendJson(res, 500, { error: { code: 'SERVER_ERROR', message: '服务器开小差了' } });
  }
}

function createServer() {
  openDb();
  return http.createServer((req, res) => {
    handle(req, res).catch((e) => {
      console.error('[fatal]', e);
      try { sendJson(res, 500, { error: { code: 'SERVER_ERROR', message: '服务器开小差了' } }); } catch { /* ignore */ }
    });
  });
}

module.exports = { createServer, handle, start };

function start() {
  const port = Number(process.env.PORT || process.env.QD_PORT || process.argv[2] || 3001);
  // 部署到托管平台时需要监听 0.0.0.0；本地开发默认只绑回环地址更安全。
  const host = process.env.QD_HOST || (process.env.PORT ? '0.0.0.0' : '127.0.0.1');
  const server = createServer();
  server.listen(port, host, () => {
    console.log(`轻队 QingDui 已启动： http://${host}:${port}`);
    // C6 修复：真正把提醒与清理跑起来。
    // QD_SCHEDULER=0 可在需要纯净环境（如演示、性能压测）时关掉。
    if (process.env.QD_SCHEDULER !== '0') {
      require('./scheduler').start();
      console.log('后台调度已启动：提醒每分钟一次，解散清理每小时一次');
    } else {
      console.log('后台调度已关闭（QD_SCHEDULER=0）');
    }
  });
  const shutdown = () => {
    try { require('./scheduler').stop(); } catch { /* ignore */ }
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  return server;
}

if (require.main === module) start();
