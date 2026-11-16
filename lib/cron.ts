import cron from 'node-cron';

/**
 * 校验 `cron` 字段是否可被调度器接受（支持 `interval:N` 与标准 cron 表达式）。
 *
 * 单独成模块的原因：调度器本体（lib/scheduler.ts）会连带引入 agent / llm / notify 等重依赖，
 * 而这段逻辑是纯判断——放在这里，单测可以零副作用地覆盖它。
 *
 * 背景（BUG-024）：此前创建接口只校验「非空字符串」，非法表达式能成功入库并显示为已启用；
 * 调度器注册时 `cron.schedule()` 抛错又被 `catch` 静默吞掉，任务永远不执行且无人知晓。
 * 校验前移到「写入前」，让非法输入在能返回错误的地方立刻失败。
 */
export function isValidCron(expr: string): boolean {
  const v = (expr || '').trim();
  if (!v) return false;
  if (v.startsWith('interval:')) {
    const raw = v.slice('interval:'.length).trim();
    if (!/^\d+$/.test(raw)) return false;
    const n = Number(raw);
    return Number.isInteger(n) && n >= 1;
  }
  try {
    return cron.validate(v);
  } catch {
    return false;
  }
}
