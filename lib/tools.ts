import vm from 'vm';
import { db } from './db';
import { connectors, files } from './schema';
import { eq } from 'drizzle-orm';
import { resolveSafe } from './storage';
import fs from 'fs/promises';
import { decodeResponseBody, applyResponseMapping } from './http';
import { decryptJson } from './crypto';
import { guardCircuit, markCircuitFailure, markCircuitSuccess } from './resilience';
import { safeFetch } from './ssrf';
import { assertBusinessSuccess } from './tools/business-success';
import { McpClient } from './mcp/client';

export type ConnectorRow = typeof connectors.$inferSelect;

/**
 * 受限代码沙箱。
 *
 * 隔离级别的演进（2026-10-30）：原先直接在进程内 `vm.createContext` 执行，`timeout` 只能中断
 * **同步 JS**，且内存无上限——一段 `while(true)` 能被 timeout 拦下，但一段疯狂 `new Array(1e8)`
 * 会把整个 Next.js 进程拖到 OOM，`timeout` 完全帮不上（它只管 CPU 时间片，不管堆）。
 * 现在改到 `worker_threads` 里跑：
 *  - **可强杀**：`terminate()` 能中断同步死循环（进程内 vm 的 timeout 也做得到，但一旦代码
 *    在 native 调用里卡住就无解）；
 *  - **有内存上限**：`resourceLimits.maxOldGenerationSizeMb` 让超额分配变成 worker 崩溃，
 *    而不是拖垮整个服务进程；
 *  - **仍保留 vm**：worker 内继续用 `vm` 提供 `console`/`Math` 等受限全局，语义与原来一致。
 *
 * 诚实标注：worker_threads **不是**安全边界（同进程、共享文件系统与网络）。它能防「资源
 * 打爆」，不能防「恶意代码读文件」。面向完全不可信的第三方代码仍需容器/微虚拟机级隔离；
 * 本项目用它执行「用户自己编写、平台信任其意图」的脚本，这个边界是可接受的。
 */
const SANDBOX_VM_TIMEOUT_MS = 1000;

/** worker 源码：用字符串 eval 启动，避免构建期把 worker 当独立入口处理（Next 打包会失败） */
function sandboxWorkerSource(): string {
  return [
    "'use strict';",
    "const vm = require('vm');",
    "const { parentPort, workerData } = require('worker_threads');",
    'const logs = [];',
    'try {',
    '  const ctx = vm.createContext({',
    '    console: { log: (...a) => { if (logs.length < 200) logs.push(a.map(String).join(" ")); } },',
    '    Math, JSON, result: undefined,',
    '  });',
    '  new vm.Script("\'use strict\';(function(){ " + workerData.code + " })();", { filename: "sandbox.js" })',
    '    .runInContext(ctx, { timeout: workerData.vmTimeoutMs });',
    '  const out = ctx.result !== undefined ? ctx.result : logs.join("\\n");',
    '  parentPort.postMessage({ ok: true, out: typeof out === "string" ? out : JSON.stringify(out) });',
    '} catch (e) {',
    '  parentPort.postMessage({ ok: false, error: String((e && e.message) || e) });',
    '}',
  ].join('\n');
}

function sandboxTimeoutMs(): number {
  const n = Number(process.env.SANDBOX_TIMEOUT_MS);
  return Number.isFinite(n) && n > 0 ? n : 2000;
}

function sandboxMemMb(): number {
  const n = Number(process.env.SANDBOX_MEM_MB);
  return Number.isFinite(n) && n > 0 ? n : 64;
}

/** 进程内 vm：worker 不可用（或显式 SANDBOX_MODE=vm）时的降级路径，隔离性更弱 */
function runSandboxInVm(code: string): string {
  const logs: string[] = [];
  const sandbox: any = {
    console: { log: (...a: any[]) => logs.push(a.map(String).join(' ')) },
    Math,
    JSON,
    result: undefined,
  };
  try {
    const ctx = vm.createContext(sandbox);
    // 'use strict' 使函数内 this=undefined，阻断 `this.constructor.constructor('return process')()`
    // 这类原型链逃逸起手式（vm 不是安全边界，见上方说明）
    const script = new vm.Script(`'use strict';(function(){ ${code} })();`, { filename: 'sandbox.js' });
    script.runInContext(ctx, { timeout: SANDBOX_VM_TIMEOUT_MS });
    const out = sandbox.result !== undefined ? sandbox.result : logs.join('\n');
    return typeof out === 'string' ? out : JSON.stringify(out);
  } catch (e: any) {
    return `沙箱执行失败: ${e?.message || e}`;
  }
}

async function runSandboxInWorker(code: string): Promise<string> {
  // 动态 import：静态 import worker_threads 会让 edge/浏览器侧打包出问题
  const { Worker } = await import('node:worker_threads');
  const timeoutMs = sandboxTimeoutMs();
  const memMb = sandboxMemMb();

  return new Promise<string>((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let worker: any;

    const finish = (text: string) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(text);
      // terminate 是幂等的；失败也不影响已 resolve 的结果
      try {
        worker?.terminate?.();
      } catch {
        /* ignore */
      }
    };

    try {
      worker = new Worker(sandboxWorkerSource(), {
        eval: true,
        workerData: { code, vmTimeoutMs: SANDBOX_VM_TIMEOUT_MS },
        resourceLimits: {
          maxOldGenerationSizeMb: memMb,
          maxYoungGenerationSizeMb: Math.max(8, Math.floor(memMb / 4)),
        },
      });
    } catch (e: any) {
      // 启动失败（运行时不支持 worker / 资源限制非法）交给上层降级，不在这里吞掉
      settled = true;
      resolve(`__WORKER_UNAVAILABLE__:${e?.message || e}`);
      return;
    }

    timer = setTimeout(() => finish(`沙箱执行超时（>${timeoutMs}ms），已终止`), timeoutMs);

    worker.on('message', (m: any) => {
      if (m?.ok) finish(String(m.out ?? ''));
      else finish(`沙箱执行失败: ${m?.error || '未知错误'}`);
    });
    worker.on('error', (e: any) => {
      const msg = String(e?.message || e);
      // 内存超限是 worker 特有的失败形态，给出可操作的提示而不是把 ERR_WORKER_OUT_OF_MEMORY 直抛给模型
      finish(
        /out of memory|ERR_WORKER_OUT_OF_MEMORY/i.test(msg)
          ? `沙箱内存超限（上限 ${memMb}MB），已终止`
          : `沙箱执行失败: ${msg}`,
      );
    });
    worker.on('exit', (c: number) => {
      if (!settled) finish(c === 0 ? '沙箱执行结束但无输出' : `沙箱异常退出（code ${c}）`);
    });
  });
}

export async function runSandbox(code: string): Promise<string> {
  if ((process.env.SANDBOX_MODE || '').toLowerCase() === 'vm') return runSandboxInVm(code);
  const r = await runSandboxInWorker(code);
  if (r.startsWith('__WORKER_UNAVAILABLE__:')) {
    console.warn(
      `[sandbox] worker 线程不可用，降级到进程内 vm（隔离性下降）：${r.slice('__WORKER_UNAVAILABLE__:'.length)}`,
    );
    return runSandboxInVm(code);
  }
  return r;
}

function cfgOf(c: ConnectorRow): any {
  return parseConnectorConfig(c.config);
}

/**
 * 解析连接器配置（统一入口）。
 * 连接器 config 里可能含 Authorization / API Key / 数据库连接串，落库前统一用 AES-256-GCM 加密
 * （见 `lib/crypto.ts` 的 `encryptJson`）；此函数兼容 V6.5 之前的明文存量行，老库无需迁移。
 */
export function parseConnectorConfig(stored: string | null | undefined): any {
  return decryptJson(stored);
}

/**
 * 解码 HTTP 响应体（解决行情/老采集点 GBK 中文乱码）：
 * 实现见 `lib/http.ts` 的 decodeResponseBody；此处保留 re-export 方便旧调用方。
 */
export { decodeResponseBody } from './http';

/**
 * 连接器调用（工具执行）。支持：
 * - http：HTTP 请求
 * - db：只读 SQL 查询（需 config.connectionString + config.query）
 * - builtin:file：读取用户文件
 * - builtin:sandbox：JS 代码沙箱
 * - browser：Playwright 浏览器抓取（未安装则给出提示）
 * - mcp：MCP 端点连通性探测
 */
export async function callConnector(c: ConnectorRow, userId: string, input = ''): Promise<string> {
  const cfg = cfgOf(c);

  if (c.type === 'http') {
    // 熔断：下游连续失败达阈值时快速失败，避免每次调用都白等 15s 超时
    const breakerKey = `connector:${c.id}`;
    try {
      await guardCircuit(breakerKey, c.name);
    } catch (e: any) {
      return String(e?.message || e);
    }
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15000);
    try {
      // 支持 {{input}} 占位符：调用方传入的 input 替换到 url/headers/body 中，实现「一个连接器调用不同参数」。
      // GET 语义下 body 通常不用；POST 时 body 模板同样可用。
      const tpl = (v: string, fallback?: string) => String(v ?? fallback ?? '').split('{{input}}').join(input);
      const url = cfg.url ? tpl(cfg.url) : undefined;
      const body = cfg.body !== undefined ? tpl(String(cfg.body)) : undefined;
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(cfg.headers || {})) headers[k] = tpl(String(v));
      const res = await safeFetch(url!, {
        method: (cfg.method || 'GET') as any,
        headers,
        body: cfg.method === 'POST' ? body : undefined,
        signal: ctrl.signal,
      });
      // 5xx 说明下游自己故障 → 计失败；4xx 说明下游活着（只是请求不对）→ 计成功，不误伤熔断
      if (res.status >= 500) await markCircuitFailure(breakerKey);
      else await markCircuitSuccess(breakerKey);
      // 用二进制读取再按 charset 解码：腾讯/新浪行情等接口返回 GBK，直接 text() 会中文乱码
      const buf = await res.arrayBuffer();
      const raw = decodeResponseBody(buf, res.headers.get('content-type') || '');
      // V8 · O6：HTTP 200 也可能是业务失败（很多网关把鉴权/配额/参数错误放在 body 里）。
      // 不判的话，模型会拿到一段「看起来正常」的错误报文，然后当成事实继续编。
      const bizError = assertBusinessSuccess(raw, { connectorId: c.id, connectorType: c.type, url });
      if (bizError) return `HTTP ${res.status}\n${bizError}`;
      // 按配置做字段映射（extract/pick/limit），把原始报文收敛成模型易读的结构，省 token 也更稳
      const text = applyResponseMapping(raw, cfg);
      return `HTTP ${res.status}\n${String(text).slice(0, 4000)}`;
    } catch (e: any) {
      await markCircuitFailure(breakerKey);
      const msg = e && e.name === 'AbortError' ? 'HTTP 请求超时（15s）' : e?.message || e;
      return `HTTP 请求失败：${msg}`;
    } finally {
      clearTimeout(timer);
    }
  }

  if (c.type === 'db') {
    const query = String(cfg.query || '');
    if (!/^\s*(select|with)\b/i.test(query)) return 'DB 连接器仅允许只读 SELECT/WITH 查询';
    if (!cfg.connectionString) return '缺少 connectionString';
    let sql: any;
    try {
      const postgres = (await import('postgres')).default;
      // max:1 单连接；connect_timeout 防连不上挂死；idle_timeout 让连接及时回收（之前每次调用都新建长驻连接）
      sql = postgres(cfg.connectionString, { max: 1, connect_timeout: 5, idle_timeout: 2 });
      // 查询级超时：防笨重 / 恶意查询一直占用连接（connect_timeout 只管「连接」不管「查询」）
      await sql.unsafe('SET statement_timeout = 10000');
      const rows = await sql.unsafe(query, (cfg.params || []) as any[]);
      const arr = rows as any[];
      return `返回 ${arr.length} 行：\n${JSON.stringify(arr.slice(0, 50), null, 2)}`;
    } catch (e: any) {
      return `DB 查询失败：${e?.message || e}`;
    } finally {
      try {
        await sql?.end({ timeout: 1 });
      } catch {
        /* 连接已断，忽略 */
      }
    }
  }

  if (c.type === 'builtin:file') {
    const f = (await db.select().from(files).where(eq(files.id, cfg.fileId)).limit(1))[0];
    if (!f || f.ownerId !== userId) return '文件不存在或无权限';
    try {
      const buf = await fs.readFile(resolveSafe(f.path));
      return buf.toString('utf8').slice(0, 3000);
    } catch {
      return '读取文件失败';
    }
  }

  if (c.type === 'builtin:sandbox') {
    return runSandbox(String(cfg.code || ''));
  }

  if (c.type === 'browser') {
    if (!cfg.url) return '缺少 url';
    try {
      let mod: any = null;
      try {
        // 运行时动态加载：构建期不静态解析，未安装 playwright 也不会导致构建失败
        mod = await (new Function('return import("playwright")') as any)();
      } catch {
        mod = null;
      }
      if (!mod) return '未安装 Playwright（如需浏览器自动化，请在本机执行 `pnpm add playwright` 并安装浏览器）';
      const browser = await mod.chromium.launch({ headless: true });
      const page = await browser.newPage();
      await page.goto(cfg.url, { timeout: 20000 });
      const text = await page.innerText('body').catch(() => '');
      await browser.close();
      return (text || '(空页面)').slice(0, 3000);
    } catch (e: any) {
      return `浏览器抓取失败：${e?.message || e}`;
    }
  }

  if (c.type === 'mcp') {
    // MCP 端点是 POST-only 的 JSON-RPC：GET 探测只会拿到 405/400，显示成「连通性：405」会被误读成坏了。
    // 所以这里做真实握手（initialize + tools/list）——能列出工具才算通，顺带把服务名与工具数告诉用户。
    try {
      const cli = new McpClient({ url: cfg.url, headers: cfg.headers, timeoutMs: 10000 });
      await cli.initialize();
      const list = await cli.listTools();
      const info = cli.serverInfo ? `${cli.serverInfo.name || '未知服务'} ${cli.serverInfo.version || ''}`.trim() : '未声明 serverInfo';
      return `MCP 握手成功：${info}（协议 ${cli.protocolVersion}），暴露 ${list.length} 个工具${
        list.length ? `：${list.map((t) => t.name).join('、')}` : ''
      }`;
    } catch (e: any) {
      // safeFetch 在 McpClient 内部生效：内网/元数据地址会被「URL 被安全策略拒绝」拦下
      const msg = e && e.name === 'AbortError' ? '超时（10s）' : e?.message || e;
      return `MCP 握手失败：${msg}`;
    }
  }

  return '(未知连接器类型)';
}
