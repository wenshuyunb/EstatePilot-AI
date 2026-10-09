import { defineConfig } from 'vitest/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');

export default defineConfig({
  test: {
    globals: false,
    environment: 'node',
    // 只跑 test/ 目录下的集成测试
    include: ['test/**/*.e2e.test.ts'],
    testTimeout: 120_000,
    hookTimeout: 120_000,
    // 集成测试会操作真实数据库，必须串行，避免相互干扰。
    // Vitest 4 移除了 poolOptions，改为顶层选项。
    fileParallelism: false,
    pool: 'forks',
    maxForks: 1,
    minForks: 1,
    reporters: ['default'],
  },
  resolve: {
    alias: {
      '@estatepilot/types': path.join(repoRoot, 'packages/types/src/index.ts'),
      '@estatepilot/utils': path.join(repoRoot, 'packages/utils/src/index.ts'),
      '@estatepilot/ai': path.join(repoRoot, 'packages/ai/src/index.ts'),
      '@estatepilot/database': path.join(repoRoot, 'packages/database/src/index.ts'),
    },
  },
});
