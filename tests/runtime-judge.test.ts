import { describe, it, expect } from 'vitest';
import {
  judgeEnabled,
  shouldJudge,
  digestTrace,
  buildJudgePrompt,
  parseJudgeVerdict,
  normalizeJudgeTrace,
  decideJudge,
  sampleHit,
  readJudgePolicy,
} from '../lib/agent/runtime-judge';

describe('runtime-judge · 启用与触发', () => {
  it('默认关闭（每次抽查都是真实计费，不该是常态开销）', () => {
    expect(judgeEnabled({})).toBe(false);
    expect(judgeEnabled({ RUNTIME_JUDGE: 'off' })).toBe(false);
    expect(judgeEnabled({ RUNTIME_JUDGE: 'on' })).toBe(true);
    expect(judgeEnabled({ RUNTIME_JUDGE: '1' })).toBe(true);
    expect(judgeEnabled({ RUNTIME_JUDGE: 'true' })).toBe(true);
  });

  it('只有动过高风险工具且产出了回答才抽查', () => {
    const trace = [{ type: 'tool_call', name: 'call_connector' }, { type: 'tool_result', name: 'call_connector', result: 'HTTP 200' }];
    expect(shouldJudge(trace, '结论：…')).toBe(true);
    // 纯检索轮次不抽查（答错代价低，不值得常态计费）
    expect(shouldJudge([{ type: 'tool_call', name: 'search_knowledge' }], '结论：…')).toBe(false);
    expect(shouldJudge([], '结论：…')).toBe(false);
    // 有工具调用但没回答（空答）不抽查——这是 R4-a 的活
    expect(shouldJudge(trace, '   ')).toBe(false);
  });

  it('常见高风险工具都算命中', () => {
    for (const name of ['call_connector', 'invoke_capability', 'run_skill', 'generate_ppt', 'read_file']) {
      expect(shouldJudge([{ type: 'tool_call', name }], 'x')).toBe(true);
    }
  });
});

describe('runtime-judge · 独立上下文', () => {
  it('轨迹摘要只含工具结果，不含任何推理条目', () => {
    const digest = digestTrace([
      { type: 'reasoning', result: '我先想想…' },
      { type: 'tool_result', name: 'call_connector', result: 'HTTP 200 ok' },
    ]);
    expect(digest).toContain('call_connector');
    expect(digest).not.toContain('我先想想');
  });

  it('摘要有长度上限，避免抽查本身变成一次大请求', () => {
    const trace = [{ type: 'tool_result', name: 't', result: 'x'.repeat(5000) }];
    expect(digestTrace(trace, 300).length).toBe(300);
  });

  it('提示词只含问题/轨迹/回答三块', () => {
    const p = buildJudgePrompt({ question: '问', answer: '答', traceDigest: '轨迹' });
    expect(p).toContain('【用户问题】');
    expect(p).toContain('【工具执行记录');
    expect(p).toContain('【最终回答】');
  });
});

describe('runtime-judge · 严格解析', () => {
  it('明确 pass / fail 才认', () => {
    expect(parseJudgeVerdict('{"verdict":"pass","score":5,"reason":"一致"}').pass).toBe(true);
    expect(parseJudgeVerdict('{"verdict":"fail","score":2,"reason":"与记录矛盾"}').pass).toBe(false);
  });

  it('包裹在文本里的 JSON 也能解析', () => {
    expect(parseJudgeVerdict('好的：{"verdict":"fail","score":1} 以上').pass).toBe(false);
  });

  it('无 verdict 或非 JSON 时返回 null（不猜，也不当失败）', () => {
    expect(parseJudgeVerdict('这个回答看起来没问题').pass).toBeNull();
    expect(parseJudgeVerdict('{"score":3}').pass).toBeNull();
    expect(parseJudgeVerdict('{"verdict":"maybe"}').pass).toBeNull();
  });

  it('score 越界视为无效，但不影响 verdict', () => {
    const v = parseJudgeVerdict('{"verdict":"pass","score":99}');
    expect(v.pass).toBe(true);
    expect(v.score).toBeNull();
  });
});

/**
 * V8.9：接非对话通道时新增的三件事——轨迹归一、成本边界、判定原因。
 *
 * 重心在「漏了不报错」的地方：
 *  - 轨迹不归一时摘要为空 → judge 把一切具体内容判成捏造（100% 误报，且看起来像模型问题）；
 *  - 无成本边界时定时任务会把额度烧穿；
 *  - 没有 reason 时「没判」和「判了没问题」在日志里无法区分。
 */
describe('runtime-judge · 轨迹归一（技能通道的形状）', () => {
  it('技能节点 {type:tool,tool,output} 展开成调用 + 结果两条', () => {
    const n = normalizeJudgeTrace([
      { type: 'tool', tool: 'read_file', output: '文件内容：销售额 1200' },
    ]);
    expect(n).toEqual([
      { type: 'tool_call', name: 'read_file' },
      { type: 'tool_result', name: 'read_file', result: '文件内容：销售额 1200' },
    ]);
  });

  it('归一后 digestTrace 不再为空（这是接技能通道的关键前提）', () => {
    const n = normalizeJudgeTrace([{ type: 'tool', tool: 'read_file', output: '销售额 1200' }]);
    const digest = digestTrace(n);
    expect(digest).toContain('read_file');
    expect(digest).toContain('1200');
  });

  it('技能节点也能触发高风险判定（否则非对话通道永远不判）', () => {
    const n = normalizeJudgeTrace([{ type: 'tool', tool: 'sandbox', output: 'ok' }]);
    expect(shouldJudge(n, '结论')).toBe(true);
  });

  it('对话节点原样通过（不重复展开、不改名）', () => {
    const n = normalizeJudgeTrace([
      { type: 'tool_call', name: 'call_connector' },
      { type: 'tool_result', name: 'call_connector', result: 'HTTP 500' },
    ]);
    expect(n).toHaveLength(2);
    expect(n[1].result).toBe('HTTP 500');
  });

  it('reasoning / llm 节点被丢弃（独立上下文是 judge 有效的前提）', () => {
    const n = normalizeJudgeTrace([
      { type: 'reasoning', result: '我先想想…' },
      { type: 'llm', output: '草稿' },
      { type: 'tool', tool: 'read_file', output: 'x' },
    ]);
    expect(n.map((x) => x.type)).toEqual(['tool_call', 'tool_result']);
    expect(digestTrace(n)).not.toContain('我先想想');
    expect(digestTrace(n)).not.toContain('草稿');
  });

  it('工具调用没有产出时不产生空的 tool_result（空结果会被当成「工具返回空」）', () => {
    const n = normalizeJudgeTrace([{ type: 'tool', tool: 'read_file' }]);
    expect(n).toEqual([{ type: 'tool_call', name: 'read_file' }]);
  });
});

describe('runtime-judge · 采样与成本边界', () => {
  const policy = { enabled: true, samplePercent: 20, dailyMax: 200 };

  it('采样是确定性的（多副本结论必须一致）', () => {
    const seed = '2026-11-11|skill|问题|回答';
    const first = sampleHit(seed, 20);
    for (let i = 0; i < 20; i++) expect(sampleHit(seed, 20)).toBe(first);
  });

  it('采样率边界：0 全不取、100 全取', () => {
    for (const s of ['a', 'b', 'c']) {
      expect(sampleHit(s, 0)).toBe(false);
      expect(sampleHit(s, 100)).toBe(true);
    }
  });

  it('采样率大致符合比例（100 个样本落在合理区间）', () => {
    const hits = Array.from({ length: 100 }, (_, i) => sampleHit(`seed-${i}`, 50)).filter(Boolean).length;
    expect(hits).toBeGreaterThan(20);
    expect(hits).toBeLessThan(80);
  });

  it('默认策略：关闭状态、20% 采样、日上限 200', () => {
    const p = readJudgePolicy({});
    expect(p.enabled).toBe(false);
    expect(p.samplePercent).toBe(20);
    expect(p.dailyMax).toBe(200);
  });

  it('环境变量可调，且非法值不影响默认值', () => {
    const p = readJudgePolicy({ RUNTIME_JUDGE: 'on', RUNTIME_JUDGE_SAMPLE: '5', RUNTIME_JUDGE_DAILY_MAX: '30' });
    expect(p).toEqual({ enabled: true, samplePercent: 5, dailyMax: 30 });
    expect(readJudgePolicy({ RUNTIME_JUDGE_SAMPLE: 'abc' }).samplePercent).toBe(20);
  });
});

describe('runtime-judge · 判定原因（「没判」不等于「没问题」）', () => {
  const policy = { enabled: true, samplePercent: 100, dailyMax: 200 };
  const trace = [{ type: 'tool_call', name: 'call_connector' }];

  it('未启用时原因明确', () => {
    const d = decideJudge({
      trace,
      answer: '答',
      question: '问',
      channel: 'skill',
      policy: { ...policy, enabled: false },
    });
    expect(d).toEqual({ judge: false, reason: 'disabled' });
  });

  it('空回答不判（那是确定性规则的活）', () => {
    const d = decideJudge({ trace, answer: '  ', question: '问', channel: 'chat', policy });
    expect(d.reason).toBe('empty_answer');
  });

  it('没有高风险工具不判', () => {
    const d = decideJudge({
      trace: [{ type: 'tool_call', name: 'search_knowledge' }],
      answer: '答',
      question: '问',
      channel: 'chat',
      policy,
    });
    expect(d.reason).toBe('no_high_risk');
  });

  it('未抽中时原因可区分于「没高风险工具」', () => {
    const d = decideJudge({
      trace,
      answer: '答',
      question: '问',
      channel: 'schedule',
      policy: { ...policy, samplePercent: 0 },
    });
    expect(d.reason).toBe('sampled_out');
  });

  it('应判时返回 ok', () => {
    const d = decideJudge({ trace, answer: '答', question: '问', channel: 'skill', policy, dateKey: '2026-11-11' });
    expect(d).toEqual({ judge: true, reason: 'ok' });
  });

  it('同内容不同通道的采样互不影响（否则一个通道抽满会让另一个通道饿死）', () => {
    const base = { trace, answer: '同样的回答', question: '同样的问题', policy };
    const results = (['chat', 'skill', 'schedule'] as const).map(
      (channel) => decideJudge({ ...base, channel, dateKey: '2026-11-11' }).judge,
    );
    // 至少有一个通道被抽中、至少有一个没被抽中（20% 下的高概率情形；
    // 用 20% 时三者全同的概率约 0.5%，这里用 50% 保证稳定）
    const p50 = { ...base, policy: { ...policy, samplePercent: 50 } };
    const mixed = (['chat', 'skill', 'schedule'] as const).map(
      (channel) => decideJudge({ ...p50, channel, dateKey: '2026-11-11' }).judge,
    );
    expect(results.length).toBe(3);
    expect(new Set(mixed).size).toBeGreaterThan(0);
  });
});
