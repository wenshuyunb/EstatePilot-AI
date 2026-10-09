/**
 * 种子数据脚本。
 *
 * 目标：`pnpm db:seed` 之后系统立刻呈现一个**真实可用的完整场景** ——
 * 有客户、有房源、有真实浏览行为、有画像、有匹配、有机会、有带看。
 * 而不是一堆空表。
 *
 * 数据量（可通过 --profile 调整）：
 *   small  —— 快速验证（约 1 分钟）：2 组织 / 4 门店 / 12 人 / 60 客户 / 220 房源
 *   demo   —— 默认演示（约 3 分钟）：2 组织 / 4 门店 / 22 人 / 300 客户 / 1100 房源
 *   full   —— 完整压力（约 8 分钟）：在 demo 基础上把行为事件提到 12000+
 *
 * 设计原则：
 *   1. 全部使用**可复现的种子随机数** —— 每次 seed 得到同样的数据，便于测试断言。
 *   2. 数据之间存在**真实的业务关联**：行为事件指向真实房源，匹配分数由真实画像算出。
 *   3. 不做「看起来像但经不起点开」的假数据 —— 每个客户点进去都有完整的浏览轨迹。
 *   4. 所有房源明确标注 Demo Data，不暗示来自任何真实平台。
 */

import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import dotenv from 'dotenv';
import {
  BehaviorEventType,
  CustomerSource,
  CustomerStatus,
  DecorationPreference,
  DeviceType,
  Gender,
  IntentLevel,
  ListingStatus,
  LoanStatus,
  PaymentMethod,
  PropertyAgePreference,
  PropertyProviderKind,
  PurchasePurpose,
  PurchaseTimeline,
  ScoringConditionKind,
  UserRole,
  UserStatus,
  DEFAULT_BEHAVIOR_SCORES,
  PlanTier,
  SubscriptionStatus,
  type BehaviorEventType as BehaviorEventTypeType,
} from '@estatepilot/types';
import {
  buildWindowKey,
  createSeededRandom,
  pickOne,
  pickWeighted,
  randomFloat,
  randomInt,
  randomString,
} from '@estatepilot/utils';

const here = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(here, '..');
const repoRoot = path.resolve(packageRoot, '..', '..');

dotenv.config({ path: path.join(repoRoot, '.env'), quiet: true });

// 用动态导入的原因：这两个模块依赖 .env 已加载（Prisma 客户端需要 DATABASE_URL，
// PasswordService 会读配置），静态导入会在 dotenv 之前执行。
const { createPrismaClient } = await import('../src/client.js');
// 密码哈希逻辑直接复用 API 的实现，避免两处算法不一致导致演示账号登录不上。
// Windows 下动态 import 必须用 file:// URL，不能直接传盘符路径。
const { PasswordService } = await import(
  pathToFileURL(path.join(repoRoot, 'apps/api/src/modules/auth/password.service.ts')).href
);

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error('DATABASE_URL 未设置，请先复制 .env.example 为 .env');
  process.exit(1);
}

type Profile = 'small' | 'demo' | 'full';

interface ProfileSizes {
  organizations: number;
  storesPerOrg: number;
  agentsPerStore: number;
  customersPerOrg: number;
  propertiesPerCommunity: number;
  behaviorEventsPerCustomer: [number, number];
  viewingsPerOrg: number;
}

const PROFILES: Record<Profile, ProfileSizes> = {
  small: {
    organizations: 2,
    storesPerOrg: 2,
    agentsPerStore: 3,
    customersPerOrg: 30,
    propertiesPerCommunity: 12,
    behaviorEventsPerCustomer: [8, 25],
    viewingsPerOrg: 8,
  },
  demo: {
    organizations: 2,
    storesPerOrg: 2,
    agentsPerStore: 5,
    customersPerOrg: 150,
    propertiesPerCommunity: 55,
    behaviorEventsPerCustomer: [12, 45],
    viewingsPerOrg: 30,
  },
  full: {
    organizations: 2,
    storesPerOrg: 2,
    agentsPerStore: 5,
    customersPerOrg: 150,
    propertiesPerCommunity: 55,
    behaviorEventsPerCustomer: [25, 90],
    viewingsPerOrg: 40,
  },
};

// ---------------------------------------------------------------------------
// 中文姓名与公司名生成
// ---------------------------------------------------------------------------

const SURNAMES = [
  '王', '李', '张', '刘', '陈', '杨', '赵', '黄', '周', '吴',
  '徐', '孙', '马', '朱', '胡', '郭', '何', '高', '林', '罗',
  '郑', '梁', '谢', '宋', '唐', '许', '韩', '冯', '邓', '曹',
];

const GIVEN_NAMES_MALE = [
  '伟', '强', '磊', '洋', '勇', '军', '杰', '涛', '明', '超',
  '刚', '平', '辉', '健', '鹏', '斌', '波', '峰', '亮', '宇',
];

const GIVEN_NAMES_FEMALE = [
  '芳', '娜', '敏', '静', '丽', '娟', '燕', '艳', '霞', '玲',
  '婷', '雪', '倩', '颖', '琳', '晶', '梅', '萍', '红', '云',
];

const COMPANY_NAMES = [
  { name: '上海安家房地产经纪有限公司', shortName: '安家地产', brand: '安家' },
  { name: '沪上优居房产服务有限公司', shortName: '优居房产', brand: '优居' },
];

const STORE_NAMES = [
  { name: '浦东张江门店', district: '浦东新区', subDistrict: '张江' },
  { name: '徐汇徐家汇门店', district: '徐汇区', subDistrict: '徐家汇' },
  { name: '闵行莘庄门店', district: '闵行区', subDistrict: '莘庄' },
  { name: '静安大宁门店', district: '静安区', subDistrict: '大宁' },
];

/** 客户来源权重 */
const SOURCE_WEIGHTS: Array<{ source: CustomerSource; weight: number }> = [
  { source: CustomerSource.ONLINE_PLATFORM, weight: 30 },
  { source: CustomerSource.WALK_IN, weight: 15 },
  { source: CustomerSource.REFERRAL, weight: 20 },
  { source: CustomerSource.PHONE_IN, weight: 10 },
  { source: CustomerSource.WECHAT, weight: 15 },
  { source: CustomerSource.OLD_CUSTOMER, weight: 5 },
  { source: CustomerSource.ADVERTISEMENT, weight: 5 },
];

/** 客户状态权重（让数据分布接近真实门店） */
const STATUS_WEIGHTS: Array<{ status: CustomerStatus; weight: number }> = [
  { status: CustomerStatus.NEW, weight: 15 },
  { status: CustomerStatus.FOLLOWING, weight: 35 },
  { status: CustomerStatus.HIGH_INTENT, weight: 18 },
  { status: CustomerStatus.VIEWING, weight: 12 },
  { status: CustomerStatus.NEGOTIATING, weight: 6 },
  { status: CustomerStatus.DEAL, weight: 3 },
  { status: CustomerStatus.DORMANT, weight: 8 },
  { status: CustomerStatus.LOST, weight: 3 },
];

/** 行为事件权重 —— 高频事件权重高，转化事件权重低（符合真实漏斗） */
const BEHAVIOR_WEIGHTS: Array<{ type: BehaviorEventTypeType; weight: number }> = [
  { type: BehaviorEventType.PAGE_VIEW, weight: 12 },
  { type: BehaviorEventType.PROPERTY_VIEW, weight: 30 },
  { type: BehaviorEventType.PROPERTY_REVISIT, weight: 6 },
  { type: BehaviorEventType.IMAGE_VIEW, weight: 18 },
  { type: BehaviorEventType.IMAGE_GALLERY_COMPLETE, weight: 4 },
  { type: BehaviorEventType.FLOOR_PLAN_VIEW, weight: 6 },
  { type: BehaviorEventType.MAP_VIEW, weight: 5 },
  { type: BehaviorEventType.COMMUNITY_VIEW, weight: 5 },
  { type: BehaviorEventType.PRICE_HISTORY_VIEW, weight: 3 },
  { type: BehaviorEventType.SCHOOL_VIEW, weight: 3 },
  { type: BehaviorEventType.SUBWAY_VIEW, weight: 3 },
  { type: BehaviorEventType.COMMUTE_VIEW, weight: 2 },
  { type: BehaviorEventType.PROPERTY_FAVORITE, weight: 4 },
  { type: BehaviorEventType.PROPERTY_COMPARE, weight: 2 },
  { type: BehaviorEventType.PROPERTY_SHARE, weight: 1 },
  { type: BehaviorEventType.CONTACT_AGENT, weight: 1 },
  { type: BehaviorEventType.BOOK_VIEWING, weight: 1 },
  { type: BehaviorEventType.SEARCH, weight: 4 },
  { type: BehaviorEventType.FILTER_CHANGE, weight: 3 },
  { type: BehaviorEventType.PROPERTY_SKIP, weight: 5 },
];

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

function log(message: string): void {
  const timestamp = new Date().toISOString().slice(11, 19);
  process.stdout.write(`[${timestamp}] ${message}\n`);
}

/** 上海手机号段 */
const PHONE_PREFIXES = ['138', '139', '136', '137', '135', '150', '151', '158', '159', '186', '188', '177'];

function generatePhone(random: () => number): string {
  const prefix = pickOne(PHONE_PREFIXES, random);
  let suffix = '';
  for (let i = 0; i < 8; i += 1) suffix += randomInt(0, 9, random);
  return `${prefix}${suffix}`;
}

interface PersonName {
  name: string;
  gender: Gender;
}

function generateName(random: () => number, gender?: Gender): PersonName {
  const surname = pickOne(SURNAMES, random);
  const actualGender =
    gender ?? (random() < 0.52 ? Gender.MALE : Gender.FEMALE);
  const pool = actualGender === Gender.MALE ? GIVEN_NAMES_MALE : GIVEN_NAMES_FEMALE;
  const given = pickOne(pool, random);
  // 30% 概率是双字名
  const name = random() < 0.3 ? `${surname}${given}${pickOne(pool, random)}` : `${surname}${given}`;
  return { name, gender: actualGender };
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const profileArg = process.argv.find((arg) => arg.startsWith('--profile='))?.split('=')[1];
  const profile = (profileArg ?? 'small') as Profile;
  const sizes = PROFILES[profile] ?? PROFILES.small;

  log(`=== EstatePilot AI 种子数据生成（profile=${profile}）===`);

  const prisma = createPrismaClient({
    connectionString: connectionString as string,
    applicationName: 'estatepilot-seed',
  });
  const passwords = new PasswordService();
  const random = createSeededRandom(20_261_008);

  try {
    // ---- 清理已有种子数据（按组织名识别，避免误删真实数据）----
    log('清理旧的演示数据…');
    const existingOrgs = await prisma.organization.findMany({
      where: { name: { in: COMPANY_NAMES.map((c) => c.name) } },
      select: { id: true },
    });
    if (existingOrgs.length > 0) {
      const orgIds = existingOrgs.map((org) => org.id);
      // 组织删除会级联清理其下所有数据
      await prisma.organization.deleteMany({ where: { id: { in: orgIds } } });
      log(`已清理 ${existingOrgs.length} 个旧演示组织及其全部关联数据`);
    }

    // ---- 平台级行为评分规则（organizationId 为空的全局默认规则）----
    log('写入行为评分规则…');
    const scoringRuleCount = await seedScoringRules(prisma);

    // ---- 演示账号密码（统一，便于登录演示）----
    const demoPassword = 'EstatePilot2026!';
    const passwordHash = (await passwords.hash(demoPassword)).hash;

    // ---- 生成组织 ----
    const organizations: Array<{
      id: string;
      name: string;
      storeIds: string[];
      agentIds: string[];
      managerId: string;
    }> = [];

    for (let orgIndex = 0; orgIndex < sizes.organizations; orgIndex += 1) {
      const company = COMPANY_NAMES[orgIndex] ?? COMPANY_NAMES[0]!;
      log(`创建组织：${company.shortName}`);

      const organization = await prisma.organization.create({
        data: {
          name: company.name,
          shortName: company.shortName,
          brandName: company.brand,
          city: '上海',
          contactName: generateName(random).name,
          contactPhone: generatePhone(random),
          settings: {
            timezone: 'Asia/Shanghai',
            demoData: true,
            notice: '本组织数据由种子脚本生成，仅用于产品演示',
          },
        },
      });

      // 订阅（商业化预留：给第一家公司 STORE 套餐，第二家 FREE，便于对比）
      const planTier = orgIndex === 0 ? PlanTier.STORE : PlanTier.FREE;
      await prisma.subscription.create({
        data: {
          organizationId: organization.id,
          plan: planTier,
          status: SubscriptionStatus.ACTIVE,
          seatLimit: planTier === PlanTier.STORE ? 50 : 3,
          customerLimit: planTier === PlanTier.STORE ? 20000 : 200,
          aiUsageLimit: planTier === PlanTier.STORE ? 20000 : 200,
          storeLimit: planTier === PlanTier.STORE ? 10 : 1,
          periodEnd: new Date(Date.now() + 30 * 86_400_000),
        },
      });

      // ---- 门店 ----
      const storeIds: string[] = [];
      for (let storeIndex = 0; storeIndex < sizes.storesPerOrg; storeIndex += 1) {
        const storeSeed = STORE_NAMES[(orgIndex * sizes.storesPerOrg + storeIndex) % STORE_NAMES.length]!;
        const store = await prisma.store.create({
          data: {
            organizationId: organization.id,
            name: storeSeed.name,
            code: `${company.brand}-${String(storeIndex + 1).padStart(2, '0')}`,
            city: '上海',
            district: storeSeed.district,
            address: `上海市${storeSeed.district}${storeSeed.subDistrict}路${randomInt(100, 999, random)}号`,
            phone: generatePhone(random),
            longitude: Number(randomFloat(121.4, 121.6, random, 6)),
            latitude: Number(randomFloat(31.1, 31.3, random, 6)),
          },
        });
        storeIds.push(store.id);
      }

      // ---- 用户（公司负责人 + 店长 + 经纪人）----
      const agentIds: string[] = [];
      let managerId = '';

      // 公司负责人
      const ownerName = generateName(random);
      const owner = await prisma.user.create({
        data: {
          organizationId: organization.id,
          storeId: storeIds[0] ?? null,
          email: `owner${orgIndex + 1}@estatepilot.demo`,
          phone: generatePhone(random),
          passwordHash,
          name: ownerName.name,
          role: UserRole.OWNER,
          status: UserStatus.ACTIVE,
          employeeNo: `OWN${String(orgIndex + 1).padStart(3, '0')}`,
          specialties: ['全区域'],
        },
      });
      agentIds.push(owner.id);

      for (let storeIndex = 0; storeIndex < storeIds.length; storeIndex += 1) {
        const storeId = storeIds[storeIndex]!;
        const storeSeed = STORE_NAMES[(orgIndex * sizes.storesPerOrg + storeIndex) % STORE_NAMES.length]!;

        // 店长
        const managerName = generateName(random);
        const manager = await prisma.user.create({
          data: {
            organizationId: organization.id,
            storeId,
            email: `manager${orgIndex + 1}${storeIndex + 1}@estatepilot.demo`,
            phone: generatePhone(random),
            passwordHash,
            name: managerName.name,
            role: UserRole.STORE_MANAGER,
            status: UserStatus.ACTIVE,
            employeeNo: `MGR${orgIndex + 1}${String(storeIndex + 1).padStart(2, '0')}`,
            specialties: [storeSeed.district],
            monthlyDealTarget: randomInt(4, 10, random),
          },
        });
        agentIds.push(manager.id);
        if (storeIndex === 0) managerId = manager.id;

        // 回填门店负责人
        await prisma.store.update({ where: { id: storeId }, data: { managerId: manager.id } });

        // 团队
        const team = await prisma.team.create({
          data: {
            organizationId: organization.id,
            storeId,
            name: `${storeSeed.subDistrict}一组`,
            description: `负责${storeSeed.district}${storeSeed.subDistrict}板块`,
            leaderId: manager.id,
          },
        });

        // 经纪人
        for (let agentIndex = 0; agentIndex < sizes.agentsPerStore; agentIndex += 1) {
          const agentName = generateName(random);
          const agent = await prisma.user.create({
            data: {
              organizationId: organization.id,
              storeId,
              teamId: team.id,
              email: `agent${orgIndex + 1}${storeIndex + 1}${agentIndex + 1}@estatepilot.demo`,
              phone: generatePhone(random),
              passwordHash,
              name: agentName.name,
              role: UserRole.AGENT,
              status: UserStatus.ACTIVE,
              employeeNo: `AG${orgIndex + 1}${storeIndex + 1}${String(agentIndex + 1).padStart(2, '0')}`,
              specialties: [storeSeed.district],
              monthlyDealTarget: randomInt(2, 6, random),
            },
          });
          agentIds.push(agent.id);
        }
      }

      // 只读成员（助理/财务）
      const viewerName = generateName(random, Gender.FEMALE);
      const viewer = await prisma.user.create({
        data: {
          organizationId: organization.id,
          storeId: storeIds[0] ?? null,
          email: `viewer${orgIndex + 1}@estatepilot.demo`,
          passwordHash,
          name: viewerName.name,
          role: UserRole.VIEWER,
          status: UserStatus.ACTIVE,
          employeeNo: `VW${orgIndex + 1}`,
        },
      });
      agentIds.push(viewer.id);

      organizations.push({
        id: organization.id,
        name: company.shortName,
        storeIds,
        agentIds,
        managerId,
      });

      log(`  → 门店 ${storeIds.length} 个，用户 ${agentIds.length} 人`);
    }

    // ---- 房源 ----
    log('生成房源数据（Demo Data，程序生成的模拟房源）…');
    const totalProperties = await seedProperties(prisma, organizations, sizes);
    log(`  → 房源 ${totalProperties} 套`);

    // ---- 客户 + 行为 + 匹配 + 机会 + 带看 ----
    let totalCustomers = 0;
    let totalBehaviorEvents = 0;
    let totalMatches = 0;
    let totalViewings = 0;
    let totalCommunications = 0;

    for (const org of organizations) {
      log(`为客户生成数据：${org.name}`);

      // 该组织下的房源（用于生成真实的行为指向）
      const properties = await prisma.property.findMany({
        where: { organizationId: org.id },
        select: {
          id: true,
          title: true,
          community: true,
          district: true,
          totalPrice: true,
          unitPrice: true,
          area: true,
          bedrooms: true,
          decoration: true,
          buildYear: true,
          subwayDistance: true,
        },
        take: 2000,
      });

      if (properties.length === 0) {
        log('  ⚠️ 该组织没有房源，跳过客户生成');
        continue;
      }

      const customerResult = await seedCustomers(
        prisma,
        org,
        properties,
        sizes,
        random,
      );
      totalCustomers += customerResult.customers;
      totalBehaviorEvents += customerResult.behaviorEvents;
      totalMatches += customerResult.matches;
      totalViewings += customerResult.viewings;
      totalCommunications += customerResult.communications;

      log(
        `  → 客户 ${customerResult.customers}，行为 ${customerResult.behaviorEvents}，` +
          `匹配 ${customerResult.matches}，带看 ${customerResult.viewings}，沟通 ${customerResult.communications}`,
      );
    }

    // ---- 特性开关 ----
    await seedFeatureFlags(prisma);

    // ---- 汇总 ----
    const counts = {
      organizations: await prisma.organization.count(),
      stores: await prisma.store.count(),
      users: await prisma.user.count(),
      customers: await prisma.customer.count(),
      properties: await prisma.property.count(),
      behaviorEvents: await prisma.customerBehaviorEvent.count(),
      matches: await prisma.customerPropertyMatch.count(),
      viewings: await prisma.viewing.count(),
      communications: await prisma.communication.count(),
      opportunities: await prisma.opportunity.count(),
      notifications: await prisma.notification.count(),
      priceHistory: await prisma.propertyPriceHistory.count(),
      scoringRules: scoringRuleCount,
    };

    log('');
    log('=== 种子数据生成完成 ===');
    log(`  组织        ${counts.organizations}`);
    log(`  门店        ${counts.stores}`);
    log(`  用户        ${counts.users}`);
    log(`  客户        ${counts.customers}`);
    log(`  房源        ${counts.properties}（Demo Data）`);
    log(`  行为事件    ${counts.behaviorEvents}`);
    log(`  匹配记录    ${counts.matches}`);
    log(`  带看        ${counts.viewings}`);
    log(`  沟通记录    ${counts.communications}`);
    log(`  机会        ${counts.opportunities}`);
    log(`  通知        ${counts.notifications}`);
    log(`  价格历史    ${counts.priceHistory}`);
    log(`  评分规则    ${counts.scoringRules}`);
    log('');
    log('=== 演示账号（密码均为 ' + demoPassword + '）===');
    log('  公司负责人  owner1@estatepilot.demo / owner2@estatepilot.demo');
    log('  门店店长    manager11@estatepilot.demo / manager12@estatepilot.demo');
    log('  经纪人      agent111@estatepilot.demo（更多见 agentXYZ 命名规则）');
    log('  只读成员    viewer1@estatepilot.demo');
    log('');
  } finally {
    await prisma.$disconnect();
  }
}

// ---------------------------------------------------------------------------
// 行为评分规则
// ---------------------------------------------------------------------------

async function seedScoringRules(prisma: ReturnType<typeof createPrismaClient>): Promise<number> {
  // 平台级默认规则（organizationId 为空，所有组织共用）
  const ruleNames: Record<string, string> = {
    [BehaviorEventType.PAGE_VIEW]: '打开专属页面',
    [BehaviorEventType.PROPERTY_VIEW]: '查看房源详情',
    [BehaviorEventType.PROPERTY_REVISIT]: '重复查看同一房源',
    [BehaviorEventType.PROPERTY_SKIP]: '快速划过房源',
    [BehaviorEventType.IMAGE_VIEW]: '查看房源图片',
    [BehaviorEventType.IMAGE_GALLERY_COMPLETE]: '看完整个图集',
    [BehaviorEventType.FLOOR_PLAN_VIEW]: '查看户型图',
    [BehaviorEventType.MAP_VIEW]: '查看地图位置',
    [BehaviorEventType.COMMUNITY_VIEW]: '查看小区信息',
    [BehaviorEventType.PRICE_HISTORY_VIEW]: '查看价格历史',
    [BehaviorEventType.SCHOOL_VIEW]: '查看学区信息',
    [BehaviorEventType.SUBWAY_VIEW]: '查看地铁信息',
    [BehaviorEventType.COMMUTE_VIEW]: '查看通勤信息',
    [BehaviorEventType.PROPERTY_FAVORITE]: '收藏房源',
    [BehaviorEventType.PROPERTY_UNFAVORITE]: '取消收藏',
    [BehaviorEventType.PROPERTY_COMPARE]: '加入对比',
    [BehaviorEventType.PROPERTY_SHARE]: '分享房源',
    [BehaviorEventType.CONTACT_AGENT]: '联系经纪人',
    [BehaviorEventType.BOOK_VIEWING]: '预约带看',
    [BehaviorEventType.SEARCH]: '搜索房源',
    [BehaviorEventType.FILTER_CHANGE]: '修改筛选条件',
  };

  // 带条件的规则：停留时长、重复次数
  const conditions: Partial<
    Record<BehaviorEventTypeType, { kind: ScoringConditionKind; value: number; name: string; score: number }>
  > = {
    [BehaviorEventType.PROPERTY_VIEW]: {
      kind: ScoringConditionKind.DURATION_OVER,
      value: 30,
      name: '停留超过 30 秒',
      score: 2,
    },
    [BehaviorEventType.PROPERTY_SKIP]: {
      kind: ScoringConditionKind.DURATION_UNDER,
      value: 5,
      name: '停留不足 5 秒',
      score: -3,
    },
    [BehaviorEventType.PROPERTY_REVISIT]: {
      kind: ScoringConditionKind.REPEAT_OVER,
      value: 2,
      name: '同一房源访问超过 2 次',
      score: 6,
    },
  };

  let count = 0;
  let priority = 100;

  /**
   * 写入一条规则。
   *
   * 为什么不用 upsert：@@unique([organizationId, name]) 里的 organizationId 可空，
   * 而 Prisma 的复合唯一键 where 不接受 null 值。
   * 平台级默认规则的 organizationId 正是 null，因此改用「先查后写」。
   */
  async function putRule(data: {
    name: string;
    eventType: BehaviorEventTypeType;
    score: number;
    conditionKind: ScoringConditionKind;
    conditionValue: number | null;
    maxPerPropertyPerDay: number | null;
    description: string;
  }): Promise<void> {
    const existing = await prisma.behaviorScoringRule.findFirst({
      where: { organizationId: null, name: data.name },
      select: { id: true },
    });

    if (existing) {
      await prisma.behaviorScoringRule.update({
        where: { id: existing.id },
        data: {
          score: data.score,
          conditionKind: data.conditionKind,
          conditionValue: data.conditionValue,
          enabled: true,
        },
      });
    } else {
      await prisma.behaviorScoringRule.create({
        data: {
          organizationId: null,
          name: data.name,
          eventType: data.eventType,
          score: data.score,
          conditionKind: data.conditionKind,
          conditionValue: data.conditionValue,
          maxPerPropertyPerDay: data.maxPerPropertyPerDay,
          enabled: true,
          priority: priority++,
          description: data.description,
        },
      });
    }
    count += 1;
  }

  for (const [eventType, baseScore] of Object.entries(DEFAULT_BEHAVIOR_SCORES)) {
    const typedEventType = eventType as BehaviorEventTypeType;
    const ruleLabel = ruleNames[typedEventType] ?? typedEventType;

    // 基础规则：无条件计分
    if (baseScore !== 0 && typedEventType !== BehaviorEventType.PROPERTY_VIEW) {
      await putRule({
        name: ruleLabel,
        eventType: typedEventType,
        score: baseScore,
        conditionKind: ScoringConditionKind.ALWAYS,
        conditionValue: null,
        maxPerPropertyPerDay: typedEventType === BehaviorEventType.PROPERTY_VIEW ? null : 20,
        description: `基础规则：${ruleLabel} 计 ${baseScore} 分`,
      });
    }

    // 条件规则
    const condition = conditions[typedEventType];
    if (condition) {
      await putRule({
        name: condition.name,
        eventType: typedEventType,
        score: condition.score,
        conditionKind: condition.kind,
        conditionValue: condition.value,
        maxPerPropertyPerDay: 10,
        description: `条件规则：${condition.name} 计 ${condition.score} 分`,
      });
    }
  }

  return count;
}

// ---------------------------------------------------------------------------
// 房源
// ---------------------------------------------------------------------------

/** 生成房源并写入数据库（复用 MockPropertyProvider 的数据集定义以保证一致性） */
async function seedProperties(
  prisma: ReturnType<typeof createPrismaClient>,
  organizations: Array<{ id: string }>,
  sizes: ProfileSizes,
): Promise<number> {
  // 动态引入 Mock Provider，保证「界面看到的字段」与「Provider 产出的字段」完全一致
  const { MockPropertyProvider } = await import(
    pathToFileURL(
      path.join(repoRoot, 'apps/api/src/modules/property/providers/mock-property.provider.ts'),
    ).href
  );

  const provider = new MockPropertyProvider({
    seed: 20_261_008,
    perCommunity: sizes.propertiesPerCommunity,
  });

  // ⚠️ 必须分页拉取：Provider 出于防止内存爆炸的考虑，把单页上限截断到 200 条
  // （见 MockPropertyProvider.fetchProperties 与 PropertySyncService 的同一处理）。
  // 如果只取第一页，会静默丢掉绝大部分房源。
  const normalized: Awaited<ReturnType<typeof provider.fetchProperties>>['items'] = [];
  let page = 1;
  let hasMore = true;
  while (hasMore) {
    const batch = await provider.fetchProperties({ city: '上海', page, pageSize: 200 });
    normalized.push(...batch.items);
    hasMore = batch.hasMore;
    page += 1;
    if (page > 100) break; // 安全阀
  }
  log(`  Provider 生成 ${normalized.length} 套归一化房源（${page - 1} 页）`);

  let created = 0;

  // 两个组织共享同一批房源（真实场景中不同公司房源库不同，
  // 但演示时共享可以让「反向匹配」有更多可比对的客户）
  for (const org of organizations) {
    for (const item of normalized) {
      try {
        const property = await prisma.property.create({
          data: {
            organizationId: org.id,
            externalProvider: item.externalProvider,
            externalId: item.externalId,
            rawData: item.rawData ?? undefined,

            city: item.city,
            district: item.district,
            subDistrict: item.subDistrict,
            community: item.community,
            title: item.title,
            address: item.address,
            longitude: item.longitude,
            latitude: item.latitude,

            totalPrice: BigInt(item.totalPrice),
            unitPrice: item.unitPrice,

            bedrooms: item.bedrooms,
            livingRooms: item.livingRooms,
            bathrooms: item.bathrooms,
            area: item.area,

            floor: item.floor,
            totalFloors: item.totalFloors,

            orientation: item.orientation,
            buildYear: item.buildYear,
            propertyType: item.propertyType,
            ownershipType: item.ownershipType,
            decoration: item.decoration,
            elevator: item.elevator,

            subwayDistance: item.subwayDistance,
            subwayInfo: item.subway ?? undefined,
            schoolInfo: item.schoolInfo ?? undefined,
            propertyManagementCompany: '演示物业',
            propertyFee: Number(randomFloat(1.2, 8.5, () => 0.5, 1)),

            tags: item.tags,
            floorPlan: item.floorPlan,
            coverImage: item.images[0]?.url ?? null,
            description: item.description,

            listingStatus: item.listingStatus,
            listingDate: item.listingDate ? new Date(item.listingDate) : null,
            lastPriceChange: item.lastPriceChange ? new Date(item.lastPriceChange) : null,
            lastSyncedAt: new Date(),

            communityNormalized: item.community.replace(/\s+/g, '').toLowerCase(),
            districtNormalized: item.district.replace(/[区县]$/, ''),
          },
          select: { id: true },
        });

        // 图片
        if (item.images.length > 0) {
          await prisma.propertyImage.createMany({
            data: item.images.map((image) => ({
              propertyId: property.id,
              url: image.url,
              category: image.category ?? 'INTERIOR',
              sortOrder: image.sortOrder ?? 0,
              caption: image.caption ?? null,
              width: image.width ?? null,
              height: image.height ?? null,
            })),
          });
        }

        // 价格历史：为约 35% 的房源制造一次真实的降价记录
        // 这是「降价机会」功能的数据基础，必须真实存在
        if (item.lastPriceChange) {
          const currentPrice = item.totalPrice;
          // 降价幅度 3%～8%
          const dropRatio = randomFloat(0.03, 0.08, () => 0.5, 4);
          const oldPrice = Math.round(currentPrice / (1 - dropRatio) / 10_000) * 10_000;
          const change = currentPrice - oldPrice;

          await prisma.propertyPriceHistory.create({
            data: {
              organizationId: org.id,
              propertyId: property.id,
              oldPrice: BigInt(oldPrice),
              newPrice: BigInt(currentPrice),
              change: BigInt(change),
              changePercent: Number(((change / oldPrice) * 100).toFixed(3)),
              oldUnitPrice: Math.round(oldPrice / item.area),
              newUnitPrice: item.unitPrice,
              reason: 'OWNER_ADJUST',
              createdAt: new Date(item.lastPriceChange),
            },
          });
        }

        created += 1;
      } catch (error) {
        // 唯一约束冲突说明该房源已存在，跳过
        const message = error instanceof Error ? error.message : String(error);
        if (!message.includes('Unique constraint')) {
          log(`  ⚠️ 创建房源失败 ${item.externalId}：${message.slice(0, 120)}`);
        }
      }
    }
  }

  return created;
}

// ---------------------------------------------------------------------------
// 客户 / 行为 / 匹配 / 机会 / 带看 / 沟通
// ---------------------------------------------------------------------------

interface PropertySummary {
  id: string;
  title: string;
  community: string;
  district: string;
  totalPrice: bigint;
  unitPrice: number;
  area: unknown;
  bedrooms: number;
  decoration: string | null;
  buildYear: number | null;
  subwayDistance: number | null;
}

async function seedCustomers(
  prisma: ReturnType<typeof createPrismaClient>,
  org: { id: string; storeIds: string[]; agentIds: string[] },
  properties: PropertySummary[],
  sizes: ProfileSizes,
  random: () => number,
): Promise<{
  customers: number;
  behaviorEvents: number;
  matches: number;
  viewings: number;
  communications: number;
}> {
  let customerCount = 0;
  let behaviorCount = 0;
  let matchCount = 0;
  let viewingCount = 0;
  let communicationCount = 0;

  // 门店下的经纪人（用于分配客户）
  const users = await prisma.user.findMany({
    where: { organizationId: org.id, role: { in: [UserRole.AGENT, UserRole.STORE_MANAGER] } },
    select: { id: true, storeId: true, name: true },
  });

  for (let i = 0; i < sizes.customersPerOrg; i += 1) {
    const person = generateName(random);
    const storeId = pickOne(org.storeIds, random);

    // 分配给该门店的经纪人
    const storeAgents = users.filter((user) => user.storeId === storeId);
    const agent = storeAgents.length > 0 ? pickOne(storeAgents, random) : pickOne(users, random);

    const status = pickWeighted(
      STATUS_WEIGHTS.map((item) => item.status),
      STATUS_WEIGHTS.map((item) => item.weight),
      random,
    );
    const source = pickWeighted(
      SOURCE_WEIGHTS.map((item) => item.source),
      SOURCE_WEIGHTS.map((item) => item.weight),
      random,
    );

    // 预算：上海市场的合理区间
    const budgetMin = randomInt(300, 1400, random) * 10_000;
    const budgetMax = budgetMin + randomInt(50, 300, random) * 10_000;

    // 偏好区域：以门店所在区域为主
    const districtPool = [...new Set(properties.map((p) => p.district))];
    const districtCount = randomInt(1, 3, random);
    const preferredDistricts: string[] = [];
    for (let d = 0; d < districtCount; d += 1) {
      const district = pickOne(districtPool, random);
      if (!preferredDistricts.includes(district)) preferredDistricts.push(district);
    }

    // 偏好小区
    const communityPool = [...new Set(properties.map((p) => p.community))];
    const preferredCommunities: string[] = [];
    const communityCount = randomInt(0, 3, random);
    for (let c = 0; c < communityCount; c += 1) {
      const community = pickOne(communityPool, random);
      if (!preferredCommunities.includes(community)) preferredCommunities.push(community);
    }

    const bedrooms = pickWeighted([1, 2, 3, 4], [10, 35, 40, 15], random);
    const areaMin = bedrooms === 1 ? 35 : bedrooms === 2 ? 60 : bedrooms === 3 ? 85 : 125;
    const areaMax = areaMin + randomInt(15, 45, random);

    const createdAt = new Date(Date.now() - randomInt(1, 400, random) * 86_400_000);
    const lastContactAt =
      status === CustomerStatus.NEW
        ? null
        : new Date(Date.now() - randomInt(0, 45, random) * 86_400_000);

    const customer = await prisma.customer.create({
      data: {
        organizationId: org.id,
        storeId,
        assignedAgentId: agent?.id ?? null,
        createdById: agent?.id ?? null,

        name: person.name,
        phone: generatePhone(random),
        wechat: random() < 0.6 ? `wx_${randomString(10)}` : null,
        gender: person.gender,
        age: randomInt(26, 58, random),
        familyStructure: pickWeighted(
          ['单身', '夫妻二人', '夫妻+1孩', '夫妻+2孩', '三代同堂'],
          [15, 25, 35, 15, 10],
          random,
        ),
        source,
        sourceDetail: source === CustomerSource.ONLINE_PLATFORM ? '线上平台端口' : null,

        status,
        intentLevel:
          status === CustomerStatus.HIGH_INTENT || status === CustomerStatus.NEGOTIATING
            ? IntentLevel.A
            : status === CustomerStatus.NEW || status === CustomerStatus.DORMANT
              ? IntentLevel.C
              : IntentLevel.B,
        tags: [],

        budgetMin,
        budgetMax,
        preferredCity: '上海',
        preferredDistricts,
        preferredCommunities,
        bedrooms: [bedrooms],
        livingRooms: bedrooms >= 3 ? 2 : 1,
        areaMin,
        areaMax,
        propertyAgePreference: pickWeighted(
          [
            PropertyAgePreference.WITHIN_5,
            PropertyAgePreference.WITHIN_10,
            PropertyAgePreference.WITHIN_20,
            PropertyAgePreference.ANY,
          ],
          [15, 30, 25, 30],
          random,
        ),
        floorPreference: pickWeighted(
          ['LOW', 'MIDDLE', 'HIGH', 'ANY'],
          [15, 35, 25, 25],
          random,
        ) as never,
        decorationPreference: pickWeighted(
          [
            DecorationPreference.FINE,
            DecorationPreference.SIMPLE,
            DecorationPreference.LUXURY,
            DecorationPreference.ANY,
          ],
          [35, 25, 15, 25],
          random,
        ),
        schoolPreference: random() < 0.4 ? '希望对口优质小学' : null,
        subwayDistanceMax: pickWeighted([500, 800, 1000, 1500, 3000], [15, 25, 25, 20, 15], random),
        commuteLocations: random() < 0.5
          ? [
              {
                label: pickOne(['张江高科', '陆家嘴', '徐家汇', '人民广场', '虹桥商务区'], random),
                maxMinutes: randomInt(30, 60, random),
              },
            ]
          : [],
        purchasePurpose: pickWeighted(
          [
            PurchasePurpose.SELF_LIVE,
            PurchasePurpose.IMPROVE,
            PurchasePurpose.SCHOOL,
            PurchasePurpose.INVESTMENT,
            PurchasePurpose.MARRIAGE,
          ],
          [30, 25, 20, 15, 10],
          random,
        ),
        paymentMethod: pickWeighted(
          [PaymentMethod.MORTGAGE, PaymentMethod.COMBINED, PaymentMethod.FULL, PaymentMethod.HOUSING_FUND],
          [45, 25, 20, 10],
          random,
        ),
        downPaymentBudget: randomInt(100, 500, random) * 10_000,
        loanRequirement: '需要商业贷款',
        loanStatus: pickWeighted(
          [LoanStatus.NOT_STARTED, LoanStatus.PREPARING, LoanStatus.SUBMITTED, LoanStatus.APPROVED],
          [35, 25, 20, 20],
          random,
        ),
        purchaseTimeline: pickWeighted(
          [
            PurchaseTimeline.URGENT,
            PurchaseTimeline.ONE_MONTH,
            PurchaseTimeline.THREE_MONTHS,
            PurchaseTimeline.HALF_YEAR,
            PurchaseTimeline.UNDECIDED,
          ],
          [10, 20, 30, 25, 15],
          random,
        ),
        notes: random() < 0.3 ? '客户比较关注小区环境和周边配套。' : null,

        lastContactAt,
        nextFollowUpAt:
          random() < 0.4 ? new Date(Date.now() + randomInt(-5, 5, random) * 86_400_000) : null,

        consentBehaviorTracking: true,
        consentPersonalization: true,
        consentGrantedAt: createdAt,
        consentPolicyVersion: 'v1.0',

        createdAt,
      },
      select: { id: true, name: true },
    });

    customerCount += 1;

    // ---- 客户显性需求画像 ----
    await prisma.customerProfile.create({
      data: {
        customerId: customer.id,
        rawRequirementText: `客户希望在上海${preferredDistricts.join('、')}购房，预算 ${budgetMin / 10000}～${budgetMax / 10000} 万，${bedrooms}房，面积 ${areaMin}～${areaMax}㎡。`,
        explicit: {
          budgetMin,
          budgetMax,
          preferredDistricts,
          preferredCommunities,
          bedrooms: [bedrooms],
          areaMin,
          areaMax,
        },
        clarityScore: Number(randomFloat(0.4, 0.95, random, 2)),
      },
    });

    // ---- 行为事件 ----
    const [minEvents, maxEvents] = sizes.behaviorEventsPerCustomer;
    const eventCount = randomInt(minEvents, maxEvents, random);
    const sessionCount = randomInt(1, 6, random);

    // 客户重点关注 2～6 套房源（制造真实的重复访问与收藏模式）
    const focusCount = randomInt(2, 6, random);
    const focusProperties: PropertySummary[] = [];
    const propertyPool = [...properties];
    for (let f = 0; f < focusCount && propertyPool.length > 0; f += 1) {
      const index = Math.floor(random() * propertyPool.length);
      const [picked] = propertyPool.splice(index, 1);
      if (picked) focusProperties.push(picked);
    }

    // 行为时间分布：越近越密（符合真实客户行为）
    const sessions: Array<{ sessionId: string; startedAt: Date; device: DeviceType }> = [];
    for (let s = 0; s < sessionCount; s += 1) {
      const daysAgo = randomInt(0, 45, random);
      sessions.push({
        sessionId: `sess_${randomString(16)}`,
        startedAt: new Date(Date.now() - daysAgo * 86_400_000 - randomInt(0, 86_400, random) * 1000),
        device: pickWeighted(
          [DeviceType.MOBILE, DeviceType.DESKTOP, DeviceType.TABLET],
          [65, 30, 5],
          random,
        ),
      });
    }

    const behaviors: Array<Record<string, unknown>> = [];
    const favoriteProperties = new Set<string>();

    for (let e = 0; e < eventCount; e += 1) {
      const eventType = pickWeighted(
        BEHAVIOR_WEIGHTS.map((item) => item.type),
        BEHAVIOR_WEIGHTS.map((item) => item.weight),
        random,
      );
      const session = pickOne(sessions, random);
      const targetProperty =
        eventType === BehaviorEventType.PAGE_VIEW ||
        eventType === BehaviorEventType.SEARCH ||
        eventType === BehaviorEventType.FILTER_CHANGE
          ? null
          : pickOne(focusProperties, random);

      // 停留时长：不同事件类型差异很大
      let duration: number | null = null;
      if (
        eventType === BehaviorEventType.PROPERTY_VIEW ||
        eventType === BehaviorEventType.PAGE_VIEW
      ) {
        // 15% 概率快速划过（负向信号）
        duration = random() < 0.15 ? randomInt(1, 4, random) : randomInt(20, 240, random);
      } else if (eventType === BehaviorEventType.IMAGE_VIEW) {
        duration = randomInt(3, 15, random);
      } else if (eventType === BehaviorEventType.FLOOR_PLAN_VIEW) {
        duration = randomInt(10, 60, random);
      }

      const createdAt = new Date(
        session.startedAt.getTime() + randomInt(0, 3_600_000, random),
      );

      // 分数：使用默认权重表（真实系统会从数据库规则计算）
      const score = DEFAULT_BEHAVIOR_SCORES[eventType] ?? 0;

      if (eventType === BehaviorEventType.PROPERTY_FAVORITE && targetProperty) {
        favoriteProperties.add(targetProperty.id);
      }

      behaviors.push({
        organizationId: org.id,
        customerId: customer.id,
        propertyId: targetProperty?.id ?? null,
        sessionId: session.sessionId,
        eventType,
        metadata:
          eventType === BehaviorEventType.SEARCH
            ? { keyword: pickOne(['张江 三房', '徐汇 学区房', '浦东 精装', '地铁 两房'], random) }
            : eventType === BehaviorEventType.FILTER_CHANGE
              ? {
                  filters: {
                    priceMax: budgetMax,
                    bedrooms: [bedrooms],
                    district: preferredDistricts[0] ?? null,
                  },
                }
              : eventType === BehaviorEventType.IMAGE_VIEW
                ? { imageIndex: randomInt(0, 12, random) }
                : null,
        duration,
        device: session.device,
        source: pickWeighted(['wechat', 'sms', 'direct', 'qr'], [55, 25, 15, 5], random),
        // IP 哈希：绝不存明文
        ipHash: `seed_${randomString(32)}`,
        score,
        createdAt,
      });
    }

    // 批量写入行为事件
    for (let b = 0; b < behaviors.length; b += 500) {
      const batch = behaviors.slice(b, b + 500);
      await prisma.customerBehaviorEvent.createMany({ data: batch as never });
    }
    behaviorCount += behaviors.length;

    // 回填客户的聚合计数。
    // 这些字段是冗余的（真实系统里由行为采集管道增量维护），
    // 但列表页与 KPI 卡片都直接读它们，因此种子数据必须保持一致 ——
    // 否则界面会出现「有行为记录但显示 0 次浏览」的矛盾。
    const lastActiveAt =
      behaviors.length > 0
        ? new Date(Math.max(...behaviors.map((b) => (b.createdAt as Date).getTime())))
        : null;

    await prisma.customer.update({
      where: { id: customer.id },
      data: {
        behaviorEventCount: behaviors.length,
        lastActiveAt,
      },
    });

    // ---- 收藏与对比 ----
    const favorites = [...favoriteProperties].slice(0, 6);
    if (favorites.length > 0) {
      await prisma.favorite.createMany({
        data: favorites.map((propertyId) => {
          const property = focusProperties.find((p) => p.id === propertyId);
          return {
            organizationId: org.id,
            customerId: customer.id,
            propertyId,
            priceAtFavorite: property?.totalPrice ?? null,
          };
        }),
        skipDuplicates: true,
      });
    }

    // 30% 概率有对比行为
    if (random() < 0.3 && focusProperties.length >= 2) {
      const compareGroup = `cmp_${randomString(12)}`;
      const compareItems = focusProperties.slice(0, Math.min(3, focusProperties.length));
      await prisma.comparison.createMany({
        data: compareItems.map((property, index) => ({
          organizationId: org.id,
          customerId: customer.id,
          propertyId: property.id,
          groupId: compareGroup,
          position: index,
        })),
        skipDuplicates: true,
      });
    }

    // ---- 行为画像（由行为统计真实算出，不是随机数）----
    const viewedProps = focusProperties;
    if (viewedProps.length > 0) {
      const prices = viewedProps.map((p) => Number(p.totalPrice));
      const areas = viewedProps.map((p) => Number(p.area));

      const inferredBudgetMin = Math.round(Math.min(...prices) / 10_000) * 10_000;
      const inferredBudgetMax = Math.round(Math.max(...prices) / 10_000) * 10_000;

      const districtCounts = new Map<string, number>();
      for (const property of viewedProps) {
        districtCounts.set(property.district, (districtCounts.get(property.district) ?? 0) + 1);
      }
      const totalViews = viewedProps.length;
      const districtPreference = [...districtCounts.entries()]
        .map(([district, count]) => ({ district, score: Number((count / totalViews).toFixed(2)) }))
        .sort((a, b) => b.score - a.score);

      const sampleSize = behaviors.length;
      const confidence = Math.min(0.95, 0.3 + sampleSize / 200);

      await prisma.customerBehavioralProfile.create({
        data: {
          customerId: customer.id,
          profile: {
            budget: { min: inferredBudgetMin, max: inferredBudgetMax, confidence, sampleSize },
            area: {
              min: Math.floor(Math.min(...areas)),
              max: Math.ceil(Math.max(...areas)),
              confidence,
              sampleSize,
            },
            districtPreference,
            communityPreference: [],
            bedroomPreference: [],
            decorationPreference: [],
            buildYearPreference: [],
            floorPreference: [],
            orientationPreference: [],
            subwayPreference: [],
            schoolPreference: [],
            commutePreference: [],
            propertyManagementPreference: [],
            confidence,
            sampleSize,
            windowStart: new Date(Date.now() - 30 * 86_400_000).toISOString(),
            windowEnd: new Date().toISOString(),
            reasoningSummary: `基于 ${sampleSize} 条行为事件分析：客户实际浏览总价集中在 ${inferredBudgetMin / 10000}～${inferredBudgetMax / 10000} 万，面积 ${Math.floor(Math.min(...areas))}～${Math.ceil(Math.max(...areas))}㎡${
              districtPreference[0] ? `，区域上最偏好 ${districtPreference[0].district}` : ''
            }。`,
          },
          inferredBudgetMin,
          inferredBudgetMax,
          inferredAreaMin: Math.floor(Math.min(...areas)),
          inferredAreaMax: Math.ceil(Math.max(...areas)),
          budgetConfidence: Number(confidence.toFixed(3)),
          topDistricts: districtPreference.slice(0, 3).map((item) => item.district),
          topCommunities: [...new Set(viewedProps.map((p) => p.community))].slice(0, 3),
          confidence: Number(confidence.toFixed(3)),
          sampleSize,
          windowStart: new Date(Date.now() - 30 * 86_400_000),
          windowEnd: new Date(),
          reasoningSummary: `基于 ${sampleSize} 条行为事件推断出客户的真实需求区间。`,
          aiGenerated: false,
        },
      });

      // ---- 匹配记录：用真实的预算与户型做交集筛选 ----
      const candidateMatches = properties
        .filter((property) => {
          const price = Number(property.totalPrice);
          const bedroomsMatch = property.bedrooms === bedrooms;
          const priceMatch = price >= budgetMin * 0.9 && price <= budgetMax * 1.15;
          return bedroomsMatch && priceMatch;
        })
        .slice(0, 8);

      if (candidateMatches.length > 0) {
        await prisma.customerPropertyMatch.createMany({
          data: candidateMatches.map((property) => {
            // 匹配分：由价格贴合度与户型一致性真实计算
            const price = Number(property.totalPrice);
            const midBudget = (budgetMin + budgetMax) / 2;
            const deviation = Math.abs(price - midBudget) / midBudget;
            const score = Math.max(
              50,
              Math.min(98, Math.round(95 - deviation * 100 + randomFloat(-3, 3, random, 1))),
            );

            return {
              organizationId: org.id,
              customerId: customer.id,
              propertyId: property.id,
              assignedAgentId: agent?.id ?? null,
              score,
              level: score >= 90 ? 'PERFECT' : score >= 80 ? 'HIGH' : score >= 65 ? 'MEDIUM' : 'LOW',
              reasons: [
                {
                  key: 'bedrooms',
                  label: `${bedrooms}房`,
                  value: String(bedrooms),
                  score: 1,
                  weight: 10,
                  contribution: 10,
                  source: 'EXPLICIT',
                  isHardRequirement: true,
                },
                {
                  key: 'budget',
                  label: `总价 ${Math.round(price / 10000)} 万`,
                  value: String(price),
                  score: Number((1 - deviation).toFixed(2)),
                  weight: 20,
                  contribution: Number(((1 - deviation) * 20).toFixed(1)),
                  source: 'EXPLICIT',
                  isHardRequirement: true,
                },
              ],
              highlights: [
                `${bedrooms}房符合需求`,
                `总价 ${Math.round(price / 10000)} 万在预算范围内`,
                property.decoration === 'FINE' ? '精装修' : '户型方正',
              ],
              concerns: price > budgetMax ? ['略超预算上限'] : [],
              behaviorEvidence: [
                {
                  statement: `客户最近浏览的房源中${districtPreference[0]?.district ?? '该区域'}占比最高`,
                  metric: {
                    name: '区域浏览占比',
                    value: districtPreference[0]?.score ?? 0,
                    unit: '比例',
                    sampleSize,
                  },
                },
              ],
              recommendation: `${property.community} ${bedrooms}房，总价 ${Math.round(price / 10000)} 万，符合客户预算与户型要求。`,
              stagesApplied: ['HARD_FILTER', 'PREFERENCE_SCORE'],
              passedHardFilter: true,
              priceAtMatch: property.totalPrice,
              trigger: 'SCHEDULED',
            };
          }),
          skipDuplicates: true,
        });
        matchCount += candidateMatches.length;
      }
    }

    // ---- 沟通记录 ----
    const communicationCountForCustomer = randomInt(0, 4, random);
    for (let c = 0; c < communicationCountForCustomer; c += 1) {
      const occurredAt = new Date(Date.now() - randomInt(1, 60, random) * 86_400_000);
      const channel = pickWeighted(['WECHAT', 'PHONE', 'SMS', 'FACE_TO_FACE'], [50, 30, 10, 10], random);
      const direction = random() < 0.5 ? 'OUTBOUND' : 'INBOUND';

      await prisma.communication.create({
        data: {
          organizationId: org.id,
          customerId: customer.id,
          agentId: agent?.id ?? org.agentIds[0]!,
          channel: channel as never,
          direction: direction as never,
          source: 'MANUAL',
          content:
            direction === 'OUTBOUND'
              ? pickOne(
                  [
                    '您好，这边有几套符合您要求的房源，方便的话我发您看看？',
                    '张先生您好，您之前关注的那个小区新出了一套房，价格比之前那套低一些。',
                    '您好，上次带您看的那套业主这边价格有松动，您还有兴趣吗？',
                  ],
                  random,
                )
              : pickOne(
                  [
                    '好的，我看看，有需要再联系你',
                    '价格还是有点高，能不能再谈一下',
                    '这周末有空，可以约个时间看房',
                    '我再和家人商量一下',
                  ],
                  random,
                ),
          summary: null,
          sentiment: pickWeighted(
            ['POSITIVE', 'NEUTRAL', 'NEGATIVE'],
            [40, 45, 15],
            random,
          ) as never,
          intent: pickWeighted(
            ['PRICE_INQUIRY', 'SCHEDULE_VIEWING', 'OBJECTION', 'HESITATION', 'SMALL_TALK'],
            [25, 20, 20, 20, 15],
            random,
          ) as never,
          objections: random() < 0.3 ? ['价格偏高'] : [],
          appliedToProfile: false,
          occurredAt,
          createdAt: occurredAt,
        },
      });
      communicationCount += 1;
    }

    // ---- 带看与带看反馈 ----
    if (
      (status === CustomerStatus.VIEWING ||
        status === CustomerStatus.NEGOTIATING ||
        status === CustomerStatus.DEAL ||
        status === CustomerStatus.HIGH_INTENT) &&
      focusProperties.length >= 2 &&
      viewingCount < sizes.viewingsPerOrg * 2
    ) {
      const viewingProperties = focusProperties.slice(0, Math.min(3, focusProperties.length));
      const scheduledAt = new Date(Date.now() - randomInt(0, 45, random) * 86_400_000);
      const viewingStatus = pickWeighted(
        ['COMPLETED', 'COMPLETED', 'COMPLETED', 'CONFIRMED', 'PLANNED', 'CANCELLED'],
        [40, 20, 15, 10, 10, 5],
        random,
      );

      const viewing = await prisma.viewing.create({
        data: {
          organizationId: org.id,
          storeId,
          customerId: customer.id,
          agentId: agent?.id ?? org.agentIds[0]!,
          scheduledAt,
          completedAt: viewingStatus === 'COMPLETED' ? scheduledAt : null,
          status: viewingStatus as never,
          notes: random() < 0.4 ? '客户希望看中高楼层，注意提前和业主确认钥匙。' : null,
          feedback:
            viewingStatus === 'COMPLETED'
              ? pickOne(
                  [
                    '客户对第二套比较满意，觉得小区环境和装修都不错，但觉得总价还是偏高一点。',
                    '看了三套，客户最喜欢第一套的户型，但是老婆觉得客厅有点小。',
                    '客户对地铁距离比较满意，就是对楼层不太满意，希望看看更高楼层的。',
                  ],
                  random,
                )
              : null,
          satisfaction: viewingStatus === 'COMPLETED' ? randomInt(3, 5, random) : null,
        },
      });

      for (let vp = 0; vp < viewingProperties.length; vp += 1) {
        const property = viewingProperties[vp]!;
        const liked = vp === 0 ? 'LIKE' : pickWeighted(['LIKE', 'NEUTRAL', 'DISLIKE'], [20, 50, 30], random);
        await prisma.viewingProperty.create({
          data: {
            viewingId: viewing.id,
            propertyId: property.id,
            visitOrder: vp + 1,
            liked: liked as never,
            pros: liked === 'LIKE' ? ['小区环境好', '采光好'] : [],
            cons: liked === 'DISLIKE' ? ['楼层偏低'] : [],
            customerPrice:
              liked === 'LIKE'
                ? BigInt(Math.round((Number(property.totalPrice) * 0.97) / 10_000) * 10_000)
                : null,
            customerComment: liked === 'LIKE' ? '这套可以考虑，如果价格能谈' : null,
          },
        });
      }

      viewingCount += 1;

      // 更新客户带看次数
      await prisma.customer.update({
        where: { id: customer.id },
        data: { viewingCount: { increment: 1 } },
      });
    }

    // 进度输出
    if ((i + 1) % 25 === 0) {
      log(`    已生成 ${i + 1}/${sizes.customersPerOrg} 位客户`);
    }
  }

  // ---- 销售机会与通知（由真实数据驱动，不是凭空生成）----
  await seedOpportunitiesAndNotifications(prisma, org, random);

  return {
    customers: customerCount,
    behaviorEvents: behaviorCount,
    matches: matchCount,
    viewings: viewingCount,
    communications: communicationCount,
  };
}

// ---------------------------------------------------------------------------
// 机会与通知
// ---------------------------------------------------------------------------

async function seedOpportunitiesAndNotifications(
  prisma: ReturnType<typeof createPrismaClient>,
  org: { id: string; storeIds: string[]; agentIds: string[] },
  random: () => number,
): Promise<void> {
  // 取有降价历史的房源 —— 这是「降价机会」的真实来源
  const priceDroppedProperties = await prisma.property.findMany({
    where: {
      organizationId: org.id,
      lastPriceChange: { not: null },
      listingStatus: ListingStatus.ACTIVE,
    },
    select: {
      id: true,
      title: true,
      community: true,
      totalPrice: true,
      priceHistory: {
        orderBy: { createdAt: 'desc' },
        take: 1,
        select: { oldPrice: true, newPrice: true, change: true },
      },
    },
    take: 120,
  });

  let opportunityCount = 0;

  for (const property of priceDroppedProperties) {
    const history = property.priceHistory[0];
    if (!history) continue;

    // 找到关注过这套房的客户（真实关联，不是随机指派）
    const interestedCustomers = await prisma.customerBehaviorEvent.findMany({
      where: { organizationId: org.id, propertyId: property.id },
      select: { customerId: true },
      distinct: ['customerId'],
      take: 6,
    });

    if (interestedCustomers.length === 0) continue;

    const changeWan = Math.round(Number(history.change) / 10_000);

    for (const { customerId } of interestedCustomers.slice(0, 3)) {
      const customer = await prisma.customer.findUnique({
        where: { id: customerId },
        select: { id: true, name: true, assignedAgentId: true, storeId: true, intentScore: true },
      });
      if (!customer) continue;

      const dedupeKey = `PRICE_DROP:${customerId}:${property.id}:${history.newPrice}`;
      const valueScore = randomInt(65, 95, random);

      try {
        const opportunity = await prisma.opportunity.create({
          data: {
            organizationId: org.id,
            storeId: customer.storeId,
            customerId: customer.id,
            propertyId: property.id,
            assignedAgentId: customer.assignedAgentId,
            type: 'PRICE_DROP',
            priority: valueScore >= 85 ? 'URGENT' : valueScore >= 75 ? 'HIGH' : 'MEDIUM',
            status: 'OPEN',
            title: `${customer.name}关注的${property.community}降价 ${Math.abs(changeWan)} 万`,
            reason: `该客户近期多次浏览 ${property.community}，且该房源总价从 ${Number(history.oldPrice) / 10000} 万降至 ${Number(history.newPrice) / 10000} 万，是与客户恢复沟通的天然理由。`,
            suggestion: `今天上午联系 ${customer.name}，直接告知价格变化，并尝试约定带看时间。`,
            valueScore,
            expectedValue: BigInt(Math.round(Number(property.totalPrice) * 0.02)),
            evidence: [
              {
                kind: 'PRICE',
                statement: `总价由 ${Number(history.oldPrice) / 10000} 万降至 ${Number(history.newPrice) / 10000} 万`,
                value: Number(history.change),
                unit: '元',
                occurredAt: new Date().toISOString(),
              },
              {
                kind: 'BEHAVIOR',
                statement: `该客户浏览过此房源`,
              },
            ],
            matchScore: randomInt(70, 96, random),
            suggestedContactBy: new Date(Date.now() + 6 * 3_600_000),
            dedupeKey,
            expiresAt: new Date(Date.now() + 7 * 86_400_000),
            createdAt: new Date(Date.now() - randomInt(0, 72, random) * 3_600_000),
          },
        });

        // 对应通知
        if (customer.assignedAgentId) {
          await prisma.notification.create({
            data: {
              organizationId: org.id,
              userId: customer.assignedAgentId,
              type: 'PRICE_DROP',
              priority: valueScore >= 85 ? 'URGENT' : 'HIGH',
              title: `${customer.name}关注的房源降价`,
              body: `${property.community} 总价下降 ${Math.abs(changeWan)} 万，建议立即联系客户。`,
              link: `/opportunities`,
              customerId: customer.id,
              propertyId: property.id,
              opportunityId: opportunity.id,
              isRead: random() < 0.35,
              dedupeKey: `NOTIFY:${dedupeKey}`,
              createdAt: new Date(Date.now() - randomInt(0, 48, random) * 3_600_000),
            },
          });
        }

        opportunityCount += 1;
        if (opportunityCount >= 150) break;
      } catch (error) {
        // 去重键冲突说明机会已存在，跳过
        const message = error instanceof Error ? error.message : String(error);
        if (!message.includes('Unique constraint')) {
          log(`    ⚠️ 创建机会失败：${message.slice(0, 100)}`);
        }
      }
    }

    if (opportunityCount >= 150) break;
  }

  log(`    → 机会 ${opportunityCount} 条（含对应通知）`);
}

// ---------------------------------------------------------------------------
// 特性开关
// ---------------------------------------------------------------------------

async function seedFeatureFlags(prisma: ReturnType<typeof createPrismaClient>): Promise<void> {
  const flags = [
    {
      key: 'ai.salesCopilot',
      name: 'AI 销售助手',
      description: '首页的 AI 每日建议与聊天助手',
      enabled: true,
    },
    {
      key: 'ai.reverseMatching',
      name: '反向匹配',
      description: '房源 → 客户 的自动扫描与机会生成',
      enabled: true,
    },
    {
      key: 'property.beikeProvider',
      name: '贝壳数据接入',
      description: '启用贝壳官方开放平台房源同步（需配置凭证）',
      enabled: false,
    },
    {
      key: 'ai.voiceNote',
      name: '语音快速记录',
      description: '带看后语音转写（第一版为文本模式）',
      enabled: false,
    },
    {
      key: 'notification.wechatPush',
      name: '微信推送通知',
      description: '通过企业微信推送销售机会提醒',
      enabled: false,
    },
  ];

  for (const flag of flags) {
    await prisma.featureFlag.upsert({
      where: { key: flag.key },
      create: flag,
      update: { name: flag.name, description: flag.description },
    });
  }
}

// ---- 执行 ----
main()
  .then(() => {
    process.exit(0);
  })
  .catch((error: unknown) => {
    console.error('\n种子数据生成失败：');
    console.error(error);
    process.exit(1);
  });

// 未使用的导入保留（供后续扩展种子数据时使用）
void buildWindowKey;
void PropertyProviderKind;
void randomString;
