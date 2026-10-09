/**
 * 通知中心服务。
 */

import { Injectable, Logger } from '@nestjs/common';
import {
  NOTIFICATION_PRIORITY_RANK,
  NOTIFICATION_TYPE_LABELS,
  NotificationPriority,
  NotificationType,
  normalizePagination,
  type NotificationUnreadCount,
  type PaginatedResult,
} from '@estatepilot/types';
import { formatRelativeTime, maskPhone } from '@estatepilot/utils';
import { TenantService } from '../tenant/tenant.service.js';
import { getContext } from '../../common/context/request-context.js';
import { NotFoundError } from '../../common/filters/all-exceptions.filter.js';

/** 通知列表项（对外返回结构） */
export interface NotificationListItem {
  id: string;
  type: NotificationType;
  typeLabel: string;
  priority: NotificationPriority;
  title: string;
  body: string;
  link: string | null;
  customerId: string | null;
  customerName: string | null;
  customerPhoneMasked: string | null;
  propertyId: string | null;
  opportunityId: string | null;
  isRead: boolean;
  readAt: string | null;
  createdAt: string;
  createdAtRelative: string;
}

@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);

  constructor(private readonly tenant: TenantService) {}

  /** 通知列表（分页 + 筛选） */
  async list(filters: {
    page?: number;
    pageSize?: number;
    type?: string;
    priority?: string;
    isRead?: boolean;
  }): Promise<PaginatedResult<NotificationListItem>> {
    const context = getContext();
    if (!context?.userId) throw new Error('通知列表需要登录上下文');

    const scope = this.tenant.scope();
    const { page, pageSize, skip, take } = normalizePagination({
      page: filters.page,
      pageSize: filters.pageSize,
    });

    const where: Record<string, unknown> = { userId: context.userId };
    if (filters.type) where.type = filters.type;
    if (filters.priority) where.priority = filters.priority;
    if (filters.isRead !== undefined) where.isRead = filters.isRead;

    const [rows, total] = await Promise.all([
      scope.findMany<{
        id: string;
        type: string;
        priority: string;
        title: string;
        body: string;
        link: string | null;
        customerId: string | null;
        propertyId: string | null;
        opportunityId: string | null;
        isRead: boolean;
        readAt: Date | null;
        createdAt: Date;
        customer: { name: string; phone: string } | null;
      }>('Notification', {
        where,
        // 未读优先，其次按优先级，最后按时间
        orderBy: [{ isRead: 'asc' }, { createdAt: 'desc' }],
        skip,
        take,
        select: {
          id: true,
          type: true,
          priority: true,
          title: true,
          body: true,
          link: true,
          customerId: true,
          propertyId: true,
          opportunityId: true,
          isRead: true,
          readAt: true,
          createdAt: true,
          customer: { select: { name: true, phone: true } },
        },
      }),
      scope.count('Notification', where),
    ]);

    const now = new Date();
    const items: NotificationListItem[] = rows.map((row) => ({
      id: row.id,
      type: row.type as NotificationType,
      typeLabel: NOTIFICATION_TYPE_LABELS[row.type as NotificationType] ?? row.type,
      priority: row.priority as NotificationPriority,
      title: row.title,
      body: row.body,
      link: row.link,
      customerId: row.customerId,
      customerName: row.customer?.name ?? null,
      // 手机号始终脱敏 —— 通知列表不是查看完整联系方式的地方
      customerPhoneMasked: row.customer?.phone ? maskPhone(row.customer.phone) : null,
      propertyId: row.propertyId,
      opportunityId: row.opportunityId,
      isRead: row.isRead,
      readAt: row.readAt ? row.readAt.toISOString() : null,
      createdAt: row.createdAt.toISOString(),
      createdAtRelative: formatRelativeTime(row.createdAt, now),
    }));

    // 客户端排序：未读优先 + 优先级排序（数据库层已按 isRead 排过，这里补优先级）
    items.sort((a, b) => {
      if (a.isRead !== b.isRead) return a.isRead ? 1 : -1;
      const rankA = NOTIFICATION_PRIORITY_RANK[a.priority] ?? 0;
      const rankB = NOTIFICATION_PRIORITY_RANK[b.priority] ?? 0;
      return rankB - rankA;
    });

    const totalPages = Math.max(1, Math.ceil(total / pageSize));

    return {
      items,
      page,
      pageSize,
      total,
      totalPages,
      hasNext: page < totalPages,
      hasPrev: page > 1,
    };
  }

  /** 未读数统计（按优先级分组） */
  async unreadCount(): Promise<NotificationUnreadCount> {
    const context = getContext();
    if (!context?.userId) {
      return { total: 0, byPriority: [] };
    }

    const scope = this.tenant.scope();

    const grouped = await scope.groupBy<{ priority: string; _count: { _all: number } }>(
      'Notification',
      {
        by: ['priority'],
        where: { userId: context.userId, isRead: false },
        _count: { _all: true },
      },
    );

    const byPriority = grouped
      .map((row) => ({
        priority: row.priority as NotificationPriority,
        count: row._count._all,
      }))
      .sort(
        (a, b) =>
          (NOTIFICATION_PRIORITY_RANK[b.priority] ?? 0) - (NOTIFICATION_PRIORITY_RANK[a.priority] ?? 0),
      );

    return {
      total: byPriority.reduce((acc, item) => acc + item.count, 0),
      byPriority,
    };
  }

  /** 标记单条已读 */
  async markRead(id: string): Promise<{ success: true }> {
    const scope = this.tenant.scope();

    // update 内部会先校验归属，跨用户操作会被拒绝
    try {
      await scope.update('Notification', {
        where: { id },
        data: { isRead: true, readAt: new Date() },
      });
    } catch {
      throw new NotFoundError('通知', id);
    }

    return { success: true };
  }

  /** 全部标记已读 */
  async markAllRead(): Promise<{ updated: number }> {
    const context = getContext();
    if (!context?.userId) throw new Error('需要登录上下文');

    const scope = this.tenant.scope();
    const updated = await scope.updateMany('Notification', {
      where: { userId: context.userId, isRead: false },
      data: { isRead: true, readAt: new Date() },
    });

    this.logger.log(`用户 ${context.userId} 将 ${updated} 条通知标记为已读`);
    return { updated };
  }

  /** 删除通知 */
  async remove(id: string): Promise<{ success: true }> {
    const scope = this.tenant.scope();
    try {
      await scope.delete('Notification', { id });
    } catch {
      throw new NotFoundError('通知', id);
    }
    return { success: true };
  }
}
