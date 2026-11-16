import { jsonSchema } from 'ai';
import {
  coerceCapabilityInput,
  findCapabilityForUser,
  formatInputErrors,
  invokeCapability,
  listCapabilitiesForUser,
  validateCapabilityInput,
  type CapabilityView,
} from '../capabilities';
import { invokeRegisteredTool, registerTool, type ToolContext } from './registry';
import { wrapUntrusted } from '../guardrails';

/**
 * 能力目录接入聊天：list_capabilities / invoke_capability。
 * 工具本身注册进统一注册表，聊天层只做薄封装，便于后续技能/定时任务复用。
 */

function describeCapability(c: CapabilityView, idx: number): string {
  let schema: any = {};
  try {
    schema = JSON.parse(c.inputSchema || '{}');
  } catch {
    schema = {};
  }
  const props = Object.entries(schema.properties || {})
    .map(([k, v]: [string, any]) => {
      const req = (schema.required || []).includes(k) ? '*' : '';
      const desc = v?.description ? `：${v.description}` : '';
      return `    - ${k}${req} (${v?.type || 'any'})${desc}`;
    })
    .join('\n');
  return [
    `${idx + 1}. ${c.name}（${c.method} ${c.path}${c.connectorName ? `，连接器 ${c.connectorName}` : ''}${c.requiresApproval ? '，需审批' : ''}）`,
    `   能力标识：${c.id}${c.key && c.key !== c.name ? ` / key: ${c.key}` : ''}`,
    c.description ? `   说明：${c.description}` : '',
    props ? `   参数：\n${props}` : '   参数：无',
  ]
    .filter(Boolean)
    .join('\n');
}

let registered = false;

/**
 * 从调用结果里抽出可下载产物（第三方系统返回的 artifacts）。
 * 模型拿到的是 JSON 文本，经常只复述文件名而丢掉 url；这里主动给出一条 Markdown 链接，
 * 用户在气泡里点一下就能下载。
 */
export function artifactLinks(output: string): { filename: string; url: string }[] {
  const start = output.indexOf('{');
  const end = output.lastIndexOf('}');
  if (start < 0 || end <= start) return [];
  try {
    const j = JSON.parse(output.slice(start, end + 1));
    const arr = Array.isArray(j?.artifacts) ? j.artifacts : [];
    return arr
      .filter((a: any) => a && typeof a.url === 'string' && a.url)
      .map((a: any) => ({ filename: String(a.filename || a.name || '下载文件'), url: String(a.url) }));
  } catch {
    return [];
  }
}

function registerOnce() {
  if (registered) return;
  registered = true;

  registerTool({
    name: 'list_capabilities',
    title: '能力目录',
    description:
      '列出当前用户可用的平台能力（由连接器 OpenAPI 自动发现，或内置能力）。' +
      '当用户要求查询外部系统、调用三方接口，但不确定具体能力名时，先调用本工具。',
    parameters: { type: 'object', properties: {}, required: [] },
    permission: 'guest',
    timeoutMs: 15000,
    invoke: async (_input: any, ctx: ToolContext) => {
      const list = await listCapabilitiesForUser({ userId: ctx.userId, role: ctx.role });
      if (!list.length) {
        return '当前没有可用能力。管理员可在「连接器」页面通过 OpenAPI 发现并安装能力，或添加 HTTP 连接器。';
      }
      return `可用能力（${list.length} 个）：\n${list.map(describeCapability).join('\n')}\n\n调用时请使用 invoke_capability，name 传能力标识或能力名，input 传参数对象。`;
    },
  });

  registerTool({
    name: 'invoke_capability',
    title: '调用能力',
    description:
      '调用能力目录中的一个能力（三方接口 / 内置能力），返回真实数据。' +
      '能力目录里出现的能力（含第三方系统暴露的能力）只能用本工具调用，不要用 call_connector。' +
      'name 传能力标识或能力名（不确定时先调用 list_capabilities）；input 传符合该能力参数定义的 JSON 对象。' +
      '部分能力需要管理员审批，调用后会返回「已提交审批」。',
    parameters: jsonSchema({
      type: 'object',
      properties: {
        name: { type: 'string', description: '能力标识或能力名' },
        input: {
          type: 'object',
          description: '能力参数对象，例如 {"city":"北京"}；无参数时传 {}',
          additionalProperties: true,
        },
      },
      required: ['name'],
    }),
    permission: 'guest',
    timeoutMs: 60000,
    invoke: async (input: any, ctx: ToolContext) => {
      const name = String(input?.name || '').trim();
      if (!name) return '缺少能力名（name）。';
      const found = await findCapabilityForUser(name, { userId: ctx.userId, role: ctx.role });
      if (!found) return `未找到可用能力：${name}。可先调用 list_capabilities 查看当前可用能力。`;

      let args: any = input?.input ?? {};
      if (typeof args === 'string') {
        try {
          args = JSON.parse(args);
        } catch {
          args = { input: args };
        }
      }
      if (!args || typeof args !== 'object' || Array.isArray(args)) args = {};

      // 先做一次无损类型纠正（模型常把数字写成字符串），再按 schema 校验
      args = coerceCapabilityInput(found.cap.inputSchema, args);
      const errors = validateCapabilityInput(found.cap.inputSchema, args);
      if (errors.length) {
        const schema = (() => {
          try {
            return JSON.parse(found.cap.inputSchema || '{}');
          } catch {
            return {};
          }
        })();
        const hint = Object.entries(schema.properties || {})
          .map(([k, v]: [string, any]) => {
            const req = (schema.required || []).includes(k) ? '必填' : '可选';
            return `${k}（${v?.type || 'any'}，${req}）`;
          })
          .join('、');
        return `参数不合法：${formatInputErrors(errors)}。${hint ? `该能力参数：${hint}。` : ''}请修正后重试。`;
      }

      const r = await invokeCapability({
        cap: found.cap,
        conn: found.conn,
        input: args,
        actor: { userId: ctx.userId, role: ctx.role },
        source: ctx.source || 'chat',
        conversationId: ctx.conversationId,
      });
      if (r.status === 'pending_approval' || r.status === 'running') return r.message;
      if (r.status === 'failed') return `能力调用失败（${r.durationMs}ms）：${r.error}`;
      const links = artifactLinks(r.output);
      const tail = links.length
        ? '\n\n【可下载产物】请在回答中原样给出下列 Markdown 链接（文件名 + 链接），不要只复述文件名：\n' +
          links.map((l) => `- [${l.filename}](${l.url})`).join('\n')
        : '';
      // 三方返回属于不可信内容（可能被对方系统/用户数据污染），定界后再交给模型
      return `能力调用成功（${r.durationMs}ms）：\n${wrapUntrusted(String(r.output ?? ''), `capability:${found.cap.name}`)}${tail}`;
    },
  });
}

/** 返回 AI SDK 形态的聊天工具（内部走统一注册表，自动审计/超时/审批） */
export function capabilityChatTools(ctx: ToolContext) {
  registerOnce();
  return {
    list_capabilities: {
      description:
        '列出当前用户可用的平台能力（连接器自动发现的三方接口 / 内置能力）。当需要调用外部系统但不确定能力名时先调用。',
      parameters: jsonSchema({ type: 'object', properties: {}, required: [] }),
      execute: async (input: any) => (await invokeRegisteredTool('list_capabilities', input || {}, ctx)).text,
    },
    invoke_capability: {
      description:
        '调用能力目录中的能力，返回真实数据。name 为能力标识或名称；input 为参数对象。' +
        '一切「能力」都必须走本工具，不要用 call_connector。' +
        '不确定能力名时先调用 list_capabilities。需要审批的能力会返回「已提交审批」。',
      parameters: jsonSchema({
        type: 'object',
        properties: {
          name: { type: 'string', description: '能力标识或能力名' },
          input: { type: 'object', description: '能力参数对象', additionalProperties: true },
        },
        required: ['name'],
      }),
      execute: async (input: any) => (await invokeRegisteredTool('invoke_capability', input || {}, ctx)).text,
    },
  };
}
