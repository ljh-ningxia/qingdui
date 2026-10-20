// 轻队前端 · 极简路由 + API 客户端
export const state = {
  token: localStorage.getItem('qd_token') || '',
  user: null,
  groups: [],
  currentGroupId: null,
  unread: 0,
  serverOffset: 0,
};

export function setToken(t) {
  state.token = t;
  if (t) localStorage.setItem('qd_token', t);
  else localStorage.removeItem('qd_token');
}

export async function api(path, opts = {}) {
  const headers = { ...(opts.headers || {}) };
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  if (state.token) headers.authorization = `Bearer ${state.token}`;
  const res = await fetch(path, {
    method: opts.method || (opts.body !== undefined ? 'POST' : 'GET'),
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  let data = null;
  const ct = res.headers.get('content-type') || '';
  if (ct.includes('application/json')) data = await res.json();
  if (!res.ok) {
    const err = (data && data.error) || { code: 'HTTP_' + res.status, message: '请求失败（' + res.status + '）' };
    err.status = res.status;
    const e = new Error(err.message);
    e.detail = err;
    throw e;
  }
  if (res.status === 204) return null;
  return data;
}

export function toast(msg, kind = '') {
  let wrap = document.querySelector('.toast-wrap');
  if (!wrap) {
    wrap = document.createElement('div');
    wrap.className = 'toast-wrap';
    document.body.appendChild(wrap);
  }
  const el = document.createElement('div');
  el.className = 'toast ' + kind;
  el.textContent = msg;
  wrap.appendChild(el);
  setTimeout(() => {
    el.style.transition = 'opacity .2s, transform .2s';
    el.style.opacity = '0';
    el.style.transform = 'translateY(6px)';
    setTimeout(() => el.remove(), 220);
  }, kind === 'err' ? 3600 : 2400);
}

export function nowMs() {
  return Date.now() + state.serverOffset;
}

/* ---------- 时间展示（与服务端口径一致：东八区） ---------- */
const TZ = 8 * 3600 * 1000;
const DAY = 86400000;

export function parts(ms) {
  const d = new Date(ms + TZ);
  return {
    y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate(),
    hh: d.getUTCHours(), mm: d.getUTCMinutes(), dow: d.getUTCDay(),
  };
}

export function startOfDay(ms) {
  const p = parts(ms);
  return Date.UTC(p.y, p.m - 1, p.d) - TZ;
}

export function fmtDue(ms) {
  if (!ms) return '无截止';
  const p = parts(ms);
  const names = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
  const hm = `${String(p.hh).padStart(2, '0')}:${String(p.mm).padStart(2, '0')}`;
  const diff = Math.round((startOfDay(ms) - startOfDay(nowMs())) / DAY);
  if (diff === 0) return hm === '23:59' ? '今天 23:59' : `今天 ${hm}`;
  if (diff === 1) return hm === '23:59' ? '明天 23:59' : `明天 ${hm}`;
  if (diff === -1) return hm === '23:59' ? '昨天 23:59' : `昨天 ${hm}`;
  if (diff > 1 && diff < 7) return `${names[p.dow]} ${hm}`;
  return `${p.m}月${p.d}日`;
}

export function fmtTime(ms) {
  const p = parts(ms);
  const diff = Math.round((startOfDay(nowMs()) - startOfDay(ms)) / DAY);
  const hm = `${String(p.hh).padStart(2, '0')}:${String(p.mm).padStart(2, '0')}`;
  if (diff === 0) return `今天 ${hm}`;
  if (diff === 1) return `昨天 ${hm}`;
  if (diff < 7 && diff > 0) return `${diff} 天前`;
  return `${p.m}/${p.d} ${hm}`;
}

export function fmtSize(n) {
  if (!n) return '0 B';
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  if (n < 1024 * 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + ' MB';
  return (n / 1024 / 1024 / 1024).toFixed(2) + ' GB';
}

export function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

export function initial(name) {
  const s = String(name || '?').trim();
  return s ? s[0] : '?';
}

export function avatarHtml(user, cls = '') {
  if (!user) {
    return `<span class="avatar ${cls}" style="background:#C9CDD4">—</span>`;
  }
  return `<span class="avatar ${cls}" style="background:${esc(user.avatar_color || '#3B6EA5')}" title="${esc(user.nickname)}">${esc(initial(user.nickname))}</span>`;
}

/* ---------- 路由 ---------- */
const routes = [];
export function route(pattern, handler) {
  const keys = [];
  const re = new RegExp('^' + pattern.replace(/\/:([a-zA-Z_]+)/g, (_, k) => { keys.push(k); return '/([^/]+)'; }) + '/?$');
  routes.push({ re, keys, handler, pattern });
}

export function navigate(path, { replace = false } = {}) {
  if (replace) history.replaceState({}, '', path);
  else history.pushState({}, '', path);
  render();
}

export function currentPath() {
  return location.pathname + location.search;
}

let rendering = false;
let renderAgain = false;
export async function render() {
  // 重入不能直接丢弃：requireAuth 会在本轮渲染中 navigate 到 /login，
  // 若此处 return，跳转后的页面永远不会被画出来（真实白屏）。改为记标记、本轮结束后补一遍。
  if (rendering) { renderAgain = true; return; }
  rendering = true;
  try {
    do {
      renderAgain = false;
      const path = location.pathname;
      let hit = false;
      for (const r of routes) {
        const m = path.match(r.re);
        if (!m) continue;
        hit = true;
        const params = {};
        r.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });
        const q = Object.fromEntries(new URLSearchParams(location.search));
        await r.handler({ params, query: q });
        break;
      }
      if (!hit) {
        // 兜底跳首页；用 replaceState 避免压栈，再标记重绘（本轮已持有 rendering）
        history.replaceState({}, '', '/my');
        renderAgain = true;
      }
    } while (renderAgain);
  } catch (e) {
    console.error(e);
  } finally {
    rendering = false;
  }
}

/* ---------- 弹层 ---------- */
let modalStack = [];
export function openModal(html, { onMount, wide = false, dismissable = true } = {}) {
  const back = document.createElement('div');
  back.className = 'modal-back';
  back.innerHTML = `<div class="modal ${wide ? 'wide' : ''}" role="dialog">${html}</div>`;
  document.body.appendChild(back);
  const close = () => {
    back.remove();
    modalStack = modalStack.filter((x) => x !== close);
  };
  modalStack.push(close);
  if (dismissable) {
    back.addEventListener('click', (e) => { if (e.target === back) close(); });
  }
  document.addEventListener('keydown', function esc2(e) {
    if (e.key === 'Escape') { close(); document.removeEventListener('keydown', esc2); }
  });
  if (onMount) onMount(back.querySelector('.modal'), close);
  const first = back.querySelector('input, textarea, select, button');
  if (first) setTimeout(() => first.focus(), 40);
  return close;
}

export function closeAllModals() {
  modalStack.slice().forEach((c) => c());
}

/* ---------- 小工具 ---------- */
export function el(html) {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
}

export function debounce(fn, ms) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

export function deviceId() {
  let id = localStorage.getItem('qd_device');
  if (!id) {
    id = 'd_' + Math.random().toString(36).slice(2) + Date.now().toString(36);
    localStorage.setItem('qd_device', id);
  }
  return id;
}
