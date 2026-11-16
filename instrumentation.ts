/**
 * Next.js 服务器启动钩子。Next 15 已内置（13.4–14 需在 next.config 里开
 * `experimental.instrumentationHook`），根目录、与 `app/` 同级，`register()`
 * 在每个 server 进程启动时执行一次。
 *
 * 为什么必须有这个文件：`lib/scheduler.ts` 的 `startScheduler()` 原先只在
 * `app/api/schedules/route.ts` 的模块顶层被调用 —— 意味着进程重启后，只要没人
 * 打开「定时任务」页面，所有 cron 一个都不会注册，而任务列表仍显示「已启用」。
 * 这是静默失效：没有报错、没有日志，用户以为任务在跑。
 */
export async function register() {
  // instrumentation 会被编到 node 与 edge 两套 bundle。
  //
  // 这里必须是**正向**判断 `=== 'nodejs'`，把 import 写在 if 体内。
  // Next 靠 AST 识别这个精确形态，从而把被守卫的模块标记为 node-only、
  // 在 edge bundle 里整段跳过。若写成 `if (NEXT_RUNTIME !== 'nodejs') return;`
  // 再在函数体顶层 await import，语义等价但识别不到 —— edge 编译会去解析
  // ./lib/scheduler 的整条依赖链，撞上 fs/path/crypto/net/dns 这些
  // Node 内置模块而报 "Module not found"，构建直接失败。
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    // 数据库自检放在最前面：它是绝大多数「启动成功但什么都用不了」的根因。
    // 必须在 startScheduler 之前——调度器会立刻查库同步任务，库不通时它抛出的
    // 错误更难读（而且那里的错误文本是 PG 原文，中文环境下是乱码）。
    const { preflightDb } = await import('./lib/db');
    await preflightDb();

    const { startScheduler } = await import('./lib/scheduler');
    startScheduler();

    // 优雅关闭：容器滚动发布 / kill 时先停调度、再关队列与连接池，避免硬切
    const { registerShutdownHooks } = await import('./lib/shutdown');
    registerShutdownHooks();
  }
}
