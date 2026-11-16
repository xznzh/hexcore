import { NextRequest, NextResponse } from 'next/server';
import { ensureInit, db } from '@/lib/db';
import { artifacts } from '@/lib/schema';
import { eq } from 'drizzle-orm';
import { getSession } from '@/lib/auth';
import { canAccessProject } from '@/lib/projects';
import { resolveSafe } from '@/lib/storage';
import fs from 'fs/promises';
import { failResponse } from '@/lib/api/handler';

export const dynamic = 'force-dynamic';

// 下载产物（本人，或该产物所属项目我有权限）
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  await ensureInit();
  const s = await getSession();
  if (!s) return failResponse(_req, 401, 'UNAUTHORIZED', '未登录');

  const a = (await db.select().from(artifacts).where(eq(artifacts.id, id)).limit(1))[0];
  if (!a) return NextResponse.json({ error: '产物不存在' }, { status: 404 });

  const allowed = a.ownerId === s.userId || (a.projectId ? await canAccessProject(a.projectId, s.userId, s.role) : false);
  if (!allowed) return NextResponse.json({ error: '无权访问' }, { status: 403 });

  try {
    const buf = await fs.readFile(resolveSafe(a.path));
    return new NextResponse(buf as any, {
      headers: {
        'Content-Type':
          a.type === 'ppt'
            ? 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
            : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'Content-Disposition': `attachment; filename="${encodeURIComponent(a.filename)}"`,
      },
    });
  } catch {
    return NextResponse.json({ error: '文件不存在' }, { status: 404 });
  }
}
