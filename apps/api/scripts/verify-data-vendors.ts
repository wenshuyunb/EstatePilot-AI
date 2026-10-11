/**
 * 核实：搜索结果里提到的"房产数据服务商"是否提供**正规的企业数据服务**。
 *
 * ============================================================================
 * 为什么必须核实（这批结果里有陷阱）
 * ============================================================================
 * 搜索命中的文章标题形如「安居客 item_get 获取详情数据接口对接全攻略」——
 * 这类"逆向接口""item_get"话术是**爬虫工具**的典型特征，不是官方授权。
 * 用它们是侵权行为（链家诉推推99 已判赔 550 万且判决生效）。
 *
 * 但同一批结果里也有**正规的企业级数据服务商**，例如：
 *   · 房软（fangruan.com）—— 面向中介的 SaaS
 *   · 云房数据（yunfangdata.com）—— 房产数据 API
 *   · 幂简集成（explinks.com）—— API 聚合平台
 *
 * 本脚本只核实**这些服务商是否存在、是否面向企业提供数据服务**，
 * 不抓取任何房源数据。
 *
 * 用法：node --experimental-strip-types scripts/verify-data-vendors.ts
 */

const VENDORS: Array<{ name: string; url: string; why: string }> = [
  {
    name: '房软 fangruan',
    url: 'https://fangruan.com/',
    why: '面向中介的 SaaS，可能与平台有数据合作',
  },
  {
    name: '云房数据 yunfangdata',
    url: 'http://m.yunfangdata.com/dataApi.html',
    why: '宣称提供房产数据 API',
  },
  {
    name: '幂简集成 explinks',
    url: 'https://apihub.explinks.com/',
    why: 'API 聚合平台，可能收录房产类接口',
  },
];

/** 企业级数据服务的特征词 */
const ENTERPRISE_SIGNALS = [
  '企业',
  '合作',
  '授权',
  '商务',
  '咨询',
  '联系',
  '解决方案',
  '数据服务',
  'API',
  '接口',
  '试用',
  '定制',
];

/** 危险特征词（爬虫/逆向工具的味道） */
const RISKY_SIGNALS = [
  '逆向',
  '抓包',
  '破解',
  '爬虫',
  'item_get',
  '一键采集',
  '无需授权',
  '采集器',
];

async function inspect(name: string, url: string, why: string): Promise<void> {
  console.log(`\n【${name}】`);
  console.log(`  ${url}`);
  console.log(`  核实点：${why}`);

  let html = '';
  let finalUrl = url;

  try {
    const response = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 EstatePilot/1.0' },
      signal: AbortSignal.timeout(20_000),
      redirect: 'follow',
    });

    finalUrl = response.url;
    html = await response.text();

    console.log(`  HTTP ${response.status} | 最终地址：${finalUrl}`);
  } catch (error) {
    console.log(`  ✗ 访问失败：${String(error).slice(0, 70)}`);
    return;
  }

  const title = /<title[^>]*>([^<]*)<\/title>/i.exec(html)?.[1]?.trim() ?? '（无标题）';
  const description =
    /<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)["']/i.exec(html)?.[1]?.trim() ??
    '（无描述）';

  console.log(`  标题：${title.slice(0, 70)}`);
  console.log(`  描述：${description.slice(0, 100)}`);
  console.log(`  页面大小：${(html.length / 1024).toFixed(1)} KB`);

  const enterpriseHits = ENTERPRISE_SIGNALS.filter((keyword) => html.includes(keyword));
  const riskyHits = RISKY_SIGNALS.filter((keyword) => html.includes(keyword));

  console.log(`  企业服务特征：${enterpriseHits.length > 0 ? enterpriseHits.join('、') : '（无）'}`);
  console.log(`  ⚠️ 风险特征：${riskyHits.length > 0 ? riskyHits.join('、') : '（无）'}`);

  if (riskyHits.length >= 2) {
    console.log(`  🔴 判定：**疑似爬虫/逆向工具** —— 不要使用`);
  } else if (enterpriseHits.length >= 5) {
    console.log(`  ✓ 判定：看起来是**正规企业数据服务**，可进一步商务接触`);
  } else if (html.length < 3000) {
    console.log(`  ⚠️ 判定：页面过小，信息不足`);
  } else {
    console.log(`  ? 判定：需人工查看`);
  }
}

async function main(): Promise<void> {
  console.log('核实房产数据服务商\n');
  console.log('='.repeat(76));
  console.log('\n目的：区分「正规企业数据服务」与「爬虫逆向工具」。');
  console.log('后者是侵权行为 —— 链家诉推推99 判赔 550 万，判决已生效。\n');

  for (const vendor of VENDORS) {
    await inspect(vendor.name, vendor.url, vendor.why);
  }

  console.log('\n' + '='.repeat(76));
  console.log('\n给决策者的提醒：');
  console.log('  · 任何宣称"无需授权即可获取贝壳/安居客数据"的服务，');
  console.log('    本质都是转卖抓取数据 —— **用了就是共同侵权**。');
  console.log('  · 正规路径只有：官方开放平台、企业数据服务商签约、自建数据。');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
