import { NextRequest, NextResponse } from 'next/server';
import { ensureInit, db } from '@/lib/db';
import { getSession } from '@/lib/auth';
import { llmExpand, buildPptx, detectPptTheme } from '@/lib/generate';
import { addUsage, logAction, estimateTokens } from '@/lib/util';
import { checkRateLimit } from '@/lib/redis';
import { canAccessProject } from '@/lib/projects';
import { visibleKbIds } from '@/lib/kb-access';
import { checkQuota } from '@/lib/quota';
import { saveArtifact } from '@/lib/artifacts';
import { skills } from '@/lib/schema';
import { failResponse } from '@/lib/api/handler';

export const dynamic = 'force-dynamic';

const PPT_SKILL_RE = /(ppt|幻灯片|演示文稿|演示|slides?|presentation)/i;

/** 找出用于 PPT 生成的技能指令（SKILL.md 正文）：优先指定 id/名称，其次自动匹配 PPT 类技能 */
async function resolvePptSkillPrompt(skillRef: unknown, userId: string): Promise<string> {
  const rows = await db.select().from(skills);
  const visible = rows.filter((k) => k.ownerId === userId || k.scope === 'team');
  const key = String(skillRef || '').trim().toLowerCase();
  const picked =
    (key
      ? visible.find((k) => k.id.toLowerCase() === key) ||
        visible.find((k) => (k.name || '').toLowerCase() === key) ||
        visible.find((k) => (k.name || '').toLowerCase().includes(key))
      : undefined) ||
    visible.find((k) => PPT_SKILL_RE.test(k.name || '') || PPT_SKILL_RE.test(k.description || '') || PPT_SKILL_RE.test(k.id));
  if (!picked) return '';
  try {
    const steps = JSON.parse(picked.steps || '[]');
    return steps
      .filter((st: any) => (st.type || 'llm') === 'llm' && st.prompt)
      .map((st: any) => String(st.prompt))
      .join('\n\n')
      .slice(0, 8000);
  } catch {
    return '';
  }
}

export async function POST(req: NextRequest) {
  await ensureInit();
  const s = await getSession();
  if (!s) return failResponse(req, 401, 'UNAUTHORIZED', '未登录');
  if (s.role === 'guest') return NextResponse.json({ error: '访客无写入权限' }, { status: 403 });

  const allowed = await checkRateLimit(`ratelimit:gen:${s.userId}`, 20, 60);
  if (!allowed) return NextResponse.json({ error: '生成过于频繁，请稍后再试' }, { status: 429 });

  // V8.3 · R7：额度闸门（同 docs 路由）。PPT 大纲生成比文档更贵，更不能漏。
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

  const projectId: string | null = body?.projectId || null;
  if (projectId && !(await canAccessProject(projectId, s.userId, s.role))) {
    return NextResponse.json({ error: '无权归属该项目' }, { status: 403 });
  }

  // —— 优先使用「PPT 类技能」的 SKILL.md 作为写作指令 ——
  // 指定了 skillId 就用指定的；否则自动挑选名称含 ppt / 演示 / 幻灯片 的可用技能。
  const skillBody = await resolvePptSkillPrompt(body?.skillId, s.userId);

  // V8.3 · R6：同 docs 路由——勾选引用知识库时必须按可见范围检索，避免全库越权
  const kbScope = body?.useKb ? await visibleKbIds(s.userId, s.role) : undefined;
  const { title, body: md, theme: aiTheme } = await llmExpand(brief, body?.modelId, 'ppt', !!body?.useKb, skillBody, kbScope);
  // 配色：API 显式指定则尊重；否则用 AI 在正文里给出的主题，再退回内容关键词识别
  const theme =
    body?.theme && String(body.theme) !== 'auto'
      ? String(body.theme)
      : aiTheme || detectPptTheme(`${title}\n${md}\n${brief}`);
  const buf = await buildPptx(title, md, theme);
  await addUsage(s.userId, estimateTokens(brief) + estimateTokens(md));
  await logAction(s.userId, 'generate_ppt', title);

  const safe = title.replace(/[^\w一-龥-]+/g, '_').slice(0, 50) || 'presentation';
  const filename = `${safe}.pptx`;
  try {
    await saveArtifact({
      ownerId: s.userId,
      projectId,
      conversationId: body?.conversationId || null,
      type: 'ppt',
      title,
      filename,
      buf,
    });
  } catch {
    /* 归档失败不影响下载 */
  }

  return new NextResponse(buf as any, {
    headers: {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      'Content-Disposition': `attachment; filename="${encodeURIComponent(filename)}"`,
    },
  });
}
