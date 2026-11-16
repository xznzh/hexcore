import { db } from './db';
import { knowledgeBases } from './schema';
import { accessibleProjectIds } from './projects';
import { eq } from 'drizzle-orm';

/**
 * 知识库可见性判定（唯一口径）。
 *
 * 背景：知识库有 `scope='personal' | 'team'` 与 `projectId`。
 * 列表接口 `/api/knowledge` 一直按「团队库 / 属主 / 管理员 / 可访问项目」过滤，
 * 但文档列表、文档上传、检索查询三个入口漏了这套校验 —— 只要拿到 kbId 就能
 * 读别人的个人库文档、往别人的库里传文件、甚至用 RAG 检索把别人的私有内容捞出来
 * （OWASP A01 Broken Access Control）。这里把口径抽出来，所有入口统一调用。
 */
export type KbLike = { scope: string; ownerId?: string | null; projectId?: string | null };

/** 纯函数：给定知识库行与用户上下文，判断是否可见 */
export function kbVisible(kb: KbLike, userId: string, role: string, projIds: Set<string>): boolean {
  if (!kb) return false;
  return (
    kb.scope === 'team' ||
    kb.ownerId === userId ||
    role === 'admin' ||
    (!!kb.projectId && projIds.has(kb.projectId))
  );
}

/** 当前用户可见的全部知识库 id（检索时用来限定范围，避免空数组退化成「全库检索」） */
export async function visibleKbIds(userId: string, role: string): Promise<string[]> {
  const all = await db.select().from(knowledgeBases);
  const projIds = await accessibleProjectIds(userId, role);
  return all.filter((k) => kbVisible(k, userId, role, projIds)).map((k) => k.id);
}

/** 单库校验：不存在或不可见均返回 false（调用方统一按 404/403 处理，避免暴露库是否存在） */
export async function canAccessKb(kbId: string, userId: string, role: string): Promise<boolean> {
  const kb = (await db.select().from(knowledgeBases).where(eq(knowledgeBases.id, kbId)).limit(1))[0];
  if (!kb) return false;
  const projIds = await accessibleProjectIds(userId, role);
  return kbVisible(kb, userId, role, projIds);
}
