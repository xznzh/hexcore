import { describe, expect, it } from 'vitest';
import { runSkillCore, type Step } from '@/lib/agent/engine';
import type { GenerateArgs, StepExecutor } from '@/lib/agent/executor';

/**
 * 编排引擎的回归测试（2026-10-30 新增）。
 *
 * 这个文件能存在，本身就是这一轮改造的目的：
 * 改造前 `engine.ts` 直接 import 了 ai / llm / rag / db / schema / storage / tools / fs 九个模块，
 * 想测编排逻辑就得 mock 九个模块，于是它长期零测试——而同目录的 `verdict.ts`（纯函数）
 * 有 9 条。差别不在重视程度，在**能不能注入依赖**。
 *
 * 现在 engine.ts 只 import 类型和纯函数，本文件因此不加载数据库、不加载模型 SDK、
 * 不读磁盘，跑一次只要几十毫秒。
 *
 * 这里锁的是**编排语义**，不是实现细节：
 *  - 节点类型的判定优先级（tool 字段会隐式把 llm 变成 tool）
 *  - {{input}} / {{prev}} 的替换时机（每一步用「上一步」的产出，不是最终产出）
 *  - condition 不满足时**必须终止**，不能悄悄继续
 *  - human 暂停时**必须**带回 nextIndex，否则续跑会从头开始重跑
 *  - critic 判定不合法时 fail-closed（宁可返工，不可放过）
 */

type Call = { kind: 'generate'; label: string; prompt: string } | { kind: 'tool'; tool: string; arg: string };

/**
 * 假执行器。
 * script 的键：generate 用 label（如 'planner'、'worker-loop2'），tool 用 `tool:<名称>`。
 * 值为字符串数组时按调用次数依次取，用尽后重复最后一项——用来演「先失败后通过」。
 */
function fakeExecutor(script: Record<string, string | string[]> = {}) {
  const calls: Call[] = [];
  const counters: Record<string, number> = {};
  const next = (key: string, fallback: string) => {
    const v = script[key];
    if (v === undefined) return fallback;
    if (!Array.isArray(v)) return v;
    const n = (counters[key] = (counters[key] ?? 0) + 1);
    return v[Math.min(n - 1, v.length - 1)];
  };

  const executor: StepExecutor = {
    resolveModel: async () => ({ name: 'fake-model', instance: {} }),
    generate: async ({ prompt, label }: GenerateArgs) => {
      calls.push({ kind: 'generate', label, prompt });
      return next(label, `<${label}>`);
    },
    runTool: async (tool: string, arg: string) => {
      calls.push({ kind: 'tool', tool, arg });
      return next(`tool:${tool}`, `<tool:${tool}>`);
    },
  };
  return { executor, calls };
}

const labels = (calls: Call[]) => calls.filter((c) => c.kind === 'generate').map((c) => (c as any).label);

describe('lib/agent/engine 编排语义', () => {
  it('无可用模型时明确报错，不是静默返回空串', async () => {
    const { executor } = fakeExecutor();
    executor.resolveModel = async () => null;
    await expect(runSkillCore([{ role: 'worker', prompt: 'x' }], '目标', { executor })).rejects.toThrow(
      /无可用模型/,
    );
  });

  it('首次运行先出 Supervisor 总览，再按步骤执行', async () => {
    const { executor, calls } = fakeExecutor();
    const steps: Step[] = [
      { role: 'planner', prompt: '拆解：{{input}}' },
      { role: 'worker', prompt: '执行' },
    ];
    const r = await runSkillCore(steps, '写一份周报', { executor });

    expect(labels(calls)).toEqual(['supervisor', 'planner', 'worker']);
    expect(r.trajectory[0].role).toBe('supervisor');
    expect(r.result).toBe('<worker>');
  });

  it('续跑（startIndex>0）不再重跑 Supervisor，避免重复计费', async () => {
    const { executor, calls } = fakeExecutor();
    await runSkillCore([{ role: 'planner', prompt: 'a' }, { role: 'worker', prompt: 'b' }], '目标', {
      executor,
      startIndex: 1,
      prevInit: '人工确认前的产出',
    });
    expect(labels(calls)).toEqual(['worker']);
  });

  it('{{input}} 与 {{prev}} 在每一步执行前替换，prev 取「上一步」产出', async () => {
    const { executor, calls } = fakeExecutor({ planner: 'PLAN', worker: 'WORK' });
    await runSkillCore(
      [
        { role: 'planner', prompt: '目标：{{input}}' },
        { role: 'worker', prompt: '依据：{{prev}}' },
      ],
      '统计本月用量',
      { executor },
    );

    const prompts = calls.filter((c) => c.kind === 'generate').map((c) => (c as any).prompt);
    expect(prompts[1]).toContain('统计本月用量');
    // worker 拿到的是 planner 的产出 PLAN，而不是 supervisor 总览或最终结果
    expect(prompts[2]).toContain('PLAN');
    expect(prompts[2]).toContain('依据：');
  });

  it('带 tool 字段的步骤自动判为 tool 类型，产出替换 prev', async () => {
    const { executor, calls } = fakeExecutor({ 'tool:search_knowledge': '片段A' });
    const r = await runSkillCore(
      [
        { role: 'worker', type: 'tool', tool: 'search_knowledge', prompt: '{{input}}' },
        { role: 'worker', prompt: '基于：{{prev}}' },
      ],
      '温度多少',
      { executor },
    );

    const toolCall = calls.find((c) => c.kind === 'tool') as any;
    expect(toolCall.tool).toBe('search_knowledge');
    expect(toolCall.arg).toBe('温度多少');
    expect(r.trajectory.find((t) => t.type === 'tool')?.output).toBe('片段A');
    // 下一步的 {{prev}} 必须是工具产出，否则工具调了等于没调
    const lastPrompt = calls.filter((c) => c.kind === 'generate').pop() as any;
    expect(lastPrompt.prompt).toContain('片段A');
  });

  it('只写 tool 不写 type 也能识别为工具节点', async () => {
    const { executor, calls } = fakeExecutor();
    const r = await runSkillCore([{ role: 'worker', tool: 'sandbox', prompt: 'print(1)' }], 'x', { executor });
    expect(calls.some((c) => c.kind === 'tool')).toBe(true);
    expect(r.trajectory.some((t) => t.type === 'tool')).toBe(true);
  });

  it('condition 满足时继续执行后续步骤', async () => {
    const { executor } = fakeExecutor({ planner: '包含关键词的产出' });
    const r = await runSkillCore(
      [
        { role: 'planner', prompt: 'p' },
        { role: 'worker', type: 'condition', contains: '关键词', prompt: '' },
        { role: 'worker', prompt: '收尾' },
      ],
      'x',
      { executor },
    );
    expect(r.result).toBe('<worker>');
    expect(r.trajectory.find((t) => t.type === 'condition')?.output).toMatch(/条件满足/);
  });

  it('condition 不满足时立刻终止，后续步骤一条都不执行', async () => {
    const { executor, calls } = fakeExecutor();
    const r = await runSkillCore(
      [
        { role: 'planner', prompt: 'p' },
        { role: 'worker', type: 'condition', contains: '不会出现的词', prompt: '' },
        { role: 'worker', prompt: '不该被执行' },
      ],
      '输入里也没有',
      { executor },
    );
    expect(r.trajectory.some((t) => t.type === 'condition')).toBe(true);
    expect(r.trajectory.some((t) => t.prompt === '不该被执行')).toBe(false);
    expect(labels(calls)).not.toContain('不该被执行');
  });

  it('condition 不写 contains 视为恒真（保留默认放行语义）', async () => {
    const { executor } = fakeExecutor();
    const r = await runSkillCore(
      [
        { role: 'planner', prompt: 'p' },
        { role: 'worker', type: 'condition', prompt: '' },
        { role: 'worker', prompt: '继续执行' },
      ],
      'x',
      { executor },
    );
    expect(r.trajectory.some((t) => t.prompt === '继续执行')).toBe(true);
  });

  it('human 节点要求确认时暂停，并带回 nextIndex 与当前 prev', async () => {
    const { executor, calls } = fakeExecutor({ planner: '待确认方案' });
    const r = await runSkillCore(
      [
        { role: 'planner', prompt: 'p' },
        { role: 'worker', type: 'human', requireConfirm: true, prompt: '请确认' },
        { role: 'worker', prompt: '确认后的收尾' },
      ],
      'x',
      { executor },
    );

    expect(r.paused).toBe(true);
    // 暂停发生在第 2 个步骤（索引 1），续跑应从索引 2 开始
    expect(r.nextIndex).toBe(2);
    expect(r.prev).toBe('待确认方案');
    expect(r.trajectory.some((t) => t.prompt === '确认后的收尾')).toBe(false);
    expect(labels(calls)).not.toContain('确认后的收尾');
  });

  it('human 节点不要求确认时自动通过，流程继续', async () => {
    const { executor } = fakeExecutor();
    const r = await runSkillCore(
      [
        { role: 'planner', prompt: 'p' },
        { role: 'worker', type: 'human', prompt: '自动确认点' },
        { role: 'worker', prompt: '收尾' },
      ],
      'x',
      { executor },
    );
    expect(r.paused).toBeUndefined();
    expect(r.trajectory.some((t) => t.type === 'human')).toBe(true);
    expect(r.trajectory.some((t) => t.prompt === '收尾')).toBe(true);
  });

  it('loop 按 times 重复，且每次把上一次结果喂回 {{prev}}', async () => {
    const { executor, calls } = fakeExecutor({ 'worker-loop1': 'v1', 'worker-loop2': 'v2', 'worker-loop3': 'v3' });
    const r = await runSkillCore([{ role: 'worker', type: 'loop', times: 3, prompt: '迭代：{{prev}}' }], 'x', {
      executor,
    });

    expect(labels(calls)).toEqual(['supervisor', 'worker-loop1', 'worker-loop2', 'worker-loop3']);
    const loopPrompts = calls.filter((c) => c.kind === 'generate' && (c as any).label.startsWith('worker-loop'));
    // 第 2 次必须能看到第 1 次的结果，否则「迭代」名不副实
    expect((loopPrompts[1] as any).prompt).toContain('v1');
    expect((loopPrompts[2] as any).prompt).toContain('v2');
    expect(r.result).toBe('v3');
    expect(r.trajectory.filter((t) => t.type === 'loop')).toHaveLength(3);
  });

  it('loop 次数被夹在 1~10，防止误写 times=999 打爆额度', async () => {
    const { executor, calls } = fakeExecutor();
    const r = await runSkillCore([{ role: 'worker', type: 'loop', times: 999, prompt: 'p' }], 'x', { executor });
    expect(r.trajectory.filter((t) => t.type === 'loop')).toHaveLength(10);

    const { executor: e2 } = fakeExecutor();
    const r2 = await runSkillCore([{ role: 'worker', type: 'loop', times: 0, prompt: 'p' }], 'x', { executor: e2 });
    expect(r2.trajectory.filter((t) => t.type === 'loop')).toHaveLength(1);
    expect(labels(calls).length).toBeGreaterThan(0);
  });

  it('critic 判 pass 时不返工', async () => {
    const { executor, calls } = fakeExecutor({
      worker: '产出A',
      critic: '{"verdict":"pass","reason":"合格"}',
    });
    const r = await runSkillCore(
      [
        { role: 'worker', prompt: 'w' },
        { role: 'critic', prompt: 'c' },
      ],
      'x',
      { executor },
    );
    expect(labels(calls)).not.toContain('worker-retry');
    expect(r.result).toBe('{"verdict":"pass","reason":"合格"}');
  });

  it('critic 判 fail 时返工，返工后通过则采用返工产出', async () => {
    const { executor, calls } = fakeExecutor({
      worker: '产出A',
      critic: '{"verdict":"fail","reason":"缺少数据来源"}',
      'worker-retry': '返工后的产出B',
      'critic-retry': '{"verdict":"pass","reason":"合格"}',
    });
    const r = await runSkillCore(
      [
        { role: 'worker', prompt: 'w' },
        { role: 'critic', prompt: 'c' },
      ],
      'x',
      { executor },
    );

    expect(labels(calls)).toContain('worker-retry');
    expect(r.result).toBe('返工后的产出B');
    expect(r.trajectory.some((t) => t.role === 'worker(retry)')).toBe(true);
  });

  it('返工提示要带上 critic 给的具体原因，不能只说「重做一遍」', async () => {
    const { executor, calls } = fakeExecutor({
      worker: 'A',
      critic: '{"verdict":"fail","reason":"缺少数据来源"}',
      'worker-retry': 'B',
      'critic-retry': '{"verdict":"pass","reason":"ok"}',
    });
    await runSkillCore(
      [
        { role: 'worker', prompt: 'w' },
        { role: 'critic', prompt: 'c' },
      ],
      'x',
      { executor },
    );
    const retry = calls.find((c) => c.kind === 'generate' && (c as any).label === 'worker-retry') as any;
    expect(retry.prompt).toContain('缺少数据来源');
  });

  it('critic 输出不是纯 JSON 时先让它重出一次，能修复就采用', async () => {
    const { executor, calls } = fakeExecutor({
      worker: 'A',
      critic: '这个方案可以通过吧',
      'critic-repair': '{"verdict":"pass","reason":"修复后合法"}',
    });
    const r = await runSkillCore(
      [
        { role: 'worker', prompt: 'w' },
        { role: 'critic', prompt: 'c' },
      ],
      'x',
      { executor },
    );
    expect(labels(calls)).toContain('critic-repair');
    expect(labels(calls)).not.toContain('worker-retry');
    expect(r.trajectory.some((t) => t.role === 'critic(invalid)')).toBe(true);
  });

  it('critic 两次都不合法时 fail-closed：按不通过处理并返工，绝不放过', async () => {
    const { executor, calls } = fakeExecutor({
      worker: 'A',
      critic: '我觉得还行',
      'critic-repair': '还是不行',
      'worker-retry': 'B',
      'critic-retry': '{"verdict":"pass","reason":"ok"}',
    });
    const r = await runSkillCore(
      [
        { role: 'worker', prompt: 'w' },
        { role: 'critic', prompt: 'c' },
      ],
      'x',
      { executor },
    );

    // 两次解析失败都要留痕，便于复盘时看清模型到底输出了什么
    const invalid = r.trajectory.filter((t) => t.role === 'critic(invalid)');
    expect(invalid).toHaveLength(2);
    // 无法确认通过 → 必须走返工，这是 fail-closed 的实际体现
    expect(labels(calls)).toContain('worker-retry');
  });

  it('步骤数上限 20：超出部分不执行，防止画布误配无限烧额度', async () => {
    const { executor, calls } = fakeExecutor();
    const steps: Step[] = Array.from({ length: 25 }, (_, i) => ({
      role: 'worker' as const,
      prompt: `步骤${i}`,
    }));
    await runSkillCore(steps, 'x', { executor });
    // supervisor 总览 1 次 + 最多 20 步
    expect(labels(calls).length).toBe(21);
  });

  it('未在中途中断时，正常返回全部轨迹', async () => {
    const { executor } = fakeExecutor();
    const r = await runSkillCore([{ role: 'planner', prompt: 'p' }], 'x', { executor });
    expect(r.paused).toBeUndefined();
    expect(r.trajectory.length).toBeGreaterThan(0);
    expect(r.result).toBeTruthy();
  });
});

/**
 * 观察项（本轮**没有**改，先记录）：
 *
 * `critic` 判 fail 但它是流程第一步（i === 0）时，返工分支不会触发（条件写成 `v.verdict === 'fail' && i > 0`）。
 * 也就是说「第一步就校验失败」会直接带着不合格产出继续往下走。
 * 当时这么写大概是因为「第一步没有可返工的产出」，但实际此时 prev 已是 Supervisor 总览文本，是有东西可改的。
 * 不改成契约、也没有为它写断言——写断言等于把可疑行为固化。
 */
