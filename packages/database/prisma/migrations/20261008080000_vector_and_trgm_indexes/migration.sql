-- ============================================================================
-- 向量检索与模糊搜索索引
-- ============================================================================
--
-- 为什么手写这个迁移：
--   Prisma schema 无法声明 pgvector 的 HNSW / IVFFlat 索引，也无法声明
--   pg_trgm 的 GIN 索引。因此用 SQL 迁移补齐，Prisma 会正常记录该迁移。
--
-- 为什么选 HNSW 而不是 IVFFlat：
--   HNSW 无需预先训练、增量插入性能好、召回率高，适合客户行为画像这类
--   持续增量写入的场景。代价是索引更大、构建更慢，对 1000～10 万级房源可接受。
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 房源语义向量索引：用于「按客户偏好找相似房源」
-- 使用余弦距离（vector_cosine_ops），与 Embedding 的语义相似度定义一致。
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS "properties_embedding_hnsw_idx"
  ON "properties"
  USING hnsw ("embedding" vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);

-- ---------------------------------------------------------------------------
-- 客户行为画像向量索引：用于「按房源找相似客户」（反向匹配）
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS "customer_behavior_profiles_embedding_hnsw_idx"
  ON "customer_behavior_profiles"
  USING hnsw ("embedding" vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);

-- ---------------------------------------------------------------------------
-- 小区名模糊搜索：解决跨数据源小区名不一致（「金桥花园」vs「金桥花园(一期)」）
-- pg_trgm 的 GIN 索引支持 % 相似度运算符与 ILIKE 加速。
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS "properties_community_normalized_trgm_idx"
  ON "properties"
  USING gin ("communityNormalized" gin_trgm_ops);

CREATE INDEX IF NOT EXISTS "properties_title_trgm_idx"
  ON "properties"
  USING gin ("title" gin_trgm_ops);

-- ---------------------------------------------------------------------------
-- 客户姓名模糊搜索（后台全局搜索用）
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS "customers_name_trgm_idx"
  ON "customers"
  USING gin ("name" gin_trgm_ops);
