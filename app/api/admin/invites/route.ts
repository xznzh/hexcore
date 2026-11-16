import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { invites, users } from '@/lib/schema';
import { eq, desc } from 'drizzle-orm';
import { newId, logAction } from '@/lib/util';
import { randomBytes } from 'crypto';
import { withApi } from '@/lib/api/handler';

export const dynamic = 'force-dynamic';

function genCode() {
  return randomBytes(6).toString('hex').toUpperCase();
}

export const GET = withApi(
  async () => {
    const rows = await db.select().from(invites).orderBy(desc(invites.createdAt));
    const userMap = new Map((await db.select().from(users)).map((u) => [u.id, u.email]));
    return NextResponse.json(
      rows.map((r) => ({
        id: r.id,
        code: r.code,
        role: r.role,
        used: r.used,
        usedBy: r.usedBy ? userMap.get(r.usedBy) || r.usedBy : null,
        createdAt: r.createdAt,
      })),
    );
  },
  { auth: 'admin' },
);

export const POST = withApi(
  async ({ req, session }) => {
    const body = await req.json().catch(() => ({}));
    const role = ['admin', 'member', 'guest'].includes(body?.role) ? body.role : 'member';
    const id = newId('inv');
    const code = genCode();
    await db.insert(invites).values({ id, code, role, used: false, createdAt: Date.now() });
    await logAction(session.userId, 'admin_create_invite', code);
    return NextResponse.json({ id, code, role });
  },
  { auth: 'admin' },
);

export const DELETE = withApi(
  async ({ req }) => {
    const id = req.nextUrl.searchParams.get('id');
    if (!id) return NextResponse.json({ error: '缺少 id' }, { status: 400 });
    await db.delete(invites).where(eq(invites.id, id));
    return NextResponse.json({ ok: true });
  },
  { auth: 'admin' },
);
