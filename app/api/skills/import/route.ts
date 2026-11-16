import { NextResponse } from 'next/server';
import JSZip from 'jszip';
import { db } from '@/lib/db';
import { skills } from '@/lib/schema';
import { newId, logAction } from '@/lib/util';
import { withApi, apiError } from '@/lib/api/handler';

export const dynamic = 'force-dynamic';

// 导入 ZIP 技能包（skill.json 为结构化定义；缺失时用 SKILL.md 生成单步技能）
export const POST = withApi(async ({ req, session }) => {
  const s = session;
  if (s.role === 'guest') apiError(403, 'FORBIDDEN', '访客无写入权限');

  // formData 解析可能因请求体超限/中断而抛错（Next 15 默认 10MB 会截断 body）。
  // 这里兜底成 413 而不是让异常冒泡成 500，避免客户端只看到一个空响应。
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    apiError(413, 'PAYLOAD_TOO_LARGE', '请求体过大或格式不正确（技能包上限 5 MB）');
  }
  const file = form.get('file');
  if (!file || typeof file === 'string') apiError(400, 'INVALID_ARGUMENT', '请选择 ZIP 技能包');

  const buf = Buffer.from(await (file as File).arrayBuffer());
  // 解压炸弹 / 超大包防护：ZIP 会整包读进内存再解析，无上限时一个几十 MB 的包即可打爆进程。
  const MAX_ZIP = 5 * 1024 * 1024;
  if (buf.length > MAX_ZIP) {
    apiError(413, 'PAYLOAD_TOO_LARGE', `技能包不能超过 ${MAX_ZIP / 1024 / 1024} MB`);
  }

  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(buf);
  } catch {
    apiError(400, 'INVALID_ZIP', '无法解析 ZIP 文件');
  }

  // 在根目录查找 skill.json / SKILL.md
  const names = Object.keys(zip.files);
  const jsonName = names.find((n) => /(^|\/)skill\.json$/i.test(n));
  const mdName = names.find((n) => /(^|\/)SKILL\.md$/i.test(n));

  let name = '';
  let description = '';
  let scope: 'personal' | 'team' = 'personal';
  let steps: any[] = [];

  if (jsonName) {
    try {
      const j = JSON.parse(await zip.files[jsonName].async('string'));
      name = String(j.name || '').trim();
      description = String(j.description || '');
      scope = j.scope === 'team' ? 'team' : 'personal';
      steps = Array.isArray(j.steps) ? j.steps : [];
    } catch {
      /* fallthrough */
    }
  }
  if ((!name || steps.length === 0) && mdName) {
    const md = await zip.files[mdName].async('string');
    const first = md.match(/^#\s+(.+)$/m);
    name = name || (first ? first[1].trim() : '');
    description = description || md.slice(0, 200);
    if (steps.length === 0) steps = [{ role: 'worker', type: 'llm', prompt: md }];
  }
  if (!name) name = '导入的技能';
  if (steps.length === 0) steps = [{ role: 'worker', type: 'llm', prompt: '' }];

  const id = newId('skill');
  await db.insert(skills).values({
    id,
    ownerId: s.userId,
    scope,
    name,
    description: description || null,
    steps: JSON.stringify(steps),
    modelId: null,
    createdAt: Date.now(),
  });
  await logAction(s.userId, 'skill_import', name);
  return NextResponse.json({ id, name, steps: steps.length });
});
