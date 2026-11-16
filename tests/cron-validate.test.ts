import { describe, expect, it } from 'vitest';
import { isValidCron } from '@/lib/cron';

// 回归护栏：BUG-024
// 非法 cron 曾被放行入库，调度器注册时抛错又被 catch 静默吞掉 → 任务显示「启用」但永不执行。
// 校验前移到写入前，这里锁住「什么算合法」。

describe('isValidCron（定时任务表达式校验）', () => {
  it('标准 5 段 cron 合法', () => {
    expect(isValidCron('0 9 * * *')).toBe(true);
    expect(isValidCron('*/30 * * * *')).toBe(true);
    expect(isValidCron('0 0 1 * *')).toBe(true);
  });

  it('interval:N 形式合法（N 为正整数）', () => {
    expect(isValidCron('interval:30')).toBe(true);
    expect(isValidCron('interval:1')).toBe(true);
  });

  it('段数不足的表达式非法（BUG-024 的复现输入）', () => {
    expect(isValidCron('* * *')).toBe(false);
    expect(isValidCron('0 9 *')).toBe(false);
  });

  it('interval 后不是正整数则非法', () => {
    expect(isValidCron('interval:')).toBe(false);
    expect(isValidCron('interval:abc')).toBe(false);
    expect(isValidCron('interval:0')).toBe(false);
    expect(isValidCron('interval:-5')).toBe(false);
    expect(isValidCron('interval:1.5')).toBe(false);
  });

  it('空值与随意字符串非法', () => {
    expect(isValidCron('')).toBe(false);
    expect(isValidCron('   ')).toBe(false);
    expect(isValidCron('每分钟跑一次')).toBe(false);
  });
});
