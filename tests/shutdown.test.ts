import { describe, it, expect } from 'vitest';
import { shutdown, registerShutdownHooks } from '@/lib/shutdown';

/**
 * 只测「不抛错 + 幂等」这两条契约。
 * 不测各资源是否真被关闭：那需要连真实 PG / Redis，属于 e2e 范畴；
 * 这里要守住的是「关闭流程本身不能把进程搞崩」——它跑在最后一个可能出错的时机。
 */
describe('shutdown', () => {
  it('重复调用只执行一次（幂等，第二次立即返回）', async () => {
    const t0 = Date.now();
    await shutdown('TEST', { exit: false, graceMs: 0 });
    const first = Date.now() - t0;

    const t1 = Date.now();
    await shutdown('TEST', { exit: false, graceMs: 0 });
    const second = Date.now() - t1;

    expect(first).toBeGreaterThanOrEqual(0);
    // 第二次应当直接命中 closing 分支返回，不应再走一遍关闭流程
    expect(second).toBeLessThan(50);
  });

  it('重复注册信号钩子是幂等的，不会堆叠 listener', () => {
    const before = process.listenerCount('SIGTERM');
    registerShutdownHooks();
    registerShutdownHooks();
    const after = process.listenerCount('SIGTERM');
    // 同一进程内多次调用最多只增加 1 个（取决于本文件是否首次注册）
    expect(after - before).toBeLessThanOrEqual(1);
  });
});
