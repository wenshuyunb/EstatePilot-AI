'use client';

/**
 * 官方平台检索助手面板。
 *
 * ============================================================================
 * 它解决什么问题
 * ============================================================================
 * 经纪人的真实工作流是：
 *   客户在微信说需求 → 经纪人在贝壳 App 里搜 → 挑房源发给客户
 *
 * 第二步是纯粹的机械劳动，而且**每次客户改口都要重做**：
 *   客户说"400万左右，岛外三房" → 经纪人要自己翻译成
 *   "城市=厦门 / 区=集美+海沧+同安+翔安 / 户型=3房 / 总价≤460万"
 *   然后在 App 里一项项点选。
 *
 * 本面板把这个翻译过程自动化，输出**可直接粘贴的检索式**。
 *
 * ============================================================================
 * 合规边界（不可移除）
 * ============================================================================
 * ⚠️ 本面板**不抓取任何平台数据**，不绕过任何反爬措施。
 * 它只做两件事：把自然语言需求翻译成检索条件（纯本地计算）、
 * 提供官方 App/网页的入口，由经纪人用**自己的账号**查看房源。
 *
 * 界面文案必须如实反映这一点，不能让用户以为系统在替他抓数据。
 */

import { useState } from 'react';
import { Check, Copy, ExternalLink, Loader2, Search, Sparkles } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { useToast } from '@/components/ui/toast';
import { usePlatformSearchPlan } from '@/lib/queries/use-platform-search-plan';

interface PlatformSearchPanelProps {
  customerId: string;
  /** 是否有需求画像（没有时提示先粘贴消息） */
  hasRequirement: boolean;
}

export function PlatformSearchPanel({ customerId, hasRequirement }: PlatformSearchPanelProps) {
  const { toast } = useToast();
  const [copied, setCopied] = useState(false);

  const { data, isLoading, isError, refetch } = usePlatformSearchPlan(customerId, hasRequirement);
  const plan = data?.plan ?? null;

  const handleCopy = async (): Promise<void> => {
    if (!plan) return;

    try {
      await navigator.clipboard.writeText(plan.searchText);
      setCopied(true);
      toast({
        variant: 'success',
        title: '检索式已复制',
        description: '打开贝壳 App，长按搜索框粘贴即可',
      });
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast({
        variant: 'error',
        title: '复制失败',
        description: '请手动选中检索式后按 Ctrl+C',
      });
    }
  };

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-sm">
          <Search className="size-4 text-brand" />
          官方平台检索助手
          <Badge variant="outline" className="text-[10px]">
            用您自己的账号查
          </Badge>
        </CardTitle>
      </CardHeader>

      <CardContent className="space-y-3">
        {/* 无需求时给出明确指引，而不是空白 */}
        {!hasRequirement && (
          <p className="text-xs text-ink-secondary">
            该客户还没有需求记录。请先在上方粘贴客户的几句话，这里会自动生成检索条件。
          </p>
        )}

        {hasRequirement && isLoading && (
          <p className="flex items-center gap-1.5 text-xs text-ink-muted">
            <Loader2 className="size-3 animate-spin" />
            正在生成检索条件…
          </p>
        )}

        {hasRequirement && isError && (
          <div className="space-y-2">
            <p className="text-xs text-danger">检索条件生成失败</p>
            <Button size="sm" variant="outline" onClick={() => void refetch()}>
              重试
            </Button>
          </div>
        )}

        {hasRequirement && !isLoading && !isError && !plan && (
          <p className="text-xs text-ink-secondary">{data?.message ?? '暂无法生成检索条件'}</p>
        )}

        {plan && (
          <>
            {/* 检索式：核心产出 */}
            <div className="rounded-md border border-brand/30 bg-brand-subtle p-3">
              <div className="mb-1.5 flex items-center gap-1.5">
                <Sparkles className="size-3 text-brand" />
                <span className="text-[11px] font-medium text-brand">
                  检索式 —— 粘进贝壳 App 搜索框
                </span>
              </div>

              <p className="select-all font-mono text-sm leading-relaxed text-ink">
                {plan.searchText}
              </p>

              <div className="mt-2 flex flex-wrap items-center gap-2">
                <Button size="sm" onClick={() => void handleCopy()}>
                  {copied ? (
                    <>
                      <Check className="size-3.5" />
                      已复制
                    </>
                  ) : (
                    <>
                      <Copy className="size-3.5" />
                      复制检索式
                    </>
                  )}
                </Button>

                {/*
                  网页链接是备用入口。
                  实测：贝壳网页版有反爬保护，直接访问会跳验证码页，
                  因此文案里如实说明，避免用户以为是系统的问题。
                */}
                {plan.deepLink && (
                  <a
                    href={plan.deepLink}
                    target="_blank"
                    rel="noreferrer noopener"
                    className="inline-flex items-center gap-1 text-[11px] text-ink-secondary underline decoration-dotted hover:text-brand"
                  >
                    <ExternalLink className="size-3" />
                    打开贝壳网页版（可能要求验证）
                  </a>
                )}
              </div>
            </div>

            {/* 结构化条件：让经纪人核对"系统理解得对不对" */}
            <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-xs sm:grid-cols-4">
              <Field label="城市" value={plan.city} />
              <Field label="行政区" value={plan.districts.map((d) => d.replace(/[区县]$/, '')).join('、') || '不限'} />
              <Field label="户型" value={plan.bedrooms.length > 0 ? `${plan.bedrooms.join('或')} 房` : '不限'} />
              <Field
                label="总价"
                value={plan.priceMax ? `${Math.round(plan.priceMax / 10_000)} 万以内` : '不限'}
              />
            </div>

            {/* 提醒：条件缺失或链接限制 */}
            {plan.warnings.length > 0 && (
              <ul className="space-y-1">
                {plan.warnings.map((warning) => (
                  <li key={warning} className="text-[11px] text-ink-muted">
                    · {warning}
                  </li>
                ))}
              </ul>
            )}

            {/* 合规说明：必须显示，避免用户误解系统在替他取数据 */}
            <p className="border-t border-border pt-2 text-[11px] leading-relaxed text-ink-muted">
              本助手只把客户需求翻译成检索条件，<strong className="text-ink-secondary">不抓取任何平台数据</strong>。
              房源由您用自己的账号在贝壳 App 里查看后，可把结果粘贴回上方由系统打分排序。
            </p>
          </>
        )}
      </CardContent>
    </Card>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <span className="text-ink-muted">{label}：</span>
      <span className="text-ink">{value}</span>
    </div>
  );
}
