/**
 * 客户触达控制器 —— 一键发送包。
 */

import { Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { z } from 'zod';
import { MessageChannel, RecommendScenario, UserRole, type RecommendBundle } from '@estatepilot/types';
import { OutreachService } from './outreach.service.js';
import { ZodBody } from '../../common/pipes/zod-validation.pipe.js';
import { CurrentUser, Roles, type RequestUser } from '../../common/decorators/auth.decorators.js';

/** 生成发送包请求 */
const generateBundleSchema = z.object({
  customerId: z.string().min(1),
  scenario: z.nativeEnum(RecommendScenario).optional(),
  channel: z.nativeEnum(MessageChannel).default(MessageChannel.WECHAT_PERSONAL),
  /** 指定推送的房源；不传则自动用匹配引擎选 */
  propertyIds: z.array(z.string().min(1)).max(6).optional(),
  /** 推送几套，默认 3 */
  limit: z.coerce.number().int().min(1).max(6).default(3),
  /** 是否附带客户专属链接（默认带上 —— 这是数据闭环入口） */
  includePortalLink: z.boolean().default(true),
  /** 经纪人补充的个性化信息 */
  customNote: z.string().max(500).optional(),
});

type GenerateBundleInput = z.infer<typeof generateBundleSchema>;

@Controller('outreach')
export class OutreachController {
  constructor(private readonly outreach: OutreachService) {}

  /**
   * 生成一键发送包。
   *
   * 返回可直接复制到微信的完整文案 + 结构化房源列表 + 电话话术 + 注意事项。
   */
  @Post('recommend-bundle')
  @HttpCode(HttpStatus.OK)
  @Roles(UserRole.AGENT, UserRole.STORE_MANAGER, UserRole.OWNER)
  async generateBundle(
    @Body(ZodBody(generateBundleSchema)) body: GenerateBundleInput,
    @CurrentUser() _user: RequestUser,
  ): Promise<RecommendBundle> {
    return this.outreach.generateBundle(body);
  }
}
