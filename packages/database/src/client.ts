/**
 * Prisma Client 工厂。
 *
 * Prisma 7 必须使用驱动适配器（driver adapter），不能直接 new PrismaClient()。
 * 生成的客户端是 TypeScript 源码，位于本包的 src/generated/prisma 下并参与编译。
 */

import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from './generated/prisma/client.js';

export interface CreatePrismaClientOptions {
  connectionString: string;
  /** 是否打印 SQL，开发排查 N+1 时打开 */
  logQueries?: boolean;
  /** 连接池上限 */
  maxConnections?: number;
  /** 连接空闲超时（毫秒） */
  idleTimeoutMillis?: number;
  /** 建立连接超时（毫秒） */
  connectionTimeoutMillis?: number;
  /** 应用名，出现在 pg_stat_activity 中，便于排查慢查询来源 */
  applicationName?: string;
}

/**
 * 创建 PrismaClient 实例。
 *
 * 连接池说明：本机 PostgreSQL 容器 max_connections=200，
 * API 进程与队列 Worker 各自持有一个池，默认上限 10 足够。
 */
export function createPrismaClient(options: CreatePrismaClientOptions): PrismaClient {
  const adapter = new PrismaPg({
    connectionString: options.connectionString,
    max: options.maxConnections ?? 10,
    idleTimeoutMillis: options.idleTimeoutMillis ?? 30_000,
    connectionTimeoutMillis: options.connectionTimeoutMillis ?? 10_000,
    application_name: options.applicationName ?? 'estatepilot',
  });

  const client = new PrismaClient({
    adapter,
    log: options.logQueries
      ? [
          { emit: 'event', level: 'query' },
          { emit: 'stdout', level: 'warn' },
          { emit: 'stdout', level: 'error' },
        ]
      : [
          { emit: 'stdout', level: 'warn' },
          { emit: 'stdout', level: 'error' },
        ],
  });

  return client;
}

export type { PrismaClient };
