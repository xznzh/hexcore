import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { models } from '@/lib/schema';
import { canChat } from '@/lib/ai/providers';
import { withApi } from '@/lib/api/handler';

export const dynamic = 'force-dynamic';

function capsOf(raw: string | null): string[] {
  try {
    const v = JSON.parse(raw || '[]');
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return [];
  }
}

/**
 * 「可选对话模型」列表（对话输入区 / 文档生成 / PPT 生成共用）。
 *
 * 过滤三件事，缺一个都会让用户在下拉里选到用不了或不该出现的模型：
 *  1. `enabled === false` —— 停用的模型选了也白选（服务端会静默降级到默认模型，用户以为换成功了）；
 *  2. 对话能力 —— embedding / rerank 模型不能聊天（此前它们会出现在对话框的模型下拉里）；
 *  3. `visibleRoles` —— 角色可见性。
 *
 * 排序：默认模型置顶，其余按厂商 + 名称，保证下拉顺序稳定、不随建表顺序抖动。
 */
export const GET = withApi(async ({ session }) => {
  const s = session;

  const rows = await db.select().from(models);
  const visible = rows
    .filter((m) => {
      if (m.enabled === false) return false;
      if (!canChat(m.capabilities)) return false;
      try {
        return (JSON.parse(m.visibleRoles || '[]') as string[]).includes(s.role);
      } catch {
        return true;
      }
    })
    .sort((a, b) => {
      if (a.isDefault !== b.isDefault) return a.isDefault ? -1 : 1;
      const byProvider = (a.provider || '').localeCompare(b.provider || '');
      return byProvider !== 0 ? byProvider : (a.name || '').localeCompare(b.name || '');
    });

  return NextResponse.json(
    visible.map((m) => ({
      id: m.id,
      name: m.name,
      provider: m.provider,
      isDefault: m.isDefault,
      caps: capsOf(m.capabilities),
      contextLength: m.contextLength || 0,
    })),
  );
});
