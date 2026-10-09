/**
 * 三级预算合并逻辑验证（纯逻辑，不依赖贝壳与数据库）。
 *
 * 覆盖需求 §8 的核心要求：需求只会越来越完整，不会被最后一句冲掉。
 *
 * 用法：node --experimental-strip-types --no-warnings scripts/verify-budget-merge.ts
 */

import { parseRequirementByRules } from '../dist/modules/requirement/chinese-expression-parser.js';
import {
  RequirementMergeService,
  createEmptyProfile,
} from '../dist/modules/requirement/requirement-merge.service.js';

interface Round {
  message: string;
  /** 该轮结束后期望的三级预算（单位：万元，null 表示未设置） */
  expect: {
    target: number | null;
    normalMax: number | null;
    stretchMax: number | null;
    strictMax: boolean;
  };
  /** 该轮说明 */
  why: string;
}

const rounds: Round[] = [
  {
    message: '想看浦东三房，500左右',
    expect: { target: 500, normalMax: null, stretchMax: null, strictMax: false },
    why: '客户只给了理想预算',
  },
  {
    message: '张江更好，550也可以',
    expect: { target: 500, normalMax: 550, stretchMax: null, strictMax: false },
    why: '关键：理想预算不能被覆盖，550 只是"可以接受的上限"',
  },
  {
    message: '特别好的600也能考虑',
    expect: { target: 500, normalMax: 550, stretchMax: 600, strictMax: false },
    why: '让步语气 → 极限上限；前两级不动',
  },
  {
    message: '其实550就够了，600那套太贵',
    expect: { target: 500, normalMax: 550, stretchMax: 600, strictMax: false },
    why: '客户回到常规上限，不应导致异常',
  },
  {
    message: '最多520，超过不看',
    expect: { target: 500, normalMax: 520, stretchMax: null, strictMax: true },
    why: '明确拒绝超价 → 严格上限生效，且要压掉原有的极限上限',
  },
];

async function main(): Promise<void> {
  const merger = new RequirementMergeService();

  let profile = createEmptyProfile();
  let passed = 0;
  let failed = 0;

  console.log('三级预算演进验证（真实的多轮对话）\n');
  console.log('轮次 | 客户说 | 理想 | 最高 | 极限 | 严格');
  console.log('─'.repeat(84));

  for (const [index, round] of rounds.entries()) {
    const extraction = parseRequirementByRules(round.message);
    const result = merger.merge(profile, extraction);
    profile = result.merged;

    const wan = (value: number | null): string => (value === null ? '—' : `${value / 10000}万`);
    const targetWan = profile.budgetTarget === null ? null : profile.budgetTarget / 10000;
    const normalWan = profile.budgetNormalMax === null ? null : profile.budgetNormalMax / 10000;
    const stretchWan = profile.budgetStretchMax === null ? null : profile.budgetStretchMax / 10000;

    const ok =
      targetWan === round.expect.target &&
      normalWan === round.expect.normalMax &&
      stretchWan === round.expect.stretchMax &&
      profile.budgetStrictMax === round.expect.strictMax;

    if (ok) passed += 1;
    else failed += 1;

    console.log(
      `  ${index + 1}  | ${round.message.slice(0, 16).padEnd(18)} | ` +
        `${wan(profile.budgetTarget).padEnd(6)} | ${wan(profile.budgetNormalMax).padEnd(6)} | ` +
        `${wan(profile.budgetStretchMax).padEnd(6)} | ${profile.budgetStrictMax ? '是' : '否'}  ${ok ? '✓' : '✗'}`,
    );

    if (!ok) {
      console.log(
        `     ✗ 期望：理想 ${wan(round.expect.target * 10000)} / 最高 ${wan(round.expect.normalMax === null ? null : round.expect.normalMax * 10000)} / ` +
          `极限 ${wan(round.expect.stretchMax === null ? null : round.expect.stretchMax * 10000)} / 严格 ${round.expect.strictMax ? '是' : '否'}`,
      );
      console.log(`     原因：${round.why}`);
    }
  }

  console.log('─'.repeat(84));
  console.log(`\n通过 ${passed} 项，失败 ${failed} 项\n`);

  // 额外验证：客户改口必须能覆盖
  console.log('=== 客户明确改口的场景 ===');
  let overrideProfile = createEmptyProfile();

  const first = merger.merge(overrideProfile, parseRequirementByRules('只要两房，预算500万'));
  overrideProfile = first.merged;
  console.log(
    `  第 1 轮"只要两房，预算500万" → 户型=${overrideProfile.bedrooms.join('/')} strict=${overrideProfile.bedroomsStrict} 理想=${overrideProfile.budgetTarget! / 10000}万`,
  );

  const second = merger.merge(overrideProfile, parseRequirementByRules('现在只考虑三房'));
  overrideProfile = second.merged;
  const overrideWorked = overrideProfile.bedrooms.length === 1 && overrideProfile.bedrooms[0] === 3;
  console.log(
    `  第 2 轮"现在只考虑三房" → 户型=${overrideProfile.bedrooms.join('/')} ${overrideWorked ? '✓ 已覆盖（不是追加）' : '✗ 未被覆盖'}`,
  );

  // 额外验证：学区"无所谓"应取消原有要求
  console.log('\n=== 学区要求取消的场景 ===');
  let schoolProfile = createEmptyProfile();
  schoolProfile = merger.merge(schoolProfile, parseRequirementByRules('一定要学区')).merged;
  console.log(`  第 1 轮"一定要学区" → schoolRequired=${schoolProfile.schoolRequired}`);
  schoolProfile = merger.merge(schoolProfile, parseRequirementByRules('学区无所谓了')).merged;
  console.log(
    `  第 2 轮"学区无所谓了" → schoolRequired=${schoolProfile.schoolRequired} schoolNotNeeded=${schoolProfile.schoolNotNeeded} ` +
      `${!schoolProfile.schoolRequired && schoolProfile.schoolNotNeeded ? '✓' : '✗'}`,
  );

  process.exit(failed > 0 ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
