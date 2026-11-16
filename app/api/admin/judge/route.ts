import { NextResponse } from 'next/server';
import { runJudge } from '@/lib/observability';
import { withApi } from '@/lib/api/handler';

export const dynamic = 'force-dynamic';

// LLM-as-judge：对「输入/回答」按标准打分
export const POST = withApi(
  async ({ req }) => {
    const body = await req.json().catch(() => ({}));
    const input = String(body?.input || '').trim();
    const output = String(body?.output || '').trim();
    const criteria = body?.criteria ? String(body.criteria) : undefined;
    if (!input || !output) return NextResponse.json({ error: '请提供输入与回答' }, { status: 400 });

    try {
      const r = await runJudge(input, output, criteria);
      return NextResponse.json(r);
    } catch (e: any) {
      // 刻意保留原文：这是管理员用来调提示词的诊断工具，
      // 返回「服务器内部错误」等于把唯一的排障线索抹掉。仅限 admin 入口，泄露面可控。
      return NextResponse.json({ error: e?.message || '评估失败' }, { status: 500 });
    }
  },
  { auth: 'admin' },
);
