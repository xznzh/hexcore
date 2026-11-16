import { describe, expect, it } from 'vitest';
import { kbVisible, type KbLike } from '@/lib/kb-access';

/**
 * 知识库可见性判定（越权修复核心，Bug-001/002/003 落点）的纯函数单测。
 *
 * 背景：此前文档列表 / 上传 / 检索三个入口漏了可见性校验，拿到任意 kbId 即可
 * 读别人个人库、往别人库传文件、用 RAG 把私有内容捞出来（OWASP A01）。
 * `kbVisible` 是唯一口径的纯函数，不碰 DB，本应零成本覆盖——旧测试体系遗漏了它。
 * 这里补齐，作为「访问控制逻辑必须单测」的回归护栏。
 */

const kb = (o: Partial<KbLike>): KbLike => ({
  scope: o.scope ?? 'personal',
  ownerId: o.ownerId ?? null,
  projectId: o.projectId ?? null,
});

describe('kbVisible — 越权修复核心判定', () => {
  it('team 库对任何人可见', () => {
    expect(kbVisible(kb({ scope: 'team' }), 'u_any', 'member', new Set())).toBe(true);
  });

  it('个人库仅 owner 可见（非 owner 不可见）', () => {
    const k = kb({ scope: 'personal', ownerId: 'u_a' });
    expect(kbVisible(k, 'u_a', 'member', new Set())).toBe(true);
    expect(kbVisible(k, 'u_b', 'member', new Set())).toBe(false);
  });

  it('admin 可看任意库（即使非 owner、非团队库）', () => {
    const k = kb({ scope: 'personal', ownerId: 'u_a' });
    expect(kbVisible(k, 'u_admin', 'admin', new Set())).toBe(true);
  });

  it('项目成员可看挂在自己项目下的个人库', () => {
    const k = kb({ scope: 'personal', ownerId: 'u_a', projectId: 'p_1' });
    expect(kbVisible(k, 'u_b', 'member', new Set(['p_1']))).toBe(true);
    expect(kbVisible(k, 'u_b', 'member', new Set(['p_2']))).toBe(false);
  });

  it('kb 为空/假值直接不可见（避免 canAccessKb 误判存在）', () => {
    expect(kbVisible(undefined as unknown as KbLike, 'u_a', 'member', new Set())).toBe(false);
    expect(kbVisible(null as unknown as KbLike, 'u_a', 'member', new Set())).toBe(false);
  });

  it('ownerId 为空串的个人库对非 owner 不可见（防 ownerId 误判）', () => {
    const k = kb({ scope: 'personal', ownerId: '' });
    expect(kbVisible(k, 'u_b', 'member', new Set())).toBe(false);
  });

  it('userId 精确匹配，不可被相似串绕过', () => {
    const k = kb({ scope: 'personal', ownerId: 'u_a' });
    expect(kbVisible(k, 'u_a1', 'member', new Set())).toBe(false);
    expect(kbVisible(k, 'u_a', 'member', new Set())).toBe(true);
  });
});
