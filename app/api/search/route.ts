import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import {
  conversations,
  files as F,
  documents,
  knowledgeBases,
  memories,
  skills,
  messages,
} from '@/lib/schema';
import { and, desc, eq, ilike, or } from 'drizzle-orm';
import { withApi } from '@/lib/api/handler';

export const dynamic = 'force-dynamic';

/**
 * 聚合搜索（命令面板 Cmd+K）：
 * 一次请求跨 会话标题 / 消息内容 / 文件 / 知识库文档 / 记忆 / 技能。
 * 每个来源 limit 5，按 updatedAt/createdAt 倒序；词法为主，来源广泛即可。
 */
export const GET = withApi(async ({ req, session }) => {
  const s = session;
  const q = (req.nextUrl.searchParams.get('q') || '').trim();
  if (!q) return NextResponse.json({ q: '', results: [] });
  const like = `%${q}%`;

  // 知识库可见范围：团队库 + 我的个人库
  const kbs = await db.select().from(knowledgeBases);
  const kbIds = kbs.filter((k) => k.scope === 'team' || k.ownerId === s.userId).map((k) => k.id);

  const [convs, msgHits, fileHits, docHits, memHits, skillHits] = await Promise.all([
    db
      .select({ id: conversations.id, title: conversations.title, createdAt: conversations.createdAt })
      .from(conversations)
      .where(and(eq(conversations.userId, s.userId), ilike(conversations.title, like)))
      .orderBy(desc(conversations.createdAt))
      .limit(5),
    db
      .select({ id: messages.id, convId: messages.conversationId, content: messages.content, role: messages.role, createdAt: messages.createdAt })
      .from(messages)
      .innerJoin(conversations, eq(messages.conversationId, conversations.id))
      .where(and(eq(conversations.userId, s.userId), ilike(messages.content, like)))
      .orderBy(desc(messages.createdAt))
      .limit(5),
    db
      .select({ id: F.id, filename: F.filename, mime: F.mime })
      .from(F)
      .where(and(or(eq(F.ownerId, s.userId), eq(F.scope, 'team')), ilike(F.filename, like)))
      .orderBy(desc(F.createdAt))
      .limit(5),
    kbIds.length
      ? db
          .select({ id: documents.id, kbId: documents.kbId, filename: documents.filename })
          .from(documents)
          .where(and(or(eq(documents.kbId, kbIds[0]), ...kbIds.slice(1).map((id) => eq(documents.kbId, id))), ilike(documents.filename, like)))
          .orderBy(desc(documents.createdAt))
          .limit(5)
      : Promise.resolve([]),
    db
      .select({ id: memories.id, content: memories.content, scope: memories.scope })
      .from(memories)
      .where(and(or(eq(memories.userId, s.userId), eq(memories.scope, 'team')), ilike(memories.content, like)))
      .orderBy(desc(memories.createdAt))
      .limit(5),
    db
      .select({ id: skills.id, name: skills.name, scope: skills.scope })
      .from(skills)
      .where(and(or(eq(skills.ownerId, s.userId), eq(skills.scope, 'team')), ilike(skills.name, like)))
      .orderBy(desc(skills.createdAt))
      .limit(5),
  ]);

  const results: { type: string; id: string; title: string; subtitle: string; url: string }[] = [];
  for (const c of convs) results.push({ type: '会话', id: c.id, title: c.title, subtitle: '会话', url: `/chat?conv=${c.id}` });
  for (const m of msgHits as any[])
    results.push({
      type: '消息',
      id: m.id,
      title: (m.content || '').replace(/\s+/g, ' ').slice(0, 60),
      subtitle: '会话内消息',
      url: `/chat?conv=${m.convId}`,
    });
  for (const f of fileHits) results.push({ type: '文件', id: f.id, title: f.filename, subtitle: f.mime || '文件', url: `/files` });
  for (const d of docHits as any[])
    results.push({ type: '知识', id: d.id, title: d.filename, subtitle: '知识库文档', url: `/knowledge?kb=&doc=${d.kbId}` });
  for (const m of memHits) results.push({ type: '记忆', id: m.id, title: m.content.slice(0, 60), subtitle: m.scope === 'team' ? '团队记忆' : '个人记忆', url: `/memory` });
  for (const k of skillHits) results.push({ type: '技能', id: k.id, title: k.name, subtitle: '技能编排', url: `/skills` });

  return NextResponse.json({ q, results: results.slice(0, 20) });
});
