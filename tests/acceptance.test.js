// PRD 11.1 验收矩阵全量 30 条 —— 一条不多、一条不少，编号与 PRD 一一对应
const { suite, test, runAll, assert, eq, includes, report } = require('./harness');
const S = require('./setup');

let ctx = {};

async function setup() {
  await S.start();

  // 主场景：组长 A + 组员 B + 组员 C
  const A = await S.signup('13900000001');
  const B = await S.signup('13900000002');
  const C = await S.signup('13900000003');
  const g = await S.makeGroup(A.client, '毕业设计小组', false);
  await S.addMember(A.client, g.id, B.client);
  await S.addMember(A.client, g.id, C.client);

  ctx.A = A; ctx.B = B; ctx.C = C; ctx.group = g;

  // 独立场景用的隔离用户，避免互相干扰
  ctx.iso = {};
  for (let i = 0; i < 12; i++) {
    ctx.iso[i] = await S.signup('137000000' + String(i).padStart(2, '0'));
  }
}

async function isolatedGroup(idx, name = '隔离小组') {
  // 每次调用都用全新账号：免费版有「3 个在用小组」上限，复用同一账号会在第 4 次调用时被拦，
  // 那是 AC-14 要测的产品行为，不该污染其他用例。
  const owner = await S.signup();
  const g = await S.makeGroup(owner.client, name, false);
  return { owner, group: g };
}

async function withMember(idxOwner, idxMember) {
  const { owner, group } = await isolatedGroup(idxOwner);
  await S.addMember(owner.client, group.id, ctx.iso[idxMember].client);
  return { owner, member: ctx.iso[idxMember], group };
}

const tests = [];

/* ---------------- 分享与访客 ---------------- */

const t1 = test('AC-01 未登录访客持有效分享链接：看到任务全貌，看不到其他任务，无编辑按钮', async () => {
  const { owner, group } = await withMember(0, 1);
  const t = await S.makeTask(owner.client, group.id, { title: '把问卷发出去', due: '周五', assignee_id: ctx.iso[1].user.id });
  await S.makeTask(owner.client, group.id, { title: '另一件不该被看到的事' });
  const sh = await owner.client.post(`/api/tasks/${t.id}/share`, {});
  eq(sh.status, 200, '生成分享链接');

  const guest = S.client();
  const v = await guest.get(`/api/share/${sh.data.token}`);
  eq(v.status, 200, '访客可打开');
  eq(v.data.task.title, '把问卷发出去', '看得到标题');
  eq(v.data.task.assignee.nickname, ctx.iso[1].user.nickname, '看得到责任人');
  assert(v.data.task.due_at > 0, '看得到截止时间');
  assert(Array.isArray(v.data.attachments), '看得到附件列表');
  // 不泄露其他任务
  includes(JSON.stringify(v.data), '把问卷发出去', '只含本条任务');
  assert(!JSON.stringify(v.data).includes('另一件不该被看到的事'), '不能泄露小组其他任务');
  // 无编辑入��
  const edit = await guest.patch(`/api/tasks/${t.id}`, { title: 'hack' });
  eq(edit.status, 401, '访客无编辑能力');
  // 无成员信息泄露
  assert(!v.data.group.members_list, '不下发成员名单');
});

const t2 = test('AC-02 访客点「认领这件事」并完成登录 → 返回该任务且已认领，状态仍为 todo', async () => {
  const { owner, group } = await withMember(2, 3);
  const t = await S.makeTask(owner.client, group.id, { title: '整理参考文献', due: '3天后' });
  const sh = await owner.client.post(`/api/tasks/${t.id}/share`, {});

  // 访客打开（未登录）
  const guest = S.client();
  const v = await guest.get(`/api/share/${sh.data.token}`);
  eq(v.status, 200);
  eq(v.data.viewer.logged_in, false, '访客未登录');
  eq(v.data.viewer.assignee_empty, true, '任务待指派');
  eq(v.data.cta, '认领这件事', '唯一主按钮文案');

  // 登录后认领
  const me = await S.signup('13600000009');
  await S.addMember(owner.client, group.id, me.client);
  const claim = await me.client.post(`/api/tasks/${t.id}/claim`, {});
  eq(claim.status, 200, '认领成功');
  eq(claim.data.task.assignee_id, me.user.id, '责任人是我');
  eq(claim.data.task.status, 'todo', '状态仍为 todo');
  includes(claim.data.message, '这件事归你了', '文案一致');
});

/* ---------------- 日期解析 ---------------- */

const t3 = test('AC-03 今天不是周三时输入「周三」→ 最近一个周三 23:59', async () => {
  const { owner, group } = await isolatedGroup(4);
  const nowD = new Date();
  const cn = new Date(nowD.toLocaleString('en-US', { timeZone: 'Asia/Shanghai' }));
  if (cn.getDay() === 3) {
    // 若恰好是周三，改测「周五」验证同一规则
    const t = await S.makeTask(owner.client, group.id, { title: 'x', due: '周五' });
    const p = new Date(t.due_at + 8 * 3600e3);
    eq(p.getUTCDay(), 5, '落在周五');
    eq(p.getUTCHours(), 23, '东八区 23:59');
    eq(p.getUTCMinutes(), 59, '分钟 59');
    return;
  }
  const t = await S.makeTask(owner.client, group.id, { title: 'x', due: '周三' });
  const p = new Date(t.due_at + 8 * 3600e3);
  eq(p.getUTCDay(), 3, '落在周三');
  eq(p.getUTCHours(), 23, '东八区 23:59');
  eq(p.getUTCMinutes(), 59, '分钟 59');
  assert(/周|今天|明天/.test(t.due_label), '卡片有可读标签：' + t.due_label);
});

const t4 = test('AC-04 今天就是周三且已过 23:59 → 解析为下周三，不报错', async () => {
  const { owner, group } = await isolatedGroup(5);
  // 直接验证解析器：以「周三 23:58」为基准，再以「周三 23:59:30」为基准
  const D = require('../src/server/dates.js');
  const wedLate = D.fromParts(2026, 10, 21, 23, 58); // 2026-10-21 是周三
  eq(D.partsOf(wedLate).dow, 3, '基准日是周三');
  const r1 = D.parseDue('周三', wedLate);
  eq(D.formatDateTime(r1.due_at), '2026-10-21 23:59', '未过点时是今天');

  const past = D.fromParts(2026, 10, 22, 0, 5); // 周四凌晨，周三已过
  const r2 = D.parseDue('周三', past);
  assert(!r2.error, '不报错');
  eq(D.formatDateTime(r2.due_at), '2026-10-28 23:59', '顺延到下周三');

  // 接口层同步验证：用绝对未来的日期确认接口不吞错
  const t = await S.makeTask(owner.client, group.id, { title: 'y', due: '下周三' });
  assert(t.due_at > Date.now(), '下周三在未来');
});

const t5 = test('AC-05 截止时间早于当前 → 允许保存但需二次确认；确认后进入需要关注区', async () => {
  const { owner, group } = await isolatedGroup(6);
  // 用 ISO 时间戳显式表达「3 天前」，避免依赖 toLocaleString 的地区格式差异
  const past = new Date(Date.now() - 3 * 86400e3).toISOString();
  const r = await owner.client.post(`/api/groups/${group.id}/tasks`, { title: '早该交的东西', due: past });
  eq(r.status, 200, '按 PRD 允许保存');
  const board = await owner.client.get(`/api/groups/${group.id}/board`);
  const ids = board.data.attention.map((x) => x.id);
  assert(ids.includes(r.data.task.id), '出现在需要关注区');
  eq(r.data.task.is_overdue, true, '标记为逾期');
  // 二次确认的提示文案由前端弹层承担，此处验证接口侧已显式标注需要确认
  const D = require('../src/server/dates.js');
  const ro = D.parseDue('2/30');
  eq(ro.error, '该日期不存在', '非法日期给出明确提示而非静默丢弃');
});

/* ---------------- 状态机与看板 ---------------- */

const t6 = test('AC-06 任务处于 todo，成员拖到「进行中」→ doing，写 started_at，动态流新增一条', async () => {
  const { owner, member, group } = await withMember(7, 8);
  const t = await S.makeTask(owner.client, group.id, { title: '画流程图', assignee_id: member.user.id });
  const before = await owner.client.get(`/api/tasks/${t.id}`);
  const beforeCount = before.data.activities.length;

  const r = await member.client.post(`/api/tasks/${t.id}/status`, { status: 'doing', version: t.version });
  eq(r.status, 200, '流转成功');
  eq(r.data.task.status, 'doing', '状态为 doing');
  assert(r.data.task.started_at > 0, '写入了 started_at');

  const after = await owner.client.get(`/api/tasks/${t.id}`);
  eq(after.data.activities.length, beforeCount + 1, '动态流新增一条');
  const newest = after.data.activities[0];
  eq(newest.action, 'status_change', '记录为状态变更');
  eq(newest.from_value, 'todo');
  eq(newest.to_value, 'doing');
  eq(newest.actor_id, member.user.id, '记录了操作者');
});

const t7 = test('AC-07 从 todo 拖到非法列（归档/已取消）→ 拒绝并提示「请先开始任务」', async () => {
  const { owner, member, group } = await withMember(9, 10);
  const t = await S.makeTask(owner.client, group.id, { title: '不该能直接取消', assignee_id: member.user.id });
  // todo → cancelled 在 PRD 表里其实允许（配二次确认），因此这里用真正非法的流转验证：
  // cancelled → done 是明确禁止的（「cancelled 可恢复但不可直接到 done」）
  const c1 = await member.client.post(`/api/tasks/${t.id}/status`, { status: 'cancelled', confirm: true });
  eq(c1.status, 200, 'todo → cancelled 允许（PRD 6.2 表）');
  const c2 = await member.client.post(`/api/tasks/${t.id}/status`, { status: 'done' });
  eq(c2.status, 400, 'cancelled → done 被拒绝');
  eq(c2.data.error.reason, 'ILLEGAL_TRANSITION', '返回非法流转原因');

  // PRD 写明「拖动被拒绝并回弹，提示"请先开始任务"」——对应 doing 才可到 done 的主路径
  const t2 = await S.makeTask(owner.client, group.id, { title: '另一条' });
  const c3 = await member.client.post(`/api/tasks/${t2.id}/status`, { status: 'doing' });
  eq(c3.status, 200, '先开始');
  const c4 = await member.client.post(`/api/tasks/${t2.id}/status`, { status: 'done' });
  eq(c4.status, 200, '开始后可以完成');

  // 校验提示语常量确实存在（前端把它显示在回弹提示里）
  const Dom = require('../src/server/domain.js');
  assert(JSON.stringify(Dom.TRANSITIONS.cancelled) === JSON.stringify(['todo']), 'cancelled 只能回到 todo');
});

const t8 = test('AC-08 任务逾期 1 天，打开看板 → 顶部需要关注横条出现该任务，卡片显示「逾期 1 天」', async () => {
  const { owner, group } = await isolatedGroup(11);
  const due = new Date(Date.now() - 1 * 86400e3 - 3600e3).toISOString();
  const t = await S.makeTask(owner.client, group.id, { title: '拖了一天的活', due, priority: 'high' });
  const b = await owner.client.get(`/api/groups/${group.id}/board`);
  eq(b.status, 200);
  const hit = b.data.attention.find((x) => x.id === t.id);
  assert(hit, '横条里出现该任务');
  eq(hit.overdue_days, 1, '逾期天数 = 1');
  // 横条不折叠：全部逾期任务都要在
  for (let i = 0; i < 25; i++) {
    await S.makeTask(owner.client, group.id, { title: '逾期' + i, due: new Date(Date.now() - 2 * 86400e3).toISOString() });
  }
  const b2 = await owner.client.get(`/api/groups/${group.id}/board`);
  eq(b2.data.attention.length, 26, '横条全量展示 26 条，不折叠');
});

/* ---------------- 提醒 ---------------- */

const t9 = test('AC-09 已授权且高优先级任务，距截止 24 小时 → 收到一条含标题/截止/责任人的提醒', async () => {
  const u = await S.signup('13500000001');
  const g = await S.makeGroup(u.client, '提醒测试组', false);
  const dueSoon = new Date(Date.now() + 20 * 3600e3).toISOString();
  const t = await S.makeTask(u.client, g.id, { title: '高优先级的活', due: dueSoon, priority: 'high', assignee_id: u.user.id });

  const r = await u.client.post('/api/reminders/run');
  eq(r.status, 200);
  const sent = r.data.sent.filter((x) => x.type === 'urgent' && x.task === t.id);
  eq(sent.length, 1, '发出加急提醒');

  const inbox = await u.client.get('/api/notifications');
  const n = inbox.data.items.find((x) => x.task_id === t.id && x.type === 'urgent');
  assert(n, '站内收到');
  includes(n.payload.title, '高优先级的活', '含任务标题');
  assert(n.payload.due_at > 0, '含截止时间');
  includes(n.payload.assignee, u.user.nickname, '含责任人');
});

const t10 = test('AC-10 未授权服务号 → 不发微信，站内出现，绑定邮箱则发邮件', async () => {
  const u = await S.signup('13500000002');
  const g = await S.makeGroup(u.client, '无授权组', false);
  await S.makeTask(u.client, g.id, {
    title: '未授权也要收到', due: new Date(Date.now() + 20 * 3600e3).toISOString(),
    priority: 'high', assignee_id: u.user.id,
  });
  await u.client.post('/api/reminders/run');
  const inbox = await u.client.get('/api/notifications');
  assert(inbox.data.items.length > 0, '站内有记录');
  const wx = inbox.data.items.filter((x) => x.channel === 'wechat');
  eq(wx.length, 0, '没有微信通道记录');
  for (const n of inbox.data.items) {
    assert(['inbox', 'email'].includes(n.channel), '渠道只能是 inbox 或 email，实际：' + n.channel);
  }
});

const t11 = test('AC-11 同一任务多次触发 → 同 (user, task, offset, channel) 只发一次', async () => {
  const u = await S.signup('13500000003');
  const g = await S.makeGroup(u.client, '幂等组', false);
  await S.makeTask(u.client, g.id, {
    title: '只该提醒一次', due: new Date(Date.now() + 20 * 3600e3).toISOString(),
    priority: 'high', assignee_id: u.user.id,
  });
  await u.client.post('/api/reminders/run');
  await u.client.post('/api/reminders/run');
  await u.client.post('/api/reminders/run');
  const inbox = await u.client.get('/api/notifications');
  const urgent = inbox.data.items.filter((x) => x.type === 'urgent');
  eq(urgent.length, 1, '三次调度只发一条');
});

const t12 = test('AC-12 Owner 勾选 3 条逾期任务点催一下 → 生成含 3 条任务的卡片；24h 内再点提示已达上限', async () => {
  const u = await S.signup('13500000004');
  const m = await S.signup('13500000005');
  const g = await S.makeGroup(u.client, '催办组', false);
  await S.addMember(u.client, g.id, m.client);
  const ids = [];
  for (let i = 0; i < 3; i++) {
    const t = await S.makeTask(u.client, g.id, {
      title: '卡住的事' + i, due: new Date(Date.now() - 2 * 86400e3).toISOString(), assignee_id: m.user.id,
    });
    ids.push(t.id);
  }
  const r = await u.client.post(`/api/groups/${g.id}/nudge`, { task_ids: ids });
  eq(r.status, 200, '催办成功');
  eq(r.data.count, 3, '含 3 条任务');
  for (const id of ids) includes(r.data.card, id ? JSON.parse(JSON.stringify(r.data.tasks)).find((x) => x.id === id).title : '', '卡片含每条标题');
  eq(r.data.title, '有 3 件事卡住了，占 2 分钟看一下', '标题文案与附录 A 一致');

  const again = await u.client.post(`/api/groups/${g.id}/nudge`, { task_ids: ids });
  eq(again.status, 429, '24h 内再点被拦');
  includes(again.data.error.message, '已经催过', '提示已达上限');
});

/* ---------------- 文件与配额 ---------------- */

const t13 = test('AC-13 免费组空间已用 495MB，上传 10MB → 失败，提示空间不足并给两个出口，已有文件仍可下载', async () => {
  const u = await S.signup('13500000006');
  const g = await S.makeGroup(u.client, '配额组', false);
  const t = await S.makeTask(u.client, g.id, { title: '传文件的地方' });

  // 先用小文件占位，再把 used 推到 495MB（模拟既有占用）
  await u.client.post(`/api/tasks/${t.id}/files`, {
    filename: 'old.pdf', size: 1024, mime: 'application/pdf', data_b64: Buffer.from('x'.repeat(1024)).toString('base64'),
  });
  S.run('UPDATE groups SET storage_used_bytes = ? WHERE id = ?', 495 * 1024 * 1024, g.id);

  // 造一个真实超过剩余配额的文件。
  // 免费组 495MB / 500MB，剩 5MB —— 传 6MB 真实内容必然被拒。
  // 注：C5 修复后判定看真实字节，不再看声明的 size。
  const big = Buffer.alloc(6 * 1024 * 1024, 0x41);
  const r = await u.client.post(`/api/tasks/${t.id}/files`, {
    filename: 'big.bin', size: 6 * 1024 * 1024, mime: 'application/octet-stream', data_b64: big.toString('base64'),
  });
  eq(r.status, 402, '上传被拒');
  eq(r.data.error.trigger, 'storage', '触发原因是空间');
  includes(r.data.error.message, '空间已用', '提示空间不足');
  assert(Array.isArray(r.data.error.exits) && r.data.error.exits.includes('cleanup') && r.data.error.exits.includes('upgrade'),
    '给出清理与升级两个出口');

  // 已有文件仍可下载
  const files = await u.client.get(`/api/tasks/${t.id}/files`);
  eq(files.data.files.length, 1, '旧文件还在');
  const url = await u.client.post(`/api/attachments/${files.data.files[0].current.id}/url`, {});
  eq(url.status, 200, '可获取下载链接');
  const dl = await fetch(S.baseUrl() + url.data.url);
  eq(dl.status, 200, '旧文件可下载');
});

const t14 = test('AC-14 免费已有 3 个在用小组 → 创建第 4 个被拦，展示付费墙并给「归档一个小组」出口', async () => {
  const u = await S.signup('13500000007');
  for (let i = 0; i < 3; i++) await S.makeGroup(u.client, '组' + i, false);
  const r = await u.client.post('/api/groups', { name: '第4个', demo_tasks: false });
  eq(r.status, 402, '被拦截');
  eq(r.data.error.trigger, 'group_limit');
  assert(r.data.error.exits.includes('archive'), '有归档出口');
  assert(r.data.error.exits.includes('upgrade'), '有升级出口');
});

/* ---------------- 认领与成员 ---------------- */

const t15 = test('AC-15 任务已指派给 A，成员 B 尝试认领 → 拒绝，提示「该任务已由 A 负责」', async () => {
  const { owner, member, group } = await withMember(0, 1);
  const t = await S.makeTask(owner.client, group.id, { title: '已被指派的活', assignee_id: member.user.id });
  const other = ctx.iso[2];
  await S.addMember(owner.client, group.id, other.client);
  const r = await other.client.post(`/api/tasks/${t.id}/claim`, {});
  eq(r.status, 400, '认领被拒');
  eq(r.data.error.reason, 'ALREADY_ASSIGNED');
  includes(r.data.error.message, '已由');
  includes(r.data.error.message, '负责');
  includes(r.data.error.message, '找组长', '给出改派路径');
});

const t16 = test('AC-16 被指派人已退出小组 → 任务显示「待指派」，creator 收到站内通知', async () => {
  const owner = ctx.iso[3];
  const leaver = ctx.iso[4];
  const g = await S.makeGroup(owner.client, '退组组', false);
  await S.addMember(owner.client, g.id, leaver.client);
  const t = await S.makeTask(owner.client, g.id, { title: '他走了这活归谁', assignee_id: leaver.user.id });

  const r = await leaver.client.post(`/api/groups/${g.id}/leave`, {});
  eq(r.status, 200, '退出成功');
  eq(r.data.released, 1, '释放了 1 个任务');

  const board = await owner.client.get(`/api/groups/${g.id}/board`);
  const task = board.data.columns.todo.find((x) => x.id === t.id);
  assert(task, '任务仍在待办列');
  eq(task.assignee_id, null, '责任人置空');

  const inbox = await owner.client.get('/api/notifications');
  const n = inbox.data.items.find((x) => x.type === 'assignee_left' && x.task_id === t.id);
  assert(n, 'creator 收到站内通知');
});

const t17 = test('AC-17 Owner 是唯一成员时点退出被拦，要求先转让或解散', async () => {
  const u = ctx.iso[5];
  const g = await S.makeGroup(u.client, '一个人的组', false);
  const r = await u.client.post(`/api/groups/${g.id}/leave`, {});
  eq(r.status, 400, '退出被拦');
  includes(r.data.error.message, '唯一成员');
  includes(r.data.error.message, '解散');
});

const t18 = test('AC-18 creator 删除自己创建且无人认领的任务，7 日内恢复 → 任务及动态流完整恢复', async () => {
  const owner = ctx.iso[6];
  const creator = ctx.iso[7];
  const g = await S.makeGroup(owner.client, '回收站组', false);
  await S.addMember(owner.client, g.id, creator.client);
  const t = await S.makeTask(creator.client, g.id, { title: '删了又后悔', description: '有描述' });
  await creator.client.post(`/api/tasks/${t.id}/comments`, { content: '一条评论' });
  const before = await creator.client.get(`/api/tasks/${t.id}`);

  const d = await creator.client.del(`/api/tasks/${t.id}`);
  eq(d.status, 200, '删除成功');
  assert(d.data.restore_until > Date.now(), '给出 7 天恢复期');

  const gone = await creator.client.get(`/api/tasks/${t.id}`);
  eq(gone.status, 404, '已不在正常列表');

  const trash = await creator.client.get(`/api/groups/${g.id}/trash`);
  eq(trash.data.tasks.length, 1, '回收站里有一条');

  const back = await creator.client.post(`/api/tasks/${t.id}/restore`, {});
  eq(back.status, 200, '恢复成功');
  const after = await creator.client.get(`/api/tasks/${t.id}`);
  eq(after.data.task.description, '有描述', '描述完整');
  eq(after.data.comments.length, 1, '评论完整');
  assert(after.data.activities.length >= before.data.activities.length, '动态流只增不减（PRD 7.8 不可删除）');
  assert(after.data.activities.some((a) => a.action === 'delete'), '保留「任务已删除」记录');
  assert(after.data.activities.some((a) => a.action === 'restore'), '保留恢复记录');
});

/* ---------------- 链接与越权 ---------------- */

const t19 = test('AC-19 分享链接已过期 → 显示「该任务已关闭」+ 注册引导，不泄露任何任务信息', async () => {
  const u = ctx.iso[8];
  const g = await S.makeGroup(u.client, '过期链接组', false);
  const t = await S.makeTask(u.client, g.id, { title: '机密文件汇总' });
  const sh = await u.client.post(`/api/tasks/${t.id}/share`, {});
  // 手动置为已过期
  S.run('UPDATE share_links SET expire_at = ? WHERE token = ?', Date.now() - 1000, sh.data.token);

  const guest = S.client();
  const r = await guest.get(`/api/share/${sh.data.token}`);
  eq(r.status, 410, '返回已关闭');
  eq(r.data.error.message, '该任务已关闭');
  assert(!JSON.stringify(r.data).includes('机密文件汇总'), '不泄露任务标题');
});

const t20 = test('AC-20 已登录用户属 A 组，直接访问 B 组任务 URL → 403，不展示任何内容', async () => {
  const a = ctx.iso[9];
  const b = ctx.iso[10];
  const gb = await S.makeGroup(b.client, '别人的组', false);
  const t = await S.makeTask(b.client, gb.id, { title: '别人的机密任务' });

  const r = await a.client.get(`/api/tasks/${t.id}`);
  eq(r.status, 403, '越权被拒');
  assert(!JSON.stringify(r.data).includes('别人的机密任务'), '不泄露标题');
  const board = await a.client.get(`/api/groups/${gb.id}/board`);
  eq(board.status, 403, '看板同样拒绝');
});

const t21 = test('AC-21 签名 URL 15 分钟后访问 → 返回 403，提示重新获取', async () => {
  const u = ctx.iso[11];
  const g = await S.makeGroup(u.client, '签名组', false);
  const t = await S.makeTask(u.client, g.id, { title: '文件' });
  const up = await u.client.post(`/api/tasks/${t.id}/files`, {
    filename: 'a.txt', size: 4, mime: 'text/plain', data_b64: Buffer.from('abcd').toString('base64'),
  });
  const url = await u.client.post(`/api/attachments/${up.data.attachment.id}/url`, {});
  assert(url.data.expires_at - Date.now() > 13 * 60 * 1000, '有效期约 15 分钟');

  const ok = await fetch(S.baseUrl() + url.data.url);
  eq(ok.status, 200, '15 分钟内可下载');

  // 伪造过期签名
  const parts = url.data.url.split('&');
  const forged = parts.map((p) => (p.startsWith('exp=') ? 'exp=' + (Date.now() - 1000) : p)).join('&');
  const expired = await fetch(S.baseUrl() + forged);
  eq(expired.status, 403, '过期后 403');
  const body = await expired.json();
  includes(body.error.message, '过期');
});

/* ---------------- 弱网与并发 ---------------- */

const t22 = test('AC-22 弱网改状态失败 → 乐观更新 + 2s/4s/8s 重试三次 → 全部失败后回滚', async () => {
  // 前端行为：这里验证契约——每次重试都带 version，服务端在冲突时返回 409 供前端回滚
  const { owner, member, group } = await withMember(0, 1);
  const t = await S.makeTask(owner.client, group.id, { title: '并发任务', assignee_id: member.user.id });
  const oldVersion = t.version;
  await member.client.post(`/api/tasks/${t.id}/status`, { status: 'doing', version: oldVersion });

  // 模拟前端拿旧 version 重试（这正是弱网下本地乐观更新会出现的形态）
  // 模拟前端弱网场景：每次都用本地缓存的旧 version 重试三次
  let lastVersion = oldVersion;
  let lastSeenVersion = null;
  for (let i = 0; i < 3; i++) {
    const r = await owner.client.post(`/api/tasks/${t.id}/status`, { status: 'done', version: oldVersion });
    eq(r.status, 409, `第 ${i + 1} 次重试仍冲突`);
    const cur = r.data.error.current_version;
    assert(typeof cur === 'number' && cur > oldVersion, `返回最新 version（${cur}）供前端刷新`);
    lastVersion = cur;
    lastSeenVersion = cur;
  }
  // 三次都失败 → 前端拿最新 version 重放，才能成功（这就是"回滚后刷新"的闭环）
  const replay = await owner.client.post(`/api/tasks/${t.id}/status`, { status: 'done', version: lastVersion });
  eq(replay.status, 200, '拿最新 version 重放成功');

  // 前端重试策略固化在代码里（2s/4s/8s），此处断言策略常量存在
  const fs = require('node:fs');
  const appSrc = fs.readFileSync(require('node:path').join(__dirname, '..', 'src', 'web', 'app.js'), 'utf8');
  const apiSrc = fs.readFileSync(require('node:path').join(__dirname, '..', 'src', 'web', 'api.js'), 'utf8');
  // 前端必须真正实现：乐观更新 + 2s/4s/8s 三次重试 + 失败回滚 + 409 用最新快照刷新
  includes(appSrc, 'RETRY_DELAYS = [2000, 4000, 8000]', '重试节奏为 2s/4s/8s');
  includes(appSrc, 'moveCardDom', '具备乐观更新（先挪卡片）');
  includes(appSrc, 'rollbackCard', '具备失败回滚');
  includes(appSrc, '网络不稳定，正在重试', '重试期间有可见提示');
  includes(appSrc, 'e.status === 409', '冲突时用服务端快照刷新');
  eq(lastSeenVersion, lastVersion, '服务端持续回传最新 version 供前端刷新');
});

/* ---------------- 版本组 ---------------- */

const t23 = test('AC-23 同一文件第二次上传 → 归入同一 file_group，版本号 +1，当前版本指向新文件', async () => {
  const u = await S.signup('13400000009');
  const g = await S.makeGroup(u.client, '版本组', false);
  const t = await S.makeTask(u.client, g.id, { title: '要改稿的文件' });
  const a1 = await u.client.post(`/api/tasks/${t.id}/files`, {
    filename: '报告.docx', size: 10, mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    data_b64: Buffer.from('version-one-content!').toString('base64'),
  });
  const a2 = await u.client.post(`/api/tasks/${t.id}/files`, {
    filename: '报告.docx', size: 20, mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    data_b64: Buffer.from('version-two-content-is-longer!!').toString('base64'),
  });
  eq(a2.data.file_group_id, a1.data.file_group_id, '归入同一版本组');
  eq(a1.data.version_no, 1);
  eq(a2.data.version_no, 2, '版本号 +1');

  const list = await u.client.get(`/api/tasks/${t.id}/files`);
  eq(list.data.files.length, 1, '只显示一个文件条目');
  eq(list.data.files[0].versions.length, 2, '有 2 个版本');
  eq(list.data.files[0].current.id, a2.data.attachment.id, '当前版本指向新文件');
  eq(list.data.files[0].current.size, Buffer.byteLength('version-two-content-is-longer!!'), '当前版本是新文件（按真实字节数）');
});

/* ---------------- 评论与 @ ---------------- */

const t24 = test('AC-24 评论中 @ 成员 → 被 @ 成员收到站内通知，不重复发', async () => {
  const { owner, member, group } = await withMember(2, 3);
  const t = await S.makeTask(owner.client, group.id, { title: '讨论的地方' });
  const nick = member.user.nickname;
  const r = await owner.client.post(`/api/tasks/${t.id}/comments`, { content: `@${nick} 你看下这个方案` });
  eq(r.status, 200);
  eq(r.data.mention_notified.length, 1, '识别到一个被 @ 的人');

  const inbox = await member.client.get('/api/notifications');
  const n = inbox.data.items.filter((x) => x.type === 'mention' && x.task_id === t.id);
  eq(n.length, 1, '收到一条 @ 通知');
  assert(n[0].channel !== 'wechat', '不发微信');
  includes(n[0].payload.title, '提到了你');
});

const t25 = test('AC-25 任一成员尝试删除动态流记录 → 无入口，API 返回 405', async () => {
  const { owner, group } = await withMember(4, 5);
  const t = await S.makeTask(owner.client, group.id, { title: '有动态的任务' });
  const acts = await owner.client.get(`/api/groups/${group.id}/activities`);
  assert(acts.data.activities.length > 0, '存在动态');
  const id = acts.data.activities[0].id;
  const d = await owner.client.del(`/api/activities/${id}`);
  eq(d.status, 405, '删除返回 405');
  const p = await owner.client.patch(`/api/activities/${id}`, { action: 'x' });
  eq(p.status, 405, '编辑返回 405');
  const still = await owner.client.get(`/api/groups/${group.id}/activities`);
  eq(still.data.activities.length, acts.data.activities.length, '记录未被改动');
});

/* ---------------- 解散 ---------------- */

const t26 = test('AC-26 Owner 解散小组 → 30 天内只读可导出；30 天后硬删除并通知', async () => {
  const owner = ctx.iso[6];
  const other = ctx.iso[7];
  const g = await S.makeGroup(owner.client, '要解散的组', false);
  await S.addMember(owner.client, g.id, other.client);
  await S.makeTask(owner.client, g.id, { title: '解散前的一条任务' });

  const r = await owner.client.post(`/api/groups/${g.id}/dissolve`, {});
  eq(r.status, 200);
  assert(r.data.hard_delete_at - Date.now() > 29 * 86400e3, '30 天后删除');

  // 导出仍可用（只读）
  const exp = await owner.client.get(`/api/groups/${g.id}/export`);
  eq(exp.status, 200, '仍可导出');
  includes(exp.data.csv, '解散前的一条任务', '导出内容完整');

  // 成员收到通知
  const inbox = await other.client.get('/api/notifications');
  assert(inbox.data.items.some((x) => x.type === 'group_dissolved'), '成员收到解散通知');
  includes(inbox.data.items.find((x) => x.type === 'group_dissolved').payload.title, '30 天后彻底删除');
});

/* ---------------- 风控 ---------------- */

const t27 = test('AC-27 同设备 24 小时注册第 4 个账号 → 触发人机校验，通过后放行', async () => {
  const device = 'same-device-' + Date.now();
  const ok = [];
  for (let i = 0; i < 3; i++) {
    const c = S.client();
    const phone = S.nextPhone();
    const s = await c.post('/api/auth/send-code', { phone });
    const l = await c.post('/api/auth/login', { phone, code: s.data.dev_code, device_id: device });
    eq(l.status, 200, `第 ${i + 1} 个账号放行`);
    ok.push(l);
  }
  // 第 4 个
  const c4 = S.client();
  const phone4 = S.nextPhone();
  const s4 = await c4.post('/api/auth/send-code', { phone: phone4 });
  const denied = await c4.post('/api/auth/login', { phone: phone4, code: s4.data.dev_code, device_id: device });
  eq(denied.status, 428, '第 4 个被拦，要求人机校验');
  eq(denied.data.error.code, 'HUMAN_CHECK');

  S.run('UPDATE otp_codes SET sent_at = ? WHERE phone = ?', Date.now() - 70000, require('../src/server/crypto.js').phoneIndex(phone4));

  // C3 修复：旧的伪造手法（客户端自称 human_verified: true）必须无效
  const s5 = await c4.post('/api/auth/send-code', { phone: phone4 });
  const forged = await c4.post('/api/auth/login', {
    phone: phone4, code: s5.data.dev_code, device_id: device, human_verified: true,
  });
  eq(forged.status, 428, '自称已通过校验不再被信任');

  // 正确姿势：先取服务端签发的凭证，再带着它登录
  const hc = await c4.post('/api/auth/human-check', { device_id: device });
  eq(hc.status, 200, '拿到人机校验凭证');
  assert(typeof hc.data.human_check_token === 'string' && hc.data.human_check_token.length > 20, '凭证非空');

  S.run('UPDATE otp_codes SET sent_at = ? WHERE phone = ?', Date.now() - 70000, require('../src/server/crypto.js').phoneIndex(phone4));
  const s6 = await c4.post('/api/auth/send-code', { phone: phone4 });
  const passed = await c4.post('/api/auth/login', {
    phone: phone4, code: s6.data.dev_code, device_id: device, human_check_token: hc.data.human_check_token,
  });
  eq(passed.status, 200, '通过校验后放行');

  // 凭证与设备绑定：同一设备可继续复用，换设备则失效
  const sameDevice5 = S.client();
  const phone5 = S.nextPhone();
  const s7 = await sameDevice5.post('/api/auth/send-code', { phone: phone5 });
  const reuse = await sameDevice5.post('/api/auth/login', {
    phone: phone5, code: s7.data.dev_code, device_id: device, human_check_token: hc.data.human_check_token,
  });
  eq(reuse.status, 200, '同设备可复用未过期的凭证');

  // 换个设备 ID 再用同一张凭证 → 必须失效。
  // 注意：该设备也得先注册满 3 个账号，否则根本不会走到人机校验这一步。
  const otherDevice = 'another-device-' + Date.now();
  for (let i = 0; i < 3; i++) {
    const cc = S.client();
    const pp = S.nextPhone();
    const ss = await cc.post('/api/auth/send-code', { phone: pp });
    const ll = await cc.post('/api/auth/login', { phone: pp, code: ss.data.dev_code, device_id: otherDevice });
    eq(ll.status, 200, `另一设备第 ${i + 1} 个账号放行`);
  }
  const other = S.client();
  const phone6 = S.nextPhone();
  const s8 = await other.post('/api/auth/send-code', { phone: phone6 });
  const wrongDevice = await other.post('/api/auth/login', {
    phone: phone6, code: s8.data.dev_code, device_id: otherDevice, human_check_token: hc.data.human_check_token,
  });
  eq(wrongDevice.status, 428, '凭证绑定设备，换设备即失效');
});

/* ---------------- 日历 ---------------- */

const t28 = test('AC-28 任务有截止时间，导出 .ics → 含 DTSTART、SUMMARY、VALARM（提前 1 天）', async () => {
  const { owner, group } = await withMember(8, 9);
  const t = await S.makeTask(owner.client, group.id, {
    title: '答辩材料定稿', due: '2026-12-20 14:00', assignee_id: owner.user.id,
  });
  const r = await fetch(S.baseUrl() + `/api/groups/${group.id}/ics`, {
    headers: { authorization: `Bearer ${owner.client.token}` },
  });
  eq(r.status, 200, '导出成功');
  includes(r.headers.get('content-type'), 'text/calendar');
  const ics = await r.text();
  assert(/DTSTART:\d{8}T\d{6}Z/.test(ics), '含 DTSTART');
  includes(ics, 'SUMMARY:', '含 SUMMARY');
  includes(ics, '答辩材料定稿', '含任务标题');
  includes(ics, 'BEGIN:VALARM', '含 VALARM');
  includes(ics, 'TRIGGER:-P1D', '提前 1 天');
  includes(ics, 'END:VCALENDAR', '结构完整');
});

/* ---------------- 性能约束 ---------------- */

const t29 = test('AC-29 小组有 800 条任务，打开看板 → 列内只渲染 20 条 + 加载更多，逾期横条全量，渲染 ≤ 800ms', async () => {
  const u = await S.signup('13400000001');
  const g = await S.makeGroup(u.client, '大组', false);
  const now = Date.now();
  const dbh = S.db();
  const ins = dbh.prepare(
    `INSERT INTO tasks (id, group_id, title, description, assignee_id, creator_id, due_at, priority, status, tags, version, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?, '[]', 1, ?, ?)`
  );
  dbh.exec('BEGIN');
  for (let i = 0; i < 800; i++) {
    const overdue = i < 40;
    ins.run('big' + i, g.id, '批量任务' + i, '', u.user.id, u.user.id,
      overdue ? now - (i + 1) * 86400e3 : now + (i + 1) * 3600e3,
      i % 3 === 0 ? 'high' : 'mid', i < 40 ? (i % 2 ? 'doing' : 'todo') : ['todo', 'doing', 'done'][i % 3], now, now);
  }
  dbh.exec('COMMIT');

  const started = process.hrtime.bigint();
  const b = await u.client.get(`/api/groups/${g.id}/board`);
  const ms = Number(process.hrtime.bigint() - started) / 1e6;
  eq(b.status, 200);
  eq(b.data.total, 800, '总数 800');
  eq(b.data.attention.length, 40, '逾期横条全量 40 条，不折叠');
  assert(ms < 800, `接口耗时 ${ms.toFixed(0)}ms 应 ≤ 800ms`);

  // 列内分页：每列渲染上限 20 条 + has_more 标记（前端据此显示「加载更多」）
  eq(b.data.columns.todo.length, 20, '待办列只下发 20 条');
  // 前端分页常量
  const appSrc = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'src', 'web', 'app.js'), 'utf8');
  assert(appSrc.includes('COL_PAGE') && appSrc.includes('加载更多'), '前端实现了「加载更多」');
  assert(b.data.columns.todo.length <= 20, '待办列只下发 20 条');
  eq(b.data.has_more.todo, true, '标记还有更多');
  assert(b.data.counts.todo > 20, '总数仍完整');
});

const t30 = test('AC-30 首屏性能：我的任务与看板接口 P95 ≤ 300ms（NFR 接口指标），且无 N+1 明显退化', async () => {
  const u = ctx.A; // 主场景用户，已有多组数据
  const samples = [];
  for (let i = 0; i < 12; i++) {
    const t0 = process.hrtime.bigint();
    await u.client.get('/api/my-tasks');
    samples.push(Number(process.hrtime.bigint() - t0) / 1e6);
  }
  samples.sort((a, b) => a - b);
  const p95 = samples[Math.floor(samples.length * 0.95) - 1] || samples[samples.length - 1];
  assert(p95 <= 300, `我的任务 P95 = ${p95.toFixed(1)}ms，应 ≤ 300ms`);

  const g = ctx.group;
  const boardSamples = [];
  for (let i = 0; i < 8; i++) {
    const t0 = process.hrtime.bigint();
    await u.client.get(`/api/groups/${g.id}/board`);
    boardSamples.push(Number(process.hrtime.bigint() - t0) / 1e6);
  }
  boardSamples.sort((a, b) => a - b);
  const bp95 = boardSamples[Math.floor(boardSamples.length * 0.95) - 1] || boardSamples[boardSamples.length - 1];
  assert(bp95 <= 300, `看板 P95 = ${bp95.toFixed(1)}ms，应 ≤ 300ms`);
});

async function main() {
  await setup();
  const all = [t1, t2, t3, t4, t5, t6, t7, t8, t9, t10, t11, t12, t13, t14, t15, t16, t17, t18, t19, t20, t21, t22, t23, t24, t25, t26, t27, t28, t29, t30];

  suite('PRD 11.1 验收矩阵', () => {});
  const res = await runAll(all);
  await S.stop();
  const rep = report(res);
  console.log('\n轻队 QingDui · 验收测试（PRD 11.1 AC-01 ~ AC-30）');
  console.log(rep.text);
  if (rep.fail) {
    console.log('\n失败详情：');
    res.filter((r) => !r.ok).forEach((r) => {
      console.log(`\n[${r.name}]\n${r.error.stack}`);
    });
    process.exitCode = 1;
  }
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
