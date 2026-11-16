import { runSkillCore, type RunResult, type Step } from './engine';
import { createDefaultExecutor } from './executor';

export type { Step, StepType, RunResult, TrajectoryStep, RunOptions } from './engine';
export type { StepExecutor, GenerateArgs, ResolvedModel } from './executor';
export { runSkillCore };
export { createDefaultExecutor };

/**
 * 技能编排的门面：保留原有位置参数签名，内部注入生产执行器。
 *
 * 为什么分成两个文件：`engine.ts` 不含任何 I/O import，测试可以直接喂假执行器，
 * 不必连带加载 db / fs / ai。而线上调用方要的是一个能直接用的函数——它就是这里。
 *
 * 调用方请统一从 `@/lib/agent` 导入，不要直接引 `engine`，否则又要把执行器拼一遍。
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
