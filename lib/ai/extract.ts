import mammoth from 'mammoth';
import * as XLSX from 'xlsx';
import JSZip from 'jszip';

export type ExtractResult = { text: string; engine: string; error?: string };

/** 解析 XML 实体（w:t 文本节点内常见 &amp; 等） */
function decodeXmlEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

/** 单元格/段落里的内联标签：只保留文字，`<br>` 变空格 */
function inlineText(html: string): string {
  const s = html
    .replace(/<\s*br\s*\/?>/gi, ' ')
    .replace(/<[^>]+>/g, '');
  return decodeXmlEntities(s).replace(/[\s\u00a0]+/g, ' ').trim();
}

/** 非表格部分：块级标签转换行，其余标签剥掉 */
function blocksToText(html: string): string {
  const withBreaks = html
    .replace(/<\s*br\s*\/?>/gi, '\n')
    .replace(/<li[^>]*>/gi, '\n- ')
    .replace(/<\/(p|div|h[1-6]|li|ul|ol)>/gi, '\n');
  return decodeXmlEntities(withBreaks.replace(/<[^>]+>/g, ''))
    .split('\n')
    .map((line) => line.replace(/[\s\u00a0]+/g, ' ').trim())
    .filter(Boolean)
    .join('\n');
}

/** 表格 → 二维单元格文本。**不展开 colspan**：合并单元格是排版，不是语义列 */
function parseTableRows(tableHtml: string): string[][] {
  const rows: string[][] = [];
  const rowRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let rm: RegExpExecArray | null;
  while ((rm = rowRe.exec(tableHtml))) {
    const cells: string[] = [];
    const cellRe = /<t([dh])\b[^>]*>([\s\S]*?)<\/t\1>/gi;
    let cm: RegExpExecArray | null;
    while ((cm = cellRe.exec(rm[1]))) cells.push(inlineText(cm[2]));
    rows.push(cells);
  }
  return rows;
}

/** 表格里出现最多的单元格数（决定这张表是「键值对」还是「数据网格」） */
function dominantCols(rows: string[][]): number {
  const count = new Map<number, number>();
  for (const r of rows) count.set(r.length, (count.get(r.length) || 0) + 1);
  let cols = 0;
  let best = 0;
  for (const [k, v] of count) {
    if (v > best || (v === best && k > cols)) {
      cols = k;
      best = v;
    }
  }
  return cols;
}

/**
 * 单张表格 → 自描述文本。两种形态分开处理：
 *
 * - **两列（及以下）= 键值对表**：接口文档里的「请求方式 / Get」「请求说明 / 需要添加 header…」
 *   都是这种。合并单元格在这里只是把值横向撑开，读数就是「左边标签：右边值」。
 *   两列的数据表也走这条（输出 `示例新区：51`），仍然可读，只是没有列名重复。
 * - **三列以上 = 数据网格**：首行作列名，其余每行输出 `列名: 值；列名: 值`，
 *   并每 15 行重插一次表头——切片被切开后，后半段仍然带列语义。
 *
 * 为什么必须做这件事：`extractRawText` 会把表格还原成「一个单元格一行」，
 * 22 个分区 × 8 列的表变成 176 行裸数字，模型只能靠**数格子**对齐列，
 * 一旦有合并单元格就整体错位（同一指标读出两套值）。行记录自描述后，
 * 读到的每条都自带「哪个分区、哪个指标、多少」，也不怕被切片切断。
 */
function tableToText(rows: string[][], index: number): string {
  const nonEmpty = rows.filter((r) => r.some((c) => c));
  if (!nonEmpty.length) return '';
  const cols = dominantCols(nonEmpty);
  const header = nonEmpty[0].map((h, i) => h || `列${i + 1}`);

  // 三列以上、且首行确实像表头，才按数据网格处理。
  // 「像表头」= 每格都短、不是 URL/接口路径：接口说明卡的首行是 `采集点小时设备状态 | /api/…`，
  // 拿它当列名会让 74 行参数表每行都重复一遍长 URL（实测文本从 5k 字膨胀到 18k 字）。
  const asGrid = cols >= 3 && headerLooksLikeHeader(header);
  if (!asGrid) {
    const out = [`【表格 ${index}】`];
    for (const r of nonEmpty) {
      const key = r[0] || '';
      const val = r.slice(1).filter(Boolean).join(' ');
      if (!key && !val) continue;
      out.push(val ? `${key}：${val}` : key);
    }
    return out.length > 1 ? out.join('\n') : '';
  }

  const headLine = `【表格 ${index} | 列：${header.join('、')}】`;
  // 多行表头（如「区域｜振动…」下一行再写单位）要整段跳过：从第一条「像数据」的行开始输出。
  // 判据是「行内过半单元是短数值」，比「整行有没有数字」稳——单位行里 m3、μs 都带数字。
  let start = 1;
  for (let i = 1; i < nonEmpty.length; i++) {
    const r = nonEmpty[i];
    const numeric = r.filter(isNumericCell).length;
    if (numeric / r.length >= 0.5) {
      start = i;
      break;
    }
  }
  const out = [headLine];
  let n = 0;
  for (let i = start; i < nonEmpty.length; i++) {
    const r = nonEmpty[i];
    const vals = header.map((h, j) => (r[j] ? `${h}: ${r[j]}` : '')).filter(Boolean);
    if (!vals.length) continue;
    if (n > 0 && n % 15 === 0) out.push(`【表格 ${index}（续）| 列：${header.join('、')}】`);
    out.push(`第${i + 1}行 ${vals.join('；')}`);
    n++;
  }
  return out.length > 1 ? out.join('\n') : '';
}

/** 短数值单元：51 / 0.6 / 4.99 / 65-95 / —（表头里的「温度」「读数（℃）」不算） */
function isNumericCell(cell: string): boolean {
  const s = (cell || '').trim();
  return s.length > 0 && s.length <= 12 && /^[\d.,%<>~—\-+±/ ]+$/.test(s) && /\d/.test(s);
}

/** 首行是不是表头：每格都要短、且不能是 URL / 接口路径 / 长句 */
function headerLooksLikeHeader(header: string[]): boolean {
  return header.every(
    (h) => h.length > 0 && h.length <= 16 && !/^https?:/i.test(h) && !h.startsWith('/') && !/\s{2,}/.test(h),
  );
}

/**
 * mammoth 的 HTML → 纯文本，其中表格按「行记录自描述」输出（思路与 xlsx 分支一致）。
 * 纯函数，便于单测；不依赖 docx 二进制。
 */
export function htmlTablesToText(html: string): string {
  const src = (html || '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '');
  const tableRe = /<table[\s\S]*?<\/table>/gi;
  const parts: string[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  let idx = 0;
  while ((m = tableRe.exec(src))) {
    const before = blocksToText(src.slice(last, m.index));
    if (before) parts.push(before);
    idx++;
    const table = tableToText(parseTableRows(m[0]), idx);
    if (table) parts.push(table);
    last = m.index + m[0].length;
  }
  const tail = blocksToText(src.slice(last));
  if (tail) parts.push(tail);
  return parts.join('\n\n').replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * 纯 JS 兜底的 .docx 文本提取：不依赖 mammoth 的动态 require 链，
 * 直接用 jszip 解压并扫描 word/document.xml 的 w:t 文本节点（按 w:p 段落换行）。
 * mammoth 在 Turbopack 等打包环境下可能加载失败，此时退到这条路径。
 */
export async function extractRawDocxText(buf: Buffer): Promise<string> {
  const zip = await JSZip.loadAsync(buf);
  const entry = zip.file('word/document.xml');
  if (!entry) return '';
  const xml = await entry.async('string');
  const paragraphs = xml.split(/<\/w:p>/);
  const lines: string[] = [];
  for (const para of paragraphs) {
    let line = '';
    const re = /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:tab\b[^>]*\/>/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(para))) {
      line += m[1] !== undefined ? m[1] : '\t';
    }
    line = decodeXmlEntities(line).replace(/\s+/g, ' ').trim();
    if (line) lines.push(line);
  }
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * 从二进制办公文档中抽取纯文本。支持 PDF / DOCX / XLSX(XLS) / CSV。
 * 解析失败或解析为空时返回 text 为空 + error 原因（调用方据此标记「解析失败」而非「0 切片」）。
 * PDF 走动态 import(unpdf)，避免无谓加载 PDF 引擎。
 */
export async function extractTextFromBuffer(
  filename: string,
  buf: Buffer,
): Promise<ExtractResult> {
  const lower = (filename || '').toLowerCase();

  if (lower.endsWith('.pdf')) {
    try {
      const { extractText, getDocumentProxy } = await import('unpdf');
      const proxy = await getDocumentProxy(new Uint8Array(buf));
      const { text } = await extractText(proxy, { mergePages: true });
      const t = (text || '').trim();
      if (t) return { text: t, engine: 'unpdf' };
      return { text: '', engine: 'unpdf', error: 'PDF 中没有可提取的文字（可能是纯图片扫描件）' };
    } catch (e) {
      const reason = String((e as Error)?.message || e);
      console.error('[extract] PDF 解析失败:', reason);
      return { text: '', engine: 'unpdf', error: `PDF 解析失败（${reason.slice(0, 120)}）` };
    }
  }

  if (lower.endsWith('.docx')) {
    let mammothError = '';
    try {
      // 优先走 HTML：只有 HTML 里才留着表格的行列结构，extractRawText 会摊成一格一行
      const { value: html } = await mammoth.convertToHtml({ buffer: buf });
      const structured = htmlTablesToText(html || '');
      if (structured) return { text: structured, engine: 'mammoth-html' };
      const { value } = await mammoth.extractRawText({ buffer: buf });
      const t = (value || '').trim() || (await extractRawDocxText(buf));
      if (t) return { text: t, engine: 'mammoth' };
      return { text: '', engine: 'mammoth', error: '文档中没有文字内容（可能只有图片/格式）' };
    } catch (e) {
      mammothError = String((e as Error)?.message || e);
      console.error('[extract] mammoth 解析 .docx 失败，改用内置 ZIP 兜底:', mammothError.slice(0, 300));
    }
    try {
      const t = await extractRawDocxText(buf);
      if (t) return { text: t, engine: 'docx-zip-fallback' };
      return { text: '', engine: 'docx-zip-fallback', error: '文档中没有文字内容（可能只有图片/格式）' };
    } catch (e) {
      const reason = String((e as Error)?.message || e);
      console.error('[extract] .docx 兜底解析也失败:', reason);
      return {
        text: '',
        engine: 'docx-zip-fallback',
        error: `解析失败（${(mammothError || reason).slice(0, 120)}）。请确认文件是真 .docx（Word 2007+），而不是旧版 .doc 改名`,
      };
    }
  }

  if (lower.endsWith('.xlsx') || lower.endsWith('.xls') || lower.endsWith('.csv')) {
    try {
      // 安全缓解（BUG-019）：xlsx 0.18.5 存在原型污染(CVE-2023-30533)与 ReDoS(CVE-2024-22363)，
      // 官方 npm 包已停更，修复版仅在 SheetJS 自建 CDN（内网环境不可达）。
      // 这里对解析范围做硬限制：限制总行数与工作表数，压缩恶意构造文件的攻击窗口。
      // 根治需把 xlsx 换到 0.20.3+ 或改用 exceljs（详见 qa/tests/docs/BUG-TRACKING.csv）。
      const MAX_SHEET_ROWS = 20000;
      const MAX_SHEETS = 20;
      const wb = XLSX.read(buf, { type: 'buffer', sheetRows: MAX_SHEET_ROWS });
      // 关键：不能只用 sheet_to_csv —— 表头只会出现在全文开头，切片后
      // 绝大多数切片只剩裸数据行，模型无法理解每列含义。
      // 这里改为「行记录自描述」：每行输出为「列名: 值；列名: 值」，
      // 并每 GROUP 行插入空行 + 重复表头，配合 splitText 的空行分段，
      // 保证每个切片都自带列语义，表格数据才能被检索和回答。
      const GROUP = 15;
      const text = wb.SheetNames.slice(0, MAX_SHEETS).map((sheet) => {
        const ws = wb.Sheets[sheet];
        const rows = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, raw: false, defval: '' }) || [];
        if (!rows.length) return '';
        const headers = (rows[0] as unknown[]).map((h) => String(h ?? '').trim());
        const headerLine = headers.filter(Boolean).join('、') || `共${headers.length}列`;
        const lines: string[] = [`【工作表: ${sheet} | 列：${headerLine}】`];
        let n = 0;
        for (let r = 1; r < rows.length; r++) {
          const row = rows[r] as unknown[];
          if (!row || row.every((c) => String(c ?? '').trim() === '')) continue;
          const rec = headers
            .map((h, i) => ({ h: h || `列${i + 1}`, v: String(row[i] ?? '').trim() }))
            .filter((x) => x.v !== '')
            .map((x) => `${x.h}: ${x.v}`)
            .join('；');
          if (!rec) continue;
          if (n > 0 && n % GROUP === 0) {
            lines.push('', `【工作表: ${sheet}（续）| 列：${headerLine}】`);
          }
          lines.push(`第${r}行 ${rec}`);
          n++;
        }
        return lines.join('\n');
      })
        .filter(Boolean)
        .join('\n\n');
      const t = text.trim();
      if (t) return { text: t, engine: 'xlsx-rows' };
      return { text: '', engine: 'xlsx-rows', error: '表格中没有数据行' };
    } catch (e) {
      const reason = String((e as Error)?.message || e);
      console.error('[extract] Excel/CSV 解析失败:', reason);
      return { text: '', engine: 'xlsx-rows', error: `Excel 解析失败（${reason.slice(0, 120)}）` };
    }
  }

  return { text: '', engine: 'unsupported', error: '不支持的文件格式' };
}

/** 暂不支持二进制的格式清单（用于给出友好提示） */
export const UNSUPPORTED_HINT =
  '暂仅支持：PDF、Word(.docx)、Excel(.xlsx/.xls)、CSV，以及 .txt/.md/.json/.py/.java 等纯文本。旧版 .doc / .pptx 暂不支持解析。';
