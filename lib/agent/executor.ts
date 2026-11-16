import { db } from '../db';
import { files, connectors, users } from '../schema';
import { eq } from 'drizzle-orm';
import { retrieve } from '../ai/rag';
import { visibleKbIds } from '../kb-access';
import { resolveSafe } from '../storage';
import { callConnector, runSandbox } from '../tools';
import { resolveModelWithFallback } from '../llm';
import type { UsageSink } from '../llm';
import { callModel } from '../llm-gateway';
import { withTimeout } from '../util';
import { wrapUntrusted } from '../guardrails';
import fs from 'fs/promises';

/**
 * 单次模型调用的超时（V8.3 · R4）。
 *
 * 缺口背景：这里原来只有 `withRetry`（3 次重试、**没有超时**）。上游挂起时
 * `generateText` 会一直 pending，`withRetry` 也就永远等不到可重试的错误——
 * 整条链路不是「慢」，是「静默不动」。技能侧表现为请求永不返回；
 * 调度侧的连锁后果更严重（见 `scheduler.ts` 的租约锁注释）。
 *
 * 为什么不是 120s（与对话通道同值）：技能一步的输入是拼装好的 prompt，
 * 正常 20s 内必有响应；卡到 120s 说明上游已经异常，早点失败让上层出「失败」比干等更有用。
 */
function llmTimeoutMs(): number {
  const n = Number(process.env.SKILL_LLM_TIMEOUT_MS);
  return Number.isFinite(n) && n > 0 ? n : 90_000;
}

/**
 * 含重试的总耗时上限。
 *
 * 只给单次调用设超时不够：`withRetry` 默认重试 3 次，最坏 4 × 90s = 6 分钟，
 * 而 `engine` 的墙钟 120s 只在**调用前**检查——卡在第三次重试里时它永远走不到下一次检查。
 * 这里从外侧再套一层，保证「一次 generate 的整体墙钟」有界。
 */
function llmTotalMs(perCall: number): number {
  const n = Number(process.env.SKILL_LLM_TOTAL_MS);
  return Number.isFinite(n) && n > 0 ? n : perCall * 2;
}

/**
 * 技能编排的「外部能力接口」。
 *
 * 为什么要有这一层：`engine.ts` 原来直接 import 了 9 个模块（ai / llm / rag / db / schema /
 * storage / tools / fs），编排逻辑和 I/O 完全缠在一起。想给编排逻辑写单测，就得 mock 九个模块，
 * 成本高到没人会做——所以它一直零测试，而同目录的 `verdict.ts`（纯函数）有 9 条。
 *
 * 差别只在一点：**能不能注入依赖**。可测性是架构属性，不是测试属性。
 *
 * 这层只收「编排时真正需要的三个能力」，不多不少：
 *  - resolveModel：整个 run 只需要一次
 *  - generate：每一步 LLM 节点调用（含重试与埋点）
 *  - runTool：tool 节点调用（内置工具 / 连接器 / 沙箱）
 *
 * 注意 `ResolvedModel.instance` 故意写成 any：它是 AI SDK 的模型对象，类型会随 SDK 版本变动，
 * 钉死反而制造无谓的升级阻力。真正的类型安全在 `generateText` 调用处。
 */
export type ResolvedModel = { name: string; instance: any };

export type GenerateArgs = {
  model: ResolvedModel;
  /** system prompt（角色设定） */
  system: string;
  prompt: string;
  /** 埋点标签：supervisor / planner / critic-repair / worker-loop1 … */
  label: string;
};

export type StepExecutor = {
  /** 解析可用模型；返回 null 表示当前没有任何可用的 chat 模型 */
  resolveModel(modelId?: string): Promise<ResolvedModel | null>;
  /** 单次文本生成（实现方负责重试与观测埋点） */
  generate(args: GenerateArgs): Promise<string>;
  /** 执行 tool 节点：内置 search_knowledge / read_file / sandbox，或按名称匹配连接器 */
  runTool(tool: string, arg: string, userId: string): Promise<string>;
};

/**
 * 生产实现：唯一允许碰 I/O 的地方。
 * 编排逻辑（engine.ts）不 import 本文件，测试也就不必加载 db / fs / ai。
 */
export function createDefaultExecutor(userId?: string, sink?: UsageSink): StepExecutor {
  /**
   * 技能/调度通道的检索范围（V8.3 · R6）。
   *
   * 缺口：这里原来是 `retrieve(arg, 4)` —— 不传 `kbIds`，而 `rag.ts` 对空数组的处理是
   * **不加任何过滤**，于是「知识库检索」变成**全库检索**：任何用户建一个带 search_knowledge
   * 节点的技能，就能把别人 personal 库里的内容读出来，再随 webhook 推给自己。
   *
   * `lib/kb-access.ts` 的注释写的是「所有入口统一调用」，对话通道确实调了
   * （`chat-tools.ts` 的 search_knowledge 用 `allowedKbIds`），但技能通道漏了。
   *
   * 用 promise 缓存：一次技能执行里通常只有一两个工具节点，但 role/权限不该每次重查；
   * 失败兜底为空数组（宁可检索不到，也不退回全库）。
   */
  let kbScopeP: Promise<string[]> | null = null;
  const kbScope = (uid: string): Promise<string[]> => {
    if (!kbScopeP) {
      kbScopeP = (async () => {
        const u = (await db.select({ role: users.role }).from(users).where(eq(users.id, uid)).limit(1))[0];
        return visibleKbIds(uid, u?.role || 'member');
      })().catch(() => [] as string[]);
    }
    return kbScopeP;
  };

  return {
    resolveModel: (modelId) => resolveModelWithFallback(modelId),

    generate: async ({ model, system, prompt, label }) => {
      const r = await callModel({
        model,
        system,
        prompt,
        label,
        userId,
        sink,
        timeoutMs: llmTimeoutMs(),
        totalMs: llmTotalMs(llmTimeoutMs()),
      });
      return r.text;
    },

    runTool: async (tool, arg, userId) => {
      if (tool === 'search_knowledge') {
        // V8.3 · R6：必须显式限定范围。空数组要在这里拦掉，
        // 不能传给 retrieve —— 那边「空 = 不过滤」会退化成全库检索。
        const allowed = await kbScope(userId);
        if (!allowed.length) return '(当前用户没有可见的知识库)';
        // RAG 检索会触发 embedding API，自身无原生超时，套 15s 兜底防止挂死
        const hits = await withTimeout(retrieve(arg, 4, allowed), 15000, '知识库检索超时');
        if (!hits.length) return '(知识库无相关片段)';
        // V8.3 · R3：检索结果属于外部内容，必须定界后再进 prompt。
        // 对话通道早有这一步（`route.ts` 的 wrapUntrusted），技能通道一直没有——
        // 而技能通道的产出会直接进 webhook 推送，构成「注入可进 + 出门无门」的完整通路。
        const body = hits.map((h) => `[${h.source}] ${h.content}`).join('\n\n');
        return wrapUntrusted(body, 'skill_knowledge_base');
      }
      if (tool === 'read_file') {
        const f = (await db.select().from(files).where(eq(files.filename, arg)).limit(1))[0];
        if (!f) return `(未找到文件: ${arg})`;
        try {
          const buf = await withTimeout(fs.readFile(resolveSafe(f.path)), 5000, '文件读取超时');
          // 同 R3：文件正文是用户可上传的任意内容，等同外部数据
          return wrapUntrusted(buf.toString('utf8').slice(0, 6000), `skill_file:${f.filename}`);
        } catch (e: any) {
          return /超时/.test(String(e?.message || e)) ? '(文件读取超时)' : '(读取文件失败)';
        }
      }
      if (tool === 'sandbox') return runSandbox(arg);

      // 连接器（按名称直查，命中 idx_connectors_name；避免每次工具调用都加载全部连接器）
      const c = (await db.select().from(connectors).where(eq(connectors.name, tool)).limit(1))[0];
      // MCP 工具是「一个连接器 → N 个工具」，技能节点做不到指定具体工具，硬调只会返回工具清单，误导读者。
      // 明确告知而不是返回一段看似结果的东西。
      if (c && c.type === 'mcp') {
        return `(技能节点暂不支持 MCP 连接器「${c.name}」：MCP 工具只在对话链路可用，请改用内置工具或 HTTP 连接器)`;
      }
      if (c) {
        // 三方系统返回同样不可信；超时由 callConnector 自身负责，这里只做定界
        const raw = await callConnector(c, userId, arg);
        return wrapUntrusted(String(raw ?? ''), `skill_connector:${c.name}`);
      }
      return `(未知工具: ${tool})`;
    },
  };
}
