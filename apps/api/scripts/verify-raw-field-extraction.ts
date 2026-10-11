/**
 * 用**仍有原始字段**的房源验证本地提取逻辑是否生效。
 *
 * 背景：132 套里有 100 套的 rawData 已被之前的 bug 抹掉（只剩元数据），
 * 只有 32 套还保有贝壳原始字段。因此要针对性验证那些房源。
 *
 * ⚠️ 不访问贝壳。
 */

import { createPrismaClient } from '@estatepilot/database';

const API = 'http://localhost:3001/api/v1';
const CID = 'cmuz8d13c0rp4i8ush0x94u8j';

const connectionString =
  process.env.DATABASE_URL ??
  'postgresql://estatepilot:estatepilot_dev_pwd@localhost:5432/estatepilot?schema=public';

const prisma = createPrismaClient({ connectionString, applicationName: 'verify-raw-extract' });

async function main(): Promise<void> {
  // ---- 找出"原始字段最丰富"的房源 ----
  const rows = await prisma.property.findMany({
    select: { externalId: true, community: true, city: true, rawData: true },
  });

  const ranked = rows
    .map((row) => {
      const raw = row.rawData as Record<string, unknown> | null;
      const fields = raw?.['fields'] as Record<string, unknown> | undefined;
      return { ...row, fieldCount: fields ? Object.keys(fields).length : 0, fields };
    })
    .filter((row) => row.fieldCount > 0)
    .sort((a, b) => b.fieldCount - a.fieldCount)
    .slice(0, 4);

  if (ranked.length === 0) {
    console.log('没有房源保有原始字段');
    return;
  }

  console.log('用"原始字段最丰富"的房源验证提取逻辑\n');
  console.log('='.repeat(74));

  for (const row of ranked) {
    console.log(`\n  ${row.community}  （原始字段 ${row.fieldCount} 个）`);

    const fields = row.fields as Record<string, unknown>;
    const interesting = ['房源所属楼层', '标签', '周边交通', '学区信息', '单价', '装修类型', '楼龄'];
    const available = interesting.filter((key) => fields[key] !== undefined);
    console.log(`  含关键字段：${available.join('、') || '（无）'}`);

    // ---- 调详情接口，看这些字段是否被提取出来 ----
    const loggedIn = await fetch(`${API}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'agent111@estatepilot.demo', password: 'EstatePilot2026!' }),
    }).then((r) => r.json() as Promise<{ accessToken: string }>);

    const H = { Authorization: `Bearer ${loggedIn.accessToken}` };

    const detail = await fetch(
      `${API}/customers/${CID}/properties/${row.externalId}/detail?city=${encodeURIComponent(row.city)}`,
      { headers: H },
    ).then(
      (r) =>
        r.json() as Promise<{
          from: string;
          detail: {
            base?: { floor?: string | null; tags?: string[] };
            nearby?: Record<string, Array<{ name: string; distanceMeters: number | null }>> | null;
          } | null;
        }>,
    );

    const base = detail.detail?.base;
    const nearby = detail.detail?.nearby;
    const nearbyTotal = nearby ? Object.values(nearby).reduce((sum, list) => sum + list.length, 0) : 0;

    console.log(`  来源：${detail.from}`);
    console.log(`  提取结果：`);
    console.log(`    楼层   → ${base?.floor ?? '（未提取）'}`);
    console.log(`    标签   → ${base?.tags?.length ? base.tags.join(' · ') : '（未提取）'}`);
    console.log(`    周边   → ${nearbyTotal > 0 ? `${nearbyTotal} 条` : '（未提取）'}`);

    if (nearbyTotal > 0 && nearby) {
      for (const [key, list] of Object.entries(nearby)) {
        if (list.length === 0) continue;
        console.log(
          `      ${key}: ${list
            .slice(0, 3)
            .map((item) => `${item.name}${item.distanceMeters ? ` ${item.distanceMeters}米` : ''}`)
            .join(' / ')}`,
        );
      }
    }

    console.log('');
  }

  await prisma.$disconnect();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
