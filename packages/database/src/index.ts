/**
 * @estatepilot/database
 *
 * Prisma Client 工厂、多租户作用域与数据库类型导出。
 *
 * 使用约定（务必遵守，这是防止串库的第一道防线）：
 *
 *   // 正确：通过租户作用域访问
 *   const scope = createTenantScope(prisma, { organizationId: user.org });
 *   const customers = await scope.findMany('Customer', { where: { status: 'NEW' } });
 *
 *   // 错误：直连 Prisma 且未带 organizationId
 *   await prisma.customer.findMany();
 *
 * 需要跨租户时，必须显式调用 scope.unsafeRaw() 并在代码注释里说明理由。
 */

export * from './client.js';
export * from './tenant-scope.js';
export type { PrismaClient, Prisma } from './generated/prisma/client.js';
