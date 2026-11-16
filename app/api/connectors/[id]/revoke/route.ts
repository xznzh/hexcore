import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { connectors, capabilities } from '@/lib/schema';
import { eq } from 'drizzle-orm';
import { logAction } from '@/lib/util';
import { resetCircuit } from '@/lib/resilience';
import { withApi, apiError } from '@/lib/api/handler';

export const dynamic = 'force-dynamic';

/**
 * 撤销连接器：停用连接器与全部能力（保留数据与历史调用记录）。
 */
export const POST = withApi(
  async ({ session, params }) => {
    if (session.role === 'guest') apiError(403, 'FORBIDDEN', '访客为只读角色，无法吊销凭据');
    const { id } = (await params) as { id: string };

    const conn = (await db.select().from(connectors).where(eq(connectors.id, id)).limit(1))[0];
    if (!conn) apiError(404, 'NOT_FOUND', '连接器不存在');

    await db.update(connectors).set({ status: 'revoked', enabled: false }).where(eq(connectors.id, id));
    await db.update(capabilities).set({ status: 'revoked', updatedAt: Date.now() }).where(eq(capabilities.connectorId, id));
    resetCircuit(`connector:${id}`);
    await logAction(session.userId, 'connector_revoke', conn.name);
    return NextResponse.json({ ok: true });
  },
  { auth: 'admin' },
);
