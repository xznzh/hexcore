import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { skillProposals, skills } from '@/lib/schema';
import { newId, logAction } from '@/lib/util';
import { eq } from 'drizzle-orm';
import { withApi, apiError, ApiError } from '@/lib/api/handler';

export const dynamic = 'force-dynamic';

/**
 * 处理安装提议：
 *  - action=confirm  → 管理员确认安装：写入技能表（只取 SKILL.md 正文作为单步 LLM 技能）
 *  - action=dismiss  → 忽略该提议
 * 附带脚本（*.py/*.js 等）本平台一律不执行，仅在描述中标注。
 */
export const POST = withApi(async ({ req, session, params }) => {
  const { id } = (await params) as { id: string };
  const s = session;
  if (s.role === 'guest') apiError(403, 'FORBIDDEN', '访客无权操作');

  const body = await req.json().catch(() => ({}));
  const action = String(body?.action || 'confirm');

  const row = (await db.select().from(skillProposals).where(eq(skillProposals.id, id)).limit(1))[0];
  if (!row) apiError(404, 'NOT_FOUND', '提议不存在');
  if (row.status !== 'pending') {
    apiError(400, 'INVALID_STATE', `该提议已${row.status === 'installed' ? '安装' : '忽略'}`);
  }

  if (action === 'dismiss') {
    // 忽略：提议发起人自己也能撤，不必等管理员
    if (row.requestedBy !== s.userId && s.role !== 'admin') {
      apiError(403, 'FORBIDDEN', '无权忽略该提议');
    }
    await db.update(skillProposals).set({ status: 'dismissed', confirmedBy: s.userId, confirmedAt: Date.now() }).where(eq(skillProposals.id, row.id));
    await logAction(s.userId, 'skill_proposal_dismiss', row.sourceLabel || row.ref);
    return NextResponse.json({ ok: true, status: 'dismissed' });
  }

  // —— 确认安装：仅管理员 ——
  if (s.role !== 'admin') apiError(403, 'FORBIDDEN', '仅管理员可以确认安装技能');

  try {
    const scriptFiles: string[] = JSON.parse(row.scriptFiles || '[]');
    const desc = (row.description || '') + (scriptFiles.length ? `（附 ${scriptFiles.length} 个脚本，本平台不执行）` : '');
    // 注意别用 id：它是路由参数（提议 id），遮蔽后会让人误以为在更新同一条记录
    const newSkillId = newId('skill');
    await db.insert(skills).values({
      id: newSkillId,
      ownerId: s.userId,
      scope: 'team', // 团队共享，便于全组使用
      projectId: null,
      name: row.name,
      description: desc.slice(0, 300),
      steps: JSON.stringify([{ role: 'worker', type: 'llm', prompt: row.body }]),
      modelId: null,
      createdAt: Date.now(),
    });
    await db
      .update(skillProposals)
      .set({ status: 'installed', confirmedBy: s.userId, confirmedAt: Date.now(), skillId: newSkillId })
      .where(eq(skillProposals.id, row.id));
    await logAction(s.userId, 'skill_install_confirm', `${row.sourceLabel || row.ref} → ${row.name}`);
    return NextResponse.json({ ok: true, skillId: newSkillId, name: row.name, status: 'installed' });
  } catch (e: any) {
    if (e instanceof ApiError) throw e;
    apiError(500, 'INSTALL_FAILED', `安装失败：${String(e?.message || e).slice(0, 200)}`);
  }
});
