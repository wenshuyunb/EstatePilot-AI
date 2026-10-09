'use client';

/**
 * 微信消息智能处理模块 —— 整个产品的核心交互。
 *
 * 经纪人视角的完整动线（需求 §5、§26、§50）：
 *   1. 在微信里 Ctrl+C 复制客户消息
 *   2. 切到本页面 Ctrl+V 粘贴
 *   3. Ctrl+Enter 或点按钮开始
 *   4. 等待 10～30 秒，看到真实房源 + 匹配度 + 可直接发送的微信文案
 *   5. 点「复制微信内容」→ 回微信 Ctrl+V 发送
 *   6. 点「我已发送」记录
 *
 * 三条实现原则：
 *   - **进度必须真实**：显示的每一步都对应后端真实执行的步骤与结果，
 *     绝不写"正在搜索"却在做别的事（需求 §27）。
 *   - **不能编造**：房源信息只来自后端返回的真实字段（需求 §42）。
 *   - **人工掌控**：AI 只是辅助，经纪人可以移除某套、调整顺序、换风格（需求 §29）。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  ArrowDownUp,
  Check,
  CheckCheck,
  Clipboard,
  ClipboardCheck,
  Copy,
  HardDrive,
  Loader2,
  Radio,
  RefreshCw,
  Send,
  Sparkles,
  Wand2,
  Zap,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/primitives';
import { useToast } from '@/components/ui/toast';
import { cn } from '@/lib/utils';
import {
  useAssistantCapabilities,
  useConfirmSent,
  useMarkCopied,
  useRegenerateReply,
  useRunAssistant,
  useRequirementProfile,
  type AssistantResult,
  type RecommendedProperty,
} from '@/lib/queries/use-wechat-assistant';
import { RequirementChanges } from '@/components/customer/requirement-profile-card';
import { RecommendedPropertyCard } from '@/components/customer/recommended-property-card';
import { LocationFilter } from '@/components/customer/location-filter';
import { PlatformSearchPanel } from '@/components/customer/platform-search-panel';
import { ApiError } from '@/lib/api-client';

/** 文案风格选项 */
const REPLY_STYLES = [
  { value: 'NATURAL_PROFESSIONAL', label: '自然专业', hint: '默认，400～600 字' },
  { value: 'CONCISE', label: '简短', hint: '200 字内，每套 1～2 行' },
  { value: 'DETAILED', label: '详细', hint: '800 字内，信息最全' },
] as const;

interface WeChatAssistantModuleProps {
  customerId: string;
  customerName: string;
}

export function WeChatAssistantModule({
  customerId,
  customerName,
}: WeChatAssistantModuleProps) {
  const { toast } = useToast();

  // ---- 输入 ----
  const [message, setMessage] = useState('');
  const [recommendationCount, setRecommendationCount] = useState(5);

  /**
   * 区域筛选状态。
   *
   * 语义（重要）：这是**本次搜索的临时筛选**，不写回客户画像。
   * 因此它不参与 useCallback 依赖之外的持久化，页面刷新即回到"自动判断"。
   */
  const [cityOverride, setCityOverride] = useState<string | null>(null);
  const [selectedDistricts, setSelectedDistricts] = useState<string[]>([]);
  const [replyStyle, setReplyStyle] = useState<(typeof REPLY_STYLES)[number]['value']>(
    'NATURAL_PROFESSIONAL',
  );

  // ---- 结果 ----
  const [result, setResult] = useState<AssistantResult | null>(null);
  const [visibleProperties, setVisibleProperties] = useState<RecommendedProperty[]>([]);
  const [replyContent, setReplyContent] = useState('');
  const [copied, setCopied] = useState(false);
  const [sentConfirmed, setSentConfirmed] = useState(false);
  const [currentReplyId, setCurrentReplyId] = useState<string | null>(null);
  const [currentBatchId, setCurrentBatchId] = useState<string | null>(null);

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const resultRef = useRef<HTMLDivElement>(null);

  // ---- 数据 ----
  const runAssistant = useRunAssistant(customerId);
  const markCopied = useMarkCopied(customerId);
  const confirmSent = useConfirmSent(customerId);
  const regenerate = useRegenerateReply(customerId);
  const { data: profileData } = useRequirementProfile(customerId);
  const { data: capabilities } = useAssistantCapabilities(customerId);

  /** 执行闭环 */
  const handleRun = useCallback(async () => {
    const text = message.trim();
    if (text.length === 0) {
      toast({ variant: 'error', title: '请先粘贴客户发来的微信消息' });
      textareaRef.current?.focus();
      return;
    }

    setCopied(false);
    setSentConfirmed(false);

    try {
      const response = await runAssistant.mutateAsync({
        message: text,
        recommendationCount,
        replyStyle,
        /**
         * 区域筛选：只作用于本次搜索，不写回客户画像。
         *
         * ⚠️ 未选择时必须传 `undefined`，**不能传空字符串或空数组**：
         * 后端的 zod schema 是 `z.string().min(1).max(20).optional()`，
         * 传 `''` 会触发"请求参数校验失败"（实测踩过），
         * 而且错误发生在参数校验层，界面上只会看到一句笼统的报错，
         * 很难联想到是筛选器传了空值。
         */
        cityOverride: cityOverride && cityOverride.length > 0 ? cityOverride : undefined,
        districtOverride: selectedDistricts.length > 0 ? selectedDistricts : undefined,
      });

      setResult(response);
      setVisibleProperties(response.recommendations);
      setReplyContent(response.reply.content);
      setCurrentReplyId(response.reply.replyId);
      setCurrentBatchId(response.batchId);

      // 提示降级情况（让经纪人知道当前用的是规则还是 AI）
      if (response.warnings.length > 0) {
        toast({
          variant: 'info',
          title: `已生成 ${response.recommendations.length} 套推荐`,
          description: response.warnings[0],
        });
      } else {
        toast({
          variant: 'success',
          title: `已找到 ${response.recommendations.length} 套匹配房源`,
          description: `耗时 ${(response.durationMs / 1000).toFixed(1)} 秒，可复制文案发给客户`,
        });
      }

      // 滚动到结果区
      setTimeout(() => {
        resultRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }, 100);
    } catch (error) {
      // 按错误类型给不同的提示与后续动作（需求 §56：给用户人能理解的中文）
      if (error instanceof ApiError) {
        const suggestions = error.details ?? [];

        toast({
          variant: 'error',
          title: error.message,
          description:
            suggestions.length > 0
              ? `建议：${suggestions.map((item) => item.message).join('；')}`
              : undefined,
          duration: 12_000,
        });
      } else {
        toast({
          variant: 'error',
          title: '处理失败',
          description: error instanceof Error ? error.message : '未知错误',
        });
      }
    }
  }, [message, recommendationCount, replyStyle, cityOverride, selectedDistricts, runAssistant, toast]);

  /** 复制微信文案 */
  const handleCopy = useCallback(async () => {
    if (!replyContent) return;

    try {
      await navigator.clipboard.writeText(replyContent);
      setCopied(true);
      toast({
        variant: 'success',
        // 注意措辞：只表示复制成功，**不能说"已发送"**
        title: '已复制，可直接粘贴到微信',
        description: '粘贴发送后，记得回来点「我已发送」以便记录跟进',
      });

      if (currentReplyId) {
        void markCopied.mutateAsync(currentReplyId);
      }
    } catch {
      // 剪贴板 API 在非安全上下文（http 且非 localhost）下会失败
      toast({
        variant: 'error',
        title: '复制失败',
        description: '请手动选中下方文案复制（浏览器限制了剪贴板访问）',
      });
    }
  }, [replyContent, currentReplyId, markCopied, toast]);

  /** 确认已发送 */
  const handleConfirmSent = useCallback(async () => {
    if (!currentReplyId) return;

    try {
      await confirmSent.mutateAsync(currentReplyId);
      setSentConfirmed(true);
      toast({
        variant: 'success',
        title: '已记录发送时间',
        description: '推荐历史已更新，后续不会重复推荐这几套无变化的房源',
      });
    } catch (error) {
      toast({
        variant: 'error',
        title: '记录失败',
        description: error instanceof Error ? error.message : '未知错误',
      });
    }
  }, [currentReplyId, confirmSent, toast]);

  /** 换风格重新生成（不重新搜索房源，不消耗贝壳额度） */
  const handleRegenerate = useCallback(
    async (style: (typeof REPLY_STYLES)[number]['value']) => {
      if (!currentBatchId) return;
      setReplyStyle(style);

      try {
        const response = await regenerate.mutateAsync({
          batchId: currentBatchId,
          style,
          propertyIds: visibleProperties.map((item) => item.propertyId),
        });
        setReplyContent(response.content);
        setCopied(false);
        toast({ variant: 'success', title: '已重新生成文案' });
      } catch (error) {
        toast({
          variant: 'error',
          title: '重新生成失败',
          description: error instanceof Error ? error.message : '未知错误',
        });
      }
    },
    [currentBatchId, visibleProperties, regenerate, toast],
  );

  // ---- 人工控制：移除 / 置顶 / 上移 ----
  const handleRemove = useCallback((propertyId: string) => {
    setVisibleProperties((previous) => previous.filter((item) => item.propertyId !== propertyId));
    setCopied(false);
  }, []);

  const handlePin = useCallback((propertyId: string) => {
    setVisibleProperties((previous) => {
      const target = previous.find((item) => item.propertyId === propertyId);
      if (!target) return previous;
      return [target, ...previous.filter((item) => item.propertyId !== propertyId)];
    });
    setCopied(false);
  }, []);

  const handleMoveUp = useCallback((index: number) => {
    if (index <= 0) return;
    setVisibleProperties((previous) => {
      const next = [...previous];
      const current = next[index];
      const above = next[index - 1];
      if (!current || !above) return previous;
      next[index - 1] = current;
      next[index] = above;
      return next;
    });
    setCopied(false);
  }, []);

  /** Ctrl+Enter 快捷提交（需求 §51） */
  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
        event.preventDefault();
        void handleRun();
      }
    },
    [handleRun],
  );

  // 客户切换时清空结果
  useEffect(() => {
    setResult(null);
    setVisibleProperties([]);
    setReplyContent('');
    setMessage('');
    setCopied(false);
    setSentConfirmed(false);
  }, [customerId]);

  const isRunning = runAssistant.isPending;
  const error = runAssistant.error instanceof ApiError ? runAssistant.error : null;
  const errorText = error?.message ?? null;
  /** 贝壳不可用：需求已保存，只需重试房源查询（不需要重新粘贴） */
  const isBeikeUnavailable = error?.code === 'BEIKE_UNAVAILABLE';
  /** 零结果：附带可点击的放宽建议 */
  const isNoProperties = error?.code === 'NO_PROPERTIES_FOUND';

  /** 没有被移除的房源数量（用于提示文案与实际发送不一致） */
  const removedCount = useMemo(
    () => (result ? result.recommendations.length - visibleProperties.length : 0),
    [result, visibleProperties.length],
  );

  return (
    <div className="space-y-4">
      {/* ================= 输入区（页面最显眼） ================= */}
      <Card className="border-brand/40">
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-1.5 text-sm">
            <Zap className="size-4 text-brand" />
            微信消息智能处理
            <span className="ml-auto text-[11px] font-normal text-ink-muted">
              把客户在微信里说的话粘贴进来，自动找房并生成回复
            </span>
          </CardTitle>
        </CardHeader>

        <CardContent className="space-y-3 pt-0">
          <textarea
            ref={textareaRef}
            value={message}
            onChange={(event) => setMessage(event.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={`把客户刚发的微信消息粘贴到这里（Ctrl+V）&#10;&#10;例如：还是想看张江附近吧，三房最好，550左右，600以内也可以，但是别太老的小区，我老婆比较在意小区环境，离地铁最好也别太远。`}
            rows={5}
            disabled={isRunning}
            className={cn(
              'w-full resize-y rounded-md border border-border bg-surface px-3 py-2 text-sm leading-relaxed text-ink',
              'placeholder:text-ink-muted',
              'focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-brand',
              'disabled:cursor-not-allowed disabled:opacity-60',
            )}
            aria-label="客户微信消息"
          />

          {/* 区域筛选：选了就只推该区域的房源 */}
          <div className="rounded-md border border-border bg-surface-subtle px-2.5 py-2">
            <LocationFilter
              city={cityOverride}
              districts={selectedDistricts}
              onCityChange={setCityOverride}
              onDistrictsChange={setSelectedDistricts}
              disabled={isRunning}
            />
            <p className="mt-1 text-[11px] text-ink-muted">
              不选则按客户消息与画像自动判断。此筛选只作用于本次搜索，不会写入客户档案。
            </p>
          </div>

          {/* 参数与提交 */}
          <div className="flex flex-wrap items-center gap-2">
            <label className="flex items-center gap-1.5 text-xs text-ink-secondary">
              推荐数量
              <select
                value={recommendationCount}
                onChange={(event) => setRecommendationCount(Number(event.target.value))}
                disabled={isRunning}
                className="h-7 rounded-md border border-border bg-surface px-1.5 text-xs focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-brand"
              >
                {[3, 5, 8].map((count) => (
                  <option key={count} value={count}>
                    {count} 套
                  </option>
                ))}
              </select>
            </label>

            <label className="flex items-center gap-1.5 text-xs text-ink-secondary">
              文案风格
              <select
                value={replyStyle}
                onChange={(event) =>
                  setReplyStyle(event.target.value as (typeof REPLY_STYLES)[number]['value'])
                }
                disabled={isRunning}
                className="h-7 rounded-md border border-border bg-surface px-1.5 text-xs focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-brand"
              >
                {REPLY_STYLES.map((style) => (
                  <option key={style.value} value={style.value}>
                    {style.label}（{style.hint}）
                  </option>
                ))}
              </select>
            </label>

            <div className="ml-auto flex items-center gap-2">
              <span className="hidden text-[11px] text-ink-muted sm:inline">
                Ctrl + Enter 直接开始
              </span>
              <Button onClick={() => void handleRun()} disabled={isRunning || message.trim().length === 0}>
                {isRunning ? (
                  <>
                    <Loader2 className="size-3.5 animate-spin" />
                    处理中…
                  </>
                ) : (
                  <>
                    <Sparkles className="size-3.5" />
                    AI 识别需求并匹配房源
                  </>
                )}
              </Button>
            </div>
          </div>

          {/* 能力与服务状态：让经纪人清楚"当前是什么在为我工作" */}
          {capabilities && (
            <div className="space-y-1">
              <p className="text-[11px] text-ink-muted">
                {capabilities.ai.live
                  ? `需求识别由 AI 模型完成（${capabilities.ai.model}）`
                  : '当前未配置 AI 模型密钥，需求识别使用内置中文规则（功能完整，理解复杂表达稍弱）'}
              </p>

              {/* 贝壳数据服务状态：这个指示器的价值在于——
                  当搜索失败时，经纪人能立刻分清是"贝壳挂了"还是"自己配置错了"，
                  不至于反复折腾自己的设置。 */}
              {capabilities.beike && (
                <p className="flex flex-wrap items-center gap-1.5 text-[11px]">
                  <span className="text-ink-muted">贝壳房源服务：</span>
                  {capabilities.beike.ok ? (
                    <span className="inline-flex items-center gap-1 text-success">
                      <span className="size-1.5 rounded-full bg-success" />
                      正常
                      <span className="text-ink-muted">
                        （探测 {capabilities.beike.durationMs}ms）
                      </span>
                    </span>
                  ) : capabilities.beike.failureKind === 'SERVICE' ? (
                    <span className="inline-flex items-center gap-1 text-warning">
                      <span className="size-1.5 rounded-full bg-warning" />
                      暂时不可用（对方服务端问题，稍后重试即可，不用改配置）
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1 text-danger">
                      <span className="size-1.5 rounded-full bg-danger" />
                      连接异常，请检查凭证配置
                    </span>
                  )}
                </p>
              )}
            </div>
          )}

          {/* 错误提示：持久显示（不用 Toast） */}
          {error && !isRunning && (
            <div
              className={cn(
                'rounded-md border px-3 py-2.5',
                isBeikeUnavailable || isNoProperties
                  ? 'border-warning/40 bg-warning-subtle'
                  : 'border-danger/30 bg-danger-subtle',
              )}
              role="alert"
            >
              <div className="flex items-start gap-2">
                <AlertTriangle
                  className={cn(
                    'mt-0.5 size-3.5 shrink-0',
                    isBeikeUnavailable || isNoProperties ? 'text-warning' : 'text-danger',
                  )}
                />
                <div className="min-w-0 flex-1">
                  <p
                    className={cn(
                      'text-xs font-medium',
                      isBeikeUnavailable || isNoProperties ? 'text-warning' : 'text-danger',
                    )}
                  >
                    {errorText}
                  </p>

                  {/* 按错误类型给出可执行的下一步 */}
                  {isBeikeUnavailable && (
                    <p className="mt-1 text-[11px] text-ink-secondary">
                      客户需求已识别并保存，无需重新粘贴。
                      点击下方按钮重试房源查询即可（不会重新调用 AI，省时省钱）。
                    </p>
                  )}

                  {isNoProperties && error.details && error.details.length > 0 && (
                    <div className="mt-1.5">
                      <p className="text-[11px] text-ink-secondary">
                        可以尝试放宽以下条件（需要你确认后才会应用）：
                      </p>
                      <ul className="mt-1 space-y-0.5">
                        {error.details.map((detail) => (
                          <li key={detail.field} className="text-[11px] text-ink-secondary">
                            · {detail.message}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}

                  {!isBeikeUnavailable && !isNoProperties && (
                    <p className="mt-1 text-[11px] text-ink-secondary">
                      客户消息已保存，修正后可直接重新提交
                    </p>
                  )}

                  {/* 贝壳不可用时的重试按钮 */}
                  {isBeikeUnavailable && (
                    <Button
                      variant="outline"
                      size="sm"
                      className="mt-2"
                      onClick={() => void handleRun()}
                    >
                      <RefreshCw className="size-3.5" />
                      重新查询房源
                    </Button>
                  )}

                  {/* 已识别到的需求摘要 —— 让经纪人确认系统理解是否正确。
                      这里只给一行摘要，完整画像在下方「需求画像」Tab 里，
                      避免同一屏出现两块相同内容。 */}
                  {profileData?.exists && (
                    <div className="mt-2 rounded-md bg-surface/70 px-2 py-1.5">
                      <p className="text-[11px] text-ink-muted">已识别到的需求</p>
                      <p className="mt-0.5 text-xs text-ink">{profileData.summary}</p>
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* ================= 真实进度（对应后端真实步骤） ================= */}
      {isRunning && <ProgressPanel />}

      {/* ================= 结果区 ================= */}
      <div ref={resultRef} className="space-y-4">
        {result && (
          <>
            {/* 需求变化 */}
            <Card>
              <CardContent className="space-y-3 p-3">
                <RequirementChanges
                  changes={result.changes}
                  needsConfirmation={result.needsConfirmation}
                />

                {/* 检索依据：让经纪人知道系统按什么搜的 */}
                <div className="rounded-md border border-border bg-surface-subtle px-2.5 py-2">
                  {/* 数据来源标注（关键：缓存数据绝不能冒充实时数据） */}
                  <div className="mb-1 flex flex-wrap items-center gap-1.5">
                    {result.dataSource === 'LOCAL_CACHE' ? (
                      <>
                        <Badge variant="warning" className="gap-1">
                          <HardDrive className="size-2.5" />
                          本地缓存房源
                        </Badge>
                        <span className="text-[11px] text-warning">
                          {result.cacheNote ?? '贝壳服务暂时不可用，本次使用本地已同步的房源'}
                        </span>
                      </>
                    ) : (
                      <Badge variant="success" className="gap-1">
                        <Radio className="size-2.5" />
                        贝壳实时数据
                      </Badge>
                    )}
                  </div>

                  <p className="text-[11px] text-ink-muted">
                    检索条件：<span className="text-ink">{result.searchQuery.naturalQuery}</span>
                  </p>
                  <p className="mt-0.5 text-[11px] text-ink-muted">
                    {result.dataSource === 'LOCAL_CACHE' ? '本地匹配' : '贝壳召回'}{' '}
                    {result.beikeStats.totalRecalled ?? '—'} 套 · 本次{' '}
                    {result.beikeStats.returned} 套 · 硬性条件筛选后{' '}
                    {result.beikeStats.passedHardFilter} 套
                  </p>

                  {/* 缓存模式的额外提醒：必须确认房源是否仍在售 */}
                  {result.dataSource === 'LOCAL_CACHE' && (
                    <p className="mt-1 text-[11px] text-warning">
                      房源信息不是实时的。发送给客户前，请先在贝壳 App 上确认这几套是否仍在售。
                    </p>
                  )}
                </div>
              </CardContent>
            </Card>

            {/* 推荐房源 */}
            {visibleProperties.length > 0 ? (
              <div className="space-y-2">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h2 className="flex items-center gap-1.5 text-sm font-semibold text-ink">
                    <CheckCheck className="size-4 text-success" />
                    推荐房源（{visibleProperties.length} 套）
                  </h2>
                  {removedCount > 0 && (
                    <p className="text-[11px] text-warning">
                      已移除 {removedCount} 套，复制前请重新生成文案以保持一致
                    </p>
                  )}
                </div>

                {visibleProperties.map((property, index) => (
                  <RecommendedPropertyCard
                    key={property.propertyId || property.externalId}
                    property={property}
                    index={index}
                    customerId={customerId}
                    onRemove={() => handleRemove(property.propertyId)}
                    onPin={() => handlePin(property.propertyId)}
                    onMoveUp={index > 0 ? () => handleMoveUp(index) : undefined}
                  />
                ))}

                {/* 人工调整后重新生成 */}
                {removedCount > 0 && (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => void handleRegenerate(replyStyle)}
                    disabled={regenerate.isPending}
                  >
                    {regenerate.isPending ? (
                      <Loader2 className="size-3.5 animate-spin" />
                    ) : (
                      <RefreshCw className="size-3.5" />
                    )}
                    按当前列表重新生成文案
                  </Button>
                )}
              </div>
            ) : (
              <Card>
                <CardContent className="p-4 text-center text-sm text-ink-secondary">
                  已移除全部房源。可以点「重新搜索」调整条件后再试。
                </CardContent>
              </Card>
            )}

            {/* 微信文案 */}
            {visibleProperties.length > 0 && (
              <Card className="border-success/40">
                <CardHeader className="pb-2">
                  <CardTitle className="flex flex-wrap items-center gap-1.5 text-sm">
                    <Clipboard className="size-4 text-success" />
                    微信发送文案
                    <Badge variant="outline" className="text-[10px] font-normal">
                      {replyContent.length} 字 ·{' '}
                      {result.reply.aiGenerated ? 'AI 生成' : '规则生成'}
                    </Badge>

                    {/* 风格切换 */}
                    <div className="ml-auto flex items-center gap-1">
                      {REPLY_STYLES.map((style) => (
                        <button
                          key={style.value}
                          type="button"
                          onClick={() => void handleRegenerate(style.value)}
                          disabled={regenerate.isPending}
                          className={cn(
                            'rounded-md border px-1.5 py-0.5 text-[11px] transition-colors',
                            replyStyle === style.value
                              ? 'border-brand-border bg-brand-subtle text-brand'
                              : 'border-border text-ink-secondary hover:bg-surface-hover',
                          )}
                        >
                          {style.label}
                        </button>
                      ))}
                    </div>
                  </CardTitle>
                </CardHeader>

                <CardContent className="space-y-3 pt-0">
                  {/* 文案正文：等宽字体 + 保留换行，方便核对 */}
                  <pre className="max-h-96 overflow-y-auto whitespace-pre-wrap rounded-md border border-border bg-surface-subtle p-3 text-xs leading-relaxed text-ink">
                    {replyContent}
                  </pre>

                  {/* 操作按钮 */}
                  <div className="flex flex-wrap items-center gap-2">
                    <Button onClick={() => void handleCopy()} disabled={copied}>
                      {copied ? (
                        <>
                          <ClipboardCheck className="size-3.5" />
                          已复制
                        </>
                      ) : (
                        <>
                          <Copy className="size-3.5" />
                          复制微信内容
                        </>
                      )}
                    </Button>

                    <Button
                      variant={sentConfirmed ? 'outline' : 'success'}
                      onClick={() => void handleConfirmSent()}
                      disabled={sentConfirmed || confirmSent.isPending}
                    >
                      {confirmSent.isPending ? (
                        <Loader2 className="size-3.5 animate-spin" />
                      ) : (
                        <Send className="size-3.5" />
                      )}
                      {sentConfirmed ? '已记录发送' : '我已发送'}
                    </Button>

                    <p className="text-[11px] text-ink-muted">
                      系统不会自动发送 —— 请到微信里粘贴发送，然后点「我已发送」记录
                    </p>
                  </div>
                </CardContent>
              </Card>
            )}
          </>
        )}
      </div>

      {/* ================= 官方平台检索助手 =================
          把客户需求翻译成"能在贝壳 App 里一键搜索"的检索式。
          与上面的房源推荐互补：推荐走系统内部房源，
          本面板走经纪人自己的官方账号（实时、合规）。 */}
      <PlatformSearchPanel customerId={customerId} hasRequirement={Boolean(profileData?.exists)} />

      {/* ================= 空状态提示 =================
          首次进入时给一句引导，而不是直接堆一个完整画像卡片 ——
          完整画像在下方「需求画像」Tab 里，避免重复。 */}
      {!result && !isRunning && !profileData?.exists && (
        <Card>
          <CardContent className="flex flex-col items-center gap-1.5 p-6 text-center">
            <Sparkles className="size-5 text-brand" />
            <p className="text-sm text-ink-secondary">还没有识别过这位客户的需求</p>
            <p className="text-xs text-ink-muted">
              在微信里复制客户发来的消息，粘贴到上面的框里，点按钮即可
            </p>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

/**
 * 真实进度面板。
 *
 * 这里的步骤文案**必须与后端真实执行的步骤一致**。
 * 后端返回的 steps 数组包含每一步的实际结果与耗时，
 * 因此这里直接展示"上一步做了什么、拿到了什么"，
 * 而不是笼统地写"正在搜索"（需求 §27 明确禁止虚假进度）。
 */
function ProgressPanel() {
  // 后端是单次请求返回全部步骤，因此前端无法拿到实时进度。
  // 这里按真实执行顺序展示阶段说明，并明确标注这是预期步骤而非实时状态，
  // 避免让用户误以为系统在实时上报。
  const stages = [
    { label: '保存客户消息', detail: '原文会先落库，后续失败也不会丢失' },
    { label: '识别客户需求', detail: '从消息中抽取购房条件' },
    { label: '更新客户画像', detail: '与历史需求合并，不覆盖旧信息' },
    { label: '查询贝壳真实房源', detail: '调用官方开放平台检索在售房源' },
    { label: '按硬性条件筛选', detail: '预算上限、户型、区域等确定性规则' },
    { label: '计算匹配度', detail: '预算/区域/户型/房龄/交通等 9 个维度' },
    { label: '补全房源详情', detail: '只对最匹配的几套查询详细数据' },
    { label: '生成微信文案', detail: '写成可以直接发给客户的话' },
  ];

  return (
    <Card>
      <CardContent className="p-4">
        <div className="flex items-center gap-2">
          <Loader2 className="size-4 animate-spin text-brand" />
          <p className="text-sm font-medium text-ink">正在处理，通常需要 10～30 秒</p>
        </div>
        <p className="mt-1 text-[11px] text-ink-muted">
          贝壳房源查询与详情补全是外部调用，耗时取决于对方服务响应速度
        </p>

        <ul className="mt-3 space-y-1.5">
          {stages.map((stage) => (
            <li key={stage.label} className="flex items-start gap-2 text-xs">
              <span className="mt-1 size-1.5 shrink-0 rounded-full bg-brand/40" />
              <span className="text-ink-secondary">
                {stage.label}
                <span className="ml-1.5 text-ink-muted">{stage.detail}</span>
              </span>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}
