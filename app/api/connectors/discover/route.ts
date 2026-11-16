import { NextResponse } from 'next/server';
import { loadSpec } from '@/lib/connectors/service';
import { withApi, apiError } from '@/lib/api/handler';

export const dynamic = 'force-dynamic';

/**
 * 发现能力：拉取 OpenAPI 文档并解析成候选工具。
 * 只读，不写库；管理员确认后再通过 /api/connectors/confirm 安装。
 */
export const POST = withApi(
  async ({ req }) => {
    const body = await req.json().catch(() => null);
    if (!body) apiError(400, 'INVALID_ARGUMENT', '参数错误');

    try {
      const { parsed, specUrl, baseUrl } = await loadSpec({
        specUrl: body.specUrl,
        spec: body.spec,
        headers: body.headers,
        baseUrl: body.baseUrl,
      });
      return NextResponse.json({
        title: parsed.title,
        version: parsed.version,
        baseUrl,
        specUrl,
        total: parsed.candidates.length,
        candidates: parsed.candidates,
        auth: parsed.auth,
      });
    } catch (e: any) {
      // 解析/拉取的失败原因（文档地址不通、格式不认识）是给管理员看的
      // 排障信息，必须原样带出；包成 400 而不是让它冒泡成 500。
      apiError(400, 'BAD_REQUEST', String(e?.message || e).slice(0, 500));
    }
  },
  { auth: 'admin' },
);
