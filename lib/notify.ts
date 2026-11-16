import { db } from './db';
import { notifications } from './schema';
import { newId } from './util';
import { and, eq } from 'drizzle-orm';

export async function createNotification(userId: string | null, title: string, body?: string) {
  try {
    await db.insert(notifications).values({
      id: newId('n'),
      userId,
      title,
      body: body || null,
      read: false,
      createdAt: Date.now(),
    });
  } catch {
    /* 通知失败不影响主流程 */
  }
}

/** 额度跨过阈值时通知（同周期同用户去重）。 */
export async function notifyQuotaOnce(
  userId: string,
  period: string,
  used: number,
  limit: number,
  threshold: number,
) {
  if (!limit || threshold <= 0) return;
  const pct = (used / limit) * 100;
  if (pct < threshold) return;
  const title = `额度告警 · ${period}`;
  const existing = await db
    .select()
    .from(notifications)
    .where(and(eq(notifications.userId, userId), eq(notifications.title, title)))
    .limit(1);
  if (existing.length) return;
  await createNotification(userId, title, `本月已使用额度 ${Math.round(pct)}%（${used} / ${limit} Token），请留意。`);
}
