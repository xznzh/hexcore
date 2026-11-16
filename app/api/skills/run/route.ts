import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { skills, skillRuns } from '@/lib/schema';
import { eq } from 'drizzle-orm';
import { runSkill } from '@/lib/agent';
import { finalizeChannel, toolOutputsOf } from '@/lib/agent/answer-guard';
import { auditChannelAnswer } from '@/lib/agent/channel-verify';
import { judgeChannelAnswer } from '@/lib/agent/runtime-judge';
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
 * 技能通道的出口护栏（V8.4）+ 运行时 V 层（V8.6）。
 *
 * 与 V8.3 的差别只有一处，但很关键：**把通道自己的上下文带进去了**。
 *  - `question` = 本次运行的输入 → 用户说「就按我说的定」时，越权类规则才会生效；
 *  - `toolOutputs` = 轨迹里所有 tool 节点产出 → 检索片段里出现过的 `《某报告》`
 *    才算「有据可引」，否则「照着知识库引用」这条最正当的路径会被误判成编造引用。
 *
 * 只认 tool 节点（`toolOutputsOf` 内部已过滤），模型自己的输出不构成出处。
 *
 * V8.6 在同一函数里补上 `auditChannelAnswer`，顺序不能反：V 层校验的对象是
 * **护栏之后**的文本。放在前面等于对着「已经不会外发」的草稿报警，
 * 日志会把护栏的功劳记成模型的过错。
 */
function guardRun(
  text: string,
  opts: {
    userId: string;
    skillName: string;
    input: string;
    trajectory: readonly { type?: string; tool?: string; output?: string }[];
  },
) {
  const r = finalizeChannel(text, {
    userId: opts.userId,
    source: 'skill',
    label: opts.skillName,
    question: opts.input,
    toolOutputs: toolOutputsOf(opts.trajectory),
  });
  auditChannelAnswer(
    { userId: opts.userId, source: 'skill', label: opts.skillName },
    { answer: r.text, trajectory: opts.trajectory },
  );
  /**
   * V8.9：语义抽查（judge）。
   *
   * 与上面的确定性校验是**并联**关系，不是替代：`auditChannelAnswer` 每次必跑、
   * 零成本、只抓可枚举的硬伤；judge 有成本、按采样跑、能看出「工具失败但回答说成功」
   * 这类规则抓不到的问题。
   *
   * fire-and-forget：不 await，也不接本轮请求的 signal——技能运行没有「客户端断开」
   * 的概念（它可能来自定时任务或另一个服务），判定结果只写日志。
   * 是否真的调用由 `RUNTIME_JUDGE` + 采样 + 日预算三层决定，默认关闭。
   */
  void judgeChannelAnswer({
    userId: opts.userId,
    channel: 'skill',
    label: opts.skillName,
    question: opts.input,
    answer: r.text,
    trace: opts.trajectory,
  }).catch(() => {});
  return r;
}

/** 被拦过就告诉调用方（前端要能提示「部分内容已按安全策略处理」，webhook 也能据此告警） */
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
      const r = await runSkill(steps, run.input, sk.modelId || undefined, s.userId, run.resumeIndex, run.resumePrev || '');
      // V8.3 · R2 起有出口护栏；V8.4 补上通道上下文（见 guardRun 注释）
      const guard = guardRun(r.result || '', {
        userId: s.userId,
        skillName: sk.name,
        input: run.input,
        trajectory: r.trajectory,
      });
      const guardedResult = guard.text;
      const merged = [...(JSON.parse(run.trajectory || '[]') as any[]), ...r.trajectory];
      if (r.paused) {
        await db.update(skillRuns).set({
          status: 'paused',
          resumeIndex: r.nextIndex || 0,
          resumePrev: r.prev || '',
          trajectory: JSON.stringify(merged),
          result: guardedResult,
        }).where(eq(skillRuns.id, resumeId));
        return NextResponse.json({ ok: true, paused: true, runId: resumeId, result: guardedResult, trajectory: merged, ...guardMeta(guard) });
      }
      if (r.aborted) {
        await db.update(skillRuns).set({ status: 'error', trajectory: JSON.stringify(merged), result: guardedResult }).where(eq(skillRuns.id, resumeId));
        // 中断不是「服务器内部错误」：保留 aborted / result / runId 三个字段，
        // 前端要据此展示「已中断」而不是「运行失败」。
        return NextResponse.json(
          { error: r.abortReason || '运行被中断', aborted: true, result: guardedResult, runId: resumeId, ...guardMeta(guard) },
          { status: 429 },
        );
      }
      await db.update(skillRuns).set({ status: 'done', trajectory: JSON.stringify(merged), result: guardedResult }).where(eq(skillRuns.id, resumeId));
      await addUsage(s.userId, estimateTokens(run.input) + estimateTokens(guardedResult || ''));
      return NextResponse.json({ ok: true, result: guardedResult, trajectory: merged, ...guardMeta(guard) });
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
    const r = await runSkill(steps, input, sk.modelId || undefined, s.userId);
    // 同上的出口护栏（全新运行路径）
    const guard = guardRun(r.result || '', {
      userId: s.userId,
      skillName: sk.name,
      input,
      trajectory: r.trajectory,
    });
    const guardedResult = guard.text;
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
      return NextResponse.json({ ok: true, paused: true, runId, result: guardedResult, trajectory: r.trajectory, ...guardMeta(guard) });
    }
    if (r.aborted) {
      return NextResponse.json(
        { error: r.abortReason || '运行被中断', aborted: true, result: guardedResult, ...guardMeta(guard) },
        { status: 429 },
      );
    }
    await addUsage(s.userId, estimateTokens(input) + estimateTokens(guardedResult || ''));
    await logAction(s.userId, 'skill_run', sk.name);
    return NextResponse.json({ ok: true, result: guardedResult, trajectory: r.trajectory, ...guardMeta(guard) });
  } catch (e: any) {
    if (e instanceof ApiError) throw e;
    await db.insert(skillRuns).values({
      id: runId, skillId: id, ownerId: s.userId, input, trajectory: '[]', result: e?.message || '运行失败',
      status: 'error', createdAt: Date.now(),
    });
    apiError(500, 'SKILL_RUN_FAILED', String(e?.message || '运行失败').slice(0, 300));
  }
});
