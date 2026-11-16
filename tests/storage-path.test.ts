import path from 'path';
import { describe, expect, it } from 'vitest';
import { DATA_DIR, resolveSafe, safeName, userDir } from '@/lib/storage';

// 回归护栏：Bug-004「路径穿越读取」的修复落点是 resolveSafe。
// 旧写法 `abs.startsWith(DATA_DIR)` 没有分隔符边界，`data/files_evil/x` 会被误判为合法，
// 因此这些用例既验证「拦住越界」，也验证「不能把相邻同前缀目录当自己人」。

describe('resolveSafe（文件路径越界防护）', () => {
  it('普通相对路径解析到 DATA_DIR 之下', () => {
    const abs = resolveSafe('u1/report.pdf');
    expect(abs).toBe(path.join(DATA_DIR, 'u1', 'report.pdf'));
    expect(abs.startsWith(path.resolve(DATA_DIR) + path.sep)).toBe(true);
  });

  it('多级子目录正常放行', () => {
    const abs = resolveSafe('u1/a/b/c.txt');
    expect(abs).toBe(path.join(DATA_DIR, 'u1', 'a', 'b', 'c.txt'));
  });

  it('拒绝 ../ 上跳穿越', () => {
    expect(() => resolveSafe('../secret.txt')).toThrow('非法路径');
  });

  it('拒绝多级 ../ 穿越到系统目录', () => {
    expect(() => resolveSafe('../../../../etc/passwd')).toThrow('非法路径');
  });

  it('同前缀的相邻目录（data/files_evil）必须被拒绝', () => {
    // 这是旧 `startsWith(DATA_DIR)` 写法的真实绕过点：
    // `../files_evil/x` 归一化后为 `<root>/data/files_evil/x`，字符串上以 `<root>/data/files` 开头。
    expect(() => resolveSafe('../files_evil/x')).toThrow('非法路径');
  });

  it('拒绝绝对路径逃逸', () => {
    const outside = process.platform === 'win32' ? 'C:\\Windows\\win.ini' : '/etc/passwd';
    expect(() => resolveSafe(outside)).toThrow('非法路径');
  });

  it('DATA_DIR 本身允许（视为根）', () => {
    expect(resolveSafe('')).toBe(path.resolve(DATA_DIR));
  });

  it('入口经过归一化，形如 u1/../u1 的写法不会逃出根目录', () => {
    const abs = resolveSafe('u1/../u1/ok.txt');
    expect(abs).toBe(path.join(DATA_DIR, 'u1', 'ok.txt'));
  });
});

describe('userDir', () => {
  it('用户目录位于 DATA_DIR 之下', () => {
    expect(userDir('u1')).toBe(path.join(DATA_DIR, 'u1'));
  });
});

describe('safeName（文件名净化）', () => {
  it('替换路径分隔符等非法字符', () => {
    expect(safeName('a/b\\c:d*e?f.txt')).toBe('a_b_c_d_e_f.txt');
  });

  it('保留中文、点、连字符与空格', () => {
    expect(safeName('测试 报告-v1.2.pdf')).toBe('测试 报告-v1.2.pdf');
  });

  it('超长文件名截断到 120 字符', () => {
    expect(safeName('a'.repeat(300))).toHaveLength(120);
  });

  it('空输入回退为 file', () => {
    expect(safeName('')).toBe('file');
  });

  it('全非法字符会被合并成单个下划线（不是 file，属可接受的外观问题）', () => {
    // 记录真实行为：净化正则 `+` 会合并连续非法字符，所以 `|| 'file'` 兜底只对空串生效。
    // 结果为 '_' 不构成安全问题（仍是合法、无穿越能力的安全文件名），仅为可读性瑕疵，P4。
    expect(safeName('///???')).toBe('_');
  });

  it('说明：safeName 不负责拦截 ..，越界由 resolveSafe 兜底', () => {
    // 记录设计边界——不要误以为净化文件名就等于防穿越。
    expect(safeName('..')).toBe('..');
    expect(() => resolveSafe(path.join('u1', safeName('..'), 'x'))).not.toThrow();
    expect(() => resolveSafe(path.join('u1', '..', '..', 'x'))).toThrow('非法路径');
  });
});
