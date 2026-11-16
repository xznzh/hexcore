/**
 * 定时任务通道（`runSchedule`）的两条硬约束。
 *
 * 为什么值得单独测：这条通道**无人值守**。它把失败报成成功、或者把被护栏截断的
 * 产出原样推出去，用户都不会当场发现——只会觉得「这个任务怎么没内容」。
 * 所以这里断言的不是「函数能跑」，而是「异常语义有没有传到底」。
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

let selectRows: any[] = [];
const inserted: any[] = [];
const updates: any[] = [];

const chain: any = {
  from: () => chain,
  where: () => chain,
  limit: () => Promise.resolve(selectRows),
  set: (v: any) => {
    updates.push(v);
    return chain;
  },
  values: (v: any) => {
    inserted.push(v);
    return Promise.resolve(undefined);
  },
  // 真实 drizzle 查询是 thenable：`await db.update(x).set(y).where(z)` 靠的就是它。
  // 替身缺了 then，await 拿到的是链对象本身，看起来像「查了但没写」。
  then: (resolve: any, reject: any) => Promise.resolve(undefined).then(resolve, reject),
  catch: (fn: any) => Promise.resolve(undefined).catch(fn),
  finally: (fn: any) => Promise.resolve(undefined).finally(fn),
};
const dbMock = {
  select: () => chain,
  update: () => chain,
  insert: () => chain,
};

vi.mock('@/lib/db', () => ({
  ensureInit: vi.fn(async () => undefined),
  isVectorSupported: () => false,
  get db() {
    return dbMock;
  },
}));
vi.mock('@/lib/llm', () => ({
  resolveModelWithFallback: vi.fn(async () => ({ name: 'mock-model', instance: {} })),
}));
vi.mock('@/lib/llm-gateway', () => ({ callModel: vi.fn(async () => ({ text: '直接生成的正文' })) }));
vi.mock('@/lib/agent', () => ({ runSkill: vi.fn() }));
vi.mock('@/lib/notify', () => ({ createNotification: vi.fn(async () => undefined) }));
vi.mock('@/lib/quota', () => ({ checkQuota: vi.fn(async () => ({ exceeded: false })) }));
vi.mock('@/lib/agent/quality-alert', () => ({ maybeRunQualityCheck: vi.fn(async () => null) }));
vi.mock('@/lib/redis', () => ({
  tryLock: vi.fn(async () => true),
  releaseLock: vi.fn(async () => undefined),
  extendLock: vi.fn(async () => true),
  // 熔断器现在是集群共享的（V8.22），会向 lib/redis 要客户端；
  // 这个文件测的是调度语义，不需要 Redis，故明确返回 null（走本地兜底）。
  getRedis: () => null,
}));
vi.mock('@/lib/util', () => ({
  newId: (p: string) => `${p}_test`,
  logAction: vi.fn(async () => undefined),
  estimateTokens: (s: string) => Math.ceil(String(s || '').length / 4),
  addUsage: vi.fn(async () => undefined),
}));

import { runSchedule, startScheduler, stopScheduler } from '@/lib/scheduler';
import { createNotification } from '@/lib/notify';
import { runSkill } from '@/lib/agent';
import { logAction } from '@/lib/util';
import { maybeRunQualityCheck } from '@/lib/agent/quality-alert';

const SKILL = { id: 'sk1', name: '周报技能', steps: '[]' };

function schedule(over: Record<string, any> = {}) {
  return {
    id: 's1',
    ownerId: 'u1',
    name: '每日简报',
    prompt: '汇总今日运营数据',
    cron: '0 9 * * *',
    target: 'prompt',
    skillId: null,
    modelId: null,
    enabled: true,
    notify: 'none',
    webhookUrl: null,
    ...over,
  } as any;
}

const lastNotification = () => vi.mocked(createNotification).mock.calls.at(-1)!;
const lastRunRecord = () => inserted.find((v) => v && 'scheduleId' in v);

describe('定时任务通道：中断与护栏语义', () => {
  beforeEach(() => {
    selectRows = [SKILL];
    inserted.length = 0;
    updates.length = 0;
    vi.mocked(createNotification).mockClear();
    vi.mocked(runSkill).mockReset();
  });

  it('技能被墙钟中断 → 报「中断」而不是「完成」，且保留部分产出', async () => {
    vi.mocked(runSkill).mockResolvedValueOnce({
      result: '前两条数据已经汇总完，第三条在读取时',
      trajectory: [],
      aborted: true,
      abortReason: '超出单次运行墙钟 120s',
    } as any);

    const out = await runSchedule(schedule({ target: 'skill', skillId: 'sk1' }));

    expect(out).toContain('前两条数据');
    const [, title, body] = lastNotification();
    expect(title).toContain('中断');
    expect(title).not.toContain('完成');
    expect(body).toContain('120s');
    // 执行历史里必须留下它，否则「任务没跑」无从追查
    const rec = lastRunRecord();
    expect(rec?.status).toBe('error');
    expect(rec?.result).toContain('前两条数据');
  });

  it('中断同时 push webhook → payload 里 aborted 单独可见', async () => {
    vi.mocked(runSkill).mockResolvedValueOnce({
      result: '半截产出',
      trajectory: [],
      aborted: true,
      abortReason: '预算耗尽',
    } as any);
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('ok'));

    await runSchedule(schedule({ target: 'skill', skillId: 'sk1', notify: 'webhook', webhookUrl: 'https://example.com/hook' }));

    const payload = JSON.parse(String((fetchSpy.mock.calls[0][1] as any).body));
    expect(payload.status).toBe('error');
    expect(payload.aborted).toBe(true);
    expect(payload.result).toContain('半截产出');
    fetchSpy.mockRestore();
  });

  it('正常完成但被护栏拦截 → 标题如实说明「已按安全策略处理」', async () => {
    vi.mocked(runSkill).mockResolvedValueOnce({
      result: '结论如下。\nDROP TABLE users;',
      trajectory: [],
    } as any);

    const out = await runSchedule(schedule({ target: 'skill', skillId: 'sk1' }));

    expect(out).not.toContain('DROP TABLE users;');
    const [, title] = lastNotification();
    expect(title).toContain('已按安全策略处理');
  });

  it('工具节点里有出处的引用不被误伤（V8.3 的空上下文会截断它）', async () => {
    vi.mocked(runSkill).mockResolvedValueOnce({
      result: '按《2025 年度运营报告》，留存率 42%。',
      trajectory: [
        { role: 'worker', type: 'tool', tool: 'search_knowledge', prompt: 'p', output: '[运营报告.docx] 《2025 年度运营报告》留存率 42%' },
      ],
    } as any);

    const out = await runSchedule(schedule({ target: 'skill', skillId: 'sk1' }));

    expect(out).toContain('《2025 年度运营报告》');
    const [, title] = lastNotification();
    expect(title).not.toContain('已按安全策略处理');
  });

  it('定时任务的原始指令参与语境判定：写着「你替我定」就按越权语境拦', async () => {
    vi.mocked(runSkill).mockResolvedValueOnce({
      result: '验收标准已定稿，本周五上线。',
      trajectory: [],
    } as any);

    await runSchedule(schedule({ target: 'skill', skillId: 'sk1', prompt: '验收标准你替我定了，就按我说的写' }));

    const [, title] = lastNotification();
    expect(title).toContain('已按安全策略处理');
  });
});

/**
 * 运行时 V 层在这条通道上的接线（V8.6）。
 *
 * 断言的重点是**轨迹确实传进了校验器**：如果只传 answer 不传轨迹，
 * 「已使用能力」会被无条件判成空话——这类误报不会让任何东西报错，
 * 只会让日志失去可信度，最后没人再看。
 */
describe('定时任务通道：运行时 V 层记账', () => {
  const evalLogs = () =>
    vi.mocked(logAction).mock.calls.filter((c) => c[1] === 'eval_runtime');

  beforeEach(() => {
    selectRows = [SKILL];
    inserted.length = 0;
    updates.length = 0;
    vi.mocked(createNotification).mockClear();
    vi.mocked(runSkill).mockReset();
    vi.mocked(logAction).mockClear();
  });

  it('技能产出为空 → 记 fail / empty_answer（无人值守的静默失败）', async () => {
    vi.mocked(runSkill).mockResolvedValueOnce({ result: '   ', trajectory: [] } as any);

    await runSchedule(schedule({ target: 'skill', skillId: 'sk1' }));

    await vi.waitFor(() => expect(evalLogs().length).toBeGreaterThan(0));
    const [, , target, meta] = evalLogs()[0];
    expect(target).toBe('fail');
    // 用可选链而不是 `!`：meta 是 logAction 的第 4 个参数（签名上可选）。
    // 万一它真没传，expect(undefined).toContain 会直接把这个用例判失败——这正是我们要的断言。
    expect(meta?.status).toBe('error');
    expect(meta?.detail).toContain('empty_answer');
    expect(meta?.detail).toContain('channel · schedule/每日简报');
  });

  it('声称用了能力但轨迹里没有对应工具 → 记 warn', async () => {
    vi.mocked(runSkill).mockResolvedValueOnce({
      result: '已使用能力：天气查询\n今日晴，18℃。',
      trajectory: [{ role: 'worker', type: 'llm', prompt: 'p', output: '今日晴' }],
    } as any);

    await runSchedule(schedule({ target: 'skill', skillId: 'sk1' }));

    await vi.waitFor(() => expect(evalLogs().length).toBeGreaterThan(0));
    const [, , target, meta] = evalLogs()[0];
    expect(target).toBe('pass_with_warn');
    expect(meta?.detail).toContain('ungrounded_capability');
  });

  it('轨迹里真有 invoke_capability 时不报（说明轨迹确实被传进去了）', async () => {
    vi.mocked(runSkill).mockResolvedValueOnce({
      result: '已使用能力：天气查询\n今日晴，18℃。',
      trajectory: [
        { role: 'worker', type: 'tool', tool: 'invoke_capability', prompt: 'p', output: '{"temp":18}' },
      ],
    } as any);

    await runSchedule(schedule({ target: 'skill', skillId: 'sk1' }));

    // 没有问题就不写日志——所以这里断言的是「没有 eval_runtime」，而不是某条 pass 记录
    await new Promise((r) => setTimeout(r, 20));
    expect(evalLogs()).toEqual([]);
  });
});

/**
 * V8.8：质量告警靠调度器的 tick 驱动。
 *
 * 独立成一个 describe 是因为它测的不是「告警逻辑」（那是 quality-alert 的事），
 * 而是「告警会不会真的被叫起来」。前几轮反复出现的失效形态就是这类：
 * 逻辑写好了、测试全绿，但没有任何地方调用它——没有任何报错，只是永远不触发。
 */
describe('调度器 tick 是否驱动质量告警检查', () => {
  it('每分钟的 tick 会顺带跑一次告警检查', async () => {
    selectRows = [];
    vi.useFakeTimers();
    try {
      startScheduler();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(maybeRunQualityCheck).toHaveBeenCalled();
    } finally {
      stopScheduler();
      vi.useRealTimers();
    }
  });
});
