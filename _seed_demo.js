// 为文章截图准备演示数据：一个真实的课程项目小组
const BASE = 'http://127.0.0.1:3456';

async function call(method, path, body, token) {
  const headers = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  const r = await fetch(BASE + path, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
  });
  const ct = r.headers.get('content-type') || '';
  const data = ct.includes('json') ? await r.json() : await r.text();
  return { status: r.status, data };
}

async function signup(phone, nickname) {
  const s = await call('POST', '/api/auth/send-code', { phone });
  const l = await call('POST', '/api/auth/login', {
    phone, code: s.data.dev_code, device_id: 'demo-' + phone,
  });
  if (l.status !== 200) throw new Error('登录失败: ' + JSON.stringify(l.data));
  if (nickname) await call('PATCH', '/api/me', { nickname }, l.data.token);
  return { token: l.data.token, user: l.data.user };
}

async function main() {
  // 组员
  const me = await signup('13900001111', '北渚');
  const b = await signup('13900002222', '小林');
  const c = await signup('13900003333', '陈嘉');
  const d = await signup('13900004444', '张一鸣');

  // 建组
  const g = await call('POST', '/api/groups', {
    name: '人机交互 · 期末项目', demo_tasks: false,
  }, me.token);
  const gid = g.data.group.id;

  // 拉人
  for (const m of [b, c, d]) {
    const inv = await call('POST', `/api/groups/${gid}/invites`, {}, me.token);
    await call('POST', `/api/invites/${inv.data.token}/join`, {}, m.token);
  }

  // 造任务
  const tasks = [
    { title: '用户调研：访谈 5 位同学', assignee_id: b.user.id, due: '3天后', priority: 'high' },
    { title: '竞品分析报告（Notion / Todoist / 滴答清单）', assignee_id: c.user.id, due: '5天后' },
    { title: '低保真原型（Figma）', assignee_id: me.user.id, due: '下周三', priority: 'high' },
    { title: '交互流程图', assignee_id: me.user.id, due: '下周三' },
    { title: '可用性测试脚本', assignee_id: d.user.id, due: '一周后' },
    { title: '高保真视觉稿', assignee_id: c.user.id, due: '2026-10-28' },
    { title: '答辩 PPT 初稿', assignee_id: me.user.id, due: '2026-11-02', priority: 'high' },
    { title: '录制演示视频', assignee_id: d.user.id, due: '2026-11-05' },
    { title: '整理参考文献', assignee_id: b.user.id, due: '2026-10-15' },
  ];

  const made = [];
  for (const t of tasks) {
    const r = await call('POST', `/api/groups/${gid}/tasks`, { ...t }, me.token);
    if (r.status === 200) made.push(r.data.task);
  }

  // 推进状态：部分进行中、部分待验收、部分已完成
  const plan = [
    { idx: 0, status: 'doing' },
    { idx: 1, status: 'doing' },
    { idx: 3, status: 'done' },
    { idx: 8, status: 'todo' },
  ];
  for (const p of plan) {
    const t = made[p.idx];
    if (!t) continue;
    if (p.status === 'doing') {
      await call('POST', `/api/tasks/${t.id}/status`, { status: 'doing', version: t.version }, me.token);
    } else if (p.status === 'done') {
      const r1 = await call('POST', `/api/tasks/${t.id}/status`, { status: 'doing', version: t.version }, me.token);
      const v = r1.data && r1.data.task ? r1.data.task.version : t.version + 1;
      await call('POST', `/api/tasks/${t.id}/status`, { status: 'done', version: v }, me.token);
    }
  }

  // 加几条评论
  const t0 = made[0];
  if (t0) {
    await call('POST', `/api/tasks/${t0.id}/comments`, {
      content: '这周约了 3 位，还差 2 位，@陈嘉 你那边能帮忙约一个吗',
    }, b.token);
    await call('POST', `/api/tasks/${t0.id}/comments`, {
      content: '可以，我拉一个同寝室的同学',
    }, c.token);
  }

  console.log(JSON.stringify({ group_id: gid, token: me.token, tasks: made.length }, null, 2));
}

main().catch((e) => { console.error(e); process.exit(1); });
