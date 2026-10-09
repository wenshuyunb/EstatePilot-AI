/**
 * 检查客户真实需求画像（Phase 12 实测用）。
 *
 * 用法：node --experimental-strip-types scripts/check-requirement.ts -- <customerId>
 */

import { createPrismaClient } from '@estatepilot/database';

async function main(): Promise<void> {
  const customerId = process.argv[2] ?? process.argv[process.argv.length - 1];

  const prisma = createPrismaClient({
    connectionString:
      process.env.DATABASE_URL ??
      'postgresql://estatepilot:estatepilot_dev_pwd@localhost:5432/estatepilot?schema=public',
    applicationName: 'estatepilot-check-requirement',
  });

  try {
    const profile = await prisma.customerRequirementProfile.findFirst({
      where: { customerId },
    });

    if (!profile) {
      console.log('该客户还没有需求画像（尚未粘贴过微信消息）');
      return;
    }

    const wan = (v: number | null): string => (v === null ? '—' : `${v / 10_000}万`);

    console.log('=== 真实需求画像（来自微信消息）===');
    console.log(`  城市:        ${profile.city ?? '—'}`);
    console.log(`  行政区:      ${profile.districts.join('、') || '—'}`);
    console.log(`  板块:        ${profile.subDistricts.join('、') || '—'}`);
    console.log(`  小区:        ${profile.communities.join('、') || '—'}`);
    console.log('');
    console.log(`  理想预算:    ${wan(profile.budgetTarget)}`);
    console.log(`  最高可接受:  ${wan(profile.budgetNormalMax)}`);
    console.log(`  极限预算:    ${wan(profile.budgetStretchMax)}`);
    console.log(`  严格上限:    ${profile.budgetStrictMax ? '是（超出不看）' : '否'}`);
    console.log('');
    console.log(`  户型:        ${profile.bedrooms.join('/') || '—'} 房${profile.bedroomsStrict ? '（硬性）' : ''}`);
    console.log(`  面积:        ${profile.areaMin ?? '—'} ~ ${profile.areaMax ?? '—'} ㎡`);
    console.log(`  房龄偏好:    ${profile.buildingAgePreference ?? '—'}`);
    console.log(`  避免老小区:  ${profile.avoidOldCommunity ? '是' : '否'}`);
    console.log(`  地铁优先级:  ${profile.subwayPriority ?? '—'}`);
    console.log(`  学区:        ${profile.schoolRequired ? '需要' : profile.schoolNotNeeded ? '无所谓' : '—'}`);
    console.log(`  购房目的:    ${profile.purchasePurpose ?? '—'}`);
    console.log(`  家人关注:    ${profile.familyConcerns.join('；') || '—'}`);
    console.log('');
    console.log(`  置信度:      ${(profile.confidence * 100).toFixed(0)}%`);
    console.log(`  来源消息数:  ${profile.sourceMessageCount} 条`);

    // 需求版本历史
    const snapshots = await prisma.customerRequirementSnapshot.findMany({
      where: { customerId },
      orderBy: { version: 'asc' },
      select: { version: true, changedFields: true, createdAt: true },
    });

    console.log('');
    console.log(`=== 需求演进历史（${snapshots.length} 个版本）===`);
    for (const snap of snapshots) {
      console.log(
        `  v${String(snap.version).padStart(2)}  ${snap.createdAt.toISOString().slice(11, 19)}  ` +
          `变更: ${snap.changedFields.join('、') || '(无)'}`,
      );
    }

    // 粘贴的消息
    const messages = await prisma.customerMessageImport.findMany({
      where: { customerId },
      orderBy: { createdAt: 'asc' },
      select: { rawText: true, parseStatus: true, createdAt: true },
    });

    console.log('');
    console.log(`=== 客户消息原文（${messages.length} 条）===`);
    for (const msg of messages) {
      console.log(`  [${msg.parseStatus}] ${msg.rawText.slice(0, 70)}`);
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
