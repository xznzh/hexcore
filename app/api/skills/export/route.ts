import { NextRequest, NextResponse } from 'next/server';
import JSZip from 'jszip';
import { ensureInit, db } from '@/lib/db';
import { skills } from '@/lib/schema';
import { eq } from 'drizzle-orm';
import { getSession } from '@/lib/auth';
import { failResponse } from '@/lib/api/handler';

export const dynamic = 'force-dynamic';

const TYPE_LABEL: Record<string, string> = {
  llm: 'LLM',
  tool: '工具',
  condition: '条件',
  loop: '循环',
  human: '人工确认',
};

// 导出技能为 ZIP 技能包（含 SKILL.md 与 skill.json）
export async function GET(req: NextRequest) {
  await ensureInit();
  const s = await getSession();
  if (!s) return failResponse(req, 401, 'UNAUTHORIZED', '未登录');
  const id = req.nextUrl.searchParams.get('id');
  if (!id) return NextResponse.json({ error: '缺少 id' }, { status: 400 });

  const sk = (await db.select().from(skills).where(eq(skills.id, id)).limit(1))[0];
  if (!sk) return NextResponse.json({ error: '技能不存在' }, { status: 404 });

  const steps = JSON.parse(sk.steps || '[]');
  const manifest = {
    schema: 'ai-agent-platform/skill@1',
    name: sk.name,
    description: sk.description || '',
    scope: sk.scope,
    modelId: sk.modelId,
    version: sk.version,
    steps,
  };

  const md = [
    `# ${sk.name}`,
    '',
    sk.description || '（无描述）',
    '',
    `- 作用域：${sk.scope === 'team' ? '团队' : '个人'}`,
    `- 版本：v${sk.version}`,
    '',
    '## 节点',
    ...steps.map((st: any, i: number) => {
      const type = st.type || (st.tool ? 'tool' : 'llm');
      let extra = '';
      if (type === 'tool') extra = ` → 工具：${st.tool || ''}`;
      if (type === 'condition') extra = ` → 需包含：${st.contains || ''}`;
      if (type === 'loop') extra = ` → 次数：${st.times || 2}`;
      if (type === 'human') extra = st.requireConfirm ? ' → 需人工确认' : '';
      return `${i + 1}. **${st.role}**（${TYPE_LABEL[type] || type}）${extra}\n   - prompt: ${st.prompt || '（空）'}`;
    }),
  ].join('\n');

  const zip = new JSZip();
  zip.file('skill.json', JSON.stringify(manifest, null, 2));
  zip.file('SKILL.md', md);
  const buf = await zip.generateAsync({ type: 'nodebuffer' });

  const safe = sk.name.replace(/[^\w一-龥-]+/g, '_').slice(0, 50) || 'skill';
  return new NextResponse(buf as any, {
    headers: {
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename="${encodeURIComponent(safe)}.skill.zip"`,
    },
  });
}
