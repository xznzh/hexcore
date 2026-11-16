import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { buildDocx } from '@/lib/generate';
import { extractTextFromBuffer, extractRawDocxText, htmlTablesToText } from '@/lib/ai/extract';

/** 在 data/files 里找一份真实上传的接口手册（找不到就跳过，不卡门禁） */
function findSampleDocx(): string | null {
  const root = path.join(process.cwd(), 'data/files');
  if (!fs.existsSync(root)) return null;
  for (const dir of fs.readdirSync(root)) {
    const sub = path.join(root, dir);
    if (!fs.statSync(sub).isDirectory()) continue;
    const hit = fs.readdirSync(sub).find((f) => f.endsWith('.docx') && f.includes('接口使用手册'));
    if (hit) return path.join(sub, hit);
  }
  return null;
}

function bufOf(b: Buffer): Buffer {
  return b;
}

describe('lib/ai/extract .docx 解析', () => {
  it('mammoth 主路径：能从生成器产出的 docx 中提取标题与正文', async () => {
    const docx = bufOf(
      await buildDocx('产品定价方案', '基础定价说明：先写一句话。\n\n## 阶段定价\n- 试用版：0 元\n- 标准版：99 元'),
    );
    const r = await extractTextFromBuffer('测试文档.docx', docx);
    expect(r.text.length).toBeGreaterThan(0);
    expect(r.text).toContain('产品定价方案');
    expect(r.text).toContain('标准版');
    expect(r.engine).toBe('mammoth-html');
  });

  it('兜底路径（jszip 直读 document.xml）：不经过 mammoth 也能提取文本', async () => {
    const docx = bufOf(
      await buildDocx('环境治理应急预案', '应急响应分为四级。\n\n## 处置流程\n一、接警与研判。二、启动预案。'),
    );
    const t = await extractRawDocxText(docx);
    expect(t).toContain('环境治理应急预案');
    expect(t).toContain('应急响应分为四级');
    expect(t).toContain('启动预案');
  });

  it('解析结果始终返回对象，损坏数据时 text 为空但 error 有原因', async () => {
    const r = await extractTextFromBuffer('损坏.docx', Buffer.from('this is not a real docx'));
    expect(r).toHaveProperty('engine');
    expect(r.text).toBe('');
    expect((r.error || '').length).toBeGreaterThan(0);
  });
});

describe('htmlTablesToText（docx 表格按行列还原）', () => {
  it('两列键值对表输出成「标签：值」，不会被摊成一格一行', () => {
    const html =
      '<table>' +
      '<tr><td><p>获取token</p></td><td colspan="3"><p>/api/GetExternalApiToken?UserName={username}</p></td></tr>' +
      '<tr><td><p>请求方式</p></td><td colspan="3"><p>Get</p></td></tr>' +
      '<tr><td><p>请求说明</p></td><td colspan="3"><p>需要添加 header 参数：Authorization 和 X-Api-Key</p></td></tr>' +
      '</table>';
    const text = htmlTablesToText(html);
    expect(text).toContain('获取token：/api/GetExternalApiToken?UserName={username}');
    expect(text).toContain('请求方式：Get');
    expect(text).toContain('请求说明：需要添加 header 参数：Authorization 和 X-Api-Key');
    // 键值对表不该出现「整行只有一个标签」的老形态
    expect(text.split('\n').filter((l) => l.trim() === '请求方式')).toHaveLength(0);
  });

  it('多列数据网格每行自描述，列名来自首行', () => {
    const head = '<tr><td><p>区域</p></td><td><p>振动</p></td><td><p>电流</p></td><td><p>温度</p></td></tr>';
    const row = (name: string, vib: string, amp: string, temp: string) =>
      `<tr><td><p>${name}</p></td><td><p>${vib}</p></td><td><p>${amp}</p></td><td><p>${temp}</p></td></tr>`;
    const text = htmlTablesToText(`<table>${head}${row('示例新区', '6', '24', '51')}${row('甲区', '7', '22', '48')}</table>`);
    expect(text).toContain('【表格 1 | 列：区域、振动、电流、温度】');
    expect(text).toContain('区域: 甲区；振动: 7；电流: 22；温度: 48');
  });

  it('表头里的单位行（整行无数字）不会混进数据行', () => {
    const html =
      '<table>' +
      '<tr><td><p>区域</p></td><td><p>温度</p></td><td><p>湿度</p></td></tr>' +
      '<tr><td><p>读数（℃）</p></td><td><p>读数（℃）</p></td><td><p>读数（℃）</p></td></tr>' +
      '<tr><td><p>示例新区</p></td><td><p>51</p></td><td><p>39</p></td></tr>' +
      '</table>';
    const text = htmlTablesToText(html);
    expect(text).toContain('区域: 示例新区；温度: 51；湿度: 39');
    expect(text).not.toContain('区域: 读数（℃）');
  });

  it('大表每 15 行重插一次表头，切片被切开后后半段仍带列语义', () => {
    const head = '<tr><td><p>区域</p></td><td><p>温度</p></td><td><p>湿度</p></td></tr>';
    const rows = Array.from(
      { length: 20 },
      (_, i) => `<tr><td><p>区${i}</p></td><td><p>${10 + i}</p></td><td><p>${20 + i}</p></td></tr>`,
    ).join('');
    const text = htmlTablesToText(`<table>${head}${rows}</table>`);
    expect(text).toContain('【表格 1（续）| 列：区域、温度、湿度】');
  });

  it('表格前后的正文顺序不乱，HTML 实体被还原', () => {
    const html =
      '<h1>周报</h1><p>表 1：各区读数 &amp; 排名</p>' +
      '<table><tr><td><p>区域</p></td><td><p>温度</p></td></tr><tr><td><p>示例新区</p></td><td><p>51</p></td></tr></table>' +
      '<p>表后说明 &lt;完&gt;</p>';
    const text = htmlTablesToText(html);
    const a = text.indexOf('表 1：各区读数 & 排名');
    const b = text.indexOf('【表格 1');
    const c = text.indexOf('表后说明 <完>');
    expect(a).toBeGreaterThanOrEqual(0);
    expect(b).toBeGreaterThan(a);
    expect(c).toBeGreaterThan(b);
  });

  it('空表格与纯文本都不抛错', () => {
    expect(htmlTablesToText('<table></table>')).toBe('');
    expect(htmlTablesToText('<p>只有文字</p>')).toBe('只有文字');
    expect(htmlTablesToText('')).toBe('');
  });
});

describe('extractTextFromBuffer 真实文件（表格语义）', () => {
  const docx = findSampleDocx();

  it.skipIf(!docx)('接口手册的表格被还原成自描述记录，而不是一格一行', async () => {
    const r = await extractTextFromBuffer('接口手册.docx', fs.readFileSync(docx!));
    expect(r.engine).toBe('mammoth-html');
    // 键值对表：请求方式/Get 这类必须成对出现
    expect(r.text).toMatch(/请求方式：\s*Get/);
    // 采集点枚举表：键 1..4 与取值成对
    expect(r.text).toMatch(/1：\s*国控站/);
    // 不该再出现「整行只有一个单元格词」的摊平形态
    const flat = r.text.split('\n').filter((l) => /^(振动|电流|湿度|温度)$/.test(l.trim()));
    expect(flat).toHaveLength(0);
  });
});
