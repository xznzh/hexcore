/**
 * 评测判定器（纯函数，无网络、无数据库）
 *
 * 单独抽出来是为了能被单测覆盖：**评测器本身也需要被评测**。
 * 2026-10-29 这一轮里，50 条用例的 6 条失败中有 4 条是判定器误伤
 * （把「2030 年温度目标读数」里的 2.5、把括号里的 2024 年当成编造数据），
 * 而这些误判会被当成系统缺陷写进复盘，形成错误结论。
 */

export type Golden = {
  id: string;
  type: 'answer' | 'abstain';
  q: string;
  /** 每组至少命中一个关键词；全部组命中才算答对（组之间是 AND，组内是 OR） */
  must_contain?: string[][];
  /** 命中任一正则即判定为幻觉（只在 abstain 类使用） */
  forbidden?: string[];
  /** 期望命中的文档名片段，用于单独衡量检索质量 */
  source?: string;
  note?: string;
};

export type RetrievalHitLike = { content: string; source: string; score: number };

/**
 * 弃答表达：只有这些说法才算「承认自己不知道」。
 * 词表是按真实失败回答一轮轮补出来的，判据只有一个：
 * **这句话有没有把「我给不出答案」明确传递给用户。**
 */
export const ABSTAIN_PATTERNS = [
  /不知道/,
  /不确定/,
  /未找到/,
  // 「无法」和动词之间常夹修饰词：「无法**直接**给出」「无法**准确**判断」，
  // 要求严格相邻会一直漏（abs-05 就这样假失败过）。
  /无法[^。]{0,6}(确(定|认)|回答|核实|查询|查|获取|取得|提供|给出|判断|判定|得知|查看|看到|计算|统计|得出|推算|推导|接入|读取|检索)/,
  // 同理，「没有」后面也常带定语：「没有接口名称或文档地址」「没有相关的气象数据」
  // 跨度要放宽到 30：模型会写「知识库中没有“2024 年上半年示例新区达标天数率”的数据」，
  // 对象名本身就有二十几个字，{0,10} 一直匹配不上（2026-10-29 一次改动让 4 条用例假失败）。
  /没有[^。]{0,30}(信息|数据|资料|记录|内容|说明|依据|上下文|文档|接口)/,
  // 这句是 route.ts 里明确教模型说的措辞，词表必须直接认：
  /(知识库|资料|文档|参考资料)[^。]{0,6}(中|里)?(都|并)?(没有|未|不)/,
  // 下面的措辞必须与 app/api/chat/route.ts 的「作答要求」保持同步：
  // 第 ④ 条教模型说「请直接说明未取得」，词表里就必须有「未取得」——
  // 否则模型照着 prompt 正确回答，判定器却判它「没表态」（abs-16 就这样假失败过一轮）。
  /未(提及|包含|提供|说明|涉及|记录|配置|规定|明确|给出|列出|标注|取得|获得|获取|采集|载明|载有)/,
  /资料(中|里)(没有|未|不)/,
  /暂无/,
  /无从/,
  /超出(了)?(资料|手册|文档|知识库)/,
  /不在(资料|手册|文档|知识库)/,
  /(手册|资料|文档)(中|里)?(只|仅)(提到|包含|说明)/,
];

/** 上下标与微符号的归一化表：模型写 `℃`、`振动`，资料写 `℃`、`振动` */
const NORMALIZE_MAP: Record<string, string> = {
  '⁰': '0', '¹': '1', '²': '2', '³': '3', '⁴': '4', '⁵': '5', '⁶': '6', '⁷': '7', '⁸': '8', '⁹': '9',
  '₀': '0', '₁': '1', '₂': '2', '₃': '3', '₄': '4', '₅': '5', '₆': '6', '₇': '7', '₈': '8', '₉': '9',
  'µ': 'μ', // U+00B5 MICRO SIGN → U+03BC GREEK MU，两个字符肉眼完全一样
  '／': '/', '　': ' ',
};

/**
 * 剥掉 markdown 装饰 + 归一化「看起来一样但码位不同」的字符。
 *
 * 为什么必须做：`must_contain` 是字符串包含判断，`℃` 与 `℃` 差一个码位就算「没答对」。
 * 2026-10-29 实测：模型正确回答「温度是 ℃、功耗是 A」并额外指出原文单位不一致，
 * 却因为上标 ³ 被判成「缺少关键事实」。这类假失败最难查——回答看着完全正确。
 * 同理 `振动`/`振动`、`µ`/`μ`、全角斜杠，都会让一条用例莫名其妙地红。
 */
export function stripMarkdown(answer: string): string {
  return answer
    .replace(/[*_`]/g, '')
    .replace(/[⁰¹²³⁴-⁹₀-₉µ／　]/g, (c) => NORMALIZE_MAP[c] ?? c)
    .replace(/\s+/g, ' ');
}

/**
 * 宽松的否定表达（不要求动词精确搭配）。
 * 与 ABSTAIN_PATTERNS 的区别：那里要求「无法 + 具体动词」，
 * 这里只要出现「无法/没有/查不到」这类词 + 全段无数值，就认为是表过态了。
 */
const SOFT_NEGATION = /无法|没法|未能|没有|不能|不可|不知道|不确定|暂无|查不到|找不到|不存在|尚未|未经/;

/** 分句级的否定词：命中就把这一句从断言文本里剔除（词表比上面宽，含「未/不得」等） */
const NEG_CLAUSE = /未|没有|无法|不能|不可|不存在|暂无|暂缺|尚未|未能|不得|不够|无关|不能等同|并非同一/;

/**
 * 断言文本：把「我没说」的分句整段删掉，只留下模型真正在断言的内容。
 *
 * 为什么必须这么做：`forbidden` 正则是「标记词 + 附近数字」，
 * 而 `[^。]` 这种跨度会**跨过否定语**。
 * 实例（2026-10-29，abs-29）：
 *   「但全文未提供上一周乙区的振动读数，也没有…（报告中的"振动同比上升 54.8%"是示例新区整体数据，不能用于乙区）」
 * —— 模型明确说了做不到，正则却从「乙区」一路抓到引用的 54.8%，判它编造。
 * 同类误伤在 abs-01 / abs-24 / abs-16 上都出现过，靠一条条改正则治不完，
 * 所以在这里从结构上切断：分句有否定词 → 这一句不参与 forbidden 匹配。
 *
 * 代价：真有编造、但句子里恰好带着「不能/无法」的说法会漏判。
 * 可接受——报告里仍保留回答原文，人可以复核；而误判会被写成错误的复盘结论。
 *
 * 2026-10-29 又补了一类：**澄清句**。
 * abs-24 的真实回答是「…没有 GDP 数据及排名，因此无法确定 GDP 名次。现有资料仅显示其
 * 设备综合指数在全园排名第 11 位，与 GDP 排名无关。」
 * 前两句被剔除，第三句没有否定词被保留，而 `第 N 位…GDP` 的正则恰好跨到第四句的
 * 「与 GDP 无关」，把「说明两者无关」判成了「编造 GDP 名次」。
 * 所以「无关 / 不能等同 / 并非同一」也算否定分句——它们的语义就是「这不是同一回事」。
 */
export function assertiveText(answer: string): string {
  const text = stripMarkdown(answer);
  return text
    .split(/(?<=[。；;！!？?，,\n])/)
    .map((seg) => (NEG_CLAUSE.test(seg) ? '。' : seg))
    .join('');
}

/**
 * 剥掉「不是答案的数字」后，是否还剩数字。
 *
 * 用途：`abstain` 类的兜底判据——**答不出具体数值，就证明没在编数值**。
 * 起因是词表补了四轮还在漏（abs-03 说「无法查到…未接入薪酬数据源」，
 * 词表里没有「查到」「接入」两种说法，就被判成「没表态」）。
 * 逐条补词治不完，所以加一条不依赖措辞的结构性判据。
 *
 * 被剥掉的是：日期、异常项名（温度/振动）、章节号（1.2）、列表序号（1.）、
 * 规范号（GB 3095-2012）、版本/单位里的字母数字（m3）。
 * 代价：真有编造、但整段不含数字的回答会漏判（例如「年终奖一般在春节前发」）。
 * 这类回答本身没有「具体数值」，风险低于误判；报告里仍保留原文可人工复核。
 */
export function hasConcreteNumber(answer: string): boolean {
  const cleaned = stripMarkdown(answer)
    .replace(/^\s*\d+[.、)]\s?/gm, ' ') // 列表序号
    .replace(/\d{4}\s*年(\s*\d{1,2}\s*月)?(\s*\d{1,2}\s*日)?/g, ' ') // 年月日
    .replace(/\d{1,2}\s*月(\s*\d{1,2}\s*日)?/g, ' ') // 月日
    .replace(/\b[A-Za-z]{1,4}\d[\w.]*/g, ' ') // 代号里带的数字（T2.5 探头、P99、m3）
    .replace(/GB\s*\d+([-–]\d+)?/g, ' ') // 规范号
    .replace(/第\s*\d+\s*[条章节款页表图]/g, ' ') // 第 3 条 / 第 2 章
    .replace(/\d+(\.\d+)+\s*[条章节款]/g, ' ') // 1.2 节
    .replace(/\d+(\.\d+){2,}/g, ' ') // 章节号 1.2.3（只吃两段以上，避免误删 85.7）
    .replace(/[A-Za-z]+\d+/g, ' '); // v1 / m3 / h24
  return /\d/.test(cleaned);
}

export function judgeAnswer(
  g: Golden,
  answer: string,
  hits: RetrievalHitLike[],
): { pass: boolean; reason: string; sourceHit: boolean | null } {
  const text = stripMarkdown(answer);
  const assertive = assertiveText(answer);
  const sourceHit = g.source ? hits.some((h) => h.source.includes(g.source!)) : null;

  // 空回答单独判定：这不是「答错」，是模型没输出（可能被截断/上游异常），
  // 混进「没表态」里会掩盖真正的执行问题。
  if (!text.trim()) return { pass: false, reason: '模型返回空文本（执行异常，非质量问题）', sourceHit };

  if (g.type === 'answer') {
    const missing = (g.must_contain || []).filter((group) => !group.some((k) => text.includes(k)));
    if (missing.length) return { pass: false, reason: `缺少关键事实：${missing.map((m) => m.join('|')).join('；')}`, sourceHit };
    if (sourceHit === false) return { pass: false, reason: '答案看似正确但检索没命中预期文档（可能是模型自己编的）', sourceHit };
    return { pass: true, reason: '命中全部关键事实', sourceHit };
  }

  // 必须有 typeof 过滤：`new RegExp(undefined)` 不是「不匹配任何东西」，而是**空模式**——
  // 等价于 `new RegExp()`，它匹配任意字符串。一条 forbidden 传成 undefined，
  // 就会让所有回答被判成编造（2026-10-29 写测试时真踩了一次：把正则字符串传给只接受
  // RegExp 的辅助函数，`.source` 取出 undefined，整条用例直接假失败）。
  const hallucinated = (g.forbidden || []).filter(
    (f) => typeof f === 'string' && f.length > 0 && new RegExp(f).test(assertive),
  );
  if (hallucinated.length) return { pass: false, reason: `编造了不存在的具体信息：${hallucinated.join('；')}`, sourceHit };
  if (!ABSTAIN_PATTERNS.some((re) => re.test(text))) {
    // 结构性兜底：整段没有任何具体数值 → 不可能在编数值，按「已承认不知道」处理。
    // 这条不依赖措辞，专治「词表永远差一个说法」。
    if (!hasConcreteNumber(text) && SOFT_NEGATION.test(text))
      return { pass: true, reason: '未给出任何具体数值且明确表示做不到，视为已承认资料中无此信息', sourceHit };
    return { pass: false, reason: '知识库里没有该信息，但没有明确表示不知道', sourceHit };
  }
  return { pass: true, reason: '正确承认资料中无此信息', sourceHit };
}
