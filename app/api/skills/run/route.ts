import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { skills, skillRuns } from '@/lib/schema';
import { eq } from 'drizzle-orm';
import { runSkillGoverned } from '@/lib/agent';
import { newId, logAction, estimateTokens, addUsage } from '@/lib/util';
import { accessibleProjectIds } from '@/lib/projects';
import { checkRateLimit } from '@/lib/redis';
import { checkQuota } from '@/lib/quota';
import { withApi, apiError, ApiError } from '@/lib/api/handler';

export const dynamic = 'force-dynamic';

/** 当前用户是否有权运行该技能：本人 / 团队 / 内置 / 可访问项目 */
async function canRunSkill(sk: any, userId: string, role: string): Promise<boolean> {
  if (!sk) return false;
  if (sk.ownerId === userId || sk.scope === 'team' || sk.scope === 'builtin') return true;
  if (sk.projectId) {
    const projIds = await accessibleProjectIds(userId, role);
    return projIds.has(sk.projectId);
  }
  return false;
}

/**
 * 出口护栏 + 运行时 V 层 + 语义抽查：三段已经收进 `runSkillGoverned`
 * （见 `lib/agent/channel-governance.ts` 的文件头）。
 *
 * 这里只保留「告诉调用方被拦过」这一件事——拦截不能是隐形的，
 * 前端要能提示「部分内容已按安全策略处理」，webhook 也能据此告警。
 */
function guardMeta(r: { blocked: boolean; rule?: string }) {
  return r.blocked ? { guard: { blocked: true, rule: r.rule } } : {};
}

export const POST = withApi(async ({ req, session }) => {
  const s = session;
  if (s.role === 'guest') apiError(403, 'FORBIDDEN', '访客无写入权限');
  const body = await req.json().catch(() => null);

  // 技能运行也受用户月度预算与频控约束，避免绕过对话通道烧穿额度 / 被打爆上游
  const allowed = await checkRateLimit(`ratelimit:skill:${s.userId}`, 20, 60);
  if (!allowed) apiError(429, 'RATE_LIMITED', '操作过于频繁，请稍后再试');
  const quota = await checkQuota(s.userId);
  if (quota.exceeded) {
    apiError(403, 'QUOTA_EXCEEDED', '本月 Token 额度已用尽，请联系管理员调整「超限策略」');
  }

  // —— 恢复（人工确认后续跑）——
  const resumeId: string | undefined = body?.resume;
  if (resumeId) {
    const run = (await db.select().from(skillRuns).where(eq(skillRuns.id, resumeId)).limit(1))[0];
    if (!run || run.ownerId !== s.userId) apiError(404, 'NOT_FOUND', '运行记录不存在');
    const sk = run.skillId
      ? (await db.select().from(skills).where(eq(skills.id, run.skillId)).limit(1))[0]
      : undefined;
    if (!sk) apiError(404, 'NOT_FOUND', '技能不存在');
    if (!(await canRunSkill(sk, s.userId, s.role))) apiError(403, 'FORBIDDEN', '无权运行该技能');

    try {
      const steps = JSON.parse(sk.steps || '[]');
      // 续跑也走同一个治理门面：换一种「入口」不该换一套护栏。
      // question 用 run.input（原始指令），不是这一段的上一步产出——语境风险按最初的要求算。
      const r = await runSkillGoverned(steps, run.input, {
        modelId: sk.modelId || undefined,
        userId: s.userId,
        source: 'skill',
        label: sk.name,
        question: run.input,
        startIndex: run.resumeIndex,
        prevInit: run.resumePrev || '',
      });
      const guardedResult = r.text;
      const merged = [...(JSON.parse(run.trajectory || '[]') as any[]), ...r.trajectory];
      if (r.paused) {
        await db.update(skillRuns).set({
          status: 'paused',
          resumeIndex: r.nextIndex || 0,
          resumePrev: r.prev || '',
          trajectory: JSON.stringify(merged),
          result: guardedResult,
        }).where(eq(skillRuns.id, resumeId));
        return NextResponse.json({ ok: true, paused: true, runId: resumeId, result: guardedResult, trajectory: merged, ...guardMeta(r.guard) });
      }
      if (r.aborted) {
        await db.update(skillRuns).set({ status: 'error', trajectory: JSON.stringify(merged), result: guardedResult }).where(eq(skillRuns.id, resumeId));
        // 中断不是「服务器内部错误」：保留 aborted / result / runId 三个字段，
        // 前端要据此展示「已中断」而不是「运行失败」。
        return NextResponse.json(
          { error: r.abortReason || '运行被中断', aborted: true, result: guardedResult, runId: resumeId, ...guardMeta(r.guard) },
          { status: 429 },
        );
      }
      await db.update(skillRuns).set({ status: 'done', trajectory: JSON.stringify(merged), result: guardedResult }).where(eq(skillRuns.id, resumeId));
      await addUsage(s.userId, estimateTokens(run.input) + estimateTokens(guardedResult || ''));
      return NextResponse.json({ ok: true, result: guardedResult, trajectory: merged, ...guardMeta(r.guard) });
    } catch (e: any) {
      // catch 内的 apiError 必须原样抛出，否则会被这里再包一层
      if (e instanceof ApiError) throw e;
      await db.update(skillRuns).set({ status: 'error', result: e?.message || '运行失败' }).where(eq(skillRuns.id, resumeId));
      // 这里刻意把原始错误信息带给调用方：模型/连接器失败的原因（超时、鉴权、余额）
      // 对用户是可执行的，压成「服务器内部错误」只会让人无从下手。仅截断长度。
      apiError(500, 'SKILL_RUN_FAILED', String(e?.message || '运行失败').slice(0, 300));
    }
  }

  // —— 全新运行 ——
  const id: string | undefined = body?.id;
  const input: string = body?.input?.trim();
  if (!id || !input) apiError(400, 'INVALID_ARGUMENT', '缺少技能 id 或输入');

  const sk = (await db.select().from(skills).where(eq(skills.id, id)).limit(1))[0];
  if (!sk) apiError(404, 'NOT_FOUND', '技能不存在');
  if (!(await canRunSkill(sk, s.userId, s.role))) apiError(403, 'FORBIDDEN', '无权运行该技能');

  const runId = newId('run');
  try {
    const steps = JSON.parse(sk.steps || '[]');
    const r = await runSkillGoverned(steps, input, {
      modelId: sk.modelId || undefined,
      userId: s.userId,
      source: 'skill',
      label: sk.name,
      question: input,
    });
    const guardedResult = r.text;
    await db.insert(skillRuns).values({
      id: runId,
      skillId: id,
      ownerId: s.userId,
      input,
      trajectory: JSON.stringify(r.trajectory),
      result: guardedResult,
      status: r.paused ? 'paused' : r.aborted ? 'error' : 'done',
      resumeIndex: r.nextIndex || 0,
      resumePrev: r.prev || '',
      createdAt: Date.now(),
    });
    if (r.paused) {
      return NextResponse.json({ ok: true, paused: true, runId, result: guardedResult, trajectory: r.trajectory, ...guardMeta(r.guard) });
    }
    if (r.aborted) {
      return NextResponse.json(
        { error: r.abortReason || '运行被中断', aborted: true, result: guardedResult, ...guardMeta(r.guard) },
        { status: 429 },
      );
    }
    await addUsage(s.userId, estimateTokens(input) + estimateTokens(guardedResult || ''));
    await logAction(s.userId, 'skill_run', sk.name);
    return NextResponse.json({ ok: true, result: guardedResult, trajectory: r.trajectory, ...guardMeta(r.guard) });
  } catch (e: any) {
    if (e instanceof ApiError) throw e;
    await db.insert(skillRuns).values({
      id: runId, skillId: id, ownerId: s.userId, input, trajectory: '[]', result: e?.message || '运行失败',
      status: 'error', createdAt: Date.now(),
    });
    apiError(500, 'SKILL_RUN_FAILED', String(e?.message || '运行失败').slice(0, 300));
  }
});
