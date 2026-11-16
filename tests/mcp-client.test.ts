import { describe, expect, it } from 'vitest';
import { flattenToolContent, parseJsonRpcBody, parseSseBody } from '@/lib/mcp/client';
import { mcpToolKey, sanitizeToolName } from '@/lib/tools/mcp-tools';

/**
 * MCP 客户端最容易出错的是「响应解析」：同一个端点可能返回一次性 JSON，
 * 也可能返回 SSE 流；批量返回时还可能是一个数组。这里把三种形态都钉住。
 */
describe('lib/mcp 协议解析', () => {
  it('解析一次性 JSON 响应', () => {
    const msg = parseJsonRpcBody('{"jsonrpc":"2.0","id":1,"result":{"tools":[]}}', 1);
    expect(msg?.result).toEqual({ tools: [] });
  });

  it('数组批量返回时按 id 命中', () => {
    const body = JSON.stringify([
      { jsonrpc: '2.0', method: 'notifications/progress', params: {} },
      { jsonrpc: '2.0', id: 7, result: { ok: true } },
    ]);
    expect(parseJsonRpcBody(body, 7)?.result).toEqual({ ok: true });
    expect(parseJsonRpcBody(body, 9)).toBeNull();
  });

  it('解析 SSE 流，跳过通知帧与坏帧', () => {
    const sse = [
      'event: message',
      'data: {"jsonrpc":"2.0","method":"notifications/message","params":{}}',
      '',
      'data: {"jsonrpc":"2.0","id":2,"result":{"content":[{"type":"text","text":"hi"}]}}',
      '',
      'data: not-json',
      '',
    ].join('\n');
    const msg = parseSseBody(sse, 2);
    expect(msg?.result?.content?.[0]?.text).toBe('hi');
  });

  it('SSE 中没有匹配 id 时返回 null（交给上层报「协议不兼容」）', () => {
    expect(parseSseBody('data: {"jsonrpc":"2.0","id":1,"result":{}}', 2)).toBeNull();
  });

  it('错误响应能被上层识别', () => {
    const msg = parseJsonRpcBody('{"jsonrpc":"2.0","id":3,"error":{"code":-32601,"message":"Method not found"}}', 3);
    expect(msg?.error?.code).toBe(-32601);
  });

  it('tools/call 结果压平为文本', () => {
    expect(flattenToolContent([{ type: 'text', text: '温度=36' }, { type: 'text', text: 'EHI=96' }])).toBe('温度=36\nEHI=96');
    expect(flattenToolContent('纯文本')).toBe('纯文本');
    expect(flattenToolContent(undefined)).toBe('');
  });

  it('工具名做命名空间与净化，避免不同服务的同名工具互相覆盖', () => {
    expect(sanitizeToolName('read file/路径')).toBe('read_file');
    // 纯中文名净化后为空 → 用短哈希兜底，保证不同连接器不塌缩成同一个名字
    const a = sanitizeToolName('本地文件');
    const b = sanitizeToolName('知识库');
    expect(a).toMatch(/^t_[a-z0-9]+$/);
    expect(a).not.toBe(b);
    expect(sanitizeToolName('本地文件')).toBe(a); // 稳定
    expect(mcpToolKey('local', 'read-file')).toBe('mcp__local__read-file');
    // 长名截断，保证各模型都能接受
    expect(sanitizeToolName('a'.repeat(80), 10)).toHaveLength(10);
  });
});
