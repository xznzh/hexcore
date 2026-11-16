import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { skills, skillVersions } from '@/lib/schema';
import { eq, desc } from 'drizzle-orm';
import { withApi, apiError } from '@/lib/api/handler';

export const dynamic = 'force-dynamic';

/**
 * 技能的历史版本快照列表（供前端「历史版本」抽屉展示）。
 *
 * 权限只放开给 owner：快照里是完整的节点 prompt，属于技能作者的个人资产，
 * 团队可见性只应体现在「当前生效的版本」上，而不是历史草稿。
 *
 * 同一 version 号理论上只快照一次（PATCH 与 rollback 都会先把「当前版本」落库再自增），
 * 但历史数据或并发写入可能留下重复行，这里按 version 去重并保留最新一条，
 * 避免前端出现两个 v3 让用户不知道该回滚哪个。
 */
export const GET = withApi(async ({ session, params }) => {
  const { id } = (await params) as { id: string };
  const s = session;

  const own = (await db.select().from(skills).where(eq(skills.id, id)).limit(1))[0];
  if (!own) apiError(404, 'NOT_FOUND', '技能不存在');
  if (own.ownerId !== s.userId) apiError(403, 'FORBIDDEN', '无权查看该技能的历史版本');

  const rows = await db
    .select()
    .from(skillVersions)
    .where(eq(skillVersions.skillId, id))
    .orderBy(desc(skillVersions.version), desc(skillVersions.createdAt))
    .limit(50);

  const seen = new Set<number>();
  const versions = rows
    .filter((r) => {
      if (seen.has(r.version)) return false;
      seen.add(r.version);
      return true;
    })
    .map((r) => {
      let steps: unknown = [];
      try {
        steps = JSON.parse(r.steps || '[]');
      } catch {
        // 单条快照损坏不应该让整个列表 500：原样返回空数组，前端会显示「无法解析」
        steps = [];
      }
      return { version: r.version, steps, createdAt: r.createdAt, createdBy: r.createdBy };
    });

  return NextResponse.json({ currentVersion: own.version || 1, versions });
});
