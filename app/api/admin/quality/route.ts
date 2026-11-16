import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { rowsOf } from '@/lib/sql';
import { withApi } from '@/lib/api/handler';
import { aggregateChannelHealth, type ChannelHealthLogRow } from '@/lib/agent/channel-health';
import { readAlertPolicy, type AlertState } from '@/lib/agent/quality-alert';
import { getSetting } from '@/lib/settings';

export const dynamic = 'force-dynamic';

const DAY_MS = 86400000;
/**
 * 明细行数上限。
 *
 * 为什么不用 SQL 直接 GROUP BY：规则名藏在 detail 文本里（见 channel-health.ts 的注释），
 * 数据库侧无法可靠聚合。所以把窗口内的明细拉回 Node 解析。
 *
 * 上限必须有，且**截断必须上报**（响应里的 `truncated`）：
 * 悄悄截断会让「问题变少」看起来像「质量变好」，和 `unparsed` 是同一类陷阱。
 */
const MAX_ROWS = 20000;

/**
 * 通道健康度：最近 N 天里各通道触发校验规则与出口护栏的分布。
 *
 * 数据源是 `operation_logs`，不是新表：
 *  - `eval_runtime`             —— 运行时 V 层（v8.6 起覆盖 skill / schedule）
 *  - `guardrail_output_block`   —— 出口护栏拦截（含观察模式）
 *
 * 仅管理员：这是全局视图，成员看不到别人的技能与任务名。
 */
export const GET = withApi(
  async ({ req }) => {
    const days = Math.min(90, Math.max(1, Number(req.nextUrl.searchParams.get('days') || 7)));
    const now = Date.now();
    const since = now - days * DAY_MS;

    const raw = rowsOf(
      await db.execute(sql`
        SELECT action, target, status, detail, created_at
        FROM operation_logs
        WHERE created_at >= ${since}
          AND action IN ('eval_runtime', 'guardrail_output_block')
        ORDER BY created_at DESC
        LIMIT ${MAX_ROWS}
      `),
    );

    const rows: ChannelHealthLogRow[] = raw.map((r) => ({
      action: String(r?.action || ''),
      target: r?.target ?? null,
      status: r?.status ?? null,
      detail: r?.detail ?? null,
      // bigint 在部分驱动下返回字符串，统一成 number 再进聚合
      createdAt: Number(r?.created_at ?? 0),
    }));

    return NextResponse.json({
      days,
      since,
      /** true = 达到行数上限，统计只覆盖最近 MAX_ROWS 条 */
      truncated: raw.length >= MAX_ROWS,
      ...aggregateChannelHealth(rows, { days, now }),
      /**
       * 告警状态（V8.8）。
       *
       * 页面上必须有这一块，否则「配了告警却没收到」无法回答——三种可能
       * （没到阈值 / 在静默期 / 检查根本没跑）在界面上看起来完全一样。
       * 读取失败不影响统计：告警是附加信息，不该把主视图拖挂。
       */
      alerts: await readAlertSnapshot(),
    });
  },
  { auth: 'admin' },
);

async function readAlertSnapshot() {
  const policy = readAlertPolicy();
  let state: AlertState = { fired: {} };
  try {
    const raw = await getSetting('quality_alert_state');
    if (raw) {
      const o = JSON.parse(raw) as Partial<AlertState>;
      // 逐字段收敛而不是整体 cast：这份 JSON 由旧版本写入，形状可能缺少新字段，
      // 直接信任它会让下面的 Object.entries(undefined) 在页面上炸掉。
      state = {
        fired: o && typeof o.fired === 'object' && o.fired ? o.fired : {},
        unparsedAt: Number(o?.unparsedAt) || undefined,
        lastRunAt: Number(o?.lastRunAt) || undefined,
        lastResult: o?.lastResult,
        // 逐字段收敛时同样要带上它：漏掉这一步，「外发失败」在页面上永远显示为 null，
        // 而 null 的语义是「从未外发」——一次静默的失败就变成了「没配」。
        lastExternal: o && typeof o.lastExternal === 'object' ? o.lastExternal ?? undefined : undefined,
      };
    }
  } catch {
    /* 状态读失败时只显示策略，不假装「从未告警」 */
    return { policy, state: null, error: 'unreadable' as const };
  }
  return {
    policy,
    /** lastRunAt 为空 = 检查从未跑过（调度器未启用 / 刚部署），这本身就是答案 */
    state: {
      lastRunAt: state.lastRunAt ?? null,
      lastResult: state.lastResult ?? null,
      /**
       * 外发结果（V8.9）。必须暴露，否则「配了 webhook 却没收到」无法与
       * 「根本没告警」区分——两者在页面上都会表现为「没有新消息」。
       * `null` 表示从未外发过（含未配置），与「外发失败」是两件事。
       */
      lastExternal: state.lastExternal ?? null,
      /** 处于静默期、尚未恢复的告警项 */
      active: Object.entries(state.fired)
        .filter(([, v]) => v && !v.recoveredAt)
        .map(([key, v]) => ({ key, at: v.at, count: v.count, observe: !!v.observe }))
        .sort((a, b) => b.at - a.at)
        .slice(0, 20),
      activeTotal: Object.keys(state.fired).length,
    },
  };
}
