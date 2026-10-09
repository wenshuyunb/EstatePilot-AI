/**
 * 房源粘贴解析的端到端验证脚本。
 *
 * 用多份「真实格式」的样本（模拟经纪人从贝壳/链家后台复制出来的文本）
 * 调用真实 API，验证解析准确性。
 *
 * 用法：
 *   node --experimental-transform-types scripts/verify-import.ts
 *   或： tsx scripts/verify-import.ts
 */

const API_BASE = process.env.API_BASE_URL ?? 'http://localhost:3001/api/v1';
const DEMO_EMAIL = process.env.DEMO_EMAIL ?? 'agent111@estatepilot.demo';
const DEMO_PASSWORD = process.env.DEMO_PASSWORD ?? 'EstatePilot2026!';

// ---------------------------------------------------------------------------
// 测试样本：三种真实会遇到的格式
// ---------------------------------------------------------------------------

/** 格式 A：贝壳后台「带标签逐行」复制（最常见） */
const SAMPLE_A_LABELED = `小区名称：碧云国际社区
户型：3室2厅1卫
建筑面积：128.5平米
总价：1250万
单价：97276元/平
所在楼层：中层/18层
朝向：南北
装修：精装修
建筑年代：2012年
所在区域：浦东新区
板块：金桥
地铁：9号线 金桥站 约650米
学校：福山外国语小学 / 建平中学西校
标签：满五唯一，南北通透，精装
房源描述：小区环境好，绿化率高，业主诚心出售。

小区名称：张江汤臣豪园
户型：3室2厅
建筑面积：106平米
总价：680万
所在楼层：8/18层
朝向：南
装修：精装修
建筑年代：2008年
所在区域：浦东新区
板块：张江
地铁：2号线 张江高科站 约400米
标签：学区房，地铁房`;

/** 格式 B：紧凑单行（从列表页直接复制） */
const SAMPLE_B_COMPACT = `徐家汇花园 3室2厅 128.5㎡ 1580万 精装 中层/18层
春申景城 2室1厅 88㎡ 520万 简装 高楼层/11层
大宁金茂府 4室2厅 186㎡ 2280万 豪装 低楼层/26层`;

/** 格式 C：JSON（部分系统复制按钮给出结构化数据） */
const SAMPLE_C_JSON = JSON.stringify([
  {
    community: '陆家嘴中央公寓',
    district: '浦东新区',
    bizCircle: '陆家嘴',
    bedrooms: 3,
    livingRooms: 2,
    bathrooms: 2,
    buildArea: 152,
    totalPriceWan: 1950,
    floor: 12,
    totalFloor: 28,
    orientation: '南北',
    decoration: '精装修',
    buildYear: 2010,
    subwayDistance: 350,
  },
  {
    community: '田林新村',
    district: '徐汇区',
    bedrooms: 2,
    livingRooms: 1,
    buildArea: 68,
    totalPriceWan: 480,
    floor: 4,
    totalFloor: 6,
    orientation: '南',
    decoration: '简装',
    buildYear: 1992,
  },
]);

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

interface ParsedDraft {
  draftId: string;
  fields: Record<string, unknown>;
  confidence: number;
  missingFields: string[];
  warnings: string[];
  subway: Record<string, unknown> | null;
  schoolInfo: Record<string, unknown> | null;
}

async function login(): Promise<string> {
  const response = await fetch(`${API_BASE}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: DEMO_EMAIL, password: DEMO_PASSWORD }),
  });

  if (!response.ok) {
    throw new Error(`登录失败 HTTP ${response.status}: ${await response.text()}`);
  }

  const data = (await response.json()) as { accessToken: string };
  return data.accessToken;
}

async function preview(token: string, text: string, label: string): Promise<void> {
  console.log(`\n${'='.repeat(78)}`);
  console.log(`样本：${label}`);
  console.log('='.repeat(78));

  const response = await fetch(`${API_BASE}/properties/import/preview`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ text, city: '上海' }),
  });

  if (!response.ok) {
    console.error(`❌ HTTP ${response.status}: ${await response.text()}`);
    return;
  }

  const data = (await response.json()) as {
    drafts: ParsedDraft[];
    summary: { totalBlocks: number; parsedBlocks: number; importable: number };
  };

  console.log(
    `解析结果：${data.summary.parsedBlocks}/${data.summary.totalBlocks} 条解析成功，` +
      `${data.summary.importable} 条字段完整可直接导入`,
  );

  data.drafts.forEach((draft, index) => {
    const f = draft.fields as Record<string, string | number | null>;
    console.log(`\n  ── 第 ${index + 1} 条 ── 置信度 ${Math.round(draft.confidence * 100)}%`);
    console.log(`     小区      ${f.community ?? '(未解析)'}  [${f.district ?? '?'} / ${f.subDistrict ?? '?'}]`);
    console.log(
      `     户型面积  ${f.bedrooms ?? '?'}室${f.livingRooms ?? '?'}厅${f.bathrooms ?? '?'}卫  ${f.area ?? '?'}㎡`,
    );
    console.log(
      `     价格      ${f.totalPrice ? `${Math.round(Number(f.totalPrice) / 10000)}万` : '(未解析)'}` +
        `  单价 ${f.unitPrice ? `${Number(f.unitPrice).toLocaleString('zh-CN')}元/㎡` : '—'}`,
    );
    console.log(
      `     楼层朝向  ${f.floor ?? '?'}/${f.totalFloors ?? '?'}层  ${f.orientation ?? '—'}  装修 ${f.decoration ?? '—'}`,
    );
    console.log(`     建成年份  ${f.buildYear ?? '—'}`);
    console.log(
      `     地铁      ${draft.subway ? `${draft.subway.line ?? ''} ${draft.subway.station ?? ''} ${f.subwayDistance ?? ''}米` : '—'}`,
    );
    console.log(
      `     学校      ${draft.schoolInfo ? `${draft.schoolInfo.primarySchool ?? ''} ${draft.schoolInfo.middleSchool ?? ''} ${draft.schoolInfo.isKeySchool ? '(重点)' : ''}` : '—'}`,
    );
    console.log(
      `     标签      ${Array.isArray(f.tags) && (f.tags as string[]).length > 0 ? (f.tags as string[]).join('、') : '—'}`,
    );

    if (draft.missingFields.length > 0) {
      console.log(`     ⚠️  缺失：${draft.missingFields.join('、')}`);
    }
    if (draft.warnings.length > 0) {
      console.log(`     ⚠️  告警：${draft.warnings.join('；')}`);
    }
  });
}

async function main(): Promise<void> {
  console.log('房源粘贴解析验证');
  console.log(`API: ${API_BASE}`);

  const token = await login();
  console.log('登录成功');

  await preview(token, SAMPLE_A_LABELED, 'A. 贝壳后台带标签逐行格式（2 条）');
  await preview(token, SAMPLE_B_COMPACT, 'B. 列表页紧凑单行格式（3 条）');
  await preview(token, SAMPLE_C_JSON, 'C. JSON 结构化格式（2 条）');

  console.log(`\n${'='.repeat(78)}`);
  console.log('验证完成');
  console.log('='.repeat(78));
}

main().catch((error) => {
  console.error('验证失败：', error);
  process.exit(1);
});
