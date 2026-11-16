import { NextRequest, NextResponse } from 'next/server';
import { ensureInit } from '@/lib/db';
import { getSession } from '@/lib/auth';
import { llmExpand, buildDocx, markdownToPlainText } from '@/lib/generate';
import { addUsage, logAction, estimateTokens } from '@/lib/util';
import { checkRateLimit } from '@/lib/redis';
import { canAccessProject } from '@/lib/projects';
import { visibleKbIds } from '@/lib/kb-access';
import { checkQuota } from '@/lib/quota';
import { saveArtifact } from '@/lib/artifacts';
import { failResponse } from '@/lib/api/handler';

export const dynamic = 'force-dynamic';

const FORMATS = {
  docx: { ext: 'docx', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' },
  md: { ext: 'md', mime: 'text/markdown; charset=utf-8' },
  txt: { ext: 'txt', mime: 'text/plain; charset=utf-8' },
} as const;
type Format = keyof typeof FORMATS;

export async function POST(req: NextRequest) {
  await ensureInit();
  const s = await getSession();
  if (!s) return failResponse(req, 401, 'UNAUTHORIZED', '未登录');
  if (s.role === 'guest') return NextResponse.json({ error: '访客无写入权限' }, { status: 403 });

  const allowed = await checkRateLimit(`ratelimit:gen:${s.userId}`, 20, 60);
  if (!allowed) return NextResponse.json({ error: '生成过于频繁，请稍后再试' }, { status: 429 });

  // V8.3 · R7：额度闸门（与 chat / skills / scheduler 同一口径）。
  // 原来这条链路只有频率限制、没有额度判断 —— 单次生成动辄几千 token，
  // 超限用户在对话框里被 block 拦住，却可以在这里继续生成，额度机制形同虚设。
  const quota = await checkQuota(s.userId);
  if (quota.exceeded) {
    return NextResponse.json(
      { error: `本月 Token 额度已用尽（已用 ${quota.used} / 额度 ${quota.limit}），请联系管理员调整额度` },
      { status: 429 },
    );
  }

  const body = await req.json().catch(() => null);
  const brief: string = body?.brief?.trim();
  if (!brief) return NextResponse.json({ error: '请输入主题或要点' }, { status: 400 });

  const fmtRaw = String(body?.format || 'docx').toLowerCase();
  const format: Format = (fmtRaw in FORMATS ? fmtRaw : 'docx') as Format;

  const projectId: string | null = body?.projectId || null;
  if (projectId && !(await canAccessProject(projectId, s.userId, s.role))) {
    return NextResponse.json({ error: '无权归属该项目' }, { status: 403 });
  }

  // V8.3 · R6：文档生成若勾选「引用知识库」，检索范围必须按当前用户的可见库限定，
  // 否则会退化成全库检索（含别人的个人库）。仅在真正要检索时才查，省一次往返。
  const kbScope = body?.useKb ? await visibleKbIds(s.userId, s.role) : undefined;
  const { title, body: md } = await llmExpand(brief, body?.modelId, 'doc', !!body?.useKb, '', kbScope);
  await addUsage(s.userId, estimateTokens(brief) + estimateTokens(md));
  await logAction(s.userId, 'generate_doc', title);

  const safe = title.replace(/[^\w一-鿿-]+/g, '_').slice(0, 50) || 'document';
  const { ext, mime } = FORMATS[format];

  // Markdown / 纯文本：直接输出正文；Word：走 docx 生成器
  // （正文里若已有一级标题则不重复加，避免标题出现两次）
  const mdBody = md.replace(/^\s*#\s+.*(?:\r?\n)+/, '');
  const payload =
    format === 'docx'
      ? await buildDocx(title, md)
      : Buffer.from(format === 'md' ? `# ${title}\n\n${mdBody}\n` : markdownToPlainText(`${title}\n\n${mdBody}`), 'utf8');

  const filename = `${safe}.${ext}`;
  try {
    await saveArtifact({
      ownerId: s.userId,
      projectId,
      conversationId: body?.conversationId || null,
      type: 'doc',
      title,
      filename,
      buf: payload,
    });
  } catch {
    /* 归档失败不影响下载 */
  }

  return new NextResponse(payload as any, {
    headers: {
      'Content-Type': mime,
      'Content-Disposition': `attachment; filename="${encodeURIComponent(filename)}"`,
    },
  });
}
