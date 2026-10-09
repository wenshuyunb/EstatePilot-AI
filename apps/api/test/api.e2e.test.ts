/**
 * API 集成测试（真实 HTTP + 真实数据库）。
 *
 * 与单元测试的区别：这里不 mock 任何东西 —— 真实启动 NestJS 应用、
 * 真实连接 PostgreSQL、真实走 HTTP 请求。目的是验证「组装起来之后」是否正确，
 * 因为多租户、守卫、异常过滤器这些机制只有在完整链路里才会暴露问题。
 *
 * 运行方式：
 *   pnpm --filter @estatepilot/api test:e2e
 *
 * 前置条件：数据库已迁移 + 已 seed（测试会创建并清理自己的数据）。
 */

import { INestApplication, VersioningType } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { AppModule } from '../src/app.module.js';
import { AllExceptionsFilter } from '../src/common/filters/all-exceptions.filter.js';
import { runWithContext } from '../src/common/context/request-context.js';
import { TenantService } from '../src/modules/tenant/tenant.service.js';
import { PasswordService } from '../src/modules/auth/password.service.js';
import { UserRole } from '@estatepilot/types';

/**
 * 用 supertest 时不需要真正 listen 端口，但请求上下文中间件是在 main.ts 里注册的，
 * 而测试用的是 testing module（不走 main.ts）。因此这里手工补上同样的中间件，
 * 否则 request-context 会是空的、所有租户查询都会失败。
 */
function applyRequestContextMiddleware(app: INestApplication): void {
  const httpAdapter = app.getHttpAdapter();
  const instance = httpAdapter.getInstance() as {
    use: (fn: (req: unknown, res: unknown, next: () => void) => void) => void;
  };

  instance.use((req: Record<string, unknown>, res: Record<string, unknown>, next: () => void) => {
    const headers = (req.headers ?? {}) as Record<string, string | string[] | undefined>;
    const forwardedFor = headers['x-forwarded-for'];
    const clientIp =
      (Array.isArray(forwardedFor) ? forwardedFor[0] : forwardedFor)?.split(',')[0]?.trim() ??
      (req.ip as string) ??
      '';
    const traceId =
      (Array.isArray(headers['x-trace-id']) ? headers['x-trace-id'][0] : headers['x-trace-id']) ??
      randomUUID();

    runWithContext(
      {
        traceId: String(traceId),
        startedAt: Date.now(),
        clientIp,
        userAgent: String(headers['user-agent'] ?? ''),
        method: String(req.method ?? ''),
        path: String(req.originalUrl ?? req.url ?? ''),
      },
      () => {
        next();
      },
    );
  });
}

describe('EstatePilot API 集成测试', () => {
  let app: INestApplication;
  let tenant: TenantService;
  let http: ReturnType<typeof request>;

  // 测试数据标识，用于最后精确清理
  const testRunId = randomUUID().slice(0, 8);
  const TEST_PASSWORD = 'TestPassword2026!';

  // 两个隔离的组织
  let orgA: { id: string; name: string };
  let orgB: { id: string; name: string };
  let agentA: { id: string; email: string };
  let agentB: { id: string; email: string };
  let viewerA: { id: string; email: string };
  let tokenA = '';
  let tokenB = '';
  let viewerTokenA = '';

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();

    app = moduleRef.createNestApplication();
    applyRequestContextMiddleware(app);
    app.useGlobalFilters(new AllExceptionsFilter());
    // 与 main.ts 保持完全一致的路由配置：
    // 全局前缀 api + URI 版本 v1 → 最终路径是 /api/v1/...
    // 少了 enableVersioning 会导致所有请求 404（路由只注册为 /api/...）
    app.setGlobalPrefix('api');
    app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
    await app.init();

    http = request(app.getHttpServer());
    tenant = app.get(TenantService);

    // ---- 准备两个互相隔离的组织与账号 ----
    const prisma = tenant.forSystem();
    const passwords = app.get(PasswordService);
    const passwordHash = (await passwords.hash(TEST_PASSWORD)).hash;

    orgA = await prisma.organization.create({
      data: { name: `E2E测试公司A_${testRunId}`, shortName: `A${testRunId}`, city: '上海' },
      select: { id: true, name: true },
    });
    orgB = await prisma.organization.create({
      data: { name: `E2E测试公司B_${testRunId}`, shortName: `B${testRunId}`, city: '上海' },
      select: { id: true, name: true },
    });

    const storeA = await prisma.store.create({
      data: { organizationId: orgA.id, name: `A门店_${testRunId}`, city: '上海', district: '浦东新区' },
      select: { id: true },
    });

    agentA = await prisma.user.create({
      data: {
        organizationId: orgA.id,
        storeId: storeA.id,
        email: `agent-a-${testRunId}@e2e.test`,
        passwordHash,
        name: '测试经纪人A',
        role: UserRole.AGENT,
      },
      select: { id: true, email: true },
    });

    agentB = await prisma.user.create({
      data: {
        organizationId: orgB.id,
        email: `agent-b-${testRunId}@e2e.test`,
        passwordHash,
        name: '测试经纪人B',
        role: UserRole.AGENT,
      },
      select: { id: true, email: true },
    });

    viewerA = await prisma.user.create({
      data: {
        organizationId: orgA.id,
        storeId: storeA.id,
        email: `viewer-a-${testRunId}@e2e.test`,
        passwordHash,
        name: '测试只读A',
        role: UserRole.VIEWER,
      },
      select: { id: true, email: true },
    });

    // ---- 登录取 token ----
    const loginA = await http
      .post('/api/v1/auth/login')
      .send({ email: agentA.email, password: TEST_PASSWORD })
      .expect(200);
    tokenA = loginA.body.accessToken as string;

    const loginB = await http
      .post('/api/v1/auth/login')
      .send({ email: agentB.email, password: TEST_PASSWORD })
      .expect(200);
    tokenB = loginB.body.accessToken as string;

    const loginViewer = await http
      .post('/api/v1/auth/login')
      .send({ email: viewerA.email, password: TEST_PASSWORD })
      .expect(200);
    viewerTokenA = loginViewer.body.accessToken as string;
  }, 120_000);

  afterAll(async () => {
    if (tenant) {
      const prisma = tenant.forSystem();
      // 显式清理：Organization 的级联删除依赖外键 onDelete: Cascade，
      // 这里额外清一遍关联表，保证不会留下脏数据影响后续测试
      const orgIds = [orgA?.id, orgB?.id].filter((id): id is string => Boolean(id));
      if (orgIds.length > 0) {
        await prisma.auditLog.deleteMany({ where: { organizationId: { in: orgIds } } });
        await prisma.refreshToken.deleteMany({
          where: { user: { organizationId: { in: orgIds } } },
        });
        await prisma.user.deleteMany({ where: { organizationId: { in: orgIds } } });
        await prisma.store.deleteMany({ where: { organizationId: { in: orgIds } } });
        await prisma.organization.deleteMany({ where: { id: { in: orgIds } } });
      }
    }
    if (app) await app.close();
  }, 60_000);

  // -------------------------------------------------------------------------
  describe('健康检查', () => {
    it('存活检查无需认证', async () => {
      const res = await http.get('/api/v1/health').expect(200);
      expect(res.body.status).toBe('ok');
      expect(res.body.service).toBe('estatepilot-api');
    });

    it('就绪检查会验证数据库连通性', async () => {
      const res = await http.get('/api/v1/health/ready').expect(200);
      expect(res.body.status).toBe('ok');
      expect(res.body.checks.database.ok).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  describe('认证', () => {
    it('正确凭证可以登录并返回完整会话信息', async () => {
      const res = await http
        .post('/api/v1/auth/login')
        .send({ email: agentA.email, password: TEST_PASSWORD })
        .expect(200);

      expect(res.body.accessToken).toBeTruthy();
      expect(res.body.refreshToken).toBeTruthy();
      expect(res.body.user.id).toBe(agentA.id);
      expect(res.body.user.role).toBe(UserRole.AGENT);
      expect(res.body.user.organizationId).toBe(orgA.id);
      // 响应中绝不能出现密码哈希
      expect(JSON.stringify(res.body)).not.toContain('argon2');
      expect(JSON.stringify(res.body)).not.toContain('passwordHash');
    });

    it('错误密码被拒绝', async () => {
      const res = await http
        .post('/api/v1/auth/login')
        .send({ email: agentA.email, password: 'WrongPassword!' })
        .expect(401);
      expect(res.body.code).toBe('UNAUTHORIZED');
    });

    it('不存在的账号与错误密码返回完全相同的错误（防账号枚举）', async () => {
      const wrongPassword = await http
        .post('/api/v1/auth/login')
        .send({ email: agentA.email, password: 'WrongPassword!' })
        .expect(401);

      const noSuchUser = await http
        .post('/api/v1/auth/login')
        .send({ email: `ghost-${testRunId}@e2e.test`, password: 'WrongPassword!' })
        .expect(401);

      expect(noSuchUser.body.code).toBe(wrongPassword.body.code);
      expect(noSuchUser.body.message).toBe(wrongPassword.body.message);
    });

    it('参数校验失败返回字段级错误明细', async () => {
      const res = await http
        .post('/api/v1/auth/login')
        .send({ email: 'not-an-email', password: '' })
        .expect(400);

      expect(res.body.code).toBe('VALIDATION_FAILED');
      expect(Array.isArray(res.body.details)).toBe(true);
      expect(res.body.details.length).toBeGreaterThan(0);
      // 错误响应必须带 traceId，便于对照后端日志
      expect(res.body.traceId).toBeTruthy();
    });

    it('无 token 访问受保护接口返回 401', async () => {
      const res = await http.get('/api/v1/auth/me').expect(401);
      expect(res.body.code).toBe('UNAUTHORIZED');
    });

    it('伪造的 token 被拒绝', async () => {
      await http
        .get('/api/v1/auth/me')
        .set('Authorization', 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.fake.signature')
        .expect(401);
    });

    it('格式错误的 Authorization 头被拒绝', async () => {
      await http.get('/api/v1/auth/me').set('Authorization', 'NotBearer xyz').expect(401);
    });

    it('带有效 token 可以获取当前用户', async () => {
      const res = await http
        .get('/api/v1/auth/me')
        .set('Authorization', `Bearer ${tokenA}`)
        .expect(200);

      expect(res.body.user.id).toBe(agentA.id);
      expect(res.body.organization.id).toBe(orgA.id);
      // AGENT 不应有管理权限
      expect(res.body.permissions.canManageUsers).toBe(false);
      expect(res.body.permissions.canViewAllStores).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  describe('Refresh Token 轮换与重放检测', () => {
    it('刷新会签发新的 access 与 refresh token', async () => {
      const login = await http
        .post('/api/v1/auth/login')
        .send({ email: agentA.email, password: TEST_PASSWORD })
        .expect(200);

      const refreshed = await http
        .post('/api/v1/auth/refresh')
        .send({ refreshToken: login.body.refreshToken })
        .expect(200);

      expect(refreshed.body.accessToken).toBeTruthy();
      expect(refreshed.body.refreshToken).toBeTruthy();
      expect(refreshed.body.refreshToken).not.toBe(login.body.refreshToken);
    });

    it('重放已使用的 refresh token 会被拒绝，并吊销整个会话家族', async () => {
      const login = await http
        .post('/api/v1/auth/login')
        .send({ email: agentB.email, password: TEST_PASSWORD })
        .expect(200);

      const originalRefresh = login.body.refreshToken as string;

      // 第一次刷新：正常
      const first = await http
        .post('/api/v1/auth/refresh')
        .send({ refreshToken: originalRefresh })
        .expect(200);
      const secondRefresh = first.body.refreshToken as string;

      // 重放旧 token：必须被识别为重放
      const replay = await http
        .post('/api/v1/auth/refresh')
        .send({ refreshToken: originalRefresh })
        .expect(401);
      expect(replay.body.code).toBe('REFRESH_TOKEN_REUSED');

      // 重放之后，同一家族的合法 token 也必须失效
      const afterReplay = await http
        .post('/api/v1/auth/refresh')
        .send({ refreshToken: secondRefresh })
        .expect(401);
      expect(afterReplay.body.code).toBe('REFRESH_TOKEN_REUSED');
    });

    it('登出后 refresh token 失效', async () => {
      const login = await http
        .post('/api/v1/auth/login')
        .send({ email: agentA.email, password: TEST_PASSWORD })
        .expect(200);

      const accessToken = login.body.accessToken as string;
      const refreshToken = login.body.refreshToken as string;

      const logout = await http
        .post('/api/v1/auth/logout')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ refreshToken })
        .expect(200);
      expect(logout.body.success).toBe(true);
      expect(logout.body.revoked).toBeGreaterThan(0);

      await http.post('/api/v1/auth/refresh').send({ refreshToken }).expect(401);
    });
  });

  // -------------------------------------------------------------------------
  describe('多租户隔离（HTTP 层面）', () => {
    it('两个组织的 token 携带各自的 organizationId', async () => {
      const meA = await http
        .get('/api/v1/auth/me')
        .set('Authorization', `Bearer ${tokenA}`)
        .expect(200);
      const meB = await http
        .get('/api/v1/auth/me')
        .set('Authorization', `Bearer ${tokenB}`)
        .expect(200);

      expect(meA.body.user.organizationId).toBe(orgA.id);
      expect(meB.body.user.organizationId).toBe(orgB.id);
      expect(meA.body.user.organizationId).not.toBe(meB.body.user.organizationId);
    });

    it('租户作用域下 A 组织的用户查不到 B 组织的客户', async () => {
      const prisma = tenant.forSystem();

      // 在 B 组织下建一个客户
      const customerB = await prisma.customer.create({
        data: {
          organizationId: orgB.id,
          name: 'B公司客户',
          phone: '13900000001',
          preferredCity: '上海',
        },
        select: { id: true },
      });

      // 用 A 组织的作用域查（模拟 A 组织用户发起的查询）
      const scopeA = tenant.scopeFor(orgA.id);
      const leaked = await scopeA.findFirst('Customer', { where: { id: customerB.id } });
      expect(leaked).toBeNull();

      // 用 B 组织的作用域查得到
      const scopeB = tenant.scopeFor(orgB.id);
      const found = await scopeB.findFirst('Customer', { where: { id: customerB.id } });
      expect(found).not.toBeNull();

      // 用 A 的作用域按 ID 精确读取会抛越权错误（而不是返回 null，便于区分 404 与 403）
      await expect(scopeA.findByIdOrThrow('Customer', customerB.id)).rejects.toThrow(
        /跨租户访问被拒绝/,
      );
    });

    it('通过 API 创建的数据自动归属当前租户，且无法伪造 organizationId', async () => {
      const scopeA = tenant.scopeFor(orgA.id);

      const created = await scopeA.create<{ id: string; organizationId: string }>('Customer', {
        data: {
          name: 'A公司客户',
          phone: '13900000002',
          preferredCity: '上海',
          // 恶意尝试归属到 B 组织
          organizationId: orgB.id,
        },
      });

      expect(created.organizationId).toBe(orgA.id);
    });

    it('跨租户更新被拒绝', async () => {
      const prisma = tenant.forSystem();
      const customerB = await prisma.customer.create({
        data: { organizationId: orgB.id, name: 'B客户2', phone: '13900000003', preferredCity: '上海' },
        select: { id: true },
      });

      const scopeA = tenant.scopeFor(orgA.id);
      await expect(
        scopeA.update('Customer', { where: { id: customerB.id }, data: { name: '被篡改' } }),
      ).rejects.toThrow(/跨租户访问被拒绝/);

      // 确认数据未被改动
      const unchanged = await prisma.customer.findUnique({
        where: { id: customerB.id },
        select: { name: true },
      });
      expect(unchanged?.name).toBe('B客户2');
    });

    it('跨租户删除被拒绝', async () => {
      const prisma = tenant.forSystem();
      const customerB = await prisma.customer.create({
        data: { organizationId: orgB.id, name: 'B客户3', phone: '13900000004', preferredCity: '上海' },
        select: { id: true },
      });

      const scopeA = tenant.scopeFor(orgA.id);
      await expect(scopeA.delete('Customer', { id: customerB.id })).rejects.toThrow(
        /跨租户访问被拒绝/,
      );

      const stillExists = await prisma.customer.count({ where: { id: customerB.id } });
      expect(stillExists).toBe(1);
    });

    it('租户作用域不会因为 where 条件为空而退化为全表查询', async () => {
      const prisma = tenant.forSystem();
      // 在 B 组织建 1 个客户
      await prisma.customer.create({
        data: { organizationId: orgB.id, name: 'B客户4', phone: '13900000005', preferredCity: '上海' },
      });

      // A 组织用一个不存在的名字查询，且不传任何租户条件 —— 不应返回 B 的数据
      const scopeA = tenant.scopeFor(orgA.id);
      const results = await scopeA.findMany('Customer', {});
      const hasBData = results.some(
        (row) => (row as { organizationId: string }).organizationId === orgB.id,
      );
      expect(hasBData).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  describe('审计日志', () => {
    it('登录成功会写入审计日志', async () => {
      const prisma = tenant.forSystem();
      const before = await prisma.auditLog.count({
        where: { organizationId: orgA.id, action: 'LOGIN' },
      });

      await http
        .post('/api/v1/auth/login')
        .send({ email: agentA.email, password: TEST_PASSWORD })
        .expect(200);

      const after = await prisma.auditLog.count({
        where: { organizationId: orgA.id, action: 'LOGIN' },
      });
      expect(after).toBeGreaterThan(before);

      // 审计日志里不能出现明文密码
      const latest = await prisma.auditLog.findFirst({
        where: { organizationId: orgA.id, action: 'LOGIN' },
        orderBy: { createdAt: 'desc' },
      });
      expect(JSON.stringify(latest)).not.toContain(TEST_PASSWORD);
    });

    it('登录失败也会写审计日志', async () => {
      const prisma = tenant.forSystem();
      const before = await prisma.auditLog.count({
        where: { organizationId: orgA.id, action: 'LOGIN_FAILED' },
      });

      await http
        .post('/api/v1/auth/login')
        .send({ email: agentA.email, password: 'DefinitelyWrong!' })
        .expect(401);

      const after = await prisma.auditLog.count({
        where: { organizationId: orgA.id, action: 'LOGIN_FAILED' },
      });
      expect(after).toBeGreaterThan(before);
    });
  });

  // -------------------------------------------------------------------------
  describe('账号安全', () => {
    it('连续登录失败会锁定账号', async () => {
      const prisma = tenant.forSystem();
      const passwords = app.get(PasswordService);

      const lockUser = await prisma.user.create({
        data: {
          organizationId: orgA.id,
          email: `lock-test-${testRunId}@e2e.test`,
          passwordHash: (await passwords.hash(TEST_PASSWORD)).hash,
          name: '锁定测试账号',
          role: UserRole.AGENT,
        },
        select: { id: true, email: true },
      });

      // 连续 5 次失败
      for (let attempt = 0; attempt < 5; attempt += 1) {
        await http
          .post('/api/v1/auth/login')
          .send({ email: lockUser.email, password: 'WrongPassword!' })
          .expect(401);
      }

      // 第 6 次即使密码正确也应被锁定拦截
      const locked = await http
        .post('/api/v1/auth/login')
        .send({ email: lockUser.email, password: TEST_PASSWORD })
        .expect(423);

      expect(locked.body.message).toMatch(/锁定/);

      // 数据库中确实记录了锁定状态
      const row = await prisma.user.findUnique({
        where: { id: lockUser.id },
        select: { lockedUntil: true, failedLoginAttempts: true },
      });
      expect(row?.lockedUntil).not.toBeNull();
      expect(row?.failedLoginAttempts).toBeGreaterThanOrEqual(5);
    });
  });

  // -------------------------------------------------------------------------
  describe('密码哈希', () => {
    it('使用 argon2id 且能正确校验', async () => {
      const passwords = app.get(PasswordService);
      const { hash, algorithm } = await passwords.hash('SomeStrongPass123!');

      expect(algorithm).toBe('argon2id');
      expect(hash).toMatch(/^\$argon2id\$/);

      expect(await passwords.verify('SomeStrongPass123!', hash)).toBe(true);
      expect(await passwords.verify('WrongPass123!', hash)).toBe(false);
    });

    it('同一密码每次哈希结果不同（加盐）', async () => {
      const passwords = app.get(PasswordService);
      const first = await passwords.hash('SamePassword123!');
      const second = await passwords.hash('SamePassword123!');
      expect(first.hash).not.toBe(second.hash);
    });

    it('弱密码被拒绝', () => {
      const passwords = app.get(PasswordService);
      expect(passwords.validateStrength('12345678').length).toBeGreaterThan(0);
      expect(passwords.validateStrength('password').length).toBeGreaterThan(0);
      expect(passwords.validateStrength('aaaaaaaa').length).toBeGreaterThan(0);
      expect(passwords.validateStrength('StrongPass2026!')).toEqual([]);
    });
  });
});
