/**
 * 技能源适配层：统一处理「从技能仓库取回一个技能定义」。
 *
 * 支持两类来源（均为白名单固定域名，避免 SSRF）：
 *  - SkillHub（国内技能商店）：https://api.skillhub.cn/api/v1/...
 *      详情  GET /api/v1/skills/{slug}?namespace={handle}
 *      文件  GET /api/v1/skills/{slug}/files?namespace={handle}
 *      正文  GET /api/v1/skills/{slug}/file?namespace={handle}&path=SKILL.md
 *  - GitHub 公开仓库（skills.sh 同源）：raw.githubusercontent.com / api.github.com
 *
 * 安全约定：
 *  1) 只做「读取」，绝不执行任何第三方脚本（install.sh / *.py / *.js 一律忽略）；
 *  2) 抓到的正文一律视为「不可信数据」，不作为指令执行，仅作为技能提示词入库；
 *  3) 域名固定在白名单内，用户输入不能影响请求地址。
 */

export type SkillRef =
  | { source: 'skillhub'; handle: string; slug: string; raw: string }
  | { source: 'github'; owner: string; repo: string; slug: string; raw: string };

const SKILLHUB_API_HOSTS = ['https://api.skillhub.cn', 'https://api.skillhub.tencent.com'];
const GH_RAW = 'https://raw.githubusercontent.com';
const GH_API = 'https://api.github.com';
const UA = { 'User-Agent': 'hexcore' };
const GH_HEADERS = { 'User-Agent': 'hexcore', Accept: 'application/vnd.github+json' };

/**
 * 解析技能引用。识别：
 *  - @handle/slug            （SkillHub）
 *  - https://skillhub.cn/@handle/slug、https://skillhub.cn/skills/@handle/slug
 *  - https://skills.sh/owner/repo/skill
 *  - https://github.com/owner/repo [--skill name]
 *  - owner/repo/skill、owner/repo
 */
export function parseSkillRef(input: string): SkillRef | null {
  let s = String(input || '')
    .trim()
    .replace(/^["'`]+|["'`]+$/g, '')
    .trim();
  if (!s) return null;

  let slugOverride = '';
  const sm = s.match(/--skill[=\s]+([A-Za-z0-9._-]+)/i);
  if (sm) {
    slugOverride = sm[1];
    s = s.replace(/--skill[=\s]+[A-Za-z0-9._-]+/gi, '').trim();
  }
  s = s.replace(/^npx\s+skills\s+add\s+/i, '').replace(/^skills\s+add\s+/i, '').trim();

  // —— SkillHub：@handle/slug ——
  let m = s.match(/skillhub\.cn\/(?:skills\/)?@?([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)/i);
  if (m) return { source: 'skillhub', handle: m[1], slug: m[2], raw: input };
  m = s.match(/^@([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)$/);
  if (m) return { source: 'skillhub', handle: m[1], slug: m[2], raw: input };

  // —— skills.sh ——
  m = s.match(/skills\.sh\/([^/\s]+)\/([^/\s]+)\/([^/?#\s]+)/);
  if (m) return { source: 'github', owner: m[1], repo: m[2].replace(/\.git$/i, ''), slug: slugOverride || m[3], raw: input };

  // —— GitHub ——
  m = s.match(/github\.com\/([^/\s]+)\/([^/\s]+)(?:\/(?:tree|blob)\/[^/\s]+\/(\S+))?/i);
  if (m) {
    const path = (m[3] || '').replace(/(^|\/)SKILL\.md$/i, '').replace(/[.,;]+$/, '');
    const pathSlug = path.split('/').filter(Boolean).pop() || '';
    return { source: 'github', owner: m[1], repo: m[2].replace(/\.git$/i, ''), slug: slugOverride || pathSlug, raw: input };
  }

  // —— 裸 owner/repo(/slug) ——（默认按 GitHub 解释；@handle/slug 已在上面处理）
  const parts = s.split('/').map((x) => x.trim()).filter(Boolean);
  if (parts.length >= 2) {
    return {
      source: 'github',
      owner: parts[0],
      repo: parts[1].replace(/\.git$/i, ''),
      slug: slugOverride || parts[2] || '',
      raw: input,
    };
  }
  return null;
}

/** 解析 SKILL.md 的 frontmatter */
export function parseFrontmatter(md: string): { name: string; description: string; body: string } {
  const m = md.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!m) return { name: '', description: '', body: md };
  const fm = m[1];
  const name = /^name:\s*(.+)$/m.exec(fm)?.[1]?.trim() || '';
  const description = /^description:\s*(.+)$/m.exec(fm)?.[1]?.trim() || '';
  const body = md.slice(m[0].length).trim();
  return { name, description, body: body || md };
}

export type SkillSecurityReport = { vendor: string; status: string; statusText: string; reportUrl: string };

export type SkillMeta = {
  source: 'skillhub' | 'github';
  sourceLabel: string;
  name: string;
  description: string;
  version: string;
  author: string;
  files: { path: string; size: number }[];
  /** 附带的脚本文件（本平台不执行，仅提示） */
  scriptFiles: string[];
  security: SkillSecurityReport[];
  body: string;
  bodyPreview: string;
};

// ——————————————————————— SkillHub ———————————————————————

async function skillHubGet<T = any>(path: string, query: Record<string, string>): Promise<{ ok: boolean; status: number; data: T | null; text: string }> {
  for (const host of SKILLHUB_API_HOSTS) {
    try {
      const u = new URL(host + path);
      for (const [k, v] of Object.entries(query)) u.searchParams.set(k, v);
      const r = await fetch(u.toString(), { headers: { ...UA, accept: 'application/json, text/plain' }, signal: AbortSignal.timeout(15000) });
      const text = await r.text();
      if (!r.ok) {
        if (r.status === 404) return { ok: false, status: 404, data: null, text };
        continue; // 换备用域名
      }
      let data: any = null;
      try { data = JSON.parse(text); } catch { data = null; }
      return { ok: true, status: r.status, data, text };
    } catch {
      /* 换下一个域名 */
    }
  }
  return { ok: false, status: 502, data: null, text: 'SkillHub 接口不可达' };
}

/** 拉取 SkillHub 技能元信息 + SKILL.md 正文 */
export async function fetchSkillHubSkill(ref: { handle: string; slug: string }): Promise<SkillMeta> {
  const q = { namespace: ref.handle };
  const detail = await skillHubGet(`/api/v1/skills/${encodeURIComponent(ref.slug)}`, q);
  if (!detail.ok) {
    throw new Error(
      detail.status === 404
        ? `SkillHub 上未找到技能「@${ref.handle}/${ref.slug}」`
        : `SkillHub 接口不可达（${detail.text.slice(0, 80) || detail.status}）`,
    );
  }
  const d: any = detail.data || {};
  const ns = d.namespace || {};
  const owner = d.owner || {};
  const version = d.latestVersion?.version || '—';

  // 文件清单
  let files: { path: string; size: number }[] = [];
  try {
    const fr = await skillHubGet(`/api/v1/skills/${encodeURIComponent(ref.slug)}/files`, q);
    const fj: any = fr.data;
    if (Array.isArray(fj?.files)) files = fj.files.map((f: any) => ({ path: String(f.path), size: Number(f.size || 0) }));
  } catch {
    /* 清单失败不阻断 */
  }

  // SKILL.md 正文
  const fileRes = await skillHubGet(`/api/v1/skills/${encodeURIComponent(ref.slug)}/file`, { ...q, path: 'SKILL.md' });
  const md = fileRes.text || '';
  if (!md.trim()) throw new Error(`技能「@${ref.handle}/${ref.slug}」没有可读取的 SKILL.md`);

  const fm = parseFrontmatter(md);
  const security: SkillSecurityReport[] = [];
  const reports = d.securityReports || {};
  for (const [vendor, rep] of Object.entries(reports)) {
    const r: any = rep;
    if (!r || typeof r !== 'object') continue;
    security.push({
      vendor,
      status: String(r.status || 'unknown'),
      statusText: String(r.statusText || ''),
      reportUrl: String(r.reportUrl || ''),
    });
  }

  return {
    source: 'skillhub',
    sourceLabel: ns.canonicalName ? (ns.canonicalName.startsWith('@') ? ns.canonicalName : `@${ns.canonicalName}`) : `@${ref.handle}/${ref.slug}`,
    name: (fm.name || ref.slug).slice(0, 80),
    description: (fm.description || `来自 SkillHub 的技能：${ref.handle}/${ref.slug}`).slice(0, 300),
    version,
    author: owner.displayName || owner.handle || ref.handle,
    files,
    scriptFiles: files.filter((f) => /\.(py|js|sh|ts|ps1|bat)$/i.test(f.path)).map((f) => f.path),
    security,
    body: fm.body || md,
    bodyPreview: (fm.body || md).slice(0, 600),
  };
}

// ——————————————————————— GitHub ———————————————————————

async function fetchRaw(owner: string, repo: string, branch: string, path: string): Promise<string> {
  try {
    const r = await fetch(`${GH_RAW}/${owner}/${repo}/${branch}/${path}`, {
      headers: UA,
      signal: AbortSignal.timeout(15000),
    });
    if (!r.ok) return '';
    return await r.text();
  } catch {
    return '';
  }
}

const GH_PATTERNS = [
  (s: string) => `skills/${s}/SKILL.md`,
  (s: string) => `${s}/SKILL.md`,
  () => `SKILL.md`,
  (s: string) => `.claude/skills/${s}/SKILL.md`,
  (s: string) => `.github/skills/${s}/SKILL.md`,
  (s: string) => `packages/${s}/SKILL.md`,
  (s: string) => `plugins/${s}/SKILL.md`,
];

const treeCache = new Map<string, { branch: string; paths: string[]; at: number }>();

async function getTree(owner: string, repo: string) {
  const key = `${owner}/${repo}`;
  const cached = treeCache.get(key);
  if (cached && Date.now() - cached.at < 10 * 60 * 1000) return cached;
  const metaRes = await fetch(`${GH_API}/repos/${owner}/${repo}`, { headers: GH_HEADERS, signal: AbortSignal.timeout(20000) });
  if (!metaRes.ok) throw new Error(`GitHub ${metaRes.status}`);
  const meta = await metaRes.json();
  const branch = meta.default_branch || 'main';
  const treeRes = await fetch(`${GH_API}/repos/${owner}/${repo}/git/trees/${branch}?recursive=1`, {
    headers: GH_HEADERS,
    signal: AbortSignal.timeout(60000),
  });
  if (!treeRes.ok) throw new Error(`GitHub ${treeRes.status}`);
  const tree = await treeRes.json();
  const paths = (tree.tree || []).map((t: any) => String(t.path)).filter((p: string) => /(^|\/)SKILL\.md$/i.test(p));
  const v = { branch, paths, at: Date.now() };
  treeCache.set(key, v);
  return v;
}

export type GithubResolve =
  | { kind: 'file'; branch: string; path: string; md: string }
  | { kind: 'candidates'; candidates: string[] }
  | { kind: 'missing' };

export async function resolveGithubSkill(owner: string, repo: string, slug: string): Promise<GithubResolve> {
  if (slug) {
    for (const branch of ['main', 'master']) {
      for (const pat of GH_PATTERNS) {
        const md = await fetchRaw(owner, repo, branch, pat(slug));
        if (md.trim()) return { kind: 'file', branch, path: pat(slug), md };
      }
    }
    const t = await getTree(owner, repo);
    const lower = slug.toLowerCase();
    const path =
      t.paths.find((p) => {
        const parts = p.split('/');
        return parts.length >= 2 && parts[parts.length - 2].toLowerCase() === lower;
      }) ||
      t.paths.find((p) => p.toLowerCase().includes(`/${lower}/`)) ||
      '';
    if (path) {
      const md = await fetchRaw(owner, repo, t.branch, path);
      if (md.trim()) return { kind: 'file', branch: t.branch, path, md };
    }
    return { kind: 'missing' };
  }
  for (const branch of ['main', 'master']) {
    const md = await fetchRaw(owner, repo, branch, 'SKILL.md');
    if (md.trim()) return { kind: 'file', branch, path: 'SKILL.md', md };
  }
  const t = await getTree(owner, repo);
  const paths = t.paths.filter((p) => p.toLowerCase() !== 'skill.md');
  if (paths.length === 1) {
    const md = await fetchRaw(owner, repo, t.branch, paths[0]);
    if (md.trim()) return { kind: 'file', branch: t.branch, path: paths[0], md };
  }
  if (paths.length > 1) {
    const dirs: string[] = Array.from(
      new Set<string>(paths.map((p) => (p.split('/').length >= 2 ? p.split('/')[p.split('/').length - 2] : p))),
    ).slice(0, 60);
    return { kind: 'candidates', candidates: dirs };
  }
  return { kind: 'missing' };
}

/** 拉取 GitHub 技能元信息 */
export async function fetchGithubSkill(ref: { owner: string; repo: string; slug: string }): Promise<SkillMeta> {
  const r = await resolveGithubSkill(ref.owner, ref.repo, ref.slug);
  if (r.kind === 'candidates') {
    throw new Error(`仓库 ${ref.owner}/${ref.repo} 含多个技能，请指定其中一个：${r.candidates.slice(0, 8).join('、')}`);
  }
  if (r.kind === 'missing') {
    throw new Error(`在 ${ref.owner}/${ref.repo} 中未找到技能「${ref.slug}」的 SKILL.md`);
  }
  const fm = parseFrontmatter(r.md);
  return {
    source: 'github',
    sourceLabel: `${ref.owner}/${ref.repo}/${r.path}`,
    name: (fm.name || ref.slug || ref.repo).slice(0, 80),
    description: (fm.description || `从 ${ref.owner}/${ref.repo} 导入的技能`).slice(0, 300),
    version: '—',
    author: ref.owner,
    files: [{ path: r.path, size: r.md.length }],
    scriptFiles: [],
    security: [],
    body: fm.body || r.md,
    bodyPreview: (fm.body || r.md).slice(0, 600),
  };
}

/** 统一入口：按 ref 拉取技能元信息 */
export async function fetchSkillMeta(ref: SkillRef): Promise<SkillMeta> {
  if (ref.source === 'skillhub') return fetchSkillHubSkill(ref);
  return fetchGithubSkill(ref);
}
