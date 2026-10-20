// 领域服务：权限、状态机、活动流、通知
const { one, all, run, tx } = require('./db');
const { randomId } = require('./crypto');
const { E, AppError } = require('./errors');
const D = require('./dates');

const PLAN = {
  free: { storage: 500 * 1024 * 1024, singleFile: 20 * 1024 * 1024, maxMembers: 8, maxGroups: 3, versions: 3 },
  pro: { storage: 2 * 1024 * 1024 * 1024, singleFile: 100 * 1024 * 1024, maxMembers: 30, maxGroups: 10, versions: Infinity },
};

const STATUS = ['todo', 'doing', 'done', 'cancelled'];
const STATUS_LABEL = { todo: '待办', doing: '进行中', done: '已完成', cancelled: '已取消' };

// PRD 6.2 状态机：只允许以下流转
const TRANSITIONS = {
  todo: ['doing', 'done', 'cancelled'],
  doing: ['todo', 'done', 'cancelled'],
  done: ['todo'],
  cancelled: ['todo'],
};

const AVATAR_COLORS = ['#3B6EA5', '#C2603F', '#4F8A6B', '#8A5FA8', '#B08A2E', '#3C7F86', '#A65476', '#5B6B7A'];

/* ---------- 小组与权限 ---------- */

function membershipOf(groupId, userId) {
  if (!userId) return null;
  return one(
    'SELECT * FROM memberships WHERE group_id = ? AND user_id = ? AND deleted_at IS NULL',
    groupId, userId
  );
}

function getGroup(groupId) {
  const g = one('SELECT * FROM groups WHERE id = ?', groupId);
  if (!g) throw E.notFound('小组不存在');
  return g;
}

// PRD 11.1 AC-20：非成员访问任何小组内容 → 403，不泄露信息
function requireMember(groupId, userId) {
  const g = getGroup(groupId);
  const m = membershipOf(groupId, userId);
  if (!m) throw E.forbidden('你还不是这个小组的成员');
  return { group: g, membership: m };
}

// 解散后 30 天内的只读窗口（AC-26）：可读、可导出，不可写
function assertWritable(group) {
  if (group.status === 'archived' || group.deleted_at) {
    throw new AppError(403, 'GROUP_READONLY', '小组已解散，内容转为只读，30 天后彻底删除');
  }
  return true;
}

function requireOwner(groupId, userId) {
  const ctx = requireMember(groupId, userId);
  if (ctx.group.owner_id !== userId) throw E.forbidden('只有组长能做这件事');
  return ctx;
}

/**
 * C4 修复：按 group_id 直接判定只读，供路由层统一调用。
 *
 * 原做法是手工在个别 handler 里插 assertWritable，漏一个就漏一个洞
 * （实测改名 / 发邀请 / 升级在解散后仍返回 200）。现在由派发层统一拦截，
 * 新增路由不需要记得加这一句。
 *
 * 组不存在时放行，交给后续 handler 返回 404 —— 这里只负责"已解散则禁写"。
 */
function assertGroupWritable(groupId) {
  if (!groupId) return true;
  const g = one('SELECT id, status, deleted_at FROM groups WHERE id = ?', String(groupId));
  if (g) assertWritable(g);
  return true;
}

function planOf(group) {
  return PLAN[group.plan] || PLAN.free;
}

function membersOf(groupId) {
  return all(
    `SELECT m.user_id, m.role, m.joined_at, u.nickname, u.avatar_color
       FROM memberships m JOIN users u ON u.id = m.user_id
      WHERE m.group_id = ? AND m.deleted_at IS NULL AND u.deleted_at IS NULL
      ORDER BY CASE m.role WHEN 'owner' THEN 0 ELSE 1 END, m.joined_at`,
    groupId
  );
}

function publicUser(u) {
  if (!u) return null;
  return { id: u.id, nickname: u.nickname, avatar_color: u.avatar_color };
}

/* ---------- 动态流（不可编辑、不可删除，PRD 7.8） ---------- */

function logActivity({ groupId, taskId, actorId, action, from, to }) {
  run(
    'INSERT INTO activities (id, group_id, task_id, actor_id, action, from_value, to_value, created_at) VALUES (?,?,?,?,?,?,?,?)',
    randomId('act'), groupId, taskId || null, actorId, action,
    from == null ? null : String(from), to == null ? null : String(to), Date.now()
  );
}

/* ---------- 通知 ---------- */

function notify({ userId, groupId, taskId, type, payload, channel = 'inbox', offset = '' }) {
  if (!userId) return null;
  // PRD 11.1 AC-11 幂等：同 (user, task, offset, channel) 只发一次
  try {
    run(
      `INSERT INTO notifications (id, user_id, group_id, task_id, type, payload, channel, status, reminder_offset, sent_at)
       VALUES (?,?,?,?,?,?,?, 'sent', ?, ?)`,
      randomId('ntf'), userId, groupId || null, taskId || null, type,
      JSON.stringify(payload || {}), channel, offset, Date.now()
    );
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) return null;
    throw e;
  }
  return true;
}

/* ---------- 任务 ---------- */

function taskWithMeta(t) {
  if (!t) return null;
  const assignee = t.assignee_id ? one('SELECT id, nickname, avatar_color FROM users WHERE id = ?', t.assignee_id) : null;
  const creator = one('SELECT id, nickname, avatar_color FROM users WHERE id = ?', t.creator_id);
  const overdue = D.isOverdue(t);
  return {
    ...t,
    tags: safeJson(t.tags, []),
    images: safeJson(t.images, []),
    assignee: publicUser(assignee),
    creator: publicUser(creator),
    is_overdue: overdue,
    overdue_days: overdue ? D.overdueDays(t.due_at) : 0,
    due_label: t.due_at ? D.formatDue(t.due_at) : '',
    status_label: STATUS_LABEL[t.status],
  };
}

function safeJson(s, fallback) {
  try { const v = JSON.parse(s); return v == null ? fallback : v; } catch { return fallback; }
}

function getTask(taskId) {
  const t = one('SELECT * FROM tasks WHERE id = ? AND deleted_at IS NULL', taskId);
  if (!t) throw E.notFound('任务不存在或已删除');
  return t;
}

// 编辑权限：标题/描述/截止 → 仅 creator 与 Owner（PRD 4.2）
function canEdit(task, group, userId) {
  return task.creator_id === userId || group.owner_id === userId;
}

function canChangeStatus(task, group, userId) {
  // 成员可改任何任务的状态（PRD 4.2 取舍一）
  return !!membershipOf(task.group_id, userId);
}

function canDeleteTask(task, group, userId) {
  if (group.owner_id === userId) return true;
  return task.creator_id === userId && !task.assignee_id;
}

function applyStatusChange(task, group, actorId, next, { reason } = {}) {
  if (!STATUS.includes(next)) throw E.badRequest('未知状态');
  if (next === task.status) return task;
  // AC-07：拖到「归档」不是状态，是删除动作，禁止；拖到「已完成」必须已经开始过
  const allowed = TRANSITIONS[task.status] || [];
  if (!allowed.includes(next)) {
    let msg = `不能从「${STATUS_LABEL[task.status]}」直接变到「${STATUS_LABEL[next]}」`;
    if (task.status === 'todo' && next === 'doing') msg = '请先开始任务';
    throw E.badRequest(msg, { reason: 'ILLEGAL_TRANSITION', from: task.status, to: next });
  }
  return tx(() => {
    const now = Date.now();
    const updates = { status: next, version: task.version + 1, updated_at: now };
    if (next === 'done') updates.completed_at = now;
    if (next === 'doing' && !task.started_at) updates.started_at = now;
    if (next === 'todo' && task.status === 'done') updates.completed_at = null;
    run(
      'UPDATE tasks SET status = ?, version = ?, updated_at = ?, completed_at = ?, started_at = ? WHERE id = ? AND version = ?',
      updates.status, updates.version, updates.updated_at,
      updates.completed_at === undefined ? task.completed_at : updates.completed_at,
      updates.started_at === undefined ? task.started_at : updates.started_at,
      task.id, task.version
    );
    logActivity({
      groupId: task.group_id, taskId: task.id, actorId,
      action: next === 'todo' && task.status === 'done' ? 'reopen' : 'status_change',
      from: task.status, to: next,
    });
    if (next === 'done' && task.creator_id !== actorId) {
      notify({
        userId: task.creator_id, groupId: task.group_id, taskId: task.id,
        type: 'task_done', payload: { title: task.title }, offset: `done:${now}`,
      });
    }
    return one('SELECT * FROM tasks WHERE id = ?', task.id);
  });
}

/* ---------- 用户 ---------- */

function nextAvatarColor(seed) {
  let h = 0;
  for (const ch of String(seed)) h = (h * 31 + ch.charCodeAt(0)) % 9973;
  return AVATAR_COLORS[h % AVATAR_COLORS.length];
}

function touchGroup(groupId) {
  run('UPDATE groups SET last_active_at = ? WHERE id = ?', Date.now(), groupId);
}

module.exports = {
  PLAN, STATUS, STATUS_LABEL, TRANSITIONS,
  membershipOf, getGroup, requireMember, requireOwner, planOf, membersOf, publicUser,
  logActivity, notify, taskWithMeta, getTask, canEdit, canChangeStatus, canDeleteTask,
  applyStatusChange, nextAvatarColor, touchGroup, safeJson, AVATAR_COLORS, assertWritable,
  assertGroupWritable,
};
