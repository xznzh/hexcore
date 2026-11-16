import { NextResponse } from 'next/server';
import { runRagEval } from '@/lib/observability';
import { withApi } from '@/lib/api/handler';

export const dynamic = 'force-dynamic';

/**
 * RAG 效果自检（recall@k）。内置若干示例用例，用于验证检索质量。
 * 真实使用时应替换为业务数据集。仅管理员可访问。
 */
export const GET = withApi(
  async () => {
    const demoCases = [
      { query: '项目背景是什么', expect: '项目' },
      { query: '知识库里有什么', expect: '文档' },
    ];
    const res = await runRagEval(demoCases, 4);
    return NextResponse.json({
      ...res,
      note: '示例用例，请替换为真实业务评估集以获得有意义的 recall@k。',
    });
  },
  { auth: 'admin' },
);
