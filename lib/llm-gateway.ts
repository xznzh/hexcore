/**
 * 统一模型调用网关（V8.3 · X1）。
 *
 * 缺口背景：`generateText` 曾在 8 个业务文件里各写一遍，每处自己解决
 * 「超时 / 重试 / 中止 / 埋点」四件事——而这四件事**每一件都曾被漏掉过**：
 *  - `executor.ts` 与 `scheduler.ts` 只有重试、没有超时（上游挂起时永久 pending，
 *    进而导致调度锁不释放、失败通知发不出去）；
 *  - `runtime-judge` 与 `memory` 不接 `req.signal`（用户关页面后照跑照计费）；
 *  - chat 主路径手写埋点，`withObservability` 明明已经存在却没用。
 *
 * 这些不是「某个调用点写得不好」，而是**没有收口点**：只要还有人在业务代码里直接
 * `import { generateText } from 'ai'`，同一个坑就会被重新踩一遍。所以这里提供唯一的
 * 调用入口，把四件事一次性做对，业务侧只描述「用什么模型、问什么」。
 *
 * 刻意保留的两处例外（以及原因）：
 *  - `lib/observability.ts` 自己的摘要调用：它就在埋点链路里，走网关会形成循环依赖；
 *  - chat 主循环的 `streamText`：流式路径的中止/预算由 `abortOnDisconnect` + `turnBudget`
 *    统一编排，形态与非流式完全不同，不硬套同一层。
 */

import { generateText } from 'ai';
import { withRetry, withObservability, resolveModelForTask, type UsageSink } from './llm';
import type { TaskKind } from './agent/model-tiers';
import { withTimeout } from './util';

/**
 * 网关只关心「叫什么、能不能调」，不关心上层用哪个模型结构体。
 *
 * 刻意比 `lib/llm` 的 `ResolvedModel` 更宽松：`agent/executor.ts` 有自己的一份
 * `{ name, instance }`（它要能在单测里注入假模型，不能被数据库层的类型绑架）。
 * 如果这里钉死 `ResolvedModel`，executor 就必须伪造一个 `id` 才能过类型检查——
 * 那是让类型服务于实现，而不是反过来。
 */
export type CallModelTarget = { name: string; instance: any; id?: string };

export type CallModelArgs = {
  model: CallModelTarget;
  /** 埋点标签：summary / synthesize / judge / memory-extract / skill:xxx … */
  label: string;
  /** prompt 与 messages 二选一（AI SDK 两者互斥） */
  prompt?: string;
  system?: string;
  messages?: any[];
  maxTokens?: number;
  /** 归属用户，写进 llm 埋点用于成本归因 */
  userId?: string;
  /** 外部中止源（客户端断连 / 预算超限）。**必须传**——不传就等于放弃可中断性 */
  signal?: AbortSignal;
  /** token 累加槽（技能运行预算用） */
  sink?: UsageSink;
  /** 单次调用超时，默认 90s */
  timeoutMs?: number;
  /** 含重试的总墙钟上限，默认 2×单次 */
  totalMs?: number;
  /** 重试次数，默认 3（与 withRetry 一致） */
  retries?: number;
};

export type CallModelResult = { text: string; usage?: number };

/** 合并外部信号与超时信号（Node 18 没有 AbortSignal.any，自己拼） */
function mergeSignals(a?: AbortSignal, b?: AbortSignal): AbortSignal | undefined {
  if (!a) return b;
  if (!b) return a;
  const ac = new AbortController();
  const on = () => ac.abort();
  if (a.aborted || b.aborted) ac.abort();
  else {
    a.addEventListener('abort', on, { once: true });
    b.addEventListener('abort', on, { once: true });
  }
  return ac.signal;
}

export async function callModel(args: CallModelArgs): Promise<CallModelResult> {
  const perCall = args.timeoutMs && args.timeoutMs > 0 ? args.timeoutMs : 90_000;
  const total = args.totalMs && args.totalMs > 0 ? args.totalMs : perCall * 2;
  // 外部 signal 与「单次超时」合并成一条：前者管「别为没人等的结果付费」，
  // 后者管「上游挂着不动时别无限等」。缺任何一条都会留一个洞。
  const signal = mergeSignals(args.signal, AbortSignal.timeout(perCall));

  const buildParams = () => {
    const base: any = {
      model: args.model.instance,
      abortSignal: signal,
    };
    if (args.system) base.system = args.system;
    if (args.messages) base.messages = args.messages;
    else base.prompt = args.prompt ?? '';
    if (args.maxTokens && args.maxTokens > 0) base.maxTokens = args.maxTokens;
    return base;
  };

  const r: any = await withTimeout(
    withRetry(
      () =>
        withObservability(args.model.name, args.label, () => generateText(buildParams()), {
          userId: args.userId,
          sink: args.sink,
        }),
      args.retries ?? 3,
    ),
    total,
    `模型调用超时（${args.label}，${perCall}ms 内无响应）`,
  );

  const usage = (r as any)?.usage?.totalTokens;
  return {
    text: String(r?.text ?? ''),
    usage: typeof usage === 'number' ? usage : undefined,
  };
}

/**
 * 带降档的调用：先按任务解析便宜档，失败/无档位自动回退主模型。
 *
 * 这一步单独抽出来的原因：`resolveModelForTask` + `callModel` 的组合在
 * 摘要 / 合成 / judge / 记忆抽取四处重复了四遍，每遍都要处理「model 可能为 null」。
 * 放在这里，业务侧只需要说「这是 summary 任务」。
 */
export async function callModelForTask(
  args: CallModelArgs & { task: TaskKind },
): Promise<CallModelResult> {
  const { task, ...rest } = args;
  const primaryId = (args.model as any)?.id;
  const { model } = await resolveModelForTask(task, primaryId);
  return callModel({ ...rest, model: model || args.model });
}
