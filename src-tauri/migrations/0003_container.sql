-- 影栈 W4 修补：扫描时记录真实容器（container）。
-- 用途：文件叫 .mp4 却是 AVI 这类「看着没问题、内置播放器放不了」的情况，
-- 列表页要能提前标出来，不用点进去播失败才知道（详见技术方案 §8.5 自检）。
-- 由 db.rs::run_migrations 以 pragma 守卫幂等执行（SQLite 不支持 ADD COLUMN IF NOT EXISTS）。
-- 可空：老行的容器未知，等下次扫到时补齐（只读 12 字节，补完不再读）。
ALTER TABLE videos ADD COLUMN container TEXT;
