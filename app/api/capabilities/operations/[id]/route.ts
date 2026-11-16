import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { capabilityOperations, capabilities } from '@/lib/schema';
import { eq } from 'drizzle-orm';
import { cancelOperation } from '@/lib/capabilities';
import { withApi, apiError } from '@/lib/api/handler';

export const dynamic = 'force-dynamic';

/** 操作详情（含完整输出/错误，供轮询异步任务） */
export const GET = withApi(async ({ session, params }) => {
  const { id } = (await params) as { id: string };
  const s = session;

  const op = (
    await db.select().from(capabilityOperations).where(eq(capabilityOperations.id, id)).limit(1)
  )[0];
  if (!op) apiError(404, 'NOT_FOUND', '操作不存在');
  if (s.role !== 'admin' && op.userId !== s.userId) {
    apiError(403, 'FORBIDDEN', '无权查看该操作');
  }
  const cap = op.capabilityId
    ? (await db.select().from(capabilities).where(eq(capabilities.id, op.capabilityId)).limit(1))[0]
    : null;

  return NextResponse.json({
    id: op.id,
    capabilityId: op.capabilityId,
    capabilityName: cap?.name || null,
    status: op.status,
    mode: op.mode,
    input: op.input,
    output: op.output,
    error: op.error,
    source: op.source,
    durationMs: op.durationMs,
    approvedBy: op.approvedBy,
    approvedAt: op.approvedAt,
    createdAt: op.createdAt,
    startedAt: op.startedAt,
    finishedAt: op.finishedAt,
  });
});

/** 取消待审批 / 运行中的操作 */
export const DELETE = withApi(async ({ session, params }) => {
  const { id } = (await params) as { id: string };
  const ok = await cancelOperation(id, { userId: session.userId, role: session.role });
  if (!ok) apiError(400, 'INVALID_STATE', '操作不存在或当前状态不可取消');
  return NextResponse.json({ ok: true });
});
