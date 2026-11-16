import { summarizeVerify, verifyAnswer, type VerifyResult } from './runtime-verify';

/**
 * 运行时 V 层的**通道适配层**（V8.6）。
 *
 * 缺口背景：`verifyAnswer` 至今只在 `app/api/chat/route.ts` 一处调用。技能执行
 * （`skills/run` → `engine.ts`）与定时任务（`scheduler.ts`）命中数为 0——而它们和
 * 出口护栏那条缺口是**同一批通道、同一个模式**（v8.3 R2 修的是「拦」，
 * 这里补的是「看」）。无人值守通道尤其需要这一步：产出直接进站内通知与 webhook，
 * 事后没有任何人能回答「这条通知到底靠不靠谱」。
 *
 * ── 为什么需要适配，而不是在调用点直接 `verifyAnswer({ answer })` ──
 *
 * 校验器吃的是 `VerifyInput`：`{ answer, sources, trace }`，其中两条规则的输入
 * 在非对话通道里**形状完全不同**：
 *
 *  1. `ungrounded_capability` 匹配 `trace` 里 `type === 'tool_call' && name`。
 *     技能轨迹是 `{ type: 'tool', tool: 'invoke_capability', output }`——
 *     `type` 不是 `tool_call`，工具名在 `tool` 而不是 `name`。
 *     原样传进去，这条规则会对**每一次**声称「已使用能力」的回答报警：永远误报。
 *
 *  2. `fabricated_source` 依赖 `sources` 非空。对话通道传 `hits.map(h => h.source)`，
 *     技能通道根本没有 hits，只有 tool 节点的产出。
 *
 * 这与 v8.4 的教训是同一件事的第二次出现：**校验器接受什么形状，必须由每个通道翻译一次**。
 * 翻译写两遍，就一定会有一处把 `type: 'tool'` 忘掉，然后误报以「不知道为什么日志全是 warn」
 * 的形式出现。所以翻译只留一份，就在本文件。
 *
 * ── `sources` 的三态（别再犯 `retrieve()` 的老错）──
 *
 *  `undefined` = 通道没给来源信息 → 从 tool 节点推导；
 *  `[]`        = 通道明确表示「本轮没有来源」→ 就用空（此时列出参考来源才是编造）；
 *  非空数组    = 通道给出的来源清单。
 *
 * 若用 `explicit.length ? explicit : derive(...)` 实现，空数组会被当成「没传」，
 * 于是「没检索却列了来源」这个**本该被抓的**情况被悄悄放过。判断必须看 `undefined`，
 * 不能看 `length`——这正是 `retrieve()` 默认值站在错误一侧的同一个陷阱。
 */

/** 轨迹节点的最小交集：技能轨迹（type/tool/output）与对话轨迹（type/name/result） */
export type ChannelTraceNode = {
  type?: string;
  /** 技能轨迹：工具步骤的工具名 */
  tool?: string;
  /** 对话轨迹：工具名 */
  name?: string;
  output?: string;
  result?: string;
};

export type ChannelVerifyInput = {
  /** 最终交付给用户的回答正文（应当是**出口护栏之后**的文本） */
  answer: string;
  /** 通道轨迹；缺省表示这条通道没有工具调用可核对 */
  trajectory?: readonly ChannelTraceNode[];
  /** 显式来源清单；`undefined` 与 `[]` 语义不同，见文件头 */
  sources?: readonly string[];
};

/** 是否算「本轮的工具调用」：两条通道的类型名不同，这里归一 */
function isToolNode(n: ChannelTraceNode): boolean {
  return n?.type === 'tool' || n?.type === 'tool_call';
}

/**
 * 从 tool 节点产出推导来源。
 *
 * 只认 `type === 'tool'`（技能通道的工具步骤）。对话通道若传了 trace 却没给
 * `sources`，这里会返回空——那是**有意**的：对话侧的来源清单只能来自 `hits`，
 * 拿工具返回的正文顶替会让「模型自己编了来源」这类真问题失去检出能力。
 */
function deriveSources(trajectory: readonly ChannelTraceNode[]): string[] {
  return trajectory
    .filter((n) => n?.type === 'tool' && typeof n.output === 'string' && n.output.trim())
    .map((n) => String(n.output).trim().slice(0, 200));
}

/**
 * 把通道自身的产物翻译成 `VerifyInput`，再做确定性体检。
 * 纯函数、零 I/O，可直接单测。
 */
export function verifyChannelAnswer(input: ChannelVerifyInput): VerifyResult {
  const answer = String(input.answer ?? '');
  const trajectory = input.trajectory || [];

  const trace = trajectory.filter(isToolNode).map((n) => ({
    type: 'tool_call',
    name: String(n.tool || n.name || ''),
    result: typeof n.output === 'string' ? n.output.slice(0, 2000) : n.result,
  }));

  const sources =
    input.sources === undefined
      ? deriveSources(trajectory)
      : (input.sources || []).filter(Boolean);

  return verifyAnswer({ answer, sources, trace });
}

export type ChannelVerifyAudit = {
  userId: string;
  /** 与出口护栏同一套通道标识，便于把「拦」和「看」的日志按通道合并统计 */
  source: 'skill' | 'schedule' | 'api';
  label?: string;
};

/**
 * 审计落库（**旁路**，失败静默）。
 *
 * 无问题时不写：这类日志是「发现劣化」用的，pass 记录会把有效信号淹掉
 * （与对话通道 `eval_runtime` 的既有口径一致）。
 *
 * 走动态 import 的原因同 `answer-guard.auditBlock`：本模块要能被单测直接调用，
 * 而 `util.ts` 会拉起数据库连接——为了记一条日志把 DB 依赖传染给纯函数，
 * 会让这个文件再也无法离线测试。
 */
export function recordChannelVerify(audit: ChannelVerifyAudit, result: VerifyResult): void {
  if (!result.issues.length) return;
  const label = audit.source + (audit.label ? '/' + audit.label : '');
  void import('../util')
    .then(({ logAction }) =>
      logAction(audit.userId, 'eval_runtime', result.ok ? 'pass_with_warn' : 'fail', {
        status: result.ok ? 'warn' : 'error',
        // `channel ·` 前缀用于在日志聚合里与对话通道的同名 action 区分
        detail: `channel · ${label} · ${summarizeVerify(result)}`,
      }),
    )
    .catch(() => {});
}

/**
 * 调用点首选：体检 + 落审计，一次完成。
 *
 * 存在的理由与 `finalizeChannel` 同源——把「怎么适配」和「怎么记账」收成一次调用，
 * 调用方就没有机会只做一半（比如只体检不记录，那观测又变成隐形的）。
 *
 * **不做拦截**：V 层是观测层，判错就改写交付物是把风险放大（对话通道同样如此）。
 * 真正决定「发不发出去」的是 `answer-guard` 的出口护栏。
 */
export function auditChannelAnswer(audit: ChannelVerifyAudit, input: ChannelVerifyInput): VerifyResult {
  const result = verifyChannelAnswer(input);
  recordChannelVerify(audit, result);
  return result;
}
