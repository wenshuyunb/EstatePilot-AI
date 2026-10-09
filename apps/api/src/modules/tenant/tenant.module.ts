/**
 * 租户与数据库模块。
 *
 * 标记为 @Global()，这样任何业务模块都能直接注入 TenantService 而无需重复 import。
 * 这是有意为之：租户作用域是所有业务代码的必需品，不是可选依赖。
 */

import { Global, Module } from '@nestjs/common';
import { APP_CONFIG, buildAppConfig, loadConfig } from '../../config/configuration.js';
import { TenantService } from './tenant.service.js';

@Global()
@Module({
  providers: [
    {
      provide: APP_CONFIG,
      useFactory: () => buildAppConfig(loadConfig()),
    },
    TenantService,
  ],
  exports: [TenantService, APP_CONFIG],
})
export class TenantModule {}
