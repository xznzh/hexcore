import { NextResponse } from 'next/server';
import { checkRateLimit } from '@/lib/redis';
import {
  findCapabilityForUser,
  formatInputErrors,
  invokeCapability,
  coerceCapabilityInput,
  validateCapabilityInput,
} from '@/lib/capabilities';
import { withApi, apiError } from '@/lib/api/handler';

export const dynamic = 'force-dynamic';

/**
 * 统一能力调用入口：
 * - mode='async' 时转后台执行，返回 202 + operationId 供轮询；
 * - 需要审批时落审批单，返回 202；
 * - 参数按 inputSchema 轻量校验（必填 / 类型 / 枚举），不合法返回 400 + errors。
 */
export const POST = withApi(async ({ req, session }) => {
  // 访客只读：能力调用可能真实写下游系统（建单、发消息），不能只靠 chat 入口拦
  if (session.role === 'guest') apiError(403, 'FORBIDDEN', '访客为只读角色，无法调用能力');
  // 限流：能力调用会真实打到下游连接器（外部额度/费用/写入副作用），是比 chat 更贵的入口，
  // 此前完全没有限流，脚本循环调用即可打爆下游。口径：单用户 60 次 / 分钟。
  const allowed = await checkRateLimit(`ratelimit:invoke:${session.userId}`, 60, 60);
  if (!allowed) apiError(429, 'RATE_LIMITED', '调用过于频繁，请稍后重试');

  const body = await req.json().catch(() => null);
  const name = String(body?.name || body?.id || '').trim();
  if (!name) apiError(400, 'INVALID_ARGUMENT', '缺少 name');

  const found = await findCapabilityForUser(name, { userId: session.userId, role: session.role });
  if (!found) apiError(404, 'NOT_FOUND', '能力不存在或无权调用');

  let input: any = body?.input ?? {};
  if (typeof input === 'string') {
    try {
      input = JSON.parse(input);
    } catch {
      // 保留 errors 数组：前端据此把错误定位到具体字段，包成 ApiError 会丢掉这个结构
      return NextResponse.json(
        { error: '参数必须是合法 JSON', errors: [{ field: '$', message: '参数必须是合法 JSON 对象' }] },
        { status: 400 },
      );
    }
  }
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return NextResponse.json(
      { error: '参数必须是 JSON 对象', errors: [{ field: '$', message: '参数必须是 JSON 对象' }] },
      { status: 400 },
    );
  }

  // 已审批的操作按审批时保存的参数执行，无需再次校验
  if (!body?.operationId) {
    // 无损类型纠正：数字写成字符串等情况自动转回，再校验
    Object.assign(input, coerceCapabilityInput(found.cap.inputSchema, input));
    const errors = validateCapabilityInput(found.cap.inputSchema, input);
    if (errors.length) {
      return NextResponse.json({ error: formatInputErrors(errors), errors }, { status: 400 });
    }
  }

  const mode = body?.mode === 'async' ? 'async' : 'sync';
  const r = await invokeCapability({
    cap: found.cap,
    conn: found.conn,
    input,
    actor: { userId: session.userId, role: session.role },
    source: body?.source || 'api',
    conversationId: body?.conversationId,
    approvedOperationId: body?.operationId,
    mode,
  });
  const status = r.status === 'pending_approval' || r.status === 'running' ? 202 : 200;
  return NextResponse.json(r, { status });
});
