import { describe, expect, it } from 'vitest';
import { assertiveText, hasConcreteNumber, judgeAnswer, stripMarkdown, type Golden } from './judge';

/**
 * 判定器的回归测试。
 *
 * 全部样本都来自 2026-10-29 那一轮真实评测的回答原文（`evals/reports/*.json`），
 * 每一条都对应一次真实误判或漏判。判定器出错比系统出错更危险：
 * 它会把「答对了」记成失败，然后被当成系统缺陷写进复盘。
 *
 * 这批用例不需要模型和数据库，`npm run eval` 会先跑它。
 * 正则一律用字面量传进来，避免字符串里 `\d` / `\\d` 的转义层次把自己绕进去。
 */
const abstain = (id: string, patterns: RegExp[]): Golden => ({
  id,
  type: 'abstain',
  q: 'q',
  forbidden: patterns.map((p) => p.source),
});
const answer = (id: string, must: string[][], source?: string): Golden => ({
  id,
  type: 'answer',
  q: 'q',
  must_contain: must,
  source,
});
const hits = [{ content: '', source: '周报-示例新区未来7天运行状态预报.docx', score: 0.9 }];

describe('stripMarkdown', () => {
  it('去掉加粗与代码符，保证正则能贴上数值', () => {
    expect(stripMarkdown('EHI：**100–130**')).toBe('EHI：100–130');
    expect(stripMarkdown('达标天数率 **54.8%**，同比`下降`')).toBe('达标天数率 54.8%，同比下降');
  });
});

describe('答案类判定', () => {
  it('命中全部关键事实即通过', () => {
    const v = judgeAnswer(answer('a1', [['64.1']], '周报'), '温度读数为 64.1℃', hits);
    expect(v.pass).toBe(true);
  });

  it('二维数组是「外层 AND、内层 OR」', () => {
    const g = answer('a2', [['Authorization'], ['X-Api-Key']], '周报');
    expect(judgeAnswer(g, '需要 Authorization 头', hits).pass).toBe(false);
    expect(judgeAnswer(g, '需要 Authorization 和 X-Api-Key', hits).pass).toBe(true);
  });

  it('答案正确但检索没命中预期文档 → 不算通过（疑似模型自编）', () => {
    const v = judgeAnswer(answer('a3', [['64.1']], '周报'), '64.1', [
      { content: '', source: '接口手册.docx', score: 0.9 },
    ]);
    expect(v.pass).toBe(false);
    expect(v.reason).toContain('检索没命中');
  });
});

describe('拒答类判定：真编造必须被抓到', () => {
  it('给出资料里没有的 EHI 数值 → 判编造', () => {
    // 真实样本：abs-26
    const v = judgeAnswer(abstain('abs-26', [/11\s*日[^。]{0,10}EHI[^。]{0,12}\d{2,3}/]), '11 日的 EHI 预报值为 **100～130**。', []);
    expect(v.pass).toBe(false);
  });

  it('加粗的数值也能被抓到（剥 markdown 后匹配）', () => {
    // 真实样本：abs-27
    const v = judgeAnswer(abstain('abs-27', [/(EHI|ehi)\s*[：:]?\s*\d{2,3}/]), '仅找到 **1 月 13 日**示例新区的 EHI：**100–130**。', []);
    expect(v.pass).toBe(false);
  });

  it('表格形态给出的编造区间也能抓到（正则跨不过 `|` 就会漏判）', () => {
    // 真实样本：abs-27 换成了 markdown 表格输出
    const v = judgeAnswer(
      abstain('abs-27', [/(EHI|ehi)\s*[：:]?\s*\d{2,3}/, /(EHI|ehi)[^。]{0,30}\d{2,3}\s*[–\-~～]\s*\d{2,3}/]),
      '根据现有参考资料，仅取得：\n\n| 日期 | EHI |\n|---|---:|\n| 1月13日 | 100–130 |',
      [],
    );
    expect(v.pass).toBe(false);
  });

  it('声称资料规定了重试次数 → 判编造', () => {
    const v = judgeAnswer(
      abstain('abs-18', [/(资料|手册|文档|规范)[^。]{0,10}(规定|要求|明确)[^。]{0,10}\d+\s*次/]),
      '手册规定失败后最多重试 3 次。',
      [],
    );
    expect(v.pass).toBe(false);
  });
});

describe('拒答类判定：正确拒答不能被误伤', () => {
  it('明确说未找到，且引用了相邻数据 → 通过', () => {
    // 真实样本：abs-12（曾被「丙区 + 附近任意数字」误判，命中的是括号里的 2024 年）
    const v = judgeAnswer(
      abstain('abs-12', [/丙区[^。]{0,15}\d+(\.\d)?\s*%/]),
      '参考资料中未找到丙区同期（2024年12月30日至2025年1月6日）的达标天数率。文中 **54.8%** 是示例新区的达标天数率，并非丙区数据。',
      hits,
    );
    expect(v.pass).toBe(true);
  });

  it('设备代号里的数字（T2.5）不算编造值', () => {
    // 真实样本：abs-09（曾被「2030 + 附近任意数字」误判，命中的是代号 T2.5 里的 2.5，
    // 还被误当成「模型拿 2025 年数据充数」写进了复盘）
    const v = judgeAnswer(
      abstain('abs-09', [/2030\s*年[^。]{0,10}目标[^。]{0,10}(为|是|达到)?\s*\d+(\.\d)?\s*(℃|A)/]),
      '现有参考资料中**未找到示例新区 2030 年温度目标读数**。资料仅包含 2024 年 12 月 30 日至 2025 年 1 月 6 日的设备运行数据，未载明 2030 年目标值，T2.5 探头亦无记录。',
      hits,
    );
    expect(v.pass).toBe(true);
  });

  it('逐小时数据缺失时的说明 → 通过', () => {
    // 真实样本：abs-22
    const v = judgeAnswer(
      abstain('abs-22', [/小时[^。]{0,10}\d+(\.\d)?\s*(℃|A)/]),
      '参考资料中**未找到**逐小时读数。现有资料仅提供期间温度平均读数 **64.1 ℃**，无法据此推算各小时数值。',
      hits,
    );
    expect(v.pass).toBe(true);
  });

  it('给通用建议但声明「资料未规定」→ 通过', () => {
    // 真实样本：abs-18
    const v = judgeAnswer(
      abstain('abs-18', [/(资料|手册|文档|规范)[^。]{0,10}(规定|要求|明确)[^。]{0,10}\d+\s*次/]),
      '建议最多重试 3 次，并采用指数退避。当前参考资料未规定统一的硬性重试次数，以上为通用实践建议。',
      [],
    );
    expect(v.pass).toBe(true);
  });

  it('「无法计算」也算明确表态（词表曾漏掉）', () => {
    // 真实样本：abs-28
    const v = judgeAnswer(
      abstain('abs-28', [/(失败率|错误率)[^。]{0,10}\d+\s*%/]),
      '根据现有参考资料，**无法计算该接口的历史调用失败率**。资料中仅记录了若干次请求返回 success。',
      [],
    );
    expect(v.pass).toBe(true);
  });

  it('「未取得」也算表态（prompt 教模型这么说，词表必须跟上）', () => {
    // 真实样本：abs-16 —— 回答完全正确，却因为词表缺「未取得」被判「没表态」
    const v = judgeAnswer(
      abstain('abs-16', [/甲区[^。]{0,20}\d+(\.\d)?\s*(℃|A)/]),
      '未取得甲区在同期（2024年12月30日至2025年1月6日）的电流读数。参考资料仅提供了示例新区同期的电流平均读数（35.6 ℃），不能以该数值代替甲区数据。',
      hits,
    );
    expect(v.pass).toBe(true);
  });

  it('「未载明」也算表态（词表曾漏掉这个说法）', () => {
    // 真实样本：abs-09 第二轮 —— 回答正确，却因为词表只有「未提供/未找到」被判「没表态」
    const v = judgeAnswer(
      abstain('abs-09', [/2030\s*年[^。]{0,10}目标[^。]{0,10}(为|是)?\s*\d+(\.\d)?\s*(℃|A)/]),
      '现有参考资料未载明示例新区 2030 年温度目标读数。周报仅提供了 2025 年 1 月 7—13 日的预报及控制目标，无法据此推算 2030 年目标值。',
      hits,
    );
    expect(v.pass).toBe(true);
  });

  it('引用了别人的数字、同时声明「不能用于本区」→ 不算编造', () => {
    // 真实样本：abs-29 —— 正则从「乙区」跨过否定句，抓到了引用的「振动同比上升 54.8%」
    const v = judgeAnswer(
      abstain('abs-29', [/青白江[^。]{0,25}(上升|下降|升高|降低)[^。]{0,8}\d+\s*(%|个百分点)/]),
      '无法判定——参考资料中没有上一周乙区的振动数据。周报给出的是本期读数，乙区为 6 ℃；但全文未提供上一周数值，也没有变化幅度（报告中的"振动同比上升 54.8%"是示例新区整体数据，不能用于乙区）。',
      hits,
    );
    expect(v.pass).toBe(true);
  });

  it('「无法查到 / 未接入」也算表态（措辞兜底，不要求动词精确搭配）', () => {
    // 真实样本：abs-03 —— 词表里只有「无法确定/无法查询」，没有「无法查到」「未接入」
    const v = judgeAnswer(
      abstain('abs-03', []),
      '我目前无法查到你所在公司今年年终奖的发放时间、计算方式和金额，因为当前未接入公司薪酬或 HR 数据源，也不宜凭空估算。建议通过以下途径确认：1. 查阅员工手册 2. 询问 HRBP。',
      hits,
    );
    expect(v.pass).toBe(true);
  });

  it('「无法直接给出」也算表态（词表曾要求「无法」紧跟动词）', () => {
    // 真实样本：abs-05 —— 中间夹了「直接」两个字，判据就不认了
    const v = judgeAnswer(
      abstain('abs-05', []),
      '需要先确认你说的是哪个接口，以及服务商是否提供官方 Java SDK；目前上下文里没有接口名称或文档地址，因此无法直接给出准确的 Maven 坐标。一般来说有三种接入方式。',
      hits,
    );
    expect(v.pass).toBe(true);
  });

  it('既没拒答也没编数值 → 仍然失败（态度不对）', () => {
    const v = judgeAnswer(abstain('x', [/\d+\s*%/]), '这个问题很常见，建议查看官方文档。', []);
    expect(v.pass).toBe(false);
    expect(v.reason).toContain('没有明确表示不知道');
  });
});

describe('hasConcreteNumber（数值兜底判据的边界）', () => {
  it('日期、异常项名、章节号、序号都不算「具体数值」', () => {
    expect(hasConcreteNumber('2025 年 1 月 6 日温度与振动，见 1.2 节，第 1 条')).toBe(false);
  });

  it('真正的度量值算', () => {
    expect(hasConcreteNumber('达标天数率 = 6 ÷ 7 × 100% ≈ 85.7%')).toBe(true);
    expect(hasConcreteNumber('EHI 预报为 100-130')).toBe(true);
  });
});

describe('assertiveText（切掉否定分句，防止正则跨过「我没说」）', () => {
  it('含否定词的分句被替换成句号', () => {
    const t = assertiveText('未提供该数据，无法确定。仅给出示例新区 4.99。');
    expect(t).not.toContain('未提供');
    expect(t).not.toContain('无法确定');
    expect(t).toContain('4.99');
  });

  it('没有否定词时保持原样', () => {
    expect(assertiveText('EHI 为 100-130。')).toBe('EHI 为 100-130。');
  });
});

describe('执行异常单独识别', () => {
  it('空回答报「执行异常」而不是「没表态」', () => {
    const v = judgeAnswer(answer('x', [['1']]), '   ', []);
    expect(v.pass).toBe(false);
    expect(v.reason).toContain('执行异常');
  });
});

describe('认「知识库中没有…」这类措辞（prompt 教的，词表必须同步）', () => {
  // 2026-10-29：route.ts 里加了「资料缺失时不许用常识顶替，直接说明『知识库中没有该信息』」，
  // 模型照做之后，4 条 abstain 用例却判成「没表态」——因为旧的 `没有[^。]{0,10}` 跨不过对象名。
  const cases = [
    '知识库中没有丙区同期（2024年12月30日至2025年1月6日）的达标天数率具体数值。资料仅记载：丙区出现中度异常1天，首要异常项为温度。',
    '知识库中没有“2024 年上半年示例新区达标天数率”的数据。现有资料仅显示：2024 年 12 月 30 日至 2025 年 1 月 6 日达标天数率为 54.8%，不能作为 2024 年上半年的数据。',
    '知识库中没有该接口每天调用次数的记录（资料里只有 token 有效期 1 小时）。',
  ];
  for (const [i, text] of cases.entries()) {
    it(`样本 ${i + 1} 判为已承认不知道`, () => {
      const v = judgeAnswer(abstain('t', []), text, hits);
      expect(v.reason).toBe('正确承认资料中无此信息');
      expect(v.pass).toBe(true);
    });
  }

  it('宽跨度仍然不放过真正的编造（说了不知道但顺手给了数）', () => {
    const g = abstain('t', [/上一?周[^。]{0,12}\d+(\.\d)?\s*(℃|A)/]);
    const v = judgeAnswer(g, '资料里没有上一周的数据，但上一周为 6 ℃。', hits);
    expect(v.pass).toBe(false);
  });
});

describe('澄清句（「与 X 无关」）不算断言', () => {
  // 2026-10-29 夜间跑出来的真实样本：模型正确拒答，还额外说明「综合指数排名 ≠ GDP 排名」，
  // 旧正则 `第 N 位[^。]{0,10}GDP` 跨过逗号抓到「与 GDP 排名无关」，判成编造。
  // 注意：这里必须传 RegExp 字面量。传字符串会让辅助函数的 `.source` 取到 undefined，
  // 而 `new RegExp(undefined)` 是**空模式**（匹配一切），整条用例会毫无理由地判成编造。
  const g = abstain('abs-24', [
    /GDP[^。，]{0,10}第\s*\d+\s*位/,
    /第\s*\d+\s*位[^。，]{0,6}GDP/,
  ]);

  it('拒答并澄清「综合指数排名与 GDP 无关」不算编造', () => {
    const text =
      '知识库中没有全园 22 个区（市、县）的 GDP 数据及排名，因此无法确定示例新区的 GDP 名次。' +
      '现有资料仅显示其**设备综合指数**在全园排名第 11 位，与 GDP 排名无关。';
    const v = judgeAnswer(g, text, hits);
    expect(v.pass).toBe(true);
  });

  it('但真的编了 GDP 名次，照样抓得住', () => {
    const v = judgeAnswer(g, '示例新区的 GDP 在全园排名第 8 位。', hits);
    expect(v.pass).toBe(false);
    expect(v.reason).toContain('编造');
  });

  it('把两个指标混为一谈（说 GDP 就是综合指数排名）也算断言', () => {
    const v = judgeAnswer(g, '示例新区第 11 位，GDP 排名即该值。', hits);
    expect(v.pass).toBe(false);
  });
});

describe('forbidden 的类型防御', () => {
  // 2026-10-29：写用例时误把正则字符串传给「只收 RegExp」的辅助函数，
  // `.source` 取到 undefined，`new RegExp(undefined)` 变成空模式 → 每条回答都被判成编造。
  // 判定器现在会跳过非字符串项，这里锁住这个行为。
  it('forbidden 里混入 undefined 时不会把正常回答判成编造', () => {
    const g = { id: 'x', type: 'abstain' as const, q: 'q', forbidden: [undefined as any, ''] };
    const v = judgeAnswer(g, '知识库中没有该信息。', hits);
    expect(v.pass).toBe(true);
  });
});

describe('字符归一化（看不见的码位差）', () => {
  // 2026-10-29：模型答「温度是 ℃、功耗是 A」（全对），
  // 却被判「缺少关键事实 ℃｜℃」——差的就是上标 ³。
  it('上标数字会被归一成普通数字', () => {
    const v = judgeAnswer(
      answer('ans-x', [['℃', '℃'], ['A', '毫克']]),
      '温度：64.1 ℃；功耗：1 A',
      hits,
    );
    expect(v.pass).toBe(true);
  });

  it('µ(U+00B5) 与 μ(U+03BC) 视作同一个字符', () => {
    const v = judgeAnswer(answer('ans-y', [['μs']]), '读数单位是 µs。', hits);
    expect(v.pass).toBe(true);
  });

  it('下标也归一：振动能匹配振动', () => {
    const v = judgeAnswer(answer('ans-z', [['振动']]), '振动读数为 4.8。', hits);
    expect(v.pass).toBe(true);
  });
});
