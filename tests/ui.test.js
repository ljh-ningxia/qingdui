// 前端冒烟测试：用极简 DOM 桩真实执行 app.js，走完 登录 → 建组 → 建任务 → 看板 → 详情 → 分享 全链路
// 目的不是替代浏览器测试，而是抓住「模块加载失败 / 渲染时报错 / 关键节点未渲染」这类线上会白屏的问题
const { suite, test, runAll, assert, eq, includes, report } = require('./harness');
const S = require('./setup');

/* ---------------- 极简 DOM 桩 ---------------- */
// 关键点：前端用 innerHTML 拼串渲染。桩不实现 HTML 解析，只做两件事：
//   1) 把串里带 id / data-* / class 的标签「物化」成子节点，供 getElementById / querySelector 命中；
//   2) 保留原始串，供 text() 做文本化断言。
const VOID_TAGS = new Set(['input', 'img', 'br', 'hr', 'meta', 'link', 'source']);

// 极简标签栈解析：还原嵌套层级，只把「有 id / class / data-*」的元素建成节点，
// 其余标签当作透明容器（子元素挂到最近的已建节点上）。
function materialize(parent, htmlStr) {
  const src = String(htmlStr || '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, '');
  const tokenRe = /<(\/?)([a-zA-Z][\w-]*)((?:\s+[^<>]*?)?)(\/?)>/g;
  const stack = [parent];
  let m;
  while ((m = tokenRe.exec(src))) {
    const [, closing, rawTag, attrStr, selfClose] = m;
    const tag = rawTag.toLowerCase();
    if (closing) {
      if (stack.length > 1) stack.pop();
      continue;
    }
    const attrs = {};
    const attrRe = /([\w-]+)\s*=\s*"([^"]*)"|([\w-]+)\s*=\s*'([^']*)'|([\w-]+)/g;
    let a;
    while ((a = attrRe.exec(attrStr || ''))) {
      const k = a[1] || a[3] || a[5];
      attrs[k] = a[2] !== undefined ? a[2] : (a[4] !== undefined ? a[4] : '');
    }
    const interesting = attrs.id || attrs.class || Object.keys(attrs).some((k) => k.startsWith('data-'));
    let node = null;
    if (interesting) {
      node = new StubEl(tag);
      Object.entries(attrs).forEach(([k, v]) => node.setAttribute(k, v));
      stack[stack.length - 1].appendChild(node);
    }
    if (VOID_TAGS.has(tag) || selfClose) continue;
    stack.push(node || stack[stack.length - 1]);
  }
}

class ClassList {
  constructor(el) { this.el = el; }
  _set() { return new Set((this.el._class || '').split(/\s+/).filter(Boolean)); }
  _write(s) { this.el._class = [...s].join(' '); }
  add(...c) { const s = this._set(); c.forEach((x) => s.add(x)); this._write(s); }
  remove(...c) { const s = this._set(); c.forEach((x) => s.delete(x)); this._write(s); }
  contains(c) { return this._set().has(c); }
  toggle(c, on) { if (on === undefined) on = !this.contains(c); on ? this.add(c) : this.remove(c); return on; }
}

class StubEl {
  constructor(tag = 'div') {
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this.parentNode = null;
    this._class = '';
    this._attrs = {};
    this.dataset = {};
    this.style = { cssText: '', setProperty() {}, removeProperty() {} };
    this._html = '';
    this._text = '';
    this.value = '';
    this.checked = false;
    this.disabled = false;
    this.files = [];
    this.offsetWidth = 100;
    this.classList = new ClassList(this);
    this._listeners = {};
  }
  get className() { return this._class; }
  set className(v) { this._class = v; }
  get id() { return this._attrs.id || ''; }
  set id(v) { this._attrs.id = v; }
  // 写入 innerHTML 时把串里带 id / data-* 的元素「物化」成子节点，
  // 否则 getElementById('#create')、querySelectorAll('[data-nav]') 全都取不到东西
  set innerHTML(v) {
    this._html = String(v == null ? '' : v);
    this.children = [];
    materialize(this, this._html);
  }
  get innerHTML() { return this._html; }
  set textContent(v) { this._text = String(v); }
  get textContent() { return this._text; }
  setAttribute(k, v) {
    this._attrs[k] = v;
    if (k === 'class') this._class = v;
    if (k.startsWith('data-')) this.dataset[k.slice(5).replace(/-(\w)/g, (_, c) => c.toUpperCase())] = v;
  }
  getAttribute(k) { return this._attrs[k]; }
  removeAttribute(k) { delete this._attrs[k]; }
  appendChild(c) { c.parentNode = this; this.children.push(c); return c; }
  insertBefore(c, ref) {
    c.parentNode = this;
    const i = ref ? this.children.indexOf(ref) : -1;
    if (i < 0) this.children.push(c); else this.children.splice(i, 0, c);
    return c;
  }
  removeChild(c) { const i = this.children.indexOf(c); if (i >= 0) this.children.splice(i, 1); c.parentNode = null; }
  remove() { if (this.parentNode) this.parentNode.removeChild(this); }
  // 前端多用 innerHTML 拼串，桩里把 HTML 里出现的纯文本抽出来，供 text() 断言
  _flatHtml() { return String(this._html || ''); }
  addEventListener(t, fn) { (this._listeners[t] = this._listeners[t] || []).push(fn); }
  removeEventListener() {}
  dispatch(t, ev = {}) {
    const e = { target: this, stopPropagation() {}, preventDefault() {}, ...ev };
    (this._listeners[t] || []).forEach((f) => f(e));
    // 前端大量使用 el.onclick / el.onchange 直接赋值，桩必须一并触发
    const inline = this['on' + t];
    if (typeof inline === 'function') inline(e);
  }
  click() { this.dispatch('click'); }
  focus() {}
  getBoundingClientRect() { return { left: 0, top: 0, right: 100, bottom: 100, width: 100, height: 100 }; }
  cloneNode() { const e = new StubEl(this.tagName); e._class = this._class; e._html = this._html; return e; }
  querySelector(sel) { return this._find(sel, false); }
  querySelectorAll(sel) { return this._find(sel, true); }
  _all(acc = []) { for (const c of this.children) { acc.push(c); c._all(acc); } return acc; }
  _find(sel, many) {
    // 支持 [data-x]、.class、#id、tag 的单一或组合选择器（够用即可）
    const parts = sel.trim().match(/(\[[^\]]+\]|[.#][\w-]+|[a-zA-Z]+)/g) || [];
    const match = (el) => parts.every((p) => {
      if (p.startsWith('[')) {
        const m = p.slice(1, -1).split('=');
        const k = m[0].replace(/^data-/, '').replace(/-(\w)/g, (_, c) => c.toUpperCase());
        if (k.startsWith('data-')) return false;
        const has = el.dataset[k] !== undefined || el._attrs[m[0]] !== undefined;
        if (m.length === 1) return has;
        const v = m[1].replace(/^["']|["']$/g, '');
        return String(el.dataset[k] !== undefined ? el.dataset[k] : el._attrs[m[0]]) === v;
      }
      if (p.startsWith('.')) return el.classList.contains(p.slice(1));
      if (p.startsWith('#')) return el.id === p.slice(1);
      return el.tagName === p.toUpperCase();
    });
    const all = this._all().filter(match);
    return many ? all : (all[0] || null);
  }
}

function installDom() {
  const body = new StubEl('body');
  const html = new StubEl('html');
  const store = {};
  const localStorage = {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: (k) => { delete store[k]; },
    clear: () => { Object.keys(store).forEach((k) => delete store[k]); },
  };
  const location = { origin: 'http://127.0.0.1', pathname: '/', search: '', href: 'http://127.0.0.1/' };
  const listeners = {};
  const g = globalThis;
  g.window = g;
  // app.js 末尾会调 window.addEventListener('popstate', …)，globalThis 本身没有该方法
  g.addEventListener = (t, f) => { (listeners[t] = listeners[t] || []).push(f); };
  g.removeEventListener = () => {};
  g.scrollTo = () => {};
  g.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  g.requestAnimationFrame = (fn) => setTimeout(() => fn(Date.now()), 0);
  g.cancelAnimationFrame = (id) => clearTimeout(id);
  g.alert = () => {};
  g.confirm = () => true;
  g.document = {
    body, documentElement: html,
    getElementById: (id) => {
      const hit = body._all().find((e) => e.id === id);
      if (hit) return hit;
      // 前端用 innerHTML 渲染，桩不建节点；这里按 id="xxx" 兜底造一个节点，避免 getElementById 返回 null
      if (new RegExp(`id=["']${id}["']`).test(body._html || '')) {
        const el = new StubEl('div');
        el.id = id;
        body.appendChild(el);
        return el;
      }
      return null;
    },
    querySelector: (s) => body.querySelector(s),
    querySelectorAll: (s) => body.querySelectorAll(s),
    createElement: (tag) => new StubEl(tag),
    addEventListener: (t, f) => { (listeners[t] = listeners[t] || []).push(f); },
    removeEventListener: () => {},
  };
  g.localStorage = localStorage;
  g.sessionStorage = localStorage;
  // app.js 加载时就会 const app = document.getElementById('app')，所以 #app 必须预先存在
  const appEl = new StubEl('main');
  appEl.id = 'app';
  body.appendChild(appEl);
  html.appendChild(body);
  g.location = location;
  g.history = {
    pushState(_s, _t, url) {
      const u = new URL(url, 'http://127.0.0.1');
      location.pathname = u.pathname; location.search = u.search; location.href = u.href;
    },
    replaceState(_s, _t, url) { g.history.pushState(_s, _t, url); },
  };
  // Node 22 的 navigator 是只有 getter 的内置对象，直接赋值会抛 TypeError
  try {
    Object.defineProperty(g, 'navigator', {
      configurable: true,
      value: { clipboard: { writeText: async () => {} }, vibrate: () => {} },
    });
  } catch { /* 忽略：已有可用 navigator */ }
  // 注意：这里必须捕获「真正的」fetch 引用。写成 g.fetch = (...a) => fetch(...a) 会自我递归爆栈。
  const nativeFetch = globalThis.fetch;
  g.fetch = (path, opts) => {
    const url = typeof path === 'string' && path.startsWith('/') ? S.baseUrl() + path : path;
    return nativeFetch(url, opts);
  };
  g.URL = URL;
  return { body, appEl, location, localStorage, listeners };
}

/* ---------------- 加载前端模块 ---------------- */
let dom;
let qd;

async function loadApp() {
  dom = installDom();          // installDom 内部已把 fetch 指到测试服务器
  await import('../src/web/app.js?t=' + Date.now());
  // 等 boot 完成
  await new Promise((r) => setTimeout(r, 200));
  qd = globalThis.__qd;
  assert(qd, '前端模块成功加载');
}

/* ---------------- 辅助 ---------------- */
// innerHTML 串 → 近似文本：去掉 script/style、标签变空格、解码常见实体
function toText(htmlStr) {
  return String(htmlStr || '')
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ');
}
function text() {
  const parts = [toText(dom.appEl._html), toText(dom.body._html)];
  dom.body._all().forEach((e) => { parts.push(e._text || '', toText(e._html)); });
  return parts.join('\n');
}
// 在某个节点的 innerHTML 串里按简单选择器取「虚拟节点」，供断言用
function pick(node, sel) {
  const el = new StubEl('div');
  el._html = node._html;
  el._attrs = { ...node._attrs };
  return el;
}
async function waitRender(ms = 90) { await new Promise((r) => setTimeout(r, ms)); }
async function go(path) {
  qd.navigate(path);
  await waitRender();
}

/* ---------------- 测试 ---------------- */
const tests = [];

const t1 = test('前端启动：未登录时自动跳到登录页，页面含手机号与验证码输入', async () => {
  await loadApp();
  await go('/my');
  await waitRender(200);
  const html = text();
  includes(html, '手机号', '渲染出手机号输入');
  includes(html, '验证码', '渲染出验证码输入');
  includes(html, '微信群负责说', '渲染出价值主张');
  eq(dom.location.pathname, '/login', '未登录被引导到登录页');
});

const t2 = test('登录流程：填手机号取码、填验证码登录 → 进入我的任务空态', async () => {
  const phone = '13911110001';
  const phoneEl = document.getElementById('phone');
  assert(phoneEl, '存在手机号输入框');
  phoneEl.value = phone;
  document.getElementById('send-btn').click();
  await waitRender(200);
  // 验证码由服务端下发，测试里直接走接口拿
  const dev = (text().match(/验证码 (\d{6})/) || [])[1];
  assert(dev, '开发模式下页面显示验证码：' + text().slice(0, 200));
  const codeEl = document.getElementById('code');
  codeEl.value = dev;
  document.getElementById('login-btn').click();
  await waitRender(350);
  includes(text(), '我的任务', '进入主界面');
  includes(text(), '建一个小组', '侧栏有建组入口');
  assert(qd.state.user, '登录态已写入');
});

const t3 = test('建组 → 自动进入成员页并弹出邀请链接', async () => {
  // 用全新账号建组，避免与前面用例共享「免费版 3 组」配额
  const { dev_code } = await qd.api('/api/auth/send-code', { body: { phone: '13911110002' } });
  const login = await qd.api('/api/auth/login', { body: { phone: '13911110002', code: dev_code, device_id: 'ui-test-t3' } });
  qd.state.token = login.token;
  qd.state.user = login.user;
  localStorage.setItem('qd_token', login.token);

  const g = await qd.api('/api/groups', { body: { name: '毕业设计小组', demo_tasks: true } });
  await qd.loadGroups();
  await go('/g/' + g.group.id + '/members');
  const html = text();
  includes(html, '毕业设计小组', '渲染小组名');
  includes(html, '邀请链接', '成员页有邀请区块');
  includes(html, '本周完成', '成员行有本周完成数');
});

const t4 = test('看板：四列渲染、每列有计数、示例任务出现在待办列', async () => {
  const gid = qd.state.groups[0].id;
  await go('/g/' + gid + '/board');
  const html = text();
  ['待办', '进行中', '已完成', '已取消'].forEach((l) => includes(html, l, '渲染列：' + l));
  includes(html, '定题并提交开题报告', '示例任务出现在看板');
  const cards = document.querySelectorAll('.bcard');
  assert(cards.length >= 3, '渲染出任务卡片，实际 ' + cards.length);
  assert(document.querySelector('.col[data-col="todo"]'), '待办列存在');
});

const t5 = test('新建任务：填标题与「下周三」，日期实时解析成具体日期', async () => {
  await go('/my');
  document.getElementById('quick-add').click();
  await waitRender(150);
  const modal = document.querySelector('.modal');
  assert(modal, '弹出新建任务弹层');
  modal.querySelector('#title').value = '把问卷发到群里';
  const dueEl = modal.querySelector('#due');
  dueEl.value = '下周三';
  dueEl.dispatch('input');
  await waitRender(200);
  const hint = modal.querySelector('#due-hint');
  assert(/\d{4}-\d{2}-\d{2}/.test(hint.textContent), '实时解析出具体日期：' + hint.textContent);
  modal.querySelector('#create').click();
  await waitRender(300);
  includes(text(), '任务建好了', '创建成功有提示');
});

const t6 = test('任务详情：渲染标题、责任人、截止、动态流、评论、附件区', async () => {
  const gid = qd.state.groups[0].id;
  const list = await qd.api(`/api/groups/${gid}/tasks`);
  const t = list.tasks.find((x) => x.title === '把问卷发到群里') || list.tasks[0];
  await go('/t/' + t.id);
  const html = text();
  includes(html, t.title, '渲染标题');
  includes(html, '责任人', '渲染责任人');
  includes(html, '动态', '渲染动态流');
  includes(html, '评论', '渲染评论区');
  includes(html, '附件', '渲染附件区');
  includes(html, '不可编辑、不可删除', '明确动态流不可改');
});

const t7 = test('分享：生成链接后分享页在免登录状态下可渲染，主按钮为「认领这件事」', async () => {
  const gid = qd.state.groups[0].id;
  const list = await qd.api(`/api/groups/${gid}/tasks`);
  const t = list.tasks[0];
  const sh = await qd.api(`/api/tasks/${t.id}/share`, { body: {} });
  // 模拟未登录访客
  const savedToken = qd.state.token;
  qd.state.token = '';
  localStorage.removeItem('qd_token');
  await go('/s/' + sh.token);
  const html = text();
  includes(html, t.title, '访客看得到标题');
  includes(html, '认领这件事', '唯一主按钮');
  includes(html, '微信群负责说', '价值主张');
  qd.state.token = savedToken;
  localStorage.setItem('qd_token', savedToken);
});

const t8 = test('我的任务：逾期任务进入「已逾期」分组并显示逾期天数', async () => {
  const gid = qd.state.groups[0].id;
  const past = new Date(Date.now() - 3 * 86400e3).toISOString();
  const r = await qd.api(`/api/groups/${gid}/tasks`, {
    body: { title: '早就该交的东西', due: past, assignee_id: qd.state.user.id },
  });
  await go('/my');
  const html = text();
  includes(html, '已逾期', '有逾期分组标题');
  includes(html, '早就该交的东西', '逾期任务出现在首页');
  includes(html, '逾期 3 天', '显示逾期天数');
});

const t9 = test('设置页：提醒开关与「加入日历」按钮存在，打开开关会写回服务端', async () => {
  await go('/settings');
  const html = text();
  includes(html, '每日 08:30', '有每日汇总开关');
  includes(html, '加入日历', '有 .ics 入口');
  const cb = document.getElementById('p-daily');
  assert(cb, '开关存在');
  cb.checked = false;
  cb.dispatch('change');
  await waitRender(250);
  const me = await qd.api('/api/me');
  eq(me.user.notify_prefs.daily, false, '关闭每日汇总已保存');
});

const t10 = test('高级版页：权益对比与价格渲染正确', async () => {
  await go('/plan');
  const html = text();
  includes(html, '一个学期 168 块，换不延期', '副标题与附录 A 一致');
  includes(html, '2GB', '渲染高级版空间');
  includes(html, '¥19', '渲染价格');
  includes(html, '退款', '渲染退款承诺');
});

const t11 = test('全站无脚本错误：连续切换 8 个页面均无异常', async () => {
  const errors = [];
  const onErr = (e) => errors.push(e);
  process.on('unhandledRejection', onErr);
  const gid = qd.state.groups[0].id;
  for (const p of ['/my', `/g/${gid}/board`, `/g/${gid}/list`, `/g/${gid}/files`, `/g/${gid}/members`, '/settings', '/plan', '/my']) {
    await go(p);
  }
  process.off('unhandledRejection', onErr);
  eq(errors.length, 0, '无未捕获异常：' + errors.map((x) => x && x.message).join('；'));
  includes(text(), '我的任务', '最终回到我的任务且渲染正常');
});

tests.push(t1, t2, t3, t4, t5, t6, t7, t8, t9, t10, t11);

async function main() {
  await S.start();
  const H = require('./harness');
  H.suite('前端冒烟', () => {});
  const res = await H.runAll(tests);
  await S.stop();
  const rep = report(res);
  console.log('\n轻队 QingDui · 前端冒烟测试（真实执行 app.js）');
  console.log(rep.text);
  if (rep.fail) {
    res.filter((r) => !r.ok).forEach((r) => console.log(`\n[${r.name}]\n${r.error.stack}`));
    process.exitCode = 1;
  }
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
