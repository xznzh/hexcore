import { NextResponse } from 'next/server';
import { withApi } from '@/lib/api/handler';
import { readAlertPolicy, runQualityCheck } from '@/lib/agent/quality-alert';

export const dynamic = 'force-dynamic';

/**
 * 手动触发一次质量告警检查（V8.8）。
 *
 * 存在的理由：告警是周期任务，**上线后想验证它是否真的会响，只能等**。
 * 而「等」在这类需求上几乎等于「不验证」——阈值调得对不对，没人会在一周后回来确认。
 *
 * `dryRun: true` 只算不发，返回本轮会发出的通知原文。调阈值时的正确用法是
 * 先 dryRun 看一遍，确认不会误伤再让它真发——而不是先发一轮再后悔。
 *
 * 仅管理员：这个接口会给全体管理员发通知，不能开放给成员。
 */
export const POST = withApi(
  async ({ req, session }) => {
    const body = await req.json().catch(() => ({}));
    const dryRun = body?.dryRun === true;
    const r = await runQualityCheck({ dryRun });
    return NextResponse.json({
      ...r,
      /** 把当前生效的策略一起返回：阈值来自环境变量，页面上看不到就无法解释「为什么没响」 */
      policy: dryRun ? readAlertPolicy() : undefined,
      by: session.userId,
    });
  },
  { auth: 'admin' },
);
