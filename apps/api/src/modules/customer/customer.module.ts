import { Module } from '@nestjs/common';
import { TenantModule } from '../tenant/tenant.module.js';
import { CustomerController } from './customer.controller.js';
import { IntentScoreService } from './intent-score-service.js';

/**
 * 客户模块。
 *
 * 提供客户列表、客户 360 基本信息与意向分计算。
 * 微信需求识别与房源推荐在 RequirementModule 里（它依赖本模块的客户数据）。
 */
@Module({
  imports: [TenantModule],
  controllers: [CustomerController],
  providers: [IntentScoreService],
  exports: [IntentScoreService],
})
export class CustomerModule {}
