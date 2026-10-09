/**
 * 数据库连通性与多租户隔离冒烟测试。
 *
 * 这是一个可重复执行的真实数据库测试（不使用 mock）：
 *   1. 用驱动适配器连接 PostgreSQL
 *   2. 建立两个组织，验证 TenantScope 不会跨租户读取
 *   3. 验证 create 会自动注入 organizationId 且不可被伪造覆盖
 *   4. 验证跨租户 ID 访问会抛 TenantMismatchError
 *   5. 验证 pgvector 可写入与检索
 *   6. 清理测试数据
 *
 * 用法：
 *   pnpm --filter @estatepilot/database exec tsx src/scripts/smoke-test.ts
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..', '..', '..');
dotenv.config({ path: path.join(repoRoot, '.env'), quiet: true });

const { createPrismaClient } = await import('../client.js');
const { createTenantScope, TenantMismatchError } = await import('../tenant-scope.js');

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error('DATABASE_URL 未设置');
  process.exit(1);
}

const prisma = createPrismaClient({ connectionString, applicationName: 'estatepilot-smoke' });

let passed = 0;
let failed = 0;

function check(name: string, condition: boolean, detail?: string): void {
  if (condition) {
    passed += 1;
    console.log(`  ✅ ${name}`);
  } else {
    failed += 1;
    console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

async function main(): Promise<void> {
  console.log('\n=== EstatePilot AI 数据库连通性 + 多租户隔离测试 ===\n');

  // -------------------------------------------------------------------------
  console.log('[1] 基础连通性');
  const version = await prisma.$queryRaw<Array<{ version: string }>>`SELECT version() AS version`;
  check('可以连接 PostgreSQL', version.length === 1, JSON.stringify(version));
  check('版本为 PostgreSQL 18', version[0]?.version.includes('PostgreSQL 18') ?? false, version[0]?.version);

  const extRows = await prisma.$queryRaw<Array<{ extname: string; extversion: string }>>`
    SELECT extname, extversion FROM pg_extension WHERE extname IN ('vector', 'pg_trgm')
  `;
  check('pgvector 与 pg_trgm 扩展已启用', extRows.length === 2, JSON.stringify(extRows));

  // -------------------------------------------------------------------------
  console.log('\n[2] 准备两个组织的测试数据');
  const suffix = Date.now().toString(36);
  const orgA = await prisma.organization.create({
    data: { name: `冒烟测试公司A_${suffix}`, shortName: 'A司', city: '上海' },
  });
  const orgB = await prisma.organization.create({
    data: { name: `冒烟测试公司B_${suffix}`, shortName: 'B司', city: '上海' },
  });
  check('创建组织 A 与 B', Boolean(orgA.id && orgB.id));

  const scopeA = createTenantScope(prisma, { organizationId: orgA.id });
  const scopeB = createTenantScope(prisma, { organizationId: orgB.id });

  const storeA = await scopeA.create<{ id: string; organizationId: string }>('Store', {
    data: { name: `A门店_${suffix}`, city: '上海', district: '浦东' },
  });
  check('通过作用域创建门店时自动注入 organizationId', storeA.organizationId === orgA.id);

  // -------------------------------------------------------------------------
  console.log('\n[3] 伪造 organizationId 必须被忽略');
  const forged = await scopeA.create<{ id: string; organizationId: string }>('Store', {
    data: {
      name: `A伪造门店_${suffix}`,
      city: '上海',
      // 恶意传入 B 的组织 ID
      organizationId: orgB.id,
    },
  });
  check(
    '写入时伪造的 organizationId 被覆盖为当前租户',
    forged.organizationId === orgA.id,
    `期望 ${orgA.id}，实际 ${forged.organizationId}`,
  );

  // -------------------------------------------------------------------------
  console.log('\n[4] 读取隔离：A 看不到 B 的门店');
  const storesA = await scopeA.findMany<{ id: string; name: string }>('Store', {
    where: { name: { contains: suffix } },
  });
  const storesB = await scopeB.findMany<{ id: string; name: string }>('Store', {
    where: { name: { contains: suffix } },
  });
  check('A 查到自己创建的 2 个门店', storesA.length === 2, `实际 ${storesA.length}`);
  check('B 查不到 A 的门店', storesB.length === 0, `实际 ${storesB.length}`);

  const countA = await scopeA.count('Store', { name: { contains: suffix } });
  const countB = await scopeB.count('Store', { name: { contains: suffix } });
  check('count 也受租户隔离', countA === 2 && countB === 0, `A=${countA} B=${countB}`);

  // -------------------------------------------------------------------------
  console.log('\n[5] 用 B 的作用域按 ID 读取 A 的记录必须抛错');
  // 先确认记录确实存在于 A
  const existsInA = await scopeA.findFirst('Store', { where: { id: storeA.id } });
  check('A 能按 ID 读到自己门店', existsInA !== null);

  let threw = false;
  let thrownName = '';
  try {
    await scopeB.findByIdOrThrow('Store', storeA.id);
  } catch (error) {
    threw = true;
    thrownName = error instanceof Error ? error.name : 'unknown';
  }
  check('B 按 ID 读取 A 的门店抛出 TenantMismatchError', threw && thrownName === 'TenantMismatchError', thrownName);

  // -------------------------------------------------------------------------
  console.log('\n[6] 更新隔离：B 无法更新 A 的记录');
  let updateThrew = false;
  try {
    await scopeB.update('Store', { where: { id: storeA.id }, data: { name: '被篡改' } });
  } catch (error) {
    updateThrew = error instanceof TenantMismatchError;
  }
  check('B 更新 A 的门店被拒绝', updateThrew);

  const stillOriginal = await scopeA.findFirst<{ name: string }>('Store', { where: { id: storeA.id } });
  check('A 的门店名未被篡改', stillOriginal?.name === `A门店_${suffix}`, stillOriginal?.name);

  // -------------------------------------------------------------------------
  console.log('\n[7] 更新时不可篡改 organizationId');
  const updated = await scopeA.update<{ organizationId: string }>('Store', {
    where: { id: storeA.id },
    data: { district: '徐汇', organizationId: orgB.id },
  });
  check('更新时伪造的 organizationId 被忽略', updated.organizationId === orgA.id);

  // -------------------------------------------------------------------------
  console.log('\n[8] 未登记的模型必须被拒绝（防止漏加租户过滤）');
  let unsupportedThrew = false;
  try {
    await scopeA.findMany('FeatureFlag');
  } catch (error) {
    unsupportedThrew = error instanceof Error && error.name === 'TenantScopeUnsupportedError';
  }
  check('对无 organizationId 的模型调用作用域会报错', unsupportedThrew);

  // -------------------------------------------------------------------------
  console.log('\n[9] 客户创建与 pgvector 向量读写');
  const customer = await scopeA.create<{ id: string; organizationId: string; name: string }>('Customer', {
    data: {
      name: '冒烟客户',
      phone: '13800000000',
      preferredCity: '上海',
      preferredDistricts: ['浦东'],
      bedrooms: [3],
    },
  });
  check('创建客户成功且归属正确', customer.organizationId === orgA.id);

  const vectorLiteral = `[${Array.from({ length: 1536 }, (_, i) => ((i % 10) / 10).toFixed(3)).join(',')}]`;

  // 说明：CustomerBehavioralProfile 通过 customerId 与 Customer 关联，
  // 本身没有 organizationId 字段，因此不在 TENANT_SCOPED_MODELS 白名单内。
  // 它的租户隔离由父表 Customer 保证 —— 必须先通过作用域确认客户归属，
  // 再直连写入画像，这正是下面两步的顺序。
  const profile = await prisma.customerBehavioralProfile.create({
    data: {
      customerId: customer.id,
      profile: {},
      confidence: 0.5,
      sampleSize: 10,
    },
  });
  check('通过父表租户校验后创建行为画像成功', Boolean(profile.id));

  await prisma.$executeRawUnsafe(
    `UPDATE customer_behavior_profiles SET embedding = $1::vector WHERE id = $2`,
    vectorLiteral,
    profile.id,
  );

  const vectorRead = await prisma.$queryRawUnsafe<Array<{ distance: number }>>(
    `SELECT embedding <=> $1::vector AS distance
       FROM customer_behavior_profiles
      WHERE id = $2`,
    vectorLiteral,
    profile.id,
  );
  check(
    'pgvector 余弦距离可查询且自身距离为 0',
    vectorRead.length === 1 && Math.abs(vectorRead[0]!.distance) < 1e-6,
    JSON.stringify(vectorRead),
  );

  // -------------------------------------------------------------------------
  console.log('\n[10] 级联删除与清理');
  const deletedCount = await scopeA.deleteMany('Store', { name: { contains: suffix } });
  check('批量删除只影响本租户', deletedCount === 2, `实际删除 ${deletedCount}`);

  // 删除组织会级联删除其下所有数据
  await prisma.organization.deleteMany({ where: { id: { in: [orgA.id, orgB.id] } } });

  const leftoverCustomers = await prisma.customer.count({ where: { organizationId: orgA.id } });
  const leftoverStores = await prisma.store.count({ where: { organizationId: { in: [orgA.id, orgB.id] } } });
  check('删除组织后客户被级联清理', leftoverCustomers === 0, `残留 ${leftoverCustomers}`);
  check('删除组织后门店被级联清理', leftoverStores === 0, `残留 ${leftoverStores}`);

  // -------------------------------------------------------------------------
  console.log(`\n=== 结果: ${passed} 通过 / ${failed} 失败 ===\n`);
  await prisma.$disconnect();

  if (failed > 0) process.exit(1);
}

main().catch(async (error) => {
  console.error('\n冒烟测试异常终止:', error);
  await prisma.$disconnect().catch(() => undefined);
  process.exit(1);
});
