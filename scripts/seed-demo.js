// 演示数据：直接写库，不依赖已启动的 HTTP 服务。
// 用途：公开演示站首次启动时填充内容，让别人一进来就看到真实的看板，而不是空白页。
// 只在库为空（无任何用户）时执行，绝不覆盖已有数据。
const crypto = require('node:crypto');

const db = require('../src/server/db');
const Crypt = require('../src/server/crypto');

const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;
const now = Date.now();

const rid = (p, n = 10) => p + '_' + crypto.randomBytes(12).toString('base64url').slice(0, n);

function isEmpty() {
  const row = db.one('SELECT COUNT(*) AS n FROM users');
  return !row || row.n === 0;
}

function makeUser(nickname, phone, color) {
  const id = rid('u');
  db.run(
    `INSERT INTO users (id, phone, phone_hash, nickname, avatar_color, notify_prefs, created_at, last_active_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    id, Crypt.encryptPhone(phone), Crypt.phoneIndex(phone), nickname, color,
    JSON.stringify({ daily: true, urgent: true, overdue: true, email: false, service: false }),
    now - 14 * DAY, now - 2 * HOUR,
  );
  return id;
}

function seed() {
  if (!isEmpty()) {
    console.log('[轻队] 数据库已有数据，跳过演示数据写入');
    return;
  }

  const owner = makeUser('北渚', '13900001111', '#B08A2E');
  const u1 = makeUser('小林', '13900002222', '#3B6EA5');
  const u2 = makeUser('陈嘉', '13900003333', '#7A5EA8');
  const u3 = makeUser('张一鸣', '13900004444', '#2F7D62');

  const gid = rid('g');
  db.run(
    `INSERT INTO groups (id, name, owner_id, storage_quota_bytes, last_active_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    gid, '人机交互 · 期末项目', owner, 500 * 1024 * 1024, now - 2 * HOUR, now - 12 * DAY,
  );

  const members = [
    [owner, 'owner', '北渚'],
    [u1, 'member', '小林'],
    [u2, 'member', '陈嘉'],
    [u3, 'member', '张一鸣'],
  ];
  for (const [uid, role] of members) {
    db.run(
      `INSERT INTO memberships (id, group_id, user_id, role, joined_at) VALUES (?, ?, ?, ?, ?)`,
      rid('m'), gid, uid, role, now - 12 * DAY,
    );
  }

  // [标题, 描述, 负责人, 状态, 截止, 优先级, 标签]
  const tasks = [
    ['整理参考文献', '把近三年的 HCI 会议论文过一遍，挑 15 篇进共享文件夹。', u1, 'todo', now + 3 * DAY, 'high', ['文献']],
    ['写第三章交互流程', '重点写任务指派那一段，配三张流程图。', owner, 'doing', now + 2 * DAY, 'high', ['写作']],
    ['做用户访谈（5 人）', '每人 20 分钟，录屏 + 转写。已经拖了一天了。', u2, 'doing', now - 1 * DAY, 'high', ['调研']],
    ['画高保真原型', '用 Figma 把看板和详情页做出来。', u3, 'todo', now + 5 * DAY, 'mid', ['设计']],
    ['整理访谈录音', '五个人的录音都要转成文字。', u2, 'todo', now + 4 * DAY, 'mid', ['调研']],
    ['写摘要和结论', '最后再写，等正文定稿。', owner, 'todo', now + 9 * DAY, 'low', ['写作']],
    ['组会汇报 PPT', '已经讲完了，留个记录。', u3, 'done', now - 3 * DAY, 'mid', ['汇报']],
    ['确定选题', '从三个候选里挑了"小组任务协作"。', owner, 'done', now - 11 * DAY, 'low', ['选题']],
  ];

  const taskIds = [];
  for (const [title, desc, assignee, status, due, prio, tags] of tasks) {
    const tid = rid('t');
    taskIds.push(tid);
    const createdAt = now - 10 * DAY;
    db.run(
      `INSERT INTO tasks (id, group_id, title, description, assignee_id, creator_id,
         status, priority, due_at, tags, version, completed_at, started_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`,
      tid, gid, title, desc, assignee, owner, status, prio, due, JSON.stringify(tags),
      status === 'done' ? due : null,
      status === 'doing' ? createdAt + 2 * DAY : null,
      createdAt, now - Math.floor(Math.random() * 36) * HOUR,
    );
    db.run(
      `INSERT INTO activities (id, group_id, task_id, actor_id, action, to_value, created_at)
       VALUES (?, ?, ?, ?, 'create', ?, ?)`,
      rid('a'), gid, tid, owner, JSON.stringify({ title }), createdAt,
    );
  }

  // 给第一条任务补几条评论，让详情页有内容可看
  const comments = [
    [u1, '我先按主题分了四类，晚上发群里。'],
    [owner, '收到，我看完补充一下和我们选题最相关的那些。'],
    [u2, '要不要把访谈里提到的痛点也标出来？后面写正文用得上。'],
  ];
  for (const [uid, text] of comments) {
    const at = now - Math.floor(Math.random() * 3 * DAY);
    db.run(
      `INSERT INTO comments (id, task_id, author_id, content, created_at) VALUES (?, ?, ?, ?, ?)`,
      rid('c'), taskIds[0], uid, text, at,
    );
    db.run(
      `INSERT INTO activities (id, group_id, task_id, actor_id, action, to_value, created_at)
       VALUES (?, ?, ?, ?, 'comment', ?, ?)`,
      rid('a'), gid, taskIds[0], uid, JSON.stringify({ excerpt: text.slice(0, 30) }), at,
    );
  }

  console.log(`[轻队] 演示数据已写入：小组「人机交互 · 期末项目」，4 名成员，${tasks.length} 个任务`);
}

if (require.main === module) {
  seed();
  console.log('完成');
}

module.exports = { seed };
