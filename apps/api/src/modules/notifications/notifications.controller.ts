/**
 * 通知中心控制器。
 */

import { Controller, Delete, Get, HttpCode, HttpStatus, Param, Patch, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { NotificationPriority, NotificationType, type NotificationUnreadCount, type PaginatedResult } from '@estatepilot/types';
import { NotificationsService, type NotificationListItem } from './notifications.service.js';
import { ZodQuery } from '../../common/pipes/zod-validation.pipe.js';
import { CurrentUser, type RequestUser } from '../../common/decorators/auth.decorators.js';

/** 列表查询参数 */
const listQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  type: z.nativeEnum(NotificationType).optional(),
  priority: z.nativeEnum(NotificationPriority).optional(),
  /** 传 'true'/'false' 过滤已读状态；不传则全部 */
  isRead: z
    .enum(['true', 'false'])
    .transform((value) => value === 'true')
    .optional(),
});

type ListQuery = z.infer<typeof listQuerySchema>;

@Controller('notifications')
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  /** 通知列表 */
  @Get()
  async list(@Query(ZodQuery(listQuerySchema)) query: ListQuery): Promise<PaginatedResult<NotificationListItem>> {
    return this.notifications.list(query);
  }

  /**
   * 未读数。
   * 路径放在 /:id 之前注册，否则 'unread-count' 会被当成 id 匹配。
   */
  @Get('unread-count')
  async unreadCount(): Promise<NotificationUnreadCount> {
    return this.notifications.unreadCount();
  }

  /** 全部标记已读 */
  @Post('read-all')
  @HttpCode(HttpStatus.OK)
  async markAllRead(): Promise<{ updated: number }> {
    return this.notifications.markAllRead();
  }

  /** 标记单条已读 */
  @Patch(':id/read')
  @HttpCode(HttpStatus.OK)
  async markRead(@Param('id') id: string): Promise<{ success: true }> {
    return this.notifications.markRead(id);
  }

  /** 删除通知 */
  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  async remove(@Param('id') id: string, @CurrentUser() _user: RequestUser): Promise<{ success: true }> {
    return this.notifications.remove(id);
  }
}
