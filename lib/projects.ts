import { db } from './db';
import { projects, projectMembers } from './schema';
import { eq, and } from 'drizzle-orm';

/** 当前用户可访问的项目 id 集合（owner / 团队 / 我是成员 / 管理员全量） */
export async function accessibleProjectIds(userId: string, role?: string): Promise<Set<string>> {
  const all = await db.select().from(projects);
  if (role === 'admin') return new Set(all.map((p) => p.id));
  const mine = await db.select().from(projectMembers).where(eq(projectMembers.userId, userId));
  const memberIds = new Set(mine.map((m) => m.projectId));
  return new Set(
    all
      .filter((p) => p.ownerId === userId || p.visibility === 'team' || (p.visibility === 'members' && memberIds.has(p.id)))
      .map((p) => p.id),
  );
}

export async function isProjectMember(projectId: string, userId: string): Promise<boolean> {
  const rows = await db
    .select()
    .from(projectMembers)
    .where(and(eq(projectMembers.projectId, projectId), eq(projectMembers.userId, userId)))
    .limit(1);
  return rows.length > 0;
}

/** 是否能访问某个项目 */
export async function canAccessProject(projectId: string, userId: string, role?: string): Promise<boolean> {
  const p = (await db.select().from(projects).where(eq(projects.id, projectId)).limit(1))[0];
  if (!p) return false;
  if (role === 'admin') return true;
  if (p.ownerId === userId || p.visibility === 'team') return true;
  if (p.visibility === 'members') return isProjectMember(projectId, userId);
  return false; // personal：仅 owner（admin 上面已放行）
}
