import { db } from './db';
import { users as U, usage as USG } from './schema';
import { eq, and } from 'drizzle-orm';
import { periodNow } from './util';

export type QuotaCheck = {
  /** 是否应拒绝运行：仅当「已用尽」且策略为 block 时为 true */
  exceeded: boolean;
  action: string;
  limit: number;
  used: number;
};

/**
 * 用户月度 Token 额度预检（与对话通道 chat/route.ts 同一口径：block / warn / downgrade）。
 * - block：已用尽则本次应拒绝运行（exceeded=true）
 * - warn / downgrade：用尽也放行，不阻断
 * 真正用量累加仍由 lib/util.addUsage 在运行完成后写入，预检只用于「拒绝」判定，
 * 因此技能运行、定时任务也能复用同一套预算约束，避免绕过对话通道烧穿额度。
 */
export async function checkQuota(userId: string): Promise<QuotaCheck> {
  const period = periodNow();
  const [uRow, usedRows] = await Promise.all([
    db.select().from(U).where(eq(U.id, userId)).limit(1),
    db.select().from(USG).where(and(eq(USG.userId, userId), eq(USG.period, period))).limit(1),
  ]);
  const u = uRow[0];
  const limit = u?.monthlyLimit ?? 1000000; // ?? 而非 ||：0 是「额度为零」的合法配置，不能被当成未设置
  const used = usedRows[0]?.tokensUsed || 0;
  const action = u?.overQuotaAction || 'block';
  const exceeded = used >= limit && action === 'block';
  return { exceeded, action, limit, used };
}
