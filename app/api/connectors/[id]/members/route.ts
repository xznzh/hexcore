import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { capabilityGrants, connectors, users } from '@/lib/schema';
import { and, eq, inArray } from 'drizzle-orm';
import { newId, logAction } from '@/lib/util';
import { withApi, apiError } from '@/lib/api/handler';

export const dynamic = 'force-dynamic';

/** 连接器成员授权（scope=connector）：存在授权记录时，仅授权用户/角色可用 */
export const GET = withApi(
  async ({ params }) => {
    const { id } = (await params) as { id: string };

    const rows = await db
      .select()
      .from(capabilityGrants)
      .where(and(eq(capabilityGrants.scope, 'connector'), eq(capabilityGrants.targetId, id)))
      .limit(500);
    const userIds = rows.filter((r) => r.subjectType === 'user').map((r) => r.subjectId);
    const userRows = userIds.length
      ? await db.select().from(users).where(inArray(users.id, userIds)).limit(500)
      : [];
    const nameMap = new Map(userRows.map((u) => [u.id, u.name || u.email]));

    return NextResponse.json(
      rows.map((r) => ({
        id: r.id,
        subjectType: r.subjectType,
        subjectId: r.subjectId,
        subjectLabel: r.subjectType === 'user' ? nameMap.get(r.subjectId) || r.subjectId : r.subjectId,
        createdAt: r.createdAt,
      })),
    );
  },
  { auth: 'admin' },
);

export const POST = withApi(
  async ({ req, session, params }) => {
    // 用 routeId 而非 id：本函数后面有 `const id = newId('grant')`（授权记录主键），
    // 直接解构为 id 会被遮蔽，导致 targetId 误指向授权记录自己而非连接器。
    const { id: routeId } = (await params) as { id: string };

    const conn = (await db.select().from(connectors).where(eq(connectors.id, routeId)).limit(1))[0];
    if (!conn) apiError(404, 'NOT_FOUND', '连接器不存在');

    const body = await req.json().catch(() => null);
    const subjectType = body?.subjectType === 'role' ? 'role' : 'user';
    const subjectId = String(body?.subjectId || '').trim();
    if (!subjectId) apiError(400, 'INVALID_ARGUMENT', '缺少 subjectId');
    if (subjectType === 'role' && !['admin', 'member', 'guest'].includes(subjectId)) {
      apiError(400, 'INVALID_ARGUMENT', '角色只能是 admin / member / guest');
    }

    const exists = (
      await db
        .select()
        .from(capabilityGrants)
        .where(
          and(
            eq(capabilityGrants.scope, 'connector'),
            eq(capabilityGrants.targetId, routeId),
            eq(capabilityGrants.subjectType, subjectType),
            eq(capabilityGrants.subjectId, subjectId),
          ),
        )
        .limit(1)
    )[0];
    if (exists) return NextResponse.json({ id: exists.id, ok: true });

    const id = newId('grant');
    await db.insert(capabilityGrants).values({
      id,
      scope: 'connector',
      targetId: routeId,
      subjectType,
      subjectId,
      createdAt: Date.now(),
    });
    await logAction(session.userId, 'connector_member_add', `${conn.name}:${subjectType}:${subjectId}`);
    return NextResponse.json({ id, ok: true });
  },
  { auth: 'admin' },
);

export const DELETE = withApi(
  async ({ req, session, params }) => {
    const { id } = (await params) as { id: string };

    const grantId = req.nextUrl.searchParams.get('grantId');
    if (!grantId) apiError(400, 'INVALID_ARGUMENT', '缺少 grantId');
    await db
      .delete(capabilityGrants)
      .where(
        and(
          eq(capabilityGrants.id, grantId),
          eq(capabilityGrants.scope, 'connector'),
          eq(capabilityGrants.targetId, id),
        ),
      );
    await logAction(session.userId, 'connector_member_remove', grantId);
    return NextResponse.json({ ok: true });
  },
  { auth: 'admin' },
);
