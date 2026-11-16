import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { capabilities } from '@/lib/schema';
import { eq } from 'drizzle-orm';
import { logAction } from '@/lib/util';
import { withApi, apiError } from '@/lib/api/handler';

export const dynamic = 'force-dynamic';

/** 能力配置：审批 / 最低角色 / 超时 / 响应映射 / 启停（管理员） */
export const PATCH = withApi(
  async ({ req, session, params }) => {
    const { id } = (await params) as { id: string };

    const cap = (await db.select().from(capabilities).where(eq(capabilities.id, id)).limit(1))[0];
    if (!cap) apiError(404, 'NOT_FOUND', '能力不存在');

    const body = await req.json().catch(() => null);
    if (!body) apiError(400, 'INVALID_ARGUMENT', '参数错误');

    const patch: any = { updatedAt: Date.now() };
    if (typeof body.name === 'string' && body.name.trim()) patch.name = body.name.trim().slice(0, 120);
    if (typeof body.description === 'string') patch.description = body.description.slice(0, 1000);
    if (['admin', 'member', 'guest'].includes(body.minRole)) patch.minRole = body.minRole;
    if (typeof body.requiresApproval === 'boolean') patch.requiresApproval = body.requiresApproval;
    if (body.timeoutMs != null) patch.timeoutMs = Math.min(120000, Math.max(1000, Number(body.timeoutMs) || 30000));
    if (['active', 'disabled'].includes(body.status)) patch.status = body.status;
    if (body.responseMapping && typeof body.responseMapping === 'object') {
      patch.responseMapping = JSON.stringify(body.responseMapping);
    }

    await db.update(capabilities).set(patch).where(eq(capabilities.id, id));
    await logAction(session.userId, 'capability_update', cap.name, { detail: JSON.stringify(body).slice(0, 1000) });
    return NextResponse.json({ ok: true });
  },
  { auth: 'admin' },
);

/** 删除能力（软删：置 revoked，保留历史调用记录） */
export const DELETE = withApi(
  async ({ session, params }) => {
    const { id } = (await params) as { id: string };

    const cap = (await db.select().from(capabilities).where(eq(capabilities.id, id)).limit(1))[0];
    if (!cap) apiError(404, 'NOT_FOUND', '能力不存在');
    await db.update(capabilities).set({ status: 'revoked', updatedAt: Date.now() }).where(eq(capabilities.id, id));
    await logAction(session.userId, 'capability_revoke', cap.name);
    return NextResponse.json({ ok: true });
  },
  { auth: 'admin' },
);
