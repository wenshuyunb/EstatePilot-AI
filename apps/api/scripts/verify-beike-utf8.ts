/**
 * 贝壳接口的 UTF-8 安全验证。
 *
 * 为什么需要这个脚本：
 *   PowerShell 的 Invoke-RestMethod 在 Windows 上会受控制台代码页影响，
 *   把请求体里的中文转成 "??" 再发送 —— 导致服务端收到损坏的 city 参数，
 *   贝壳返回 "unsupported city_name: ??"。
 *   这不是应用的问题，而是测试工具的编码缺陷。
 *
 *   本脚本用 Node 原生 fetch（UTF-8 严格）验证，结论才可靠。
 *
 * 用法：node --experimental-strip-types scripts/verify-beike-utf8.ts
 */

const API_BASE = process.env.API_BASE_URL ?? 'http://localhost:3001/api/v1';
const DEMO_EMAIL = process.env.DEMO_EMAIL ?? 'owner1@estatepilot.demo';
const DEMO_PASSWORD = process.env.DEMO_PASSWORD ?? 'EstatePilot2026!';

/** UTF-8 安全的请求封装 */
async function apiRequest<T>(
  path: string,
  options: { method?: string; body?: unknown; token?: string } = {},
): Promise<T> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json; charset=utf-8' };
  if (options.token) headers.Authorization = `Bearer ${options.token}`;

  const response = await fetch(`${API_BASE}${path}`, {
    method: options.method ?? 'GET',
    headers,
    // JSON.stringify 产出标准 UTF-8，fetch 会按 UTF-8 发送
    ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${await response.text()}`);
  }

  return (await response.json()) as T;
}

async function main(): Promise<void> {
  console.log('贝壳接口 UTF-8 安全验证\n');
  console.log(`API: ${API_BASE}\n`);

  // ---- 登录 ----
  const login = await apiRequest<{ accessToken: string; user: { name: string } }>('/auth/login', {
    method: 'POST',
    body: { email: DEMO_EMAIL, password: DEMO_PASSWORD },
  });
  console.log(`登录成功: ${login.user.name}`);
  const token = login.accessToken;

  // ---- 验证中文参数的码点（确认客户端发送正确）----
  const city = '上海';
  console.log(`\n即将发送的 city 参数: "${city}" 码点 [${[...city].map((c) => c.codePointAt(0)?.toString(16)).join(',')}]`);

  // ---- 1. 详情接口 ----
  console.log(`\n${'='.repeat(76)}`);
  console.log('1. POST /beike/detail');
  console.log('='.repeat(76));

  const detail = await apiRequest<{
    items: Array<Record<string, unknown>>;
    notice: string;
  }>('/beike/detail', {
    method: 'POST',
    token,
    body: { city, ids: ['107112596630'] },
  });

  console.log(`返回 ${detail.items.length} 套`);
  for (const item of detail.items) {
    console.log(`\n  ✓ ${item.title}`);
    console.log(`    小区: ${item.community} | ${item.district}/${item.subDistrict}`);
    console.log(
      `    价格: ${Math.round(Number(item.totalPrice) / 10000)}万 | 单价 ${Number(item.unitPrice).toLocaleString('zh-CN')}元/㎡`,
    );
    console.log(
      `    户型: ${item.bedrooms}室${item.livingRooms}厅${item.bathrooms}卫 | ${item.area}㎡ | 楼层 ${item.floor}/${item.totalFloors}`,
    );
    console.log(`    朝向: ${item.orientation} | 装修: ${item.decoration} | 建成年份: ${item.buildYear}`);
    console.log(`    地铁: ${item.subwayText}`);
    console.log(`    学区: ${item.schoolText}`);
    console.log(`    图片: ${item.imageCount} 张`);
    console.log(`    地图: ${String(item.mapUrl).slice(0, 80)}...`);
  }

  // ---- 2. 搜索接口 ----
  console.log(`\n${'='.repeat(76)}`);
  console.log('2. POST /beike/search  （中文自由文本查询）');
  console.log('='.repeat(76));

  for (const query of ['张江 三房', '浦东 三房 500万以内']) {
    console.log(`\n--- 查询: "${query}" ---`);
    try {
      const search = await apiRequest<{
        items: Array<Record<string, unknown>>;
        totalRecalled: number | null;
        matchedConditions: Array<{ query: string; condition: string; matchType: string }>;
      }>('/beike/search', {
        method: 'POST',
        token,
        body: { city, query, houseType: 'second' },
      });

      console.log(`总召回: ${search.totalRecalled} | 本次返回: ${search.items.length} 套`);
      if (search.matchedConditions.length > 0) {
        console.log(`命中条件:`);
        for (const condition of search.matchedConditions) {
          console.log(`  「${condition.query}」 → ${condition.condition} [${condition.matchType}]`);
        }
      }
      for (const item of search.items.slice(0, 5)) {
        console.log(
          `  · ${item.community} ${item.bedrooms}室${item.livingRooms}厅 ${item.area}㎡ ` +
            `${Math.round(Number(item.totalPrice) / 10000)}万`,
        );
      }
    } catch (error) {
      console.log(`  ✗ ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

main().catch((error) => {
  console.error('\n验证失败：', error);
  process.exit(1);
});
