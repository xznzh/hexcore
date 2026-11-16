/**
 * 工具回执的「业务成功」判定（V8 · O6，缺口 G11）。
 *
 * 问题：HTTP 200 ≠ 调用成功。不少三方网关把鉴权/配额/参数错误塞在 200 的 body 里
 * （`{"demoapi_res_code":-1002}`、`{"status":"error","data":"invalid key"}`）。
 * 此前这类判定只有 `capabilities.ts` 的特判（DemoAPI + Open-Meteo 两个写死的分支），
 * 通用连接器 `callConnector` 完全不做——结果是：
 *   下游明确报错 → 模型拿到一段看似正常的数据 → 当成事实继续编。
 *
 * 本模块把它抽成**可扩展的规则表**：
 *  - 内置两条（DemoAPI / Open-Meteo），文案与行为与迁移前逐字一致；
 *  - 支持按连接器注册自定义规则（`registerBusinessRule`），新接入的网关不用再改核心代码；
 *  - `assertBusinessSuccess` 只认明确字段，**不做模糊匹配**——误判正常业务里的 `code` 字段
 *    会把成功调用报成失败，比漏判更难排查。
 *
 * 纯函数，无 IO，可直接单测。
 */

export type BusinessRuleContext = {
  /** 连接器 id，用于规则命中范围 */
  connectorId?: string;
  /** 连接器类型（http / db / mcp …） */
  connectorType?: string;
  /** 请求 URL，规则可按域名自行收窄 */
  url?: string;
};

export type BusinessRule = {
  /** 规则名，用于日志定位是哪条规则判失败 */
  name: string;
  /** 可选：只作用于指定连接器 id */
  connectorId?: string;
  /** 可选：只作用于匹配的 URL（正则） */
  urlPattern?: RegExp;
  /** 返回 null 表示「没有业务错误」 */
  check: (body: any, raw: string, ctx: BusinessRuleContext) => string | null;
};

/** 内置规则：与 V6/V7 里写死在 capabilities.ts 的判定保持一致（含提示文案） */
export const BUILTIN_RULES: BusinessRule[] = [
  {
    name: 'demoapi',
    check: (body) => {
      if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
      if (!Object.prototype.hasOwnProperty.call(body, 'demoapi_res_code')) return null;
      const code = Number(body.demoapi_res_code);
      if (!Number.isFinite(code) || code === 0) return null;
      const msg = String(body.demoapi_res_error || `业务错误码 ${code}`);
      const hint =
        code === -1002
          ? '\n提示：请求缺少 appKey。请在该连接器配置里补 {"query":{"appKey":"你的Key"}}（或 headers 里加 appKey）。'
          : code === -1004
            ? '\n提示：appKey 无效。请核对 DemoAPI 控制台的 appKey 是否填写正确。'
            : '';
      return `接口返回业务错误：${msg}（demoapi_res_code=${code}）${hint}`;
    },
  },
  {
    name: 'open-meteo',
    check: (body) => {
      if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
      // Open-Meteo（api.open-meteo.com）：HTTP 恒为 200，成败只体现在 {"status":"ok"|"error","data":...}
      if (body.status !== 'error' || typeof body.data !== 'string') return null;
      const raw = body.data;
      const hint = /unknown station/i.test(raw)
        ? '\n提示：Open-Meteo 没有该城市的采集节点点。城市名请用拼音或英文（如 beijing / shanghai），小城市可改用所属省会或邻近大城市。'
        : /invalid key|over quota/i.test(raw)
          ? '\n提示：Open-Meteo 的 token 无效或已超额。该连接器默认用官方 demo token，限流后可到 ehicn.org 申请自己的 token 填入配置。'
          : '';
      return `接口返回业务错误：${raw}（Open-Meteo status=error）${hint}`;
    },
  },
];

/** 运行期注册的规则（进程内；连接器配置变更后可重新注册，同名覆盖） */
const customRules = new Map<string, BusinessRule>();

/**
 * 注册一条自定义业务规则。
 * 典型用法：新接入一个网关时在连接器初始化处注册，判定逻辑不再散落进 `callConnector`。
 */
export function registerBusinessRule(rule: BusinessRule): void {
  customRules.set(rule.name, rule);
}

export function unregisterBusinessRule(name: string): void {
  customRules.delete(name);
}

/** 仅供测试：清空自定义规则（内置规则不受影响） */
export function clearBusinessRules(): void {
  customRules.clear();
}

function applicable(rule: BusinessRule, ctx: BusinessRuleContext): boolean {
  if (rule.connectorId && rule.connectorId !== ctx.connectorId) return false;
  if (rule.urlPattern && !rule.urlPattern.test(String(ctx.url || ''))) return false;
  return true;
}

/**
 * 判定一次回执是否为「业务失败」。
 * @returns 失败时返回给模型看的可读说明；成功返回 null。
 */
export function assertBusinessSuccess(raw: string, ctx: BusinessRuleContext = {}): string | null {
  const text = String(raw ?? '');
  let body: any;
  try {
    body = JSON.parse(text);
  } catch {
    return null; // 非 JSON（纯文本/HTML/CSV）不在此判定范围
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;

  for (const rule of [...BUILTIN_RULES, ...customRules.values()]) {
    if (!applicable(rule, ctx)) continue;
    try {
      const err = rule.check(body, text, ctx);
      if (err) return err;
    } catch {
      // 单条规则写错不应让整个调用失败
    }
  }
  return null;
}
