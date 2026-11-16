import { NextResponse } from 'next/server';
import { getSetting, setSetting, getRegisterMode } from '@/lib/settings';
import { logAction } from '@/lib/util';
import { withApi } from '@/lib/api/handler';

export const dynamic = 'force-dynamic';

export const GET = withApi(
  async () => {
    return NextResponse.json({
      registerMode: await getRegisterMode(),
      briefEnabled: (await getSetting('brief_enabled')) !== 'off',
    });
  },
  { auth: 'admin' },
);

export const PATCH = withApi(
  async ({ req, session }) => {
    const body = await req.json().catch(() => ({}));
    // 可同时更新注册方式 / 今日简报开关
    if (body?.registerMode !== undefined) {
      const mode = body.registerMode;
      if (!['open', 'invite', 'admin_only'].includes(mode)) {
        return NextResponse.json({ error: '无效的注册方式' }, { status: 400 });
      }
      await setSetting('register_mode', mode);
      await logAction(session.userId, 'admin_set_register_mode', mode);
    }
    if (body?.briefEnabled !== undefined) {
      await setSetting('brief_enabled', body.briefEnabled ? 'on' : 'off');
      await logAction(session.userId, 'admin_set_brief_enabled', body.briefEnabled ? 'on' : 'off');
    }
    return NextResponse.json({
      ok: true,
      registerMode: await getSetting('register_mode'),
      briefEnabled: (await getSetting('brief_enabled')) !== 'off',
    });
  },
  { auth: 'admin' },
);
