import { NextResponse } from 'next/server';
import { decideApproval } from '@/lib/capabilities';
import { withApi, apiError } from '@/lib/api/handler';

export const dynamic = 'force-dynamic';

/** 审批：body { operationId, approve }；仅管理员 */
export const POST = withApi(
  async ({ req, session }) => {
    const body = await req.json().catch(() => null);
    const operationId = String(body?.operationId || '').trim();
    if (!operationId) apiError(400, 'INVALID_ARGUMENT', '缺少 operationId');

    const r = await decideApproval(operationId, { userId: session.userId, role: session.role }, body?.approve !== false);
    if (!r) apiError(400, 'INVALID_STATE', '操作不存在或已处理');
    return NextResponse.json(r);
  },
  { auth: 'admin' },
);
