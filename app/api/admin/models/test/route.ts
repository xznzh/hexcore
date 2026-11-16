import { NextResponse } from 'next/server';
import { generateText } from 'ai';
import { db } from '@/lib/db';
import { models as M } from '@/lib/schema';
import { eq } from 'drizzle-orm';
import { resolveModel } from '@/lib/ai/providers';
import { embedWithModel } from '@/lib/ai/embed';
import { safeDecrypt } from '@/lib/crypto';
import { withApi } from '@/lib/api/handler';

export const dynamic = 'force-dynamic';

function hasCapability(capsJson: string | null, cap: string): boolean {
  try {
    return (JSON.parse(capsJson || '[]') as string[]).includes(cap);
  } catch {
    return false;
  }
}

/**
 * 一键连通性测试：解析该模型并发起一次极小的生成请求。
 *
 * 注意这里有两类「失败」：**测试结论失败**（下游不可达 / Key 无效）用 200 + `{ok:false}`
 * 返回，因为它是一次成功的探测、只是结论为负；**请求本身不合法**（缺 id / 模型不存在）
 * 才用 4xx。所以下方的 try/catch 不是错误处理，是探测结果的表达，迁移时原样保留。
 */
export const POST = withApi(
  async ({ req }) => {
    const body = await req.json().catch(() => ({}));
    const id = String(body?.id || '');
    if (!id) return NextResponse.json({ error: '缺少 id' }, { status: 400 });

    const row = (await db.select().from(M).where(eq(M.id, id)).limit(1))[0];
    if (!row) return NextResponse.json({ error: '模型不存在' }, { status: 404 });

    const t0 = Date.now();

    // 向量模型：走 embedding 接口测一次，返回维度（同时验证 EMBED_DIM 是否配对）
    if (hasCapability(row.capabilities, 'embedding')) {
      const apiKey = safeDecrypt(row.apiKey);
      if (!apiKey.trim()) return NextResponse.json({ ok: false, ms: 0, error: '未配置 API Key' });
      try {
        const [vec] = await embedWithModel(
          {
            id: row.id,
            provider: row.provider,
            name: row.name,
            baseUrl: row.baseUrl,
            apiKey,
            isDefault: !!row.isDefault,
            enabled: row.enabled !== false,
          },
          ['连通性测试'],
          'db',
        );
        const dim = vec?.length || 0;
        if (!dim) return NextResponse.json({ ok: false, ms: Date.now() - t0, error: '接口未返回向量' });
        return NextResponse.json({ ok: true, ms: Date.now() - t0, sample: `向量维度 ${dim}` });
      } catch (e: any) {
        return NextResponse.json({ ok: false, ms: Date.now() - t0, error: String(e?.message || e) });
      }
    }

    const resolved = await resolveModel(id);
    if (!resolved) return NextResponse.json({ error: '模型未启用或无法解析' }, { status: 400 });

    try {
      const r = await generateText({ model: resolved.instance, prompt: 'ping（请只回复 pong）', maxTokens: 10 });
      return NextResponse.json({ ok: true, ms: Date.now() - t0, sample: (r.text || '').slice(0, 80) });
    } catch (e: any) {
      return NextResponse.json({ ok: false, ms: Date.now() - t0, error: String(e?.message || e) });
    }
  },
  { auth: 'admin' },
);
