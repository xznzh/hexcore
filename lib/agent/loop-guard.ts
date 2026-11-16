import { createHash } from 'crypto';

/**
 * V8 · O1：工具调用防打转（运行时程序化拦截）
 *
 * 背景：`chat/route.ts` 里靠 `TOOL_DISCIPLINE` 提示词约束模型「不要反复检索」，
 * 但这是**软约束**——思考型模型仍会把 maxSteps 耗在同一批调用上，最后要么没正文、
 * 要么用户白等几十秒。V8 审计把它列为「E 层：原地打转无程序化检测」。
 *
 * 由于本项目用的是 ai@4（没有 v5 的 `prepareStep` 钩子），无法在循环中途改
 * toolChoice，因此把拦截点放在**工具执行层**：统一包一层 wrapper，
 * 对「完全相同的调用」与「单工具调用次数超限」直接短路返回上次结果 + 明确指令，
 * 让模型下一步只能出正文。收益：省掉重复检索的网络开销与重复结果注入的 token。
 *
 * 与 R3（lib/agent/idempotency.ts）的分工：
 *   - R3 是**跨请求**幂等，防重复副作用（重复建待办、重复跑工作流、重复扣额度）；
 *   - 本文件是**单轮内**防打转，防同一请求内的重复执行与步数浪费。
 */

export type ToolLike = {
  description?: string;
  parameters?: unknown;
  execute?: (args: any, options?: any) => any;
};

export type LoopGuardEvent = {
  type: 'duplicate' | 'saturated';
  tool: string;
  /** 触发时的调用序号（第几次） */
  count: number;
};

export type LoopGuardOptions = {
  /** 同一 (工具 + 参数) 允许真正执行的次数，默认 1：成功执行过一次后，相同调用直接短路 */
  maxIdenticalCalls?: number;
  /** 同一工具在一轮内的执行次数上限，默认 4 */
  maxSameToolCalls?: number;
  /** 触发短路时的回调，供上层落审计日志 */
  onEvent?: (e: LoopGuardEvent) => void;
};

export type LoopGuardStats = {
  /** 模型发起的工具调用总次数 */
  calls: number;
  /** 真正执行了的次数 */
  executed: number;
  /** 被短路的次数 */
  skipped: number;
};

/** 稳定序列化：键排序 + 深层截断，保证同样参数得到同样签名 */
export function stableStringify(value: unknown, maxLen = 4000): string {
  const seen = new WeakSet<object>();
  const walk = (v: any): any => {
    if (v === null || typeof v !== 'object') {
      if (typeof v === 'string') return v.length > maxLen ? v.slice(0, maxLen) : v;
      if (typeof v === 'bigint') return String(v);
      return v;
    }
    if (seen.has(v)) return '<circular>';
    seen.add(v);
    if (Array.isArray(v)) return v.map(walk);
    const out: Record<string, any> = {};
    for (const k of Object.keys(v).sort()) out[k] = walk(v[k]);
    return out;
  };
  try {
    return JSON.stringify(walk(value));
  } catch {
    return String(value);
  }
}

/** 调用签名：工具名 + 参数哈希 */
export function argsSignature(name: string, args: unknown): string {
  const h = createHash('sha1').update(stableStringify(args ?? {})).digest('hex').slice(0, 16);
  return `${name}#${h}`;
}

export const DUPLICATE_NOTICE_PREFIX = '（防重复调用）';
export const SATURATED_NOTICE_PREFIX = '（防打转）';

/**
 * 创建一轮对话内生效的工具调用守卫。返回的 `wrap` 保持原工具形状（含 description/parameters），
 * 仅替换 execute，因此可直接交给 streamText 使用。
 */
export function createToolCallGuard(options: LoopGuardOptions = {}) {
  const maxIdentical = Math.max(1, options.maxIdenticalCalls ?? 1);
  const maxSameTool = Math.max(1, options.maxSameToolCalls ?? 4);
  const stats: LoopGuardStats = { calls: 0, executed: 0, skipped: 0 };
  const identical = new Map<string, { count: number; last: string }>();
  const perTool = new Map<string, number>();

  function wrap<T extends Record<string, ToolLike>>(tools: T): T {
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
          stats.calls += 1;
          const sig = argsSignature(name, args);
          const prev = identical.get(sig);
          const prevCount = prev?.count ?? 0;

          // 1) 完全相同的调用：直接回放上次结果 + 强指令，不再执行
          if (prev && prevCount >= maxIdentical) {
            stats.skipped += 1;
            options.onEvent?.({ type: 'duplicate', tool: name, count: prevCount + 1 });
            return (
              `${DUPLICATE_NOTICE_PREFIX}本轮已经用完全相同的参数调用过 ${name}，本次不再重复执行。` +
              `上一次的结果如下，请直接基于它作答，不要再调用该工具：\n${prev.last}`
            );
          }

          // 2) 单工具调用次数超限：连参数不同的调用也拦，逼模型出正文
          const total = perTool.get(name) ?? 0;
          if (total >= maxSameTool) {
            stats.skipped += 1;
            options.onEvent?.({ type: 'saturated', tool: name, count: total + 1 });
            return (
              `${SATURATED_NOTICE_PREFIX}本轮 ${name} 已被执行 ${total} 次，达到上限。` +
              `请立即停止调用工具，直接基于上面已获得的结果给出最终回答；若信息确实不足，请明确说明缺少什么。`
            );
          }

          const result = await original(args, opts);
          // 只有成功执行才计数：失败（超时/上游报错）不应阻止模型换个方式重试
          perTool.set(name, total + 1);
          stats.executed += 1;
          const text = typeof result === 'string' ? result : stableStringify(result);
          identical.set(sig, { count: prevCount + 1, last: text.slice(0, 3000) });
          return result;
        },
      };
    }
    return out as T;
  }

  return { wrap, stats };
}
