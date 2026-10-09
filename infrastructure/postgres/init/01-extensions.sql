-- ============================================================================
-- EstatePilot AI - PostgreSQL 初始化脚本
-- 仅在数据卷为空、容器首次启动时由 docker-entrypoint-initdb.d 执行。
--
-- 这里的扩展必须存在，Prisma 迁移才能创建 vector 列：
--   语义匹配（pgvector）依赖 vector 类型与 <-> 距离运算符。
-- ============================================================================

-- pgvector：语义相似度检索
CREATE EXTENSION IF NOT EXISTS vector;

-- 模糊匹配小区名（搜索时纠正错别字）
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- 生成随机 UUID（部分种子逻辑使用）
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- 确认结果
DO $$
BEGIN
  RAISE NOTICE 'EstatePilot AI init: vector=%, pg_trgm=%, uuid-ossp=%',
    (SELECT extversion FROM pg_extension WHERE extname = 'vector'),
    (SELECT extversion FROM pg_extension WHERE extname = 'pg_trgm'),
    (SELECT extversion FROM pg_extension WHERE extname = 'uuid-ossp');
END
$$;
