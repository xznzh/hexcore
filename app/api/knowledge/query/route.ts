import { NextResponse } from 'next/server';
import { retrieve, clampTopK } from '@/lib/ai/rag';
import { visibleKbIds } from '@/lib/kb-access';
import { withApi, apiError } from '@/lib/api/handler';

export const dynamic = 'force-dynamic';

export const POST = withApi(async ({ req, session }) => {
  const s = session;
  const body = await req.json().catch(() => null);
  const query: string = body?.query?.trim();
  if (!query) apiError(400, 'INVALID_ARGUMENT', '查询为空');

  const kbId: string | undefined = body?.kbId || undefined;
  const topK = clampTopK(body?.topK); // BUG-023：0 应夹到下限 1，不能被 || 3 当成「没传」
  const threshold = Number(body?.threshold); // 0~1，可空

  // 越权防护：retrieve 不感知用户，此前传任意 kbId（或干脆不传）会把别人的个人库一起检索。
  // 这里先算出「当前用户可见的库」，指定 kbId 时必须是其中一员；不指定则只在可见范围内检索。
  // 注意：retrieve 把「空数组」当成「不限定范围」，所以可见范围为空时必须直接返回空结果。
  const allowedKbIds = await visibleKbIds(s.userId, s.role);
  let scopeKbIds: string[];
  if (kbId) {
    if (!allowedKbIds.includes(kbId)) {
      apiError(403, 'FORBIDDEN', '知识库不存在或无权检索');
    }
    scopeKbIds = [kbId];
  } else {
    scopeKbIds = allowedKbIds;
  }
  if (!scopeKbIds.length) return NextResponse.json([]);

  let hits = await retrieve(query, topK, scopeKbIds);
  if (!Number.isNaN(threshold) && threshold > 0) hits = hits.filter((h) => h.score >= threshold);
  return NextResponse.json(hits);
});
