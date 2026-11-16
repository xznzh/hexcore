import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { models } from '@/lib/schema';
import { canChat, isDemoActive, modelReady } from '@/lib/ai/providers';
import { DEMO_MODEL_ID } from '@/lib/ai/demo';
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
 *
 * 默认项的真相源在这里，不在前端：演示模式生效时把演示模型标成默认，
 * 前端「取 isDefault」就能落到能用的那个。此前这条规则缺失，前端取到的是种子数据里
 * 排第一的预设模型（没配 Key），一句话都发不出去。
 */
export const GET = withApi(async ({ session }) => {
  const s = session;

  const [rows, demo] = await Promise.all([db.select().from(models), isDemoActive()]);
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
    .map((m) => ({ row: m, isDefault: demo ? m.id === DEMO_MODEL_ID : m.isDefault }))
    .sort((a, b) => {
      if (a.isDefault !== b.isDefault) return a.isDefault ? -1 : 1;
      const byProvider = (a.row.provider || '').localeCompare(b.row.provider || '');
      return byProvider !== 0 ? byProvider : (a.row.name || '').localeCompare(b.row.name || '');
    });

  return NextResponse.json(
    visible.map(({ row: m, isDefault }) => ({
      id: m.id,
      name: m.name,
      provider: m.provider,
      isDefault,
      // 供下拉项提示「未配置 Key」：前端不必再猜，也不该让用户选中一个必然失败的模型
      usable: modelReady(m),
      caps: capsOf(m.capabilities),
      contextLength: m.contextLength || 0,
    })),
  );
});
