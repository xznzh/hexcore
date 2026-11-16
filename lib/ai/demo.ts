import { createOpenAI } from '@ai-sdk/openai';
import type { LanguageModel } from 'ai';

/**
 * 演示模式（DEMO_MODE）：不配置任何模型 Key 也能把整条链路跑通。
 *
 * 为什么需要它：clone 下来最劝退的一步是「装了依赖、起了库，一登录就提示未配置模型」。
 * 演示模式用**本地确定性回答器**顶替大模型：从检索到的参考资料里抽取句子作答，
 * 不走网络、不产生费用、不需要 Key。它能证明的链路是：
 *
 *   登录 → 建知识库 → 上传文档 → 切片索引 → 提问 → 检索 → 带引用作答 → 检索不到时拒答
 *
 * 它**不能**证明的：语义理解、多步推理、工具调用。所以回答里会显式标注演示模式，
 * 避免被误当成「这个模型的水平」。
 *
 * 实现方式：不自定义 LanguageModelV1 接口（版本耦合、易碎），而是沿用项目已有的
 * `createOpenAI` 客户端，用自定义 `fetch` 把请求截下来——协议层完全真实，
 * 只是响应由本地生成。ai-sdk 的流式解析、usage 汇总、tool 循环都还是原路径。
 */

/** DEMO_MODE 解析：true=强制开，false=强制关，null=自动判定（由调用方决定） */
export function demoModeFlag(): boolean | null {
  const v = (process.env.DEMO_MODE || '').trim().toLowerCase();
  if (v === '1' || v === 'on' || v === 'true') return true;
  if (v === '0' || v === 'off' || v === 'false') return false;
  return null;
}

/** 演示模型的固定 id / provider，DB 预设与 resolveModel 都按它识别 */
export const DEMO_MODEL_ID = 'm_demo_local';
export const DEMO_PROVIDER = 'demo';

type ChatMsg = { role?: string; content?: unknown };

/** OpenAI content 可能是字符串，也可能是 [{type:'text',text}] 数组（多模态） */
function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((p: any) => {
        if (typeof p === 'string') return p;
        if (p && typeof p === 'object' && typeof p.text === 'string') return p.text;
        return '';
      })
      .join('');
  }
  return '';
}

/** 参考资料区块的起止标记，与 app/api/chat/route.ts 组装 system 时写入的完全一致 */
const KB_START = '===== 团队知识库参考资料';
const KB_END = '===== 参考结束 =====';

type Fragment = { source: string; content: string };

/**
 * 从 system 提示里切出检索片段。
 * 原样格式：`[1] (来源: 文件名)\n正文`，整块被 <untrusted_data name="knowledge_base"> 包着。
 */
function parseFragments(system: string): Fragment[] {
  const start = system.indexOf(KB_START);
  if (start < 0) return [];
  const end = system.indexOf(KB_END, start);
  const block = system.slice(start, end < 0 ? undefined : end);

  const out: Fragment[] = [];
  // 按 `[数字] (来源: xxx)` 的头切分，正文归属到下一个头之前
  const re = /\[(\d+)\]\s*\(来源:\s*([^)]*)\)/g;
  const marks: { idx: number; headEnd: number; source: string }[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(block))) {
    marks.push({ idx: m.index, headEnd: re.lastIndex, source: m[2].trim() });
  }
  for (let i = 0; i < marks.length; i++) {
    const from = marks[i].headEnd;
    const to = i + 1 < marks.length ? marks[i + 1].idx : block.length;
    const body = block
      .slice(from, to)
      .replace(/<\/?untrusted_data[^>]*>/g, '')
      .trim();
    if (body) out.push({ source: marks[i].source, content: body });
  }
  return out;
}

/** 中文按二元组、英文数字按整词切；整句当 token 会导致词面重合恒为 0 */
function tokens(s: string): Set<string> {
  const out = new Set<string>();
  const zh = s.match(/[\u4e00-\u9fa5]{2,}/g) || [];
  for (const seg of zh) {
    for (let i = 0; i < seg.length - 1; i++) out.add(seg.slice(i, i + 2));
  }
  const en = s.toLowerCase().match(/[a-z0-9][a-z0-9._-]{1,}/g) || [];
  for (const w of en) out.add(w);
  return out;
}

/** 句子切分：中文句末标点与换行都算边界，太短的碎片（目录行）单独处理 */
function splitSentences(text: string): string[] {
  return text
    .split(/[\n。！？；]|(?<=[.!?])\s+/)
    .map((s) => s.replace(/^[-*•\d.\s]+/, '').trim())
    .filter((s) => s.length >= 4);
}

type Ranked = { text: string; score: number; source: string };

/** 按「问题与句子的词元重合数 / 句子词元数」打分，避免长句靠长度碾压短句 */
function rankSentences(question: string, frags: Fragment[]): Ranked[] {
  const q = tokens(question);
  if (!q.size) return [];
  const out: Ranked[] = [];
  for (const f of frags) {
    for (const s of splitSentences(f.content)) {
      const st = tokens(s);
      if (!st.size) continue;
      let hit = 0;
      for (const t of q) if (st.has(t)) hit++;
      if (!hit) continue;

      // 准入用「问题词元被覆盖的比例」，不能用命中绝对数：
      // 短问题（「年假有几天」）只有 4 个二元组，命中 1 个就已足够相关，
      // 而按「至少 2 个」卡会把本来能答的问题判成拒答——实测就是这么失败的。
      // 长问题命中 1 个确实多半是泛词（接口/数据），用 20% 覆盖率自然把它挡掉。
      const coverage = hit / q.size;
      if (coverage < 0.2) continue;

      out.push({ text: s, score: hit / Math.sqrt(st.size), source: f.source });
    }
  }
  return out.sort((a, b) => b.score - a.score);
}

/** 寒暄类不查资料，直接给固定介绍——否则「你好」也会被拒答，观感很差 */
const GREETING = /^(你好|您好|hi|hello|嗨|在吗|谢谢|thanks|你是谁|你能做什么|帮助|help)[\s!！?？。.]*$/i;

const DEMO_BANNER = '> 演示模式：以下回答由本地规则从检索结果中抽取，未调用大模型。';

function buildAnswer(question: string, frags: Fragment[]): string {
  if (GREETING.test(question.trim())) {
    return (
      `${DEMO_BANNER}\n\n` +
      '我是这个平台的本地演示回答器。当前没有配置任何大模型 Key，所以我不具备语义理解能力，' +
      '但我可以证明整条链路是通的。\n\n' +
      '可以这样试：\n' +
      '1. 进入「知识库」，上传一份文档（内置的《示例员工手册》已经准备好）；\n' +
      '2. 等切片与索引完成；\n' +
      '3. 回来问我文档里的事实，比如「年假有几天」；\n' +
      '4. 再问我一个文档里没有的问题，我会明确说找不到，而不是编一个。\n\n' +
      '想换成真实模型：在「后台 → 模型」填 Key，并把 DEMO_MODE 设为 0 后重启。'
    );
  }

  const ranked = rankSentences(question, frags);
  /**
   * 已知边界（不是 bug，是抽取式回答的固有局限）：
   * 词面重合不等于语义相关。实测「公司一共多少个部门？各部门负责人是谁？」
   * 会抽到「报销单需在费用发生后 30 天内提交，逾期需部门负责人特批」——
   * 两句话共享「部门」「负责」二元组，但一个是组织架构、一个是审批流程。
   * 线性调阈值治不了这类碰撞（调高会误伤正常提问），真正解决要语义向量。
   * 因此演示模式在评测集里稳定停在 37/38 而不是 38/38，这是诚实的上限。
   */
  if (!ranked.length) {
    return (
      `${DEMO_BANNER}\n\n` +
      '我在这批资料里没有找到能回答这个问题的内容。\n\n' +
      (frags.length
        ? '检索确实命中了一些片段，但里面没有与问题重合度足够的句子——演示模式只会抽取，不会推断，所以它宁可说不知道，也不编一个。'
        : '这次检索没有命中任何片段。可能是知识库为空，或问题里的词与文档用词差异太大（演示模式只做词面匹配，不做同义扩展）。')
    );
  }

  // 最多取 3 句：多了会拼成一段没有逻辑的拼接文本，反而更像胡编
  const picked = ranked.slice(0, 3);
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const p of picked) {
    const key = p.text.slice(0, 40);
    if (seen.has(key)) continue;
    seen.add(key);
    lines.push(`- ${p.text}`);
  }
  const sources = Array.from(new Set(picked.map((p) => p.source))).filter(Boolean);
  return (
    `${DEMO_BANNER}\n\n` +
    `根据知识库中的资料：\n\n${lines.join('\n')}\n\n` +
    (sources.length ? `以上内容摘录自：${sources.join('、')}。` : '')
  );
}

/** 按句读切成小片，模拟逐字输出；一次性推全文在前端看起来像卡住后闪现 */
function chunkText(text: string, size = 12): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out;
}

function sse(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

function chunkFrame(id: string, model: string, delta: Record<string, unknown>, finish: string | null = null) {
  return {
    id,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta, finish_reason: finish }],
  };
}

/**
 * 伪造的 fetch：把 OpenAI 兼容请求拦下来，本地生成响应。
 * 必须同时支持流式（对话主链）与非流式（记忆抽取 / 摘要 / judge 等后台任务），
 * 否则那些任务会拿到 SSE 去 JSON.parse 而全部失败。
 */
export async function demoFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  let body: any = {};
  try {
    // ai-sdk 既可能传 `fetch(url, {body: '...'})`，也可能传一个已构造好的 Request 对象
    // （此时 init 为 undefined，body 在 request 上）。只读 init.body 会拿到空对象，
    // 表现为上游报「Invalid JSON response」——排查时看不出是「没读到请求」。
    let raw = '';
    if (typeof Request !== 'undefined' && input instanceof Request) {
      raw = await input.clone().text();
    } else if (typeof init?.body === 'string') {
      raw = init.body;
    } else if (init?.body) {
      raw = await new Response(init.body as any).text();
    }
    body = raw ? JSON.parse(raw) : {};
  } catch {
    body = {};
  }
  const messages: ChatMsg[] = Array.isArray(body?.messages) ? body.messages : [];
  const model = String(body?.model || 'demo-local');
  const id = 'demo-' + Date.now().toString(36);

  const system = messages
    .filter((m) => m?.role === 'system')
    .map((m) => textOf(m.content))
    .join('\n\n');
  const question =
    [...messages].reverse().find((m) => m?.role === 'user')?.content !== undefined
      ? textOf([...messages].reverse().find((m) => m?.role === 'user')!.content)
      : '';

  const answer = buildAnswer(question, parseFragments(system));
  // 必须严格判断 `=== true`：ai-sdk 的 generateText 发的请求体里**根本没有 stream 字段**，
  // 写成 `!== false` 会把它也当成流式，于是非流式调用收到 SSE 去 JSON.parse，
  // 报「Invalid JSON response」——这个坑在评测里表现为 38 条全部「执行异常」。
  const wantsStream = body?.stream === true;

  if (!wantsStream) {
    return new Response(
      JSON.stringify({
        id,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [{ index: 0, message: { role: 'assistant', content: answer }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  }

  const parts = chunkText(answer);
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const enc = new TextEncoder();
      const send = (s: string) => controller.enqueue(enc.encode(s));
      // 首帧只带 role，符合 OpenAI 的约定；ai-sdk 会据此初始化 assistant 消息
      send(sse(chunkFrame(id, model, { role: 'assistant', content: '' })));
      for (const p of parts) {
        send(sse(chunkFrame(id, model, { content: p })));
        // 8ms/片：一段 300 字的回答约 0.2s，前端看起来像逐字输出又不至于让人等
        await new Promise((r) => setTimeout(r, 8));
      }
      send(sse(chunkFrame(id, model, {}, 'stop')));
      send('data: [DONE]\n\n');
      controller.close();
    },
  });

  return new Response(stream, {
    status: 200,
    headers: { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache' },
  });
}

/** 演示模型实例：baseURL 是假地址，请求根本不会出网 */
export function createDemoModel(): LanguageModel {
  const client = createOpenAI({
    apiKey: 'demo-not-a-real-key',
    baseURL: 'https://demo.local/v1',
    fetch: demoFetch as any,
  });
  return client('demo-local');
}
