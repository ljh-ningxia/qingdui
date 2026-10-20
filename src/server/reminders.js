// PRD 7.6 / 11.1 AC-09~AC-12：提醒调度、催办、.ics 导出
const { one, all, run, tx } = require('./db');
const { randomId } = require('./crypto');
const { E } = require('./errors');
const D = require('./dates');
const { getGroup, membershipOf, requireMember, taskWithMeta, logActivity, notify } = require('./domain');

const HOUR = 3600 * 1000;

function prefsOf(user) {
  const p = user.notify_prefs ? JSON.parse(user.notify_prefs) : {};
  return {
    daily: p.daily !== false,          // 每日 08:30 汇总
    urgent: p.urgent !== false,        // 高优先级 24h / 2h 加急
    overdue: p.overdue !== false,      // 逾期次日 09:00
    email: !!p.email,                  // 邮件层（需绑定邮箱）
    service: p.service !== false,      // 服务号层（需已授权）
  };
}

/**
 * 调度一轮提醒。返回本轮发出的通知。
 * 规则（PRD 7.6.3）：
 *  - 每日 08:30 一条汇总（每人每组每天最多一条）
 *  - 逾期任务次日 09:00 单独一条，每任务最多 1 次
 *  - 加急：仅高优先级，截止前 24h / 2h 各一条
 *  - 渠道互斥：服务号 > 站内 > 邮件
 *  - 幂等：同 (user, task, offset, channel) 只发一次
 */
function runReminders(nowMs = Date.now()) {
  const nowP = D.partsOf(nowMs);
  const today = D.partsOf(nowMs);
  const dayKey = `${today.y}-${String(today.m).padStart(2, '0')}-${String(today.d).padStart(2, '0')}`;
  const sent = [];

  // 1) 每日汇总：08:30 之后、当天尚未发过
  const isAfter0830 = nowP.hh * 60 + nowP.mm >= 8 * 60 + 30;
  if (isAfter0830) {
    const groups = all('SELECT * FROM groups WHERE deleted_at IS NULL');
    for (const g of groups) {
      const members = all(
        'SELECT u.* FROM users u JOIN memberships m ON m.user_id = u.id WHERE m.group_id = ? AND m.deleted_at IS NULL AND u.deleted_at IS NULL',
        g.id
      );
      for (const u of members) {
        const prefs = prefsOf(u);
        if (!prefs.daily) continue;
        const dueToday = all(
          `SELECT * FROM tasks WHERE group_id = ? AND assignee_id = ? AND deleted_at IS NULL
             AND status IN ('todo','doing') AND due_at IS NOT NULL
             AND due_at >= ? AND due_at <= ?`,
          g.id, u.id, D.startOfDay(nowMs), D.endOfDay(nowMs)
        );
        if (!dueToday.length) continue;
        const overdueCount = all(
          `SELECT * FROM tasks WHERE group_id = ? AND assignee_id = ? AND deleted_at IS NULL
             AND status IN ('todo','doing') AND due_at < ?`,
          g.id, u.id, D.startOfDay(nowMs)
        ).length;
        const ok = notify({
          userId: u.id, groupId: g.id, taskId: null,
          type: 'daily_digest', channel: 'inbox', offset: `daily:${dayKey}`,
          payload: {
            title: `今天你有 ${dueToday.length} 个任务到期` + (overdueCount ? `，其中 ${overdueCount} 个已逾期` : ''),
            taskIds: dueToday.map((t) => t.id),
            groupName: g.name,
          },
        });
        if (ok) sent.push({ user: u.id, type: 'daily_digest' });
      }
    }
  }

  // 2) 逾期次日 09:00 单独一条 + 3) 加急提醒
  const openTasks = all(
    `SELECT t.*, g.name AS group_name FROM tasks t JOIN groups g ON g.id = t.group_id
      WHERE t.deleted_at IS NULL AND t.status IN ('todo','doing') AND t.due_at IS NOT NULL`
  );
  const isAfter0900 = nowP.hh * 60 + nowP.mm >= 9 * 60;

  for (const t of openTasks) {
    if (!t.assignee_id) continue;
    const assignee = one('SELECT * FROM users WHERE id = ?', t.assignee_id);
    if (!assignee) continue;
    const prefs = prefsOf(assignee);
    const overdueDays = D.overdueDays(t.due_at, nowMs);
    const isOverdue = t.due_at < nowMs;

    // 逾期：次日 09:00 提醒一次
    if (isOverdue && prefs.overdue && isAfter0900) {
      const ok = notify({
        userId: t.assignee_id, groupId: t.group_id, taskId: t.id,
        type: 'overdue', channel: 'inbox', offset: `overdue:${t.id}`,
        payload: { title: `「${t.title}」已逾期 ${overdueDays} 天`, due_at: t.due_at, groupName: t.group_name },
      });
      if (ok) sent.push({ user: t.assignee_id, type: 'overdue', task: t.id });
    }

    // 加急：仅高优先级
    if (!isOverdue && prefs.urgent && t.priority === 'high') {
      const leaveH = (t.due_at - nowMs) / HOUR;
      let offset = null;
      if (leaveH <= 2 && leaveH > 0) offset = 'urgent:2h';
      else if (leaveH <= 24 && leaveH > 2) offset = 'urgent:24h';
      if (offset) {
        const ok = notify({
          userId: t.assignee_id, groupId: t.group_id, taskId: t.id,
          type: 'urgent', channel: 'inbox', offset,
          payload: {
            title: `「${t.title}」将在 ${offset === 'urgent:2h' ? '2 小时' : D.formatDue(t.due_at)} 内到期`,
            due_at: t.due_at, assignee: assignee.nickname, groupName: t.group_name,
          },
        });
        if (ok) sent.push({ user: t.assignee_id, type: 'urgent', task: t.id });
      }
    }
  }

  return sent;
}

/** PRD 11.1 AC-12：组长催办卡片，同任务 24h 内最多 1 次 */
function nudge(groupId, userId, taskIds) {
  const { group, membership } = requireMember(groupId, userId);
  if (membership.role !== 'owner' && group.owner_id !== userId) throw E.forbidden('只有组长能催办');
  if (!Array.isArray(taskIds) || !taskIds.length) throw E.badRequest('先勾选要催办的任务');

  const tasks = [];
  const cutoff = Date.now() - 24 * HOUR;
  for (const id of taskIds) {
    const t = one('SELECT * FROM tasks WHERE id = ? AND group_id = ? AND deleted_at IS NULL', id, groupId);
    if (!t) continue;
    // 幂等检查：activity 里 24h 内是否存在 nudge
    const recent = one(
      "SELECT id FROM activities WHERE task_id = ? AND action = 'nudge' AND created_at > ?",
      id, cutoff
    );
    if (recent) {
      throw E.tooMany('这个任务 24 小时内已经催过了', { taskId: id, limit: 'nudge_24h' });
    }
    tasks.push(t);
  }
  if (!tasks.length) throw E.badRequest('没有可催办的任务');

  const now = Date.now();
  const lines = tasks.map((t) => {
    const d = D.overdueDays(t.due_at, now);
    const who = t.assignee_id ? (one('SELECT nickname FROM users WHERE id = ?', t.assignee_id) || {}).nickname : '待指派';
    return { id: t.id, title: t.title, assignee: who, overdue_days: d, due_label: t.due_at ? D.formatDue(t.due_at) : '无截止' };
  });
  tx(() => {
    for (const t of tasks) {
      logActivity({ groupId, taskId: t.id, actorId: userId, action: 'nudge' });
      // 催办同时给责任人一条站内通知（PRD 7.6.3 组长催办）
      if (t.assignee_id) {
        notify({
          userId: t.assignee_id, groupId, taskId: t.id,
          type: 'nudge', channel: 'inbox', offset: `nudge:${Math.floor(now / (24 * HOUR))}`,
          payload: { title: `组长催了一下「${t.title}」`, groupName: group.name },
        });
      }
    }
  });

  const card = buildNudgeCard(group, lines);
  return { count: tasks.length, card, tasks: lines, title: `有 ${tasks.length} 件事卡住了，占 2 分钟看一下` };
}

function buildNudgeCard(group, lines) {
  const head = group.name;
  const body = lines.map((l) => `${l.overdue_days > 0 ? `【逾期${l.overdue_days}天】` : '【进行中】'}${l.title} — ${l.assignee}`).join('\n');
  return `【轻队 · ${head}】\n有 ${lines.length} 件事需要跟进：\n${body}\n\n点开看板：请打开轻队「${head}」的「需要关注」`;
}

/** PRD 11.1 AC-28：.ics 含 DTSTART / SUMMARY / VALARM（提前 1 天） */
function buildIcs(groupId, userId) {
  const m = requireMember(groupId, userId);
  const group = getGroup(groupId);
  // PRD AC-28 只要求「有截止时间就能导出」，但只导指派给我的会让负责人导出空文件。
  // 口径：指派给我的 + 我自己创建的（负责人建的任务默认由自己盯）。
  const tasks = all(
    `SELECT * FROM tasks WHERE group_id = ? AND deleted_at IS NULL AND due_at IS NOT NULL
       AND status IN ('todo','doing') AND (assignee_id = ? OR creator_id = ?) ORDER BY due_at`,
    groupId, userId, userId
  );
  const stamp = (ms) => new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//QingDui//PRD R1//CN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:轻队 · ${escapeIcs(group.name)}`,
    'X-WR-TIMEZONE:Asia/Shanghai',
  ];
  for (const t of tasks) {
    lines.push(
      'BEGIN:VEVENT',
      `UID:${t.id}@qingdui.local`,
      `DTSTAMP:${stamp(Date.now())}`,
      `DTSTART:${stamp(t.due_at)}`,
      `DTEND:${stamp(t.due_at + 30 * 60 * 1000)}`,
      `SUMMARY:${escapeIcs(`【轻队】${t.title}`)}`,
      `DESCRIPTION:${escapeIcs(`${group.name} · 截止 ${D.formatDateTime(t.due_at)}`)}`,
      'BEGIN:VALARM',
      'TRIGGER:-P1D',
      'ACTION:DISPLAY',
      `DESCRIPTION:${escapeIcs(`明天到期：${t.title}`)}`,
      'END:VALARM',
      'END:VEVENT'
    );
  }
  lines.push('END:VCALENDAR');
  return lines.join('\r\n');
}

function escapeIcs(s) {
  return String(s).replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\n/g, '\\n');
}

function inbox(userId, limit = 50) {
  const rows = all(
    'SELECT * FROM notifications WHERE user_id = ? ORDER BY sent_at DESC LIMIT ?',
    userId, limit
  );
  return rows.map((r) => ({ ...r, payload: JSON.parse(r.payload || '{}') }));
}

function unreadCount(userId) {
  const r = one("SELECT COUNT(*) AS c FROM notifications WHERE user_id = ? AND read_at IS NULL", userId);
  return r ? r.c : 0;
}

function markRead(userId, ids) {
  if (ids && ids.length) {
    for (const id of ids) run('UPDATE notifications SET read_at = ? WHERE id = ? AND user_id = ?', Date.now(), id, userId);
  } else {
    run('UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL', Date.now(), userId);
  }
  return unreadCount(userId);
}

// 提醒打扰率（PRD 3.2 护栏：周均 > 2 条的用户占比）
function disturbanceRate() {
  const weekStart = D.startOfWeek(Date.now());
  const rows = all(
    'SELECT user_id, COUNT(*) AS c FROM notifications WHERE sent_at >= ? GROUP BY user_id',
    weekStart
  );
  const total = rows.length;
  const heavy = rows.filter((r) => r.c > 2).length;
  return { usersWithReminders: total, heavyUsers: heavy, rate: total ? heavy / total : 0 };
}

module.exports = { runReminders, nudge, buildIcs, inbox, unreadCount, markRead, prefsOf, disturbanceRate };
