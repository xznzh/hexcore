/**
 * 质量告警（V8.8）。
 *
 * 这一层要守住的东西和前几轮不太一样：前几轮是「机制只装在一条通道上」，
 * 这轮是「机制存在但没人会看到」。所以测试分两块：
 *  1) 纯函数 `planChannelAlerts` —— 什么时候该吵、什么时候该闭嘴、恢复怎么算；
 *  2) I/O 侧 `runQualityCheck` —— 没有收件人时不能假装发过了。
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

let adminRows: any[] = [{ id: 'u_admin' }];
let logRows: any[] = [];

const dbMock = {
  // 真实 `db.execute()` 走原生 SQL，返回的是**蛇形列名**（created_at）。
  // 替身若照着领域类型写成 createdAt，行会在时间窗过滤那一步被全部丢弃，
  // 表现为「一条日志都没扫到」——却没有任何报错。
  execute: async () => ({ rows: logRows }),
  select: () => ({
    from: () => ({
      where: () => Promise.resolve(adminRows),
    }),
  }),
};

vi.mock('@/lib/db', () => ({
  get db() {
    return dbMock;
  },
}));
vi.mock('@/lib/settings', () => ({
  getSetting: vi.fn(async () => null),
  setSetting: vi.fn(async () => undefined),
}));
vi.mock('@/lib/notify', () => ({ createNotification: vi.fn(async () => undefined) }));
vi.mock('@/lib/util', () => ({ logAction: vi.fn(async () => undefined) }));
vi.mock('@/lib/redis', () => ({
  tryLock: vi.fn(async () => true),
  releaseLock: vi.fn(async () => undefined),
}));

import {
  planChannelAlerts,
  alertKey,
  readAlertPolicy,
  runQualityCheck,
  maybeRunQualityCheck,
  __resetThrottle,
  type AlertPolicy,
} from '@/lib/agent/quality-alert';
import { createNotification } from '@/lib/notify';
import { logAction } from '@/lib/util';
import { getSetting, setSetting } from '@/lib/settings';
import { tryLock } from '@/lib/redis';

const MIN = 60_000;
const NOW = 1_700_000_000_000;

const policy = (over: Partial<AlertPolicy> = {}): AlertPolicy => ({
  enabled: true,
  windowMin: 60,
  minCount: 3,
  cooldownMin: 360,
  recoveryMin: 60,
  maxAlertsPerRun: 5,
  intervalMin: 10,
  ...over,
});

/**
 * 构造一行日志。
 *
 * 同时给出 `createdAt`（领域类型）与 `created_at`（原始 SQL 列名）：
 * 纯函数读前者，I/O 侧的行映射读后者。只给一个就会出现「单元测试全绿、
 * 接线测试扫不到任何行」的割裂。
 */
function row(opts: {
  at?: number;
  channel?: string;
  label?: string;
  rule?: string;
  severity?: 'block' | 'warn';
  observe?: boolean;
  action?: string;
}) {
  const at = opts.at ?? NOW - 5 * MIN;
  let action = 'eval_runtime';
  let target = opts.channel ?? 'skill';
  let detail: string;

  if (opts.action === 'guardrail_output_block') {
    action = 'guardrail_output_block';
    target = opts.rule ?? 'unverified_citation';
    detail = `${opts.observe ? 'observe · ' : ''}${opts.channel ?? 'skill'}/${opts.label ?? '周报'} · 命中规则`;
  } else {
    const ch = opts.channel ?? 'skill';
    const label = opts.label ?? '周报';
    const rule = opts.rule ?? 'empty_answer';
    const sev = opts.severity ?? 'block';
    detail = `${opts.observe ? 'observe · ' : ''}channel · ${ch}/${label} · ${sev}:${rule}(说明)`;
  }

  return { action, target, detail, status: 'warn', createdAt: at, created_at: at };
}

/** 同一时刻往前推的 n 行，保证全部落在 `at` 之前（不会越过后来的 now） */
function rows(n: number, opts: Parameters<typeof row>[0] = {}) {
  const base = opts.at ?? NOW - 5 * MIN;
  return Array.from({ length: n }, (_, i) => row({ ...opts, at: base - i * 1000 }));
}

describe('planChannelAlerts · 何时该吵', () => {
  it('未达最小次数不告警：一次多半是抖动', () => {
    const p = planChannelAlerts(rows(2), policy(), NOW);
    expect(p.notifications).toEqual([]);
    expect(p.state.fired).toEqual({});
  });

  it('同一对象同一规则达到阈值即告警，标题能直接定位到「谁 · 哪条规则」', () => {
    const p = planChannelAlerts(rows(3), policy(), NOW);
    expect(p.notifications).toHaveLength(1);
    const n = p.notifications[0];
    expect(n.kind).toBe('issue');
    expect(n.title).toBe('质量告警 · skill/周报 · empty_answer');
    expect(n.body).toContain('3 次');
    expect(n.body).toContain('阻断级');
    expect(n.keys).toEqual([alertKey('skill', '周报', 'empty_answer')]);
  });

  it('不同标签分别计数，不会被合并成一个「累计 3 次」', () => {
    // 三个技能各一次，都不到阈值——若按通道汇总就会误报
    const p = planChannelAlerts(
      [...rows(1, { label: 'A' }), ...rows(1, { label: 'B' }), ...rows(1, { label: 'C' })],
      policy(),
      NOW,
    );
    expect(p.notifications).toEqual([]);
    expect(p.scanned).toBe(3);
  });

  it('对话通道没有标签，key 退化为「通道#规则」', () => {
    const chatRow = row({ channel: 'chat', rule: 'fabricated_source' });
    // 对话通道的 detail 没有 `channel · ` 前缀，需要单独构造
    const r = { ...chatRow, detail: 'block:fabricated_source(编造来源)' };
    const p = planChannelAlerts([r, { ...r }, { ...r }], policy(), NOW);
    expect(p.notifications[0].title).toBe('质量告警 · chat · fabricated_source');
    expect(p.notifications[0].keys).toEqual(['chat/#fabricated_source']);
  });

  it('窗口外的行不参与判定（否则昨天的故障会一直报）', () => {
    const old = rows(3, { at: NOW - 120 * MIN });
    const p = planChannelAlerts(old, policy(), NOW);
    expect(p.notifications).toEqual([]);
    expect(p.scanned).toBe(0);
  });

  it('warn 级也能告警，但正文标明「提示级」', () => {
    const p = planChannelAlerts(rows(3, { severity: 'warn', rule: 'thin_citation' }), policy(), NOW);
    expect(p.notifications[0].body).toContain('提示级');
  });
});

describe('planChannelAlerts · 静默期', () => {
  it('cooldown 内重复命中只压住，不重复通知，但压掉几条要能看见', () => {
    const first = planChannelAlerts(rows(3), policy(), NOW);
    expect(first.notifications).toHaveLength(1);

    // 10 分钟后再查：窗口里既有旧的 3 次，也有新的 4 次（真实查询同样会返回整窗）
    const second = planChannelAlerts(
      [...rows(3), ...rows(4, { at: NOW + 10 * MIN })],
      policy(),
      NOW + 10 * MIN,
      first.state,
    );
    expect(second.notifications).toEqual([]);
    expect(second.suppressed).toBe(1);
    expect(second.state.lastResult?.suppressed).toBe(1);
  });

  it('cooldown 过后仍没好转就再提醒一次（「还在坏」本身是信息）', () => {
    const first = planChannelAlerts(rows(3), policy(), NOW);
    const later = NOW + 400 * MIN;
    const second = planChannelAlerts(rows(3, { at: later - 5 * MIN }), policy(), later, first.state);
    expect(second.notifications).toHaveLength(1);
    expect(second.notifications[0].kind).toBe('issue');
  });

  it('单次上限按「次数多的优先」截断，被截掉的计入 suppressed', () => {
    const many = [...rows(3, { label: 'A' }), ...rows(9, { label: 'B' }), ...rows(5, { label: 'C' })];
    const p = planChannelAlerts(many, policy({ maxAlertsPerRun: 2 }), NOW);
    expect(p.notifications).toHaveLength(2);
    // B(9) 与 C(5) 优先，A(3) 被截
    expect(p.notifications.map((n) => n.title)).toEqual([
      '质量告警 · skill/B · empty_answer',
      '质量告警 · skill/C · empty_answer',
    ]);
    expect(p.suppressed).toBe(1);
  });
});

describe('planChannelAlerts · 恢复', () => {
  it('不再达到条件且已过 recoveryMin，发一条恢复通知', () => {
    const first = planChannelAlerts(rows(3), policy(), NOW);
    const later = NOW + 90 * MIN;
    const second = planChannelAlerts([], policy(), later, first.state);
    const rec = second.notifications.find((n) => n.kind === 'recovery');
    expect(rec).toBeDefined();
    expect(rec!.title).toContain('已解除');
    expect(rec!.body).toContain('未再达到告警条件');
    // 措辞必须留出「没跑」的可能，不能断言已修复
    expect(rec!.body).toContain('不等于');
  });

  it('刚报完就说「好了」是噪声：recoveryMin 之前不发', () => {
    const first = planChannelAlerts(rows(3), policy(), NOW);
    const second = planChannelAlerts([], policy(), NOW + 10 * MIN, first.state);
    expect(second.notifications.filter((n) => n.kind === 'recovery')).toEqual([]);
  });

  it('恢复只发一次：下一轮不会重复说「已解除」', () => {
    const first = planChannelAlerts(rows(3), policy(), NOW);
    const second = planChannelAlerts([], policy(), NOW + 90 * MIN, first.state);
    expect(second.notifications.filter((n) => n.kind === 'recovery')).toHaveLength(1);

    const third = planChannelAlerts([], policy(), NOW + 180 * MIN, second.state);
    expect(third.notifications.filter((n) => n.kind === 'recovery')).toEqual([]);
  });

  it('「从 5 次降到 2 次」算恢复：卡在阈值下方不该两边都不报', () => {
    const first = planChannelAlerts(rows(5), policy(), NOW);
    const later = NOW + 90 * MIN;
    // 窗口内仍有 2 次，但已低于 minCount
    const second = planChannelAlerts(rows(2, { at: later - 5 * MIN }), policy(), later, first.state);
    expect(second.notifications.filter((n) => n.kind === 'recovery')).toHaveLength(1);
  });

  it('恢复后 cooldown 内复发：压住，避免抖动刷屏', () => {
    const first = planChannelAlerts(rows(3), policy(), NOW);
    const rec = planChannelAlerts([], policy(), NOW + 90 * MIN, first.state);
    const again = planChannelAlerts(rows(3, { at: NOW + 120 * MIN }), policy(), NOW + 120 * MIN, rec.state);
    expect(again.notifications.filter((n) => n.kind === 'issue')).toEqual([]);
    expect(again.suppressed).toBe(1);
  });

  it('多个 key 同时恢复合并成一条通知', () => {
    const p1 = planChannelAlerts([...rows(3, { label: 'A' }), ...rows(3, { label: 'B' })], policy(), NOW);
    expect(p1.notifications).toHaveLength(2);
    const p2 = planChannelAlerts([], policy(), NOW + 90 * MIN, p1.state);
    const rec = p2.notifications.filter((n) => n.kind === 'recovery');
    expect(rec).toHaveLength(1);
    expect(rec[0].title).toContain('2 项');
    expect(rec[0].keys).toHaveLength(2);
  });
});

describe('planChannelAlerts · 平台自身问题与观察模式', () => {
  it('解析失败超过 0 行就告警，且一天只吵一次', () => {
    const bad = (at: number) => ({
      action: 'eval_runtime',
      target: 'skill',
      detail: '格式变了',
      status: null,
      createdAt: at,
    });
    const first = planChannelAlerts([bad(NOW - MIN)], policy(), NOW);
    expect(first.notifications.some((n) => n.kind === 'unparsed')).toBe(true);
    expect(first.unparsed).toBe(1);

    const second = planChannelAlerts([bad(NOW + 59 * MIN)], policy(), NOW + 60 * MIN, first.state);
    expect(second.notifications.some((n) => n.kind === 'unparsed')).toBe(false);
    expect(second.suppressed).toBeGreaterThan(0);

    const third = planChannelAlerts([bad(NOW + 24 * 60 * MIN)], policy(), NOW + 25 * 60 * MIN, second.state);
    expect(third.notifications.some((n) => n.kind === 'unparsed')).toBe(true);
  });

  it('观察模式下的命中会告警，但正文明确说「没有拦截」', () => {
    const p = planChannelAlerts(rows(3, { observe: true }), policy(), NOW);
    expect(p.notifications[0].body).toContain('观察模式');
    expect(p.notifications[0].body).toContain('没有');
  });

  it('同一 key 混有正常命中时不带观察模式提示（否则会误导）', () => {
    const p = planChannelAlerts([...rows(2, { observe: true }), ...rows(1)], policy(), NOW);
    expect(p.notifications[0].body).not.toContain('观察模式');
  });

  it('状态有上限：条目数受 MAX_STATE_KEYS 约束，不随技能增长无限膨胀', () => {
    const many = Array.from({ length: 600 }, (_, i) => row({ label: `S${i}` }));
    const p = planChannelAlerts(many, policy({ maxAlertsPerRun: 50 }), NOW);
    expect(Object.keys(p.state.fired).length).toBeLessThanOrEqual(500);
  });
});

describe('runQualityCheck · 没人可通知时不能假装发过了', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    adminRows = [{ id: 'u_admin' }];
    logRows = [];
    __resetThrottle();
  });

  it('关闭时直接跳过，不查询也不写状态', async () => {
    process.env.QUALITY_ALERT_ENABLED = 'off';
    const r = await runQualityCheck({ now: NOW });
    delete process.env.QUALITY_ALERT_ENABLED;
    expect(r.skipped).toBe('disabled');
    expect(setSetting).not.toHaveBeenCalled();
  });

  it('扫描到的行确实进入判定（蛇形列名 → 领域字段的映射没断）', async () => {
    logRows = rows(3);
    const r = await runQualityCheck({ now: NOW });
    expect(r.scanned).toBe(3);
  });

  it('给每个管理员各发一条（不能用 userId=null 广播，成员不该看到别人的技能名）', async () => {
    adminRows = [{ id: 'a1' }, { id: 'a2' }];
    logRows = rows(3);
    const r = await runQualityCheck({ now: NOW });
    expect(r.issued).toBe(1);
    expect(r.notified).toBe(2);
    expect(vi.mocked(createNotification).mock.calls.map((c) => c[0])).toEqual(['a1', 'a2']);
    expect(setSetting).toHaveBeenCalled();
  });

  it('没有可用管理员：日志留 error，而不是安静地「发完了」', async () => {
    adminRows = [];
    logRows = rows(3);
    const r = await runQualityCheck({ now: NOW });
    expect(r.issued).toBe(1);
    expect(r.notified).toBe(0);
    const call = vi.mocked(logAction).mock.calls.find((c) => c[1] === 'quality_alert');
    expect(call).toBeDefined();
    expect((call![3] as any)?.status).toBe('error');
  });

  it('dryRun 只算不发：不通知、不写状态', async () => {
    logRows = rows(3);
    const r = await runQualityCheck({ now: NOW, dryRun: true });
    expect(r.dryRun).toBe(true);
    expect(r.issued).toBe(1);
    expect(r.planned?.[0].kind).toBe('issue');
    expect(createNotification).not.toHaveBeenCalled();
    expect(setSetting).not.toHaveBeenCalled();
  });

  it('拿不到锁时跳过：多副本只有一个能发', async () => {
    vi.mocked(tryLock).mockResolvedValueOnce(false);
    logRows = rows(3);
    const r = await runQualityCheck({ now: NOW });
    expect(r.skipped).toBe('locked');
    expect(createNotification).not.toHaveBeenCalled();
  });

  it('读取上次状态后能接上 cooldown（状态确实被读，而不是每轮从零开始）', async () => {
    logRows = rows(3);
    vi.mocked(getSetting).mockResolvedValueOnce(
      JSON.stringify({ fired: { 'skill/周报#empty_answer': { at: NOW - 10 * MIN, count: 3, observe: false } } }),
    );
    const r = await runQualityCheck({ now: NOW });
    expect(r.issued).toBe(0);
    expect(r.suppressed).toBe(1);
    expect(createNotification).not.toHaveBeenCalled();
  });

  it('maybeRunQualityCheck 按 intervalMin 节流', async () => {
    logRows = [];
    const a = await maybeRunQualityCheck(NOW);
    expect(a).not.toBeNull();
    const b = await maybeRunQualityCheck(NOW + 60_000);
    expect(b).toBeNull();
    const c = await maybeRunQualityCheck(NOW + 11 * MIN);
    expect(c).not.toBeNull();
  });

  it('策略默认值来自环境变量时被夹在安全区间', () => {
    process.env.QUALITY_ALERT_MIN_COUNT = '0';
    process.env.QUALITY_ALERT_WINDOW_MIN = '99999';
    const p = readAlertPolicy();
    delete process.env.QUALITY_ALERT_MIN_COUNT;
    delete process.env.QUALITY_ALERT_WINDOW_MIN;
    expect(p.minCount).toBe(3); // 0 不是有效阈值，回退默认
    expect(p.windowMin).toBe(1440); // 夹到上限
  });
});
