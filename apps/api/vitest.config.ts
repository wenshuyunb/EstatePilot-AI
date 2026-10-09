import { defineConfig } from 'vitest/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');

export default defineConfig({
  test: {
    globals: false,
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // E2E 测试单独用 vitest.e2e.config.ts，避免单元测试误跑
    exclude: ['node_modules', 'dist', 'test/**'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    reporters: ['default'],
    // 单元测试串行执行，避免多个测试同时抢数据库连接
    fileParallelism: false,
  },
  resolve: {
    alias: {
      // 直接指向 monorepo 内部包源码，避免依赖预先构建的 dist
      '@estatepilot/types': path.join(repoRoot, 'packages/types/src/index.ts'),
      '@estatepilot/utils': path.join(repoRoot, 'packages/utils/src/index.ts'),
      '@estatepilot/ai': path.join(repoRoot, 'packages/ai/src/index.ts'),
      '@estatepilot/database': path.join(repoRoot, 'packages/database/src/index.ts'),
    },
  },
});
