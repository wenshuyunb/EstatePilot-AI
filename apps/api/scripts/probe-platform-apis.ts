/**
 * 探测：除贝壳外，其他房产平台是否提供**可接入的公开接口**。
 *
 * ============================================================================
 * 为什么要实测而不是凭印象
 * ============================================================================
 * "某平台有没有 API"这件事，网上的说法经常过时或不准。
 * 而且这里有个关键区别必须分清：
 *
 *   · **官方开放平台**（有文档、有授权流程）→ 可以合法接入 ✅
 *   · **网站本身可访问** → ❌ **不等于**可以接入（爬取是侵权）
 *
 * 本脚本只探测**是否存在官方开放平台/开发者入口**，
 * **不做任何房源数据抓取**。
 *
 * 用法：node --experimental-strip-types scripts/probe-platform-apis.ts
 */

/** 各平台可能存在的开发者/开放平台入口 */
const CANDIDATES: Array<{
  name: string;
  company: string;
  urls: string[];
  note: string;
}> = [
  {
    name: '贝壳开放平台',
    company: '贝壳找房',
    urls: ['https://open.ke.com/', 'https://building.ke.com/'],
    note: '已知可用：估值/成交/验真（无房源检索）',
  },
  {
    name: '安居客',
    company: '58同城 / 安居客',
    urls: [
      'https://open.58.com/',
      'https://open.anjuke.com/',
      'https://developer.58.com/',
      'https://open.58ganji.com/',
    ],
    note: '58 有开放平台（招聘/二手车为主）',
  },
  {
    name: '房天下',
    company: '搜房控股',
    urls: ['https://open.fang.com/', 'https://open.soufun.com/', 'https://developer.fang.com/'],
    note: '老牌房产平台',
  },
  {
    name: '我爱我家',
    company: '我爱我家',
    urls: ['https://open.5i5j.com/', 'https://developer.5i5j.com/', 'https://www.5i5j.com/open'],
    note: 'A 股上市（000560）',
  },
  {
    name: '乐有家',
    company: '乐有家',
    urls: ['https://open.leyoujia.com/', 'https://developer.leyoujia.com/'],
    note: '华南区域龙头',
  },
  {
    name: '中原地产',
    company: '中原集团',
    urls: ['https://open.centanet.com/', 'https://developer.centanet.com/'],
    note: '港资，覆盖深港',
  },
  {
    name: '诸葛找房',
    company: '诸葛找房',
    urls: ['https://open.zhuge.com/', 'https://developer.zhuge.com/'],
    note: '房产大数据服务商',
  },
  {
    name: '天猫好房',
    company: '阿里 / 易居',
    urls: ['https://open.taobao.com/', 'https://open.alibaba.com/'],
    note: '阿里系',
  },
];

async function probe(url: string): Promise<{ status: number; accessible: boolean; title: string | null }> {
  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: { 'User-Agent': 'Mozilla/5.0 EstatePilot/1.0' },
      signal: AbortSignal.timeout(15_000),
      redirect: 'follow',
    });

    const html = await response.text();
    const title = /<title[^>]*>([^<]*)<\/title>/i.exec(html)?.[1]?.trim() ?? null;

    return { status: response.status, accessible: true, title };
  } catch {
    return { status: 0, accessible: false, title: null };
  }
}

async function main(): Promise<void> {
  console.log('各房产平台开放接口探测\n');
  console.log('='.repeat(76));
  console.log('\n只探测"是否有官方开放平台入口"，不抓取任何房源数据。\n');

  for (const candidate of CANDIDATES) {
    console.log(`\n【${candidate.name}】${candidate.company}`);
    console.log(`  ${candidate.note}`);

    for (const url of candidate.urls) {
      const result = await probe(url);

      if (!result.accessible) {
        console.log(`  ✗ ${url}  —  无法访问（域名不存在或网络不通）`);
        continue;
      }

      if (result.status === 404) {
        console.log(`  ✗ ${url}  —  404（无此入口）`);
        continue;
      }

      if (result.status >= 300 && result.status < 400) {
        console.log(`  ⚠️  ${url}  —  ${result.status} 重定向`);
        continue;
      }

      console.log(`  ✓ ${url}  —  HTTP ${result.status}`);
      if (result.title) console.log(`      标题：${result.title.slice(0, 60)}`);
    }
  }

  console.log('\n' + '='.repeat(76));
  console.log('\n结论要点：');
  console.log('  · 能访问 ≠ 能接入。很多平台首页可访问，但没有开放接口。');
  console.log('  · 有开放平台也只是第一步，通常还需企业资质与商务签约。');
  console.log('  · **未授权抓取房源数据是侵权行为**（见链家诉推推99 案，判赔 550 万）。');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
