/**
 * 给 Property 模型加 fullDetail 字段（贝壳完整详情 JSON）。
 *
 * 为什么需要：完整详情是**花配额从贝壳换来的**。
 * 如果只放在内存缓存里，限流或重启后就丢了 ——
 * 而贝壳限流恢复需要 20 分钟以上。
 *
 * 存库后：
 *   · 限流期间仍能展示完整详情（来自上次成功获取的数据）
 *   · 重启不清空
 *   · 界面必须标注数据时间，让经纪人知道"这份详情是什么时候取的"
 *
 * ⚠️ 用 Node 脚本改 schema 而不是 PowerShell 文本往返 ——
 *    本项目有过 PowerShell 损坏 UTF-8 中文注释的事故。
 */

import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const SCHEMA = path.resolve(process.cwd(), 'prisma', 'schema.prisma');

function main() {
  const content = readFileSync(SCHEMA, 'utf8');

  if (content.includes('fullDetail')) {
    console.log('✓ fullDetail 字段已存在，无需修改');
    return;
  }

  /**
   * 插入位置：`rawData Json?` 之后。
   *
   * 让它紧邻 rawData 是有意的 —— 两者都是"原始数据快照"，
   * 放在一起便于理解：rawData 是搜索摘要，fullDetail 是完整详情。
   */
  const anchor = '  rawData Json?';

  if (!content.includes(anchor)) {
    console.error('✗ 未找到插入锚点 rawData Json?');
    process.exit(1);
  }

  const addition = `${anchor}

  /// 贝壳完整详情（entity_detail + entity_material 解析后的结构化数据）
  ///
  /// 包含：房屋信息（19 项）、小区信息（20 项）、周边配套（按距离排序）、图片列表。
  /// 存库的理由：这是花 API 配额换来的数据，缓存降级或重启后不应丢失。
  /// 界面展示时必须显示 detailFetchedAt，让经纪人知道数据的新鲜度。
  fullDetail Json?

  /// 完整详情的获取时间（用于界面标注"详情获取于 X 分钟前"）
  detailFetchedAt DateTime?`;

  const updated = content.replace(anchor, addition);

  if (updated === content) {
    console.error('✗ 替换未生效');
    process.exit(1);
  }

  writeFileSync(SCHEMA, updated, 'utf8');
  console.log('✓ 已添加 fullDetail 与 detailFetchedAt 字段');
}

main();
