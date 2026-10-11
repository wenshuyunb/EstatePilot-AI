/**
 * 深入核实：那些返回 200 的"开放平台"入口，**实际是什么内容**。
 *
 * ============================================================================
 * 为什么必须核实
 * ============================================================================
 * 上一步探测发现多个域名返回 HTTP 200，但标题明显不对：
 *   · `developer.58.com` 标题是「厦门分类信息」→ 跳到了普通站点
 *   · `open.fang.com` 无标题 → 可能是空壳或跳转
 *   · `developer.fang.com` 标题是「全国房地产门户」→ 也是普通站点
 *
 * 很多网站对所有未知路径都返回 200（展示首页或 SEO 落地页），
 * 因此**单看状态码会得出错误结论**。
 *
 * 本脚本检查页面里是否有**真正的 API 文档特征**：
 *   · 关键词：API、接口、开发者、SDK、access_token、AppKey、文档
 *   · 是否存在文档目录结构
 *
 * 用法：node --experimental-strip-types scripts/verify-platform-docs.ts
 */

const TARGETS: Array<{ label: string; url: string }> = [
  { label: '58开放平台', url: 'https://open.58.com/' },
  { label: '58 developer 子域', url: 'https://developer.58.com/' },
  { label: '安居客 open 子域', url: 'https://open.anjuke.com/' },
  { label: '房天下 open 子域', url: 'https://open.fang.com/' },
  { label: '房天下 developer 子域', url: 'https://developer.fang.com/' },
  { label: '诸葛找房 open 子域', url: 'https://open.zhuge.com/' },
  { label: '贝壳开放平台（对照）', url: 'https://open.ke.com/' },
];

/** 判断页面是否像"真的开放平台文档" */
const API_DOC_SIGNALS = [
  '开放平台',
  '开发者',
  'API',
  '接口文档',
  'SDK',
  'access_token',
  'AppKey',
  'appkey',
  '应用管理',
  '接入指南',
  'OAuth',
];

/** 判断页面是否只是"普通网站首页" */
const PLAIN_SITE_SIGNALS = [
  '二手房',
  '新房',
  '租房',
  '楼盘',
  '房价',
  '找房',
];

async function inspect(label: string, url: string): Promise<void> {
  console.log(`\n【${label}】`);
  console.log(`  ${url}`);

  let html = '';
  let finalUrl = url;
  let status = 0;

  try {
    const response = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 EstatePilot/1.0' },
      signal: AbortSignal.timeout(20_000),
      redirect: 'follow',
    });

    status = response.status;
    finalUrl = response.url;
    html = await response.text();
  } catch (error) {
    console.log(`  ✗ 访问失败：${String(error).slice(0, 80)}`);
    return;
  }

  const title = /<title[^>]*>([^<]*)<\/title>/i.exec(html)?.[1]?.trim() ?? '（无标题）';

  console.log(`  HTTP ${status} | 最终地址：${finalUrl}`);
  console.log(`  标题：${title}`);
  console.log(`  页面大小：${(html.length / 1024).toFixed(1)} KB`);

  // ---- 检查 API 文档特征 ----
  const apiHits = API_DOC_SIGNALS.filter((keyword) => html.includes(keyword));
  const siteHits = PLAIN_SITE_SIGNALS.filter((keyword) => html.includes(keyword));

  console.log(`  API 文档特征词命中：${apiHits.length > 0 ? apiHits.join('、') : '（无）'}`);
  console.log(`  普通网站特征词命中：${siteHits.length > 0 ? siteHits.join('、') : '（无）'}`);

  // ---- 判定 ----
  if (finalUrl !== url && !finalUrl.includes(new URL(url).hostname)) {
    console.log(`  ⚠️  被重定向到**其他域名** → 该入口不存在`);
  } else if (apiHits.length >= 3) {
    console.log(`  ✓ 看起来是**真的开放平台**（含 ${apiHits.length} 个文档特征词）`);
  } else if (siteHits.length >= 2 && apiHits.length === 0) {
    console.log(`  ✗ 只是**普通网站首页**，没有开放接口`);
  } else if (html.length < 3000) {
    console.log(`  ⚠️  页面很小（${html.length} 字符）→ 可能是空壳页`);
  } else {
    console.log(`  ? 无法确定，需人工查看`);
  }
}

async function main(): Promise<void> {
  console.log('核实各平台"开放平台"的真伪\n');
  console.log('='.repeat(76));
  console.log('\n判定依据：页面是否含 API/开发者/AppKey 等**文档特征词**，');
  console.log('而不是只看 HTTP 状态码（很多站点对任意路径都返回 200）。\n');

  for (const target of TARGETS) {
    await inspect(target.label, target.url);
  }

  console.log('\n' + '='.repeat(76));
  console.log('\n说明：');
  console.log('  · 「开放平台」存在 ≠ 有房源数据接口。');
  console.log('    例如 58 开放平台主要是招聘/二手车业务，不含二手房源检索。');
  console.log('  · 即使有接口，通常也需企业资质 + 商务签约 + 按量付费。');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
