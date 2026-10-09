import { Module } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../../config/configuration.js';
import { MockPropertyProvider } from './providers/mock-property.provider.js';
import { BeikeMcpClient } from './providers/beike/beike-mcp-client.js';
import { BeikeToolBridge } from '../ai/beike-tool-bridge.service.js';
import { BeikeDetailParser } from './providers/beike/beike-detail-parser.service.js';
import { BeikeDetailCache } from './providers/beike/beike-detail-cache.service.js';
import { BeikeRateLimiter } from './providers/beike/beike-rate-limiter.service.js';
import { PropertyDetailService } from './providers/beike/property-detail.service.js';
import { BeikeUsageStats } from './providers/beike/beike-usage-stats.service.js';
import { BeikeQuotaGuard } from './providers/beike/beike-quota-guard.service.js';
import { PropertyProviderRegistry } from './providers/provider-registry.js';
import { PropertySyncService } from './property-sync.service.js';
import { PropertyTextParserService } from './property-text-parser.service.js';
import { PropertyImportService } from './property-import.service.js';
import { PropertyReliabilityService } from './reliability/property-reliability.service.js';
// ---- 多源架构 V2（Phase 11 新增，Phase 12 接入可信度与 Demo 隔离）----
import { CommunityNormalizerService } from './dedup/community-normalizer.service.js';
import { PropertyDeduplicationService } from './dedup/property-deduplication.service.js';
import { ProviderHealthMonitor } from './providers/provider-health-monitor.service.js';
import { ProviderRegistryV2 } from './providers/provider-registry-v2.js';
import { MultiSourceAggregator } from './providers/multi-source-aggregator.service.js';
import { BeikePropertyProviderV2 } from './providers/beike/beike-provider-v2.js';
import { UserProvidedPropertyProvider } from './providers/user-provided/user-provided-property.provider.js';
import { PropertyImportController } from './property-import.controller.js';
import { BeikeController } from './beike.controller.js';

@Module({
  controllers: [PropertyImportController, BeikeController],
  providers: [
    {
      provide: MockPropertyProvider,
      useFactory: () => new MockPropertyProvider({ seed: 20_261_008, perCommunity: 55 }),
    },
    {
      // 贝壳 MCP 客户端：从环境变量读取 CLI 路径与凭证
      provide: BeikeMcpClient,
      useFactory: (config: AppConfig, usageStats: BeikeUsageStats, quotaGuard: BeikeQuotaGuard) => {
        const client = new BeikeMcpClient(config);

        /**
         * 把用量统计与预算护栏注入到客户端**内部**的节流器。
         *
         * 为什么必须这么做：`BeikeMcpClient` 是手动 new 的
         * （要同时管理 CLI 子进程与直连两条通道），
         * 它在内部自建了节流器。若不注入，
         * 诊断端点读到的会是一个**没人用的空实例**。
         */
        client.attachUsageStats(usageStats);
        client.attachQuotaGuard(quotaGuard);

        return client;
      },
      inject: [APP_CONFIG, BeikeUsageStats, BeikeQuotaGuard],
    },
    PropertyProviderRegistry,
    PropertySyncService,
    PropertyTextParserService,
    PropertyImportService,
    // Phase 12：数据可信度策略（Demo 隔离 + 可信度评分 + 综合排序）
    PropertyReliabilityService,

    // ---- 多源聚合层（V2）----
    CommunityNormalizerService,
    PropertyDeduplicationService,
    ProviderHealthMonitor,
    MultiSourceAggregator,

    // V2 Provider 实例（ProviderRegistryV2 在构造时自动装配它们）
    {
      provide: BeikePropertyProviderV2,
      useFactory: (client: BeikeMcpClient) => new BeikePropertyProviderV2(client),
      inject: [BeikeMcpClient],
    },
    {
      // 用户录入房源：无需任何第三方凭证，是零法律风险的兜底数据源
      provide: UserProvidedPropertyProvider,
      useFactory: () => new UserProvidedPropertyProvider(),
    },
    ProviderRegistryV2,

    // ---- 贝壳 MCP 工具桥（供 AI 助手动态调用官方 18 个工具）----
    BeikeToolBridge,

    // ---- 贝壳详情解析（把 entity_detail / entity_material 的丰富信息结构化）----
    BeikeDetailParser,

    // ---- 贝壳调用优化（限流与缓存，避免把服务端打到限流）----
    BeikeRateLimiter,
    BeikeDetailCache,
    /** 用量统计与预算护栏（诊断端点读取） */
    BeikeUsageStats,
    BeikeQuotaGuard,

    // ---- 用量统计（贝壳不提供配额查询，只能自己量化）----
    BeikeUsageStats,

    // ---- 按需加载详情（列表用摘要，点开才取完整详情与图片）----
    PropertyDetailService,
  ],
  exports: [
    PropertyProviderRegistry,
    PropertySyncService,
    MockPropertyProvider,
    PropertyImportService,
    PropertyTextParserService,
    BeikeMcpClient,
    PropertyReliabilityService,
    // 详情解析（编排器用于补全房源详情）
    BeikeDetailParser,
    BeikeDetailCache,
    // 按需加载详情（需求模块的端点调用）
    PropertyDetailService,
    // 多源聚合对外出口
    ProviderRegistryV2,
    ProviderHealthMonitor,
    MultiSourceAggregator,
    PropertyDeduplicationService,
    CommunityNormalizerService,
    BeikePropertyProviderV2,
    UserProvidedPropertyProvider,
    // AI 助手通过它访问贝壳工具
    BeikeToolBridge,
  ],
})
export class PropertyModule {}
