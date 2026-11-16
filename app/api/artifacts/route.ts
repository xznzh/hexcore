import { NextRequest, NextResponse } from 'next/server';
import { ensureInit, db } from '@/lib/db';
import { artifacts, users } from '@/lib/schema';
import { and, desc, eq, inArray, or } from 'drizzle-orm';
import { getSession } from '@/lib/auth';
import { accessibleProjectIds } from '@/lib/projects';
import { failResponse } from '@/lib/api/handler';

export const dynamic = 'force-dynamic';

// 列出我可访问的产物（自己的 + 我可访问项目内的）。可按 type / projectId / conversationId 过滤。
export async function GET(req: NextRequest) {
  await ensureInit();
  const s = await getSession();
  if (!s) return failResponse(req, 401, 'UNAUTHORIZED', '未登录');

  const type = req.nextUrl.searchParams.get('type');
  const projectId = req.nextUrl.searchParams.get('projectId');
  const conversationId = req.nextUrl.searchParams.get('conversationId');

  // 可见性 + 全部过滤条件下推到 SQL：
  // 原实现是「把整张 artifacts 拉进内存、再拉整张 users 建 nameMap、再在 JS 里逐条 filter」，
  // 产物越多越慢，而且为了拿一个 ownerName 白读全表用户。
  const projIds = Array.from(await accessibleProjectIds(s.userId, s.role));
  const visibleCond = projIds.length
    ? or(eq(artifacts.ownerId, s.userId), inArray(artifacts.projectId, projIds))
    : eq(artifacts.ownerId, s.userId);
  const where = and(
    visibleCond,
    type ? eq(artifacts.type, type) : undefined,
    projectId ? eq(artifacts.projectId, projectId) : undefined,
    conversationId ? eq(artifacts.conversationId, conversationId) : undefined,
  );

  const rows = await db
    .select({
      id: artifacts.id,
      ownerId: artifacts.ownerId,
      projectId: artifacts.projectId,
      conversationId: artifacts.conversationId,
      type: artifacts.type,
      title: artifacts.title,
      filename: artifacts.filename,
      size: artifacts.size,
      createdAt: artifacts.createdAt,
      ownerName: users.name,
    })
    .from(artifacts)
    .leftJoin(users, eq(artifacts.ownerId, users.id))
    .where(where)
    .orderBy(desc(artifacts.createdAt))
    .limit(500); // 列表护栏：正常量级远小于此，避免异常数据把响应撑爆

  return NextResponse.json(
    rows.map((a) => ({
      id: a.id,
      type: a.type,
      title: a.title,
      filename: a.filename,
      size: a.size,
      projectId: a.projectId || null,
      conversationId: a.conversationId || null,
      ownerName: a.ownerName || '成员',
      isOwner: a.ownerId === s.userId,
      createdAt: a.createdAt,
    })),
  );
}
