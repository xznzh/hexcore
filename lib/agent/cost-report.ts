/**
 * 成本报表：把 `operation_logs` 的聚合行算成「token + 钱」（纯函数）。
 *
 * 为什么单独抽出来：这段逻辑原来写在 GET 路由里，只能靠真库验证，
 * 而它最容易错的地方恰恰是**算术**——单价单位、输入/输出分别计价、
 * 历史行没有拆分字段时的处理。这些都不需要数据库就能验，所以放成纯函数。
 *
 * 三条刻意的取舍（都会影响页面上的数字，写在这里省得下次再猜）：
 *
 * 1. **单价单位是「分 / 千 token」**（沿用 `models.price_in/price_out` 的定义），
 *    所以金额以「分」为单位返回，展示时再除 100。统一用分做中间量，
 *    避免浮点元在累加时出现 0.30000000000000004 这种脏数字。
 *
 * 2. **只对「拆得出输入/输出」的行计价**。历史行（v8.10 之前）只有一个总 token，
 *    按输入价算会低估、按输出价会高估；与其给一个看起来精确的错数字，
 *    不如把它们单列为 `unpriced.unsplitTokens`，让页面说实话。
 *
 * 3. **没配单价的行不计金额**，token 计入 `unpriced.noPriceTokens`。
 *    `price_in=0 && price_out=0` 是「管理员没填」，不是「免费」，这两者必须分开——
 *    否则看板上 ¥0.00 会被读成"没花钱"。
 */

export type CostAggRow = {
  day: string;
  model: string | null;
  label: string | null;
  ok: boolean | null;
  calls: number;
  tokens: number;
  promptTokens: number;
  completionTokens: number;
};

/** 分 / 千 token */
export type ModelPrice = { in: number; out: number };

export type CostBucket = {
  key: string;
  tokens: number;
  calls: number;
  /** 金额（分）；只统计可计价部分 */
  costCents: number;
  /** 该分组里无法计价的 token 数，用于解释「token 很多但金额很小」 */
  unpricedTokens: number;
};

export type CostReport = {
  total: {
    tokens: number;
    calls: number;
    /** 失败率（%）：分母只算「成败已知」的调用，未知的不进分母 */
    failRate: number;
    /** 未知成败的调用次数（历史行没有 ok 列） */
    unknownOkCalls: number;
    costCents: number;
    unpriced: { unsplitTokens: number; noPriceTokens: number };
    /** 是否所有可计价的行都算出了钱；false 时页面应提示「部分未计价」 */
    fullyPriced: boolean;
  };
  byDay: CostBucket[];
  byModel: CostBucket[];
  byLabel: CostBucket[];
};

/**
 * 模型名归一键：去掉空格/连字符/下划线/点并转小写。
 *
 * 同一个模型在历史上被写成过 `MiniMax-M3.1-Flash` 与 `MiniMax M3.1-Flash`
 * （不同入口取了配置名或模型 id），直接按字符串分组会出现两条统计。
 * 这里只做读取侧归并，不改写日志——审计流水应当保持原样。
 */
export function normalizeModelName(name: string): string {
  return (name || 'unknown').trim().toLowerCase().replace(/[\s\-_.·]+/g, '');
}

function money(tokens: number, pricePer1k: number): number {
  return (tokens / 1000) * pricePer1k;
}

/** 累加器：一个分组内的 token / 次数 / 金额 */
type Acc = { tokens: number; calls: number; costCents: number; unpricedTokens: number; names?: Map<string, number> };

function addTo(m: Map<string, Acc>, key: string, tokens: number, calls: number, cost: number, unpriced: number) {
  const v = m.get(key) || { tokens: 0, calls: 0, costCents: 0, unpricedTokens: 0 };
  v.tokens += tokens;
  v.calls += calls;
  v.costCents += cost;
  v.unpricedTokens += unpriced;
  m.set(key, v);
}

function toArr(m: Map<string, Acc>, pickName?: (a: Acc) => string): CostBucket[] {
  return [...m.entries()]
    .map(([key, v]) => ({
      key: pickName ? pickName(v) : key,
      tokens: v.tokens,
      calls: v.calls,
      costCents: Math.round(v.costCents * 100) / 100,
      unpricedTokens: v.unpricedTokens,
    }))
    .sort((a, b) => b.tokens - a.tokens || (a.key < b.key ? -1 : 1));
}

/**
 * @param rows 按「日 × 模型 × 用途 × 成败」预聚合过的行
 * @param prices 归一化模型名 → 单价
 */
export function composeCostReport(rows: CostAggRow[], prices: Map<string, ModelPrice>): CostReport {
  const byDay = new Map<string, Acc>();
  const byLabel = new Map<string, Acc>();
  // 模型用归一键做 key，同时记各写法的 token，最后挑最多的那写法做展示名
  const byModel = new Map<string, Acc>();

  let tokens = 0;
  let calls = 0;
  let failCalls = 0;
  let unknownOkCalls = 0;
  let costCents = 0;
  let unsplitTokens = 0;
  let noPriceTokens = 0;

  for (const r of rows) {
    const rowTokens = Number(r.tokens) || 0;
    const promptTokens = Number(r.promptTokens) || 0;
    const completionTokens = Number(r.completionTokens) || 0;
    const rowCalls = Number(r.calls) || 0;
    const rawModel = String(r.model || 'unknown');
    const norm = normalizeModelName(rawModel);
    const price = prices.get(norm);

    tokens += rowTokens;
    calls += rowCalls;

    // 成败：null 表示这行没有成败信息（历史行 target 里也没有 OK/FAIL 段）
    if (r.ok === false) failCalls += rowCalls;
    else if (r.ok === null || r.ok === undefined) unknownOkCalls += rowCalls;

    let rowCost = 0;
    let rowUnpriced = 0;
    const hasSplit = promptTokens > 0 || completionTokens > 0;
    if (!price || (price.in === 0 && price.out === 0)) {
      // 没配单价：token 全额计入「未计价」，不写 0 元
      noPriceTokens += rowTokens;
      rowUnpriced = rowTokens;
    } else if (!hasSplit) {
      // 有单价但拆不出输入/输出：不猜，单列出来让页面解释
      unsplitTokens += rowTokens;
      rowUnpriced = rowTokens;
    } else {
      rowCost = money(promptTokens, price.in) + money(completionTokens, price.out);
      // 极少数行可能只记了总量没记拆分，差额按未计价处理（既算进总未计价，也记到本行）
      const covered = promptTokens + completionTokens;
      if (rowTokens > covered) {
        unsplitTokens += rowTokens - covered;
        rowUnpriced += rowTokens - covered;
      }
      costCents += rowCost;
    }

    addTo(byDay, r.day, rowTokens, rowCalls, rowCost, rowUnpriced);
    addTo(byLabel, String(r.label || '（未知）'), rowTokens, rowCalls, rowCost, rowUnpriced);

    const acc = byModel.get(norm) || { tokens: 0, calls: 0, costCents: 0, unpricedTokens: 0, names: new Map() };
    acc.tokens += rowTokens;
    acc.calls += rowCalls;
    acc.costCents += rowCost;
    acc.unpricedTokens += rowUnpriced;
    acc.names!.set(rawModel, (acc.names!.get(rawModel) || 0) + rowTokens);
    byModel.set(norm, acc);
  }

  const known = calls - unknownOkCalls;

  return {
    total: {
      tokens,
      calls,
      // 分母只算「成败已知」的调用：把未知塞进分母会让失败率随着历史数据变多而稀释
      failRate: known > 0 ? Math.round((failCalls / known) * 1000) / 10 : 0,
      unknownOkCalls,
      costCents: Math.round(costCents * 100) / 100,
      unpriced: { unsplitTokens, noPriceTokens },
      fullyPriced: unsplitTokens === 0 && noPriceTokens === 0,
    },
    byDay: toArr(byDay).sort((a, b) => (a.key < b.key ? -1 : 1)),
    byModel: toArr(byModel, (a) => {
      // 展示名取 token 最多的那种写法（代表实际在用的配置名）
      const e = [...(a.names || new Map<string, number>()).entries()].sort((x, y) => y[1] - x[1])[0];
      return e ? e[0] : 'unknown';
    }),
    byLabel: toArr(byLabel),
  };
}
