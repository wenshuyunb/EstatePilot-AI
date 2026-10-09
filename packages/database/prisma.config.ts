import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { defineConfig } from 'prisma/config';

/**
 * Prisma 7 配置。
 *
 * 与 Prisma 6 的差异（见 DEVELOPMENT_ENVIRONMENT.md 15.7）：
 * - 配置从 schema.prisma 移到这里（datasource.url 已不允许写在 schema 中）
 * - .env 不会自动加载，必须显式加载
 * - migrate dev --name 已移除，改用 migrate diff + migrate deploy
 *
 * 本仓库把 .env 统一放在仓库根目录（monorepo 单一配置源），
 * 因此这里显式指定路径，而不是依赖当前工作目录。
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');

// 优先加载仓库根目录的 .env
dotenv.config({ path: path.join(repoRoot, '.env'), quiet: true });
// 同时允许包级 .env 覆盖（便于单独调试数据库包）
dotenv.config({ path: path.join(here, '.env'), override: true, quiet: true });

const databaseUrl = process.env.DATABASE_URL ?? '';

if (!databaseUrl) {
  // 明确报错，避免后续出现难以定位的 "Connection url is empty"
  console.error(
    `\n[prisma.config] 未找到 DATABASE_URL。\n` +
      `  期望的 .env 位置: ${path.join(repoRoot, '.env')}\n` +
      `  请先执行:  Copy-Item .env.example .env   (Windows)\n` +
      `             cp .env.example .env          (Linux/macOS)\n`,
  );
}

/**
 * Shadow database URL。
 *
 * 为什么需要：`prisma migrate diff --from-migrations` 需要一个**可自由读写**的
 * 临时数据库来重放迁移历史，从而判断 schema 与迁移是否一致（检测迁移漂移）。
 * 它不能直接用业务库，因为重放过程会改结构。
 *
 * 这里指向同一 PostgreSQL 实例上的另一个库（Prisma 会自动创建/清空它）。
 * 若配置了 SHADOW_DATABASE_URL 则优先使用，方便指向独立实例。
 */
const shadowDatabaseUrl =
  process.env.SHADOW_DATABASE_URL ??
  databaseUrl.replace(/\/([^/?]+)(\?|$)/, '/estatepilot_shadow$2');

export default defineConfig({
  schema: path.join(here, 'prisma', 'schema.prisma'),
  migrations: {
    path: path.join(here, 'prisma', 'migrations'),
    seed: 'tsx prisma/seed.ts',
  },
  datasource: {
    url: databaseUrl,
    shadowDatabaseUrl,
  },
});
