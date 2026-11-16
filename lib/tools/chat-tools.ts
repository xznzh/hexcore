import fs from 'fs/promises';
import { jsonSchema } from 'ai';
import { db } from '../db';
import {
  conversations,
  users as U,
  usage as USG,
  projects,
  files as F,
  skills,
  projectMembers,
  schedules,
  todos as todosT,
  skillProposals,
  connectors,
} from '../schema';
import { eq, and, or, sql } from 'drizzle-orm';
import { retrieve } from '../ai/rag';
import { runSkillGoverned } from '../agent';
import { newId, periodNow, logAction } from '../util';
import { buildPptx } from '../generate';
import { saveArtifact } from '../artifacts';
import { resolveSafe } from '../storage';
import { callConnector, parseConnectorConfig } from '../tools';
import { parseSkillRef, fetchSkillMeta } from '../skills/hub';
import { withIdempotency, makeToolKey } from '../agent/idempotency';
import { capabilityChatTools } from './capability-tools';
import { mcpChatTools } from './mcp-tools';
import { listCapabilitiesForUser } from '../capabilities';
import { registerTool, getRegisteredTool, invokeRegisteredTool, type ToolContext } from './registry';
import { timeoutForTool, ToolInvocationError } from './policy';

/**
 * V8 · O5（第一步）：对话工具定义从 `app/api/chat/route.ts` 搬出。
 *
 * 为什么搬：route 原本 1136 行，其中 360 行是 13 个工具的内联定义，混在
 * 「鉴权 → 检索 → 记忆 → 提示词拼装 → 工具 → 流式 → 落库」的请求编排里。
 * 这带来两个后果：
 *   1. 想给工具加统一策略（超时/审计/权限）必须改 route，而 route 太大、没人敢动；
 *   2. 工具定义无法单测——它闭包依赖 10+ 个请求级变量。
 * 搬出来后工具成为「接收 context 的纯构造」，route 只负责编排。
 *
 * **行为严格不变**：本文件是把原代码整体搬运，唯一改动是把闭包变量换成
 * `ctx` 上的显式字段（userId / role / conversationId / convProjectId / prompt /
 * allowedKbIds）。没有顺手改逻辑，便于 diff 审查与回滚。
 *
 * 注意：这里**不做**超时/审计/防打转包装。那些是编排层的职责（route 里的
 * `withToolPolicy(toolGuard.wrap(...))`），放这里会让「工具是什么」和
 * 「工具怎么被管控」重新耦合，等于白搬。
 */

export type ChatToolContext = {
  userId: string;
  role: string;
  conversationId: string;
  /** 当前对话绑定的项目 id（未绑定为 null）；generate_ppt 归档时用 */
  convProjectId?: string | null;
  /** 用户本轮原始问题；generate_ppt 在大纲缺标题时兜底 */
  prompt: string;
  /** 允许检索的知识库 id；空数组表示不限 */
  allowedKbIds: string[];
};

export type ChatTool = {
  description: string;
  parameters: any;
  execute: (args: any) => any;
};

/**
 * 模块级工具定义（与请求无关）。
 *
 * 注意这里是**模块级常量**而不是每次请求重新构造：`registerTool` 写的是全局 Map，
 * 如果定义闭包了请求级变量（userId 等），并发请求之间会串用户。
 * 因此定义只依赖 `(args, ctx)` 两个入参，用户身份一律从 ctx 读。
 */
export type ChatToolDef = {
  description: string;
  parameters: any;
  invoke: (args: any, ctx: ToolContext) => any;
};

/**
 * call_connector 的「自愈」兜底。
 *
 * 背景：模型很容易把「能力目录里的三方能力」当成普通连接器来调 —— 实测就是
 * 拿能力提供方的名字去 call_connector，结果命中「未找到连接器 / 暂无连接器」。
 * 与其让模型自己猜，不如在这里把匹配到的能力连同「能力标识」一起回给它，下一步必然能改对。
 */
async function capabilityCallHint(rawKey: string, actor: { userId: string; role: string }): Promise<string> {
  const key = String(rawKey || '').trim();
  if (!key) return '';
  const lower = key.toLowerCase();
  const caps = await listCapabilitiesForUser(actor);
  const byName = caps.filter(
    (c) => c.id === key || c.key.toLowerCase() === lower || c.name.toLowerCase().includes(lower),
  );
  const byConnector = caps.filter((c) => (c.connectorName || '').toLowerCase().includes(lower));
  const seen = new Set<string>();
  const hits = [...byName, ...byConnector].filter((c) => (seen.has(c.id) ? false : (seen.add(c.id), true))).slice(0, 5);
  if (!hits.length) return '';
  return (
    `「${key}」不是普通连接器，而是能力目录里的能力（能力提供方会把接口暴露成能力），不能用 call_connector 调用。\n` +
    `请立即改用 invoke_capability，name 传下列能力标识：\n` +
    hits
      .map((c) => `- ${c.name}：${c.id}${c.connectorName ? `（提供方 ${c.connectorName}）` : ''}`)
      .join('\n') +
    `\ninput 传符合该能力参数定义的 JSON 对象；无参数传 {}。`
  );
}

/**
 * 构造本轮对话可用的全部工具：13 个内置工具 + 能力目录工具 + MCP 动态工具。
 * MCP 工具需要握手，因此本函数是 async。
 */
const DEFS: Record<string, ChatToolDef> = {
    propose_skill_install: {
      description:
        '当用户要求「安装/导入某个技能」（给出 @handle/slug、skillhub.cn 链接、skills.sh 链接或 owner/repo/skill）时调用。' +
        '本工具只做只读拉取并生成一条「安装提议」，不会直接安装——需要管理员在界面点「确认安装」后才会生效。' +
        '调用前请先向用户复述该技能的名称、版本与安全扫描结论。',
      parameters: jsonSchema({
        type: 'object',
        properties: { ref: { type: 'string', description: '技能引用，如 @user_3b34947d/ppt-generator-skill' } },
        required: ['ref'],
      }),
      invoke: async (args: any, toolCtx: ToolContext) => {
        const { ref } = args as { ref: string };
        const { userId, role, conversationId, prompt, convProjectId, allowedKbIds } = toolCtx as ChatToolContext;
        try {
          const parsed = parseSkillRef(ref);
          if (!parsed) return '无法解析该技能引用。支持：@handle/slug、https://skillhub.cn/@handle/slug、https://skills.sh/owner/repo/skill、owner/repo/skill';
          // 幂等：重放会给同一次请求建出两条 pending 提议，管理员看到重复卡片无从判断该批哪条
          const { value } = await withIdempotency(
            makeToolKey(conversationId, 'propose_skill_install', { ref: String(ref || '').trim() }),
            async () => {
              const meta = await fetchSkillMeta(parsed);
              const id = newId('prop');
              await db.insert(skillProposals).values({
                id,
                ref: String(ref || '').trim(),
                source: meta.source,
                sourceLabel: meta.sourceLabel,
                name: meta.name,
                description: meta.description,
                version: meta.version,
                author: meta.author,
                security: JSON.stringify(meta.security),
                files: JSON.stringify(meta.files),
                scriptFiles: JSON.stringify(meta.scriptFiles),
                bodyPreview: meta.bodyPreview,
                body: meta.body,
                status: 'pending',
                requestedBy: userId,
                createdAt: Date.now(),
              });
              await logAction(userId, 'skill_propose', meta.sourceLabel);
              const sec = meta.security.length
                ? meta.security.map((x) => `${x.vendor}: ${x.statusText || x.status}`).join('；')
                : '无安全扫描报告';
              return [
                `已生成安装提议（待确认）：${meta.name} v${meta.version}（来源 ${meta.sourceLabel}，作者 ${meta.author}）`,
                `安全扫描：${sec}`,
                `文件：${meta.files.length} 个${meta.scriptFiles.length ? `（其中 ${meta.scriptFiles.length} 个脚本本平台不执行）` : ''}`,
                `说明：${meta.description}`,
                `提议编号：${id}`,
                role === 'admin'
                  ? '请让用户在下方「安装提议」卡片中点击【确认安装】。'
                  : '请让管理员在「安装提议」卡片中点击【确认安装】。',
              ].join('\n');
            },
          );
          return value;
        } catch (e: any) {
          return `读取技能失败：${String(e?.message || e).slice(0, 200)}`;
        }
      },
    },
    search_knowledge: {
      description: '在团队知识库中检索与问题相关的文档片段。当用户询问文档、资料或内部知识时调用。',
      parameters: jsonSchema({
        type: 'object',
        properties: { query: { type: 'string', description: '检索关键词或问题' } },
        required: ['query'],
      }),
      invoke: async (args: any, toolCtx: ToolContext) => {
        const { query } = args as { query: string };
        const { userId, role, conversationId, prompt, convProjectId, allowedKbIds } = toolCtx as ChatToolContext;
        // V8.3 · R6：原来写的是 `allowedKbIds.length ? allowedKbIds : undefined`，
        // 而 `rag.ts` 把「空/undefined」当作**不加过滤**——用户一旦没有任何可见知识库，
        // 这次检索就退化成全库扫描，把别人的个人库内容捞出来。必须在这里就截断。
        if (!allowedKbIds.length) return '当前用户没有可见的知识库，无法检索。';
        const r = await retrieve(query, 5, allowedKbIds);
        return r.length ? r.map((h, i) => `[${i + 1}] (来源:${h.source})\n${h.content}`).join('\n\n') : '知识库无相关片段。';
      },
    },
    read_file: {
      description: '读取当前用户已上传的文件内容（按文件名）。用于读取用户提供的资料。',
      parameters: jsonSchema({
        type: 'object',
        properties: {
          filename: { type: 'string' },
          maxChars: { type: 'number' },
        },
        required: ['filename'],
      }),
      invoke: async (args: any, toolCtx: ToolContext) => {
        const { filename, maxChars } = args as { filename: string; maxChars?: number };
        const { userId, role, conversationId, prompt, convProjectId, allowedKbIds } = toolCtx as ChatToolContext;
        const f = (await db.select().from(F).where(eq(F.ownerId, userId)).limit(50))
          .find((x) => x.filename === filename) ||
          (await db.select().from(F).where(eq(F.scope, 'team')).limit(50)).find((x) => x.filename === filename);
        if (!f) return `未找到文件: ${filename}`;
        try {
          const abs = resolveSafe(f.path);
          const content = await fs.readFile(abs, 'utf8');
          return content.slice(0, maxChars || 4000);
        } catch (e: any) {
          return `读取失败: ${String(e?.message || e)}`;
        }
      },
    },
    run_skill: {
      description:
        '运行一个已配置的技能（多 Agent 工作流）。当用户明确要求执行某技能时调用。' +
        'skillId 可传技能 id（skill_xxx）或技能名称（如 ppt-generator）；不确定名称时先调用 list_my_skills。',
      parameters: jsonSchema({
        type: 'object',
        properties: {
          skillId: { type: 'string', description: '技能 id 或技能名称' },
          input: { type: 'string', description: '传给技能的输入（用户的原始要求/资料）' },
        },
        required: ['skillId', 'input'],
      }),
      invoke: async (args: any, toolCtx: ToolContext) => {
        const { skillId, input } = args as { skillId: string; input: string };
        const { userId, role, conversationId, prompt, convProjectId, allowedKbIds } = toolCtx as ChatToolContext;
        // 1) 先按 id 精确匹配；2) 再按名称（忽略大小写）匹配；3) 最后按名称/描述模糊匹配。
        // 这样模型传「ppt-generator」这类名称也能命中，而不是只认内部 id。
        const all = await db.select().from(skills);
        const visible = all.filter((k) => k.ownerId === userId || k.scope === 'team' || k.scope === 'builtin');
        const key = String(skillId || '').trim().toLowerCase();
        const sk =
          visible.find((k) => k.id === skillId) ||
          visible.find((k) => (k.name || '').toLowerCase() === key) ||
          visible.find((k) => (k.name || '').toLowerCase().includes(key)) ||
          visible.find((k) => (k.description || '').toLowerCase().includes(key));
        if (!sk) {
          const names = visible.map((k) => k.name).slice(0, 20).join('、') || '（暂无可用技能）';
          return `未找到技能：${skillId}。当前可用技能：${names}。请用技能名称或 id 重试。`;
        }
        const steps = JSON.parse(sk.steps || '[]');
        // V8 · R3 幂等：同一会话内「相同技能 + 相同输入」只跑一次，避免 streamText 重试重跑工作流烧额度
        const idemKey = makeToolKey(conversationId, 'run_skill', { id: sk.id, input });
        const { value } = await withIdempotency(idemKey, async () => {
          // 技能在对话里被调用，也要按「技能通道」治理一次：它的产出会先进模型上下文、
          // 再进最终回答。对话层的护栏只管最终那段文本——若技能产出里带了不该外发的内容，
          // 它已经先一步进了上下文，等于绕过了外发前的最后一道闸。
          // 走门面而不是裸 runSkill，是为了让「运行即治理」成为默认值，不靠调用方记得。
          const r = await runSkillGoverned(steps, input, {
            modelId: sk.modelId ?? undefined,
            userId,
            source: 'skill',
            label: sk.name,
            question: input,
          });
          return r.text;
        });
        return value;
      },
    },
    generate_ppt: {
      description:
        '根据一段结构化大纲生成真正的 .pptx 文件并归档，返回下载链接。' +
        '当用户要求「做 PPT / 生成演示文稿 / 用某技能生成 PPT」时使用。' +
        'outline 必须是 Markdown：# 主题，然后每页一个「## 页面标题」，下面用「- 要点」列出内容（6~10 页，每页 3~5 条，每条不超过 30 字）。',
      parameters: jsonSchema({
        type: 'object',
        properties: {
          outline: { type: 'string', description: 'Markdown 大纲：# 主题 + 若干「## 页面标题」+「- 要点」' },
          theme: {
            type: 'string',
            description: '配色主题：tech（深色科技）/ business（浅色商务）/ warm（暖色）/ green（清新绿）/ minimal（极简白）',
          },
        },
        required: ['outline'],
      }),
      invoke: async (args: any, toolCtx: ToolContext) => {
        const { outline, theme } = args as { outline: string; theme?: string };
        const { userId, role, conversationId, prompt, convProjectId, allowedKbIds } = toolCtx as ChatToolContext;
        try {
          // 幂等：PPT 生成是重操作（渲染 + 落盘 + 建产物记录），重放会产生两份文件、
          // 两条产物记录，用户要在下载列表里自己分辨哪个是「对的」。
          // TTL 取 10 分钟：生成本身可能超过默认的 2 分钟，账本不能在执行中途过期被别人接管。
          const { value } = await withIdempotency(
            makeToolKey(conversationId, 'generate_ppt', { outline: String(outline || ''), theme: theme || 'tech' }),
            async () => {
              const titleMatch = String(outline || '').match(/^#\s+(.+)$/m);
              const title = (titleMatch?.[1] || prompt).slice(0, 60);
              const buf = await buildPptx(title, String(outline || prompt), theme || 'tech');
              const safe = title.replace(/[^\w一-鿿-]+/g, '_').slice(0, 50) || 'presentation';
              const filename = `${safe}.pptx`;
              const artId = await saveArtifact({
                ownerId: userId,
                projectId: convProjectId,
                conversationId,
                type: 'ppt',
                title,
                filename,
                buf,
              });
              await logAction(userId, 'generate_ppt', title);
              return `已生成 PPT（${(buf.length / 1024).toFixed(0)} KB）：[下载 ${filename}](/api/artifacts/${artId})`;
            },
            600_000,
          );
          return value;
        } catch (e: any) {
          // 失败必须在 withIdempotency 外面捕获：抛出去才会释放账本条目，
          // 否则「一次失败的生成」会被记成已完成，用户重试时直接拿回同一条错误文案。
          return `生成 PPT 失败：${String(e?.message || e).slice(0, 200)}`;
        }
      },
    },
    list_project_members: {
      description: '查询当前对话所绑定项目的成员名单。当用户询问“这个项目有哪些成员 / 谁在项目里”时调用。',
      parameters: jsonSchema({ type: 'object', properties: {}, required: [] }),
      invoke: async (args: any, toolCtx: ToolContext) => {
        const { userId, role, conversationId, prompt, convProjectId, allowedKbIds } = toolCtx as ChatToolContext;
        const c = (await db.select().from(conversations).where(eq(conversations.id, conversationId)).limit(1))[0];
        if (!c?.projectId) return '当前对话未绑定任何项目。';
        const proj = (await db.select().from(projects).where(eq(projects.id, c.projectId)).limit(1))[0];
        const ms = await db
          .select({ name: U.name, email: U.email })
          .from(projectMembers)
          .leftJoin(U, eq(projectMembers.userId, U.id))
          .where(eq(projectMembers.projectId, c.projectId));
        if (!ms.length) return `项目「${proj?.name || ''}」当前没有成员。`;
        return (
          `项目「${proj?.name || ''}」的成员（${ms.length}）：\n` +
          ms.map((m, i) => `${i + 1}. ${m.name || '(无名)'}（${m.email || ''}）`).join('\n')
        );
      },
    },
    get_my_quota: {
      description: '查询“我”的 Token 额度与用量、存储用量、超限策略。当用户问“我还剩多少额度/我的用量/我的存储”时调用。',
      parameters: jsonSchema({ type: 'object', properties: {}, required: [] }),
      invoke: async (args: any, toolCtx: ToolContext) => {
        const { userId, role, conversationId, prompt, convProjectId, allowedKbIds } = toolCtx as ChatToolContext;
        const u = (await db.select().from(U).where(eq(U.id, userId)).limit(1))[0];
        const period = periodNow();
        const usedRow = (await db.select().from(USG).where(and(eq(USG.userId, userId), eq(USG.period, period))).limit(1))[0];
        const used = usedRow?.tokensUsed || 0;
        const limit = u?.monthlyLimit || 0;
        const pct = limit ? Math.round((used / limit) * 100) : 0;
        const storageUsed = Number((await db.select({ v: sql`coalesce(sum(${F.size}),0)` }).from(F).where(eq(F.ownerId, userId)))[0]?.v || 0);
        const quota = u?.storageQuota ?? 0; // ?? 而非 ||：与文件上传接口保持同一口径（0 表示禁止存储）
        const fmt = (n: number) => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`);
        const action = u?.overQuotaAction === 'downgrade' ? '超限降级' : u?.overQuotaAction === 'warn' ? '仅告警' : '超限拦截';
        return (
          `本月（${period}）Token：已用 ${used.toLocaleString()} / 额度 ${limit.toLocaleString()}（剩余 ${Math.max(0, limit - used).toLocaleString()}，${pct}%）；超限策略：${action}；告警阈值：${u?.alertThreshold ?? 80}%。\n` +
          `存储：已用 ${fmt(storageUsed)} / 配额 ${fmt(quota)}。`
        );
      },
    },
    list_my_projects: {
      description: '列出“我”可以访问的项目以及我在其中的角色。当用户问“我有哪些项目/我的项目”时调用。',
      parameters: jsonSchema({ type: 'object', properties: {}, required: [] }),
      invoke: async (args: any, toolCtx: ToolContext) => {
        const { userId, role, conversationId, prompt, convProjectId, allowedKbIds } = toolCtx as ChatToolContext;
        const all = await db.select().from(projects);
        const mine = await db.select().from(projectMembers).where(eq(projectMembers.userId, userId));
        const memberIds = new Set(mine.map((m) => m.projectId));
        const vis = all.filter((p) => p.ownerId === userId || p.visibility === 'team' || (p.visibility === 'members' && memberIds.has(p.id)));
        if (!vis.length) return '你当前没有任何项目。';
        return vis
          .map((p, i) => {
            const v = p.visibility === 'team' ? '团队' : p.visibility === 'members' ? '指定成员' : '个人';
            const roleLabel = p.ownerId === userId ? '我是创建者' : memberIds.has(p.id) ? '我是成员' : '团队可见';
            return `${i + 1}. ${p.name}（${v}，${roleLabel}）`;
          })
          .join('\n');
      },
    },
    list_my_files: {
      description: '列出“我”已上传的文件。当用户问“我有哪些文件/我的文件”时调用。',
      parameters: jsonSchema({ type: 'object', properties: {}, required: [] }),
      invoke: async (args: any, toolCtx: ToolContext) => {
        const { userId, role, conversationId, prompt, convProjectId, allowedKbIds } = toolCtx as ChatToolContext;
        const rows = await db.select().from(F).where(eq(F.ownerId, userId)).orderBy(F.createdAt);
        if (!rows.length) return '你还没有上传文件。';
        return rows.map((f, i) => `${i + 1}. ${f.filename}（${(f.size / 1024).toFixed(1)} KB，${f.scope === 'team' ? '团队' : '个人'}）`).join('\n');
      },
    },
    list_my_skills: {
      description: '列出“我”可用（我创建或团队共享）的技能。当用户问“我有哪些技能”时调用。',
      parameters: jsonSchema({ type: 'object', properties: {}, required: [] }),
      invoke: async (args: any, toolCtx: ToolContext) => {
        const { userId, role, conversationId, prompt, convProjectId, allowedKbIds } = toolCtx as ChatToolContext;
        const rows = await db.select().from(skills).where(or(eq(skills.ownerId, userId), eq(skills.scope, 'team'), eq(skills.scope, 'builtin')));
        if (!rows.length) return '暂无可用技能。';
        return rows.map((k, i) => `${i + 1}. ${k.name}（${k.scope === 'builtin' ? '内置' : k.scope === 'team' ? '团队' : '个人'}${k.ownerId === userId ? '，我创建' : ''}）`).join('\n');
      },
    },
    list_my_schedules: {
      description: '列出“我”的定时任务。当用户问“我有哪些定时任务”时调用。',
      parameters: jsonSchema({ type: 'object', properties: {}, required: [] }),
      invoke: async (args: any, toolCtx: ToolContext) => {
        const { userId, role, conversationId, prompt, convProjectId, allowedKbIds } = toolCtx as ChatToolContext;
        const rows = await db.select().from(schedules).where(or(eq(schedules.ownerId, userId), eq(schedules.scope, 'team')));
        if (!rows.length) return '你还没有定时任务。';
        return rows.map((r, i) => `${i + 1}. ${r.name}（${r.cron}，${r.enabled ? '启用' : '停用'}，${r.scope === 'team' ? '团队' : '个人'}）`).join('\n');
      },
    },
    create_todo: {
      description:
        '当你从对话中得出明确、可执行的后续行动（如“下周三交付周报”“核对这份文档”）时，调用此工具为用户创建一条待办。title 用一句行动描述（不超过 60 字），detail 可带关键上下文。',
      parameters: jsonSchema({
        type: 'object',
        properties: {
          title: { type: 'string', description: '行动项标题，一句话，不超过 60 字' },
          detail: { type: 'string', description: '可选：补充说明/关键上下文' },
        },
        required: ['title'],
      }),
      invoke: async (args: any, toolCtx: ToolContext) => {
        const { title, detail } = args as { title: string; detail?: string };
        const { userId, role, conversationId, prompt, convProjectId, allowedKbIds } = toolCtx as ChatToolContext;
        const t = String(title || '').trim();
        if (!t) return '标题不能为空，未创建。';
        // V8 · R3 幂等：同一会话内相同待办只建一次（防 streamText 重试重复落库）
        const idemKey = makeToolKey(conversationId, 'create_todo', { title: t, detail: detail || '' });
        const { value } = await withIdempotency(idemKey, async () => {
          await db.insert(todosT).values({
            id: newId('todo'),
            userId,
            scope: 'personal',
            title: t.slice(0, 120),
            detail: detail ? String(detail).slice(0, 2000) : null,
            status: 'open',
            source: 'chat',
            sourceRef: JSON.stringify({ conversationId }),
            createdAt: Date.now(),
          });
          return `已创建待办：「${t}」，用户可在工作台查看并勾选完成。`;
        });
        return value;
      },
    },
    list_my_connectors: {
      description:
        '列出当前用户可用的「普通外部连接器」（HTTP 接口 / 数据库 / MCP 等）。' +
        '当用户要求「调用某个后端接口 / 查外部系统 / 接入三方 API」且不确定连接器名时调用。' +
        '注意：第三方系统把接口以「能力」形式暴露在能力目录里，不在本工具的列表中，查询能力请用 list_capabilities。',
      parameters: jsonSchema({ type: 'object', properties: {}, required: [] }),
      invoke: async (args: any, toolCtx: ToolContext) => {
        const { userId, role, conversationId, prompt, convProjectId, allowedKbIds } = toolCtx as ChatToolContext;
        const rows = await db.select().from(connectors).where(eq(connectors.enabled, true)).limit(100);
        const visible = rows.filter((r) => {
          try {
            const vr = JSON.parse(r.visibleRoles || '[]');
            return !Array.isArray(vr) || !vr.length || vr.includes(role);
          } catch {
            return true;
          }
        });
        if (!visible.length) {
          return (
            '当前没有可用的普通 HTTP 连接器。' +
            '（第三方系统的接口以「能力」形式存在，不在本列表中：请用 list_capabilities 查看、invoke_capability 调用。）'
          );
        }
        return (
          '可用连接器：\n' +
          visible
            .map((c, i) => {
              const url = String(parseConnectorConfig(c.config).url || '');
              return `${i + 1}. ${c.name}（类型 ${c.type}${url ? `，地址 ${url}` : ''}）`;
            })
            .join('\n') +
          '\n\n如需调用，请使用 call_connector 工具并传入连接器名称。'
        );
      },
    },
    call_connector: {
      description:
        '调用一个已配置的「普通外部连接器」（三方后端接口 / 数据库等），获取真实数据。' +
        '当用户提供了接口地址、要求查询外部系统数据，或已配置了对应连接器（如行情、订单、CRM）时调用。' +
        'name 为连接器名称（不确定时先调用 list_my_connectors）；input 会替换连接器配置中的 {{input}} 占位符（例如作为查询关键词或请求体参数）。' +
        '⚠️ 能力目录里的能力（第三方系统暴露的能力）不能用本工具，必须用 invoke_capability。',
      parameters: jsonSchema({
        type: 'object',
        properties: {
          name: { type: 'string', description: '连接器名称（如 a-stock-quote）' },
          input: { type: 'string', description: '传给接口的参数，将替换配置里的 {{input}} 占位符' },
        },
        required: ['name'],
      }),
      invoke: async (args: any, toolCtx: ToolContext) => {
        const { name, input } = args as { name: string; input?: string };
        const { userId, role, conversationId, prompt, convProjectId, allowedKbIds } = toolCtx as ChatToolContext;
        const rows = await db.select().from(connectors).where(eq(connectors.enabled, true)).limit(100);
        const key = String(name || '').trim().toLowerCase();
        const c =
          rows.find((x) => (x.name || '').toLowerCase() === key) ||
          rows.find((x) => (x.name || '').toLowerCase().includes(key));
        if (!c) {
          // 自愈：模型很可能拿三方系统名 / 能力名来调，这里直接把它导向 invoke_capability
          const hint = await capabilityCallHint(name, { userId, role });
          if (hint) return hint;
          const names = rows.map((x) => x.name).slice(0, 20).join('、') || '（暂无普通 HTTP 连接器）';
          return (
            `未找到连接器：${name}。可用连接器：${names}。` +
            '若你要调的是能力目录里的能力（第三方系统暴露的），请改用 invoke_capability（可先 list_capabilities 查看能力标识）。'
          );
        }
        if (role === 'guest') return '访客无权调用外部连接器。';
        await logAction(userId, 'call_connector', c.name);
        /**
         * 只对「会改变下游状态」的调用做幂等，GET 一律放行。
         *
         * 为什么这样分：GET 是只读查询，去重会把旧数据返回给用户——同一会话里问两次
         * 「现在茅台多少钱」，第二次在 TTL 内会拿到第一次的价格，这是直接的错误答案。
         * 而 POST/PUT/DELETE 重放意味着重复下单、重复提交、重复扣款，才是真正要挡的。
         */
        const method = String(parseConnectorConfig(c.config)?.method || 'GET').toUpperCase();
        if (method === 'GET' || method === 'HEAD') {
          return callConnector(c, userId, String(input || ''));
        }
        // 写操作：失败结果也一并记账（不抛错 → 条目保留）。
        // 刻意如此：未知状态下重发写请求，比让用户看到上一次的失败信息更危险。
        const { value } = await withIdempotency(
          makeToolKey(conversationId, 'call_connector', { name: c.name, input: String(input || ''), method }),
          () => callConnector(c, userId, String(input || '')),
          300_000,
        );
        return value;
      },
    },
};

let registered = false;

/**
 * 有外部影响或写操作的工具：跑工作流（烧额度）、生成文件、建待办、调外部接口、发起安装提议。
 * 其余（检索/读文件/各类 list/get_my_quota）为只读。
 *
 * 这里**只做风险标注**，不改变现有行为：
 *   - `permission` 写工具设 member、只读设 guest —— 实际入口已拦访客，故行为不变；
 *   - `requiresApproval` 一律保持 false。**审批开关是产品决策**：一开，普通成员建一条
 *     待办都要管理员批，体验会变。不该由重构顺手决定，等确认后再逐工具开启。
 */
const WRITE_TOOLS = new Set([
  'run_skill',
  'generate_ppt',
  'create_todo',
  'call_connector',
  'propose_skill_install',
]);

/** 把 14 个内置工具注册进统一 registry（进程内一次）。 */
function ensureChatToolsRegistered(): void {
  if (registered) return;
  for (const [name, def] of Object.entries(DEFS)) {
    registerTool({
      name,
      title: name,
      description: def.description,
      parameters: def.parameters,
      permission: WRITE_TOOLS.has(name) ? 'member' : 'guest',
      timeoutMs: timeoutForTool(name),
      invoke: def.invoke,
    });
  }
  registered = true;
}

/**
 * 构造本轮对话可用的全部工具：14 个内置工具（走 registry）+ 能力目录工具 + MCP 动态工具。
 *
 * 内置工具不再直接暴露 execute，而是统一经 `invokeRegisteredTool` 调用，从而获得
 * registry 的**权限校验 → 审批 → 超时 → 审计（入参/返回 PII 脱敏）**四道处理。
 * 这也是 R1「工具双轨制」的闭合点：此前只有能力工具走这套，对话工具完全绕过。
 */
export async function buildChatTools(ctx: ChatToolContext): Promise<Record<string, ChatTool>> {
  ensureChatToolsRegistered();
  const toolCtx: ToolContext = { ...ctx, source: 'chat' };
  const mcpTools = await mcpChatTools({ userId: ctx.userId, role: ctx.role, source: 'chat', conversationId: ctx.conversationId });

  const out: Record<string, ChatTool> = {};
  for (const name of Object.keys(DEFS)) {
    const def = getRegisteredTool(name);
    if (!def) continue; // 理论上不会发生；注册失败时宁可少一个工具，也不要抛错拖垮整轮
    out[name] = {
      description: def.description,
      parameters: def.parameters,
      execute: async (args: any) => {
        const r = await invokeRegisteredTool(name, args, toolCtx);
        // registry 内部已 catch，永不抛错。但上层两个守卫依赖「异常」判断失败：
        //   - 防打转（loop-guard）靠抛错来决定「失败不计数」，失败若被当成功，
        //     模型换个参数重试会被误短路；
        //   - 策略层（policy）靠抛错来决定返回哪种可读文案。
        // 所以这里把业务性失败重新抛成 ToolInvocationError，同时带上已可读的 text。
        if (!r.ok) throw new ToolInvocationError(r.text);
        return r.text;
      },
    };
  }

  return {
    ...out,
    ...capabilityChatTools({ userId: ctx.userId, role: ctx.role, source: 'chat', conversationId: ctx.conversationId }),
    ...mcpTools,
  };
}
