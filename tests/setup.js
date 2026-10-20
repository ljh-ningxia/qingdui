// 测试环境：真实 HTTP 服务 + 内存数据库，所有断言都走接口，不走内部函数
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

// C1 修复后密钥有最小长度要求（32 字符），测试用一个固定的长密钥
process.env.QD_SECRET = 'test-secret-qingdui-0123456789abcdef-固定测试密钥';
process.env.QD_DEV_CODE = '1';
// 测试必须用内存库：否则会读到 data/qingdui.db 里的历史数据，
// 撞上「免费版 3 个小组」之类的业务上限，让用例互相污染。
process.env.QD_DB = ':memory:';

const app = require('../src/server/index.js');
const { getDb, run, closeDb } = require('../src/server/db');

let server;
let baseUrl;

async function start() {
  server = app.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  baseUrl = `http://127.0.0.1:${port}`;
  return baseUrl;
}

async function stop() {
  if (server) await new Promise((r) => server.close(r));
  closeDb();
}

let phoneSeq = 0;
function nextPhone() {
  phoneSeq += 1;
  return '138' + String(10000000 + phoneSeq).slice(0, 8);
}

/**
 * 一个 API 客户端 = 一个用户会话
 */
function client(token) {
  const self = {
    token: token || null,
    async call(method, path, body, opts = {}) {
      const headers = {};
      if (self.token) headers.authorization = `Bearer ${self.token}`;
      if (body !== undefined) headers['content-type'] = 'application/json';
      const res = await fetch(baseUrl + path, {
        method, headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
        redirect: 'manual',
      });
      const ct = res.headers.get('content-type') || '';
      let data = null;
      if (ct.includes('application/json')) data = await res.json();
      else data = await res.text();
      return { status: res.status, data, headers: res.headers };
    },
    get: (p) => self.call('GET', p),
    post: (p, b) => self.call('POST', p, b === undefined ? {} : b),
    patch: (p, b) => self.call('PATCH', p, b),
    del: (p) => self.call('DELETE', p),
  };
  return self;
}

/** 完整登录一个新用户，返回 { client, user, phone, code } */
async function signup(phoneOverride) {
  const c = client();
  const phone = phoneOverride || nextPhone();
  const s = await c.post('/api/auth/send-code', { phone });
  if (s.status !== 200) throw new Error('发送验证码失败：' + JSON.stringify(s.data));
  const code = s.data.dev_code;
  const l = await c.post('/api/auth/login', { phone, code, device_id: 'dev-' + phone });
  if (l.status !== 200) throw new Error('登录失败：' + JSON.stringify(l.data));
  c.token = l.data.token;
  return { client: c, user: l.data.user, phone, code };
}

/** 建组，可选关掉示例任务 */
async function makeGroup(client, name = '测试小组', demo = false) {
  const r = await client.post('/api/groups', { name, demo_tasks: demo });
  if (r.status !== 200) throw new Error('建组失败：' + JSON.stringify(r.data));
  return r.data.group;
}

async function addMember(ownerClient, groupId, memberClient) {
  const inv = await ownerClient.post(`/api/groups/${groupId}/invites`, {});
  const token = inv.data.token;
  const j = await memberClient.post(`/api/invites/${token}/join`, {});
  if (j.status !== 200) throw new Error('加入失败：' + JSON.stringify(j.data));
  return token;
}

async function makeTask(client, groupId, body) {
  const r = await client.post(`/api/groups/${groupId}/tasks`, body);
  if (r.status !== 200) throw new Error('建任务失败：' + JSON.stringify(r.data));
  return r.data.task;
}

function db() { return getDb(); }

module.exports = {
  start, stop, client, signup, makeGroup, addMember, makeTask, nextPhone, db, run, baseUrl: () => baseUrl,
};
