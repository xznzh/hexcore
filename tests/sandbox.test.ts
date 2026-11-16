import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runSandbox } from '@/lib/tools';

/**
 * 沙箱（worker 线程隔离）。
 *
 * 这些用例是**真起 worker** 跑的，不是 mock：要验证的正是隔离本身（能否强杀、strict 是否生效），
 * mock 掉就把被测对象拿走了。单条耗时 20~300ms，整体仍在秒级。
 */
const ENV_KEYS = ['SANDBOX_MODE', 'SANDBOX_TIMEOUT_MS', 'SANDBOX_MEM_MB'] as const;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe('runSandbox（worker 线程）', () => {
  it('执行表达式并通过 result 返回', async () => {
    expect(await runSandbox('result = 1 + 1;')).toBe('2');
  });

  it('console.log 的输出会被收集', async () => {
    expect(await runSandbox("console.log('hello'); console.log('world');")).toBe('hello\nworld');
  });

  it('返回对象时序列化为 JSON', async () => {
    expect(await runSandbox("result = { a: 1, b: 'x' };")).toBe('{"a":1,"b":"x"}');
  });

  it('语法错误返回失败信息，不抛异常', async () => {
    const r = await runSandbox('result = ;;;');
    expect(r).toContain('沙箱执行失败');
  });

  it('同步死循环会被强制终止（这是 worker 隔离的核心价值）', async () => {
    process.env.SANDBOX_TIMEOUT_MS = '300';
    const t0 = Date.now();
    const r = await runSandbox('while (true) {}');
    const cost = Date.now() - t0;
    expect(r).toMatch(/超时|timed out/);
    // 必须真的被掐断：给足调度余量，但不能是「等到 vm 自己超时」的 1s+
    expect(cost).toBeLessThan(3000);
  }, 10_000);

  it("'use strict' 阻断 this.constructor 原型链逃逸", async () => {
    // 逃逸起手式：函数内 this=undefined → 访问 constructor 直接 TypeError
    const r = await runSandbox("result = this.constructor.constructor('return typeof process')();");
    expect(r).toContain('沙箱执行失败');
  });

  it('沙箱内看不到 require / process（受限全局）', async () => {
    const r = await runSandbox('result = typeof require + "/" + typeof process;');
    expect(r).toBe('undefined/undefined');
  });
});

describe('runSandbox 降级路径（SANDBOX_MODE=vm）', () => {
  it('显式关闭 worker 后仍能执行并返回结果', async () => {
    process.env.SANDBOX_MODE = 'vm';
    expect(await runSandbox('result = 40 + 2;')).toBe('42');
  });

  it('降级路径同样拒绝原型链逃逸', async () => {
    process.env.SANDBOX_MODE = 'vm';
    const r = await runSandbox("result = this.constructor.constructor('return typeof process')();");
    expect(r).toContain('沙箱执行失败');
  });
});
