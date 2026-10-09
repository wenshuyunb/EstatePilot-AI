/**
 * 认证模块。
 */

import { Module } from '@nestjs/common';
import { APP_CONFIG } from '../../config/configuration.js';
import type { AppConfig } from '../../config/configuration.js';
import { AuthController } from './auth.controller.js';
import { AuthService } from './auth.service.js';
import { PasswordService } from './password.service.js';
import { TokenService } from './token.service.js';

@Module({
  controllers: [AuthController],
  providers: [
    {
      provide: TokenService,
      useFactory: (config: AppConfig) => new TokenService(config),
      inject: [APP_CONFIG],
    },
    PasswordService,
    AuthService,
  ],
  exports: [AuthService, TokenService, PasswordService],
})
export class AuthModule {}
