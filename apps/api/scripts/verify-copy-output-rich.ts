/**
 * 用"仍有原始字段"的房源，验证**完整复制链路**的输出效果。
 *
 * 为什么不用推荐接口：推荐命中的那批房源恰好是 rawData 已被抹掉的，
 * 无法体现修复效果。本脚本直接从数据库挑数据最全的房源，
 * 走真实的详情接口 → 模拟前端的复制格式化，展示最终文本。
 *
 * ⚠️ 不访问贝壳。
 */

import { createPrismaClient } from '@estatepilot/database';

const API = 'http://localhost:3001/api/v1';
const CID = 'cmuz8d13c0rp4i8ush0x94u8j';

const connectionString =
  process.env.DATABASE_URL ??
  'postgresql://estatepilot:estatepilot_dev_pwd@localhost:5432/estatepilot?schema=public';

const prisma = createPrismaClient({ connectionString, applicationName: 'verify-copy-output' });

/** 与前端 property-copy.ts 保持一致的格式化（此处刻意复刻，便于命令行验证） */
function formatCopy(input: {
  community: string;
  city: string;
  district: string;
  subDistrict: string | null;
  totalPrice: number;
  unitPrice: number;
  bedrooms: number;
  livingRooms: number;
  bathrooms: number;
  area: number;
  buildYear: number | null;
  orientation: string | null;
  tags: string[];
  detail: Record<string, unknown> | null;
}): string {
  const blocks: string[] = [];

  const layout = `${input.bedrooms}室${input.livingRooms > 0 ? `${input.livingRooms}厅` : ''}${
    input.bathrooms > 0 ? `${input.bathrooms}卫` : ''
  }`;

  const wan = (amount: number): string => {
    const value = amount / 10_000;
    return Number.isInteger(value) ? `${value}万` : `${value.toFixed(1)}万`;
  };

  blocks.push(
    `【${input.community}】${layout} · ${input.area}㎡ · ${wan(input.totalPrice)}`,
  );

  const location = [input.city, input.district, input.subDistrict].filter(Boolean).join(' ');
  if (location) blocks.push(location);

  const detailBase = (input.detail?.['base'] ?? null) as Record<string, unknown> | null;
  const detailCommunity = (input.detail?.['community'] ?? null) as Record<string, unknown> | null;
  const detailNearby = (input.detail?.['nearby'] ?? null) as Record<
    string,
    Array<{ name: string; distanceMeters: number | null }>
  > | null;

  const base: string[] = [];

  if (detailBase?.['unitPrice']) base.push(`单价：${String(detailBase['unitPrice'])}`);
  else if (input.unitPrice > 0) base.push(`单价：${Math.round(input.unitPrice).toLocaleString('zh-CN')}元/㎡`);

  const floor = detailBase?.['floor'] ?? null;
  if (floor) base.push(`楼层：${String(floor)}`);

  if (input.orientation) base.push(`朝向：${input.orientation}`);
  if (input.buildYear !== null) base.push(`建成年份：${input.buildYear}年`);
  if (detailBase?.['decoration']) base.push(`装修：${String(detailBase['decoration'])}`);
  if (detailBase?.['hasElevator']) base.push(`电梯：${String(detailBase['hasElevator'])}`);
  if (detailBase?.['ownership']) base.push(`产权：${String(detailBase['ownership'])}`);

  if (base.length > 0) blocks.push(`■ 基本信息\n${base.join('\n')}`);

  const tags = (detailBase?.['tags'] as string[] | undefined)?.length
    ? (detailBase['tags'] as string[])
    : input.tags;

  if (tags.length > 0) {
    blocks.push(`■ 房源标签\n${tags.slice(0, 14).join(' · ')}${tags.length > 14 ? ` …（共 ${tags.length} 项）` : ''}`);
  }

  if (detailCommunity) {
    const c = detailCommunity;
    const lines: string[] = [];
    for (const [label, key] of [
      ['建成年代', 'buildYears'],
      ['容积率', 'floorAreaRatio'],
      ['绿化率', 'greeningRate'],
      ['物业费', 'propertyFee'],
      ['物业公司', 'propertyCompany'],
      ['车位配比', 'parkingRatio'],
      ['总户数', 'totalHouseholds'],
      ['人车分流', 'separatedTraffic'],
    ] as const) {
      if (c[key] !== null && c[key] !== undefined && String(c[key]).trim().length > 0) {
        lines.push(`${label}：${String(c[key])}`);
      }
    }

    if (lines.length > 0) blocks.push(`■ 小区信息\n${lines.join('\n')}`);
  }

  if (detailNearby) {
    const nearby: string[] = [];
    const ICON: Record<string, string> = {
      subway: '🚇 地铁',
      bus: '🚌 公交',
      school: '🎓 学校',
      hospital: '🏥 医院',
      shopping: '🛒 购物',
      park: '🌳 公园',
    };

    for (const [key, list] of Object.entries(detailNearby)) {
      if (!list || list.length === 0) continue;
      const icon = ICON[key] ?? key;

      const items = list
        .slice(0, 3)
        .map((item) =>
          item.distanceMeters !== null ? `${item.name}（${item.distanceMeters}米）` : item.name,
        )
        .join('、');

      nearby.push(`${icon}：${items}`);
    }

    if (nearby.length > 0) blocks.push(`■ 周边配套\n${nearby.join('\n')}`);
  }

  if (detailBase?.['title']) blocks.push(`■ 房源描述\n${String(detailBase['title']).split('\n')[0]}`);

  return blocks.join('\n\n');
}

async function main(): Promise<void> {
  const loggedIn = await fetch(`${API}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'agent111@estatepilot.demo', password: 'EstatePilot2026!' }),
  }).then((r) => r.json() as Promise<{ accessToken: string }>);

  const H = { Authorization: `Bearer ${loggedIn.accessToken}` };

  // ---- 挑原始字段最丰富的 2 套 ----
  const rows = await prisma.property.findMany({
    select: {
      externalId: true,
      community: true,
      city: true,
      district: true,
      subDistrict: true,
      totalPrice: true,
      unitPrice: true,
      bedrooms: true,
      livingRooms: true,
      bathrooms: true,
      area: true,
      buildYear: true,
      orientation: true,
      tags: true,
      rawData: true,
    },
  });

  const ranked = rows
    .map((row) => {
      const raw = row.rawData as Record<string, unknown> | null;
      const fields = raw?.['fields'] as Record<string, unknown> | undefined;
      return { ...row, fieldCount: fields ? Object.keys(fields).length : 0 };
    })
    .filter((row) => row.fieldCount > 10)
    .sort((a, b) => b.fieldCount - a.fieldCount)
    .slice(0, 2);

  console.log('完整复制效果验证（贝壳未参与）\n');
  console.log('='.repeat(74));

  for (const row of ranked) {
    const detailResponse = await fetch(
      `${API}/customers/${CID}/properties/${row.externalId}/detail?city=${encodeURIComponent(row.city)}`,
      { headers: H },
    ).then((r) => r.json() as Promise<{ from: string; detail: Record<string, unknown> | null }>);

    const text = formatCopy({
      community: row.community,
      city: row.city,
      district: row.district,
      subDistrict: row.subDistrict,
      totalPrice: Number(row.totalPrice),
      unitPrice: Number(row.unitPrice),
      bedrooms: row.bedrooms,
      livingRooms: row.livingRooms,
      bathrooms: row.bathrooms,
      area: Number(String(row.area)),
      buildYear: row.buildYear,
      orientation: String(row.orientation ?? ''),
      tags: row.tags,
      detail: detailResponse.detail,
    });

    console.log(`\n【来源：${detailResponse.from}】\n`);
    console.log(text.split('\n').map((line) => `  │ ${line}`).join('\n'));
    console.log(`\n  → ${text.length} 字\n`);
    console.log('='.repeat(74));
  }

  await prisma.$disconnect();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
