import { beforeEach, describe, expect, it, vi } from 'vitest';

const { logAction } = vi.hoisted(() => ({ logAction: vi.fn() }));
vi.mock('@/lib/util', () => ({ logAction }));

import { auditChannelAnswer, recordChannelVerify, verifyChannelAnswer } from '@/lib/agent/channel-verify';

/**
 * 通道适配层的测试重点不是「规则好不好」（那是 runtime-verify.test.ts 的事），
 * 而是**翻译对不对**：同一个校验器，喂进两条形状不同的通道，结论必须一致。
 * 翻译错了不会报错，只会表现为「日志里全是误报」或「该报的永远不报」。
 */
describe('verifyChannelAnswer 通道适配', () => {
  it('技能轨迹（type:tool + tool 字段）能被认成工具调用，不误报能力声明', () => {
    // 技能轨迹的真实形状见 engine.ts 的 TrajectoryStep：{ role, type:'tool', tool, output }
    const r = verifyChannelAnswer({
      answer: '已使用能力：天气查询\n今天晴，18℃。',
      trajectory: [{ type: 'tool', tool: 'invoke_capability', output: '{"ok":true}' }],
    });
    expect(r.issues.some((i) => i.rule === 'ungrounded_capability')).toBe(false);
    expect(r.ok).toBe(true);
  });

  it('对话轨迹（type:tool_call + name 字段）原样通过', () => {
    // chat 通道改成走这里之后，行为必须与原来完全一致
    const r = verifyChannelAnswer({
      answer: '已使用能力：天气查询\n今天晴。',
      sources: ['知识库A'],
      trajectory: [{ type: 'tool_call', name: 'invoke_capability', result: 'ok' }],
    });
    expect(r.issues.some((i) => i.rule === 'ungrounded_capability')).toBe(false);
  });

  it('轨迹里确实没有能力调用时，仍要指出「已使用能力」是空话', () => {
    const r = verifyChannelAnswer({
      answer: '已使用能力：天气查询\n今天晴。',
      trajectory: [{ type: 'llm', output: '随便' }],
    });
    const hit = r.issues.find((i) => i.rule === 'ungrounded_capability');
    expect(hit).toBeTruthy();
    // warn 不阻断：观测层不替业务判死刑
    expect(r.ok).toBe(true);
  });

  it('有工具产出时，列出参考来源不算编造', () => {
    const r = verifyChannelAnswer({
      answer: '结论如下。\n\n---\n\n📚 **参考来源**\n1. 某文档.pdf',
      trajectory: [{ type: 'tool', tool: 'search_knowledge', output: '命中：某文档.pdf 第 3 页' }],
    });
    expect(r.issues.some((i) => i.rule === 'fabricated_source')).toBe(false);
  });

  it('全无工具产出时，列出参考来源就是编造', () => {
    const r = verifyChannelAnswer({
      answer: '结论。\n\n---\n\n📚 **参考来源**\n1. 某文档.pdf',
      trajectory: [],
    });
    expect(r.ok).toBe(false);
    expect(r.issues.some((i) => i.rule === 'fabricated_source')).toBe(true);
  });

  it('sources 传空数组 = 「确实没有来源」，不得回退到轨迹推导', () => {
    // 这是 retrieve() 那个陷阱的翻版：若实现写成 `sources.length ? sources : derive(...)`，
    // 空数组会被当成「没传」，于是「没检索却列了来源」这个本该被抓的情况被悄悄放过。
    const r = verifyChannelAnswer({
      answer: '结论。\n\n---\n\n📚 **参考来源**\n1. 某文档.pdf',
      sources: [],
      trajectory: [{ type: 'tool', tool: 'search_knowledge', output: '某文档.pdf' }],
    });
    expect(r.issues.some((i) => i.rule === 'fabricated_source')).toBe(true);
  });

  it('sources 传 undefined 才回退到工具产出', () => {
    const r = verifyChannelAnswer({
      answer: '结论。\n\n---\n\n📚 **参考来源**\n1. 某文档.pdf',
      trajectory: [{ type: 'tool', tool: 'search_knowledge', output: '某文档.pdf' }],
    });
    expect(r.issues.some((i) => i.rule === 'fabricated_source')).toBe(false);
  });

  it('空产出是 block——定时任务报「完成」但正文为空，正是要抓的情况', () => {
    const r = verifyChannelAnswer({ answer: '   ', trajectory: [] });
    expect(r.ok).toBe(false);
    expect(r.issues[0]?.rule).toBe('empty_answer');
  });
});

describe('recordChannelVerify 记账', () => {
  beforeEach(() => logAction.mockClear());

  it('无问题时完全不写日志（pass 记录会把有效信号淹掉）', () => {
    recordChannelVerify({ userId: 'u1', source: 'skill' }, { ok: true, issues: [], score: 1 });
    expect(logAction).not.toHaveBeenCalled();
  });

  it('有问题时写 eval_runtime，带通道前缀与规则摘要', async () => {
    recordChannelVerify(
      { userId: 'u1', source: 'schedule', label: '周报' },
      { ok: false, issues: [{ rule: 'empty_answer', severity: 'block', detail: '最终回答为空' }], score: 0.6 },
    );
    await vi.waitFor(() => expect(logAction).toHaveBeenCalled());
    const [userId, action, target, meta] = logAction.mock.calls[0];
    expect(userId).toBe('u1');
    expect(action).toBe('eval_runtime');
    expect(target).toBe('fail');
    expect(meta.status).toBe('error');
    // `channel ·` 前缀是与对话通道日志分开聚合的依据
    expect(meta.detail).toContain('channel · schedule/周报');
    expect(meta.detail).toContain('empty_answer');
  });

  it('warn 级问题记 pass_with_warn / status=warn', async () => {
    recordChannelVerify(
      { userId: 'u2', source: 'skill', label: '润色' },
      { ok: true, issues: [{ rule: 'template_placeholder', severity: 'warn', detail: '残留 {{prev}}' }], score: 0.9 },
    );
    await vi.waitFor(() => expect(logAction).toHaveBeenCalled());
    const target = logAction.mock.calls[0][2];
    expect(target).toBe('pass_with_warn');
    expect(logAction.mock.calls[0][3].status).toBe('warn');
  });

  it('auditChannelAnswer 是「体检 + 记账」的合体，不改变返回值', async () => {
    const r = auditChannelAnswer(
      { userId: 'u3', source: 'api' },
      { answer: '', trajectory: [] },
    );
    expect(r.ok).toBe(false);
    await vi.waitFor(() => expect(logAction).toHaveBeenCalled());
  });
});
