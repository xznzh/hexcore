/**
 * 混合召回的两块纯逻辑：RRF 融合与词法腿的 SQL 字面量。
 *
 * 为什么单独测这两块：`retrieve()` 依赖真实 PG 与 embedding，无法在常规单测里跑；
 * 但「融合顺序对不对」「转义有没有漏」恰恰是最容易出错、也最容易静默出错的地方——
 * 融合错了表现为「答案偶尔不在 top-k」（看不出是 bug），转义漏了是注入。
 * 所以把这两块抽成纯函数，用单测锁住。
 */
import { describe, expect, it } from 'vitest';
import { blendScore, lexicalTerms, pgTextArrayLiteral, rrfFuse } from '@/lib/ai/rag';

const mk = (keys: string[]) => keys.map((key) => ({ key, item: key }));

describe('rrfFuse 倒数排名融合', () => {
  it('两路都靠前的条目胜出（互相印证）', () => {
    const out = rrfFuse([mk(['a', 'b', 'c']), mk(['b', 'd'])], { limit: 10 });
    expect(out[0].item).toBe('b');
    // b 在 A 列第 2、B 列第 1，累加后必须高于只在单列冒尖的 a
    expect(out.map((o) => o.item)).toEqual(['b', 'a', 'd', 'c']);
  });

  it('只在单路出现的条目也能进候选池（不被另一路否掉）', () => {
    const out = rrfFuse([mk(['a', 'b']), mk(['z'])], { limit: 10 });
    expect(out.map((o) => o.item)).toContain('z');
    expect(out).toHaveLength(3);
  });

  it('同一列表内重复条目只按最好名次计一次，不刷分', () => {
    const dup = rrfFuse([mk(['a', 'a', 'a']), mk(['b'])], { limit: 10 });
    const once = rrfFuse([mk(['a']), mk(['b'])], { limit: 10 });
    const a1 = dup.find((o) => o.item === 'a')!.score;
    const a2 = once.find((o) => o.item === 'a')!.score;
    expect(a1).toBeCloseTo(a2, 10);
  });

  it('k 越大名次差异被压得越平（k=60 时首末名差距很小）', () => {
    const big = rrfFuse([mk(['a', 'b'])], { k: 60, limit: 10 });
    const small = rrfFuse([mk(['a', 'b'])], { k: 0, limit: 10 });
    const gap = (r: typeof big) => r[0].score - r[1].score;
    expect(gap(big)).toBeLessThan(gap(small));
  });

  it('limit 截断，且不产生重复条目', () => {
    const out = rrfFuse([mk(['a', 'b', 'c']), mk(['b', 'c', 'd'])], { limit: 2 });
    expect(out).toHaveLength(2);
    expect(new Set(out.map((o) => o.item)).size).toBe(2);
  });

  it('空输入返回空数组（不抛错）', () => {
    expect(rrfFuse([], { limit: 5 })).toEqual([]);
    expect(rrfFuse([[], []], { limit: 5 })).toEqual([]);
  });

  it('同分时保持确定性（同输入永远同输出）', () => {
    const a = rrfFuse([mk(['x', 'y']), mk(['y', 'x'])], { limit: 5 });
    const b = rrfFuse([mk(['x', 'y']), mk(['y', 'x'])], { limit: 5 });
    expect(a.map((o) => o.item)).toEqual(b.map((o) => o.item));
  });

  it('记录每一路的名次，便于排障', () => {
    const out = rrfFuse([mk(['a', 'b']), mk(['b'])], { limit: 5 });
    expect(out.find((o) => o.item === 'b')!.ranks).toEqual([1, 0]);
    expect(out.find((o) => o.item === 'a')!.ranks).toEqual([0]);
  });
});

describe('pgTextArrayLiteral 词法腿 SQL 字面量', () => {
  it('普通词逐字面量拼接', () => {
    expect(pgTextArrayLiteral(['a', 'b'])).toBe(`ARRAY['a','b']::text[]`);
  });

  it('单引号翻倍转义（否则查询词能截断字符串）', () => {
    expect(pgTextArrayLiteral(["it's"])).toBe(`ARRAY['it''s']::text[]`);
    expect(pgTextArrayLiteral(["'); DROP TABLE chunks; --"])).toBe(
      `ARRAY['''); DROP TABLE chunks; --']::text[]`,
    );
  });

  it('空数组给出合法但空集的字面量', () => {
    expect(pgTextArrayLiteral([])).toBe('ARRAY[]::text[]');
  });
});

describe('lexicalTerms 词法腿查询词', () => {
  it('英文整词与中文二元组都要有（纯中文问句才召得回）', () => {
    const t = lexicalTerms('vib 读数超标怎么办');
    expect(t).toContain('vib');
    expect(t).toContain('读数');
    expect(t).toContain('超标');
  });

  it('去重并限量', () => {
    const t = lexicalTerms('接口接口接口', 4);
    expect(t.length).toBeLessThanOrEqual(4);
    expect(new Set(t).size).toBe(t.length);
  });

  it('纯标点不产生查询词', () => {
    expect(lexicalTerms('？！。')).toEqual([]);
  });
});

describe('blendScore 标定分（0.62 闸门依赖它，口径不许漂）', () => {
  it('向量满分且词面命中 → 1', () => {
    expect(blendScore('接口鉴权', '接口鉴权说明', 1)).toBe(1);
  });

  it('向量为 0 且无任何重合 → 0', () => {
    expect(blendScore('接口鉴权', '完全无关的一段话', 0)).toBe(0);
  });

  it('仍是 0.75 / 0.25 的加权，未被改成 RRF 分', () => {
    // 词法满分（片段包含整个查询）+ 向量 0 → 只剩 0.25 的词法项
    expect(blendScore('接口鉴权', '接口鉴权', 0)).toBe(0.25);
    // 词法满分 + 向量满分 → 1；权重和必须为 1，否则闸门阈值失去意义
    expect(blendScore('接口鉴权', '接口鉴权', 1)).toBe(1);
  });

  it('结果始终落在 [0,1]', () => {
    for (const v of [0, 0.3, 0.75, 1]) {
      const s = blendScore('温度超标', '温度日均值超标 3 倍', v);
      expect(s).toBeGreaterThanOrEqual(0);
      expect(s).toBeLessThanOrEqual(1);
    }
  });
});
