import { describe, expect, it } from 'vitest';
import { composeCostReport, normalizeModelName, type CostAggRow, type ModelPrice } from '../lib/agent/cost-report';

const price = (inCents: number, outCents: number): ModelPrice => ({ in: inCents, out: outCents });

function row(p: Partial<CostAggRow> = {}): CostAggRow {
  return {
    day: '2026-11-11',
    model: 'M1',
    label: 'chat',
    ok: true,
    calls: 1,
    tokens: 0,
    promptTokens: 0,
    completionTokens: 0,
    ...p,
  };
}

describe('normalizeModelName', () => {
  it('把空格/连字符/下划线/点都抹掉并转小写（同一模型两种写法要合并）', () => {
    expect(normalizeModelName('MiniMax-M3.1-Flash')).toBe(normalizeModelName('MiniMax M3.1 Flash'));
    expect(normalizeModelName('GPT_4o')).toBe(normalizeModelName('gpt-4o'));
  });

  it('空值回落成 unknown 而不是空串（空 key 会让所有未知名混成一个桶）', () => {
    expect(normalizeModelName('')).toBe('unknown');
  });
});

describe('composeCostReport · 金额', () => {
  it('输入与输出分开计价（单价单位：分 / 千 token）', () => {
    const r = composeCostReport(
      [row({ tokens: 1500, promptTokens: 1000, completionTokens: 500 })],
      new Map([['m1', price(2, 8)]]),
    );
    // 1000/1000*2 = 2 分；500/1000*8 = 4 分
    expect(r.total.costCents).toBeCloseTo(6, 5);
    expect(r.total.fullyPriced).toBe(true);
  });

  it('同一天的多个分组会累加，不因四舍五入漂移', () => {
    const r = composeCostReport(
      [
        row({ tokens: 1000, promptTokens: 1000 }),
        row({ tokens: 1000, promptTokens: 1000 }),
        row({ tokens: 1000, promptTokens: 1000 }),
      ],
      new Map([['m1', price(1, 0)]]),
    );
    expect(r.total.costCents).toBeCloseTo(3, 5); // 1 + 1 + 1，不是 0.99 或 3.0000000001
    expect(r.byDay).toHaveLength(1);
    expect(r.byDay[0].tokens).toBe(3000);
  });

  it('没配单价（0/0）按「未计价」处理，不写 0 元', () => {
    const r = composeCostReport([row({ tokens: 5000, promptTokens: 4000, completionTokens: 1000 })], new Map([['m1', price(0, 0)]]));
    expect(r.total.costCents).toBe(0);
    expect(r.total.unpriced.noPriceTokens).toBe(5000);
    // 关键：fullyPriced 必须是 false，否则页面上的 ¥0.00 会被读成「没花钱」
    expect(r.total.fullyPriced).toBe(false);
  });

  it('模型压根没在 models 表里 → 未计价', () => {
    const r = composeCostReport([row({ model: '未配置的模型', tokens: 1000, promptTokens: 1000 })], new Map());
    expect(r.total.unpriced.noPriceTokens).toBe(1000);
  });

  it('有单价但拆不出输入/输出（历史行只有总量）→ 未计价而不是猜一个', () => {
    const r = composeCostReport([row({ tokens: 2000 })], new Map([['m1', price(5, 10)]]));
    expect(r.total.costCents).toBe(0);
    expect(r.total.unpriced.unsplitTokens).toBe(2000);
  });

  it('拆分只覆盖一部分时，差额按未计价单独记（不重复计费）', () => {
    const r = composeCostReport(
      [row({ tokens: 3000, promptTokens: 1000, completionTokens: 500 })],
      new Map([['m1', price(2, 8)]]),
    );
    expect(r.total.costCents).toBeCloseTo(6, 5);
    expect(r.total.unpriced.unsplitTokens).toBe(1500);
    expect(r.total.fullyPriced).toBe(false);
  });
});

describe('composeCostReport · 失败率', () => {
  it('成败未知的行不进分母（否则历史数据越多失败率越被稀释）', () => {
    const r = composeCostReport(
      [
        row({ ok: true, calls: 8 }),
        row({ ok: false, calls: 2 }),
        row({ ok: null, calls: 90 }),
      ],
      new Map(),
    );
    expect(r.total.calls).toBe(100);
    expect(r.total.unknownOkCalls).toBe(90);
    expect(r.total.failRate).toBe(20); // 2 / (8+2)，不是 2/100
  });

  it('全部未知时不报 0%，报 0 但把 unknownOkCalls 给出来', () => {
    const r = composeCostReport([row({ ok: null, calls: 5 })], new Map());
    expect(r.total.failRate).toBe(0);
    expect(r.total.unknownOkCalls).toBe(5);
  });
});

describe('composeCostReport · 分桶', () => {
  it('同一模型的两种写法合并成一个桶，展示名取 token 多的那种', () => {
    const r = composeCostReport(
      [
        row({ model: 'MiniMax-M3.1', tokens: 100, promptTokens: 100 }),
        row({ model: 'MiniMax M3.1', tokens: 900, promptTokens: 900 }),
      ],
      new Map([['minimaxm3.1', price(1, 0)]]),
    );
    expect(r.byModel).toHaveLength(1);
    expect(r.byModel[0].key).toBe('MiniMax M3.1');
    expect(r.byModel[0].tokens).toBe(1000);
  });

  it('byDay 按日期升序（趋势图不能乱序）', () => {
    const r = composeCostReport(
      [row({ day: '2026-11-11' }), row({ day: '2026-11-09' }), row({ day: '2026-11-10' })],
      new Map(),
    );
    expect(r.byDay.map((d) => d.key)).toEqual(['2026-11-09', '2026-11-10', '2026-11-11']);
  });

  it('label 为空时归到「（未知）」而不是 null 键', () => {
    const r = composeCostReport([row({ label: null, tokens: 10 })], new Map());
    expect(r.byLabel[0].key).toBe('（未知）');
  });

  it('分桶金额与总金额一致（避免两个页面给出两个数）', () => {
    const rows = [
      row({ day: '2026-11-10', label: 'chat', tokens: 1000, promptTokens: 1000 }),
      row({ day: '2026-11-11', label: 'summary', tokens: 2000, promptTokens: 0, completionTokens: 2000 }),
    ];
    const r = composeCostReport(rows, new Map([['m1', price(1, 2)]]));
    const sumDay = r.byDay.reduce((s, x) => s + x.costCents, 0);
    const sumLabel = r.byLabel.reduce((s, x) => s + x.costCents, 0);
    expect(sumDay).toBeCloseTo(r.total.costCents, 5);
    expect(sumLabel).toBeCloseTo(r.total.costCents, 5);
  });
});

describe('composeCostReport · 边界', () => {
  it('空输入不抛错，返回全零', () => {
    const r = composeCostReport([], new Map());
    expect(r.total).toMatchObject({ tokens: 0, calls: 0, costCents: 0, failRate: 0 });
    expect(r.byDay).toEqual([]);
  });

  it('字符串数字（pg 的 bigint 会以字符串回来）也能算', () => {
    const r = composeCostReport(
      [{ day: '2026-11-11', model: 'm1', label: 'chat', ok: true, calls: '2' as any, tokens: '1000' as any, promptTokens: '1000' as any, completionTokens: '0' as any }],
      new Map([['m1', price(3, 0)]]),
    );
    expect(r.total.tokens).toBe(1000);
    expect(r.total.calls).toBe(2);
    expect(r.total.costCents).toBeCloseTo(3, 5);
  });
});
