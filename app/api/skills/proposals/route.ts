import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { skillProposals } from '@/lib/schema';
import { eq, desc } from 'drizzle-orm';
import { withApi, apiError } from '@/lib/api/handler';

export const dynamic = 'force-dynamic';

/** 待确认的安装提议列表：管理员看全部；普通用户看自己发起的 */
export const GET = withApi(async ({ session }) => {
  const s = session;
  if (s.role === 'guest') apiError(403, 'FORBIDDEN', '访客无权查看');

  const rows = s.role === 'admin'
    ? await db.select().from(skillProposals).orderBy(desc(skillProposals.createdAt)).limit(50)
    : await db.select().from(skillProposals).where(eq(skillProposals.requestedBy, s.userId)).orderBy(desc(skillProposals.createdAt)).limit(50);

  return NextResponse.json(
    rows.map((p) => ({
      id: p.id,
      ref: p.ref,
      source: p.source,
      sourceLabel: p.sourceLabel,
      name: p.name,
      description: p.description,
      version: p.version,
      author: p.author,
      security: JSON.parse(p.security || '[]'),
      files: JSON.parse(p.files || '[]'),
      scriptFiles: JSON.parse(p.scriptFiles || '[]'),
      bodyPreview: p.bodyPreview,
      status: p.status,
      requestedBy: p.requestedBy,
      skillId: p.skillId,
      createdAt: p.createdAt,
      confirmedAt: p.confirmedAt,
    })),
  );
});
