/**
 * 房源导入控制器。
 *
 * 两步式导入流程（这是刻意的设计）：
 *   POST /properties/import/preview  → 解析并返回草稿，不入库
 *   POST /properties/import/confirm  → 用户修正后确认入库
 *
 * 为什么不一步到位：粘贴解析不可能 100% 准确。
 * 让用户先看到解析结果、修正错误字段再入库，比"先入库再删错的"体验好得多，
 * 也避免了脏数据污染匹配结果。
 */

import { Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { z } from 'zod';
import { UserRole } from '@estatepilot/types';
import { PropertyImportService } from './property-import.service.js';
import { ZodBody } from '../../common/pipes/zod-validation.pipe.js';
import { CurrentUser, Roles, type RequestUser } from '../../common/decorators/auth.decorators.js';

/** 预览解析请求 */
const previewSchema = z.object({
  text: z.string().min(1, '请粘贴房源文本').max(500_000, '单次粘贴内容不能超过 500KB'),
  city: z.string().max(20).default('上海'),
});

/** 解析出的字段（供确认导入时回传修正后的值） */
const draftFieldsSchema = z.object({
  title: z.string().max(200).nullable(),
  community: z.string().min(1, '小区名称不能为空').max(100),
  district: z.string().max(50).nullable(),
  subDistrict: z.string().max(50).nullable(),
  address: z.string().max(300).nullable(),
  totalPrice: z.coerce.number().int().min(10_000, '总价至少 1 万').max(1_000_000_000),
  unitPrice: z.coerce.number().int().min(0).nullable(),
  bedrooms: z.coerce.number().int().min(1, '卧室数至少 1').max(20),
  livingRooms: z.coerce.number().int().min(0).nullable(),
  bathrooms: z.coerce.number().int().min(0).nullable(),
  area: z.coerce.number().min(5, '面积至少 5㎡').max(2000),
  floor: z.coerce.number().int().min(-5).nullable(),
  totalFloors: z.coerce.number().int().min(1).nullable(),
  buildYear: z.coerce.number().int().min(1900).max(2100).nullable(),
  tags: z.array(z.string().max(20)).max(20).default([]),
  description: z.string().max(5000).nullable(),
  /** 枚举字段用字符串透传，Service 层会做映射与兜底 */
  orientation: z.string().nullable(),
  decoration: z.string().nullable(),
  propertyType: z.string().nullable(),
  ownershipType: z.string().nullable(),
  elevator: z.boolean().nullable(),
  subwayDistance: z.coerce.number().int().min(0).max(20000).nullable(),
  imageUrls: z.array(z.string().url()).max(30).default([]),
});

const draftSchema = z.object({
  draftId: z.string().max(64),
  rawText: z.string().max(20_000),
  fields: draftFieldsSchema,
  confidence: z.coerce.number().min(0).max(1).default(0),
  missingFields: z.array(z.string()).default([]),
  warnings: z.array(z.string()).default([]),
  /** 复杂结构（subway / schoolInfo）由预览结果原样回传 */
  subway: z.unknown().optional(),
  schoolInfo: z.unknown().optional(),
  listingStatus: z.string().nullable().optional(),
});

const confirmSchema = z.object({
  drafts: z.array(draftSchema).min(1, '至少需要一条房源').max(500, '单次最多导入 500 条'),
  city: z.string().max(20).default('上海'),
  updateOnDuplicate: z.boolean().default(true),
  sourceLabel: z.string().max(50).default('PASTE_IMPORT'),
});

type PreviewInput = z.infer<typeof previewSchema>;
type ConfirmInput = z.infer<typeof confirmSchema>;

@Controller('properties/import')
export class PropertyImportController {
  constructor(private readonly importService: PropertyImportService) {}

  /**
   * 解析预览（不入库）。
   * 权限：经纪人及以上 —— 经纪人需要能自己建库。
   */
  @Post('preview')
  @HttpCode(HttpStatus.OK)
  @Roles(UserRole.AGENT, UserRole.STORE_MANAGER, UserRole.OWNER)
  async preview(@Body(ZodBody(previewSchema)) body: PreviewInput): Promise<{
    drafts: unknown[];
    summary: { totalBlocks: number; parsedBlocks: number; importable: number };
  }> {
    const result = this.importService.previewParse(body.text, { city: body.city });

    // 把解析结果转成前端友好的结构（补充显示用文案）
    const drafts = result.drafts.map((draft) => ({
      draftId: draft.draftId,
      rawText: draft.rawText.slice(0, 2000),
      fields: draft.fields,
      confidence: draft.confidence,
      missingFields: draft.missingFields,
      warnings: draft.warnings,
      subway: draft.fields.subway,
      schoolInfo: draft.fields.schoolInfo,
      listingStatus: draft.fields.listingStatus,
    }));

    return { drafts, summary: result.summary };
  }

  /**
   * 确认导入。
   * 接收用户修正后的草稿并真正入库。
   */
  @Post('confirm')
  @HttpCode(HttpStatus.OK)
  @Roles(UserRole.AGENT, UserRole.STORE_MANAGER, UserRole.OWNER)
  async confirm(
    @Body(ZodBody(confirmSchema)) body: ConfirmInput,
    @CurrentUser() user: RequestUser,
  ): Promise<{
    created: number;
    skipped: number;
    priceUpdated: number;
    rejected: number;
    details: unknown[];
    durationMs: number;
  }> {
    // 把前端回传的字段转成 Service 期望的草稿结构
    const drafts = body.drafts.map((draft) => ({
      draftId: draft.draftId,
      rawText: draft.rawText,
      confidence: draft.confidence,
      missingFields: draft.missingFields,
      warnings: draft.warnings,
      fields: {
        title: draft.fields.title,
        community: draft.fields.community,
        district: draft.fields.district,
        subDistrict: draft.fields.subDistrict,
        address: draft.fields.address,
        totalPrice: draft.fields.totalPrice,
        unitPrice: draft.fields.unitPrice,
        bedrooms: draft.fields.bedrooms,
        livingRooms: draft.fields.livingRooms,
        bathrooms: draft.fields.bathrooms,
        area: draft.fields.area,
        floor: draft.fields.floor,
        totalFloors: draft.fields.totalFloors,
        // 枚举字段：用 as never 透传，属性映射在 Service 里完成
        orientation: (draft.fields.orientation ?? null) as never,
        buildYear: draft.fields.buildYear,
        propertyType: (draft.fields.propertyType ?? null) as never,
        ownershipType: (draft.fields.ownershipType ?? null) as never,
        decoration: (draft.fields.decoration ?? null) as never,
        elevator: draft.fields.elevator,
        subwayDistance: draft.fields.subwayDistance,
        subway: (draft.subway ?? null) as never,
        schoolInfo: (draft.schoolInfo ?? null) as never,
        tags: draft.fields.tags,
        description: draft.fields.description,
        listingStatus: (draft.listingStatus ?? null) as never,
        imageUrls: draft.fields.imageUrls,
      },
    }));

    return this.importService.importConfirmedDrafts(user.organizationId, drafts as never, {
      city: body.city,
      updateOnDuplicate: body.updateOnDuplicate,
      sourceLabel: body.sourceLabel,
    });
  }
}
