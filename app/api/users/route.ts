import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { users } from '@/lib/schema';
import { withApi } from '@/lib/api/handler';

export const dynamic = 'force-dynamic';

// 团队成员目录（用于选择项目成员等），仅返回必要字段
export const GET = withApi(async () => {
  const rows = await db.select().from(users);
  return NextResponse.json(
    rows.filter((u) => u.status === 'active').map((u) => ({ id: u.id, name: u.name, email: u.email, role: u.role })),
  );
});
