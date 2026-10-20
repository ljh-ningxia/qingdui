// 后台调度器（C6 修复）
//
// 原实现的问题：全库没有 setInterval，`runReminders()` 只在测试里被手工调用，
// 生产环境下「每日 08:30 汇总 / 截止前 24h、2h 加急 / 逾期次日 09:00」
// 永远不会触发；PRD 承诺的「解散 30 天后彻底删除」也不存在。
//
// 本模块负责把这些到期动作真正跑起来，并保证：
//   - 单进程内不重入（上一轮没跑完就跳过本轮）
//   - 任何一轮抛错都不会终止定时器
//   - 进程退出时能干净停掉，不阻止 Node 退出（unref）
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { all, run, tx } = require('./db');
const Rem = require('./reminders');

const REMINDER_TICK = 60 * 1000;          // 每分钟检查一次，内部按幂等键去重
const CLEANUP_TICK = 60 * 60 * 1000;      // 每小时清理一次

const state = {
  timers: [],
  running: false,
  started: false,
  lastReminderRun: 0,
  lastCleanupRun: 0,
  errors: 0,
};

function logErr(where, e) {
  state.errors += 1;
  console.error(`[scheduler:${where}]`, e && e.message ? e.message : e);
}

/**
 * 跑一轮提醒。幂等由 notifications 的唯一索引保证，
 * 所以"每分钟调一次"不会重复打扰用户。
 */
function tickReminders(now = Date.now()) {
  if (state.running) return { skipped: true };
  state.running = true;
  try {
    const r = Rem.runReminders(now);
    state.lastReminderRun = now;
    return r;
  } finally {
    state.running = false;
  }
}

/**
 * 硬删除：解散超过 30 天的小组连同其任务、附件、成员关系一并清除。
 * 对应 PRD 7.3「解散后 30 天只读，之后彻底删除」与 AC-26。
 */
function tickCleanup(now = Date.now()) {
  const GRACE = 30 * 24 * 3600 * 1000;
  const deadline = now - GRACE;

  const expired = all(
    "SELECT id FROM groups WHERE deleted_at IS NOT NULL AND deleted_at < ?",
    deadline
  );
  if (!expired.length) {
    state.lastCleanupRun = now;
    return { purged: 0 };
  }

  let purged = 0;
  for (const g of expired) {
    try {
      // 先把要删的附件磁盘路径取出来，事务提交后再删文件
      const files = all(
        'SELECT storage_key FROM attachments WHERE task_id IN (SELECT id FROM tasks WHERE group_id = ?)',
        g.id
      );

      tx(() => {
        // 顺序遵守外键：attachments 引用 file_groups 和 tasks，必须最先删
        run('DELETE FROM attachments WHERE task_id IN (SELECT id FROM tasks WHERE group_id = ?)', g.id);
        run('DELETE FROM file_groups WHERE group_id = ?', g.id);
        run('DELETE FROM comments WHERE task_id IN (SELECT id FROM tasks WHERE group_id = ?)', g.id);
        run('DELETE FROM share_links WHERE task_id IN (SELECT id FROM tasks WHERE group_id = ?)', g.id);
        run('DELETE FROM activities WHERE group_id = ?', g.id);
        run('DELETE FROM notifications WHERE group_id = ?', g.id);
        run('DELETE FROM tasks WHERE group_id = ?', g.id);
        run('DELETE FROM invites WHERE group_id = ?', g.id);
        run('DELETE FROM memberships WHERE group_id = ?', g.id);
        run('DELETE FROM groups WHERE id = ?', g.id);
      });

      // 磁盘文件尽力删，删不掉不影响数据库结果
      const UP = process.env.QD_UPLOADS || path.join(__dirname, '..', '..', 'data', 'uploads');
      for (const f of files) {
        try { fs.unlinkSync(path.join(UP, String(f.storage_key).replace(/[/]/g, '_'))); } catch { /* ignore */ }
      }
      purged += 1;
    } catch (e) {
      logErr('cleanup', e);
    }
  }
  state.lastCleanupRun = now;
  return { purged };
}

function start(opts = {}) {
  if (state.started) return state;
  const reminderTick = opts.reminderTick || REMINDER_TICK;
  const cleanupTick = opts.cleanupTick || CLEANUP_TICK;

  // 启动后先补跑一次，避免"服务器 09:00 才启动、08:30 那轮错过"
  setTimeout(() => {
    try { tickReminders(); } catch (e) { logErr('reminders', e); }
    try { tickCleanup(); } catch (e) { logErr('cleanup', e); }
  }, 3000).unref?.();

  const t1 = setInterval(() => {
    try { tickReminders(); } catch (e) { logErr('reminders', e); }
  }, reminderTick);
  const t2 = setInterval(() => {
    try { tickCleanup(); } catch (e) { logErr('cleanup', e); }
  }, cleanupTick);

  // 不阻止进程退出（测试跑完能正常结束）
  t1.unref?.();
  t2.unref?.();

  state.timers = [t1, t2];
  state.started = true;
  return state;
}

function stop() {
  for (const t of state.timers) clearInterval(t);
  state.timers = [];
  state.started = false;
}

function status() {
  return {
    started: state.started,
    running: state.running,
    last_reminder_run: state.lastReminderRun || null,
    last_cleanup_run: state.lastCleanupRun || null,
    errors: state.errors,
  };
}

module.exports = { start, stop, status, tickReminders, tickCleanup };
