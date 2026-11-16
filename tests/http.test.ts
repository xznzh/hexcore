import { describe, expect, it } from 'vitest';
import { decodeResponseBody, applyResponseMapping, readPath } from '@/lib/http';

// 「上证指数」的 GBK 字节（GBK 与 GB18030 兼容）
const GBK_SZZS = new Uint8Array([0xc9, 0xcf, 0xd6, 0xa4, 0xd6, 0xb8, 0xca, 0xfd]);

describe('lib/http decodeResponseBody', () => {
  it('按 Content-Type 的 charset=gbk 正确解码中文', () => {
    expect(decodeResponseBody(GBK_SZZS, 'text/plain; charset=GBK')).toBe('上证指数');
  });

  it('charset=gb2312 走 GB18030 超集解码', () => {
    expect(decodeResponseBody(GBK_SZZS, 'text/html; charset=gb2312')).toBe('上证指数');
  });

  it('无 charset 时嗅探 HTML meta', () => {
    const html = new Uint8Array([
      ...new TextEncoder().encode('<html><head><meta charset="gbk"></head><body>'),
      ...GBK_SZZS,
      ...new TextEncoder().encode('</body></html>'),
    ]);
    const out = decodeResponseBody(html, 'text/html');
    expect(out).toContain('上证指数');
  });

  it('无任何编码信息时按 UTF-8 解码', () => {
    const buf = new TextEncoder().encode('hello 世界');
    expect(decodeResponseBody(buf, 'text/plain')).toBe('hello 世界');
  });

  it('支持 ArrayBuffer 输入（fetch 的 arrayBuffer 返回值）', () => {
    const ab = GBK_SZZS.buffer.slice(GBK_SZZS.byteOffset, GBK_SZZS.byteOffset + GBK_SZZS.byteLength);
    expect(decodeResponseBody(ab as ArrayBuffer, 'text/plain; charset=gbk')).toBe('上证指数');
  });
});

describe('lib/http readPath / applyResponseMapping', () => {
  const raw = JSON.stringify({
    code: 0,
    data: {
      list: [
        { code: 'sh000001', name: '上证指数', price: 3692.3, extra: 'x' },
        { code: 'sz399001', name: '深证成指', price: 12345.6, extra: 'y' },
        { code: 'sz399006', name: '创业板指', price: 2345.6, extra: 'z' },
      ],
    },
  });

  it('readPath 支持点号与数组下标', () => {
    const j = JSON.parse(raw);
    expect(readPath(j, 'data.list[1].name')).toBe('深证成指');
    expect(readPath(j, 'data["list"][0].code')).toBe('sh000001');
    expect(readPath(j, 'data.missing.deep')).toBeUndefined();
  });

  it('extract 取子树 + pick 只保留需要的字段', () => {
    const out = JSON.parse(
      applyResponseMapping(raw, {
        extract: 'data.list',
        pick: { 代码: 'code', 名称: 'name', 现价: 'price' },
      }),
    );
    expect(out).toHaveLength(3);
    expect(out[0]).toEqual({ 代码: 'sh000001', 名称: '上证指数', 现价: 3692.3 });
    expect(out[0].extra).toBeUndefined();
  });

  it('limit 截断数组', () => {
    const out = JSON.parse(applyResponseMapping(raw, { extract: 'data.list', limit: 2 }));
    expect(out).toHaveLength(2);
    expect(out[1].name).toBe('深证成指');
  });

  it('pick 缺失路径输出 null，避免模型臆造', () => {
    const out = JSON.parse(applyResponseMapping('{"a":1}', { pick: { v: 'b.c' } }));
    expect(out).toEqual({ v: null });
  });

  it('非 JSON 响应原样返回（老接口/纯文本不受影响）', () => {
    expect(applyResponseMapping('v_sh000001="1~上证指数~3692.30"')).toBe('v_sh000001="1~上证指数~3692.30"');
  });

  it('responseType=text 时不做映射', () => {
    expect(applyResponseMapping('{"a":1}', { responseType: 'text', pick: { a: 'a' } })).toBe('{"a":1}');
  });

  it('pick 支持 path/100 与 path*0.01 缩放（东财等接口 ×100 存价格）', () => {
    const raw2 = JSON.stringify({ data: { diff: [{ f2: 369332, f3: 8 }, { f2: 1155044, f3: -106 }] } });
    const out = JSON.parse(
      applyResponseMapping(raw2, {
        extract: 'data.diff',
        pick: { 现价: 'f2/100', 涨跌幅: 'f3*0.01' },
      }),
    );
    expect(out[0]).toEqual({ 现价: 3693.32, 涨跌幅: 0.08 });
    expect(out[1]).toEqual({ 现价: 11550.44, 涨跌幅: -1.06 });
  });

  it('readPath 遇到非数字时缩放不生效，保留原值', () => {
    const out = JSON.parse(applyResponseMapping('{"a":"abc"}', { pick: { v: 'a/100' } }));
    expect(out.v).toBe('abc');
  });
});
