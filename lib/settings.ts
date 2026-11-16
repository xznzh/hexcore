import { db } from './db';
import { settings } from './schema';
import { eq } from 'drizzle-orm';

export type RegisterMode = 'open' | 'invite' | 'admin_only';

const DEFAULTS: Record<string, string> = {
  register_mode: 'open',
  brief_enabled: 'on',
};

export async function getSetting(key: string): Promise<string | null> {
  const r = await db.select().from(settings).where(eq(settings.key, key)).limit(1);
  return r[0]?.value ?? DEFAULTS[key] ?? null;
}

export async function setSetting(key: string, value: string): Promise<void> {
  const existing = await db.select().from(settings).where(eq(settings.key, key)).limit(1);
  if (existing.length) await db.update(settings).set({ value }).where(eq(settings.key, key));
  else await db.insert(settings).values({ key, value });
}

export async function getRegisterMode(): Promise<RegisterMode> {
  const v = (await getSetting('register_mode')) || 'open';
  return (['open', 'invite', 'admin_only'].includes(v) ? v : 'open') as RegisterMode;
}

export async function isBriefEnabled(): Promise<boolean> {
  const v = await getSetting('brief_enabled');
  return v !== 'off';
}
