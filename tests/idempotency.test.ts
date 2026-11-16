import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  idempotencySize,
  makeToolKey,
  persistentEnabled,
  resetIdempotencyForTests,
  withIdempotency,
} from '@/lib/agent/idempotency';

describe('lib/agent/idempotency 工具幂等', () => {
  beforeEach(() => resetIdempotencyForTests());

  it('相同 key 只执行一次，第二次命中缓存', async () => {
    let calls = 0;
    const fn = async () => {
      calls++;
      return 'ok';
    };
    const a = await withIdempotency('k1', fn);
    const b = await withIdempotency('k1', fn);
    expect(calls).toBe(1);
    expect(a.deduped).toBe(false);
    expect(b.deduped).toBe(true);
    expect(b.value).toBe('ok');
  });

  it('不同 key 各自执行', async () => {
    let calls = 0;
    const fn = async () => ++calls;
    await withIdempotency('a', fn);
    await withIdempotency('b', fn);
    expect(calls).toBe(2);
  });

  it('并发同 key 共享同一个 promise，不双写', async () => {
    let calls = 0;
    const fn = async () => {
      calls++;
      await new Promise((r) => setTimeout(r, 10));
      return calls;
    };
    const [x, y] = await Promise.all([withIdempotency('c', fn), withIdempotency('c', fn)]);
    expect(calls).toBe(1);
    expect(x.value).toBe(1);
    expect(y.value).toBe(1);
  });

  it('失败后允许重试（失败不是已完成）', async () => {
    let n = 0;
    const fn = async () => {
      n++;
      if (n === 1) throw new Error('boom');
      return n;
    };
    await expect(withIdempotency('f', fn)).rejects.toThrow('boom');
    const r = await withIdempotency('f', fn);
    expect(r.value).toBe(2);
    expect(r.deduped).toBe(false);
  });

  it('ttl 过期后重新执行', async () => {
    let calls = 0;
    const fn = async () => ++calls;
    await withIdempotency('t', fn, 0);
    const r = await withIdempotency('t', fn, 0);
    expect(calls).toBe(2);
    expect(r.deduped).toBe(false);
  });

  it('makeToolKey 对参数键序不敏感', () => {
    expect(makeToolKey('conv', 'create_todo', { b: 2, a: 1 })).toBe(
      makeToolKey('conv', 'create_todo', { a: 1, b: 2 }),
    );
    expect(makeToolKey('conv', 'create_todo', { a: 1 })).not.toBe(makeToolKey('conv', 'run_skill', { a: 1 }));
  });

  it('完成后条目保留在内存（供后续命中）', async () => {
    await withIdempotency('keep', async () => 1);
    expect(idempotencySize()).toBe(1);
  });
});

describe('persistentEnabled 账本开关', () => {
  const orig = process.env.IDEMPOTENCY_STORE;
  afterEach(() => {
    if (orig === undefined) delete process.env.IDEMPOTENCY_STORE;
    else process.env.IDEMPOTENCY_STORE = orig;
  });

  it('显式 memory 强制关闭（压测 / 无库环境）', () => {
    process.env.IDEMPOTENCY_STORE = 'memory';
    expect(persistentEnabled()).toBe(false);
  });

  it('显式 db 强制开启（CI 里验证落库路径）', () => {
    process.env.IDEMPOTENCY_STORE = 'db';
    expect(persistentEnabled()).toBe(true);
  });

  it('未设置时单测环境走内存，保证常规单测零 I/O', () => {
    delete process.env.IDEMPOTENCY_STORE;
    expect(persistentEnabled()).toBe(process.env.NODE_ENV !== 'test');
  });
});
