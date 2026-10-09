/**
 * 分析「搜索响应」与「详情响应」的字段差异。
 *
 * ============================================================================
 * 为什么这个分析很重要（关系到上线容量）
 * ============================================================================
 * 当前实现为每套房源额外调用 2 次接口（entity_detail + entity_material）
 * 来获取完整详情。按实测，一次搜索 11 次调用就可能触发限流，
 * 恢复需 30 分钟以上。
 *
 * 但如果**搜索响应本身**已经包含足够的字段（面积/户型/朝向/楼层/建成年代/
 * 小区/价格），那"卡片列表"就可以零额外调用展示，
 * 只有"确实需要的深度详情"才去调接口 —— 调用量能降一个数量级。
 *
 * 本脚本用**已保存的真实响应**做离线对比，不访问网络。
 *
 * 用法：
 *   node --experimental-strip-types scripts/analyze-response-fields.ts
 *   （需要先运行 capture-beike-fixtures.ts 生成 fixture）
 */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

const FIXTURE_DIR = path.resolve(process.cwd(), 'scripts', 'fixtures');

interface FieldDiff {
  name: string;
  inSearch: boolean;
  inDetail: boolean;
}

function main(): void {
  const searchPath = path.join(FIXTURE_DIR, 'beike-house-search.txt');
  const detailPath = path.join(FIXTURE_DIR, 'beike-entity-detail.txt');

  if (!existsSync(searchPath) || !existsSync(detailPath)) {
    console.log('缺少 fixture 文件。');
    console.log('');
    console.log('请先在贝壳可用时运行：');
    console.log('  node --experimental-strip-types scripts/capture-beike-fixtures.ts');
    console.log('');
    console.log('（当前贝壳处于限流状态，需要等恢复）');
    process.exit(1);
  }

  const searchText = readFileSync(searchPath, 'utf8');
  const detailText = readFileSync(detailPath, 'utf8');

  const searchFields = extractTopLevelFields(searchText, '摘要信息');
  const detailFields = extractTopLevelFields(detailText, '基础信息');
  const communityFields = extractTopLevelFields(detailText, '基本信息');

  console.log('贝壳响应字段对比\n');
  console.log('='.repeat(74));

  console.log('\n【搜索响应 · 摘要信息】');
  console.log(`  共 ${searchFields.length} 个字段`);
  for (const field of searchFields) console.log(`    · ${field}`);

  console.log('\n【详情响应 · 基础信息】');
  console.log(`  共 ${detailFields.length} 个字段`);
  for (const field of detailFields) console.log(`    · ${field}`);

  console.log('\n【详情响应 · 小区基本信息】');
  console.log(`  共 ${communityFields.length} 个字段`);
  for (const field of communityFields) console.log(`    · ${field}`);

  // ---- 差异分析 ----
  console.log('');
  console.log('='.repeat(74));
  console.log('\n【字段差异分析】\n');

  const onlyInDetail = detailFields.filter((field) => !searchFields.includes(field));
  const onlyInSearch = searchFields.filter((field) => !detailFields.includes(field));

  console.log('  仅详情有（需要额外调用才能拿到）：');
  for (const field of onlyInDetail) console.log(`    · ${field}`);
  if (onlyInDetail.length === 0) console.log('    （无）');

  console.log('');
  console.log('  仅搜索有：');
  for (const field of onlyInSearch) console.log(`    · ${field}`);
  if (onlyInSearch.length === 0) console.log('    （无）');

  // ---- 结论 ----
  const coverage =
    detailFields.length > 0
      ? Math.round((searchFields.filter((f) => detailFields.includes(f)).length / detailFields.length) * 100)
      : 0;

  console.log('');
  console.log('='.repeat(74));
  console.log('\n【结论】\n');
  console.log(`  搜索响应覆盖了详情字段的 ${coverage}%`);
  console.log(`  搜索响应独有 ${onlyInSearch.length} 个字段，详情独有 ${onlyInDetail.length} 个`);
  console.log('');
  console.log('  决策依据：');
  if (onlyInDetail.length <= 6 && coverage >= 60) {
    console.log('    → 搜索响应已覆盖大部分字段，**卡片列表可零额外调用展示**，');
    console.log('      仅"深度详情"（小区配套、周边、图片）按需加载。');
  } else {
    console.log('    → 详情提供的字段明显更多，用户需要深度信息时确实要额外调用。');
    console.log('      建议：列表用摘要，详情用缓存 + 节流控制。');
  }
  console.log('');
}

/** 从响应文本里提取某个 JSON 块的顶层字段名 */
function extractTopLevelFields(text: string, blockKey: string): string[] {
  const marker = `"${blockKey}"`;
  const index = text.indexOf(marker);
  if (index < 0) return [];

  const braceStart = text.indexOf('{', index + marker.length);
  if (braceStart < 0) return [];

  // 找配对的右括号
  let depth = 0;
  let inString = false;
  let escaped = false;
  let end = -1;

  for (let i = braceStart; i < text.length; i += 1) {
    const char = text[i]!;
    if (escaped) { escaped = false; continue; }
    if (char === '\\') { escaped = true; continue; }
    if (char === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) { end = i; break; }
    }
  }

  if (end <= braceStart) return [];

  try {
    const obj: unknown = JSON.parse(text.slice(braceStart, end + 1));
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return [];
    return Object.keys(obj as Record<string, unknown>);
  } catch {
    return [];
  }
}

main();
