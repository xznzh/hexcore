import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';

/**
 * 文档链接自检：扫描仓库内所有 Markdown，校验相对链接（含图片）目标是否存在。
 * 用途：docs 目录重组后防止路径漂移；可挂到 npm run check 里。
 * 用法：node scripts/check-doc-links.mjs [根目录]
 */

const ROOT = process.argv[2] || '.';
const SKIP = new Set(['node_modules', '.git', '.next', '.manual-tmp']);

/**
 * 扫描范围只认「受版本控制的文件」。
 *
 * 之前按目录遍历，会把本地未入库的东西一起算进来——`.workbuddy/memory/`、
 * `evals/reports/`、`qa/`（后两者已在 .gitignore）。结果是本地报「67 篇」，
 * 而别人 clone 下来只有 46 篇，README 里引用的这个数字对读者永远是错的，
 * 检查本身也就成了自我安慰。
 *
 * 在 git 工作区内改用 `git ls-files` 取文件清单，非 git 目录（比如 CI 里扫
 * 一份导出的静态文档包）才退回目录遍历。
 */
function trackedMarkdown() {
  try {
    const list = execFileSync('git', ['ls-files', '-z', '*.md'], {
      cwd: ROOT,
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
    });
    return list.split('\0').filter(Boolean).map((p) => path.join(ROOT, p));
  } catch {
    return null; // 不是 git 工作区 / 没装 git，交给下面的遍历
  }
}

const tracked = trackedMarkdown();
const files = [];
if (tracked) {
  // 索引里可能有「已删除但没提交」的条目（本地删了文件还没 commit），跳过以免读文件直接抛错
  files.push(
    ...tracked.filter((p) => !p.split(path.sep).some((seg) => SKIP.has(seg)) && fs.existsSync(p)),
  );
} else {
  (function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (SKIP.has(e.name)) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.md')) files.push(p);
    }
  })(ROOT);
}

let bad = 0;
for (const f of files) {
  const raw = fs.readFileSync(f, 'utf8');
  // 先剔掉代码块与行内代码：里面的 `[名称](url)` 是示例文本，不是真链接
  const text = raw.replace(/```[\s\S]*?```/g, '').replace(/`[^`\n]*`/g, '');
  for (const m of text.matchAll(/!?\[[^\]]*\]\(([^)\s]+)\)/g)) {
    const t = m[1];
    // 以 / 开头是「采集点根相对 URL」（如模型回答里生成的 /api/artifacts/xxx 下载链接），
    // 不是文件系统相对路径。过去用 path.resolve(文档目录, '/api/...') 去 existsSync，
    // 会把运行时产物里的 API 链接误报成断链（2026-11-09 全量回归后误报 9 处）。
    // 本项目文档链接一律写相对路径（见 AGENTS.md），跳过 / 开头不会漏掉真链接。
    if (/^(https?:|mailto:|#|<|\/)/.test(t)) continue;
    const clean = decodeURI(t.split('#')[0]);
    if (!clean) continue;
    const abs = path.resolve(path.dirname(f), clean);
    if (!fs.existsSync(abs)) {
      console.log('MISSING', path.relative(ROOT, f), '->', t);
      bad++;
    }
  }
}
console.log(bad ? `\n共 ${bad} 处断链` : `\n✅ ${files.length} 个 Markdown，链接全部有效`);
process.exit(bad ? 1 : 0);
