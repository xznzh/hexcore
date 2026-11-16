import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { capabilityOperations, capabilities, users } from '@/lib/schema';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { withApi } from '@/lib/api/handler';

export const dynamic = 'force-dynamic';

/** LIKE 通配符转义，避免用户输入 % / _ 把查询放大 */
function likePattern(q: string): string {
  return `%${q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
}

/**
 * 操作列表：普通用户只看自己的；管理员可看全部（审批收件箱用 status=pending_approval）。
 * 支持 status / capabilityId / q（能力名、调用者、操作编号模糊搜索）与 offset 分页，返回 { items, total }。
 */
export const GET = withApi(async ({ req, session }) => {
  const s = session;
  const sp = req.nextUrl.searchParams;
  const status = sp.get('status') || '';
  const capabilityId = sp.get('capabilityId') || '';
  const q = (sp.get('q') || '').trim();
  const mineParam = sp.get('mine');
  const mine = mineParam === null ? s.role !== 'admin' : mineParam === '1';
  const limit = Math.min(200, Math.max(1, Number(sp.get('limit') || 50)));
  const offset = Math.max(0, Number(sp.get('offset') || 0) || 0);

  const conds = [];
  if (mine) conds.push(eq(capabilityOperations.userId, s.userId));
  if (status) conds.push(eq(capabilityOperations.status, status));
  if (capabilityId) conds.push(eq(capabilityOperations.capabilityId, capabilityId));
  if (q) {
    const like = likePattern(q);
    conds.push(sql`(
      ${capabilityOperations.id} ILIKE ${like}
      OR EXISTS (SELECT 1 FROM capabilities c WHERE c.id = ${capabilityOperations.capabilityId} AND c.name ILIKE ${like})
      OR EXISTS (SELECT 1 FROM users u WHERE u.id = ${capabilityOperations.userId} AND (u.name ILIKE ${like} OR u.email ILIKE ${like}))
    )`);
  }
  const where = conds.length ? and(...conds) : undefined;

  const base = db.select().from(capabilityOperations);
  const rows = await (where ? base.where(where) : base)
    .orderBy(desc(capabilityOperations.createdAt))
    .limit(limit)
    .offset(offset);

  const countRows = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(capabilityOperations)
    .where(where);
  const total = Number(countRows[0]?.count) || 0;

  const capIds = [...new Set<string>(rows.map((r: any) => String(r.capabilityId)).filter(Boolean))];
  const caps = capIds.length
    ? await db.select().from(capabilities).where(inArray(capabilities.id, capIds)).limit(1000)
    : [];
  const capMap = new Map<string, any>(caps.map((c: any) => [String(c.id), c] as [string, any]));

  const userIds = [...new Set<string>(rows.map((r: any) => String(r.userId)).filter(Boolean))];
  const userRows = userIds.length
    ? await db.select().from(users).where(inArray(users.id, userIds)).limit(1000)
    : [];
  const userMap = new Map<string, string>(
    userRows.map((u: any) => [String(u.id), String(u.name || u.email)] as [string, string]),
  );

  return NextResponse.json({
    total,
    items: rows.map((r: any) => ({
      id: r.id,
      capabilityId: r.capabilityId,
      capabilityName: r.capabilityId ? capMap.get(String(r.capabilityId))?.name || r.capabilityId : null,
      userId: r.userId,
      userName: userMap.get(String(r.userId)) || null,
      status: r.status,
      mode: r.mode,
      input: r.input,
      output: r.output ? r.output.slice(0, 2000) : null,
      error: r.error,
      source: r.source,
      conversationId: r.conversationId,
      approvedBy: r.approvedBy,
      approvedAt: r.approvedAt,
      durationMs: r.durationMs,
      createdAt: r.createdAt,
      finishedAt: r.finishedAt,
    })),
  });
});
