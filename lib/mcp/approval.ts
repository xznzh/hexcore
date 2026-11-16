/**
 * MCP 工具的审批闸（V8.5）。
 *
 * ── 缺口 ──
 *
 * `lib/tools/registry.ts` 早有一套审批：权限 → 审批 → 超时 → 审计，普通成员调
 * `requiresApproval` 的工具会落一条 `pending_approval`，管理员在能力页批完再执行。
 * 但 **MCP 工具没有走注册表**：它们是 `mcpChatTools()` 里现拼的 AI SDK 工具对象，
 * 自带 `execute` 闭包，直接连远端。于是同一个平台上存在两种工具语义：
 *
 *   注册表工具：成员调用要审批；
 *   MCP 工具：任何登录用户、任何工具、任意参数，模型想调就调。
 *
 * 这是 R 系列里最常见的一类缺口——**机制存在，但只装在一条路上**。
 * 而 MCP 恰好是风险更高的一侧：工具由第三方服务定义，描述与参数 schema 都不由我们控制
 * （tool poisoning 的标准载体），一次 `filesystem:write_file` 就足够把数据写到别处。
 *
 * ── 为什么复用 `capability_operations` 而不是新建表 ──
 *
 * 审批的价值有一半在「只有一个收件箱」。管理员已经习惯在能力页看待审批，
 * 再开一张表 = 两个页面、两套状态机、两份审计口径。这里沿用既有记录形态：
 * `capabilityId = null` + `input = { tool, args, mcp }`，与注册表工具完全同构，
 * `decideApproval` 只需按 `mcp` 字段分流执行器。
 *
 * ── 策略：按连接器配置，不搞全局开关 ──
 *
 * | 值 | 含义 |
 * |---|---|
 * | `auto`（默认） | 读语义工具放行，写语义 / 认不出来的工具要审批；管理员豁免 |
 * | `always` | 该连接器的所有工具都要审批，**管理员也不例外**（给高危服务用） |
 * | `never` | 不审批（只在确认该服务无副作用时使用） |
 *
 * `auto` 里「认不出来就要审批」是刻意的 fail-closed：工具名是第三方起的，
 * 猜错一个词的代价是「多一次点击」，而猜反的代价是「静默执行了一次写操作」。
 * 觉得吵的话，正确的降级动作是给**这个连接器**设 `never`，而不是把判断改成猜读。
 */

import { db } from '../db';
import { capabilityOperations } from '../schema';
import { logAction, newId } from '../util';

export type McpApprovalPolicy = 'auto' | 'always' | 'never';

const POLICIES: McpApprovalPolicy[] = ['auto', 'always', 'never'];

export function normalizeMcpApproval(v: unknown): McpApprovalPolicy {
  const s = String(v ?? '').trim().toLowerCase();
  return (POLICIES as string[]).includes(s) ? (s as McpApprovalPolicy) : 'auto';
}

/**
 * 写语义动词。命中即审批。
 *
 * 顺序很重要：**先查写、再查读**。"get_or_create"、"search_and_delete" 这类复合名
 * 必须被写动词抓住——只做前缀判断会被它们整个放过。
 */
const WRITE_VERBS = new Set([
  'create', 'update', 'delete', 'remove', 'drop', 'insert', 'upsert', 'write', 'edit',
  'patch', 'put', 'post', 'send', 'publish', 'upload', 'exec', 'execute', 'run', 'invoke',
  'call', 'set', 'add', 'append', 'modify', 'move', 'rename', 'copy', 'grant', 'revoke',
  'deploy', 'restart', 'kill', 'stop', 'start', 'apply', 'submit', 'commit', 'push', 'pull',
  'sync', 'import', 'install', 'uninstall', 'migrate', 'clear', 'reset', 'truncate', 'chmod',
  'chown', 'format', 'mkdir', 'rmdir', 'touch', 'save', 'store', 'merge', 'replace', 'assign',
]);

/** 读语义动词：只有工具名的**第一个词**命中才算读（"search_and_delete" 不算） */
const READ_VERBS = new Set([
  'get', 'list', 'read', 'search', 'query', 'fetch', 'lookup', 'find', 'describe', 'inspect',
  'show', 'status', 'health', 'ping', 'view', 'count', 'stat', 'stats', 'summary', 'explain',
  'resolve', 'preview', 'diff', 'exists', 'check', 'export', 'download', 'render', 'browse',
]);

/** camelCase / kebab / dotted 都拆成词，便于逐词判定 */
function wordsOf(name: string): string[] {
  return String(name || '')
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .split(/[^A-Za-z0-9]+/)
    .map((w) => w.toLowerCase())
    .filter(Boolean);
}

/**
 * 该次调用是否需要审批。
 *
 * 注意传的是**远端原始工具名**（`create_issue`），不是命名空间后的
 * `mcp__<连接器>__<工具>`——后者掺了连接器名，一个叫 `get_data` 的连接器
 * 会让它下面所有工具都被判成读。
 */
export function mcpToolNeedsApproval(policy: McpApprovalPolicy, toolName: string, role: string): boolean {
  if (policy === 'never') return false;
  if (policy === 'always') return true;
  // auto：管理员豁免（与注册表 `requiresApproval` 语义一致，避免运维自己把自己锁在外面）
  if (role === 'admin') return false;
  const words = wordsOf(toolName);
  if (!words.length) return true;
  if (words.some((w) => WRITE_VERBS.has(w))) return true;
  return !READ_VERBS.has(words[0]);
}

export type McpApprovalRequest = {
  /** `mcp__<连接器>__<工具>`，与 `capability_operations.input.tool` 一致 */
  toolKey: string;
  /** 远端原始工具名 */
  toolName: string;
  connectorId: string;
  connectorName: string;
  args: Record<string, any>;
  userId: string;
  role: string;
  source?: string;
  conversationId?: string;
};

/**
 * 落一条待审批记录，返回给模型的提示语。
 *
 * 入参落库要**截断**：某些 MCP 工具的参数体可以到几十 KB（批量 SQL、整篇文章），
 * 原样存进 `input` 会把一行撑爆，也会顺带把敏感内容写进操作记录。
 * 真正执行时用的是这里存下的参数（审批即执行同一份），所以截断只影响「记录可读性」：
 * 超长参数会被换成占位提示，并且**拒绝审批**——这一点很重要，见 `requestMcpApproval` 的返回。
 */
export async function requestMcpApproval(req: McpApprovalRequest): Promise<{ operationId: string; message: string }> {
  const operationId = newId('op');
  const argsJson = (() => {
    try {
      return JSON.stringify(req.args ?? {});
    } catch {
      return '{}';
    }
  })();
  // 审批后要按原参数执行，所以参数必须完整保存；但超过上限的入参没法安全落库，
  // 与其存一份被截断的、审批后执行出错的参数，不如明确告知「这次调用无法走审批」。
  const MAX_ARGS_CHARS = 16000;
  if (argsJson.length > MAX_ARGS_CHARS) {
    await logAction(req.userId, 'mcp_approval_rejected', `${req.connectorName} / ${req.toolName}`, {
      status: 'error',
      detail: `入参 ${argsJson.length} 字符，超过审批记录上限 ${MAX_ARGS_CHARS}，已拒绝提交审批`,
    }).catch(() => {});
    return {
      operationId: '',
      message:
        `工具「${req.toolName}」需要审批，但本次入参过大（${argsJson.length} 字符，上限 ${MAX_ARGS_CHARS}），` +
        '无法完整保存供审批后执行。请缩小请求范围后重试，或联系管理员把该连接器的审批策略改为 never。',
    };
  }

  await db.insert(capabilityOperations).values({
    id: operationId,
    capabilityId: null,
    connectorId: req.connectorId,
    userId: req.userId,
    status: 'pending_approval',
    input: JSON.stringify({
      tool: req.toolKey,
      args: req.args ?? {},
      mcp: { connectorId: req.connectorId, toolName: req.toolName },
    }),
    source: req.source || 'chat',
    conversationId: req.conversationId || null,
    createdAt: Date.now(),
  });

  await logAction(req.userId, 'mcp_approval_request', `${req.connectorName} / ${req.toolName}`, {
    status: 'pending_approval',
    detail: argsJson.slice(0, 1000),
  }).catch(() => {});

  return {
    operationId,
    message:
      `工具「${req.toolName}」（${req.connectorName}）需要管理员审批，已提交审批（编号 ${operationId}）。` +
      '审批通过后会按本次参数执行，结果可在「能力 · 调用记录」查看；本轮对话不会包含它的返回内容。',
  };
}
