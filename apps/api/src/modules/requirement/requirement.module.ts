import { Module } from '@nestjs/common';
import { TenantModule } from '../tenant/tenant.module.js';
import { PropertyModule } from '../property/property.module.js';
import { AiService } from '../ai/ai.service.js';
import { MessageImportService } from './message-import.service.js';
import { RequirementExtractorService } from './requirement-extractor.service.js';
import { RequirementMergeService } from './requirement-merge.service.js';
import { RequirementProfileService } from './requirement-profile.service.js';
import { RequirementSnapshotService } from './requirement-snapshot.service.js';
import { PropertySearchQueryBuilder } from './property-search-query-builder.service.js';
import { PlatformSearchPlanner } from './platform-search-planner.service.js';
import { PropertyDetailStore } from './property-detail.store.js';
import { HardFilterService } from './hard-filter.service.js';
import { MatchScoringService } from './match-scoring.service.js';
import { PropertyUpsertService } from './property-upsert.service.js';
import { CachedPropertySearchService } from './cached-property-search.service.js';
import { WeChatReplyGenerator } from './wechat-reply-generator.service.js';
import { RecommendationService } from './recommendation.service.js';
import { PropertyFeedbackService } from './property-feedback.service.js';
import { WeChatPropertyAssistantOrchestrator } from './wechat-assistant.orchestrator.js';
import { WeChatAssistantController } from './wechat-assistant.controller.js';
import { RecommendationController } from './recommendation.controller.js';
import { LocationCatalogController } from './location-catalog.controller.js';

/**
 * 微信复制 → AI 需求 → 贝壳 → 推荐 闭环模块。
 *
 * 依赖说明：
 *   - TenantModule：所有数据库访问都经过租户作用域
 *   - PropertyModule：复用已完成的贝壳接入（BeikeMcpClient 从这里导出）
 *
 * 这个模块内的每个服务都**可以单独测试**：
 *   中文表达解析、需求合并、硬筛、打分都是纯函数式逻辑，不依赖数据库。
 */
@Module({
  imports: [TenantModule, PropertyModule],
  controllers: [
    WeChatAssistantController,
    RecommendationController,
    LocationCatalogController,
  ],
  providers: [
    AiService,
    MessageImportService,
    RequirementExtractorService,
    RequirementMergeService,
    RequirementProfileService,
    RequirementSnapshotService,
    PropertySearchQueryBuilder,
    PlatformSearchPlanner,
    PropertyDetailStore,
    HardFilterService,
    MatchScoringService,
    PropertyUpsertService,
    CachedPropertySearchService,
    WeChatReplyGenerator,
    RecommendationService,
    PropertyFeedbackService,
    WeChatPropertyAssistantOrchestrator,
  ],
  exports: [
    MessageImportService,
    RequirementExtractorService,
    RequirementMergeService,
    RequirementProfileService,
    RequirementSnapshotService,
    PropertySearchQueryBuilder,
    HardFilterService,
    MatchScoringService,
    PropertyUpsertService,
    CachedPropertySearchService,
    WeChatReplyGenerator,
    RecommendationService,
    PropertyFeedbackService,
    WeChatPropertyAssistantOrchestrator,
    AiService,
  ],
})
export class RequirementModule {}
