/**
 * 非对话通道的**统一治理出口**（V8.22）。
 *
 * ── 这个文件解决的是「靠记得」而不是「靠结构」──
 *
 * 治理在此之前是三段独立调用，散落在每个通道里：
 *   1. `finalizeChannel`   —— 出口护栏（命中即截断，带通道上下文）
 *   2. `auditChannelAnswer`—— 运行时 V 层（确定性核对：声称用了工具，轨迹里有没有）
 *   3. `judgeChannelAnswer`—— 语义抽查（采样 + 预算，能看出规则抓不到的问题）
 *
 * `app/api/skills/run/route.ts` 装了这三段，`lib/scheduler.ts` 又原样装了第二遍。
 * 现在两条通道都记得装，所以测试是绿的——但**这是靠"记得"**。第三条通道
 * （比如哪天加 `/api/workflows/run`，或开放 webhook 触发技能）漏装的时候，
 * **不会报错**：只是静默地没有审计、没有护栏。而评测抓不到这类退化，
 * 因为评测只跑已有通道。
 *
 * 所以把三段收成一个调用点。顺序不可换，理由写在下面每一步上：
 *  - 护栏必须在审计**之前**：V 层校验的对象是「真正会外发的那份文本」。
 *    放在前面等于对着「已经不会外发」的草稿报警，日志会把护栏的功劳记成模型的过错。
 *  - judge 必须在护栏**之后**：判的同样是外发文本，否则会把已被截掉的片段再判一次，
 *    白白消耗采样额度。
 *
 * 注意这不是「skill 专用」：定时任务的内容来源不止技能（还有直接 prompt 生成），
 * 但外发这件事是一样的。因此门面收在**通道出口**，而 `runSkillGoverned`
 * （见 `index.ts`）是在它之上再包一层「执行 + 治理」的便捷组合。
 */

import { finalizeChannel, toolOutputsOf } from './answer-guard';
import { auditChannelAnswer, type ChannelTraceNode } from './channel-verify';
import { judgeChannelAnswer } from './runtime-judge';

export type { ChannelTraceNode };

export type ChannelGovernInput = {
  userId: string;
  /**
   * 通道标识。只允许 `skill` / `schedule`：
   * `api` 是审计层为「外部 API 调用」预留的，它没有统一的产出文本可以治理。
   */
  source: 'skill' | 'schedule';
  /** 展示名：技能名 / 定时任务名。会进日志与通知标题 */
  label: string;
  /** 触发本次执行的原始指令。决定「就按我说的定」这类越权规则是否生效 */
  question: string;
  /** 本次执行的完整轨迹。既是「有据可引」的来源，也是 V 层的核对依据 */
  trajectory: readonly ChannelTraceNode[];
};

export type ChannelGovernResult = {
  /** 可安全外发的文本（未命中护栏时与原文本一致） */
  text: string;
  blocked: boolean;
  rule?: string;
};

/**
 * 把一段「即将外发」的文本过完三道关。
 *
 * @param text 待外发正文；空串直接原样返回（三段在空文本上都没有意义）
 */
export function governChannelAnswer(text: string, ctx: ChannelGovernInput): ChannelGovernResult {
  const raw = String(text ?? '');

  const guarded = finalizeChannel(raw, {
    userId: ctx.userId,
    source: ctx.source,
    label: ctx.label,
    question: ctx.question,
    toolOutputs: toolOutputsOf(ctx.trajectory),
  });

  const audit = { userId: ctx.userId, source: ctx.source, label: ctx.label };
  auditChannelAnswer(audit, { answer: guarded.text, trajectory: ctx.trajectory });

  /**
   * 语义抽查：fire-and-forget，不 await、也不接本轮请求的 signal——
   * 这条通道没有「客户端断开」的概念（它可能来自定时任务或另一个服务），
   * 判定结果只写日志。是否真的调用由 `RUNTIME_JUDGE` + 采样 + 日预算三层决定，默认关闭。
   */
  void judgeChannelAnswer({
    userId: ctx.userId,
    channel: ctx.source,
    label: ctx.label,
    question: ctx.question,
    answer: guarded.text,
    trace: ctx.trajectory,
  }).catch(() => {});

  return { text: guarded.text, blocked: guarded.blocked, rule: guarded.rule };
}
