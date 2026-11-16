/**
 * HTTP 响应体解码工具（零依赖，可单测）。
 *
 * 背景：腾讯/新浪行情、大量老采集点返回 GBK/GB2312，若直接 `res.text()` 会按 UTF-8 解出乱码。
 * 策略：
 * 1) 优先用响应头 Content-Type 里的 charset；
 * 2) 没有则嗅探 HTML <meta charset="...">；
 * 3) 都没有按 UTF-8；
 * 4) GBK/GB2312 统一用 GB18030（GBK 超集）解码，Node 缺少完整 ICU 时安全回退 UTF-8。
 */
export function decodeResponseBody(buf: ArrayBuffer | Uint8Array, contentType = ''): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  const m = String(contentType).match(/charset\s*=\s*["']?([\w-]+)/i);
  let charset = (m?.[1] || '').toLowerCase();
  if (!charset) {
    const head = new TextDecoder('utf-8').decode(bytes.slice(0, 2048));
    charset = (head.match(/<meta[^>]+charset\s*=\s*["']?([\w-]+)/i)?.[1] || '').toLowerCase();
  }
  if (!charset) charset = 'utf-8';
  if (charset === 'gbk' || charset === 'gb2312' || charset === 'gb18030') charset = 'gb18030';
  try {
    return new TextDecoder(charset).decode(bytes);
  } catch {
    return new TextDecoder('utf-8').decode(bytes);
  }
}

/** HTTP 连接器的响应映射配置（来自 connectors.config，可全部省略） */
export type ResponseMapping = {
  /** auto：能解析成 JSON 就结构化输出，否则原样返回（默认）；json：强制按 JSON 解析；text：原样返回 */
  responseType?: 'auto' | 'json' | 'text';
  /** 取子树路径，如 data.list、data.items[0].quote */
  extract?: string;
  /** 字段映射：输出字段名 -> 取值路径（相对 extract 之后的节点） */
  pick?: Record<string, string>;
  /** 结果为数组时最多返回多少条（默认不截断） */
  limit?: number;
};

/**
 * 按路径取值。支持点号、数组下标与带引号的键：
 * `a.b[0].c`、`data["stock-list"].price`。
 */
export function readPath(obj: any, path: string): any {
  if (!path) return obj;
  const parts: (string | number)[] = [];
  const re = /\[(\d+)\]|\[\s*["']([^"']+)["']\s*\]|([^.[\]]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(path))) {
    if (m[1] !== undefined) parts.push(Number(m[1]));
    else parts.push(m[2] ?? m[3]);
  }
  let cur = obj;
  for (const p of parts) {
    if (cur == null) return undefined;
    cur = cur[p as any];
  }
  return cur;
}

/**
 * 解析 pick 表达式，支持可选的缩放后缀：
 * `f2/100`（除以 100）、`f3*0.01`（乘以 0.01）、`data.price`（原样）。
 */
export function parsePickExpr(expr: string): { path: string; scale?: { op: '/' | '*'; n: number } } {
  const m = String(expr ?? '').match(/^(.*?)\s*([*/])\s*(-?\d+(?:\.\d+)?)$/);
  if (!m) return { path: String(expr ?? '') };
  return { path: m[1], scale: { op: m[2] as '/' | '*', n: Number(m[3]) } };
}

/**
 * 把三方接口的原始响应整理成「模型友好」的简洁结构：
 * - 非 JSON 响应原样返回（老接口/纯文本不受影响）；
 * - extract 取子树 → pick 提取字段 → limit 截断数组；
 * - pick 值支持 `path/100`、`path*0.01` 缩放（东财/同花顺等接口常以 ×100 存价格）；
 * - 缺失字段输出 null（而不是让模型猜）。
 */
export function applyResponseMapping(text: string, cfg: ResponseMapping = {}): string {
  const mode = cfg.responseType || 'auto';
  if (mode === 'text') return text;
  let data: any;
  try {
    data = JSON.parse(text);
  } catch {
    return text;
  }
  if (cfg.extract) data = readPath(data, cfg.extract);
  if (cfg.pick && typeof cfg.pick === 'object') {
    // extract 得到数组时，pick 逐条应用（列表接口的常见形态）；否则对根节点应用
    const pickOne = (item: any) => {
      const out: Record<string, any> = {};
      for (const [k, raw] of Object.entries(cfg.pick!)) {
        const { path, scale } = parsePickExpr(String(raw ?? ''));
        let v = readPath(item, path);
        if (v !== undefined && v !== null && scale) {
          const num = Number(v);
          if (Number.isFinite(num)) v = scale.op === '/' ? num / scale.n : num * scale.n;
        }
        out[k] = v === undefined ? null : v;
      }
      return out;
    };
    data = Array.isArray(data) ? data.map(pickOne) : pickOne(data);
  }
  const limit = Number(cfg.limit || 0);
  if (Array.isArray(data) && limit > 0) data = data.slice(0, limit);
  if (data === undefined) return '(响应中未找到指定路径)';
  return typeof data === 'string' ? data : JSON.stringify(data, null, 2);
}
