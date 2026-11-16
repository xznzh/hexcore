import { NextResponse } from 'next/server';
import { z } from 'zod';
import { db } from '@/lib/db';
import { models as M } from '@/lib/schema';
import { eq } from 'drizzle-orm';
import { encryptText, hasApiKey } from '@/lib/crypto';
import { newId, logAction } from '@/lib/util';
import { invalidateModelCache } from '@/lib/llm';
import { withApi } from '@/lib/api/handler';

export const dynamic = 'force-dynamic';

const createSchema = z.object({
  provider: z.string().min(1),
  name: z.string().min(1),
  baseUrl: z.string().optional(),
  apiKey: z.string().optional(),
  visibleRoles: z.array(z.enum(['admin', 'member', 'guest'])).default(['admin', 'member']),
  capabilities: z.array(z.enum(['chat', 'tools', 'vision', 'embedding', 'rerank'])).optional(),
  priceIn: z.number().int().min(0).optional(),
  priceOut: z.number().int().min(0).optional(),
});

const patchSchema = z.object({
  id: z.string(),
  isDefault: z.boolean().optional(),
  enabled: z.boolean().optional(),
  // 留空字符串表示清除已保存的 Key
  apiKey: z.string().optional(),
});

export const GET = withApi(
  async () => {
    const rows = await db.select().from(M);
    return NextResponse.json(
      rows.map((m) => ({
        id: m.id,
        provider: m.provider,
        name: m.name,
        baseUrl: m.baseUrl,
        visibleRoles: m.visibleRoles,
        isDefault: m.isDefault,
        enabled: m.enabled,
        capabilities: m.capabilities,
        hasKey: hasApiKey(m.apiKey),
      })),
    );
  },
  { auth: 'admin' },
);

export const POST = withApi(
  async ({ req, session }) => {
    const body = await req.json().catch(() => null);
    const parsed = createSchema.safeParse(body);
    if (!parsed.success) return NextResponse.json({ error: '参数错误' }, { status: 400 });
    const { provider, name, baseUrl, apiKey, visibleRoles, capabilities, priceIn, priceOut } = parsed.data;

    const id = newId('m');
    await db.insert(M).values({
      id,
      provider,
      name,
      baseUrl: baseUrl || null,
      apiKey: apiKey ? encryptText(apiKey) : encryptText(''),
      capabilities: JSON.stringify(capabilities && capabilities.length ? capabilities : ['chat']),
      visibleRoles: JSON.stringify(visibleRoles),
      isDefault: false,
      enabled: true,
      priceIn: priceIn || 0,
      priceOut: priceOut || 0,
      contextLength: 8192,
    });
    await logAction(session.userId, 'admin_create_model', name);
    invalidateModelCache();
    return NextResponse.json({ id, name, provider });
  },
  { auth: 'admin' },
);

export const PATCH = withApi(
  async ({ req, session }) => {
    const body = await req.json().catch(() => null);
    const parsed = patchSchema.safeParse(body);
    if (!parsed.success) return NextResponse.json({ error: '参数错误' }, { status: 400 });

    if (parsed.data.isDefault) {
      // 先清空其他默认
      await db.update(M).set({ isDefault: false });
      await db.update(M).set({ isDefault: true }).where(eq(M.id, parsed.data.id));
    }
    if (typeof parsed.data.enabled === 'boolean') {
      await db.update(M).set({ enabled: parsed.data.enabled }).where(eq(M.id, parsed.data.id));
    }
    if (typeof parsed.data.apiKey === 'string') {
      await db.update(M).set({ apiKey: encryptText(parsed.data.apiKey.trim()) }).where(eq(M.id, parsed.data.id));
    }
    await logAction(session.userId, 'admin_update_model', parsed.data.id);
    invalidateModelCache();
    return NextResponse.json({ ok: true });
  },
  { auth: 'admin' },
);

export const DELETE = withApi(
  async ({ req, session }) => {
    const id = req.nextUrl.searchParams.get('id');
    if (!id) return NextResponse.json({ error: '缺少 id' }, { status: 400 });
    await db.delete(M).where(eq(M.id, id));
    await logAction(session.userId, 'admin_delete_model', id);
    invalidateModelCache();
    return NextResponse.json({ ok: true });
  },
  { auth: 'admin' },
);
