import { describe, expect, it } from 'vitest';
import { MemoryRateLimiter } from '@/lib/redis';

describe('MemoryRateLimiter（无 Redis 时的进程内限流）', () => {
  it('额度内放行，超出后拒绝', () => {
    const rl = new MemoryRateLimiter();
    const t = 1_000_000;
    expect(rl.check('u1', 2, 60, t)).toBe(true);
    expect(rl.check('u1', 2, 60, t + 100)).toBe(true);
    expect(rl.check('u1', 2, 60, t + 200)).toBe(false);
  });

  it('窗口滑过后恢复', () => {
    const rl = new MemoryRateLimiter();
    const t = 1_000_000;
    expect(rl.check('u1', 1, 60, t)).toBe(true);
    expect(rl.check('u1', 1, 60, t + 59_000)).toBe(false);
    expect(rl.check('u1', 1, 60, t + 61_000)).toBe(true);
  });

  it('不同 key 互不影响', () => {
    const rl = new MemoryRateLimiter();
    const t = 1_000_000;
    expect(rl.check('chat:u1', 1, 60, t)).toBe(true);
    expect(rl.check('chat:u2', 1, 60, t)).toBe(true);
    expect(rl.check('chat:u1', 1, 60, t)).toBe(false);
    expect(rl.check('gen:u1', 1, 60, t)).toBe(true);
  });

  it('过期 key 会被清理，避免内存无限增长', () => {
    const rl = new MemoryRateLimiter(3);
    const t = 1_000_000;
    for (let i = 0; i < 3; i++) rl.check(`k${i}`, 1, 60, t);
    expect(rl.size).toBe(3);
    // 窗口过去后再触发一次，sweep 清掉旧 key
    rl.check('fresh', 1, 60, t + 61_000);
    expect(rl.size).toBe(1);
  });

  it('非正数窗口按 1 秒处理，不会永久封禁', () => {
    const rl = new MemoryRateLimiter();
    const t = 1_000_000;
    expect(rl.check('u1', 1, 0, t)).toBe(true);
    expect(rl.check('u1', 1, 0, t + 10)).toBe(false);
    expect(rl.check('u1', 1, 0, t + 1_100)).toBe(true);
  });
});
