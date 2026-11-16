import { runSkillCore, type RunResult, type Step } from './engine';
import { createDefaultExecutor } from './executor';
import { governChannelAnswer, type ChannelGovernInput } from './channel-governance';

export type { Step, StepType, RunResult, TrajectoryStep, RunOptions } from './engine';
export type { StepExecutor, GenerateArgs, ResolvedModel } from './executor';
export type { ChannelGovernInput, ChannelGovernResult, ChannelTraceNode } from './channel-governance';
export { runSkillCore };
export { createDefaultExecutor };
export { governChannelAnswer };

/**
 * 技能编排的门面：保留原有位置参数签名，内部注入生产执行器。
 *
 * 为什么分成两个文件：`engine.ts` 不含任何 I/O import，测试可以直接喂假执行器，
 * 不必连带加载 db / fs / ai。而线上调用方要的是一个能直接用的函数——它就是这里。
 *
 * 调用方请统一从 `@/lib/agent` 导入，不要直接引 `engine`，否则又要把执行器拼一遍。
 *
 * **例外说明（V8.22）**：技能结果是要外发的，所以「运行」与「治理」不该分成两步
 * 让每个调用方自己接。新代码请用 `runSkillGoverned`；只有在需要自行组织通道出口时
 * （如 `lib/scheduler.ts`：它的产出还可能来自直接 prompt 生成，必须统一过一次护栏）
 * 才用裸 `runSkill` 再调 `governChannelAnswer`。
 * `tests/governance-coverage.test.ts` 会检查这条约定。
 */
export async function runSkill(
  steps: Step[],
  input: string,
  modelId?: string,
  userId?: string,
  startIndex = 0,
  prevInit = '',
  opts?: { maxWallClockMs?: number; maxTokens?: number },
): Promise<RunResult> {
  // token 累加槽：executor（每次 LLM 调用后累计）与 engine（每步后查预算）共享同一个对象，
  // 实现「运行中实时预算」而无需 engine 直接碰数据库（保持纯函数可测）。
  let used = 0;
  const sink = { add: (n: number) => { used += n; }, total: () => used };
  return runSkillCore(steps, input, {
    modelId,
    userId,
    startIndex,
    prevInit,
    executor: createDefaultExecutor(userId, sink),
    maxWallClockMs: opts?.maxWallClockMs ?? 120_000,
    maxTokens: opts?.maxTokens ?? 0,
    usageSink: sink,
  });
}

export type GovernedRunOptions = {
  modelId?: string;
  /** 归属用户：既用于执行器记账，也用于治理日志 */
  userId: string;
  /** 通道标识，与 `ChannelGovernInput` 同义 */
  source: ChannelGovernInput['source'];
  /** 展示名（技能名 / 任务名） */
  label: string;
  /** 触发本次运行的原始指令；不传时用 `input`（两者通常相同，续跑时才有区别） */
  question?: string;
  startIndex?: number;
  prevInit?: string;
  maxWallClockMs?: number;
  maxTokens?: number;
};

export type GovernedRunResult = RunResult & {
  /** 过完护栏的正文。**落库与对外发送都应该用这个，而不是 `result`** */
  text: string;
  guard: { blocked: boolean; rule?: string };
};

/**
 * 「运行 + 治理」的默认入口（V8.22）。
 *
 * 为什么把这两步合成一个函数：拆开时，治理是调用方的义务，而义务会被漏——
 * 漏了不报错，只是静默地没有审计、没有护栏。合成之后，「拿到技能产出」
 * 与「产出自带治理」是同一件事，新通道想漏都漏不掉。
 *
 * `guard.blocked` 必须显式消费（前端提示 / 通知标题 / 运行记录），
 * 否则拦截就是隐形的——用户会把截断当成模型能力问题。
 */
export async function runSkillGoverned(
  steps: Step[],
  input: string,
  opts: GovernedRunOptions,
): Promise<GovernedRunResult> {
  const r = await runSkill(steps, input, opts.modelId, opts.userId, opts.startIndex, opts.prevInit, {
    maxWallClockMs: opts.maxWallClockMs,
    maxTokens: opts.maxTokens,
  });
  const governed = governChannelAnswer(r.result || '', {
    userId: opts.userId,
    source: opts.source,
    label: opts.label,
    question: opts.question ?? input,
    trajectory: r.trajectory,
  });
  return { ...r, text: governed.text, guard: { blocked: governed.blocked, rule: governed.rule } };
}
