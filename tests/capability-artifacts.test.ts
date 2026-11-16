import { describe, expect, it } from 'vitest';
import { artifactLinks } from '@/lib/tools/capability-tools';

/**
 * 能力产物回捞。
 *
 * 回归背景：能力调用成功后返回的是一段文本 + 末尾 JSON（形如 `completed\n{...artifacts:[{url,filename}]}`），
 * 模型常常只复述文件名而把 url 丢掉，用户拿不到下载链接。这里保证「文件名 + 链接」能被稳定抽出来。
 */
describe('lib/tools/capability-tools . artifactLinks', () => {
  it('从成功结果里抽出文件名与下载链接', () => {
    const out =
      'completed\n{\n  "status": "completed",\n  "output": { "fileName": "报表_20261026.xls" },\n' +
      '  "artifacts": [\n    { "url": "http://x/api/files/1?sign=a", "filename": "报表_20261026.xls", "size": 999424 }\n  ]\n}';
    expect(artifactLinks(out)).toEqual([{ filename: '报表_20261026.xls', url: 'http://x/api/files/1?sign=a' }]);
  });

  it('无 artifacts / 非法 JSON / 缺 url 时返回空数组（不抛错）', () => {
    expect(artifactLinks('completed\n{"status":"completed"}')).toEqual([]);
    expect(artifactLinks('纯文本，没有 JSON')).toEqual([]);
    expect(artifactLinks('{"artifacts":[{"filename":"a.xls"}]}')).toEqual([]);
  });

  it('缺少 filename 时给一个可读的兜底名', () => {
    expect(artifactLinks('{"artifacts":[{"url":"http://x/1"}]}')).toEqual([{ filename: '下载文件', url: 'http://x/1' }]);
  });
});
