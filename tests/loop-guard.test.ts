import { describe, it, expect, vi } from 'vitest';
import {
  createToolCallGuard,
  argsSignature,
  stableStringify,
  DUPLICATE_NOTICE_PREFIX,
  SATURATED_NOTICE_PREFIX,
} from '../lib/agent/loop-guard';

function tool(execute: (args: any) => any) {
  return {
    description: 'fake',
    parameters: { type: 'object' },
    execute: vi.fn(execute),
  };
}

describe('stableStringify / argsSignature', () => {
  it('键顺序不同但语义相同 → 签名一致（模型重排参数不该绕过防重）', () => {
    expect(argsSignature('t', { a: 1, b: 2 })).toBe(argsSignature('t', { b: 2, a: 1 }));
  });

  it('嵌套对象按键排序', () => {
    expect(stableStringify({ x: { b: 1, a: 2 } })).toBe(stableStringify({ x: { a: 2, b: 1 } }));
  });

  it('值不同 → 签名不同；工具名不同 → 签名不同', () => {
    expect(argsSignature('t', { a: 1 })).not.toBe(argsSignature('t', { a: 2 }));
    expect(argsSignature('t', { a: 1 })).not.toBe(argsSignature('u', { a: 1 }));
  });

  it('循环引用不抛错', () => {
    const a: any = { name: 'x' };
    a.self = a;
    expect(() => stableStringify(a)).not.toThrow();
    expect(stableStringify(a)).toContain('<circular>');
  });
});

describe('createToolCallGuard（V8 · O1）', () => {
  it('相同参数的第二次调用被短路，回放上次结果且不重复执行', async () => {
    const exec = tool(async () => '知识库结果 A');
    const guard = createToolCallGuard();
    const g = guard.wrap({ search_knowledge: exec } as any);

    const r1 = await g.search_knowledge.execute!({ query: '温度' });
    const r2 = await g.search_knowledge.execute!({ query: '温度' });

    expect(r1).toBe('知识库结果 A');
    expect(r2).toContain(DUPLICATE_NOTICE_PREFIX);
    expect(r2).toContain('知识库结果 A');
    expect(exec.execute).toHaveBeenCalledTimes(1);
    expect(guard.stats).toMatchObject({ calls: 2, executed: 1, skipped: 1 });
  });

  it('参数不同则正常执行，不影响合法的多次检索', async () => {
    const exec = tool(async ({ query }: any) => `结果:${query}`);
    const g = createToolCallGuard().wrap({ search_knowledge: exec } as any);
    expect(await g.search_knowledge.execute!({ query: 'a' })).toBe('结果:a');
    expect(await g.search_knowledge.execute!({ query: 'b' })).toBe('结果:b');
    expect(exec.execute).toHaveBeenCalledTimes(2);
  });

  it('失败不计入次数：模型可用同样参数重试（超时场景）', async () => {
    let n = 0;
    const exec = tool(async () => {
      n += 1;
      if (n === 1) throw new Error('timeout');
      return 'ok';
    });
    const g = createToolCallGuard().wrap({ call_connector: exec } as any);
    await expect(g.call_connector.execute!({ name: 'x' })).rejects.toThrow('timeout');
    expect(await g.call_connector.execute!({ name: 'x' })).toBe('ok');
    expect(exec.execute).toHaveBeenCalledTimes(2);
  });

  it('单工具执行次数超上限后被拦截，即使参数各不相同', async () => {
    const exec = tool(async ({ q }: any) => `r:${q}`);
    const guard = createToolCallGuard({ maxSameToolCalls: 3 });
    const g = guard.wrap({ search_knowledge: exec } as any);
    for (const q of ['a', 'b', 'c']) await g.search_knowledge.execute!({ q });
    const r = await g.search_knowledge.execute!({ q: 'd' });
    expect(r).toContain(SATURATED_NOTICE_PREFIX);
    expect(exec.execute).toHaveBeenCalledTimes(3);
    expect(guard.stats.skipped).toBe(1);
  });

  it('不同工具各自独立计数', async () => {
    const a = tool(async () => 'a');
    const b = tool(async () => 'b');
    const g = createToolCallGuard().wrap({ ta: a, tb: b } as any);
    await g.ta.execute!({});
    await g.tb.execute!({}); // 空参数也各自独立，不应被 ta 的记录短路
    expect(b.execute).toHaveBeenCalledTimes(1);
  });

  it('触发短路时回调 onEvent，供上层记审计日志', async () => {
    const seen: string[] = [];
    const g = createToolCallGuard({ onEvent: (e) => seen.push(`${e.type}:${e.tool}`) }).wrap({
      read_file: tool(async () => 'content'),
    } as any);
    await g.read_file.execute!({ id: 'f1' });
    await g.read_file.execute!({ id: 'f1' });
    expect(seen).toEqual(['duplicate:read_file']);
  });

  it('保留原工具的 description / parameters，不破坏给模型的工具定义', () => {
    const g = createToolCallGuard().wrap({ t: tool(async () => 'x') } as any);
    expect(g.t.description).toBe('fake');
    expect(g.t.parameters).toEqual({ type: 'object' });
  });

  it('没有 execute 的工具原样透传，不崩', () => {
    const passthrough: any = { description: 'no-exec', parameters: {} };
    const g = createToolCallGuard().wrap({ p: passthrough } as any);
    expect(g.p).toBe(passthrough);
  });

  it('工具返回对象时签名缓存仍可用（转字符串后回放）', async () => {
    const exec = tool(async () => ({ rows: [1, 2, 3] }));
    const g = createToolCallGuard().wrap({ q: exec } as any);
    const r1 = await g.q.execute!({});
    const r2 = await g.q.execute!({});
    expect(r1).toEqual({ rows: [1, 2, 3] });
    expect(String(r2)).toContain(DUPLICATE_NOTICE_PREFIX);
    expect(String(r2)).toContain('rows');
  });
});
