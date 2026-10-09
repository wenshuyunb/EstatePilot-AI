'use client';

/**
 * 登录页。
 *
 * 设计取向：克制、专业。左侧是产品价值说明（不是营销海报），
 * 右侧是登录表单。演示账号明确列出，便于试用。
 */

import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Building2, Loader2, Sparkles, TrendingUp, Users } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/primitives';
import { useAuthStore } from '@/lib/auth-store';

/** 演示账号（与种子脚本一致） */
const DEMO_ACCOUNTS = [
  { email: 'owner1@estatepilot.demo', label: '公司负责人', desc: '可看全部门店数据' },
  { email: 'manager11@estatepilot.demo', label: '门店店长', desc: '门店驾驶舱视角' },
  { email: 'agent111@estatepilot.demo', label: '经纪人', desc: '日常工作台视角' },
];

const DEMO_PASSWORD = 'EstatePilot2026!';

export default function LoginPage() {
  const router = useRouter();
  const { login, loading, error, clearError, user, initialized } = useAuthStore();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');

  // 已登录用户直接进工作台
  useEffect(() => {
    if (initialized && user) {
      router.replace('/dashboard');
    }
  }, [initialized, user, router]);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    clearError();
    try {
      await login(email.trim(), password);
      router.replace('/dashboard');
    } catch {
      // 错误已由 store 记录并展示
    }
  }

  /** 一键填充演示账号，降低试用门槛 */
  function fillDemo(demoEmail: string) {
    setEmail(demoEmail);
    setPassword(DEMO_PASSWORD);
    clearError();
  }

  return (
    <div className="grid min-h-dvh lg:grid-cols-2">
      {/* ---- 左侧：产品价值说明 ---- */}
      <div className="hidden flex-col justify-between border-r border-border bg-surface p-10 lg:flex">
        <div className="flex items-center gap-2">
          <div className="flex size-8 items-center justify-center rounded-lg bg-brand text-white">
            <Building2 className="size-4.5" />
          </div>
          <div>
            <p className="text-sm font-semibold text-ink">EstatePilot AI</p>
            <p className="text-2xs text-ink-muted">房产 AI 成交助手</p>
          </div>
        </div>

        <div className="max-w-md">
          <h1 className="text-3xl font-semibold leading-snug tracking-tight text-ink">
            让经纪人每天知道
            <br />
            <span className="text-brand">最应该联系谁</span>
          </h1>
          <p className="mt-3 text-sm leading-relaxed text-ink-tertiary">
            传统 CRM 只负责记录客户。EstatePilot 通过客户真实浏览行为、房源价格变化与 AI
            分析，主动告诉经纪人今天该联系谁、推荐什么房、下一步怎么推进。
          </p>

          <ul className="mt-8 space-y-4">
            {[
              {
                icon: Users,
                title: '看见客户真正想要什么',
                desc: '客户嘴上说 500 万，行为却在看 560 万的房子 —— 系统会告诉你这个差距。',
              },
              {
                icon: TrendingUp,
                title: '第一时间发现成交机会',
                desc: '客户关注的房源降价 30 万、沉睡客户重新活跃，系统立刻提醒并给出话术。',
              },
              {
                icon: Sparkles,
                title: 'AI 副驾驶而不是报表工具',
                desc: '每天打开首页看到的不是客户总数，而是「今天 AI 帮你发现了什么」。',
              },
            ].map((item) => (
              <li key={item.title} className="flex gap-3">
                <div className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-md border border-border bg-surface-subtle">
                  <item.icon className="size-3.5 text-ink-secondary" />
                </div>
                <div>
                  <p className="text-sm font-medium text-ink">{item.title}</p>
                  <p className="mt-0.5 text-xs leading-relaxed text-ink-tertiary">{item.desc}</p>
                </div>
              </li>
            ))}
          </ul>
        </div>

        <p className="text-2xs text-ink-muted">
          房源数据为程序生成的演示数据，不代表任何真实在售房源。
        </p>
      </div>

      {/* ---- 右侧：登录表单 ---- */}
      <div className="flex items-center justify-center p-6">
        <div className="w-full max-w-sm">
          {/* 移动端顶部标识 */}
          <div className="mb-6 flex items-center gap-2 lg:hidden">
            <div className="flex size-8 items-center justify-center rounded-lg bg-brand text-white">
              <Building2 className="size-4.5" />
            </div>
            <div>
              <p className="text-sm font-semibold text-ink">EstatePilot AI</p>
              <p className="text-2xs text-ink-muted">房产 AI 成交助手</p>
            </div>
          </div>

          <h2 className="text-xl font-semibold tracking-tight text-ink">登录工作台</h2>
          <p className="mt-1 text-xs text-ink-tertiary">使用您的企业邮箱登录</p>

          <form onSubmit={handleSubmit} className="mt-6 space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="email" required>
                邮箱
              </Label>
              <Input
                id="email"
                type="email"
                autoComplete="username"
                placeholder="you@company.com"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                required
                aria-invalid={Boolean(error)}
                disabled={loading}
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="password" required>
                密码
              </Label>
              <Input
                id="password"
                type="password"
                autoComplete="current-password"
                placeholder="请输入密码"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                required
                aria-invalid={Boolean(error)}
                disabled={loading}
              />
            </div>

            {error && (
              <div
                role="alert"
                className="rounded-md border border-danger-border bg-danger-subtle px-3 py-2 text-xs text-danger"
              >
                {error}
              </div>
            )}

            <Button type="submit" className="w-full" size="lg" loading={loading}>
              {loading ? '登录中…' : '登录'}
            </Button>
          </form>

          {/* ---- 演示账号 ---- */}
          <div className="mt-6 rounded-lg border border-border bg-surface-subtle p-3">
            <p className="text-2xs font-medium text-ink-secondary">演示账号（点击自动填充）</p>
            <div className="mt-2 space-y-1">
              {DEMO_ACCOUNTS.map((account) => (
                <button
                  key={account.email}
                  type="button"
                  onClick={() => fillDemo(account.email)}
                  disabled={loading}
                  className="flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left transition-colors hover:bg-surface disabled:opacity-50"
                >
                  <span className="min-w-0">
                    <span className="block truncate text-2xs font-medium text-ink">
                      {account.label}
                    </span>
                    <span className="block truncate text-2xs text-ink-muted">{account.email}</span>
                  </span>
                  <span className="ml-2 shrink-0 text-2xs text-ink-muted">{account.desc}</span>
                </button>
              ))}
            </div>
            <p className="mt-2 border-t border-border pt-2 text-2xs text-ink-muted">
              统一密码：<code className="font-mono text-ink-secondary">{DEMO_PASSWORD}</code>
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
