// 用 CDP 在注入登录态后截图（零依赖，直接连 Chrome 的 DevTools WebSocket）
// 用法：node shot.js <name> <path>
const http = require('node:http');

const NAME = process.argv[2] || 'board';
const OUT = process.argv[3] || `C:/Users/Administrator/WorkBuddy/2026-10-20-09-43-57/article-assets/${NAME}.png`;
const TOKEN = process.argv[4] || '';
const URL_PATH = process.argv[5] || '/';

function httpJson(port, path) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path }, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

async function main() {
  // 1. 启动一个带调试端口的 headless Chrome
  const { spawn } = require('node:child_process');
  const chrome = spawn('C:/Program Files/Google/Chrome/Application/chrome.exe', [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
    '--remote-debugging-port=9222', '--window-size=1440,1000', '--user-data-dir=C:/Users/Administrator/AppData/Local/Temp/chrome-shot-profile',
    'about:blank',
  ], { stdio: 'ignore' });

  // 等 DevTools 起来
  let targets = null;
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 500));
    try { targets = await httpJson(9222, '/json'); break; } catch { /* retry */ }
  }
  if (!targets) throw new Error('Chrome DevTools 没起来');
  const page = targets.find((t) => t.type === 'page');
  if (!page) throw new Error('找不到 page target');

  // 2. 连 WebSocket（Node 22 内置 WebSocket）
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

  let id = 0;
  const pending = new Map();
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  };
  function send(method, params = {}) {
    return new Promise((resolve) => {
      const mid = ++id;
      pending.set(mid, resolve);
      ws.send(JSON.stringify({ id: mid, method, params }));
    });
  }

  await send('Page.enable');
  await send('Runtime.enable');

  // 3. 先开目标域名（才能设 localStorage）
  await send('Page.navigate', { url: 'http://127.0.0.1:3456/' });
  await new Promise((r) => setTimeout(r, 1500));

  // 4. 注入登录态
  if (TOKEN) {
    await send('Runtime.evaluate', {
      expression: `localStorage.setItem('qd_token', ${JSON.stringify(TOKEN)});`,
    });
  }

  // 5. 导航到目标页面：先设 token 再整页刷新，等 boot 完成后用 SPA 内部导航
  await send('Page.navigate', { url: 'http://127.0.0.1:3456' + URL_PATH });
  await new Promise((r) => setTimeout(r, 3000));

  // 若被重定向（SPA fallback），直接调用内部 navigate 强制去目标页
  const check = await send('Runtime.evaluate', { expression: 'location.pathname', returnByValue: true });
  if (check.result.result.value !== URL_PATH) {
    console.log('整页导航落在', check.result.result.value, '，改用 SPA navigate...');
    await send('Runtime.evaluate', {
      expression: `window.__qd.navigate(${JSON.stringify(URL_PATH)})`,
    });
    await new Promise((r) => setTimeout(r, 2000));
  }

  // 5.5 诊断：看实际 URL
  const loc = await send('Runtime.evaluate', { expression: 'location.pathname', returnByValue: true });
  console.log('实际页面:', loc.result.result.value);

  // 6. 截图
  const shot = await send('Page.captureScreenshot', { format: 'png' });
  require('node:fs').writeFileSync(OUT, Buffer.from(shot.result.data, 'base64'));
  console.log('OK ->', OUT);

  ws.close();
  chrome.kill();
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
