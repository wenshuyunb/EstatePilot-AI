/**
 * 工作台控制器。
 *
 * GET /dashboard       经纪人工作台（今天做什么）
 * GET /dashboard/store 门店驾驶舱（店长/负责人）
 */

import { Controller, Get, Query } from '@nestjs/common';
import { UserRole, type AgentDashboard, type StoreDashboard } from '@estatepilot/types';
import { DashboardService } from './dashboard.service.js';
import { Roles } from '../../common/decorators/auth.decorators.js';

@Controller('dashboard')
export class DashboardController {
  constructor(private readonly dashboard: DashboardService) {}

  /**
   * 经纪人工作台。
   * 所有角色都可访问 —— 店长与负责人也需要看到"我自己的客户"视角。
   */
  @Get()
  async getAgentDashboard(): Promise<AgentDashboard> {
    return this.dashboard.getAgentDashboard();
  }

  /**
   * 门店驾驶舱。
   * 仅店长与负责人可见 —— 经纪人不需要看全店数据，也不应该看到同事的客户量。
   */
  @Get('store')
  @Roles(UserRole.STORE_MANAGER, UserRole.OWNER)
  async getStoreDashboard(@Query('storeId') storeId?: string): Promise<StoreDashboard> {
    return this.dashboard.getStoreDashboard(storeId);
  }
}
