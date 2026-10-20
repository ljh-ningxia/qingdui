-- 轻队 QingDui 数据模型 · 对齐 PRD 第 9 章（12 实体）
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id              TEXT PRIMARY KEY,
  phone           TEXT NOT NULL UNIQUE,          -- PRD 要求加密存储，见 crypto.js（AES-256-GCM）
  phone_hash      TEXT NOT NULL UNIQUE,          -- 盲索引，用于登录查找
  nickname        TEXT NOT NULL,
  avatar_color    TEXT NOT NULL,
  openid          TEXT,
  email           TEXT,
  notify_prefs    TEXT NOT NULL DEFAULT '{}',
  device_id       TEXT,
  created_at      INTEGER NOT NULL,
  last_active_at  INTEGER NOT NULL,
  deleted_at      INTEGER
);

CREATE TABLE IF NOT EXISTS groups (
  id                  TEXT PRIMARY KEY,
  name                TEXT NOT NULL,
  owner_id            TEXT NOT NULL REFERENCES users(id),
  plan                TEXT NOT NULL DEFAULT 'free',
  storage_used_bytes  INTEGER NOT NULL DEFAULT 0,
  storage_quota_bytes INTEGER NOT NULL,
  status              TEXT NOT NULL DEFAULT 'active',
  last_active_at      INTEGER NOT NULL,
  created_at          INTEGER NOT NULL,
  deleted_at          INTEGER
);

CREATE TABLE IF NOT EXISTS memberships (
  id        TEXT PRIMARY KEY,
  group_id  TEXT NOT NULL REFERENCES groups(id),
  user_id   TEXT NOT NULL REFERENCES users(id),
  role      TEXT NOT NULL,           -- owner | member
  joined_at INTEGER NOT NULL,
  deleted_at INTEGER,
  UNIQUE (group_id, user_id)
);

CREATE TABLE IF NOT EXISTS invites (
  id          TEXT PRIMARY KEY,
  group_id    TEXT NOT NULL REFERENCES groups(id),
  token       TEXT NOT NULL UNIQUE,
  created_by  TEXT NOT NULL,
  expire_at   INTEGER,
  revoked_at  INTEGER,
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS tasks (
  id           TEXT PRIMARY KEY,
  group_id     TEXT NOT NULL REFERENCES groups(id),
  title        TEXT NOT NULL,
  description  TEXT NOT NULL DEFAULT '',
  images       TEXT NOT NULL DEFAULT '[]',
  assignee_id  TEXT,
  creator_id   TEXT NOT NULL,
  due_at       INTEGER,
  priority     TEXT NOT NULL DEFAULT 'mid',
  status       TEXT NOT NULL DEFAULT 'todo',
  tags         TEXT NOT NULL DEFAULT '[]',
  version      INTEGER NOT NULL DEFAULT 1,
  completed_at INTEGER,
  started_at   INTEGER,
  deleted_at   INTEGER,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS file_groups (
  id                    TEXT PRIMARY KEY,
  task_id               TEXT NOT NULL REFERENCES tasks(id),
  group_id              TEXT NOT NULL,
  name                  TEXT NOT NULL,
  current_attachment_id TEXT,
  created_at            INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS attachments (
  id            TEXT PRIMARY KEY,
  file_group_id TEXT NOT NULL REFERENCES file_groups(id),
  task_id       TEXT NOT NULL REFERENCES tasks(id),
  uploader_id   TEXT NOT NULL,
  filename      TEXT NOT NULL,
  size          INTEGER NOT NULL,
  mime          TEXT NOT NULL,
  storage_key   TEXT NOT NULL,
  version_no    INTEGER NOT NULL,
  deleted_at    INTEGER,
  created_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS comments (
  id         TEXT PRIMARY KEY,
  task_id    TEXT NOT NULL REFERENCES tasks(id),
  author_id  TEXT NOT NULL,
  content    TEXT NOT NULL,
  mentions   TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL,
  deleted_at INTEGER
);

CREATE TABLE IF NOT EXISTS activities (
  id         TEXT PRIMARY KEY,
  group_id   TEXT NOT NULL,
  task_id    TEXT,
  actor_id   TEXT NOT NULL,
  action     TEXT NOT NULL,
  from_value TEXT,
  to_value   TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS share_links (
  id         TEXT PRIMARY KEY,
  task_id    TEXT NOT NULL REFERENCES tasks(id),
  token      TEXT NOT NULL UNIQUE,
  expire_at  INTEGER,
  revoked_at INTEGER,
  view_count INTEGER NOT NULL DEFAULT 0,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS notifications (
  id               TEXT PRIMARY KEY,
  user_id          TEXT NOT NULL REFERENCES users(id),
  group_id         TEXT,
  task_id          TEXT,
  type             TEXT NOT NULL,
  payload          TEXT NOT NULL DEFAULT '{}',
  channel          TEXT NOT NULL,
  status           TEXT NOT NULL DEFAULT 'pending',
  reminder_offset  TEXT NOT NULL DEFAULT '',
  sent_at          INTEGER,
  read_at          INTEGER
);

CREATE TABLE IF NOT EXISTS orders (
  id               TEXT PRIMARY KEY,
  group_id         TEXT NOT NULL,
  user_id          TEXT NOT NULL,
  plan             TEXT NOT NULL,
  cycle            TEXT NOT NULL,
  amount           INTEGER NOT NULL,
  status           TEXT NOT NULL DEFAULT 'pending',
  paid_at          INTEGER,
  refunded_at      INTEGER,
  channel_trade_no TEXT,
  created_at       INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS group_flags (
  group_id TEXT PRIMARY KEY,
  data     TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS otp_codes (
  phone       TEXT PRIMARY KEY,
  code        TEXT NOT NULL,
  expire_at   INTEGER NOT NULL,
  attempts    INTEGER NOT NULL DEFAULT 0,
  locked_until INTEGER,
  sent_at     INTEGER NOT NULL,
  send_count  INTEGER NOT NULL DEFAULT 0,
  day_key     TEXT NOT NULL,
  day_count   INTEGER NOT NULL DEFAULT 0
);

-- PRD 9.3 索引
CREATE INDEX IF NOT EXISTS idx_task_group_status_due ON tasks(group_id, status, due_at);
CREATE INDEX IF NOT EXISTS idx_task_assignee_status_due ON tasks(assignee_id, status, due_at);
CREATE INDEX IF NOT EXISTS idx_activity_group_time ON activities(group_id, created_at);
CREATE INDEX IF NOT EXISTS idx_activity_task_time ON activities(task_id, created_at);
CREATE INDEX IF NOT EXISTS idx_attachment_task ON attachments(task_id);
CREATE INDEX IF NOT EXISTS idx_notif_user ON notifications(user_id, sent_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_attachment_version ON attachments(file_group_id, version_no);
-- 提醒幂等：同 (user, task, offset, channel) 只发一次
CREATE UNIQUE INDEX IF NOT EXISTS idx_notif_idem ON notifications(user_id, task_id, reminder_offset, channel);
CREATE UNIQUE INDEX IF NOT EXISTS idx_membership_active ON memberships(group_id, user_id);
