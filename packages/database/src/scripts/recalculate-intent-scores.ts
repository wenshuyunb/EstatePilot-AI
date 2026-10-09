/**
 * 成交概率重算脚本。
 *
 * 用途：
 *   1. seed 之后回填所有客户的 intentScore（否则首页与列表页的意向分都是 0）
 *   2. 定时任务调用（本应由 BullMQ 触发，在队列 Worker 实现前用脚本代替）
 *   3. 数据修复：怀疑分数不准时全量重算
 *
 * 用法：
 *   pnpm --filter @estatepilot/database recalc-intent
 *   pnpm --filter @estatepilot/database recalc-intent -- --org=<organizationId>
 */

import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import dotenv from 'dotenv';

const here = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(here, '..', '..');
const repoRoot = path.resolve(packageRoot, '..', '..');

dotenv.config({ path: path.join(repoRoot, '.env'), quiet: true });

const { createPrismaClient } = await import('../client.js');

/** 动态引入 API 侧的服务，保证与线上计算逻辑完全一致（不做第二份实现） */
const intentScoreModuleUrl = pathToFileURL(
  path.join(repoRoot, 'apps/api/src/modules/customer/intent-score-service.ts'),
).href;
const tenantModuleUrl = pathToFileURL(
  path.join(repoRoot, 'apps/api/src/modules/tenant/tenant.service.ts'),
).href;
const configModuleUrl = pathToFileURL(
  path.join(repoRoot, 'apps/api/src/config/configuration.ts'),
).href;

const { IntentScoreService } = (await import(intentScoreModuleUrl)) as {
  IntentScoreService: new (tenant: unknown) => {
    recalculate: (
      organizationId: string,
      options?: { customerIds?: string[]; onlyActive?: boolean },
    ) => Promise<{
      customersProcessed: number;
      updated: number;
      levelDistribution: Record<string, number>;
      averageScore: number;
      durationMs: number;
    }>;
  };
};

const { createTenantScope } = await import(
  pathToFileURL(path.join(repoRoot, 'packages/database/src/tenant-scope.ts')).href
);
void tenantModuleUrl;
void configModuleUrl;

const prisma = createPrismaClient({
  connectionString: process.env.DATABASE_URL as string,
  applicationName: 'estatepilot-recalc-intent',
});

/**
 * 最小实现的 TenantService 替身。
 *
 * 为什么不用真实的 TenantService：它依赖 NestJS 的 DI 容器与请求上下文，
 * 而脚本环境没有这些。这里只实现 IntentScoreService 用到的 scopeFor 方法，
 * 保证计算逻辑复用、基础设施适配脚本环境。
 */
const tenantDouble = {
  scopeFor: (organizationId: string) => createTenantScope(prisma, { organizationId }),
  forSystem: () => prisma,
};

async function main(): Promise<void> {
  const orgArg = process.argv.find((arg) => arg.startsWith('--org='))?.split('=')[1];

  console.log('\n=== 成交概率（AI 辅助判断）重算 ===\n');

  // 确定要处理的组织
  const organizations = orgArg
    ? await prisma.organization.findMany({
        where: { id: orgArg },
        select: { id: true, name: true, shortName: true },
      })
    : await prisma.organization.findMany({
        where: { isActive: true },
        select: { id: true, name: true, shortName: true },
        orderBy: { createdAt: 'asc' },
      });

  if (organizations.length === 0) {
    console.error('未找到组织。请先执行种子脚本：pnpm db:seed');
    process.exit(1);
  }

  const service = new IntentScoreService(tenantDouble);

  let totalProcessed = 0;
  let totalUpdated = 0;
  const globalDistribution: Record<string, number> = { HOT: 0, WARM: 0, COOL: 0, COLD: 0 };

  for (const organization of organizations) {
    const label = organization.shortName ?? organization.name;
    process.stdout.write(`处理 ${label} … `);

    const summary = await service.recalculate(organization.id, { onlyActive: false });

    totalProcessed += summary.customersProcessed;
    totalUpdated += summary.updated;
    for (const [level, count] of Object.entries(summary.levelDistribution)) {
      globalDistribution[level] = (globalDistribution[level] ?? 0) + count;
    }

    console.log(
      `${summary.updated}/${summary.customersProcessed} 位客户，平均分 ${summary.averageScore}，耗时 ${summary.durationMs}ms`,
    );
  }

  // ---- 结果核对：确认数据库里真的写进去了 ----
  const verification = await prisma.customer.groupBy({
    by: ['intentScoreLevel'],
    _count: { _all: true },
    _avg: { intentScore: true },
  });

  console.log('\n=== 数据库核对 ===');
  console.log(`  客户总数：      ${await prisma.customer.count({ where: { deletedAt: null } })}`);
  console.log(`  已算出分数：    ${await prisma.customer.count({ where: { intentScore: { not: null } } })}`);
  console.log('  等级分布：');
  for (const row of verification) {
    console.log(
      `    ${row.intentScoreLevel ?? '(未评分)'}: ${row._count._all} 位，` +
        `平均 ${row._avg.intentScore !== null ? Math.round(row._avg.intentScore) : '-'} 分`,
    );
  }

  console.log(
    `\n完成：共处理 ${totalProcessed} 位客户，更新 ${totalUpdated} 位。` +
      `\n注意：该分数为 AI 辅助判断，仅供参考，不构成成交承诺。\n`,
  );

  await prisma.$disconnect();
}

main().catch(async (error) => {
  console.error('\n重算失败：', error);
  await prisma.$disconnect().catch(() => undefined);
  process.exit(1);
});
