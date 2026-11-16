import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { models, operationLogs } from '@/lib/schema';
import { and, eq, gte, sql } from 'drizzle-orm';
import { withApi } from '@/lib/api/handler';
import { composeCostReport, normalizeModelName, type CostAggRow, type ModelPrice } from '@/lib/agent/cost-report';

export const dynamic = 'force-dynamic';

/**
 * 成本看板：聚合 operation_logs 的 token 与金额。
 *
 * V8.10 起改为读结构化列（`model` / `label` / `ok` / `prompt_tokens` / `completion_tokens`）。
 * 之前靠 `split_part(target,' | ',n)` 从摘要串里反解——模型名或用途里出现一个 ` | `
 * 就整体错位，而且**错位不报错**：成本会安静地记到另一个模型头上。
 *
 * 兼容：v8.10 之前的行这几列为 NULL，这里用 SQL 表达式回落到 target 拆分。
 * 回落只影响读取，不重写历史行——审计流水保持原样。
 */

/** 历史行兜底：model 列没值时从 `target` 的第一段取 */
const modelExpr = sql<string>`coalesce(nullif(${operationLogs.model}, ''), nullif(split_part(${operationLogs.target}, ' | ', 1), ''), 'unknown')`;
/** 历史行兜底：label 列没值时从第二段取 */
const labelExpr = sql<string>`coalesce(nullif(${operationLogs.label}, ''), nullif(split_part(${operationLogs.target}, ' | ', 2), ''), '（未知）')`;
/**
 * 历史行的成败：target 里带 ` | OK | ` / ` | FAIL | ` 才判得出来，
 * 都没有就返回 NULL（= 未知），**不要**默认成失败——那会让失败率凭空变高。
 */
const okExpr = sql<boolean | null>`coalesce(${operationLogs.ok}, case when ${operationLogs.target} like '% | OK | %' then true when ${operationLogs.target} like '% | FAIL | %' then false else null end)`;
const dayExpr = sql<string>`to_char(to_timestamp(${operationLogs.createdAt} / 1000), 'YYYY-MM-DD')`;

export const GET = withApi(
  async ({ req }) => {
    const { searchParams } = new URL(req.url);
    const days = [7, 30, 90].includes(Number(searchParams.get('days'))) ? Number(searchParams.get('days')) : 30;
    const since = Date.now() - days * 86_400_000;

    const rows = (await db
      .select({
        day: dayExpr,
        model: modelExpr,
        label: labelExpr,
        ok: okExpr,
        calls: sql<number>`count(*)`,
        tokens: sql<number>`coalesce(sum(${operationLogs.tokens}), 0)`,
        promptTokens: sql<number>`coalesce(sum(${operationLogs.promptTokens}), 0)`,
        completionTokens: sql<number>`coalesce(sum(${operationLogs.completionTokens}), 0)`,
      })
      .from(operationLogs)
      .where(and(eq(operationLogs.action, 'llm_call'), gte(operationLogs.createdAt, since)))
      // PostgreSQL 要求聚合的每个非聚合表达式都出现在 GROUP BY；漏一个就报 42803，
      // 页面会永久停在「加载中」——这个错在 2026-10-27 真机走查时踩过一次。
      .groupBy(dayExpr, modelExpr, labelExpr, okExpr)) as any[];

    // 单价从后台模型配置读（分/千 token）。按归一化名建索引，容忍 `MiniMax-M3.1` 与 `MiniMax M3.1` 两种写法。
    const priceRows = await db
      .select({ name: models.name, priceIn: models.priceIn, priceOut: models.priceOut })
      .from(models);
    const prices = new Map<string, ModelPrice>();
    for (const p of priceRows as any[]) {
      prices.set(normalizeModelName(String(p.name || '')), {
        in: Number(p.priceIn) || 0,
        out: Number(p.priceOut) || 0,
      });
    }

    const aggRows: CostAggRow[] = (rows || []).map((r) => ({
      day: String(r.day),
      model: r.model ?? null,
      label: r.label ?? null,
      // SQL 里的布尔可能以 't'/'f' 或 true/false 形式返回，统一归一
      ok: r.ok === null || r.ok === undefined ? null : r.ok === true || r.ok === 't' || r.ok === 'true',
      calls: Number(r.calls) || 0,
      tokens: Number(r.tokens) || 0,
      promptTokens: Number(r.promptTokens) || 0,
      completionTokens: Number(r.completionTokens) || 0,
    }));

    const report = composeCostReport(aggRows, prices);

    return NextResponse.json({
      days,
      from: new Date(since).toISOString().slice(0, 10),
      to: new Date().toISOString().slice(0, 10),
      /** 单位说明随数据一起下发，避免前端各写一份「分还是元」的解释 */
      currency: { unit: 'cent', priceUnit: 'cent/1k tokens' },
      ...report,
    });
  },
  { auth: 'admin' },
);
