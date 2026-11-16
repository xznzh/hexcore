import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { skills, connectors } from '@/lib/schema';
import { listCapabilitiesForUser } from '@/lib/capabilities';
import { accessibleProjectIds } from '@/lib/projects';
import { inArray } from 'drizzle-orm';
import { withApi } from '@/lib/api/handler';

export const dynamic = 'force-dynamic';

/**
 * 对话框「/」联想的分类数据源：内置技能 / 自建技能 / 三方系统（按连接器分组）。
 * - 内置技能：scope='builtin'（随部署幂等注入，只读、可运行）
 * - 自建技能：个人 / 团队 / 可访问项目的技能
 * - 三方系统：连接器暴露的能力，按连接器分组
 */
export const GET = withApi(async ({ session }) => {
  const s = session;

  // —— 技能：内置 / 自建 ——
  const rows = await db.select().from(skills).orderBy(skills.createdAt);
  const projIds = await accessibleProjectIds(s.userId, s.role);
  const pick = (r: any) => ({ id: r.id, name: r.name, description: r.description, scope: r.scope });
  const builtinSkills = rows.filter((r: any) => r.scope === 'builtin').map(pick);
  const selfSkills = rows
    .filter(
      (r: any) =>
        r.scope !== 'builtin' &&
        (r.ownerId === s.userId || r.scope === 'team' || (r.projectId && projIds.has(r.projectId))),
    )
    .map(pick);

  // —— 三方系统：能力按连接器分组 ——
  const caps = await listCapabilitiesForUser({ userId: s.userId, role: s.role });
  const byConn = new Map<string, { id: string; name: string; description: string | null; method: string; path: string }[]>();
  for (const c of caps.filter((x) => x.connectorId)) {
    const arr = byConn.get(c.connectorId!) || [];
    arr.push({ id: c.id, name: c.name, description: c.description, method: c.method, path: c.path });
    byConn.set(c.connectorId!, arr);
  }
  const connRows = byConn.size
    ? await db
        .select({ id: connectors.id, name: connectors.name, type: connectors.type })
        .from(connectors)
        .where(inArray(connectors.id, [...byConn.keys()]))
    : [];
  const connMap = new Map(connRows.map((c) => [c.id, c]));
  const thirdParty = [...byConn.entries()].map(([cid, cs]) => ({
    connector: connMap.get(cid) || { id: cid, name: '未知连接器', type: 'unknown' },
    caps: cs,
  }));

  return NextResponse.json({ builtinSkills, selfSkills, thirdParty });
});
