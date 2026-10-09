import { Module } from '@nestjs/common';
import { DashboardController } from './dashboard.controller.js';
import { DashboardService } from './dashboard.service.js';
import { StoreDashboardService } from './store-dashboard.service.js';
import { NotificationsModule } from '../notifications/notifications.module.js';

@Module({
  imports: [NotificationsModule],
  controllers: [DashboardController],
  providers: [DashboardService, StoreDashboardService],
  exports: [DashboardService, StoreDashboardService],
})
export class DashboardModule {}
