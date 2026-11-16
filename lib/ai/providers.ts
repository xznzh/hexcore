import { createOpenAI } from '@ai-sdk/openai';
import type { LanguageModel } from 'ai';
import { decryptText } from '../crypto';
import { db } from '../db';
import { models } from '../schema';
import { eq } from 'drizzle-orm';
import { createDemoModel, demoModeFlag, DEMO_MODEL_ID, DEMO_PROVIDER } from './demo';

export type ResolvedModel = {
  instance: LanguageModel;
  id: string;
  name: string;
};

export async function resolveModel(modelId: string): Promise<ResolvedModel | null> {
  const rows = await db.select().from(models).where(eq(models.id, modelId)).limit(1);
  if (!rows.length) return null;
  const m = rows[0];
  if (m.enabled === false) return null; // 已停用的模型不可用
  // 演示模型：不连任何网络，响应由 lib/ai/demo.ts 本地生成
  if (m.provider === DEMO_PROVIDER) {
    return { instance: createDemoModel(), id: m.id, name: m.name };
  }
  const apiKey = m.apiKey ? decryptText(m.apiKey) : process.env.OPENAI_API_KEY || 'no-key';
  const baseURL = m.baseUrl || 'https://api.openai.com/v1';
  const client = createOpenAI({ apiKey, baseURL });
  return { instance: client(m.name), id: m.id, name: m.name };
}

/** 是否具备对话能力（embedding / rerank 等模型不能当聊天模型用） */
export function canChat(capsJson: string | null): boolean {
  try {
    const caps = JSON.parse(capsJson || '[]') as string[];
    // 老数据可能没写 capabilities，按可对话处理，避免直接把模型过滤没了
    return !caps.length || caps.includes('chat');
  } catch {
    return true;
  }
}

/**
 * 「库里是否存在真正可用的对话模型」——判定标准是**能解出非空 API Key**。
 * 只看 enabled 不够：预设模型默认全部 enabled，但没填 Key 时调用必然 401，
 * 那正是最典型的「装完打不开」场景，不能算可用。
 *
 * 结果缓存 30 秒：这个判断每轮对话都要用，但配置变更后又要能较快生效。
 */
let usableCache: { at: number; value: boolean } | null = null;
const USABLE_TTL_MS = 30_000;

async function hasUsableChatModel(): Promise<boolean> {
  const now = Date.now();
  if (usableCache && now - usableCache.at < USABLE_TTL_MS) return usableCache.value;
  let value = false;
  try {
    const rows = await db.select().from(models);
    value = rows.some(
      (m) =>
        m.enabled !== false &&
        m.provider !== DEMO_PROVIDER &&
        canChat(m.capabilities) &&
        !!m.apiKey &&
        decryptText(m.apiKey).length > 0,
    );
  } catch {
    // 库还没就绪时按「没有可用模型」处理，让演示模式接管，避免直接报错
    value = false;
  }
  usableCache = { at: now, value };
  return value;
}

export function invalidateModelCache() {
  usableCache = null;
}

/** 当前是否处于演示模式（供 UI 与接口回显用） */
export async function isDemoActive(): Promise<boolean> {
  const flag = demoModeFlag();
  if (flag !== null) return flag;
  return !(await hasUsableChatModel());
}

export async function resolveDefaultModel(): Promise<ResolvedModel | null> {
  // 强制演示：直接给出演示模型，不再看库里的其它预设（它们多半没有 Key）
  if (demoModeFlag() === true) {
    const demo = await db.select().from(models).where(eq(models.id, DEMO_MODEL_ID)).limit(1);
    return { instance: createDemoModel(), id: DEMO_MODEL_ID, name: demo[0]?.name || 'demo-local' };
  }

  const rows = await db.select().from(models);
  const chatModels = rows.filter((m) => m.enabled !== false && canChat(m.capabilities));

  // 未显式配置 DEMO_MODE 时才自动判定：没有任何可用 Key → 落到演示模型。
  // 顺序很重要——先挑「真的有 Key 的」，挑不到才用演示，避免用户配了真模型却被演示模式顶掉。
  if (demoModeFlag() === null && !(await hasUsableChatModel())) {
    const demo = rows.find((m) => m.id === DEMO_MODEL_ID);
    return { instance: createDemoModel(), id: DEMO_MODEL_ID, name: demo?.name || 'demo-local' };
  }

  const picked = chatModels.find((m) => m.isDefault) || chatModels[0];
  if (picked) return resolveModel(picked.id);
  return null;
}
