/**
 * 直接测试需求抽取器，定位"消息明说厦门却解析成上海"。
 */

import { RequirementExtractorService } from '../dist/modules/requirement/requirement-extractor.service.js';
import { AiService } from '../dist/modules/ai/ai.service.js';

async function main(): Promise<void> {
  const config = {
    env: 'development',
    isDevelopment: true,
    log: { level: 'info' },
    ai: { provider: 'mock', apiKey: null },
  };

  const ai = new AiService(config as never);
  const extractor = new RequirementExtractorService(ai);

  const message = '厦门岛外的房子';

  const scenarios: Array<{ label: string; options: Record<string, unknown> }> = [
    {
      label: '不传 cityHint（我改后的行为）',
      options: { customerName: '唐刚刚', cityHint: null, existingProfile: null },
    },
    {
      label: '传 cityHint=上海（模拟修复前的行为）',
      options: { customerName: '唐刚刚', cityHint: '上海', existingProfile: null },
    },
    {
      label: '传 cityHint=null + 有历史画像(上海)',
      options: {
        customerName: '唐刚刚',
        cityHint: null,
        existingProfile: { city: '上海', districts: ['浦东新区'], subDistricts: ['张江'] },
      },
    },
  ];

  for (const s of scenarios) {
    console.log('='.repeat(74));
    console.log(s.label);
    console.log('='.repeat(74));

    const result = await extractor.extract(message, s.options as never);

    console.log(`  source      = ${result.source}`);
    console.log(`  city        = ${JSON.stringify(result.extraction.city)}`);
    console.log(`  citySource  = ${JSON.stringify(result.extraction.citySource)}`);
    console.log(`  districts   = ${JSON.stringify(result.extraction.districts)}`);
    console.log(`  subDistricts= ${JSON.stringify(result.extraction.subDistricts)}`);
    console.log(`  summary     = ${result.extraction.summary}`);
    console.log('');
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
