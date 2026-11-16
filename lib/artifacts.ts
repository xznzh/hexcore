import fs from 'fs/promises';
import path from 'path';
import { db } from './db';
import { artifacts } from './schema';
import { newId } from './util';
import { userDir, safeName } from './storage';

/** 保存产物文件到本地并登记 artifacts（可绑定项目/会话）。 */
export async function saveArtifact(p: {
  ownerId: string;
  projectId?: string | null;
  conversationId?: string | null;
  type: 'doc' | 'ppt';
  title?: string;
  filename: string;
  buf: Buffer;
}): Promise<string> {
  const stored = `${newId('art')}_${safeName(p.filename)}`;
  const dir = userDir(p.ownerId);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, stored), p.buf);
  const id = newId('artifact');
  await db.insert(artifacts).values({
    id,
    ownerId: p.ownerId,
    projectId: p.projectId || null,
    conversationId: p.conversationId || null,
    type: p.type,
    title: p.title || p.filename,
    filename: p.filename,
    path: `${p.ownerId}/${stored}`,
    size: p.buf.length,
    createdAt: Date.now(),
  });
  return id;
}
