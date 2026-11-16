import { NextRequest, NextResponse } from 'next/server';
import { ensureInit, db } from '@/lib/db';
import { files } from '@/lib/schema';
import { eq } from 'drizzle-orm';
import { getSession } from '@/lib/auth';
import { logAction } from '@/lib/util';
import { resolveSafe } from '@/lib/storage';
import { extractTextFromBuffer } from '@/lib/ai/extract';
import { readFile, unlink } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { Readable } from 'node:stream';
import { failResponse } from '@/lib/api/handler';

export const dynamic = 'force-dynamic';

// 下载（?preview=1 则返回可预览内容）
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  await ensureInit();
  const s = await getSession();
  if (!s) return failResponse(req, 401, 'UNAUTHORIZED', '未登录');
  const f = (await db.select().from(files).where(eq(files.id, id)).limit(1))[0];
  // 区分「不存在」与「无权」：合并成 403 会让用户删除文件后再访问时看到「无权访问」，
  // 误以为是权限故障。这里不泄漏他人文件的存在性——不存在统一 404，存在但非本人仍 403。
  if (!f) return NextResponse.json({ error: '文件不存在' }, { status: 404 });
  if (f.ownerId !== s.userId) return NextResponse.json({ error: '无权访问' }, { status: 403 });

  if (req.nextUrl.searchParams.get('preview')) {
    const buf = await readFile(resolveSafe(f.path)).catch(() => null);
    if (!buf) return NextResponse.json({ error: '文件不存在' }, { status: 404 });
    const name = f.filename.toLowerCase();

    // 图片
    if ((f.mime || '').startsWith('image/') || /\.(png|jpe?g|gif|webp|bmp|svg)$/.test(name)) {
      return NextResponse.json({ kind: 'image', mime: f.mime || 'image/png', data: buf.toString('base64') });
    }

    // Excel / CSV → 表格
    if (/\.(xlsx|xls|csv|tsv)$/.test(name)) {
      try {
        const XLSX: any = await import('xlsx');
        // 安全缓解（BUG-019）：限制解析行数，压缩 xlsx 0.18.5 的 ReDoS/原型污染攻击窗口
        const wb = XLSX.read(buf, { type: 'buffer', sheetRows: 1000 });
        const sheets = (wb.SheetNames as string[]).slice(0, 8).map((sheetName) => {
          const ws = wb.Sheets[sheetName];
          const arr = (XLSX.utils.sheet_to_json(ws, { header: 1, raw: false, defval: '' }) as any[][]) || [];
          const headers = (arr[0] || []).map((h) => String(h ?? ''));
          const rows = arr.slice(1, 1001).map((r) => headers.map((_, i) => String(r?.[i] ?? '')));
          return { name: sheetName, headers, rows };
        });
        return NextResponse.json({ kind: 'sheet', sheets });
      } catch (e: any) {
        console.error('[preview] xlsx 解析失败:', e?.message || e);
        /* 解析失败则继续走文本兜底 */
      }
    }

    // Word (.docx) → HTML
    if (name.endsWith('.docx')) {
      try {
        const mod: any = await import('mammoth');
        const mammoth: any = mod.default || mod;
        const { value } = await mammoth.convertToHtml({ buffer: buf });
        return NextResponse.json({ kind: 'doc', html: String(value || '').slice(0, 300000) });
      } catch (e: any) {
        console.error('[preview] docx 解析失败:', e?.message || e);
        /* 继续兜底 */
      }
    }

    // 旧版 .doc
    if (name.endsWith('.doc')) {
      return NextResponse.json({ kind: 'unsupported', message: '旧版 .doc 暂不支持内联预览，请另存为 .docx 或下载查看。' });
    }

    // PDF → 浏览器内嵌查看
    if (name.endsWith('.pdf')) {
      return NextResponse.json({ kind: 'pdf', url: `/api/files/${id}?inline=1` });
    }

    // 文本类
    const text = buf.toString('utf8');
    const sample = text.slice(0, 2000);
    const printable = (sample.match(/[\x09\x0a\x0d\x20-\x7e一-鿿]/g) || []).length;
    if (sample.length && printable / sample.length > 0.85) {
      if (/\.(md|markdown)$/.test(name)) return NextResponse.json({ kind: 'markdown', text: text.slice(0, 200000) });
      return NextResponse.json({ kind: 'text', text: text.slice(0, 200000) });
    }

    // 其他二进制：用抽取的纯文本兜底
    const ex = await extractTextFromBuffer(f.filename, buf);
    if (ex?.text) return NextResponse.json({ kind: 'text', text: ex.text.slice(0, 200000) });
    return NextResponse.json({ kind: 'binary' });
  }

  try {
    const abs = resolveSafe(f.path);
    const inline = req.nextUrl.searchParams.get('inline');
    const lower = f.filename.toLowerCase();
    const guess = lower.endsWith('.pdf')
      ? 'application/pdf'
      : lower.endsWith('.md')
        ? 'text/markdown; charset=utf-8'
        : lower.endsWith('.txt')
          ? 'text/plain; charset=utf-8'
          : 'application/octet-stream';

    // 流式返回（大文件更省内存）；先等文件句柄打开，确保 404 判断有效
    const stream = createReadStream(abs);
    await new Promise<void>((resolve, reject) => {
      stream.once('open', () => resolve());
      stream.once('error', reject);
    });
    return new NextResponse(Readable.toWeb(stream) as any, {
      headers: {
        'Content-Type': f.mime || guess,
        'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename="${encodeURIComponent(f.filename)}"`,
      },
    });
  } catch {
    return NextResponse.json({ error: '文件不存在' }, { status: 404 });
  }
}

// 重命名 / 移动（改归属项目）
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  await ensureInit();
  const s = await getSession();
  if (!s) return failResponse(req, 401, 'UNAUTHORIZED', '未登录');
  if (s.role === 'guest') return NextResponse.json({ error: '访客无写入权限' }, { status: 403 });
  const f = (await db.select().from(files).where(eq(files.id, id)).limit(1))[0];
  // 区分「不存在」与「无权」：合并成 403 会让用户删除文件后再访问时看到「无权访问」，
  // 误以为是权限故障。这里不泄漏他人文件的存在性——不存在统一 404，存在但非本人仍 403。
  if (!f) return NextResponse.json({ error: '文件不存在' }, { status: 404 });
  if (f.ownerId !== s.userId) return NextResponse.json({ error: '无权访问' }, { status: 403 });
  const body = await req.json().catch(() => null);
  const patch: Record<string, unknown> = {};
  if (typeof body?.filename === 'string') {
    const filename = body.filename.trim();
    if (!filename) return NextResponse.json({ error: '文件名不能为空' }, { status: 400 });
    patch.filename = filename;
  }
  if ('projectId' in (body || {})) {
    patch.projectId = body.projectId || null;
    patch.scope = body.projectId ? 'project' : 'personal';
  }
  if (Object.keys(patch).length === 0) return NextResponse.json({ error: '无可更新字段' }, { status: 400 });
  await db.update(files).set(patch).where(eq(files.id, id));
  await logAction(s.userId, 'file_update', f.filename);
  return NextResponse.json({ ok: true });
}

// 删除
export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  await ensureInit();
  const s = await getSession();
  if (!s) return failResponse(_req, 401, 'UNAUTHORIZED', '未登录');
  if (s.role === 'guest') return NextResponse.json({ error: '访客无写入权限' }, { status: 403 });
  const f = (await db.select().from(files).where(eq(files.id, id)).limit(1))[0];
  // 区分「不存在」与「无权」：合并成 403 会让用户删除文件后再访问时看到「无权访问」，
  // 误以为是权限故障。这里不泄漏他人文件的存在性——不存在统一 404，存在但非本人仍 403。
  if (!f) return NextResponse.json({ error: '文件不存在' }, { status: 404 });
  if (f.ownerId !== s.userId) return NextResponse.json({ error: '无权访问' }, { status: 403 });
  await unlink(resolveSafe(f.path)).catch(() => {});
  await db.delete(files).where(eq(files.id, id));
  await logAction(s.userId, 'file_delete', f.filename);
  return NextResponse.json({ ok: true });
}
