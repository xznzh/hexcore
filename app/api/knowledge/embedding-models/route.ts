import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { models } from '@/lib/schema';
import { hasCapability } from '@/lib/ai/embed';
import { safeDecrypt } from '@/lib/crypto';
import { withApi } from '@/lib/api/handler';

export const dynamic = 'force-dynamic';

/**
 * 知识库可选的向量模型列表。
 * 不复用 /api/models：那里按 visibleRoles 过滤，会漏掉仅管理员可见的预置 embedding 模型；
 * 这里只暴露 id/名称/供应商与是否已配 Key，不含任何密钥。
 */
export const GET = withApi(async () => {
  const rows = await db.select().from(models);
  const list = rows
    .filter((m) => hasCapability(m.capabilities, 'embedding'))
    .map((m) => ({
      id: m.id,
      name: m.name,
      provider: m.provider,
      enabled: m.enabled !== false,
      hasKey: safeDecrypt(m.apiKey).trim().length > 0,
    }))
    // 可用的排前面，方便用户直接选
    .sort((a, b) => Number(b.enabled && b.hasKey) - Number(a.enabled && a.hasKey));

  return NextResponse.json(list);
});
