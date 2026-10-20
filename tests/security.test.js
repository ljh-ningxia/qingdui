// 安全回归测试（C1 ~ C7）
//
// 与验收测试的区别：验收测试测"功能对不对"，这里测"漏洞还在不在"。
// 每条用例都对应 代码审查报告.md 里的一个 P0 项，且都按攻击者的视角构造，
// 直接断言"攻击失败"，而不是断言"正常流程能跑通"。
const S = require('./setup');
const { suite, test, runAll, report, eq, assert } = require('./harness');
const crypto = require('node:crypto');
const { one } = require('../src/server/db');

const t = [];

/* ---------------- C1：硬编码兜底密钥 ---------------- */

t.push(test('C1 用公开常量自签 token → 必须被拒绝（不再有源码内兜底密钥）', async () => {
  const u = await S.signup('13800000001');

  // 复刻审计报告里的攻击：拿旧版源码中的公开常量签一个 token
  const PUBLIC_CONST = 'qingdui-local-dev-secret';
  const SECRET = crypto.createHash('sha256').update(PUBLIC_CONST + ':session').digest();
  const body = Buffer.from(JSON.stringify({ uid: u.user.id, exp: Date.now() + 3600_000 })).toString('base64url');
  const mac = crypto.createHmac('sha256', SECRET).update(body).digest('base64url');
  const forged = `${body}.${mac}`;

  const res = await S.client(forged).get('/api/me');
  eq(res.status, 401, '公开常量签出的 token 必须无效');
}));

t.push(test('C1 源码中不得再出现兜底密钥字面量', async () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const dir = path.join(__dirname, '..', 'src', 'server');
  const hits = [];
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.js')) continue;
    const src = fs.readFileSync(path.join(dir, f), 'utf8');
    // 允许在 secrets.js 的注释里提到它（那是说明），但不允许作为取值使用
    const codeLines = src.split('\n').filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*'));
    if (codeLines.some((l) => l.includes('qingdui-local-dev-secret'))) hits.push(f);
  }
  eq(hits.length, 0, `以下文件仍在代码中使用兜底密钥：${hits.join(', ') || '无'}`);
}));

/* ---------------- C2：验证码默认明文返回 ---------------- */

t.push(test('C2 默认配置下 send-code 不返回明文验证码', async () => {
  // tests/setup.js 里显式设了 QD_DEV_CODE=1，那是本地开发的合理场景。
  // 这里验证的是"开关判定必须是显式开启"：只有严格等于 '1' 才回显。
  // 只看非注释行，避免把说明文字当成代码。
  const src = require('node:fs').readFileSync(
    require('node:path').join(__dirname, '..', 'src', 'server', 'api.js'), 'utf8'
  );
  const code = src.split('\n')
    .filter((l) => {
      const s = l.trim();
      return s && !s.startsWith('//') && !s.startsWith('*') && !s.startsWith('/*');
    })
    .join('\n');

  assert(/QD_DEV_CODE\s*===\s*['"]1['"]/.test(code), '必须是显式等于 1 才开启');
  assert(!/QD_DEV_CODE\s*!==\s*['"]0['"]/.test(code), '不得再用 "!== 0" 这种默认开启的写法');
}));

t.push(test('C2 生产环境下即使设了 QD_DEV_CODE=1 也不回显验证码', async () => {
  const { execFileSync } = require('node:child_process');
  const path = require('node:path');
  const script = `
    process.env.QD_SECRET = 'x'.repeat(40);
    process.env.QD_DEV_CODE = '1';
    process.env.NODE_ENV = 'production';
    process.env.QD_DB = ':memory:';
    const api = require(${JSON.stringify(path.join(__dirname, '..', 'src', 'server', 'api.js'))});
    const R = require(${JSON.stringify(path.join(__dirname, '..', 'src', 'server', 'router.js'))});
    const { openDb } = require(${JSON.stringify(path.join(__dirname, '..', 'src', 'server', 'db.js'))});
    openDb();
    // 找到 send-code 的处理函数直接调用
    const route = R.routes.find((r) => r.re.test('/api/auth/send-code'));
    const out = route.handler({ body: { phone: '13800000099' }, user: null });
    console.log(JSON.stringify({ has_dev_code: 'dev_code' in out && out.dev_code !== undefined }));
  `;
  const out = execFileSync(process.execPath, ['-e', script], { encoding: 'utf8' });
  const r = JSON.parse(out.trim().split('\n').pop());
  eq(r.has_dev_code, false, '生产环境绝不回显验证码');
}));

/* ---------------- C3：客户端自称通过人机校验 ---------------- */

t.push(test('C3 伪造 human_verified:true → 不放行；必须用服务端凭证', async () => {
  const device = 'c3-device-' + Date.now();
  for (let i = 0; i < 3; i++) {
    const c = S.client();
    const phone = S.nextPhone();
    const s = await c.post('/api/auth/send-code', { phone });
    const l = await c.post('/api/auth/login', { phone, code: s.data.dev_code, device_id: device });
    eq(l.status, 200, `第 ${i + 1} 个账号放行`);
  }

  const victim = S.nextPhone();
  const c = S.client();
  const s = await c.post('/api/auth/send-code', { phone: victim });

  // 攻击 1：直接自称通过
  const byBool = await c.post('/api/auth/login', {
    phone: victim, code: s.data.dev_code, device_id: device, human_verified: true,
  });
  eq(byBool.status, 428, 'human_verified:true 不再被信任');

  // 攻击 2：伪造一个格式正确但签名错误的凭证
  const fakeBody = Buffer.from(JSON.stringify({ d: device, exp: Date.now() + 600000 })).toString('base64url');
  const byFakeToken = await c.post('/api/auth/login', {
    phone: victim, code: s.data.dev_code, device_id: device, human_check_token: `${fakeBody}.deadbeef`,
  });
  eq(byFakeToken.status, 428, '伪造签名的人机凭证无效');

  // 正解
  const hc = await c.post('/api/auth/human-check', { device_id: device });
  S.run('UPDATE otp_codes SET sent_at = ? WHERE phone = ?',
    Date.now() - 70000, require('../src/server/crypto.js').phoneIndex(victim));
  const s2 = await c.post('/api/auth/send-code', { phone: victim });
  const ok = await c.post('/api/auth/login', {
    phone: victim, code: s2.data.dev_code, device_id: device, human_check_token: hc.data.human_check_token,
  });
  eq(ok.status, 200, '服务端凭证可正常放行');
}));

/* ---------------- C4：解散后仍可写 ---------------- */

t.push(test('C4 小组解散后，所有群组写接口一律 403（逐条验证曾经漏掉的那几个）', async () => {
  const u = await S.signup('13800000003');
  const g = await S.makeGroup(u.client, '待解散组', false);

  const ok = await u.client.post(`/api/groups/${g.id}/dissolve`, {});
  eq(ok.status, 200, '解散成功');

  // 这三个在修复前都能返回 200
  const rename = await u.client.patch(`/api/groups/${g.id}`, { name: '改个名' });
  eq(rename.status, 403, '解散后不能改名');
  eq(rename.data.error.code, 'GROUP_READONLY');

  const invite = await u.client.post(`/api/groups/${g.id}/invites`, {});
  eq(invite.status, 403, '解散后不能发邀请');

  const upgrade = await u.client.post(`/api/groups/${g.id}/upgrade`, {});
  eq(upgrade.status, 403, '解散后不能升级');

  const transfer = await u.client.post(`/api/groups/${g.id}/transfer`, { user_id: u.user.id });
  eq(transfer.status, 403, '解散后不能转让');

  // 只读能力必须保留
  const read = await u.client.get(`/api/groups/${g.id}`);
  eq(read.status, 200, '解散后仍可查看');
  const exp = await u.client.get(`/api/groups/${g.id}/export`);
  eq(exp.status, 200, '解散后仍可导出');
}));

/* ---------------- C5：上传大小可伪造 ---------------- */

t.push(test('C5 声明 1 字节、实传 2MB → 按真实字节计费与判配额', async () => {
  const u = await S.signup('13800000004');
  const g = await S.makeGroup(u.client, '传文件组', false);
  const task = await S.makeTask(u.client, g.id, { title: '放附件' });

  const real = Buffer.alloc(2 * 1024 * 1024, 0x42);
  const r = await u.client.post(`/api/tasks/${task.id}/files`, {
    filename: 'huge.bin', size: 1, mime: 'application/octet-stream', data_b64: real.toString('base64'),
  });
  eq(r.status, 200, '2MB 未超免费单文件上限，允许上传');
  eq(r.data.attachment.size, 2 * 1024 * 1024, '数据库记录的是真实大小，不是声明的 1');

  const g2 = one('SELECT storage_used_bytes FROM groups WHERE id = ?', g.id);
  eq(g2.storage_used_bytes, 2 * 1024 * 1024, '组配额按真实字节累加');
}));

t.push(test('C5 空内容上传被拒绝，不会写入 0 字节幽灵文件', async () => {
  const u = await S.signup('13800000005');
  const g = await S.makeGroup(u.client, '空文件组', false);
  const task = await S.makeTask(u.client, g.id, { title: '空文件' });

  const r = await u.client.post(`/api/tasks/${task.id}/files`, {
    filename: 'empty.txt', size: 100, mime: 'text/plain', data_b64: '',
  });
  eq(r.status, 400, '空文件直接拒绝');
}));

/* ---------------- C6：提醒从未自动触发 / 30 天硬删不存在 ---------------- */

t.push(test('C6 调度器可用，且 runReminders 能被自动调用（不再是死代码）', async () => {
  const sch = require('../src/server/scheduler');
  const st = sch.status();
  eq(st.started, false, '未启动时状态为 false');

  sch.start({ reminderTick: 50, cleanupTick: 50 });
  const st2 = sch.status();
  eq(st2.started, true, '启动后状态为 true');
  sch.stop();
  eq(sch.status().started, false, '可干净停止');

  // 生产入口确实调用了它
  const src = require('node:fs').readFileSync(
    require('node:path').join(__dirname, '..', 'src', 'server', 'index.js'), 'utf8'
  );
  assert(/require\('\.\/scheduler'\)\.start\(\)/.test(src), '服务启动时必须拉起调度器');
}));

t.push(test('C6 解散超 30 天的小组被硬删除，30 天内保留', async () => {
  const sch = require('../src/server/scheduler');

  const u = await S.signup('13800000006');
  const keep = await S.makeGroup(u.client, '刚解散的组', true);
  const gone = await S.makeGroup(u.client, '很久以前解散的组', true);

  await u.client.post(`/api/groups/${keep.id}/dissolve`, {});
  await u.client.post(`/api/groups/${gone.id}/dissolve`, {});

  // 把后者推到 31 天前
  const OLD = Date.now() - 31 * 24 * 3600 * 1000;
  S.run('UPDATE groups SET deleted_at = ? WHERE id = ?', OLD, gone.id);

  const r = sch.tickCleanup();
  assert(r.purged >= 1, `至少清理 1 个，实际 ${r.purged}`);

  const still = one('SELECT COUNT(*) AS c FROM groups WHERE id = ?', keep.id);
  eq(still.c, 1, '30 天内的组保留');
  const removed = one('SELECT COUNT(*) AS c FROM groups WHERE id = ?', gone.id);
  eq(removed.c, 0, '超过 30 天的组已彻底删除');
}));

/* ---------------- C7：transfer_to 未校验 ---------------- */

t.push(test('C7 移除成员时把任务转交给不存在的用户 → 必须拒绝', async () => {
  const owner = await S.signup('13800000007');
  const g = await S.makeGroup(owner.client, '转交组', true);
  const member = await S.signup('13800000008');
  await S.addMember(owner.client, g.id, member.client);
  const memberId = member.user.id;

  const task = await S.makeTask(owner.client, g.id, { title: '要转交的任务', assignee_id: memberId });

  // 攻击：转交给一个根本没加入过小组的 ID
  const bad = await owner.client.post(`/api/groups/${g.id}/members/${memberId}/remove`, {
    transfer_to: 'u_totally_fake_user',
  });
  eq(bad.status, 400, '不存在的接收人被拒绝');

  // 任务必须还挂在原责任人名下，没有被改坏
  const t1 = one('SELECT assignee_id FROM tasks WHERE id = ?', task.id);
  eq(t1.assignee_id, memberId, '任务未被错误改派');

  // 正常路径：转交给组长
  const good = await owner.client.post(`/api/groups/${g.id}/members/${memberId}/remove`, {
    transfer_to: owner.user.id,
  });
  eq(good.status, 200, '转交给本组成员正常放行');
  const t2 = one('SELECT assignee_id FROM tasks WHERE id = ?', task.id);
  eq(t2.assignee_id, owner.user.id, '任务已转交给组长');
}));

module.exports = t;

async function main() {
  await S.start();
  suite('安全回归（C1 ~ C7）', () => {});
  const res = await runAll(t);
  await S.stop();
  const rep = report(res);
  console.log('\n轻队 QingDui · 安全回归测试（对应 代码审查报告.md 的 P0 项）');
  console.log(rep.text);
  if (rep.fail) {
    console.log('\n失败详情：');
    res.filter((r) => !r.ok).forEach((r) => {
      console.log(`\n[${r.name}]\n${r.error.stack}`);
    });
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main().catch((e) => { console.error(e); process.exitCode = 1; });
}
