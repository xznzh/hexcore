/**
 * 非对话通道的**出口护栏**（V8.3 · R2，V8.4 补上下文）。
 *
 * 缺口背景：`output-guard` 的流式机、`verifyAnswer`、输入注入检测，全部只挂在
 * `app/api/chat/route.ts`。技能执行（`executor.ts` → `engine.ts`）与定时任务
 * （`scheduler.ts`）这两条通道命中数为 0 —— 而它们恰恰是**无人值守、直接对外推送**的：
 * 定时任务的产出会进 `createNotification` 与 webhook，用户在收到推送之前没有任何机会拦下。
 *
 * 为什么不能直接复用 chat 的那套：`pushDelta`/`flushGuard` 是**有状态**的，
 * 它的价值是「违规片段根本不出网」（边生成边扣留尾部 128 字符）。技能与调度是
 * 「先生成完整结果、再决定推不推」，没有 delta 可拦，只能做事后判定 + 截断。
 *
 * ── V8.4：从「空 GuardContext」到「真实 GuardContext」──
 *
 * V8.3 这里只有一句 `detectUnsafeAnswer(s)`，注释承认「语境类规则不生效」。问题是这句
 * 括号里还漏了一件事：`allowedCitations` 也是空的，而它属于**无条件规则**的一部分。
 * 后果不是「少拦」，而是**主动误伤**——任何 `《某报告》` 都会被判成未核实引用，
 * 于是「技能检索到了文档、模型照着文档引用」这条最正当的路径，产出被从引用处截断。
 * 换言之：空 context 在这条通道上不是「能力弱一点」，而是**把合规输出也一起掐掉**。
 *
 * 所以这里补 `buildChannelContext()`，两个来源都可从通道自身拿到，不依赖模型判断：
 *  - `allowedCitations` ← **工具节点产出**（检索片段 / 连接器返回 / 文件正文）。
 *    判据是「这个引用名在源材料里真的出现过」，与对话通道用 `hits` 的口径一致。
 *    注意只认 tool 节点，**不认 llm 节点的输出**——模型自己写的引用不构成出处。
 *  - `risk` ← 触发本次执行的原始指令（技能 input / 定时任务 prompt）。定时任务是
 *    无人值守的，用户的原话里出现「就按我说的」「你替我定」同样说明这是越权语境，
 *    不能因为没人坐在屏幕前就把这条规则关掉。
 *
 * 仍然存在的真实差异（不要假装两边等价）：通道没有多轮对话历史，`history` 只在
 * 续跑场景有极短的前序产出，因此 `decisionAuthority` 这类**跨轮延续**的标记会弱于对话侧。
 *
 * ── V8.4：开关不再制造盲区 ──
 *
 * `CHANNEL_GUARD=off` 原来直接 `return`，连检测都不做——文档写的是「只记录不拦截」，
 * 但实现里既没记录也没拦截，等于一个**静默的安全盲区**：线上开了应急开关，
 * 之后再没有任何信号告诉你这条通道正在放行什么。现在改成真正的**观察模式**：
 * 照常判定、照常落审计（detail 前缀 `observe ·`），只是不截断。
 * 这样「应急放行多久、期间有多少命中」是可查的，而不是靠人记得回来关。
 */

import {
  computeRiskContext,
  detectUnsafeAnswer,
  extractCitations,
  guardReplacement,
  type GuardContext,
} from './output-guard';

export type ChannelSource = 'skill' | 'schedule' | 'api';

/** 开关：`CHANNEL_GUARD=off` 切到**观察模式**（只记录、不拦截），仍然可观测 */
export function channelGuardEnabled(): boolean {
  const v = String(process.env.CHANNEL_GUARD ?? '').trim().toLowerCase();
  return !(v === 'off' || v === '0' || v === 'false');
}

export type FinalizeResult = {
  text: string;
  blocked: boolean;
  rule?: string;
  /** 被截掉的原文长度（便于判断是误伤还是真拦） */
  droppedChars?: number;
  /** 观察模式专属：命中了但按开关放行。用于统计误伤率与「应急开关开了多久」 */
  wouldBlock?: boolean;
};

/** 通道执行的上下文来源：全部由调用方从自身数据里拿，不靠模型判断 */
export type ChannelAudit = {
  userId: string;
  source: ChannelSource;
  label?: string;
  /** 触发本次执行的原始指令（技能输入 / 定时任务 prompt），用于计算语境风险 */
  question?: string;
  /** 本次执行中所有 tool 节点的产出，其中的引用名视为「有出处」 */
  toolOutputs?: readonly string[];
  /** 通道自带的历史（技能续跑的前序产出等）；对话通道不走这里 */
  history?: readonly { role: string; content: string }[];
};

/**
 * 从技能轨迹里抽 tool 节点的产出。
 *
 * 为什么单独抽出来：`skills/run` 与 `scheduler` 两处都要做同一件事，
 * 而「哪些节点算源材料」这件事必须只有一种答案——写两遍就会在某一处漏掉
 * `type: 'loop'` 的排除，或者干脆把 llm 输出也算进去（那就成了自证清白）。
 */
export function toolOutputsOf(
  trajectory: readonly { type?: string; output?: string }[] = [],
): string[] {
  return trajectory
    .filter((t) => t?.type === 'tool' && typeof t.output === 'string' && t.output.trim())
    .map((t) => String(t.output));
}

/** 由通道自身数据构建 GuardContext（纯函数，零 I/O，可直接单测） */
export function buildChannelContext(audit: Partial<ChannelAudit> = {}): GuardContext {
  const allowedCitations = Array.from(
    new Set((audit.toolOutputs || []).flatMap((o) => extractCitations(o))),
  );
  const question = String(audit.question || '');
  const history = audit.history || [];
  return {
    ...(allowedCitations.length ? { allowedCitations } : {}),
    // 指令与历史都为空时不必给出全 false 的 risk：等价于「只启用无条件规则」，
    // 少传一个字段，调用方在日志里也能一眼看出「这条通道没有语境信息」。
    ...(question || history.length ? { risk: computeRiskContext(question, history) } : {}),
  };
}

/** 审计落库（旁路，失败不影响主流程） */
function auditBlock(audit: ChannelAudit, rule: string, detail: string, observe: boolean) {
  // 日志走**动态 import**：本模块要在单测里被直接调用，而 `util.ts` 会拉起 db 连接。
  // 为了「记一条审计」把数据库依赖传染给纯函数，会让这个文件再也无法离线测。
  void import('../util')
    .then(({ logAction }) =>
      logAction(audit.userId, 'guardrail_output_block', rule, {
        status: observe ? 'warn' : 'error',
        detail: `${observe ? 'observe · ' : ''}${audit.source}${audit.label ? '/' + audit.label : ''} · ${detail}`,
      }),
    )
    .catch(() => {});
}

/**
 * 出口收口：命中即截断并替换为合规话术。
 *
 * 返回对象而不是直接返回字符串，是为了让调用方既能落库「用户实际收到的文本」，
 * 又能在执行记录里留下「这次被拦了」的事实——只返回 string 的话，拦截就成了隐形的。
 *
 * @param ctx 通道上下文；**生产代码请用 `finalizeChannel` 而不是直接调本函数**，
 *            否则又会退化成「空 context」的老问题（见文件头注释）。
 */
export function finalizeAnswer(
  text: string,
  audit?: ChannelAudit,
  ctx: GuardContext = {},
): FinalizeResult {
  const s = String(text ?? '');
  if (!s.trim()) return { text: s, blocked: false };

  const hit = detectUnsafeAnswer(s, ctx);
  if (!hit) return { text: s, blocked: false };

  const observe = !channelGuardEnabled();
  if (audit) auditBlock(audit, hit.rule, hit.detail, observe);

  // 观察模式：只记不拦。**仍然做检测**——否则开关一开，这条通道就再没有任何信号。
  if (observe) {
    return { text: s, blocked: false, rule: hit.rule, wouldBlock: true, droppedChars: 0 };
  }

  const replacement = guardReplacement(hit.rule, ctx);
  // 截断点前的内容保留：用户已经拿到的有效信息不该因为末尾一句被整段丢弃
  const kept = s.slice(0, hit.index);
  const text2 = kept + replacement;

  return { text: text2, blocked: true, rule: hit.rule, droppedChars: s.length - kept.length };
}

/**
 * **对外通道的唯一出口**（V8.4）：把「上下文构建 + 判定 + 审计」收成一次调用。
 *
 * 存在的理由与 R6 的教训同源——「默认值站在错误一侧时，修调用点只是把复发推给下一个人」。
 * 只要还允许调用方自己拼 context，就一定会有人漏传 `toolOutputs`，
 * 然后同一条误伤以「不知道为什么产出被截断」的形式再次出现。
 *
 * 源码级守卫（`tests/source-guards.test.ts`）会拦住 `app/` 与 `lib/` 里对
 * `finalizeAnswer` 的直接调用，逼着新入口走这里。
 */
export function finalizeChannel(text: string, audit: ChannelAudit): FinalizeResult {
  return finalizeAnswer(text, audit, buildChannelContext(audit));
}

/** 大多数调用点只关心「拿到一份能安全外发的文本」 */
export function safeAnswer(text: string, audit: ChannelAudit): string {
  return finalizeChannel(text, audit).text;
}
