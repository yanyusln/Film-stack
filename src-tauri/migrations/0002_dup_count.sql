-- 影栈 W2-4 重复识别：追加 dup_count 列。
-- 由 db.rs::run_migrations 以 pragma 守卫幂等执行（SQLite 不支持 ADD COLUMN IF NOT EXISTS）。
ALTER TABLE videos ADD COLUMN dup_count INTEGER NOT NULL DEFAULT 1;
CREATE INDEX IF NOT EXISTS ix_videos_dup ON videos (dup_count);
