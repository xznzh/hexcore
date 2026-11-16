import { describe, expect, it } from 'vitest';
import { canChat } from '@/lib/ai/providers';

/**
 * 「这个模型能不能出现在对话下拉里」的判定。
 *
 * 背景：`/api/models` 原先只按 visibleRoles 过滤，6 个纯 embedding 模型（capabilities=["embedding"]）
 * 因此进了对话框的模型选择器。这里把判定固化下来，避免以后又漏。
 *
 * 特别注意第 3 条：老数据可能没写 capabilities（`[]`）——必须按「可对话」处理，
 * 否则一上线就会把历史模型全藏起来。
 */
describe('lib/ai/providers . canChat', () => {
  it('纯向量 / 重排模型不可对话', () => {
    expect(canChat('["embedding"]')).toBe(false);
    expect(canChat('["rerank"]')).toBe(false);
    expect(canChat('["embedding","rerank"]')).toBe(false);
  });

  it('声明了 chat 的模型可对话（带不带 tools / vision 都行）', () => {
    expect(canChat('["chat"]')).toBe(true);
    expect(canChat('["chat","tools"]')).toBe(true);
    expect(canChat('["chat","tools","vision"]')).toBe(true);
  });

  it('空 / 脏数据按可对话处理（不能把历史模型过滤没了）', () => {
    expect(canChat('[]')).toBe(true);
    expect(canChat('')).toBe(true);
    expect(canChat(null)).toBe(true);
    expect(canChat('not-json')).toBe(true);
  });
});
