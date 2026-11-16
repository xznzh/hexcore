import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { skills } from '@/lib/schema';
import { newId, logAction } from '@/lib/util';
import { parseSkillRef, fetchSkillMeta } from '@/lib/skills/hub';
import { withApi, apiError } from '@/lib/api/handler';

export const dynamic = 'force-dynamic';

/**
 * 从技能源导入 SKILL.md 为技能（立即安装，管理员/成员均可）。
 * 支持：@handle/slug（SkillHub）、https://skills.sh/owner/repo/skill、https://github.com/owner/repo --skill skill、
 *      owner/repo/skill。
 * 只导入 SKILL.md 正文；附带的脚本文件不执行。
 */
export const POST = withApi(async ({ req, session }) => {
  const s = session;
  if (s.role === 'guest') apiError(403, 'FORBIDDEN', '访客无写入权限');

  const body = await req.json().catch(() => ({}));
  const refRaw = String(body?.url || body?.ref || '').trim();
  const ref = parseSkillRef(refRaw);
  if (!ref) {
    apiError(
      400,
      'INVALID_ARGUMENT',
      '无法解析输入。支持：@handle/slug、https://skillhub.cn/@handle/slug、https://skills.sh/owner/repo/skill、owner/repo/skill',
    );
  }

  let meta: Awaited<ReturnType<typeof fetchSkillMeta>>;
  try {
    meta = await fetchSkillMeta(ref);
  } catch (e: any) {
    const msg = String(e?.message || e);
    // 三种失败要分开：限流要等、超时要重试、其余是内容/格式问题。
    // 全压成 500 会让用户以为「平台坏了」，实际只需要「过一会儿再来」。
    if (/GitHub 403/.test(msg)) {
      apiError(429, 'UPSTREAM_RATE_LIMITED', 'GitHub 访问受限（未认证 API 每小时 60 次），请稍后重试');
    }
    if (/timeout|aborted/i.test(msg)) {
      apiError(504, 'UPSTREAM_TIMEOUT', '读取技能源超时，请稍后重试或换一个技能');
    }
    apiError(500, 'SKILL_IMPORT_FAILED', `导入失败：${msg.slice(0, 200)}`);
  }

  if (!meta.body || meta.body.trim().length < 10) {
    apiError(400, 'INVALID_ARGUMENT', '技能内容为空');
  }

  const desc =
    (meta.description || `来自 ${meta.sourceLabel} 的技能`) +
    (meta.scriptFiles.length ? `（附 ${meta.scriptFiles.length} 个脚本，本平台不执行）` : '');
  const id = newId('skill');
  await db.insert(skills).values({
    id,
    ownerId: s.userId,
    scope: 'personal',
    projectId: null,
    name: meta.name,
    description: desc.slice(0, 300),
    steps: JSON.stringify([{ role: 'worker', type: 'llm', prompt: meta.body }]),
    modelId: null,
    createdAt: Date.now(),
  });
  await logAction(s.userId, 'skill_import_url', meta.sourceLabel);
  return NextResponse.json({
    id,
    name: meta.name,
    source: meta.sourceLabel,
    version: meta.version,
    security: meta.security,
    scriptFiles: meta.scriptFiles,
  });
});
