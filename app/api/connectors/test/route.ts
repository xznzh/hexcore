import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { connectors } from '@/lib/schema';
import { eq } from 'drizzle-orm';
import { callConnector } from '@/lib/tools';
import { checkConnectorHealth } from '@/lib/connectors/service';
import { logAction } from '@/lib/util';
import { decryptJson } from '@/lib/crypto';
import { resetCircuit } from '@/lib/resilience';
import { withApi, apiError } from '@/lib/api/handler';

export const dynamic = 'force-dynamic';

export const POST = withApi(async ({ req, session }) => {
  if (session.role === 'guest') apiError(403, 'FORBIDDEN', '访客为只读角色，无法测试连接器');
  const body = await req.json().catch(() => null);
  const id: string | undefined = body?.id;
  if (!id) apiError(400, 'INVALID_ARGUMENT', '缺少 id');

  const c = (await db.select().from(connectors).where(eq(connectors.id, id)).limit(1))[0];
  if (!c) apiError(404, 'NOT_FOUND', '连接器不存在');

  // OpenAPI 连接器没有单一 url 可测，改为探测 spec/基地址，并引导到能力目录调用具体接口
  // config 落库时已加密（lib/crypto.ts encryptJson），decryptJson 兼容历史明文行
  const cfg: any = decryptJson(c.config);

  // 能力型连接器没有单一的「调用 URL」可测（配置里只有 baseUrl + 若干能力），
  // 走通用 HTTP 调用分支只会拿到「URL 格式不合法」。改为探测 spec/基地址，并引导到能力目录调用具体接口。
  // 判据同时覆盖「有 OpenAPI 文档」与「只有 baseUrl 的手工连接器」两种情况。
  const probeTarget = c.specUrl || cfg.specUrl || c.baseUrl || cfg.baseUrl || '';
  if (!cfg.url && probeTarget) {
    const h = await checkConnectorHealth(id);
    await logAction(session.userId, 'connector_test', c.name);
    // 基地址根路径通常不接受无参探测（400/404），这恰恰说明服务可达；
    // 不解释一句的话「状态正常 + HTTP 400」看起来像自相矛盾。
    const note =
      h.status === 'ok' && /HTTP 4\d\d/.test(h.detail)
        ? '\n（4xx 说明服务可达，只是根路径不接受无参探测；具体接口是否可用请到能力目录调用验证）'
        : '';
    return NextResponse.json({
      ok: true,
      result:
        `能力型连接器：${c.name}\n` +
        `探测地址：${probeTarget}\n` +
        `状态：${h.status === 'ok' ? '正常' : '异常'}\n` +
        `${h.detail}${note}\n\n` +
        '提示：具体能力请在「能力目录」选择后调用。',
    });
  }

  // 「手动测试」是排障动作：先清掉该连接器的熔断状态，否则下游刚修好也测不通（会被熔断直接拦掉）
  resetCircuit(`connector:${id}`);

  const result = await callConnector(c, session.userId);
  await logAction(session.userId, 'connector_test', c.name);
  return NextResponse.json({ ok: true, result });
});
