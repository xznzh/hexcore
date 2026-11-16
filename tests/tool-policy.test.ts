import { describe, it, expect, vi } from 'vitest';
import {
  withToolPolicy,
  withTimeout,
  truncateToolResult,
  timeoutForTool,
  ToolTimeoutError,
  DEFAULT_MAX_RESULT_CHARS,
  type ToolAuditEvent,
} from '../lib/tools/policy';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function tool(execute: (args: any) => any) {
  return { description: 'fake', parameters: { type: 'object' }, execute: vi.fn(execute) };
}

describe('timeoutForTool', () => {
  it('慢工具走覆盖表，其余走默认值', () => {
    expect(timeoutForTool('run_skill')).toBe(120_000);
    expect(timeoutForTool('search_knowledge')).toBe(20_000);
    expect(timeoutForTool('list_my_files')).toBe(30_000);
  });
});

describe('withTimeout', () => {
  it('按时返回时正常 resolve', async () => {
    await expect(withTimeout(Promise.resolve('ok'), 1000, 't')).resolves.toBe('ok');
  });

  it('超时抛 ToolTimeoutError，且带上工具名', async () => {
    const p = withTimeout(sleep(200).then(() => 'late'), 20, 'slow_tool');
    await expect(p).rejects.toBeInstanceOf(ToolTimeoutError);
    await expect(p).rejects.toThrow('slow_tool');
  });

  it('超时后原始 promise 的结果被忽略，不产生 unhandledRejection', async () => {
    const p = withTimeout(sleep(50).then(() => 'late'), 10, 't');
    await expect(p).rejects.toBeInstanceOf(ToolTimeoutError);
    await sleep(60); // 等原 promise 落地，若未 swallow 会触发 unhandledRejection
  });
});

describe('truncateToolResult', () => {
  it('短结果原样返回', () => {
    expect(truncateToolResult('abc', 10)).toBe('abc');
  });

  it('长结果同时保留头部与尾部（尾部的链接/末行不能丢）', () => {
    const head = 'A'.repeat(500);
    const tail = '下载链接: https://example.com/f.pptx';
    const out = truncateToolResult(head + tail, 200);
    expect(out.length).toBeLessThan(head.length + tail.length);
    expect(out.startsWith('AAAA')).toBe(true);
    expect(out).toContain('已截断');
    expect(out).toContain(tail);
  });
});

describe('withToolPolicy（V8 · R1-lite）', () => {
  it('成功调用透传结果并记审计', async () => {
    const events: ToolAuditEvent[] = [];
    const g = withToolPolicy({ search_knowledge: tool(async () => '命中 3 段') } as any, {
      audit: (e) => events.push(e),
    });
    expect(await g.search_knowledge.execute!({ query: 'q' })).toBe('命中 3 段');
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ tool: 'search_knowledge', ok: true });
    expect(events[0].resultChars).toBeGreaterThan(0);
  });

  it('工具抛错不向上抛，而是返回可读文本让模型自我修正', async () => {
    const events: ToolAuditEvent[] = [];
    const g = withToolPolicy({ call_connector: tool(async () => { throw new Error('ECONNREFUSED'); }) } as any, {
      audit: (e) => events.push(e),
    });
    const r = await g.call_connector.execute!({ name: 'x' });
    expect(typeof r).toBe('string');
    expect(r).toContain('工具执行失败');
    expect(r).toContain('ECONNREFUSED');
    expect(r).toContain('不要编造结果');
    expect(events[0]).toMatchObject({ ok: false, timedOut: false });
    expect(events[0].error).toContain('ECONNREFUSED');
  });

  it('超时返回明确的超时提示，并标记 timedOut', async () => {
    const events: ToolAuditEvent[] = [];
    const g = withToolPolicy({ run_skill: tool(async () => { await sleep(200); return 'done'; }) } as any, {
      timeoutFor: () => 20,
      audit: (e) => events.push(e),
    });
    const r = await g.run_skill.execute!({});
    expect(r).toContain('工具超时');
    expect(r).toContain('请不要再重复调用');
    expect(events[0]).toMatchObject({ ok: false, timedOut: true });
  });

  it('超长结果被截断（防上下文被灌爆）', async () => {
    const g = withToolPolicy({ call_connector: tool(async () => 'X'.repeat(5000)) } as any, {
      maxResultChars: () => 500,
    });
    const r = (await g.call_connector.execute!({})) as string;
    expect(r.length).toBeLessThan(600);
    expect(r).toContain('已截断');
  });

  it('未截断的字符串原样返回（不做多余的类型转换）', async () => {
    const g = withToolPolicy({ t: tool(async () => 'exact') } as any);
    expect(await g.t.execute!({})).toBe('exact');
  });

  it('对象结果未超限时原样透传（不改变既有工具行为）', async () => {
    const g = withToolPolicy({ t: tool(async () => ({ rows: 2 })) } as any);
    expect(await g.t.execute!({})).toEqual({ rows: 2 });
  });

  it('对象结果超限时转为截断后的 JSON 文本', async () => {
    const g = withToolPolicy({ t: tool(async () => ({ blob: 'Z'.repeat(3000) })) } as any, {
      maxResultChars: () => 200,
    });
    const r = await g.t.execute!({});
    expect(typeof r).toBe('string');
    expect(r).toContain('已截断');
  });

  it('保留给模型的工具定义（description / parameters 不变）', () => {
    const g = withToolPolicy({ t: tool(async () => 'x') } as any);
    expect(g.t.description).toBe('fake');
    expect(g.t.parameters).toEqual({ type: 'object' });
  });

  it('没有 execute 的工具原样透传', () => {
    const passthrough: any = { description: 'no-exec' };
    const g = withToolPolicy({ p: passthrough } as any);
    expect(g.p).toBe(passthrough);
  });

  it('默认上限为 16k，能力/连接器类放宽到 40k', () => {
    expect(DEFAULT_MAX_RESULT_CHARS).toBe(16_000);
    const big = 'Y'.repeat(20_000);
    // 普通工具 16k 截断，invoke_capability 40k 不截断
    const plain = withToolPolicy({ read_file: tool(async () => big) } as any);
    const cap = withToolPolicy({ invoke_capability: tool(async () => big) } as any);
    return Promise.all([plain.read_file.execute!({}), cap.invoke_capability.execute!({})]).then(([a, b]) => {
      expect(String(a)).toContain('已截断');
      expect(String(b)).toBe(big);
    });
  });
});
