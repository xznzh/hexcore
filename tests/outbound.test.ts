import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildWebhookPayload,
  deliverWebhook,
  inspectWebhookBody,
  normalizeWebhookKind,
  readOutboundTargets,
  type OutboundMessage,
} from '@/lib/outbound';
import { resetCircuit } from '@/lib/resilience';

/**
 * 出站投递的测试重心不在「happy path」，而在四个**看起来成功**的失败模式：
 *  1) HTTP 200 + 业务错误码（企微/钉钉/飞书的常态）；
 *  2) 4xx 被重试（把配置错误重复三遍，还会触发接收端风控）；
 *  3) 熔断没生效（一个下线的 webhook 让每次告警都等满超时）；
 *  4) 错误信息把 access_token 带进日志。
 */

const MSG: OutboundMessage = {
  event: 'quality_alert',
  title: '质量告警 · skill/日报 · empty_answer',
  body: '最近 60 分钟内「skill/日报」有 3 次触发 empty_answer（阻断级）。',
  meta: { channel: 'skill', label: '日报' },
};

/** 测试统一用环回地址：`assertSafeUrl` 对 IP 字面量直接放行，不打 DNS */
const URL_OK = 'http://127.0.0.1:9/hook';

function mockFetchOnce(impl: () => any) {
  return vi.spyOn(globalThis, 'fetch').mockImplementationOnce(async () => impl() as any);
}

/**
 * 响应替身必须带 `headers`：`safeFetch` 会读 `res.headers.get('location')` 判重定向，
 * 少了它就在 `safeFetch` 里抛 TypeError，被上层当成「网络层失败」重试三次——
 * 断言 `attempts === 3` 的用例会因此假绿（本条踩过：三条用例各自「通过」，
 * 实际跑的是异常路径，一个字节都没测到业务逻辑）。
 */
function jsonRes(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(),
    text: async () => JSON.stringify(body),
  };
}

describe('lib/outbound 渠道载荷', () => {
  it('未知渠道名归一到 raw，而不是抛错（配置写错不该让告警彻底发不出去）', () => {
    expect(normalizeWebhookKind('WeCom')).toBe('wecom');
    expect(normalizeWebhookKind('飞书')).toBe('raw');
    expect(normalizeWebhookKind(undefined)).toBe('raw');
  });

  it('五个渠道各用各的结构，且标题都进得了正文', () => {
    const wecom = buildWebhookPayload('wecom', MSG) as any;
    expect(wecom.msgtype).toBe('text');
    expect(wecom.text.content).toContain('质量告警');

    const ding = buildWebhookPayload('dingtalk', MSG) as any;
    expect(ding.msgtype).toBe('text');

    const feishu = buildWebhookPayload('feishu', MSG) as any;
    expect(feishu.msg_type).toBe('text');
    expect(feishu.content.text).toContain('质量告警');

    const slack = buildWebhookPayload('slack', MSG) as any;
    expect(typeof slack.text).toBe('string');

    const raw = buildWebhookPayload('raw', MSG) as any;
    expect(raw.event).toBe('quality_alert');
    expect(raw.meta.channel).toBe('skill');
  });

  it('企业微信正文按 600 字截断（2048 字节上限，中文按 3 字节算）', () => {
    // 这条不是「好看的实现细节」：超长时企微返回 errcode 40058，
    // 而那正好是最需要看到告警的时刻。
    const long = { ...MSG, body: '告'.repeat(3000) };
    const c = (buildWebhookPayload('wecom', long) as any).text.content;
    expect(c.length).toBeLessThanOrEqual(600);
    expect(c).toContain('已截断');
  });

  it('raw 格式保留结构化 meta（自建接收端要能分流，不必反解自然语言）', () => {
    const raw = buildWebhookPayload('raw', MSG) as any;
    expect(raw.meta).toEqual({ channel: 'skill', label: '日报' });
    expect(typeof raw.ts).toBe('number');
  });
});

describe('lib/outbound 业务码判定（HTTP 200 不等于成功）', () => {
  it('errcode=0 视为成功', () => {
    expect(inspectWebhookBody('wecom', '{"errcode":0,"errmsg":"ok"}')).toBeNull();
  });

  it('errcode 非 0 返回可读原因', () => {
    const r = inspectWebhookBody('wecom', '{"errcode":93000,"errmsg":"invalid webhook url"}');
    expect(r).toContain('93000');
    expect(r).toContain('invalid webhook url');
  });

  it('兼容飞书的 code/msg 与旧版 StatusCode', () => {
    expect(inspectWebhookBody('feishu', '{"code":19021,"msg":"sign match fail"}')).toContain('19021');
    expect(inspectWebhookBody('feishu', '{"StatusCode":9499,"StatusMessage":"bad"}')).toContain('9499');
  });

  it('不认识的响应体一律当成功（假告警比漏判更难排查）', () => {
    expect(inspectWebhookBody('dingtalk', 'ok')).toBeNull();
    expect(inspectWebhookBody('dingtalk', '{"foo":"bar"}')).toBeNull();
    expect(inspectWebhookBody('dingtalk', '')).toBeNull();
  });

  it('raw / slack 不做业务码判定（它们没有统一约定）', () => {
    expect(inspectWebhookBody('raw', '{"errcode":500}')).toBeNull();
    expect(inspectWebhookBody('slack', '{"ok":false}')).toBeNull();
  });
});

describe('lib/outbound 投递', () => {
  beforeEach(() => {
    vi.stubEnv('SSRF_ALLOW_PRIVATE', 'true');
    vi.stubEnv('OUTBOUND_MAX_ATTEMPTS', '3');
    resetCircuit('webhook:http://127.0.0.1:9');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    resetCircuit('webhook:http://127.0.0.1:9');
  });

  it('没有 URL 时返回 skipped，而不是发一个空请求', async () => {
    const r = await deliverWebhook('', MSG);
    expect(r.ok).toBe(false);
    expect(r.skipped).toBe('no_url');
    expect(r.attempts).toBe(0);
  });

  it('成功时 attempts=1', async () => {
    mockFetchOnce(() => jsonRes({ errcode: 0, errmsg: 'ok' }));
    const r = await deliverWebhook(URL_OK, MSG, { kind: 'wecom', retryDelaysMs: [0] });
    expect(r.ok).toBe(true);
    expect(r.attempts).toBe(1);
    expect(r.status).toBe(200);
  });

  it('4xx 不重试（配置错误重试三次只是把同一份错误抄三遍）', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonRes({}, 404) as any);
    const r = await deliverWebhook(URL_OK, MSG, { retryDelaysMs: [0] });
    expect(r.ok).toBe(false);
    expect(r.attempts).toBe(1);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('5xx 重试到上限', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonRes({}, 502) as any);
    const r = await deliverWebhook(URL_OK, MSG, { retryDelaysMs: [0] });
    expect(r.ok).toBe(false);
    expect(r.attempts).toBe(3);
    expect(spy).toHaveBeenCalledTimes(3);
  });

  it('HTTP 200 + errcode 非 0：判失败，且不重试', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonRes({ errcode: 93000, errmsg: 'invalid url' }) as any);
    const r = await deliverWebhook(URL_OK, MSG, { kind: 'wecom', retryDelaysMs: [0] });
    expect(r.ok).toBe(false);
    expect(r.attempts).toBe(1);
    expect(r.error).toContain('93000');
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('网络异常可重试，最终仍失败时 attempts 与提示都对得上', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('ECONNREFUSED'));
    const r = await deliverWebhook(URL_OK, MSG, { retryDelaysMs: [0] });
    expect(r.ok).toBe(false);
    expect(r.attempts).toBe(3);
    expect(r.error).toContain('ECONNREFUSED');
    expect(spy).toHaveBeenCalledTimes(3);
  });

  it('连续失败达阈值后熔断，后续调用不再发请求', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonRes({}, 500) as any);
    // 3 次/轮 × 2 轮 = 6 次失败，越过熔断阈值 5
    await deliverWebhook(URL_OK, MSG, { retryDelaysMs: [0] });
    await deliverWebhook(URL_OK, MSG, { retryDelaysMs: [0] });
    const before = spy.mock.calls.length;
    const r = await deliverWebhook(URL_OK, MSG, { retryDelaysMs: [0] });
    expect(r.skipped).toBe('circuit_open');
    expect(r.attempts).toBe(0);
    expect(spy.mock.calls.length).toBe(before);
  });

  it('URL 非法时直接返回 bad_url，不计入熔断（改好配置不该还要等 30 秒）', async () => {
    const spy = vi.spyOn(globalThis, 'fetch');
    const r = await deliverWebhook('ftp://example.com/hook', MSG);
    expect(r.ok).toBe(false);
    expect(r.skipped).toBe('bad_url');
    expect(spy).not.toHaveBeenCalled();
  });

  it('错误信息里的 access_token 被脱敏', async () => {
    // 接收端把完整 URL 回显在错误里是常见行为；原样落日志等于把密钥写进操作日志。
    const spy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(
      new Error('request failed for http://127.0.0.1:9/hook?access_token=SECRET123456'),
    );
    const r = await deliverWebhook(URL_OK, MSG, { retryDelaysMs: [0] });
    expect(r.ok).toBe(false);
    expect(r.error).not.toContain('SECRET123456');
    spy.mockRestore();
  });
});

describe('lib/outbound 配置读取', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('逗号分隔、去空白、丢空项', () => {
    vi.stubEnv('TEST_HOOKS', ' https://a.example.com/x , ,https://b.example.com/y ');
    expect(readOutboundTargets('TEST_HOOKS')).toEqual(['https://a.example.com/x', 'https://b.example.com/y']);
  });

  it('未配置时返回空数组（不返回 [""]，那会让调用方以为有一个目标）', () => {
    expect(readOutboundTargets('TEST_HOOKS_MISSING')).toEqual([]);
  });
});
