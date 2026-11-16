import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { capabilityGrants, capabilities, users } from '@/lib/schema';
import { and, eq, inArray } from 'drizzle-orm';
import { newId, logAction } from '@/lib/util';
import { withApi, apiError } from '@/lib/api/handler';

export const dynamic = 'force-dynamic';

/** 能力级授权：存在授权记录时，仅授权用户/角色可调用该能力 */
export const GET = withApi(
  async ({ req }) => {
    const capabilityId = req.nextUrl.searchParams.get('capabilityId') || '';
    if (!capabilityId) apiError(400, 'INVALID_ARGUMENT', '缺少 capabilityId');

    const rows = await db
      .select()
      .from(capabilityGrants)
      .where(and(eq(capabilityGrants.scope, 'capability'), eq(capabilityGrants.targetId, capabilityId)))
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
  async ({ req, session }) => {
    const body = await req.json().catch(() => null);
    const capabilityId = String(body?.capabilityId || '').trim();
    const subjectType = body?.subjectType === 'role' ? 'role' : 'user';
    const subjectId = String(body?.subjectId || '').trim();
    if (!capabilityId || !subjectId) apiError(400, 'INVALID_ARGUMENT', '缺少 capabilityId / subjectId');
    if (subjectType === 'role' && !['admin', 'member', 'guest'].includes(subjectId)) {
      apiError(400, 'INVALID_ARGUMENT', '角色只能是 admin / member / guest');
    }

    const cap = (await db.select().from(capabilities).where(eq(capabilities.id, capabilityId)).limit(1))[0];
    if (!cap) apiError(404, 'NOT_FOUND', '能力不存在');

    const exists = (
      await db
        .select()
        .from(capabilityGrants)
        .where(
          and(
            eq(capabilityGrants.scope, 'capability'),
            eq(capabilityGrants.targetId, capabilityId),
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
      scope: 'capability',
      targetId: capabilityId,
      subjectType,
      subjectId,
      createdAt: Date.now(),
    });
    await logAction(session.userId, 'capability_grant_add', `${cap.name}:${subjectType}:${subjectId}`);
    return NextResponse.json({ id, ok: true });
  },
  { auth: 'admin' },
);

export const DELETE = withApi(
  async ({ req, session }) => {
    const grantId = req.nextUrl.searchParams.get('grantId');
    if (!grantId) apiError(400, 'INVALID_ARGUMENT', '缺少 grantId');
    await db
      .delete(capabilityGrants)
      .where(and(eq(capabilityGrants.id, grantId), eq(capabilityGrants.scope, 'capability')));
    await logAction(session.userId, 'capability_grant_remove', grantId);
    return NextResponse.json({ ok: true });
  },
  { auth: 'admin' },
);
