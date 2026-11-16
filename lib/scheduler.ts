import cron from 'node-cron';
import { db, ensureInit } from './db';
import { schedules, skills, scheduleRuns } from './schema';
import { eq } from 'drizzle-orm';
import { resolveModelWithFallback } from './llm';
import { callModel } from './llm-gateway';
import { runSkill } from './agent';
import { addUsage, logAction, estimateTokens, newId } from './util';
import { finalizeChannel, toolOutputsOf } from './agent/answer-guard';
import { auditChannelAnswer } from './agent/channel-verify';
import { judgeChannelAnswer } from './agent/runtime-judge';
import { maybeRunQualityCheck } from './agent/quality-alert';
import { createNotification } from './notify';
import { postJson } from './outbound';
import { checkQuota } from './quota';
import { tryLock, releaseLock, extendLock } from './redis';
import { isValidCron } from './cron';

type ScheduleRow = typeof schedules.$inferSelect;

/**
 * 定时任务里的 LLM 调用超时（V8.3 · R4）。
 *
 * 原来这里既没有 `abortSignal` 也没有外层超时：上游挂起时 `generateText` 永久 pending，
 * 而调度锁的 `finally` 在它后面——锁永不释放、通知永不发出、用户什么都不知情。
 * 这是本次审计里最严重的一条静默故障（无人值守 + 无任何反馈）。
 */
function llmTimeoutMs(): number {
  const n = Number(process.env.SCHEDULE_LLM_TIMEOUT_MS);
  return Number.isFinite(n) && n > 0 ? n : 90_000;
}

/**
 * 调度锁的租约时长（秒）。原来是 3600s，等于「挂起一小时」；
 * 缩到 10 分钟后，即使进程被 kill -9（`finally` 不执行）也只影响十分钟。
 */
function leaseSec(): number {
  const n = Number(process.env.SCHEDULE_LOCK_SEC);
  return Number.isFinite(n) && n >= 30 ? Math.min(3600, n) : 600;
}

const jobs = new Map<string, cron.ScheduledTask>();
// 注册失败的 schedule id：避免 syncJobs 每 60s 对同一个非法 cron 反复尝试并刷日志。
const invalidCronIds = new Set<string>();
// 用 globalThis 持有启动标志：Next dev 的 HMR 会重新求值模块，模块级 `started` 会被重置，
// 导致多个 setInterval 定时器叠加（每分钟任务被重复注册/执行）。挂到 globalThis 上跨模块重载存活。
const g = globalThis as unknown as { __wb_scheduler_started?: boolean };
// 每分钟同步一次的定时器句柄。提到模块作用域是为了能在优雅关闭时 clearInterval
// —— 原实现是 startScheduler 内的 const，进程退出时无法主动停掉。
let ticker: ReturnType<typeof setInterval> | null = null;

async function recordRun(scheduleId: string, status: string, result: string | null, error: string | null, startedAt: number) {
  try {
    await db.insert(scheduleRuns).values({
      id: newId('sr'),
      scheduleId,
      status,
      result: result ? result.slice(0, 4000) : null,
      error,
      startedAt,
      finishedAt: Date.now(),
    });
  } catch {
    /* ignore */
  }
}

/**
 * 执行一次任务：prompt 直接生成；target='skill' 时运行完整多 Agent 技能流水线。
 * 结果（成功/失败）写入执行历史、站内通知，并按配置推送 Webhook。
 */
export async function runSchedule(s: ScheduleRow): Promise<string> {
  const startedAt = Date.now();
  // 分布式锁：多 replica 部署时避免同一 cron 被多个进程重复触发（单机/无 Redis 时 tryLock 直接放行）
  // V8.3 · R4：TTL 从 3600s 改为租约式（默认 600s）+ 心跳续期，见 lib/redis.ts extendLock 的注释
  const lockKey = `sched:${s.id}`;
  const lease = leaseSec();
  if (!(await tryLock(lockKey, lease))) return 'skipped: locked by another instance';
  const heartbeat = setInterval(
    () => {
      extendLock(lockKey, lease).catch(() => {});
    },
    Math.max(15_000, Math.floor((lease * 1000) / 3)),
  );
  const hb = heartbeat as unknown as { unref?: () => void };
  if (typeof hb.unref === 'function') hb.unref();
  try {
    // 定时任务也受用户月度预算约束（block 策略则跳过本次运行，避免绕过对话通道烧穿额度）
    const quota = await checkQuota(s.ownerId);
    if (quota.exceeded) {
      await recordRun(s.id, 'skipped', null, 'Token 额度已用尽（block 策略），跳过本次运行', startedAt);
      return 'skipped: quota exceeded';
    }
    const resolved = await resolveModelWithFallback(s.modelId);
    const prompt = s.prompt || '';

  let out = '';
  let status = 'ok';
  let error = '';
  /** 技能被墙钟 / 预算硬上限中断：产出是「中断前的部分内容」，不是失败，也不是完成 */
  let aborted = false;
  /**
   * 本次执行的完整轨迹（只有技能通道有）。
   *
   * V8.4 起它要供出口护栏判断「有据可引」，V8.6 起还要供运行时 V 层核对
   * 「声称使用了某个工具，轨迹里到底有没有」。**两个用途共用一份来源**——
   * 拆成 `toolOutputs` + `trajectory` 两个变量的话，后加的那个迟早漏赋值，
   * 而漏赋值的表现是「规则永远不报警」，不会报错，也不会有人发现。
   */
  let trajectory: { type?: string; tool?: string; output?: string }[] = [];

  try {
    if (s.target === 'skill' && s.skillId) {
      const sk = (await db.select().from(skills).where(eq(skills.id, s.skillId)).limit(1))[0];
      if (!sk) throw new Error('技能不存在');
      const steps = JSON.parse(sk.steps || '[]');
      const r = await runSkill(steps, prompt || s.name, sk.modelId || undefined, s.ownerId);
      out = r.result;
      trajectory = r.trajectory;
      // V8.4：中断语义必须与 `skills/run` 一致。
      // 原实现只取 `result`，把 `aborted` 丢掉了——于是技能被 120s 墙钟掐断时，
      // 这条通道仍然发「定时任务完成」的通知，而正文可能是半句话或空串。
      // 无人值守通道里「把失败报成成功」比失败本身更糟：用户不会去查，只会以为没内容。
      if (r.aborted) {
        aborted = true;
        status = 'error';
        error = r.abortReason || '技能运行被中断';
      }
      if (resolved) await addUsage(s.ownerId, estimateTokens(prompt) + estimateTokens(r.result));
    } else {
      if (!prompt) {
        out = '(空任务)';
      } else {
        // 注入运行时间上下文：任务侧无法感知「现在几点」，简报/统计类任务需以此为准
        const timeCtx = `【运行环境信息】当前时间：${new Date().toLocaleString('zh-CN', { hour12: false })}。若任务与时间、日期相关，请以此为准。\n\n`;
        const perCall = llmTimeoutMs();
        const { text } = await callModel({
          model: resolved!,
          label: 'schedule',
          prompt: timeCtx + prompt,
          userId: s.ownerId,
          timeoutMs: perCall,
          totalMs: perCall * 2,
        });
        out = text;
        if (resolved) await addUsage(s.ownerId, estimateTokens(timeCtx + prompt) + estimateTokens(text));
      }
    }
  } catch (e: any) {
    status = 'error';
    error = String(e?.message || e);
    out = `执行失败：${error}`;
  }

  // V8.3 · R2：出口护栏。这条通道的产出会直接进站内通知与 webhook——
  // 用户在收到推送前没有任何机会拦下，所以这里是「最后一道、也是唯一一道」门。
  // V8.4：把通道上下文带进去（任务指令 + 工具产出），不再用空 context——
  // 空 context 会把「照知识库引用」误判成编造引用，见 agent/answer-guard.ts 文件头。
  const guarded = finalizeChannel(out, {
    userId: s.ownerId,
    source: 'schedule',
    label: s.name,
    question: prompt,
    toolOutputs: toolOutputsOf(trajectory),
  });
  out = guarded.text;

  // V8.6：运行时 V 层。跑在护栏**之后**，校验的是真正会发出去的那份文本。
  // 这条通道最需要它：结论直接进通知与 webhook，用户看到之前没有任何人会复核，
  // 而「这周简报到底有没有编来源」此前在全平台没有任何记录。
  auditChannelAnswer(
    { userId: s.ownerId, source: 'schedule', label: s.name },
    { answer: out, trajectory },
  );
  /**
   * V8.9：语义抽查（judge）。这条通道最值得判：任务是无人值守跑的，
   * 产出直接进通知与 webhook，而「工具失败了但结论写成成功」正是确定性规则
   * 抓不到、又最伤人的一类。成本由 `RUNTIME_JUDGE` + 采样 + 日预算三层控制，
   * 默认关闭；fire-and-forget，不拖住本轮执行。
   */
  void judgeChannelAnswer({
    userId: s.ownerId,
    channel: 'schedule',
    label: s.name,
    question: prompt,
    answer: out,
    trace: trajectory,
  }).catch(() => {});

  await db.update(schedules).set({ lastRunAt: Date.now(), lastStatus: status }).where(eq(schedules.id, s.id));
  await recordRun(
    s.id,
    status,
    // 中断时保留部分产出（与 skills/run 一致）；真失败才写空，避免把「执行失败：…」当成正文
    status === 'ok' || aborted ? out : null,
    status === 'error' ? error : null,
    startedAt,
  );
  // 拦截不能是隐形的：标题要体现「内容被安全策略处理过」，否则用户会把截断当成模型能力问题
  const title = status === 'ok'
    ? (guarded.blocked ? `定时任务完成（部分内容已按安全策略处理）：${s.name}` : `定时任务完成：${s.name}`)
    : `定时任务${aborted ? '中断' : '失败'}：${s.name}`;
  await createNotification(
    s.ownerId,
    title,
    status === 'ok' ? out.slice(0, 140) : error,
  );

  if (s.notify === 'webhook' && s.webhookUrl) {
    // V8.9：原来这里是一句裸 `fetch`，四个问题叠在一起——没有超时（挂住的接收端
    // 会把定时任务吊到进程重启）、没有 SSRF 校验（webhook_url 由用户自填）、
    // 没有重试、失败静默。统一走 lib/outbound.ts 的 postJson：
    // payload 结构（schedule/status/aborted/result）保持不变，因为外部接收端已经依赖它。
    const delivered = await postJson(s.webhookUrl, {
      schedule: s.name,
      status,
      aborted,
      result: out,
    });
    if (!delivered.ok) {
      // 失败必须留痕：此前是 `catch {}`，事后无从判断「到底推没推成功」
      console.warn(
        `[scheduler] webhook 投递失败（${s.name}）：attempts=${delivered.attempts}` +
          ` status=${delivered.status ?? 'n/a'}${delivered.skipped ? ` skipped=${delivered.skipped}` : ''} ${delivered.error || ''}`,
      );
    }
  }

  try {
    await logAction(s.ownerId, 'schedule_run', s.name);
  } catch {
    /* ignore */
  }

  return out.slice(0, 800);
  } finally {
    clearInterval(heartbeat);
    await releaseLock(lockKey);
  }
}

async function syncJobs() {
  // 调度器现在由 instrumentation 在进程启动时拉起，早于任何 HTTP 请求，
  // 因此必须自己保证表已建好（原实现依赖「访问 /api/schedules 时 ensureInit 已跑过」）。
  await ensureInit();
  const rows = (await db.select().from(schedules).where(eq(schedules.enabled, true))) as ScheduleRow[];
  const ids = new Set(rows.map((r) => r.id));
  for (const [id, job] of jobs) {
    if (!ids.has(id)) {
      job.stop();
      jobs.delete(id);
    }
  }
  for (const r of rows) {
    if (jobs.has(r.id)) continue;
    if (invalidCronIds.has(r.id)) continue; // 已判定非法，不再每分钟重试
    let job: cron.ScheduledTask | null = null;
    if (r.cron.startsWith('interval:')) {
      const raw = r.cron.slice('interval:'.length).trim();
      if (!isValidCron(r.cron)) {
        await markCronInvalid(r.id, r.cron);
        continue;
      }
      const n = Math.max(1, Number(raw));
      job = cron.schedule(`*/${n} * * * *`, () => runSchedule(r).catch(() => {}));
    } else {
      try {
        job = cron.schedule(r.cron, () => runSchedule(r).catch(() => {}));
      } catch {
        job = null;
        // 不再静默：留下日志与状态，用户能在任务列表看到「cron 非法」
        await markCronInvalid(r.id, r.cron);
      }
    }
    if (job) jobs.set(r.id, job);
  }
}

/**
 * 标记「cron 表达式无法注册」：只记一次，避免每分钟刷日志；状态写入 last_status 供前端展示。
 * 历史遗留或直接改库产生的非法行会走这里（新写入已在 API 层拦截）。
 */
async function markCronInvalid(id: string, expr: string) {
  if (invalidCronIds.has(id)) return;
  invalidCronIds.add(id);
  console.warn(`[scheduler] 任务 ${id} 的 cron 表达式非法（${expr}），已跳过调度；请修正后重新保存`);
  try {
    await db.update(schedules).set({ lastStatus: 'invalid_cron' }).where(eq(schedules.id, id));
  } catch {
    /* 状态写入失败不应影响其它任务的同步 */
  }
}

/**
 * 调度器开关：`SCHEDULER_ENABLED=false` 时本副本**完全不启动**定时器。
 *
 * 为什么还需要它——`runSchedule` 里已经有 Redis 分布式锁，多副本不会真的重复执行。
 * 但锁只解决「同一次触发只跑一遍」，解决不了 N 个副本各起一套 cron、各每分钟查一次库、
 * 各在锁上失败 N-1 次。更重要的是：**部署时得能一眼看出谁负责调度**。
 * K8s 里给一个 Deployment 副本加 `SCHEDULER_ENABLED=false`，比在文档里写「请确保只有一个副本」
 * 可靠得多——后者迟早会被扩容打破，而且打破时不会有任何报错，只会悄悄重复通知。
 *
 * 默认启用，不改变单实例部署的现有行为。
 */
function isSchedulerDisabled(): boolean {
  const v = String(process.env.SCHEDULER_ENABLED ?? '').toLowerCase();
  return v === 'false' || v === '0' || v === 'no' || v === 'off';
}

/** 启动调度器（幂等，跨 HMR 单例）。在 Next 服务进程内常驻，每分钟同步一次任务注册。 */
export function startScheduler() {
  if (g.__wb_scheduler_started) return;
  g.__wb_scheduler_started = true;
  if (isSchedulerDisabled()) {
    console.log('[scheduler] SCHEDULER_ENABLED=false，本副本不承担定时任务调度（应另有副本开启）');
    return;
  }
  // 启动结果必须可见：原实现首次同步失败是静默的，运维只能靠「任务没跑」倒推。
  // 注册数写在日志里，重启后一眼能确认调度器是否真的接管了任务。
  syncJobs()
    .then(() => console.log(`[scheduler] 已启动，当前注册 ${jobs.size} 个任务`))
    .catch((e) => console.error('[scheduler] 首次同步失败:', e?.message || e));
  // 质量告警（V8.8）跟着这个 tick 走，不另起定时器：
  //  - `SCHEDULER_ENABLED=false` 的副本本就不该承担平台级周期工作，复用同一个开关；
  //  - 每多一个 setInterval 就多一处「进程退出没清掉」的隐患，这个文件已经踩过一次。
  // 内部按 QUALITY_ALERT_INTERVAL_MIN 节流，所以每分钟调用是安全的。
  const t = setInterval(() => {
    syncJobs().catch(() => {});
    void maybeRunQualityCheck();
  }, 60_000);
  ticker = t;
  if (t.unref) t.unref();
}

/**
 * 优雅关闭：停掉同步定时器与所有已注册的 cron。
 *
 * 为什么必须显式停：node-cron 的任务持有计时器，进程收到 SIGTERM 后如果只等
 * `process.exit()`，会出现在「退出过程中又触发一次任务」的窗口；
 * 而 BullMQ 的 job 与 cron 的 runSchedule 共用额度，重复触发等于重复扣费。
 */
export function stopScheduler(): void {
  if (ticker) {
    clearInterval(ticker);
    ticker = null;
  }
  for (const [id, job] of jobs) {
    try {
      job.stop();
    } catch {
      /* 已停止 */
    }
    jobs.delete(id);
  }
  g.__wb_scheduler_started = false;
}
