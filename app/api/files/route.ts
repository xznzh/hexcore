import { NextRequest, NextResponse } from 'next/server';
import { ensureInit, db } from '@/lib/db';
import { files, users, conversations } from '@/lib/schema';
import { and, eq, sql } from 'drizzle-orm';
import { getSession } from '@/lib/auth';
import { newId, logAction } from '@/lib/util';
import { canAccessProject } from '@/lib/projects';
import { userDir, safeName } from '@/lib/storage';
import fs from 'fs/promises';
import path from 'path';
import { failResponse } from '@/lib/api/handler';

export const dynamic = 'force-dynamic';

/** 单文件大小上限（上传时整块读入内存，必须有硬上限） */
const MAX_FILE_SIZE = 100 * 1024 * 1024;

/**
 * multipart 除文件内容外的额外开销（boundary、字段名、其他表单字段）。
 * 只用于「先粗筛」，比真实开销宽很多——粗筛放过之后还有按 `File.size` 的精确判定。
 */
const MULTIPART_OVERHEAD = 2 * 1024 * 1024;

/** 配额不足（在事务内抛出以便回滚，再由外层转成 403） */
class QuotaExceeded extends Error {}

export async function GET(req: NextRequest) {
  await ensureInit();
  const s = await getSession();
  if (!s) return failResponse(req, 401, 'UNAUTHORIZED', '未登录');
  const conversationId = req.nextUrl.searchParams.get('conversationId');
  // 过滤条件下推到 SQL（原实现是「把该用户全部文件拉进内存再 filter」，文件一多就白读整表）；
  // 只取列表需要的列，不把 path/mime 等无关字段带回来。
  const where = conversationId
    ? and(eq(files.ownerId, s.userId), eq(files.conversationId, conversationId))
    : eq(files.ownerId, s.userId);
  const rows = await db
    .select({
      id: files.id,
      filename: files.filename,
      size: files.size,
      scope: files.scope,
      projectId: files.projectId,
      conversationId: files.conversationId,
      createdAt: files.createdAt,
    })
    .from(files)
    .where(where)
    .orderBy(files.createdAt);
  return NextResponse.json(rows);
}

export async function POST(req: NextRequest) {
  await ensureInit();
  const s = await getSession();
  if (!s) return failResponse(req, 401, 'UNAUTHORIZED', '未登录');
  if (s.role === 'guest') return NextResponse.json({ error: '访客无写入权限' }, { status: 403 });

  // 上限校验必须在「读进内存」之前，否则这个上限等于没有（V8.10）。
  //
  // 原顺序是：formData() → arrayBuffer() → 判 size。也就是说 100MB 的上限
  // 并没有阻止 100MB 被读进内存——真正被拦下的只有"已经吃完内存"的请求，
  // 唯一效果是把 500 变成了 413。两个前置闸门：
  //   闸门 1：Content-Length（便宜，但分块上传没有这个头，所以不能只靠它）
  //   闸门 2：`File.size`（multipart 解析后就有，不必先 arrayBuffer）
  const declared = Number(req.headers.get('content-length') || 0);
  if (Number.isFinite(declared) && declared > MAX_FILE_SIZE + MULTIPART_OVERHEAD) {
    return NextResponse.json(
      { error: `单个文件不能超过 ${MAX_FILE_SIZE / 1024 / 1024} MB` },
      { status: 413 },
    );
  }

  // formData 解析可能因请求体超限/中断而抛错（Next 15 默认 10MB 会截断 body，
  // 本项目已在 next.config 放宽到 110MB）。兜底成 413，避免异常冒泡成空响应的 500。
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json({ error: '请求体过大或格式不正确' }, { status: 413 });
  }
  const file = form.get('file');
  const projectId = (form.get('projectId') as string) || null;
  const conversationId = (form.get('conversationId') as string) || null;
  if (!file || typeof file === 'string') return NextResponse.json({ error: '未找到文件' }, { status: 400 });

  // 归属校验：projectId / conversationId 都是客户端表单传来的，必须确认当前用户有权写入，
  // 否则可以把文件「塞进」别人的项目文件列表或别人的会话里（越权注入 + 污染他人的项目视图）。
  if (projectId && !(await canAccessProject(projectId, s.userId, s.role))) {
    return NextResponse.json({ error: '无权写入该项目' }, { status: 403 });
  }
  if (conversationId) {
    const conv = (
      await db.select({ userId: conversations.userId }).from(conversations).where(eq(conversations.id, conversationId)).limit(1)
    )[0];
    if (!conv || conv.userId !== s.userId) {
      return NextResponse.json({ error: '无权写入该会话' }, { status: 403 });
    }
  }
  // scope 由 projectId 推导，不接受客户端随意指定（避免 scope='project' 却没有 projectId 的脏数据）
  const scope = projectId ? 'project' : 'personal';

  const f = file as File;
  // 闸门 2：`File.size` 在 multipart 解析后即可读，不必先把内容取出来。
  // 分块上传没有 Content-Length，这一个才是真正的兜底。
  if (typeof f.size === 'number' && f.size > MAX_FILE_SIZE) {
    return NextResponse.json({ error: `单个文件不能超过 ${MAX_FILE_SIZE / 1024 / 1024} MB` }, { status: 413 });
  }
  const buf = Buffer.from(await f.arrayBuffer());
  const size = buf.length;
  // 单文件上限：内容要整块读进内存后再落盘，过大文件会直接把进程内存打爆
  if (size > MAX_FILE_SIZE) {
    return NextResponse.json({ error: `单个文件不能超过 ${MAX_FILE_SIZE / 1024 / 1024} MB` }, { status: 413 });
  }

  // 存储配额校验（用 SQL 求和，原实现把该用户全部文件行拉进内存再 reduce）
  const me = (await db.select().from(users).where(eq(users.id, s.userId)).limit(1))[0];
  const quota = me?.storageQuota ?? 1024 * 1024 * 1024; // ?? 而非 ||：0 表示禁止存储，不能被当成默认 1GB

  const storedName = `${newId('f')}_${safeName(f.name || 'file')}`;
  const dir = userDir(s.userId);
  const absPath = path.join(dir, storedName);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(absPath, buf);

  const id = newId('file');
  try {
    // 「求和判配额 → 插入记录」必须原子：原实现两条语句之间有窗口，并发上传可同时通过检查而突破配额（BUG-010）。
    // 用户级咨询锁把同一用户的上传串行化，事务结束自动释放；不同用户互不阻塞。
    await db.transaction(async (tx: any) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`upload-quota:${s.userId}`})::bigint)`);
      const usedRows = await tx.execute(
        sql`select coalesce(sum(size),0)::bigint as v from files where owner_id = ${s.userId}`,
      );
      const used = Number(usedRows?.[0]?.v ?? 0);
      if (used + size > quota) throw new QuotaExceeded();
      await tx.insert(files).values({
        id,
        ownerId: s.userId,
        scope,
        projectId,
        conversationId,
        filename: f.name || 'file',
        path: `${s.userId}/${storedName}`,
        size,
        mime: f.type || null,
        createdAt: Date.now(),
      });
    });
  } catch (e) {
    // 入账失败则把已落盘的文件删掉，避免产生「有文件无记录」的孤儿文件占用磁盘
    await fs.unlink(absPath).catch(() => {});
    if (e instanceof QuotaExceeded) {
      return NextResponse.json({ error: '存储配额不足，请联系管理员调整' }, { status: 403 });
    }
    throw e;
  }

  await logAction(s.userId, 'file_upload', f.name || 'file');
  return NextResponse.json({ ok: true, id, filename: f.name });
}
