/**
 * 创建一个全新的干净客户（用于真实实测）。
 *
 * 为什么需要：现有客户「唐刚刚」的 Customer 表里还留着**种子脚本写入的字段**
 * （静安区/徐汇区、1219-1286万），与他通过微信消息建立的真实需求画像矛盾。
 * 客户列表页读的是 Customer 表字段，因此会显示过时的信息。
 *
 * 本脚本创建一个"什么都没有"的新客户，经纪人可以从零开始粘贴微信消息，
 * 看到真实的"客户说一句话 → 系统理解 → 推荐房源"流程。
 *
 * 用法：
 *   node --experimental-strip-types scripts/create-test-customer.ts -- --name 王先生
 */

import { createPrismaClient } from '@estatepilot/database';

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  const nameIndex = args.indexOf('--name');
  const name = nameIndex >= 0 ? (args[nameIndex + 1] ?? '王先生') : '王先生';

  const phoneIndex = args.indexOf('--phone');
  const phone = phoneIndex >= 0 ? args[phoneIndex + 1] : '13900000001';

  const prisma = createPrismaClient({
    connectionString:
      process.env.DATABASE_URL ??
      'postgresql://estatepilot:estatepilot_dev_pwd@localhost:5432/estatepilot?schema=public',
    applicationName: 'estatepilot-create-customer',
  });

  try {
    // 归属到演示经纪人（冯峰）名下，否则该经纪人看不到
    const agent = await prisma.user.findFirst({
      where: { email: 'agent111@estatepilot.demo' },
      select: { id: true, organizationId: true, storeId: true, name: true },
    });

    if (!agent) {
      console.error('未找到 agent111@estatepilot.demo，无法确定归属');
      process.exit(1);
    }

    // 幂等：同名同手机号已存在则直接复用
    const existing = await prisma.customer.findFirst({
      where: { organizationId: agent.organizationId, name, phone },
      select: { id: true },
    });

    if (existing) {
      console.log(`客户「${name}」已存在，直接复用：${existing.id}`);
      console.log(`\n打开链接开始实测：`);
      console.log(`  http://localhost:3000/customers/${existing.id}`);
      return;
    }

    const customer = await prisma.customer.create({
      data: {
        organizationId: agent.organizationId,
        storeId: agent.storeId,
        // 注意：字段名是 assignedAgentId（不是 agentId）
        assignedAgentId: agent.id,
        createdById: agent.id,
        name,
        phone,
        // 关键：**不写任何需求字段** —— 让需求完全来自微信消息
        // （这样实测看到的是真实的理解过程，而不是种子数据的回显）
        source: 'WECHAT',
        status: 'NEW',
        // 注意：IntentLevel 枚举值是 A/B/C/D（不是 HOT/COLD 这类语义名）
        intentLevel: 'D',
        intentScore: 0,
      },
      select: { id: true, name: true },
    });

    console.log('✓ 已创建干净客户（无任何预设需求）');
    console.log(`  姓名:   ${customer.name}`);
    console.log(`  手机:   ${phone}`);
    console.log(`  归属:   ${agent.name}（agent111@estatepilot.demo）`);
    console.log(`  ID:     ${customer.id}`);
    console.log('');
    console.log('打开链接开始实测：');
    console.log(`  http://localhost:3000/customers/${customer.id}`);
    console.log('');
    console.log('建议粘贴的客户消息（真实场景）：');
    console.log('  想看浦东南边三房，500万左右，最好离地铁近点');
    console.log('  张江那边更好，550也可以，但别太老的小区');
    console.log('  我老婆比较在意小区环境');
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
