import path from 'path';

/** 文件存储根目录（位于项目 data/files 下，本地优先） */
export const DATA_DIR = path.join(process.cwd(), 'data', 'files');

/** 用户文件目录 */
export function userDir(userId: string): string {
  return path.join(DATA_DIR, userId);
}

/** 将存储的相对路径（userId/name）解析为绝对路径，并做越权防护 */
export function resolveSafe(relPath: string): string {
  // 用 path.resolve 归一化后按「分隔符边界」比对：旧写法 `startsWith(DATA_DIR)` 没有边界，
  // `../files_evil/x` 归一化成 `data/files_evil/x` 会以 `data/files` 为前缀被误判为合法，形成越界读取。
  const base = path.resolve(DATA_DIR);
  const abs = path.resolve(base, relPath);
  if (abs !== base && !abs.startsWith(base + path.sep)) throw new Error('非法路径');
  return abs;
}

/** 净化文件名，防止路径穿越 */
export function safeName(name: string): string {
  return name.replace(/[^\w一-龥.\- ]+/g, '_').slice(0, 120) || 'file';
}
