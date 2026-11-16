import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { conversations, messages, users, projects, projectMembers } from '@/lib/schema';
import { eq, and, desc, lt, gte, inArray } from 'drizzle-orm';
import { feedback } from '@/lib/schema';
import { withApi } from '@/lib/api/handler';

export const dynamic = 'force-dynamic';

// 获取某会话的消息历史（本人可读写；项目成员对项目内他人会话只读可见）
// 分页：支持 ?limit=50&before=<createdAt> —— 只回最近 limit 条（按 createdAt 倒序截取后反转为正序），
// before 游标用于向上滚动加载更早的消息。不传 limit 保持全量返回，兼容旧调用方。
export const GET = withApi(async ({ req, session, params }) => {
  const { id } = (await params) as { id: string };
  const t0 = Date.now();
  const s = session;

  const conv = (await db.select().from(conversations).where(eq(conversations.id, id)).limit(1))[0];
  if (!conv) return NextResponse.json({ error: '会话不存在' }, { status: 404 });

  const isOwner = conv.userId === s.userId;
  let ownerName: string | null = null;
  if (!isOwner) {
    // 非本人：仅当该会话绑定到「我可访问的项目」时允许只读查看
    let allowed = s.role === 'admin';
    if (!allowed && conv.projectId) {
      const p = (await db.select().from(projects).where(eq(projects.id, conv.projectId)).limit(1))[0];
      if (p) {
        if (p.ownerId === s.userId || p.visibility === 'team') allowed = true;
        else if (p.visibility === 'members') {
          const m = (
            await db
              .select()
              .from(projectMembers)
              .where(and(eq(projectMembers.projectId, p.id), eq(projectMembers.userId, s.userId)))
              .limit(1)
          )[0];
          allowed = !!m;
        }
      }
    }
    if (!allowed) return NextResponse.json({ error: '无权访问' }, { status: 403 });
    const ow = (await db.select().from(users).where(eq(users.id, conv.userId)).limit(1))[0];
    ownerName = ow?.name || '成员';
  }

  const sp = req.nextUrl.searchParams;
  const limitRaw = Number(sp.get('limit') || '');
  const beforeRaw = Number(sp.get('before') || '');
  const limit: number = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 200) : 0;
  const before: number = Number.isFinite(beforeRaw) && beforeRaw > 0 ? beforeRaw : 0;

  let rows: any[];
  let hasMore = false;
  if (limit > 0) {
    // 倒序取最近 limit 条（可带游标），反转为正序输出；返回满页视为还有更早历史
    const where = before > 0 ? and(eq(messages.conversationId, id), lt(messages.createdAt, before)) : eq(messages.conversationId, id);
    const descRows = await db.select().from(messages).where(where).orderBy(desc(messages.createdAt)).limit(limit);
    hasMore = descRows.length === limit;
    rows = [...descRows].reverse();
  } else {
    rows = await db
      .select()
      .from(messages)
      .where(eq(messages.conversationId, id))
      .orderBy(messages.createdAt);
  }

  // 我的反馈状态批量回显：一次 in 查询，修复点赞/点踩状态刷新即丢
  const dbMs = Date.now() - t0;
  const msgIds = rows.map((m: any) => m.id);
  const fbRows = msgIds.length
    ? await db
        .select({ messageId: feedback.messageId, rating: feedback.rating })
        .from(feedback)
        .where(and(eq(feedback.userId, s.userId), inArray(feedback.messageId, msgIds)))
    : [];
  const fbMap = new Map(fbRows.map((f) => [f.messageId, f.rating]));

  const res = NextResponse.json({
    isOwner,
    ownerName,
    hasMore,
    messages: rows.map((m: any) => ({
      id: m.id,
      role: m.role,
      content: m.content,
      sources: m.sources ? JSON.parse(m.sources) : [],
      trace: m.trace ? JSON.parse(m.trace) : [],
      // meta 含本轮技能/能力调用等过程元数据，仅属主可见（项目成员只读查看不留过程细节）
      meta: isOwner && m.meta ? JSON.parse(m.meta) : null,
      feedback: fbMap.get(m.id) || null,
      createdAt: m.createdAt,
    })),
  });
  // 慢接口排查：Server-Timing 可在浏览器 Network 面板直接看到各段耗时
  res.headers.set('Server-Timing', `db;dur=${dbMs}, total;dur=${Date.now() - t0}`);
  return res;
});

// 编辑重发：删除某条用户消息及其后的全部消息（仅属主）。
// 前端「编辑」按钮会把该消息内容回填输入框，发送前调用本接口截断旧消息，再走正常发送/重新生成。
export const DELETE = withApi(async ({ req, session, params }) => {
  const { id } = (await params) as { id: string };
  const s = session;
  if (s.role === 'guest') return NextResponse.json({ error: '访客无写入权限' }, { status: 403 });
  const conv = (await db.select().from(conversations).where(eq(conversations.id, id)).limit(1))[0];
  if (!conv) return NextResponse.json({ error: '会话不存在' }, { status: 404 });
  if (conv.userId !== s.userId) return NextResponse.json({ error: '无权操作' }, { status: 403 });
  const fromId = req.nextUrl.searchParams.get('from');
  if (!fromId) return NextResponse.json({ error: '缺少 from 参数' }, { status: 400 });
  const from = (await db.select().from(messages).where(eq(messages.id, fromId)).limit(1))[0];
  if (!from || from.conversationId !== id) {
    return NextResponse.json({ error: '消息不存在' }, { status: 404 });
  }
  await db.delete(messages).where(and(eq(messages.conversationId, id), gte(messages.createdAt, from.createdAt)));
  return NextResponse.json({ ok: true });
});
