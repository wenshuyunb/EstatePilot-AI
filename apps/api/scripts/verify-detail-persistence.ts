/**
 * 验证详情持久化链路：写入 → 读回。
 *
 * ============================================================================
 * 为什么单独验证这个
 * ============================================================================
 * 详情是花 API 配额换来的。限流时（恢复需 20+ 分钟）如果详情只存在内存里，
 * 界面就只能显示"暂无详情" —— 那等于配额白花了。
 *
 * 本测试用**手工构造的详情数据**验证存/取链路，
 * 不依赖贝壳接口（限流期间也能跑）。
 *
 * 用法：
 *   node --experimental-strip-types scripts/verify-detail-persistence.ts
 */

import { TenantService } from '../dist/modules/tenant/tenant.service.js';
import { PropertyDetailStore } from '../dist/modules/requirement/property-detail.store.js';
import { createPrismaClient } from '@estatepilot/database';

let passed = 0;
let failed = 0;

function check(name: string, condition: boolean, detail?: string): void {
  if (condition) {
    passed += 1;
    console.log(`  ✓ ${name}`);
  } else {
    failed += 1;
    console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`);
  }
}

async function main(): Promise<void> {
  const connectionString =
    process.env.DATABASE_URL ??
    'postgresql://estatepilot:estatepilot_dev_pwd@localhost:5432/estatepilot?schema=public';

  const prisma = createPrismaClient({ connectionString, applicationName: 'verify-detail-store' });

  const config = {
    env: 'development',
    isDevelopment: true,
    log: { level: 'info' },
    database: { url: connectionString },
  };

  const tenant = new TenantService(config as never);
  await tenant.onModuleInit();

  const store = new PropertyDetailStore(tenant);

  try {
    // ---- 找一套真实房源做测试对象 ----
    const property = await prisma.property.findFirst({
      where: { externalProvider: { not: 'MOCK' } },
      select: { id: true, externalId: true, organizationId: true, city: true, community: true },
    });

    if (!property) {
      console.error('库中没有真实房源，无法测试');
      process.exit(1);
    }

    console.log(`测试房源：${property.community}（${property.externalId}）\n`);

    // ---- 构造一份详情（结构与 BeikeDetailParser 输出一致）----
    const fakeDetail = {
      base: {
        title: '测试房源标题',
        unitPrice: '16,943元/平',
        buildingArea: '105㎡',
        innerArea: null,
        totalPrice: '178万',
        layoutStructure: '平层',
        houseType: '3室2厅',
        houseAge: '未满两年',
        listingStatus: '在售',
        floor: '低楼层',
        totalFloors: '30层',
        hasElevator: '有电梯',
        orientation: '东南 南',
        elevatorHouseholdRatio: '两梯四户',
        buildingType: '板楼',
        usage: '普通住宅',
        downPayment: '首付约48万起',
        ownership: '商品房',
        beikeScore: 6.6,
        tags: ['近地铁', '大阳台'],
      },
      community: {
        name: '测试小区',
        aliases: ['别名一'],
        buildYears: '2003-2011年',
        totalHouseholds: 1892,
        floorAreaRatio: '2.4',
        greeningRate: '40%',
        propertyFee: '0.8-2元/月/㎡',
        propertyCompany: '测试物业',
        parkingRatio: '1:0.8',
        parkingFee: '60',
        fixedParkingSpaces: 512,
        separatedTraffic: '是',
        isClosed: '是',
        rentToSaleRatio: '1.76%',
        rentPrice: '22.64 元/月/㎡',
        waterType: '民水',
        electricityType: '民电',
        heatingType: null,
        gasFee: '3.58元/m³',
        businessDistrict: '杏林桥头',
        district: '集美区',
      },
      nearby: {
        subway: [{ name: '园博苑', distanceMeters: 1127, category: '地铁站' }],
        bus: [{ name: '文滨花园', distanceMeters: 173, category: '公交车站' }],
        school: [{ name: '宁宝小学', distanceMeters: 199, category: '小学' }],
        hospital: [],
        shopping: [],
        park: [],
        other: [],
      },
      images: [
        { url: 'https://example.com/living-room.jpg', roomName: '客厅', kind: 'ROOM' },
        { url: 'https://example.com/floor-plan.png', roomName: null, kind: 'FLOOR_PLAN' },
      ],
      vrUrl: 'lianjiabeike://test',
    };

    // ========================================================================
    console.log('【1】写入详情');
    console.log('='.repeat(70));

    const written = await store.persistMany(property.organizationId, [
      { externalId: property.externalId, detail: fakeDetail as never, source: 'TEST' },
    ]);

    console.log(`  写入 ${written} 条`);
    check('写入成功', written === 1);

    // ========================================================================
    console.log('');
    console.log('【2】读回详情');
    console.log('='.repeat(70));

    const loaded = await store.loadMany(property.organizationId, [property.externalId]);

    check('能读回', loaded.size === 1);

    const entry = loaded.get(property.externalId);
    check('房屋信息完整', entry?.detail.base?.unitPrice === '16,943元/平');
    check('小区信息完整', entry?.detail.community?.floorAreaRatio === '2.4');
    check('周边配套完整', (entry?.detail.nearby?.subway.length ?? 0) === 1);
    check('图片完整', (entry?.detail.images.length ?? 0) === 2);
    check('VR 地址完整', entry?.detail.vrUrl === 'lianjiabeike://test');
    check('记录了获取时间', entry?.detailFetchedAt instanceof Date);

    // 内部元数据不应泄漏给界面
    check(
      '内部 _meta 已剥离（不泄漏给界面）',
      !(entry?.detail as unknown as Record<string, unknown>)['_meta'],
    );

    // ========================================================================
    console.log('');
    console.log('【3】边界情况');
    console.log('='.repeat(70));

    const missing = await store.loadMany(property.organizationId, ['NOT_EXIST_12345']);
    check('不存在的房源返回空（不报错）', missing.size === 0);

    const empty = await store.persistMany(property.organizationId, []);
    check('空输入返回 0（不报错）', empty === 0);

    const noMatch = await store.persistMany(property.organizationId, [
      { externalId: 'NOT_EXIST_12345', detail: fakeDetail as never, source: 'TEST' },
    ]);
    check('房源不在库时跳过（不抛异常）', noMatch === 0);

    // ========================================================================
    console.log('');
    console.log('【4】数据库实际状态');
    console.log('='.repeat(70));

    const raw = await prisma.property.findUnique({
      where: { id: property.id },
      select: { fullDetail: true, detailFetchedAt: true },
    });

    const hasDetail = raw?.fullDetail !== null && raw?.fullDetail !== undefined;
    console.log(`  fullDetail 存在: ${hasDetail ? '是' : '否'}`);
    console.log(`  detailFetchedAt: ${raw?.detailFetchedAt?.toISOString() ?? '(空)'}`);

    check('数据库中有 fullDetail', hasDetail);
    check('数据库中有 detailFetchedAt', raw?.detailFetchedAt !== null);

    // 清理测试数据（避免污染真实房源）
    await prisma.property.update({
      where: { id: property.id },
      data: { fullDetail: null as never, detailFetchedAt: null },
    });
    console.log('  （已清理测试数据）');

    console.log('');
    console.log('─'.repeat(70));
    console.log(`\n通过 ${passed} 项，失败 ${failed} 项\n`);
    console.log('说明：详情持久化后，贝壳限流期间仍能展示小区信息、周边配套与图片');
    console.log('      （来自上次成功获取的数据），界面会标注详情获取时间。\n');

    process.exit(failed > 0 ? 1 : 0);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error('验证异常：', error);
  process.exit(1);
});
