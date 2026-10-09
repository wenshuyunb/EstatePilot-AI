'use client';

/**
 * 侧边栏导航（桌面端）。
 *
 * 导航结构按「经纪人每天的工作动线」组织，而不是按数据表：
 *   工作台（今天做什么）→ 客户（理解客户）→ 房源（找房）→ 匹配/机会（AI 发现）
 *   → 带看/任务（执行）→ 通知
 *
 * 管理类入口（门店驾驶舱、超管后台）按角色条件显示。
 */

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  Bell,
  Building2,
  CalendarCheck,
  ChevronRight,
  FolderSearch,
  LayoutDashboard,
  ListChecks,
  MessageSquare,
  Settings,
  Shield,
  Sparkles,
  Target,
  Users,
  Zap,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { useAuthStore } from '@/lib/auth-store';
import { useUnreadCount } from '@/lib/queries/use-notifications';

interface NavItem {
  href: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  /** 需要在客户端动态计算的徽标（如未读数） */
  badge?: 'unread-notifications' | 'open-opportunities';
  /** 仅这些角色可见 */
  roles?: string[];
}

interface NavSection {
  title: string;
  items: NavItem[];
}

/** 主导航：经纪人每天的核心动线 */
const PRIMARY_NAV: NavSection[] = [
  {
    title: '今日',
    items: [
      { href: '/dashboard', label: '工作台', icon: LayoutDashboard },
      { href: '/opportunities', label: '销售机会', icon: Zap, badge: 'open-opportunities' },
      { href: '/tasks', label: '待办任务', icon: ListChecks },
      { href: '/notifications', label: '通知中心', icon: Bell, badge: 'unread-notifications' },
    ],
  },
  {
    title: '客户与房源',
    items: [
      { href: '/customers', label: '客户管理', icon: Users },
      { href: '/properties', label: '房源库', icon: Building2 },
      { href: '/matches', label: '智能匹配', icon: Target },
      { href: '/search', label: '全局搜索', icon: FolderSearch },
    ],
  },
  {
    title: '执行',
    items: [
      { href: '/viewings', label: '带看管理', icon: CalendarCheck },
      { href: '/messages', label: '沟通记录', icon: MessageSquare },
      { href: '/ai', label: 'AI 助手', icon: Sparkles },
    ],
  },
];

/** 管理导航：按角色显示 */
const ADMIN_NAV: NavSection[] = [
  {
    title: '管理',
    items: [
      {
        href: '/manager',
        label: '门店驾驶舱',
        icon: Target,
        roles: ['OWNER', 'STORE_MANAGER', 'SUPER_ADMIN'],
      },
      { href: '/settings', label: '设置', icon: Settings },
      { href: '/admin', label: '平台后台', icon: Shield, roles: ['SUPER_ADMIN', 'OWNER'] },
    ],
  },
];

export function Sidebar() {
  const pathname = usePathname();
  const user = useAuthStore((state) => state.user);
  const { data: unread } = useUnreadCount();

  const role = user?.role ?? 'AGENT';

  /** 判断导航项是否可见 */
  function isVisible(item: NavItem): boolean {
    if (!item.roles) return true;
    return item.roles.includes(role);
  }

  /** 判断是否处于激活态：精确匹配或作为父路径 */
  function isActive(href: string): boolean {
    if (pathname === href) return true;
    // /customers/xxx 时 /customers 也应高亮
    return pathname.startsWith(`${href}/`);
  }

  function renderBadge(item: NavItem): React.ReactNode {
    if (item.badge === 'unread-notifications' && unread && unread.total > 0) {
      return (
        <span className="ml-auto flex min-w-4.5 items-center justify-center rounded-full bg-danger px-1 text-2xs font-semibold text-white">
          {unread.total > 99 ? '99+' : unread.total}
        </span>
      );
    }
    return null;
  }

  const sections = [...PRIMARY_NAV, ...ADMIN_NAV];

  return (
    <aside className="hidden w-56 shrink-0 flex-col border-r border-border bg-surface lg:flex">
      {/* 品牌标识 */}
      <div className="flex h-12 items-center gap-2 border-b border-border px-3">
        <div className="flex size-6.5 items-center justify-center rounded-md bg-brand text-white">
          <Building2 className="size-3.5" />
        </div>
        <div className="min-w-0">
          <p className="truncate text-xs font-semibold text-ink">EstatePilot AI</p>
          <p className="truncate text-2xs text-ink-muted">
            {useAuthStore.getState().organization?.shortName ?? '房产 AI 成交助手'}
          </p>
        </div>
      </div>

      {/* 导航 */}
      <nav className="flex-1 overflow-y-auto px-2 py-3">
        {sections.map((section) => {
          const visibleItems = section.items.filter(isVisible);
          if (visibleItems.length === 0) return null;

          return (
            <div key={section.title} className="mb-4 last:mb-0">
              <p className="px-2 pb-1.5 text-2xs font-semibold uppercase tracking-wide text-ink-muted">
                {section.title}
              </p>
              <ul className="space-y-0.5">
                {visibleItems.map((item) => {
                  const active = isActive(item.href);
                  return (
                    <li key={item.href}>
                      <Link
                        href={item.href}
                        className={cn(
                          'group flex items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors',
                          active
                            ? 'bg-brand-subtle font-medium text-brand'
                            : 'text-ink-secondary hover:bg-surface-hover hover:text-ink',
                        )}
                        aria-current={active ? 'page' : undefined}
                      >
                        <item.icon
                          className={cn('size-4 shrink-0', active ? 'text-brand' : 'text-ink-muted')}
                        />
                        <span className="truncate">{item.label}</span>
                        {renderBadge(item)}
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </div>
          );
        })}
      </nav>
    </aside>
  );
}

/** 移动端底部导航（需求文档 §38 要求） */
export function MobileBottomNav() {
  const pathname = usePathname();
  const { data: unread } = useUnreadCount();

  // 移动端只保留最高频的 5 个入口
  const items: NavItem[] = [
    { href: '/dashboard', label: '工作台', icon: LayoutDashboard },
    { href: '/customers', label: '客户', icon: Users },
    { href: '/properties', label: '房源', icon: Building2 },
    { href: '/opportunities', label: '机会', icon: Zap },
    { href: '/notifications', label: '通知', icon: Bell, badge: 'unread-notifications' },
  ];

  return (
    <nav className="fixed inset-x-0 bottom-0 z-40 border-t border-border bg-surface pb-[env(safe-area-inset-bottom)] lg:hidden">
      <ul className="flex">
        {items.map((item) => {
          const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
          const badgeCount =
            item.badge === 'unread-notifications' && unread ? unread.total : 0;

          return (
            <li key={item.href} className="flex-1">
              <Link
                href={item.href}
                className={cn(
                  'relative flex flex-col items-center gap-0.5 py-2 transition-colors',
                  active ? 'text-brand' : 'text-ink-muted',
                )}
                aria-current={active ? 'page' : undefined}
              >
                <item.icon className="size-4.5" />
                <span className="text-2xs">{item.label}</span>
                {badgeCount > 0 && (
                  <span className="absolute right-1/4 top-1 flex min-w-4 items-center justify-center rounded-full bg-danger px-1 text-[10px] font-semibold leading-4 text-white">
                    {badgeCount > 99 ? '99+' : badgeCount}
                  </span>
                )}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

/** 顶部栏：面包屑 + 用户菜单 */
export function Topbar() {
  const user = useAuthStore((state) => state.user);
  const organization = useAuthStore((state) => state.organization);
  const logout = useAuthStore((state) => state.logout);

  // 简化的面包屑：只用路径名，具体标题由各页面自己渲染
  const pathname = usePathname();
  const currentSection = pathname.split('/')[1] ?? 'dashboard';

  const sectionLabels: Record<string, string> = {
    dashboard: '工作台',
    customers: '客户管理',
    properties: '房源库',
    matches: '智能匹配',
    opportunities: '销售机会',
    viewings: '带看管理',
    tasks: '待办任务',
    messages: '沟通记录',
    notifications: '通知中心',
    ai: 'AI 助手',
    settings: '设置',
    manager: '门店驾驶舱',
    admin: '平台后台',
    search: '全局搜索',
  };

  return (
    <header className="flex h-12 shrink-0 items-center justify-between gap-3 border-b border-border bg-surface px-4">
      <div className="flex min-w-0 items-center gap-2">
        <span className="text-sm font-medium text-ink">
          {sectionLabels[currentSection] ?? '工作台'}
        </span>
        {organization?.shortName && (
          <>
            <ChevronRight className="size-3.5 text-ink-muted" />
            <span className="truncate text-xs text-ink-tertiary">{organization.shortName}</span>
          </>
        )}
      </div>

      <div className="flex items-center gap-2">
        <div className="hidden text-right sm:block">
          <p className="text-xs font-medium leading-tight text-ink">{user?.name ?? '未登录'}</p>
          <p className="text-2xs leading-tight text-ink-muted">
            {user?.role === 'OWNER'
              ? '公司负责人'
              : user?.role === 'STORE_MANAGER'
                ? '门店店长'
                : user?.role === 'AGENT'
                  ? '经纪人'
                  : user?.role === 'VIEWER'
                    ? '只读成员'
                    : '平台管理员'}
          </p>
        </div>

        <button
          type="button"
          onClick={() => {
            void logout();
          }}
          className="rounded-md border border-border px-2 py-1 text-xs text-ink-secondary transition-colors hover:bg-surface-hover hover:text-ink"
        >
          退出
        </button>
      </div>
    </header>
  );
}
