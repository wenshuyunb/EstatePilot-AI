/**
 * 迁移辅助脚本。
 *
 * 为什么需要它：Prisma 7 移除了 `migrate dev --name`。
 * 官方推荐流程是：
 *   1. prisma migrate diff --from-migrations ... --to-schema ... --script --output <file>
 *   2. prisma migrate deploy
 * 本脚本把这两步封装成一条命令，并自动生成带时间戳的迁移目录。
 *
 * 用法：
 *   pnpm --filter @estatepilot/database migrate "add_customer_index"
 *   pnpm --filter @estatepilot/database migrate            # 自动命名
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import 'dotenv/config';

const here = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = path.resolve(here, '..', '..');
const prismaDir = path.join(pkgRoot, 'prisma');
const migrationsDir = path.join(prismaDir, 'migrations');
const schemaPath = path.join(prismaDir, 'schema.prisma');

/** 执行命令并把输出直接透传到父进程的 stdio */
function run(command: string, args: string[], options: { allowFailure?: boolean } = {}): number {
  try {
    execFileSync(command, args, { cwd: pkgRoot, stdio: 'inherit', shell: process.platform === 'win32' });
    return 0;
  } catch (error) {
    const status = typeof error === 'object' && error !== null && 'status' in error ? Number((error as { status?: number }).status ?? 1) : 1;
    if (options.allowFailure) return status;
    process.exit(status || 1);
  }
}

/** 生成时间戳前缀，格式与 Prisma 一致：YYYYMMDDHHMMSS */
function migrationTimestamp(): string {
  const now = new Date();
  const pad = (value: number, width = 2) => String(value).padStart(width, '0');
  return (
    `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}` +
    `${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}`
  );
}

/** 读取已有迁移目录，供 from-migrations 使用 */
function listMigrationDirs(): string[] {
  if (!existsSync(migrationsDir)) return [];
  return readdirSync(migrationsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^\d{14}_/.test(entry.name))
    .map((entry) => entry.name)
    .sort();
}

function main(): void {
  const rawName = process.argv[2] ?? 'migration';
  const safeName = rawName
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 60) || 'migration';

  const existing = listMigrationDirs();
  const dirName = `${migrationTimestamp()}_${safeName}`;
  const targetDir = path.join(migrationsDir, dirName);

  console.log(`\n[estatepilot:migrate] 目标迁移目录: prisma/migrations/${dirName}`);
  console.log(`[estatepilot:migrate] 已有迁移数: ${existing.length}`);

  if (!existsSync(targetDir)) mkdirSync(targetDir, { recursive: true });
  const outputFile = path.join(targetDir, 'migration.sql');

  // 基线：从空库开始，或从最后一次迁移快照开始
  const fromArgs = existing.length === 0
    ? ['--from-empty']
    : ['--from-migrations', migrationsDir];

  console.log('[estatepilot:migrate] 生成 SQL ...');
  const diffStatus = run('prisma', [
    'migrate',
    'diff',
    ...fromArgs,
    '--to-schema',
    schemaPath,
    '--script',
    '--output',
    outputFile,
  ]);

  if (diffStatus !== 0) {
    console.error('[estatepilot:migrate] 生成 SQL 失败');
    process.exit(diffStatus);
  }

  // Prisma 在没有差异时会生成空文件；不要留下空迁移
  const content = existsSync(outputFile) ? readFileSync(outputFile, 'utf8') : '';
  if (content.trim().length === 0) {
    console.log('[estatepilot:migrate] 没有检测到 schema 变化，已删除空迁移目录');
    try {
      // 目录为空，直接删除
      execFileSync(process.platform === 'win32' ? 'cmd' : 'rm', process.platform === 'win32' ? ['/c', 'rmdir', targetDir] : ['-rf', targetDir], { stdio: 'ignore' });
    } catch {
      /* 忽略清理失败 */
    }
    process.exit(0);
  }

  console.log(`[estatepilot:migrate] SQL 已生成 (${content.length} 字节)`);

  console.log('[estatepilot:migrate] 应用到数据库 ...');
  const deployStatus = run('prisma', ['migrate', 'deploy']);
  if (deployStatus !== 0) {
    console.error('[estatepilot:migrate] 应用迁移失败');
    process.exit(deployStatus);
  }

  console.log('[estatepilot:migrate] 重新生成 Prisma Client ...');
  run('prisma', ['generate']);

  console.log('[estatepilot:migrate] 完成 ✅\n');
}

main();

/** 写入文件（供后续扩展使用） */
export function writeMigrationFile(file: string, content: string): void {
  writeFileSync(file, content, 'utf8');
}
