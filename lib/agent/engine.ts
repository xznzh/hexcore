import type { ResolvedModel, StepExecutor, GenerateArgs } from './executor';
import { parseVerdictStrict, verdictRepairPrompt, type Verdict } from './verdict';
import { UNTRUSTED_DATA_NOTE } from '../guardrails';

export type StepType = 'llm' | 'tool' | 'condition' | 'loop' | 'human';

export type Step = {
  role: 'supervisor' | 'planner' | 'worker' | 'critic';
  /** 节点类型，默认 llm */
  type?: StepType;
  prompt: string;
  /** tool 节点：内置 search_knowledge / read_file / sandbox，或连接器名称 */
  tool?: string;
  /** condition 节点：prev/input 包含该子串时继续，否则终止 */
  contains?: string;
  /** loop 节点：重复次数 */
  times?: number;
  /** human 节点：是否要求人工确认后继续 */
  requireConfirm?: boolean;
};

export type TrajectoryStep = { role: string; type?: string; prompt: string; output: string; tool?: string };
export type RunResult = {
  result: string;
  trajectory: TrajectoryStep[];
  paused?: boolean;
  nextIndex?: number;
  prev?: string;
  /** 被墙钟/预算硬上限中断时为 true，result 为中断前最后可用产出 */
  aborted?: boolean;
  abortReason?: string;
};

/** 单次技能运行的可选参数 + 必须注入的执行器 */
export type RunOptions = {
  modelId?: string;
  userId?: string;
  /** 从第几步开始（人工确认后续跑时使用） */
  startIndex?: number;
  /** 续跑时的上一步产出 */
  prevInit?: string;
  executor: StepExecutor;
  /** 单次运行最大墙钟时间（毫秒），默认 120000 */
  maxWallClockMs?: number;
  /** 单次运行 token 预算（0 表示不限制），默认 0 */
  maxTokens?: number;
  /** token 累加槽，由调用方创建并共享给 executor，用于预算控制 */
  usageSink?: { add(n: number): void; total(): number };
  /**
   * 是否允许「critic 连续不通过 → 升档重做」（V8.3 · W4）。
   * 默认开启；只在当前模型 ≠ 默认主模型时才有意义（已经是主模型就无处可升）。
   */
  escalate?: boolean;
};

/** 被运行硬上限（墙钟 / token 预算）中断时抛出的内部信号，由 runSkillCore 顶层捕获转为 aborted 结果 */
class RunAborted extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'RunAborted';
  }
}

function roleSystem(role: string): string {
  const base = (() => {
    switch (role) {
      case 'supervisor':
        return '你是总控 Agent（Supervisor）。负责理解目标、拆解任务并给出整体执行思路。输出简洁清晰。';
      case 'planner':
        return '你是规划 Agent（Planner）。基于目标与上下文，产出可执行的步骤方案（纯文本步骤即可）。';
      case 'worker':
        return '你是执行 Agent（Worker）。严格按照指令完成任务，给出具体、可用的产出。';
      case 'critic':
        return [
          '你是校验 Agent（Critic）。评估上一步产出是否满足要求。',
          '必须只输出一个 JSON 对象，形如：',
          '{"verdict":"pass","reason":"..."} 或 {"verdict":"fail","reason":"<问题点>"}',
          '不要输出 JSON 以外的任何内容。',
        ].join('\n');
      default:
        return '你是一个有用的 AI 助手。';
    }
  })();
  // V8.3 · R3：executor 现在把检索片段 / 文件正文 / 连接器返回都包了 <untrusted_data>，
  // 这里配套告诉模型「那只是数据」。只定界不说规则，模型仍可能照着里面的句子做。
  return base + UNTRUSTED_DATA_NOTE;
}

/**
 * 解析 Critic 输出为结构化判定：严格 JSON 优先，失败则「带错误原因让模型重出一次」，
 * 仍不合法一律按 fail 处理（fail-closed），并把两次失败都写进轨迹便于复盘。
 * 这里不再用正则猜自然语言——「不能通过」这类文本会被正则误判成 pass。
 *
 * 改造点：改由调用方注入的 `gen`（而非直接拿 executor），使修复重试也走同一套
 * 墙钟 / token 预算闸门，不会在「重出一次」这种二次调用里偷偷绕开预算。
 */
async function criticVerdict(
  gen: (args: GenerateArgs) => Promise<string>,
  model: ResolvedModel,
  critiqueText: string,
  trajectory: TrajectoryStep[],
): Promise<Verdict> {
  const first = parseVerdictStrict(critiqueText);
  if (first.ok && first.value) return first.value;

  trajectory.push({
    role: 'critic(invalid)',
    type: 'llm',
    prompt: '严格解析 Critic 输出',
    output: `解析失败：${first.error}\n原始输出：${first.raw.slice(0, 300)}`,
  });

  const fixedText = await gen({
    model,
    system: roleSystem('critic'),
    prompt: verdictRepairPrompt(first.raw, first.error || '格式不合法'),
    label: 'critic-repair',
  });
  const second = parseVerdictStrict(fixedText);
  if (second.ok && second.value) return second.value;

  trajectory.push({
    role: 'critic(invalid)',
    type: 'llm',
    prompt: '修正后的 Critic 输出',
    output: `仍不合法：${second.error}\n原始输出：${second.raw.slice(0, 300)}`,
  });
  // fail-closed：无法确认「通过」就不通过，避免把不合格产出直接交付
  return { verdict: 'fail', reason: `Critic 输出无法解析（${second.error || '未知错误'}），按不通过处理` };
}

/**
 * 多 Agent 编排引擎（声明式节点）：
 * - llm：LLM 步骤（supervisor/planner/worker/critic）
 * - tool：调用内置工具、连接器或代码沙箱
 * - condition：包含判断，不满足则终止
 * - loop：重复执行
 * - human：人工确认点（requireConfirm 时暂停，交由 API/UI 确认后从 nextIndex 续跑）
 * 步骤间以 {{input}}（原始输入）与 {{prev}}（上一步产出）串联。
 *
 * 本文件**不 import 任何 I/O 模块**：模型调用与工具执行都经 `executor` 注入。
 * 这不是为了好看——它让编排逻辑第一次变得可测（见 tests/engine.test.ts）。
 * 生产路径请用 `lib/agent/index.ts` 的 `runSkill`（内部注入默认执行器）。
 *
 * 本次加固：所有 LLM 调用统一走内部 `gen` 包装，每次调用前检查墙钟、调用后检查 token 预算，
 * 触上限即中断并标记 aborted——补上对话通道之外（技能/定时任务）缺失的「运行硬上限」。
 */
export async function runSkillCore(steps: Step[], input: string, opts: RunOptions): Promise<RunResult> {
  const { executor } = opts;
  const startIndex = opts.startIndex ?? 0;
  const prevInit = opts.prevInit ?? '';
  const userId = opts.userId || '';

  const resolved = await executor.resolveModel(opts.modelId);
  if (!resolved) throw new Error('无可用模型，请先配置并设为默认');

  /**
   * 升档链的前置（V8.3 · W4）。
   *
   * 为什么需要：`resolveModelForTask` 只做「降档」，判不出结果时没有任何回退路径——
   * 文档里的 `tier-escalate` 日志实际只覆盖「降档目标不可用」，不是「低档产出不合格」。
   * 这里补上后者：critic 明确 fail 且重试耗尽时，用默认主模型重做一次。
   *
   * 边界（成本）：
   *  - 只在 `critic` 判定 fail 时触发，不是「任何失败」；
   *  - 最多一次，不做多级升级；
   *  - 当前已经是主模型时直接跳过（否则就是原地重跑，纯粹双倍成本）。
   */
  const keyOf = (m: ResolvedModel | null | undefined) => String((m as any)?.id ?? m?.name ?? '');
  let primary: ResolvedModel | null = null;
  if (opts.escalate !== false) {
    try {
      primary = await executor.resolveModel();
    } catch {
      primary = null;
    }
  }
  const canEscalate = !!primary && keyOf(primary) !== keyOf(resolved);

  const maxWallClockMs = opts.maxWallClockMs ?? 120_000;
  const maxTokens = opts.maxTokens ?? 0;
  const sink: { add(n: number): void; total(): number } =
    opts.usageSink ?? { add() {}, total() { return 0; } };
  const startedAt = Date.now();

  // 统一的 LLM 调用入口：先查墙钟，再调执行器，最后查 token 预算。
  // executor 已在内部把本次 token 喂给 sink，这里只需读 total()。
  const gen = async (args: GenerateArgs): Promise<string> => {
    if (Date.now() - startedAt > maxWallClockMs) throw new RunAborted('超过单次运行最大时长上限');
    const text = await executor.generate(args);
    if (maxTokens > 0 && sink.total() > maxTokens) throw new RunAborted('超过单次运行 Token 预算上限');
    return text;
  };

  const trajectory: TrajectoryStep[] = [];
  let prev = prevInit;
  let finalResult = prev;
  const maxRetries = 2;
  const maxSteps = 20;

  try {
    // 仅在首次运行时执行 Supervisor 总览
    if (startIndex === 0) {
      const supPrompt = (steps.find((s) => s.role === 'supervisor')?.prompt || '请理解目标并给出执行思路') + '\n\n目标：' + input;
      const supText = await gen({
        model: resolved,
        system: roleSystem('supervisor'),
        prompt: supPrompt,
        label: 'supervisor',
      });
      trajectory.push({ role: 'supervisor', prompt: supPrompt, output: supText });
      prev = supText;
      finalResult = supText;
    }

    let stepCount = 0;
    for (let i = startIndex; i < steps.length && stepCount < maxSteps; i++) {
      const step = steps[i];
      stepCount++;
      const type: StepType = step.type || (step.tool ? 'tool' : 'llm');
      // 保留未渲染的模板：loop 节点每轮要用自己的上一轮结果重新替换 {{prev}}，
      // 若直接复用下面这个已渲染的 prompt，`{{prev}}` 已经被吃掉，循环里的替换是空操作——
      // 结果是每轮发同一个提示词，模型看不到上一次产出，「迭代」名存实亡。
      const rawPrompt = step.prompt || '';
      const prompt = rawPrompt.split('{{input}}').join(input).split('{{prev}}').join(prev);

      if (type === 'human') {
        if (step.requireConfirm) {
          // 暂停，等待人工确认；返回下一索引与当前上下文
          return { result: prev, trajectory, paused: true, nextIndex: i + 1, prev };
        }
        trajectory.push({ role: step.role, type: 'human', prompt, output: prev || '(人工确认点，已自动通过)' });
        continue;
      }

      if (type === 'condition') {
        const target = `${prev}\n${input}`;
        const ok = !step.contains || target.includes(step.contains);
        trajectory.push({
          role: step.role,
          type: 'condition',
          prompt: `条件：包含「${step.contains || ''}」`,
          output: ok ? '条件满足，继续' : '条件不满足，流程终止',
        });
        if (!ok) return { result: prev, trajectory, prev };
        continue;
      }

      if (type === 'tool') {
        const output = await executor.runTool(step.tool || '', prompt || prev || input, userId);
        trajectory.push({ role: step.role, type: 'tool', prompt, output, tool: step.tool });
        prev = output;
        finalResult = output;
        continue;
      }

      if (type === 'loop') {
        // 用 ?? 而不是 ||：times 写 0 是「明确要 0 次」，不该被当成「没写」而回落到 2 次。
        // 之后再夹到 1~10，因为 0 次循环没有意义（等于空节点），而 999 次会直接打爆额度。
        const times = Math.max(1, Math.min(10, step.times ?? 2));
        let loopPrev = prev;
        for (let t = 0; t < times; t++) {
          const lp = rawPrompt.split('{{input}}').join(input).split('{{prev}}').join(loopPrev);
          const out = await gen({
            model: resolved,
            system: roleSystem(step.role),
            prompt: lp,
            label: `${step.role}-loop${t + 1}`,
          });
          loopPrev = out;
          trajectory.push({ role: `${step.role}(loop ${t + 1}/${times})`, type: 'loop', prompt: lp, output: out });
        }
        prev = loopPrev;
        finalResult = loopPrev;
        continue;
      }

      // 默认 llm
      const output = await gen({
        model: resolved,
        system: roleSystem(step.role),
        prompt,
        label: step.role,
      });
      trajectory.push({ role: step.role, type: 'llm', prompt, output });

      if (step.role === 'critic') {
        const v = await criticVerdict(gen, resolved, output, trajectory);
        if (v.verdict === 'fail' && i > 0) {
          let retries = 0;
          let fixedPrev = prev;
          let passed = false;
          while (retries < maxRetries) {
            retries++;
            const rePlan = await gen({
              model: resolved,
              system: roleSystem('worker'),
              prompt: `上一步被判定不通过，原因：${v.reason}\n请基于原始目标重新产出：\n${input}\n参考上下文：\n${prev}`,
              label: 'worker-retry',
            });
            fixedPrev = rePlan;
            const reCritic = await gen({
              model: resolved,
              system: roleSystem('critic'),
              prompt: fixedPrev,
              label: 'critic-retry',
            });
            const rv = await criticVerdict(gen, resolved, reCritic, trajectory);
            trajectory.push({ role: 'worker(retry)', prompt: '重新产出', output: fixedPrev });
            trajectory.push({ role: 'critic(retry)', prompt: fixedPrev, output: reCritic });
            if (rv.verdict === 'pass') {
              passed = true;
              break;
            }
            prev = fixedPrev;
          }
          // 低档模型怎么改都过不了 → 升档重做一次（若当前已是主模型则跳过）
          if (!passed && canEscalate) {
            trajectory.push({
              role: 'escalate',
              type: 'llm',
              prompt: 'critic 连续不通过，升档重做',
              output: `${resolved.name} → ${primary!.name}`,
            });
            const strong = await gen({
              model: primary!,
              system: roleSystem('worker'),
              prompt: `上一步被判定不通过，原因：${v.reason}\n请基于原始目标重新产出：\n${input}\n参考上下文：\n${prev}`,
              label: 'worker-escalate',
            });
            fixedPrev = strong;
          }
          prev = fixedPrev;
          finalResult = fixedPrev;
        } else {
          prev = output;
          finalResult = output;
        }
      } else {
        prev = output;
        finalResult = output;
      }
    }

    return { result: finalResult || prev, trajectory, prev };
  } catch (e: any) {
    // 墙钟 / token 预算硬上限触发：保留中断前轨迹与最后可用产出，标记 aborted 交上层处理
    if (e instanceof RunAborted) {
      return { result: prev, trajectory, prev, aborted: true, abortReason: e.message };
    }
    throw e;
  }
}
