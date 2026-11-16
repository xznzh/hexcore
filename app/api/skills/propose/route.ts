import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { skillProposals } from '@/lib/schema';
import { newId, logAction } from '@/lib/util';
import { parseSkillRef, fetchSkillMeta } from '@/lib/skills/hub';
import { withApi, apiError } from '@/lib/api/handler';

export const dynamic = 'force-dynamic';

/**
 * 发起「安装技能」提议：只读拉取技能元信息与 SKILL.md，生成一条待确认的提议。
 * 这里**不写入技能表**——必须由管理员在界面点「确认安装」后才会真正安装。
 */
export const POST = withApi(async ({ req, session }) => {
  const s = session;
  if (s.role === 'guest') apiError(403, 'FORBIDDEN', '访客无权安装技能');

  const body = await req.json().catch(() => ({}));
  const refRaw = String(body?.ref || '').trim();
  if (!refRaw) apiError(400, 'INVALID_ARGUMENT', '请提供技能引用（如 @handle/slug）');

  const ref = parseSkillRef(refRaw);
  if (!ref) {
    apiError(
      400,
      'INVALID_ARGUMENT',
      '无法解析技能引用。支持：@handle/slug、https://skillhub.cn/@handle/slug、https://skills.sh/owner/repo/skill、owner/repo/skill',
    );
  }

  let meta: Awaited<ReturnType<typeof fetchSkillMeta>>;
  try {
    meta = await fetchSkillMeta(ref);
  } catch (e: any) {
    // 502：上游技能源不可用/不可解析，不是本服务的内部错误
    apiError(502, 'UPSTREAM_FAILED', `读取技能失败：${String(e?.message || e).slice(0, 200)}`);
  }

  const id = newId('prop');
  await db.insert(skillProposals).values({
    id,
    ref: refRaw,
    source: meta.source,
    sourceLabel: meta.sourceLabel,
    name: meta.name,
    description: meta.description,
    version: meta.version,
    author: meta.author,
    security: JSON.stringify(meta.security),
    files: JSON.stringify(meta.files),
    scriptFiles: JSON.stringify(meta.scriptFiles),
    bodyPreview: meta.bodyPreview,
    body: meta.body,
    status: 'pending',
    requestedBy: s.userId,
    createdAt: Date.now(),
  });
  await logAction(s.userId, 'skill_propose', meta.sourceLabel);

  return NextResponse.json({
    id,
    name: meta.name,
    description: meta.description,
    version: meta.version,
    author: meta.author,
    source: meta.source,
    sourceLabel: meta.sourceLabel,
    security: meta.security,
    fileCount: meta.files.length,
    scriptFiles: meta.scriptFiles,
    bodyPreview: meta.bodyPreview,
    needAdmin: s.role !== 'admin',
  });
});
