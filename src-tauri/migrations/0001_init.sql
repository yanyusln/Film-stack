-- 影栈 V1 初始 schema（对齐技术方案 §6.1）
-- 由 db.rs::run_migrations 在首次连库时执行（W7-3 后不再依赖 tauri-plugin-sql preload）；必须幂等。

CREATE TABLE IF NOT EXISTS videos (
  id TEXT PRIMARY KEY,
  root_id TEXT NOT NULL,
  path TEXT NOT NULL,
  name TEXT NOT NULL,
  size INTEGER NOT NULL DEFAULT 0,
  mtime INTEGER NOT NULL DEFAULT 0,
  duration REAL,
  width INTEGER,
  height INTEGER,
  media_type TEXT,
  fingerprint TEXT,
  thumbnail_state TEXT NOT NULL DEFAULT 'pending',
  thumbnail_path TEXT,
  last_scanned_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_videos_root_path ON videos (root_id, path);
CREATE INDEX IF NOT EXISTS ix_videos_fingerprint ON videos (fingerprint);
CREATE INDEX IF NOT EXISTS ix_videos_thumb ON videos (thumbnail_state, size);

CREATE TABLE IF NOT EXISTS groups (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  parent_id TEXT,
  sort_order REAL NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
  updated_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
  CONSTRAINT fk_groups_parent FOREIGN KEY (parent_id) REFERENCES groups (id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS ix_groups_parent ON groups (parent_id, sort_order);

CREATE TABLE IF NOT EXISTS group_items (
  group_id TEXT NOT NULL REFERENCES groups (id) ON DELETE CASCADE,
  video_id TEXT NOT NULL REFERENCES videos (id) ON DELETE CASCADE,
  sort_order REAL NOT NULL DEFAULT 0,
  added_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
  PRIMARY KEY (group_id, video_id)
);
CREATE INDEX IF NOT EXISTS ix_group_items_order ON group_items (group_id, sort_order);

CREATE TABLE IF NOT EXISTS play_progress (
  video_id TEXT PRIMARY KEY REFERENCES videos (id) ON DELETE CASCADE,
  position REAL NOT NULL,
  duration REAL NOT NULL,
  updated_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
);
CREATE INDEX IF NOT EXISTS ix_progress_updated ON play_progress (updated_at);

CREATE TABLE IF NOT EXISTS scan_tasks (
  id TEXT PRIMARY KEY,
  root_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  state TEXT NOT NULL,
  total INTEGER NOT NULL DEFAULT 0,
  processed INTEGER NOT NULL DEFAULT 0,
  started_at INTEGER NOT NULL,
  finished_at INTEGER,
  error TEXT
);
CREATE INDEX IF NOT EXISTS ix_scan_tasks_root_state ON scan_tasks (root_id, state);

-- 根目录元数据：仅扫描用户显式选择的目录（技术方案 §8.1）
CREATE TABLE IF NOT EXISTS roots (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  path TEXT NOT NULL UNIQUE,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
);
