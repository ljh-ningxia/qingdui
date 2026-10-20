// API：FB-01 账号 / FB-02 小组 / FB-03 任务 / FB-04 视图 / FB-06 文件 / FB-07 评论 / FB-08 分享 / FB-09 付费
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const R = require('./router');
const { one, all, run, tx } = require('./db');
const { E, AppError } = require('./errors');
const { encryptPhone, decryptPhone, phoneIndex, maskPhone, randomId, randomToken } = require('./crypto');
const S = require('./session');
const D = require('./dates');
const Dom = require('./domain');
const Rem = require('./reminders');

const UPLOAD_DIR = process.env.QD_UPLOADS || path.join(__dirname, '..', '..', 'data', 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

/* ============ 安全开关（C2 / C3 修复） ============ */

/**
 * C2 修复：验证码明文回显必须**显式开启**。
 *
 * 原实现 `process.env.QD_DEV_CODE !== '0'` 是默认开启 —— 只要没配环境变量，
 * `/api/auth/send-code` 就会把验证码明文塞进响应体，任何人可以登录任意手机号。
 *
 * 现在改为：只有 QD_DEV_CODE === '1' 才回显，且生产环境一律强制关闭。
 */
const DEV_CODE_ON = process.env.QD_DEV_CODE === '1' && !process.env.NODE_ENV?.startsWith('prod');

function devCodeEnabled() {
  return DEV_CODE_ON;
}

// 人机校验凭证：服务端 HMAC 签发，客户端无法伪造（C3 修复）
const HUMAN_CHECK_TTL = 10 * 60 * 1000;

function humanCheckToken(deviceId, now = Date.now()) {
  const exp = now + HUMAN_CHECK_TTL;
  const body = Buffer.from(JSON.stringify({ d: deviceId, exp })).toString('base64url');
  const mac = crypto.createHmac('sha256', require('./secrets').sessionKey())
    .update('human:' + body).digest('base64url');
  return `${body}.${mac}`;
}

function verifyHumanCheckToken(token, deviceId, now = Date.now()) {
  if (!token || typeof token !== 'string') return false;
  const i = token.lastIndexOf('.');
  if (i < 0) return false;
  const body = token.slice(0, i);
  const mac = token.slice(i + 1);
  const expect = crypto.createHmac('sha256', require('./secrets').sessionKey())
    .update('human:' + body).digest('base64url');
  const a = Buffer.from(mac);
  const b = Buffer.from(expect);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return false;
  let p;
  try { p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')); } catch { return false; }
  if (!p.exp || p.exp < now) return false;
  // 凭证与设备绑定，防止把别人的凭证拿来用
  return p.d === deviceId;
}

/* ============ FB-01 账号与登录（PRD 7.2） ============ */

const OTP_TTL = 5 * 60 * 1000;
const OTP_RESEND = 60 * 1000;
const OTP_DAILY_MAX = 10;
const OTP_MAX_ATTEMPTS = 5;
const OTP_LOCK = 15 * 60 * 1000;

function dayKeyOf(ms = Date.now()) {
  const p = D.partsOf(ms);
  return `${p.y}-${p.m}-${p.d}`;
}

function normalizePhone(p) {
  const s = String(p || '').replace(/[\s-]/g, '');
  if (!/^1[3-9]\d{9}$/.test(s)) throw E.badRequest('手机号格式不对，请输入 11 位手机号');
  return s;
}

R.post('/api/auth/send-code', (ctx) => {
  const phone = normalizePhone(ctx.body.phone);
  const now = Date.now();
  const existing = one('SELECT * FROM otp_codes WHERE phone = ?', phoneIndex(phone));
  const devMode = devCodeEnabled();

  if (existing) {
    if (existing.locked_until && existing.locked_until > now) {
      throw E.tooMany('错误次数过多，15 分钟后再试', { lockUntil: existing.locked_until });
    }
    if (now - existing.sent_at < OTP_RESEND) {
      throw E.tooMany(`${Math.ceil((OTP_RESEND - (now - existing.sent_at)) / 1000)} 秒后才能重发`, {
        retryAfter: Math.ceil((OTP_RESEND - (now - existing.sent_at)) / 1000),
      });
    }
    const sameDay = existing.day_key === dayKeyOf();
    const dayCount = sameDay ? existing.day_count : 0;
    if (dayCount >= OTP_DAILY_MAX) throw E.tooMany('这个号码今天验证码次数用完了，明天再试');
  }

  const code = String(Math.floor(100000 + Math.random() * 900000));
  const sameDay = existing && existing.day_key === dayKeyOf();
  const dayCount = (sameDay ? existing.day_count : 0) + 1;
  tx(() => {
    run(
      `INSERT INTO otp_codes (phone, code, expire_at, attempts, locked_until, sent_at, send_count, day_key, day_count)
       VALUES (?,?,?,0,NULL,?,?,?,?)
       ON CONFLICT(phone) DO UPDATE SET code = excluded.code, expire_at = excluded.expire_at,
         attempts = 0, sent_at = excluded.sent_at, send_count = send_count + 1,
         day_key = excluded.day_key, day_count = excluded.day_count`,
      phoneIndex(phone), code, now + OTP_TTL, now, 1, dayKeyOf(), dayCount
    );
  });
  // 生产环境此处替换为真实短信网关；本地开发把验证码直接返回，其余逻辑（频控/锁定/一次性）完全相同
  // C2 修复：只有显式设置 QD_DEV_CODE=1 才回显验证码，其余情况一律视为已发送
  return {
    ok: true,
    dev_code: devMode ? code : undefined,
    expires_in: OTP_TTL / 1000,
    message: devMode ? '验证码已生成（本地开发模式直接显示）' : '验证码已发送',
  };
}, { public: true });

/**
 * 人机校验挑战：返回一张服务端签发的凭证（C3 修复）。
 * 客户端提交 human_check_token，而不是 human_verified: true。
 */
R.post('/api/auth/human-check', (ctx) => {
  const deviceId = String(ctx.body.device_id || '').slice(0, 64);
  if (!deviceId) throw E.badRequest('缺少设备标识');
  return { ok: true, human_check_token: humanCheckToken(deviceId), expires_in: HUMAN_CHECK_TTL / 1000 };
}, { public: true });

R.post('/api/auth/login', (ctx) => {
  const phone = normalizePhone(ctx.body.phone);
  const code = String(ctx.body.code || '').trim();
  if (!/^\d{6}$/.test(code)) throw E.badRequest('验证码是 6 位数字');
  const now = Date.now();
  const rec = one('SELECT * FROM otp_codes WHERE phone = ?', phoneIndex(phone));
  if (!rec) throw E.badRequest('请先获取验证码');
  if (rec.locked_until && rec.locked_until > now) throw E.tooMany('错误次数过多，15 分钟后再试');
  if (rec.expire_at < now) throw E.badRequest('验证码已过期，重新获取');
  if (rec.code !== code) {
    const attempts = rec.attempts + 1;
    const locked = attempts >= OTP_MAX_ATTEMPTS ? now + OTP_LOCK : null;
    run('UPDATE otp_codes SET attempts = ?, locked_until = ? WHERE phone = ?', attempts, locked, phoneIndex(phone));
    throw E.badRequest(locked ? '错误次数过多，15 分钟后再试' : `验证码不对，还有 ${OTP_MAX_ATTEMPTS - attempts} 次机会`);
  }

  // PRD 11.1 AC-27：同设备 24h 注册第 4 个账号 → 人机校验
  const deviceId = String(ctx.body.device_id || '').slice(0, 64);
  const idx = phoneIndex(phone);
  const user = one('SELECT * FROM users WHERE phone_hash = ?', idx);
  if (!user && deviceId) {
    const since = now - 24 * 3600 * 1000;
    const cnt = one('SELECT COUNT(*) AS c FROM users WHERE device_id = ? AND created_at > ?', deviceId, since);
    // C3 修复：不再信任 ctx.body.human_verified 这个客户端布尔值，
    // 必须是服务端 /api/auth/human-check 签发且与当前设备绑定的凭证
    const passed = verifyHumanCheckToken(ctx.body.human_check_token, deviceId);
    if (cnt.c >= 3 && !passed) {
      throw new AppError(428, 'HUMAN_CHECK', '检测到异常注册，请完成人机校验', { need_human_check: true });
    }
  }

  const userId = user ? user.id : randomId('u');
  tx(() => {
    if (!user) {
      run(
        `INSERT INTO users (id, phone, phone_hash, nickname, avatar_color, notify_prefs, device_id, created_at, last_active_at)
         VALUES (?,?,?,?,?,?,?,?,?)`,
        userId, encryptPhone(phone), idx, '同学' + phone.slice(-4), Dom.nextAvatarColor(phone),
        JSON.stringify({ daily: true, urgent: true, overdue: true, email: false, service: false }),
        deviceId || null, now, now
      );
    } else {
      run('UPDATE users SET last_active_at = ?, device_id = COALESCE(?, device_id) WHERE id = ?', now, deviceId || null, userId);
    }
    run('DELETE FROM otp_codes WHERE phone = ?', idx);
  });

  const u = one('SELECT * FROM users WHERE id = ?', userId);
  return { token: S.issue(userId), user: userView(u), is_new: !user };
}, { public: true });

function userView(u) {
  if (!u) return null;
  let phone = '';
  try { phone = decryptPhone(u.phone); } catch { phone = ''; }
  return {
    id: u.id,
    nickname: u.nickname,
    avatar_color: u.avatar_color,
    phone_masked: maskPhone(phone),
    email: u.email || '',
    notify_prefs: JSON.parse(u.notify_prefs || '{}'),
    created_at: u.created_at,
  };
}

R.get('/api/me', (ctx) => ({ user: userView(ctx.user) }), { auth: true });

R.patch('/api/me', (ctx) => {
  const { nickname, email, notify_prefs } = ctx.body;
  if (nickname != null) {
    const n = String(nickname).trim();
    if (n.length < 1 || n.length > 20) throw E.badRequest('昵称 1–20 字');
    run('UPDATE users SET nickname = ? WHERE id = ?', n, ctx.user.id);
  }
  if (email !== undefined) {
    const e = String(email || '').trim();
    if (e && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)) throw E.badRequest('邮箱格式不对');
    run('UPDATE users SET email = ? WHERE id = ?', e || null, ctx.user.id);
  }
  if (notify_prefs) {
    const cur = JSON.parse(ctx.user.notify_prefs || '{}');
    run('UPDATE users SET notify_prefs = ? WHERE id = ?', JSON.stringify({ ...cur, ...notify_prefs }), ctx.user.id);
  }
  return { user: userView(one('SELECT * FROM users WHERE id = ?', ctx.user.id)) };
}, { auth: true });

// PRD 12：账号注销
R.post('/api/me/delete', (ctx) => {
  const owned = all('SELECT * FROM groups WHERE owner_id = ? AND deleted_at IS NULL', ctx.user.id);
  tx(() => {
    for (const g of owned) {
      run('UPDATE groups SET deleted_at = ?, status = ? WHERE id = ?', Date.now(), 'archived', g.id);
    }
    run('UPDATE memberships SET deleted_at = ? WHERE user_id = ? AND deleted_at IS NULL', Date.now(), ctx.user.id);
    run('UPDATE users SET deleted_at = ? WHERE id = ?', Date.now(), ctx.user.id);
  });
  return { ok: true, owned_groups: owned.length };
}, { auth: true });

/* ============ FB-02 小组与成员（PRD 7.3） ============ */

function groupSummary(g, userId) {
  const m = Dom.membershipOf(g.id, userId);
  const plan = Dom.planOf(g);
  const activeTasks = one(
    "SELECT COUNT(*) AS c FROM tasks WHERE group_id = ? AND deleted_at IS NULL AND status IN ('todo','doing')",
    g.id
  ).c;
  const overdue = all(
    "SELECT * FROM tasks WHERE group_id = ? AND deleted_at IS NULL AND status IN ('todo','doing') AND due_at < ?",
    g.id, Date.now()
  ).length;
  return {
    id: g.id,
    name: g.name,
    role: m ? m.role : (g.owner_id === userId ? 'owner' : null),
    plan: g.plan,
    members: Dom.membersOf(g.id).length,
    max_members: plan.maxMembers,
    active_tasks: activeTasks,
    overdue_tasks: overdue,
    storage_used_bytes: g.storage_used_bytes,
    storage_quota_bytes: g.storage_quota_bytes,
    status: g.status,
    created_at: g.created_at,
  };
}

R.get('/api/groups', (ctx) => {
  const rows = all(
    `SELECT g.* FROM groups g JOIN memberships m ON m.group_id = g.id
      WHERE m.user_id = ? AND m.deleted_at IS NULL AND g.deleted_at IS NULL
      ORDER BY g.last_active_at DESC`,
    ctx.user.id
  );
  return { groups: rows.map((g) => groupSummary(g, ctx.user.id)) };
}, { auth: true });

const DEMO_TASKS = [
  { title: '定题并提交开题报告', offset: 3, priority: 'high' },
  { title: '把问卷初稿发到群里让大家改', offset: 7, priority: 'mid' },
  { title: '整理参考资料，存到任务附件里', offset: 10, priority: 'low' },
];

R.post('/api/groups', (ctx) => {
  const name = String(ctx.body.name || '').trim() || '我的小组';
  if (name.length > 20) throw E.badRequest('小组名 1–20 字');
  const plan = Dom.PLAN.free;
  // PRD 11.1 AC-14：免费 3 个在用小组上限
  const using = all(
    'SELECT id FROM groups WHERE owner_id = ? AND deleted_at IS NULL AND status != ?',
    ctx.user.id, 'dormant'
  );
  const ownedActive = using.length;
  if (ownedActive >= plan.maxGroups) {
    throw E.limit('免费版最多 3 个在用小组', {
      trigger: 'group_limit', limit: plan.maxGroups, used: ownedActive,
      exits: ['archive', 'upgrade'],
    });
  }
  const gid = randomId('g');
  const now = Date.now();
  const withDemo = ctx.body.demo_tasks !== false;
  tx(() => {
    run(
      `INSERT INTO groups (id, name, owner_id, plan, storage_used_bytes, storage_quota_bytes, status, last_active_at, created_at)
       VALUES (?,?,?,?,0,?, 'active', ?, ?)`,
      gid, name, ctx.user.id, 'free', plan.storage, now, now
    );
    run('INSERT INTO memberships (id, group_id, user_id, role, joined_at) VALUES (?,?,?,?,?)',
      randomId('m'), gid, ctx.user.id, 'owner', now);
    // PRD 6.4 第 3 步：自动带入 3 条示例任务，可一键清空
    if (withDemo) {
      for (const d of DEMO_TASKS) {
        const tid = randomId('t');
        run(
          `INSERT INTO tasks (id, group_id, title, description, assignee_id, creator_id, due_at, priority, status, tags, version, created_at, updated_at)
           VALUES (?,?,?,'',NULL,?,?,?, 'todo','[]',1,?,?)`,
          tid, gid, d.title, ctx.user.id, D.endOfDay(Date.now() + d.offset * D.DAY), d.priority, now, now
        );
        run(
          `INSERT INTO activities (id, group_id, task_id, actor_id, action, created_at) VALUES (?,?,?,?, 'create', ?)`,
          randomId('act'), gid, tid, ctx.user.id, now
        );
      }
    }
    Dom.logActivity({ groupId: gid, actorId: ctx.user.id, action: 'group_create', to: name });
  });
  return { group: groupSummary(Dom.getGroup(gid), ctx.user.id), demo_tasks: withDemo ? DEMO_TASKS.length : 0 };
}, { auth: true });

R.patch('/api/groups/:id', (ctx) => {
  const { group } = Dom.requireOwner(ctx.params.id, ctx.user.id);
  const name = String(ctx.body.name || '').trim();
  if (!name || name.length > 20) throw E.badRequest('小组名 1–20 字');
  run('UPDATE groups SET name = ? WHERE id = ?', name, group.id);
  return { group: groupSummary(Dom.getGroup(group.id), ctx.user.id) };
}, { auth: true });

R.get('/api/groups/:id', (ctx) => {
  const { group, membership } = Dom.requireMember(ctx.params.id, ctx.user.id);
  const members = Dom.membersOf(group.id).map((m) => {
    const done = one(
      "SELECT COUNT(*) AS c FROM tasks WHERE group_id = ? AND assignee_id = ? AND status = 'done' AND completed_at > ?",
      group.id, m.user_id, D.startOfWeek(Date.now())
    ).c;
    const last = one('SELECT last_active_at FROM users WHERE id = ?', m.user_id);
    return {
      ...m,
      user_id: m.user_id,
      nickname: m.nickname,
      avatar_color: m.avatar_color,
      role: group.owner_id === m.user_id ? 'owner' : 'member',
      done_this_week: done,
      last_active_at: last ? last.last_active_at : null,
    };
  });
  const invites = all('SELECT * FROM invites WHERE group_id = ? AND revoked_at IS NULL ORDER BY created_at DESC', group.id);
  return {
    group: groupSummary(group, ctx.user.id),
    my_role: membership.role,
    members,
    invites: invites.map((i) => ({ token: i.token, expire_at: i.expire_at, created_at: i.created_at })),
  };
}, { auth: true });

// 邀请链接（PRD 7.3：默认永久，可设 7 天过期，多链接并存）
R.post('/api/groups/:id/invites', (ctx) => {
  const { group } = Dom.requireMember(ctx.params.id, ctx.user.id);
  if (group.owner_id !== ctx.user.id) throw E.forbidden('只有组长能生成邀请链接');
  const days = ctx.body.expire_days ? Number(ctx.body.expire_days) : 0;
  if (days && ![1, 7, 30].includes(days)) throw E.badRequest('有效期只能是 1 / 7 / 30 天或永久');
  const token = randomToken(14);
  run(
    'INSERT INTO invites (id, group_id, token, created_by, expire_at, revoked_at, created_at) VALUES (?,?,?,?,?,NULL,?)',
    randomId('inv'), group.id, token, ctx.user.id, days ? Date.now() + days * D.DAY : null, Date.now()
  );
  return { token, url: `/join/${token}`, expire_at: days ? Date.now() + days * D.DAY : null };
}, { auth: true });

R.post('/api/groups/:id/invites/revoke', (ctx) => {
  const { group } = Dom.requireOwner(ctx.params.id, ctx.user.id);
  run('UPDATE invites SET revoked_at = ? WHERE group_id = ? AND revoked_at IS NULL', Date.now(), group.id);
  return { ok: true, message: '全部邀请链接已失效' };
}, { auth: true });

// 访客通过邀请链接加入（PRD 7.3：点击加入即成为成员，无需审批；幂等）
R.get('/api/invites/:token', (ctx) => {
  const inv = one('SELECT * FROM invites WHERE token = ?', ctx.params.token);
  if (!inv) throw E.notFound('邀请链接不存在或已失效');
  if (inv.revoked_at) throw new AppError(410, 'INVITE_REVOKED', '这个邀请链接已经失效了');
  if (inv.expire_at && inv.expire_at < Date.now()) throw new AppError(410, 'INVITE_EXPIRED', '这个邀请链接已过期');
  const g = one('SELECT * FROM groups WHERE id = ? AND deleted_at IS NULL', inv.group_id);
  if (!g) throw E.notFound('这个小组已不存在');
  const already = ctx.user ? !!Dom.membershipOf(g.id, ctx.user.id) : false;
  return {
    group: { id: g.id, name: g.name, members: Dom.membersOf(g.id).length },
    already_member: already,
    // 免登录也能看到小组名与人数，才能决定要不要加入
  };
}, { public: true });

R.post('/api/invites/:token/join', (ctx) => {
  const inv = one('SELECT * FROM invites WHERE token = ?', ctx.params.token);
  if (!inv || inv.revoked_at) throw E.notFound('邀请链接不存在或已失效');
  if (inv.expire_at && inv.expire_at < Date.now()) throw new AppError(410, 'INVITE_EXPIRED', '这个邀请链接已过期');
  const g = Dom.getGroup(inv.group_id);
  if (Dom.membershipOf(g.id, ctx.user.id)) {
    return { group_id: g.id, already_member: true, message: '你已经是这个小组的成员了' };
  }
  // 已软删除的成员重新加入
  const ghost = one('SELECT * FROM memberships WHERE group_id = ? AND user_id = ?', g.id, ctx.user.id);
  const plan = Dom.planOf(g);
  const count = Dom.membersOf(g.id).length;
  if (count >= plan.maxMembers) {
    throw E.limit(`免费版单组最多 ${plan.maxMembers} 人，升级可到 30 人`, { trigger: 'member_limit', limit: plan.maxMembers });
  }
  tx(() => {
    if (ghost) {
      run('UPDATE memberships SET deleted_at = NULL, joined_at = ? WHERE id = ?', Date.now(), ghost.id);
    } else {
      run('INSERT INTO memberships (id, group_id, user_id, role, joined_at) VALUES (?,?,?,?,?)',
        randomId('m'), g.id, ctx.user.id, 'member', Date.now());
    }
    Dom.logActivity({ groupId: g.id, actorId: ctx.user.id, action: 'member_join', to: ctx.user.nickname });
    Dom.touchGroup(g.id);
  });
  return { group_id: g.id, joined: true };
}, { auth: true });

// 移除成员（PRD 7.3：其名下未完成任务默认转给 Owner）
R.post('/api/groups/:id/members/:uid/remove', (ctx) => {
  const { group } = Dom.requireOwner(ctx.params.id, ctx.user.id);
  const uid = ctx.params.uid;
  if (uid === ctx.user.id) throw E.badRequest('你是组长，请先转让或解散小组');
  const m = Dom.membershipOf(group.id, uid);
  if (!m) throw E.notFound('这个人不在小组里');
  const tasks = all(
    "SELECT * FROM tasks WHERE group_id = ? AND assignee_id = ? AND deleted_at IS NULL AND status IN ('todo','doing')",
    group.id, uid
  );
  // C7 修复：transfer_to 必须是本组在册成员。
  // 原实现直接 `ctx.body.transfer_to || group.owner_id` 就用，传一个不存在的人
  // （甚至传任意字符串）都会把任务改派过去，任务从此不属于任何小组成员，
  // 变成永久数据错乱且无法通过界面修复。
  const target = ctx.body.transfer_to || group.owner_id;
  if (target !== group.owner_id) {
    if (typeof target !== 'string') throw E.badRequest('转交对象不对');
    const tm = Dom.membershipOf(group.id, target);
    if (!tm) throw E.badRequest('只能在小组现有成员之间转交任务');
    if (target === uid) throw E.badRequest('不能把任务转交给即将被移除的人');
  }
  tx(() => {
    run('UPDATE memberships SET deleted_at = ? WHERE id = ?', Date.now(), m.id);
    for (const t of tasks) {
      run('UPDATE tasks SET assignee_id = ?, version = version + 1, updated_at = ? WHERE id = ?', target, Date.now(), t.id);
      Dom.logActivity({ groupId: group.id, taskId: t.id, actorId: ctx.user.id, action: 'assign', from: uid, to: target });
    }
  });
  return { removed: true, transferred: tasks.length, transfer_to: target };
}, { auth: true });

R.post('/api/groups/:id/transfer', (ctx) => {
  const { group } = Dom.requireOwner(ctx.params.id, ctx.user.id);
  const to = ctx.body.user_id;
  if (!Dom.membershipOf(group.id, to)) throw E.badRequest('对方还不是小组成员');
  tx(() => {
    run('UPDATE groups SET owner_id = ? WHERE id = ?', to, group.id);
    run("UPDATE memberships SET role = 'member' WHERE group_id = ? AND user_id = ?", group.id, ctx.user.id);
    run("UPDATE memberships SET role = 'owner' WHERE group_id = ? AND user_id = ?", group.id, to);
    Dom.logActivity({ groupId: group.id, actorId: ctx.user.id, action: 'transfer_owner', to });
  });
  return { ok: true };
}, { auth: true });

// PRD 11.1 AC-17：Owner 是唯一成员时不许退出
R.post('/api/groups/:id/leave', (ctx) => {
  const { group, membership } = Dom.requireMember(ctx.params.id, ctx.user.id);
  const members = Dom.membersOf(group.id);
  if (group.owner_id === ctx.user.id) {
    if (members.length <= 1) throw E.badRequest('你是唯一成员，请先转让给别人或直接解散小组');
    throw E.badRequest('你是组长，请先把组长转让给别人');
  }
  const tasks = all(
    "SELECT * FROM tasks WHERE group_id = ? AND assignee_id = ? AND deleted_at IS NULL AND status IN ('todo','doing')",
    group.id, ctx.user.id
  );
  tx(() => {
    run('UPDATE memberships SET deleted_at = ? WHERE id = ?', Date.now(), membership.id);
    // PRD 6.3 E-01：任务保留，责任人置空，creator 收到站内通知
    for (const t of tasks) {
      run('UPDATE tasks SET assignee_id = NULL, version = version + 1, updated_at = ? WHERE id = ?', Date.now(), t.id);
      Dom.logActivity({ groupId: group.id, taskId: t.id, actorId: ctx.user.id, action: 'assign', from: ctx.user.id, to: null });
      Dom.notify({
        userId: t.creator_id, groupId: group.id, taskId: t.id, type: 'assignee_left',
        payload: { title: `「${t.title}」的责任人已退出小组，任务已转为待指派` }, offset: `left:${ctx.user.id}`,
      });
    }
  });
  return { ok: true, released: tasks.length };
}, { auth: true });

// PRD 11.1 AC-26：解散 → 全部只读，30 天后硬删除
R.post('/api/groups/:id/dissolve', (ctx) => {
  const { group } = Dom.requireOwner(ctx.params.id, ctx.user.id);
  tx(() => {
    run("UPDATE groups SET deleted_at = ?, status = 'archived' WHERE id = ?", Date.now(), group.id);
    for (const m of Dom.membersOf(group.id)) {
      Dom.notify({
        userId: m.user_id, groupId: group.id, type: 'group_dissolved',
        payload: { title: `小组「${group.name}」已解散，30 天后彻底删除，现在可以导出全部内容` },
        offset: `dissolve:${group.id}`,
      });
    }
    Dom.logActivity({ groupId: group.id, actorId: ctx.user.id, action: 'group_dissolve' });
  });
  return { ok: true, hard_delete_at: Date.now() + 30 * D.DAY, message: '小组将在 30 天后彻底删除，现在可以导出全部内容' };
}, { auth: true });

// 导出（PRD 11.2 只读导出入口）
R.get('/api/groups/:id/export', (ctx) => {
  const { group } = Dom.requireMember(ctx.params.id, ctx.user.id);
  const tasks = all('SELECT * FROM tasks WHERE group_id = ? AND deleted_at IS NULL ORDER BY created_at', group.id);
  const members = Dom.membersOf(group.id);
  const nameOf = (id) => (members.find((m) => m.user_id === id) || {}).nickname || '未指派';
  const rows = [['标题', '责任人', '创建者', '状态', '优先级', '截止时间', '标签', '描述']];
  for (const t of tasks) {
    rows.push([
      t.title, nameOf(t.assignee_id), nameOf(t.creator_id), Dom.STATUS_LABEL[t.status],
      t.priority, t.due_at ? D.formatDateTime(t.due_at) : '', JSON.parse(t.tags || '[]').join('/'), t.description || '',
    ]);
  }
  return { group: group.name, filename: `${group.name}-任务导出.csv`, csv: toCsv(rows) };
}, { auth: true });

function toCsv(rows) {
  return '\ufeff' + rows.map((r) => r.map((c) => `"${String(c == null ? '' : c).replace(/"/g, '""')}"`).join(',')).join('\r\n');
}

/* ============ FB-03 任务创建 / 指派 / 认领（PRD 7.4） ============ */

function parseDueInput(input) {
  if (input == null || input === '') return { due_at: null };
  if (typeof input === 'number') return { due_at: input };
  const r = D.parseDue(input);
  if (r.error) throw E.badRequest(r.error, { reason: 'DATE_PARSE_FAILED', input });
  return { due_at: r.due_at };
}

function insertTask(group, creatorId, body) {
  const title = String(body.title || '').trim();
  if (!title) throw E.badRequest('任务标题不能为空');
  if (title.length > 80) throw E.badRequest('标题最多 80 字');
  const desc = String(body.description || '');
  if (desc.length > 2000) throw E.badRequest('描述最多 2000 字');
  const images = Array.isArray(body.images) ? body.images.slice(0, 9) : [];
  const priority = ['low', 'mid', 'high'].includes(body.priority) ? body.priority : 'mid';
  const tags = Array.isArray(body.tags) ? body.tags.map((x) => String(x).slice(0, 12)).slice(0, 3) : [];
  const { due_at } = parseDueInput(body.due);
  let assignee = body.assignee_id || null;
  if (assignee && !Dom.membershipOf(group.id, assignee)) throw E.badRequest('被指派人不在这个小组');

  const now = Date.now();
  const id = randomId('t');
  tx(() => {
    run(
      `INSERT INTO tasks (id, group_id, title, description, images, assignee_id, creator_id, due_at, priority, status, tags, version, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?, 'todo', ?, 1, ?, ?)`,
      id, group.id, title, desc, JSON.stringify(images), assignee, creatorId, due_at, priority, JSON.stringify(tags), now, now
    );
    Dom.logActivity({ groupId: group.id, taskId: id, actorId: creatorId, action: 'create', to: title });
    if (assignee && assignee !== creatorId) {
      Dom.logActivity({ groupId: group.id, taskId: id, actorId: creatorId, action: 'assign', from: null, to: assignee });
      Dom.notify({
        userId: assignee, groupId: group.id, taskId: id, type: 'task_assigned',
        payload: { title: `你被安排了一件事：${title}`, groupName: group.name, due_at }, offset: `assign:${now}`,
      });
    }
    Dom.touchGroup(group.id);
  });
  return Dom.taskWithMeta(Dom.getTask(id));
}

R.post('/api/groups/:id/tasks', (ctx) => {
  const { group } = Dom.requireMember(ctx.params.id, ctx.user.id);
  Dom.assertWritable(group);
  // 批量创建（PRD 7.4：粘贴多行，每行一条，开关默认关闭）
  if (ctx.body.batch && Array.isArray(ctx.body.titles)) {
    const out = [];
    for (const t of ctx.body.titles.slice(0, 30)) {
      if (String(t).trim()) out.push(insertTask(group, ctx.user.id, { ...ctx.body, title: String(t).trim(), batch: false }));
    }
    return { tasks: out, count: out.length };
  }
  return { task: insertTask(group, ctx.user.id, ctx.body) };
}, { auth: true });

// 日期解析预览（前端输入框实时提示）
R.get('/api/parse-date', (ctx) => {
  const input = String(ctx.query.q || '');
  if (!input) return { due_at: null, label: '' };
  const r = D.parseDue(input);
  if (r.error) return { error: r.error };
  return { due_at: r.due_at, label: D.formatDue(r.due_at), iso: D.formatDateTime(r.due_at) };
}, { public: true });

R.get('/api/groups/:id/tasks', (ctx) => {
  const { group } = Dom.requireMember(ctx.params.id, ctx.user.id);
  // PRD 11.1 AC-18/AC-26：解散后 30 天内的只读窗口仍可读
  const q = ctx.query;
  let sql = 'SELECT * FROM tasks WHERE group_id = ? AND deleted_at IS NULL';
  const params = [group.id];
  if (q.status && q.status !== 'all') { sql += ' AND status = ?'; params.push(q.status); }
  else if (!q.include_done) { sql += " AND status != 'cancelled'"; }
  if (q.assignee) {
    if (q.assignee === 'none') sql += ' AND assignee_id IS NULL';
    else { sql += ' AND assignee_id = ?'; params.push(q.assignee); }
  }
  if (q.q) { sql += ' AND (title LIKE ? OR description LIKE ?)'; params.push(`%${q.q}%`, `%${q.q}%`); }
  sql += ' ORDER BY created_at DESC';
  const tasks = all(sql, ...params).map(Dom.taskWithMeta);
  return { tasks, server_now: Date.now() };
}, { auth: true });

R.get('/api/groups/:id/board', (ctx) => {
  const { group } = Dom.requireMember(ctx.params.id, ctx.user.id);
  const now = Date.now();
  // 排序：逾期 → 优先级 → 截止时间（PRD 7.5）
  const prioRank = { high: 0, mid: 1, low: 2 };
  const allTasks = all('SELECT * FROM tasks WHERE group_id = ? AND deleted_at IS NULL', group.id).map(Dom.taskWithMeta);
  const sortFn = (a, b) => {
    const ao = a.is_overdue ? 0 : 1;
    const bo = b.is_overdue ? 0 : 1;
    if (ao !== bo) return ao - bo;
    const ap = prioRank[a.priority] - prioRank[b.priority];
    if (ap !== 0) return ap;
    return (a.due_at || Infinity) - (b.due_at || Infinity);
  };
  const columns = {};
  const counts = {};
  const hasMore = {};
  for (const s of Dom.STATUS) {
    const col = allTasks.filter((t) => t.status === s).sort(sortFn);
    counts[s] = col.length;
    // PRD 7.5 性能约束：超过 500 条时列内只渲染前 20 条 + 加载更多
    const limit = Number(ctx.query.limit || 20);
    columns[s] = col.slice(0, Math.min(limit, 500));
    hasMore[s] = col.length > columns[s].length;
  }
  const attention = allTasks.filter((t) => t.is_overdue).sort((a, b) => b.overdue_days - a.overdue_days);
  const perMember = {};
  for (const m of Dom.membersOf(group.id)) {
    perMember[m.user_id] = {
      nickname: m.nickname,
      todo: allTasks.filter((t) => t.assignee_id === m.user_id && t.status === 'todo').length,
      doing: allTasks.filter((t) => t.assignee_id === m.user_id && t.status === 'doing').length,
      overdue: allTasks.filter((t) => t.assignee_id === m.user_id && t.is_overdue).length,
    };
  }
  return { columns, counts, has_more: hasMore, attention, per_member: perMember, server_now: now, total: allTasks.length, page_size: Number(ctx.query.limit || 20) };
}, { auth: true });

// 我的任务：跨组聚合（PRD 7.5）
R.get('/api/my-tasks', (ctx) => {
  const now = Date.now();
  const rows = all(
    `SELECT t.*, g.name AS group_name FROM tasks t
       JOIN groups g ON g.id = t.group_id
       JOIN memberships m ON m.group_id = t.group_id AND m.user_id = ? AND m.deleted_at IS NULL
      WHERE t.assignee_id = ? AND t.deleted_at IS NULL AND t.status IN ('todo','doing') AND g.deleted_at IS NULL
      ORDER BY t.due_at IS NULL, t.due_at`,
    ctx.user.id, ctx.user.id
  ).map((t) => ({ ...Dom.taskWithMeta(t), group_name: t.group_name }));
  const today = D.endOfDay(now);
  const weekEnd = D.startOfWeek(now) + 7 * D.DAY - 1;
  const buckets = { overdue: [], today: [], week: [], later: [] };
  for (const t of rows) {
    if (!t.due_at) buckets.later.push(t);
    else if (t.is_overdue) buckets.overdue.push(t);
    else if (t.due_at <= today) buckets.today.push(t);
    else if (t.due_at <= weekEnd) buckets.week.push(t);
    else buckets.later.push(t);
  }
  // 无责任人的待认领任务也出现在「我的任务」底部，给一个入口
  const unassigned = all(
    `SELECT t.*, g.name AS group_name FROM tasks t
       JOIN groups g ON g.id = t.group_id
       JOIN memberships m ON m.group_id = t.group_id AND m.user_id = ? AND m.deleted_at IS NULL
      WHERE t.assignee_id IS NULL AND t.deleted_at IS NULL AND t.status = 'todo' AND g.deleted_at IS NULL
      ORDER BY t.created_at DESC LIMIT 20`,
    ctx.user.id
  ).map((t) => ({ ...Dom.taskWithMeta(t), group_name: t.group_name }));
  return { buckets, unassigned, server_now: now };
}, { auth: true });

R.get('/api/tasks/:id', (ctx) => {
  const t = Dom.getTask(ctx.params.id);
  const { group, membership } = Dom.requireMember(t.group_id, ctx.user.id);
  const acts = all(
    `SELECT a.*, u.nickname, u.avatar_color FROM activities a JOIN users u ON u.id = a.actor_id
      WHERE a.task_id = ? ORDER BY a.created_at DESC LIMIT 50`,
    t.id
  );
  const comments = all(
    `SELECT c.*, u.nickname, u.avatar_color FROM comments c JOIN users u ON u.id = c.author_id
      WHERE c.task_id = ? AND c.deleted_at IS NULL ORDER BY c.created_at`,
    t.id
  ).map((c) => ({ ...c, mentions: JSON.parse(c.mentions || '[]') }));
  const files = all('SELECT * FROM attachments WHERE task_id = ? AND deleted_at IS NULL ORDER BY created_at DESC', t.id);
  const link = one('SELECT * FROM share_links WHERE task_id = ? AND revoked_at IS NULL ORDER BY created_at DESC', t.id);
  return {
    task: Dom.taskWithMeta(t),
    activities: acts,
    comments,
    attachments: files,
    share: link ? { token: link.token, expire_at: link.expire_at, view_count: link.view_count } : null,
    my_role: group.owner_id === ctx.user.id ? 'owner' : 'member',
    my_membership: membership.role,
    group: { id: group.id, name: group.name, owner_id: group.owner_id },
  };
}, { auth: true });

R.patch('/api/tasks/:id', (ctx) => {
  const t = Dom.getTask(ctx.params.id);
  const { group } = Dom.requireMember(t.group_id, ctx.user.id);
  Dom.assertWritable(group);
  const b = ctx.body;

  // 指派与认领不受 restrict 限制（PRD 4.2：成员可指派）
  const editingFields = ['title', 'description', 'due', 'priority', 'tags', 'images'].some((k) => b[k] !== undefined);
  if (editingFields && !Dom.canEdit(t, group, ctx.user.id)) {
    throw E.forbidden('只有创建者和组长能改标题、描述、截止时间');
  }

  // 乐观锁（PRD 6.3 E-06）
  if (b.version != null && Number(b.version) !== t.version) {
    const who = one('SELECT nickname FROM users WHERE id = (SELECT actor_id FROM activities WHERE task_id = ? ORDER BY created_at DESC LIMIT 1)', t.id);
    throw E.conflict(`该任务已被 ${who ? who.nickname : '其他人'} 修改，已刷新为最新`, { current_version: t.version });
  }

  const updates = [];
  const params = [];
  const push = (sql, v) => { updates.push(sql); params.push(v); };

  if (b.title !== undefined) {
    const ti = String(b.title).trim();
    if (!ti) throw E.badRequest('标题不能为空');
    if (ti.length > 80) throw E.badRequest('标题最多 80 字');
    if (ti !== t.title) { push('title = ?', ti); }
  }
  if (b.description !== undefined) {
    const d = String(b.description);
    if (d.length > 2000) throw E.badRequest('描述最多 2000 字');
    push('description = ?', d);
  }
  if (b.images !== undefined) push('images = ?', JSON.stringify((b.images || []).slice(0, 9)));
  if (b.priority !== undefined) {
    if (!['low', 'mid', 'high'].includes(b.priority)) throw E.badRequest('优先级只能是低/中/高');
    push('priority = ?', b.priority);
  }
  if (b.tags !== undefined) push('tags = ?', JSON.stringify((b.tags || []).map((x) => String(x).slice(0, 12)).slice(0, 3)));
  if (b.due !== undefined) {
    const { due_at } = parseDueInput(b.due);
    push('due_at = ?', due_at);
  }
  if (b.assignee_id !== undefined) {
    const a = b.assignee_id || null;
    if (a && !Dom.membershipOf(t.group_id, a)) throw E.badRequest('这个人不在小组里');
    if (a && a !== t.assignee_id && t.assignee_id && !Dom.canEdit(t, group, ctx.user.id)) {
      throw E.forbidden('已指派的任务只能由创建者或组长改派');
    }
    push('assignee_id = ?', a);
  }

  if (updates.length) {
    tx(() => {
      run(
        `UPDATE tasks SET ${updates.join(', ')}, version = version + 1, updated_at = ? WHERE id = ?`,
        ...params, Date.now(), t.id
      );
      if (b.due !== undefined) {
        const { due_at } = parseDueInput(b.due);
        if (due_at !== t.due_at) {
          Dom.logActivity({ groupId: t.group_id, taskId: t.id, actorId: ctx.user.id, action: 'due_change', from: t.due_at, to: due_at });
        }
      }
      if (b.assignee_id !== undefined && (b.assignee_id || null) !== t.assignee_id) {
        Dom.logActivity({ groupId: t.group_id, taskId: t.id, actorId: ctx.user.id, action: 'assign', from: t.assignee_id, to: b.assignee_id || null });
        if (b.assignee_id) {
          Dom.notify({
            userId: b.assignee_id, groupId: t.group_id, taskId: t.id, type: 'task_assigned',
            payload: { title: `你被安排了一件事：${t.title}`, groupName: group.name }, offset: `assign:${Date.now()}`,
          });
        }
      }
    });
  }
  return { task: Dom.taskWithMeta(Dom.getTask(t.id)) };
}, { auth: true });

// 状态流转（PRD 6.2）
R.post('/api/tasks/:id/status', (ctx) => {
  const t = Dom.getTask(ctx.params.id);
  const { group } = Dom.requireMember(t.group_id, ctx.user.id);
  Dom.assertWritable(group);
  const next = String(ctx.body.status || '');
  if (next === 'archived') {
    throw E.badRequest('归档列只用于存放已取消的任务，请先把任务取消', { reason: 'ILLEGAL_TRANSITION', to: 'archived' });
  }
  if (!Dom.STATUS.includes(next)) throw E.badRequest('未知状态');
  if (ctx.body.version != null && Number(ctx.body.version) !== t.version) {
    const who = one('SELECT nickname FROM users WHERE id = (SELECT actor_id FROM activities WHERE task_id = ? ORDER BY created_at DESC LIMIT 1)', t.id);
    throw E.conflict(`该任务已被 ${who ? who.nickname : '其他人'} 修改，已刷新为最新`, {
      task: Dom.taskWithMeta(Dom.getTask(t.id)),   // 前端直接拿这份刷新，无需再请求
      current_version: t.version,
    });
  }
  if (next === 'cancelled' && !ctx.body.confirm) {
    throw E.badRequest('取消前需要二次确认', { need_confirm: true, message: '取消后任务会进入归档列，可以随时恢复。确定取消？' });
  }
  if (t.status === 'done' && next === 'todo' && !String(ctx.body.reason || '').trim()) {
    throw E.badRequest('重新打开需要填写原因', { need_reason: true });
  }
  const updated = Dom.applyStatusChange(t, group, ctx.user.id, next, { reason: ctx.body.reason });
  return { task: Dom.taskWithMeta(updated) };
}, { auth: true });

// 认领（PRD 7.4 / AC-15）
R.post('/api/tasks/:id/claim', (ctx) => {
  const t = Dom.getTask(ctx.params.id);
  const { group } = Dom.requireMember(t.group_id, ctx.user.id);
  Dom.assertWritable(group);
  if (t.assignee_id) {
    const who = one('SELECT nickname FROM users WHERE id = ?', t.assignee_id);
    throw E.badRequest(`该任务已由 ${who ? who.nickname : '他人'} 负责，需要改派请找组长`, {
      reason: 'ALREADY_ASSIGNED', assignee: Dom.publicUser(who),
    });
  }
  tx(() => {
    run('UPDATE tasks SET assignee_id = ?, version = version + 1, updated_at = ? WHERE id = ? AND assignee_id IS NULL',
      ctx.user.id, Date.now(), t.id);
    Dom.logActivity({ groupId: t.group_id, taskId: t.id, actorId: ctx.user.id, action: 'claim', to: ctx.user.id });
    if (t.creator_id !== ctx.user.id) {
      Dom.notify({
        userId: t.creator_id, groupId: t.group_id, taskId: t.id, type: 'claim',
        payload: { title: `${ctx.user.nickname} 认领了「${t.title}」` }, offset: `claim:${ctx.user.id}`,
      });
    }
  });
  return { task: Dom.taskWithMeta(Dom.getTask(t.id)), message: '这件事归你了，到期前一天我会提醒你' };
}, { auth: true });

// 删除（软删除，PRD 4.2 + AC-18）
R.del('/api/tasks/:id', (ctx) => {
  const t = Dom.getTask(ctx.params.id);
  const { group } = Dom.requireMember(t.group_id, ctx.user.id);
  if (!Dom.canDeleteTask(t, group, ctx.user.id)) {
    throw E.forbidden(t.assignee_id && t.creator_id === ctx.user.id
      ? '任务已有人认领，只有组长能删除'
      : '只有组长或任务的创建者能删除');
  }
  tx(() => {
    run('UPDATE tasks SET deleted_at = ?, version = version + 1 WHERE id = ?', Date.now(), t.id);
    Dom.logActivity({ groupId: t.group_id, taskId: t.id, actorId: ctx.user.id, action: 'delete', to: t.title });
  });
  return { ok: true, restore_until: Date.now() + 7 * D.DAY, message: '已移入回收站，7 天内可以恢复' };
}, { auth: true });

// 回收站（AC-18）
R.get('/api/groups/:id/trash', (ctx) => {
  Dom.requireMember(ctx.params.id, ctx.user.id);
  const cutoff = Date.now() - 7 * D.DAY;
  const rows = all(
    'SELECT * FROM tasks WHERE group_id = ? AND deleted_at IS NOT NULL AND deleted_at > ? ORDER BY deleted_at DESC',
    ctx.params.id, cutoff
  );
  return { tasks: rows.map(Dom.taskWithMeta) };
}, { auth: true });

R.post('/api/tasks/:id/restore', (ctx) => {
  const t = one('SELECT * FROM tasks WHERE id = ?', ctx.params.id);
  if (!t) throw E.notFound('任务不存在');
  const { group } = Dom.requireMember(t.group_id, ctx.user.id);
  if (!Dom.canEdit(t, group, ctx.user.id)) throw E.forbidden('只有创建者或组长能恢复');
  if (!t.deleted_at) return { task: Dom.taskWithMeta(t), message: '任务本来就在' };
  if (Date.now() - t.deleted_at > 7 * D.DAY) throw E.badRequest('超过 7 天，已无法恢复');
  tx(() => {
    run('UPDATE tasks SET deleted_at = NULL, version = version + 1 WHERE id = ?', t.id);
    Dom.logActivity({ groupId: t.group_id, taskId: t.id, actorId: ctx.user.id, action: 'restore' });
  });
  return { task: Dom.taskWithMeta(Dom.getTask(t.id)), message: '已恢复' };
}, { auth: true });

/* ============ FB-06 文件（PRD 7.7） ============ */

function quotaCheck(group, size) {
  const plan = Dom.planOf(group);
  if (size > plan.singleFile) {
    throw E.limit(`单文件上限 ${plan.singleFile / 1024 / 1024}MB，升级可到 100MB`, {
      trigger: 'single_file', limit: plan.singleFile, size, exits: ['upgrade'],
    });
  }
  if (group.storage_used_bytes + size > group.storage_quota_bytes) {
    const pct = Math.round((group.storage_used_bytes / group.storage_quota_bytes) * 100);
    throw E.limit(`小组空间已用 ${pct}%。清理旧文件，或升级到高级版（¥19/组/月）`, {
      trigger: 'storage', used: group.storage_used_bytes, quota: group.storage_quota_bytes, exits: ['cleanup', 'upgrade'],
    });
  }
}

const PREVIEWABLE = /^(image\/(png|jpe?g|gif|webp)|text\/plain|application\/pdf|application\/vnd\.openxmlformats|application\/msword|application\/vnd\.ms-excel)/i;
const NEVER_INLINE = /^(image\/svg\+xml|text\/html)/i;

R.post('/api/tasks/:id/files', (ctx) => {
  const t = Dom.getTask(ctx.params.id);
  const { group } = Dom.requireMember(t.group_id, ctx.user.id);
  Dom.assertWritable(group);
  const { filename, mime, data_b64 } = ctx.body;
  const name = String(filename || 'file').slice(0, 120);
  const mid = String(mime || 'application/octet-stream');

  // C5 修复：不再采用客户端上报的 size。
  // 原实现信 `Number(size)`，声明 1 字节实传 2MB 也能通过配额校验，
  // 组计数器只 +1，配额可无限绕过。
  // 现在先解码取真实字节数，配额按真实值判定，落库也写真实值。
  if (!data_b64) throw E.badRequest('文件是空的');
  let buf;
  try {
    buf = Buffer.from(String(data_b64), 'base64');
  } catch {
    throw E.badRequest('文件内容格式不对');
  }
  const sz = buf.length;
  if (!sz) throw E.badRequest('文件是空的');
  quotaCheck(group, sz);

  const attId = randomId('att');
  const storageKey = `${group.id}/${attId}`;
  const filePath = path.join(UPLOAD_DIR, storageKey.replace(/[/]/g, '_'));
  fs.writeFileSync(filePath, buf);

  // 写盘后再核对一次，防止 base64 与声明不一致造成计数漂移
  const onDisk = fs.statSync(filePath).size;
  if (onDisk !== sz) {
    try { fs.unlinkSync(filePath); } catch { /* ignore */ }
    throw E.badRequest('文件写入校验失败，请重试');
  }

  let fileGroupId;
  let versionNo = 1;
  tx(() => {
    // 版本组：同任务同名 → 归入同一 file_group（PRD 11.1 AC-23）
    let fg = one('SELECT * FROM file_groups WHERE task_id = ? AND name = ?', t.id, name);
    if (!fg) {
      fileGroupId = randomId('fg');
      run('INSERT INTO file_groups (id, task_id, group_id, name, current_attachment_id, created_at) VALUES (?,?,?,?,NULL,?)',
        fileGroupId, t.id, t.group_id, name, Date.now());
    } else {
      fileGroupId = fg.id;
      const maxV = one('SELECT MAX(version_no) AS v FROM attachments WHERE file_group_id = ?', fg.id);
      versionNo = (maxV.v || 0) + 1;
    }
    run(
      `INSERT INTO attachments (id, file_group_id, task_id, uploader_id, filename, size, mime, storage_key, version_no, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      attId, fileGroupId, t.id, ctx.user.id, name, sz, mid, storageKey, versionNo, Date.now()
    );
    run('UPDATE file_groups SET current_attachment_id = ? WHERE id = ?', attId, fileGroupId);
    run('UPDATE groups SET storage_used_bytes = storage_used_bytes + ? WHERE id = ?', sz, group.id);
    Dom.logActivity({ groupId: t.group_id, taskId: t.id, actorId: ctx.user.id, action: 'file_add', to: name });
    Dom.touchGroup(group.id);
  });
  return {
    attachment: one('SELECT * FROM attachments WHERE id = ?', attId),
    file_group_id: fileGroupId,
    version_no: versionNo,
    quota_used_pct: Math.round(((group.storage_used_bytes + sz) / group.storage_quota_bytes) * 100),
  };
}, { auth: true });

R.get('/api/tasks/:id/files', (ctx) => {
  const t = Dom.getTask(ctx.params.id);
  Dom.requireMember(t.group_id, ctx.user.id);
  const groups = all('SELECT * FROM file_groups WHERE task_id = ? ORDER BY created_at', t.id);
  const plan = Dom.planOf(Dom.getGroup(t.group_id));
  return {
    files: groups.map((fg) => {
      const versions = all('SELECT * FROM attachments WHERE file_group_id = ? AND deleted_at IS NULL ORDER BY version_no DESC', fg.id);
      return {
        file_group_id: fg.id,
        name: fg.name,
        current: versions.find((v) => v.id === fg.current_attachment_id) || versions[0],
        versions: versions.slice(0, plan.versions === Infinity ? versions.length : plan.versions),
        hidden_versions: plan.versions === Infinity ? 0 : Math.max(0, versions.length - plan.versions),
        previewable: versions[0] ? PREVIEWABLE.test(versions[0].mime) && !NEVER_INLINE.test(versions[0].mime) : false,
      };
    }),
  };
}, { auth: true });

// 15 分钟签名 URL（PRD 7.7 / AC-21）
R.post('/api/attachments/:id/url', (ctx) => {
  const a = one('SELECT * FROM attachments WHERE id = ? AND deleted_at IS NULL', ctx.params.id);
  if (!a) throw E.notFound('文件不存在');
  const t = Dom.getTask(a.task_id);
  Dom.requireMember(t.group_id, ctx.user.id);
  const exp = Date.now() + 15 * 60 * 1000;
  const sig = signDownload(a.id, ctx.user.id, exp);
  return { url: `/api/download/${a.id}?uid=${ctx.user.id}&exp=${exp}&sig=${sig}`, expires_at: exp };
}, { auth: true });

function signDownload(id, uid, exp) {
  // C1 同类修复：原先这里也用了公开常量兜底，改为统一走 secrets.js
  return crypto.createHmac('sha256', require('./secrets').sessionKey())
    .update(`dl:${id}|${uid}|${exp}`).digest('base64url');
}

// 下载：校验签名与过期（AC-21）
R.get('/api/download/:id', (ctx) => {
  const { id } = ctx.params;
  const { uid, exp, sig } = ctx.query;
  if (!uid || !exp || !sig) throw new AppError(403, 'SIGNATURE_REQUIRED', '链接不完整，请重新获取');
  if (Number(exp) < Date.now()) throw new AppError(403, 'URL_EXPIRED', '链接已过期，请重新获取');
  if (signDownload(id, uid, exp) !== sig) throw new AppError(403, 'BAD_SIGNATURE', '链接无效');
  const a = one('SELECT * FROM attachments WHERE id = ? AND deleted_at IS NULL', id);
  if (!a) throw E.notFound('文件不存在');
  const t = Dom.getTask(a.task_id);
  Dom.requireMember(t.group_id, uid);
  const fp = path.join(UPLOAD_DIR, a.storage_key.replace(/[/]/g, '_'));
  ctx.raw = { file: fp, filename: a.filename, mime: NEVER_INLINE.test(a.mime) ? 'application/octet-stream' : a.mime };
  return null;
}, { public: true, raw: true });

R.del('/api/attachments/:id', (ctx) => {
  const a = one('SELECT * FROM attachments WHERE id = ? AND deleted_at IS NULL', ctx.params.id);
  if (!a) throw E.notFound('文件不存在');
  const { group } = Dom.requireMember(Dom.getTask(a.task_id).group_id, ctx.user.id);
  if (group.owner_id !== ctx.user.id) throw E.forbidden('只有组长能删文件');
  tx(() => {
    run('UPDATE attachments SET deleted_at = ? WHERE id = ?', Date.now(), a.id);
    run('UPDATE groups SET storage_used_bytes = MAX(0, storage_used_bytes - ?) WHERE id = ?', a.size, group.id);
    Dom.logActivity({ groupId: group.id, taskId: a.task_id, actorId: ctx.user.id, action: 'file_delete', to: a.filename });
  });
  return { ok: true, restore_until: Date.now() + 7 * D.DAY };
}, { auth: true });

R.get('/api/groups/:id/files', (ctx) => {
  const { group } = Dom.requireMember(ctx.params.id, ctx.user.id);
  const rows = all(
    `SELECT a.*, t.title AS task_title FROM attachments a JOIN tasks t ON t.id = a.task_id
      WHERE t.group_id = ? AND a.deleted_at IS NULL AND t.deleted_at IS NULL ORDER BY a.created_at DESC`,
    group.id
  );
  return {
    storage: { used: group.storage_used_bytes, quota: group.storage_quota_bytes, pct: Math.round((group.storage_used_bytes / group.storage_quota_bytes) * 100) },
    files: rows,
  };
}, { auth: true });

/* ============ FB-07 评论（PRD 7.8） ============ */

R.post('/api/tasks/:id/comments', (ctx) => {
  const t = Dom.getTask(ctx.params.id);
  const { group } = Dom.requireMember(t.group_id, ctx.user.id);
  Dom.assertWritable(group);
  const content = String(ctx.body.content || '').trim();
  if (!content) throw E.badRequest('评论不能为空');
  if (content.length > 1000) throw E.badRequest('评论最多 1000 字');
  const mentions = [];
  const re = /@([^\s@]{1,20})/g;
  const members = Dom.membersOf(group.id);
  let m;
  while ((m = re.exec(content))) {
    const hit = members.find((x) => x.nickname === m[1]);
    if (hit && hit.user_id !== ctx.user.id && !mentions.includes(hit.user_id)) mentions.push(hit.user_id);
  }
  const id = randomId('c');
  tx(() => {
    run('INSERT INTO comments (id, task_id, author_id, content, mentions, created_at) VALUES (?,?,?,?,?,?)',
      id, t.id, ctx.user.id, content, JSON.stringify(mentions), Date.now());
    Dom.logActivity({ groupId: t.group_id, taskId: t.id, actorId: ctx.user.id, action: 'comment' });
    for (const uid of mentions) {
      Dom.notify({
        userId: uid, groupId: t.group_id, taskId: t.id, type: 'mention',
        payload: { title: `${ctx.user.nickname} 在「${t.title}」里提到了你` }, offset: `mention:${id}`,
      });
    }
  });
  return {
    comment: one('SELECT * FROM comments WHERE id = ?', id),
    // PRD 11.1 AC-24：@ 仅站内通知，未绑定不发微信
    mention_notified: mentions,
  };
}, { auth: true });

// AC-25：动态流不可删除，无入口，API 返回 405
R.del('/api/activities/:id', () => { throw E.method('动态记录不可删除'); }, { auth: true });
R.patch('/api/activities/:id', () => { throw E.method('动态记录不可编辑'); }, { auth: true });

R.get('/api/groups/:id/activities', (ctx) => {
  Dom.requireMember(ctx.params.id, ctx.user.id);
  const rows = all(
    `SELECT a.*, u.nickname, u.avatar_color, t.title AS task_title FROM activities a
       JOIN users u ON u.id = a.actor_id LEFT JOIN tasks t ON t.id = a.task_id
      WHERE a.group_id = ? ORDER BY a.created_at DESC LIMIT ?`,
    ctx.params.id, Number(ctx.query.limit || 40)
  );
  return { activities: rows };
}, { auth: true });

/* ============ FB-08 分享卡片与访客查看（PRD 7.9） ============ */

R.post('/api/tasks/:id/share', (ctx) => {
  const t = Dom.getTask(ctx.params.id);
  Dom.requireMember(t.group_id, ctx.user.id);
  const days = ctx.body.expire_days ? Number(ctx.body.expire_days) : 0;
  if (days && ![1, 7].includes(days)) throw E.badRequest('有效期只能是 1 天 / 7 天 / 永久');
  const token = randomToken(12);
  run(
    'INSERT INTO share_links (id, task_id, token, expire_at, revoked_at, view_count, created_by, created_at) VALUES (?,?,?,?,NULL,0,?,?)',
    randomId('sl'), t.id, token, days ? Date.now() + days * D.DAY : null, ctx.user.id, Date.now()
  );
  return {
    token,
    url: `/s/${token}`,
    expire_at: days ? Date.now() + days * D.DAY : null,
    card: buildShareCard(t, Dom.getGroup(t.group_id)),
  };
}, { auth: true });

function buildShareCard(t, group) {
  const assignee = t.assignee_id ? one('SELECT nickname FROM users WHERE id = ?', t.assignee_id) : null;
  return {
    title: t.title,
    assignee: assignee ? assignee.nickname : '待指派',
    due: t.due_at ? D.formatDue(t.due_at) : '无截止',
    status: Dom.STATUS_LABEL[t.status],
    group: group.name,
    text: `【轻队 · ${group.name}】\n${t.title}\n责任人：${assignee ? assignee.nickname : '待指派'}\n截止：${t.due_at ? D.formatDue(t.due_at) : '无截止'}\n在轻队查看`,
  };
}

R.post('/api/tasks/:id/share/revoke', (ctx) => {
  const t = Dom.getTask(ctx.params.id);
  const { group } = Dom.requireMember(t.group_id, ctx.user.id);
  if (group.owner_id !== ctx.user.id) throw E.forbidden('只有组长能撤销分享链接');
  run('UPDATE share_links SET revoked_at = ? WHERE task_id = ? AND revoked_at IS NULL', Date.now(), t.id);
  return { ok: true };
}, { auth: true });

// 访客查看（无需登录）— AC-01 / AC-19
R.get('/api/share/:token', (ctx) => {
  const link = one('SELECT * FROM share_links WHERE token = ?', ctx.params.token);
  if (!link) throw new AppError(404, 'SHARE_CLOSED', '该任务已关闭');
  if (link.revoked_at) throw new AppError(410, 'SHARE_CLOSED', '该任务已关闭');
  if (link.expire_at && link.expire_at < Date.now()) throw new AppError(410, 'SHARE_CLOSED', '该任务已关闭');
  const t = one('SELECT * FROM tasks WHERE id = ? AND deleted_at IS NULL', link.task_id);
  if (!t) throw new AppError(410, 'SHARE_CLOSED', '该任务已关闭');
  run('UPDATE share_links SET view_count = view_count + 1 WHERE id = ?', link.id);
  const group = one('SELECT * FROM groups WHERE id = ?', t.group_id);
  const task = Dom.taskWithMeta(t);
  const files = all('SELECT id, filename, size, mime FROM attachments WHERE task_id = ? AND deleted_at IS NULL', t.id);
  const viewer = ctx.user;
  const isMember = viewer ? !!Dom.membershipOf(t.group_id, viewer.id) : false;
  return {
    task: {
      id: task.id, title: task.title, description: task.description, images: task.images,
      assignee: task.assignee, due_at: task.due_at, due_label: task.due_label,
      status: task.status, status_label: task.status_label, priority: task.priority,
      is_overdue: task.is_overdue, overdue_days: task.overdue_days, tags: task.tags,
    },
    // PRD 7.9：附件仅列名称，不可下载
    attachments: files.map((f) => ({ filename: f.filename, size: f.size })),
    group: { name: group.name, members: Dom.membersOf(group.id).length },
    viewer: {
      logged_in: !!viewer,
      is_member: isMember,
      can_claim: !!viewer && !isMember ? false : (!!viewer && !task.assignee_id),
      assignee_empty: !task.assignee_id,
    },
    value_prop: '微信群负责说，轻队负责记住谁什么时候交',
    cta: '认领这件事',
  };
}, { public: true });

/* ============ FB-09 付费（PRD 7.10） ============ */

R.get('/api/plan', () => ({
  free: { storage_mb: 500, single_file_mb: 20, versions: 3, members: 8, groups: 3, watermark: true, price: 0 },
  pro: { storage_mb: 2048, single_file_mb: 100, versions: -1, members: 30, groups: 10, watermark: false, price_month: 19, price_year: 168 },
  subtitle: '一个学期 168 块，换不延期',
  refund: '7 天内无理由全额退款，自助操作',
}), { public: true });

R.post('/api/groups/:id/upgrade', (ctx) => {
  const { group } = Dom.requireOwner(ctx.params.id, ctx.user.id);
  const cycle = ctx.body.cycle === 'year' ? 'year' : 'month';
  const amount = cycle === 'year' ? 16800 : 1900;
  const id = randomId('o');
  tx(() => {
    run('INSERT INTO orders (id, group_id, user_id, plan, cycle, amount, status, paid_at, channel_trade_no, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
      id, group.id, ctx.user.id, 'pro', cycle, amount, 'paid', Date.now(), 'manual_' + randomId(), Date.now());
    run("UPDATE groups SET plan = 'pro', storage_quota_bytes = ? WHERE id = ?", Dom.PLAN.pro.storage, group.id);
  });
  return { order: one('SELECT * FROM orders WHERE id = ?', id), group: groupSummary(Dom.getGroup(group.id), ctx.user.id) };
}, { auth: true });

R.post('/api/groups/:id/refund', (ctx) => {
  const { group } = Dom.requireOwner(ctx.params.id, ctx.user.id);
  const order = one("SELECT * FROM orders WHERE group_id = ? AND status = 'paid' ORDER BY created_at DESC", group.id);
  if (!order) throw E.notFound('没有可退款的订单');
  if (Date.now() - order.paid_at > 7 * D.DAY) throw E.badRequest('超过 7 天，无法自助退款');
  tx(() => {
    run("UPDATE orders SET status = 'refunded', refunded_at = ? WHERE id = ?", Date.now(), order.id);
    run("UPDATE groups SET plan = 'free', storage_quota_bytes = ? WHERE id = ?", Dom.PLAN.free.storage, group.id);
  });
  return { ok: true, message: '已退款，预计 3 个工作日到账' };
}, { auth: true });

/* ============ 提醒 ============ */

R.get('/api/notifications', (ctx) => ({
  items: Rem.inbox(ctx.user.id),
  unread: Rem.unreadCount(ctx.user.id),
}), { auth: true });

R.post('/api/notifications/read', (ctx) => ({
  unread: Rem.markRead(ctx.user.id, ctx.body.ids),
}), { auth: true });

R.post('/api/groups/:id/nudge', (ctx) => Rem.nudge(ctx.params.id, ctx.user.id, ctx.body.task_ids), { auth: true });

R.get('/api/groups/:id/ics', (ctx) => {
  const ics = Rem.buildIcs(ctx.params.id, ctx.user.id);
  const g = Dom.getGroup(ctx.params.id);
  ctx.raw = { body: ics, filename: `${g.name}.ics`, mime: 'text/calendar; charset=utf-8' };
  return null;
}, { auth: true });

// 手动触发一轮提醒（后台定时器也调用它；测试直接调）
R.post('/api/reminders/run', () => {
  const s = Rem.runReminders();
  return { sent: s, disturbance: Rem.disturbanceRate() };
}, { auth: false, admin: process.env.QD_ADMIN !== '0' });

R.get('/api/metrics', () => {
  const now = Date.now();
  const weekStart = D.startOfWeek(now);
  const wag = all(
    `SELECT group_id FROM activities WHERE created_at >= ? AND action = 'status_change'
      GROUP BY group_id HAVING COUNT(*) >= 3
      AND COUNT(DISTINCT actor_id) >= 2`,
    weekStart
  ).length;
  const total = one('SELECT COUNT(*) AS c FROM groups WHERE deleted_at IS NULL').c;
  return {
    wag,
    total_groups: total,
    reminder_disturbance: Rem.disturbanceRate(),
    server_now: now,
  };
}, { auth: false });

module.exports = {};
