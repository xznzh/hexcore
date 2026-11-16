import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { capabilities, connectors } from '@/lib/schema';
import { listCapabilitiesForUser } from '@/lib/capabilities';
import { withApi } from '@/lib/api/handler';

export const dynamic = 'force-dynamic';

/** 能力目录：普通用户只看到可用能力；管理员加 ?all=1 可看全部（含停用/撤销） */
export const GET = withApi(async ({ req, session }) => {
  const all = req.nextUrl.searchParams.get('all') === '1' && session.role === 'admin';
  if (!all) {
    const list = await listCapabilitiesForUser({ userId: session.userId, role: session.role });
    return NextResponse.json(list);
  }

  const caps = await db.select().from(capabilities).limit(2000);
  const conns = await db.select().from(connectors).limit(1000);
  const connMap = new Map<string, any>(conns.map((c: any) => [String(c.id), c] as [string, any]));
  return NextResponse.json(
    caps
      // 兜底历史残留：连接器已删除的能力不再展示（删除连接器现在会级联删除能力）
      .filter((c: any) => !c.connectorId || connMap.has(String(c.connectorId)))
      .map((c: any) => ({
        id: c.id,
        connectorId: c.connectorId,
        connectorName: c.connectorId ? connMap.get(String(c.connectorId))?.name || null : null,
        connectorStatus: c.connectorId ? connMap.get(String(c.connectorId))?.status || null : null,
        key: c.key,
        name: c.name,
        description: c.description,
        method: c.method,
        path: c.path,
        inputSchema: c.inputSchema,
        parameters: c.parameters,
        responseMapping: c.responseMapping,
        minRole: c.minRole,
        requiresApproval: c.requiresApproval,
        timeoutMs: c.timeoutMs,
        status: c.status,
        revision: connMap.get(String(c.connectorId || ''))?.revision || null,
        updatedAt: c.updatedAt,
      })),
  );
});
