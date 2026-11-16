/**
 * 平台的功能入口清单（给全局搜索用）。
 *
 * 为什么要单独一份：导航栏（components/Nav.tsx）里带 JSX 图标，不能直接被搜索逻辑复用；
 * 而「搜知识库应该先给我知识库页面」这件事，本质是**入口索引**，不是内容检索。
 * 这里只放纯数据，客户端本地匹配，不发请求、不需要权限过滤（页面自身会拦）。
 *
 * aliases 要覆盖用户真实说法：搜「定时任务」能中，搜「调度」「cron」也应该中。
 */
export type NavRoute = {
  path: string;
  label: string;
  group: string;
  desc: string;
  aliases: string[];
};

export const NAV_ROUTES: NavRoute[] = [
  { path: '/work', label: '工作台', group: '工作区', desc: '今日简报、最近会话、待办与产物', aliases: ['首页', '概览', '工作台', 'brief', 'dashboard', 'home'] },
  { path: '/chat', label: '对话', group: '工作区', desc: '和模型对话，可挂工具、知识库、技能', aliases: ['聊天', '会话', '提问', 'chat', 'ask'] },
  { path: '/docs', label: '文档', group: '创作与知识', desc: '生成与编辑 Word 文档', aliases: ['word', 'docx', '写作', '生成文档', '写作'] },
  { path: '/ppt', label: 'PPT', group: '创作与知识', desc: '生成演示文稿', aliases: ['幻灯片', '演示', 'slides', 'pptx'] },
  { path: '/knowledge', label: '知识库', group: '创作与知识', desc: '上传资料、切分入库、检索增强', aliases: ['知识库', 'kb', '资料库', '文档库', '上传文档', 'rag', '向量', '检索'] },
  { path: '/files', label: '文件', group: '创作与知识', desc: '我上传的文件与团队共享文件', aliases: ['附件', '网盘', '上传', 'file'] },
  { path: '/projects', label: '项目', group: '创作与知识', desc: '按项目组织会话与成员', aliases: ['project', '成员', '团队'] },
  { path: '/memory', label: '记忆', group: '更多', desc: '个人与团队长期记忆', aliases: ['memory', '长期记忆', '记住'] },
  { path: '/skills', label: '技能编排', group: '自动化', desc: '把多步流程编排成可复用技能', aliases: ['skill', '技能', '编排', '工作流', 'workflow', 'agent'] },
  { path: '/connectors', label: '连接器', group: '更多', desc: '三方接口、MCP 端点与能力发现', aliases: ['connector', '接口', 'api', 'mcp', '三方'] },
  { path: '/capabilities', label: '能力目录', group: '更多', desc: '连接器暴露出的可调用能力', aliases: ['capability', '能力', '接口目录'] },
  { path: '/schedules', label: '定时任务', group: '自动化', desc: '按 cron 定时跑对话或技能', aliases: ['schedule', 'cron', '调度', '定时', '任务', '每天', '周期'] },
  { path: '/usage', label: '用量看板', group: '系统', desc: 'token 消耗趋势、额度占用与成员明细', aliases: ['用量', '额度', '成本', 'token', '消耗', 'usage', 'cost', '计费', '统计'] },
  { path: '/settings', label: '设置', group: '系统', desc: '个人资料、模型与偏好', aliases: ['setting', '配置', '模型', 'apikey', 'api key', '密钥'] },
  { path: '/admin', label: '管理后台', group: '系统', desc: '用户、模型、邀请码、日志与配额', aliases: ['admin', '管理', '后台', '用户管理', '日志', '配额', '邀请码'] },
];

/**
 * 匹配功能入口：命中 label / 别名 / 路径 / 说明任一即可。
 * 完全相等 > 以查询开头 > 包含，保证「定时任务」这种精确说法永远排第一。
 */
export function matchNavRoutes(query: string, max = 4): NavRoute[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const scored: { r: NavRoute; s: number }[] = [];
  for (const r of NAV_ROUTES) {
    const label = r.label.toLowerCase();
    let s = 0;
    if (label === q) s = 100;
    else if (label.startsWith(q)) s = 80;
    else if (label.includes(q)) s = 60;
    else if (r.aliases.some((a) => a.toLowerCase() === q)) s = 55;
    else if (r.aliases.some((a) => a.toLowerCase().includes(q))) s = 40;
    else if (r.path.toLowerCase().includes(q)) s = 30;
    else if (r.desc.toLowerCase().includes(q)) s = 20;
    if (s > 0) scored.push({ r, s });
  }
  return scored.sort((a, b) => b.s - a.s).slice(0, max).map((x) => x.r);
}
