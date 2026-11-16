import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { conversations, notifications, schedules, scheduleRuns, todos, usage, briefings, users as U } from '@/lib/schema';
import { and, desc, eq, gt, or, isNull, sql } from 'drizzle-orm';
import { rowsOf } from '@/lib/sql';
import { isBriefEnabled } from '@/lib/settings';
import { resolveModelWithFallback } from '@/lib/llm';
import { callModel } from '@/lib/llm-gateway';
import { newId, periodNow } from '@/lib/util';
import { withApi, apiError } from '@/lib/api/handler';

export const dynamic = 'force-dynamic';

function today(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// 把素材结构化为简报要点（模板降级 / 底线输出，永远有内容可展示）
function buildTemplate(m: {
  convSummaries: string[];
  unread: { title: string; body: string | null }[];
  failedRuns: string[];
  todoTitles: string[];
  quotaPct: number;
}): string[] {
  const out: string[] = [];
  if (m.convSummaries.length) out.push(`近 24h 有 ${m.convSummaries.length} 场新会话：${m.convSummaries.slice(0, 2).join('；')}`);
  if (m.unread.length) out.push(`有 ${m.unread.length} 条未读通知，最新：「${m.unread[0].title}」`);
  if (m.failedRuns.length) out.push(`定时任务出现 ${m.failedRuns.length} 次失败，建议检查：${m.failedRuns[0]}`);
  if (m.todoTitles.length) out.push(`待办收件箱有 ${m.todoTitles.length} 项待处理，优先处理：「${m.todoTitles[0]}」`);
  out.push(`本月 Token 额度已使用 ${m.quotaPct}%。`);
  return out.slice(0, 5);
}

type Material = Awaited<ReturnType<typeof gatherMaterial>>;

async function gatherMaterial(userId: string) {
  const dayAgo = Date.now() - 24 * 3600 * 1000;
  const period = periodNow();

  // 素材彼此独立，一次并行取回（原实现是 6 次串行 await，简报首屏要多等几个 RTT）。
  // 其中「失败任务」改为 JOIN + 归属过滤：原实现先取全局最新 5 条失败再按我的任务名过滤，
  // 别人任务连续失败时会把我自己的失败挤出 Top5，导致简报漏报。
  const [convs, unreads, failed, openTodos, usedRows, limitRow] = await Promise.all([
    db
      .select()
      .from(conversations)
      .where(and(eq(conversations.userId, userId), gt(conversations.createdAt, dayAgo)))
      .orderBy(desc(conversations.createdAt))
      .limit(5),
    db
      .select()
      .from(notifications)
      .where(and(or(eq(notifications.userId, userId), isNull(notifications.userId)), eq(notifications.read, false)))
      .orderBy(desc(notifications.createdAt))
      .limit(10),
    db
      .select({ name: schedules.name })
      .from(scheduleRuns)
      .innerJoin(schedules, eq(scheduleRuns.scheduleId, schedules.id))
      .where(
        and(
          gt(scheduleRuns.startedAt, dayAgo),
          eq(scheduleRuns.status, 'error'),
          or(eq(schedules.ownerId, userId), eq(schedules.scope, 'team')),
        ),
      )
      .orderBy(desc(scheduleRuns.startedAt))
      .limit(5),
    db
      .select({ title: todos.title })
      .from(todos)
      .where(and(eq(todos.userId, userId), eq(todos.status, 'open')))
      .orderBy(desc(todos.createdAt))
      .limit(10),
    db
      .select()
      .from(usage)
      .where(and(eq(usage.userId, userId), eq(usage.period, period)))
      .limit(1),
    db.select({ v: U.monthlyLimit }).from(U).where(eq(U.id, userId)).limit(1),
  ]);

  // 近 24h 会话的「最后一条助手消息」用 DISTINCT ON 一次取回：
  // 原实现是 for 循环里逐个会话查库（N+1，5 个会话 = 5 次往返）。
  const convIds = convs.map((c) => c.id);
  const lastRows = convIds.length
    ? rowsOf(
        await db.execute(sql`
          SELECT DISTINCT ON (conversation_id) conversation_id, content
          FROM messages
          WHERE conversation_id IN (${sql.join(
            convIds.map((id) => sql`${id}`),
            sql`, `,
          )}) AND role = 'assistant'
          ORDER BY conversation_id, created_at DESC
        `),
      )
    : [];
  const lastMap = new Map<string, string>(lastRows.map((r: any) => [String(r.conversation_id), String(r.content || '')]));
  const convSummaries: string[] = convs.map((c) => {
    const last = lastMap.get(c.id) || '';
    const text = (last || c.title || '').replace(/\s+/g, ' ').slice(0, 60);
    return `「${c.title}」${last ? '→ ' + text : ''}`;
  });

  const failedRuns: string[] = Array.from(new Set(failed.map((f) => f.name).filter(Boolean)));

  const used = usedRows[0]?.tokensUsed || 0;
  const limit = limitRow[0]?.v || 1000000;
  const quotaPct = Math.min(100, Math.round((used / limit) * 100));

  return {
    convSummaries,
    unread: unreads.map((u) => ({ title: u.title, body: u.body })),
    failedRuns: Array.from(new Set(failedRuns)),
    todoTitles: openTodos.map((t) => t.title),
    quotaPct,
  };
}

// cached 是可选的：停用分支本来就不返回它（改动前的响应体里也没有），
// 加上会改变前端可见的形状，没有必要。
type BriefResult = { items: string[]; generatedBy: 'ai' | 'template'; cached?: boolean; disabled?: boolean };

/**
 * 生成（或命中当日缓存）某用户的今日简报。
 *
 * 抽成独立函数而不是让 POST 直接调 GET 的处理函数：GET 现在被 withApi 包成
 * `(req, ctx) => Response`，POST 手里没有 req/ctx，硬调只能造一个假对象。
 * 逻辑本身与「HTTP 入口」无关，本来就不该挂在 handler 上。
 */
async function generateBrief(userId: string): Promise<BriefResult> {
  const enabled = await isBriefEnabled();

  // 当日已生成 → 直接返回（缓存命中）
  const existing = (
    await db
      .select()
      .from(briefings)
      .where(and(eq(briefings.userId, userId), eq(briefings.date, today())))
      .limit(1)
  )[0];
  if (existing) {
    return {
      items: JSON.parse(existing.items || '[]'),
      generatedBy: existing.modelUsed ? 'ai' : 'template',
      cached: true,
    };
  }

  const material = await gatherMaterial(userId);
  if (!enabled) {
    return { items: buildTemplate(material), generatedBy: 'template', disabled: true };
  }

  // 走 LLM 生成结构化简报；无可用模型/失败则模板降级
  let items: string[] = [];
  let byAI = false;
  try {
    const resolved = await resolveModelWithFallback();
    if (resolved) {
      const prompt =
        `请为一名团队平台用户生成「今日工作简报」。要求：3~5 条要点，每条不超过 60 字，中文；` +
        `第一条必须与“接下来值得做的事”相关（结合待办/通知/失败任务），其余按重要性排列。` +
        `输出 JSON 数组（仅数组，形如 ["要点1","要点2"]），不要输出任何其他文字。\n\n素材：\n` +
        `会话动态：${material.convSummaries.join('；') || '无'}\n` +
        `未读通知：${material.unread.map((u) => u.title + (u.body ? `（${u.body.slice(0, 40)}）` : '')).join('；') || '无'}\n` +
        `失败定时任务：${material.failedRuns.join('、') || '无'}\n` +
        `未完成待办：${material.todoTitles.join('、') || '无'}\n` +
        `本月额度使用：${material.quotaPct}%`;
      const r = await callModel({
        model: resolved,
        label: 'brief',
        prompt,
        maxTokens: 300,
        userId,
        // 简报是旁路增强：模板兜底已经存在，宁可早失败也不要把请求拖住
        timeoutMs: 30_000,
      });
      try {
        const matched = r.text.match(/\[[\s\S]*\]/);
        const parsed = matched ? JSON.parse(matched[0]) : null;
        if (Array.isArray(parsed)) items = parsed.filter((x) => typeof x === 'string' && x.trim()).slice(0, 5);
      } catch {
        /* 走模板 */
      }
      if (items.length) byAI = true;
    }
  } catch {
    /* 走模板 */
  }
  if (!items.length) items = buildTemplate(material);

  await db.insert(briefings).values({
    id: newId('bri'),
    userId,
    date: today(),
    items: JSON.stringify(items),
    modelUsed: byAI ? 'ai' : null,
    createdAt: Date.now(),
  });
  return { items, generatedBy: byAI ? 'ai' : 'template', cached: false };
}

export const GET = withApi(async ({ session }) => {
  return NextResponse.json(await generateBrief(session.userId));
});

// 重新生成（每日限 2 次）：删除今日记录后重新生成
export const POST = withApi(async ({ session }) => {
  const s = session;
  const row = (
    await db
      .select()
      .from(briefings)
      .where(and(eq(briefings.userId, s.userId), eq(briefings.date, today())))
      .limit(1)
  )[0];
  const regenCount = Number(row?.modelUsed?.includes('#regen') ? row.modelUsed!.split('#regen')[1] : 0) || 0;
  if (row && regenCount >= 2) {
    apiError(429, 'REGEN_LIMIT', '今日重新生成次数已用完（每日 2 次）');
  }
  if (row) await db.delete(briefings).where(eq(briefings.id, row.id));

  const fresh0 = await generateBrief(s.userId);

  const fresh = (
    await db
      .select()
      .from(briefings)
      .where(and(eq(briefings.userId, s.userId), eq(briefings.date, today())))
      .limit(1)
  )[0];
  if (fresh) {
    const base = (fresh.modelUsed || '').replace(/#regen.*$/, '');
    await db.update(briefings).set({ modelUsed: `${base}#regen${regenCount + 1}` }).where(eq(briefings.id, fresh.id));
  }
  return NextResponse.json({ items: fresh ? JSON.parse(fresh.items || '[]') : fresh0.items, regenerated: true });
});
