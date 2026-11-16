#!/usr/bin/env node
/**
 * 界面规范检查（UI Spec Lint）
 * 规范正文：docs/界面开发规范.md
 *
 * 只做「能被机器判定」的那部分，避免规范沦为一纸空文：
 *   1. TSX 内联样式里禁止硬编码颜色（必须用 --accent / --text / --muted 等变量）
 *   2. TSX 里禁止出现 <Tag color="purple|geekblue|magenta|..."> 这类「未纳入配色表」的颜色
 *
 * 不检查（靠人读清单）：按钮个数、间距、空态、加载态、可访问性 —— 见规范 §10 自查清单。
 *
 * 豁免：同一行写 `// ui-spec-allow-color` 即可跳过（需在 PR/提交说明里写原因）。
 * 主题源文件 components/ThemeProvider.tsx 整体豁免（它就是 token 的镜像）。
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = process.cwd();
const SCAN_DIRS = ['app', 'components'];
const EXEMPT_FILES = new Set(['components/ThemeProvider.tsx']);
const ALLOW_MARK = 'ui-spec-allow-color';

/** 允许出现在 <Tag color="..."> 的取值（对应规范 §2.4 配色表） */
const ALLOWED_TAG_COLORS = new Set([
  'blue', // 技术标识：HTTP 方法 / 项目 / 模型 / 工具名 / 分类枚举
  'cyan', // 归属来源：内置 / 团队 / 三方系统 / 待办来源 / 关联项
  'green', // 成功 · 启用
  'red', // 失败 · 撤销 · 危险
  'orange', // 需关注：需审批 / 访客
  'gold', // 特殊强调：默认项 / 缓存命中
  'default', // 中性态
  // antd 语义预设（等价于上面的语义色，随主题走，不属于「装饰色」）
  'success',
  'error',
  'warning',
  'processing',
]);

/** 明令禁止的配色：与主色冲突或饱和度过高的装饰色 */
const FORBIDDEN_COLOR_TOKEN = /['"](magenta|purple|volcano|lime|geekblue|pink|violet)['"]/g;

const COLOR_PATTERNS = [
  { re: /#[0-9a-fA-F]{3,8}\b/g, label: '十六进制颜色' },
  { re: /\brgba?\(\s*\d/g, label: 'rgb()/rgba() 常量' },
  { re: /\bhsla?\(\s*\d/g, label: 'hsl()/hsla() 常量' },
];
const TAG_RE = /<Tag\s+color="([a-zA-Z]+)"/g;

const problems = [];

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '.next' || name.startsWith('.')) continue;
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, out);
    else if (/\.(tsx|jsx)$/.test(name)) out.push(full);
  }
  return out;
}

function scan(file) {
  const rel = relative(ROOT, file).split('\\').join('/');
  if (EXEMPT_FILES.has(rel)) return;
  const lines = readFileSync(file, 'utf8').split('\n');
  lines.forEach((line, i) => {
    if (line.includes(ALLOW_MARK) || line.trimStart().startsWith('*') || line.trimStart().startsWith('//')) return;
    for (const { re, label } of COLOR_PATTERNS) {
      re.lastIndex = 0;
      const m = re.exec(line);
      if (m) {
        problems.push({ rel, line: i + 1, at: m[0], msg: `硬编码${label}` });
      }
    }
    FORBIDDEN_COLOR_TOKEN.lastIndex = 0;
    const forbidden = FORBIDDEN_COLOR_TOKEN.exec(line);
    if (forbidden) {
      problems.push({ rel, line: i + 1, at: forbidden[0], msg: '使用了规范外的配色（与主色冲突）' });
      return; // 同一行不再重复报 Tag 检查
    }
    TAG_RE.lastIndex = 0;
    let t;
    while ((t = TAG_RE.exec(line))) {
      if (!ALLOWED_TAG_COLORS.has(t[1])) {
        problems.push({ rel, line: i + 1, at: `<Tag color="${t[1]}">`, msg: 'Tag 配色不在规范配色表内' });
      }
    }
  });
}

const files = SCAN_DIRS.flatMap((d) => {
  try {
    return walk(join(ROOT, d));
  } catch {
    return [];
  }
});

files.forEach(scan);

if (!problems.length) {
  console.log(`✅ 界面规范检查通过（扫描 ${files.length} 个 TSX 文件，0 处违规）`);
  process.exit(0);
}

console.error(`❌ 界面规范检查未通过：${problems.length} 处违规\n`);
const byFile = new Map();
for (const p of problems) {
  if (!byFile.has(p.rel)) byFile.set(p.rel, []);
  byFile.get(p.rel).push(p);
}
for (const [rel, list] of byFile) {
  console.error(`  ${rel}`);
  for (const p of list) {
    console.error(`    ${String(p.line).padStart(4)} 行  ${p.at.padEnd(22)} ${p.msg}`);
  }
}
console.error(`
修法（详见 docs/界面开发规范.md）：
  · 颜色改用变量：var(--accent) / var(--accent-soft) / var(--accent-border) /
    var(--accent-2) / rgba(var(--accent-rgb), α) / var(--text) / var(--text-secondary) /
    var(--muted) / var(--border) / var(--panel) / var(--bg-subtle) /
    var(--success) / var(--warning) / var(--danger)
  · Tag 配色只用：blue / cyan / green / red / orange / gold / default
  · 确属例外（如第三方嵌入、品牌色）在该行加注释 ${ALLOW_MARK} 并说明原因
`);
process.exit(1);
