/**
 * V8 · R1-lite：工具策略层（统一超时 / 错误归一化 / 审计 / 结果截断）
 *
 * V8 审计把「工具双轨制」列为最大风险：`registry.ts` 那套注册/审批/审计只服务
 * `capability-tools`，而对话里 13 个内联工具（`chat/route.ts` 直接定义的
 * search_knowledge / read_file / run_skill / generate_ppt / call_connector …）
 * 完全不经过任何统一包装。彻底解决要先把 route 拆开、把工具全迁进 registry，
 * 那是大改动；本文件先用**零侵入包装**把 R1 最要命的三件事补齐：
 *
 *   1. **统一超时**：此前工具 execute 没有任何超时。`call_connector` 打到一个
 *      挂起的上游，会把整轮卡到 stream 的 120s abort 才结束，用户干等；
 *      加了超时后，单个工具失败不再拖垮整轮，模型能拿到「超时」并换个方式答。
 *   2. **错误归一化**：工具抛异常会让 `streamText` 的整条工具链报错，
 *      前端只看到「生成中断」。这里把异常转成**可读文本喂回模型**——
 *      模型知道失败原因，往往能自我修正（换参数/换工具/如实告知用户）。
 *   3. **统一审计**：每次真实执行落一条 `tool_invoke`（工具名/耗时/成败），
 *      补上「工具层没有可观测性」的空白。超时与失败单独标注，便于排障。
 *
 * 与另两层守卫的分工：
 *   - `loop-guard.ts`：单轮内防打转（同参重复调用短路）；
 *   - `idempotency.ts`：跨请求防重复副作用；
 *   - 本文件：单次调用的**执行契约**（多久算超时、失败怎么表达、记什么账）。
 * 三者是不同层，串联使用时本文件应在**最外层**（这样 loop-guard 短路返回不会被
 * 记成一次真实执行，而 loop-guard 内部抛错能被这里捕获成可读文本）。
 */

export type ToolLike = {
  description?: string;
  parameters?: unknown;
  execute?: (args: any, options?: any) => any;
};

/** 默认超时：多数工具是 DB/检索，30s 足够 */
export const DEFAULT_TOOL_TIMEOUT_MS = 30_000;

/**
 * 按工具覆盖超时。依据是各工具的真实耗时量级：
 * 生成文件、跑多步工作流、打外部接口都远慢于一次 SQL。
 */
export const TOOL_TIMEOUT_OVERRIDES: Record<string, number> = {
  search_knowledge: 20_000,
  read_file: 15_000,
  call_connector: 45_000,
  generate_ppt: 90_000,
  run_skill: 120_000,
};

export function timeoutForTool(name: string): number {
  return TOOL_TIMEOUT_OVERRIDES[name] ?? DEFAULT_TOOL_TIMEOUT_MS;
}

/** 工具结果上限：防止超大 JSON（MCP / 连接器）把上下文灌爆 */
export const DEFAULT_MAX_RESULT_CHARS = 16_000;
/** 需要保留下载链接等尾部信息的工具，放宽上限 */
const RESULT_LIMIT_OVERRIDES: Record<string, number> = {
  invoke_capability: 40_000,
  call_connector: 40_000,
};

export class ToolTimeoutError extends Error {
  constructor(name: string, ms: number) {
    super(`工具 ${name} 执行超时（>${Math.round(ms / 1000)}s）`);
    this.name = 'ToolTimeoutError';
  }
}

/**
 * 工具**业务性失败**（权限拒绝、审批中、上游报错…），但 `text` 已经是给模型看的
 * 可读说明。策略层遇到它直接原样返回，不再套一层「工具执行失败：… 报错：…」，
 * 否则模型会读到重复嵌套的告警，反而看不清真实原因。
 */
export class ToolInvocationError extends Error {
  constructor(public readonly text: string) {
    super(text);
    this.name = 'ToolInvocationError';
  }
}

/** 给任意 promise 加超时。定时器 unref，避免拖住进程退出（定时任务/CLI 场景）。 */
export function withTimeout<T>(p: Promise<T> | T, ms: number, name: string): Promise<T> {
  if (!Number.isFinite(ms) || ms <= 0) return Promise.resolve(p);
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new ToolTimeoutError(name, ms));
    }, ms);
    // Node 环境下不阻塞事件循环退出；浏览器/边缘运行时没有 unref，忽略即可
    (timer as any)?.unref?.();
    Promise.resolve(p).then(
      (v) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

/**
 * 截断过长结果：保留头 70% + 尾 30%。
 * 只留头部会丢掉行尾的关键信息（如 artifacts 下载链接、表格最后几行），
 * 只留尾部又会丢掉开头的主结论，所以两头都留。
 */
export function truncateToolResult(text: string, max: number): string {
  if (!text || text.length <= max) return text;
  const head = Math.floor(max * 0.7);
  const tail = max - head;
  return (
    text.slice(0, head) +
    `\n\n…（工具结果过长，已截断 ${text.length - max} 字符；以下为末尾部分）…\n\n` +
    text.slice(-tail)
  );
}

export type ToolAuditEvent = {
  tool: string;
  ok: boolean;
  ms: number;
  /** 返回给模型的字符数（截断后） */
  resultChars: number;
  error?: string;
  timedOut?: boolean;
};

export type ToolPolicyOptions = {
  /** 自定义超时（默认查 TOOL_TIMEOUT_OVERRIDES，再退回 30s） */
  timeoutFor?: (name: string) => number;
  /** 自定义结果上限（默认 16k，能力/连接器类 40k） */
  maxResultChars?: (name: string) => number;
  /** 审计回调：每次真实执行后调用一次，best-effort */
  audit?: (e: ToolAuditEvent) => void;
};

function toText(v: any): string {
  if (typeof v === 'string') return v;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

function errText(e: any): string {
  const raw = e instanceof Error ? e.message : typeof e === 'string' ? e : JSON.stringify(e);
  return String(raw ?? '未知错误').slice(0, 300);
}

/**
 * 包装工具集合，保持 `description` / `parameters` 原样（模型看到的定义不变），
 * 只把 `execute` 换成带超时、错误归一化与审计的版本。
 */
export function withToolPolicy<T extends Record<string, ToolLike>>(tools: T, options: ToolPolicyOptions = {}): T {
  const timeoutOf = options.timeoutFor ?? timeoutForTool;
  const limitOf = options.maxResultChars ?? ((n: string) => RESULT_LIMIT_OVERRIDES[n] ?? DEFAULT_MAX_RESULT_CHARS);
  const out: Record<string, ToolLike> = {};

  for (const [name, tool] of Object.entries(tools || {})) {
    if (!tool || typeof tool.execute !== 'function') {
      out[name] = tool;
      continue;
    }
    const original = tool.execute;
    out[name] = {
      ...tool,
      execute: async (args: any, opts?: any) => {
        const t0 = Date.now();
        try {
          const raw = await withTimeout(Promise.resolve(original(args, opts)), timeoutOf(name), name);
          const text = toText(raw);
          const trimmed = truncateToolResult(text, limitOf(name));
          options.audit?.({ tool: name, ok: true, ms: Date.now() - t0, resultChars: trimmed.length });
          // 若未发生截断且原值就是字符串，原样返回，避免无谓的类型变化
          return trimmed === text ? raw : trimmed;
        } catch (e: any) {
          const timedOut = e instanceof ToolTimeoutError || e?.name === 'ToolTimeoutError';
          // 已是「给模型看的可读说明」，原样返回，避免重复包装
          if (e instanceof ToolInvocationError || e?.name === 'ToolInvocationError') {
            options.audit?.({ tool: name, ok: false, ms: Date.now() - t0, resultChars: 0, error: errText(e) });
            return (e as ToolInvocationError).text;
          }
          const msg = errText(e);
          options.audit?.({ tool: name, ok: false, ms: Date.now() - t0, resultChars: 0, error: msg, timedOut });
          // 不向上抛：工具失败应该是「信息」而不是「事故」。
          // 把原因告诉模型，让它换参数/换工具/如实告知用户，整轮对话得以继续。
          return timedOut
            ? `（工具超时）${name} 执行超过 ${Math.round(timeoutOf(name) / 1000)} 秒仍未返回，已中止等待。` +
                `请不要再重复调用它；如需该信息，请如实告知用户「该操作超时」，或改用其他可用工具。`
            : `（工具执行失败）${name} 报错：${msg}。` +
                `请据此调整：参数是否合法、是否有权限、或改用别的工具；不要原样重试，也不要编造结果。`;
        }
      },
    };
  }

  return out as T;
}
