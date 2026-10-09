/**
 * @estatepilot/types
 *
 * EstatePilot AI 全系统共享领域类型与枚举的单一事实来源。
 * 后端 DTO、数据库枚举映射、前端展示文案都从这里导入，避免多处重复定义导致漂移。
 */

export * from './auth.js';
export * from './customer.js';
export * from './property.js';
// 多源 Provider 聚合层的契约（在 property.js 基础上扩展，不改动原有定义）
export * from './property-provider.js';
export * from './behavior.js';
export * from './matching.js';
export * from './opportunity.js';
export * from './viewing.js';
export * from './ai.js';
export * from './outreach.js';
export * from './common.js';
export * from './requirement.js';
