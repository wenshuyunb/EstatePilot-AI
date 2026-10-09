/**
 * 房源数据 Provider 注册表与工厂。
 *
 * 设计目标：业务层完全不感知具体数据源。
 * 新增一家数据源只需实现 PropertyProvider 接口并在这里注册。
 *
 * 合规声明：
 *   本系统严禁以非法手段获取第三方房源数据。
 *   无官方 API 凭证时只能使用 MockPropertyProvider（界面会标注 Demo Data）。
 *   贝壳适配器是官方开放平台 API 的骨架实现，凭证就绪后即可接入，详见 docs/BEIKE_INTEGRATION.md。
 */

import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  PropertyProviderKind,
  type PropertyProvider,
  type PropertyQuery,
  type PropertyFetchResult,
  type NormalizedProperty,
  type PropertyStatusChange,
} from '@estatepilot/types';
import { MockPropertyProvider } from './mock-property.provider.js';
import { BeikePropertyProvider } from './beike/beike-property.provider.js';
import { BeikeMcpClient } from './beike/beike-mcp-client.js';
import { APP_CONFIG, type AppConfig } from '../../../config/configuration.js';

/** 未配置凭证时抛出 */
export class ProviderNotConfiguredError extends Error {
  readonly code = 'PROVIDER_NOT_CONFIGURED';

  constructor(readonly provider: PropertyProviderKind, message: string) {
    super(message);
    this.name = 'ProviderNotConfiguredError';
  }
}

@Injectable()
export class PropertyProviderRegistry {
  private readonly logger = new Logger(PropertyProviderRegistry.name);
  private readonly providers = new Map<PropertyProviderKind, PropertyProvider>();

  constructor(
    // APP_CONFIG 是 Symbol 令牌，且 AppConfig 是 interface（运行时不存在），
    // 因此必须显式 @Inject，否则 Nest 无法解析依赖。
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly mockProvider: MockPropertyProvider,
    private readonly beikeClient: BeikeMcpClient,
  ) {
    // 注册所有可用 Provider
    this.providers.set(PropertyProviderKind.MOCK, mockProvider);
    this.providers.set(PropertyProviderKind.BEIKE, new BeikePropertyProvider(beikeClient));

    const configured = [...this.providers.values()]
      .filter((provider) => provider.isConfigured())
      .map((provider) => provider.kind);
    this.logger.log(`已注册的房源 Provider：${[...this.providers.keys()].join(', ')}`);
    this.logger.log(`当前可用的 Provider：${configured.join(', ') || '无'}`);

    // 贝壳数据源不可用时明确说明原因（而不是静默降级）
    const beikeStatus = new BeikePropertyProvider(beikeClient).describeAvailability();
    if (!beikeStatus.available) {
      this.logger.warn(`贝壳数据源不可用：${beikeStatus.reason}`);
    }
  }

  /**
   * 取当前配置的默认 Provider。
   * 若配置的 Provider 未就绪（如贝壳缺凭证），**自动降级到 Mock 并明确告警**，
   * 而不是静默返回空数据 —— 后者会让问题难以定位。
   */
  getDefault(): PropertyProvider {
    const configuredKind = this.mapConfigToKind(this.config.property.provider);
    const provider = this.providers.get(configuredKind);

    if (!provider) {
      this.logger.warn(`未找到 Provider ${configuredKind}，降级到 Mock`);
      return this.mockProvider;
    }

    if (!provider.isConfigured()) {
      this.logger.warn(
        `Provider ${configuredKind} 未配置凭证，自动降级到 Mock（Demo 数据）。` +
          `请参考 docs/BEIKE_INTEGRATION.md 配置官方 API 凭证。`,
      );
      return this.mockProvider;
    }

    return provider;
  }

  /** 按类型取 Provider，未就绪时抛错（用于显式指定的场景） */
  get(kind: PropertyProviderKind): PropertyProvider {
    const provider = this.providers.get(kind);
    if (!provider) {
      throw new ProviderNotConfiguredError(kind, `未注册的房源 Provider：${kind}`);
    }
    if (!provider.isConfigured()) {
      throw new ProviderNotConfiguredError(
        kind,
        `房源 Provider ${kind} 尚未配置。` +
          `${kind === PropertyProviderKind.BEIKE ? '请配置 BEIKE_APP_ID / BEIKE_APP_KEY / BEIKE_APP_SECRET。' : ''}`,
      );
    }
    return provider;
  }

  /** 列出所有 Provider 及其状态，供超管后台展示 */
  listStatus(): Array<{
    kind: PropertyProviderKind;
    configured: boolean;
    isDefault: boolean;
    description: string;
  }> {
    const defaultKind = this.getDefault().kind;
    return [...this.providers.entries()].map(([kind, provider]) => ({
      kind,
      configured: provider.isConfigured(),
      isDefault: kind === defaultKind,
      description: this.describeProvider(kind),
    }));
  }

  private describeProvider(kind: PropertyProviderKind): string {
    switch (kind) {
      case PropertyProviderKind.MOCK:
        return '内置模拟数据（Demo），界面会标注 Demo Data';
      case PropertyProviderKind.BEIKE:
        return '贝壳官方开放平台 API，需在环境变量中配置 AppID / AppKey / AppSecret';
      case PropertyProviderKind.ANJUKE:
        return '安居客官方接口（尚未实现）';
      case PropertyProviderKind.INTERNAL:
        return '中介公司自有房源库（尚未实现）';
      default:
        return '';
    }
  }

  private mapConfigToKind(provider: string): PropertyProviderKind {
    switch (provider) {
      case 'BEIKE':
        return PropertyProviderKind.BEIKE;
      case 'ANJUKE':
        return PropertyProviderKind.ANJUKE;
      case 'INTERNAL':
        return PropertyProviderKind.INTERNAL;
      case 'MOCK':
      default:
        return PropertyProviderKind.MOCK;
    }
  }
}

export type {
  PropertyProvider,
  PropertyQuery,
  PropertyFetchResult,
  NormalizedProperty,
  PropertyStatusChange,
};
