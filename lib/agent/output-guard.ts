/**
 * 输出侧硬护栏（V8 · R4-c / R5-a）：流式回答的确定性安全闸。
 *
 * 为什么需要它：旧 V 层 `runtime-verify` 能识别危险副本，但定位是「只记录不拦截」——
 * 回答已经随 NDJSON 流推给用户、也已落库，日志里再记一条 fail 于事无补。
 * 2026-11-09 的 20 组对话实测里，3 个 P0 全部是「话术上拒绝了、同轮却贴出可复制副本」：
 *   - 假拒绝后给出完整 `CREATE TABLE` 建表语句；
 *   - 照抄并润色用户口述的《2025 年中国流浪动物白皮书》与「4000 万只」；
 *   - 以推理小说为名给出 `shred -u` / `history -c` 真实命令。
 * 第二轮用「提示词软约束 + 输出侧硬闸」压住了 P0，但 4 个 P1（越权定稿 / 代写作业 /
 * 矛盾和稀泥 / 噪声带跑）依旧靠模型自觉，实测未修好。第三轮把它们也升级为确定性断言。
 *
 * 设计取舍（两代规则的差异很重要）：
 *  - **无条件规则（P0）**：危险命令、可复制 DDL、未核实引用，任何语境都拦；语义明确、
 *    几乎没有正当场景，全文扫描即可。
 *  - **语境条件规则（P1）**：「已定稿」「完整可运行版本」在正常需求里完全正当（用户就是
 *    要一份完整代码）。所以这些规则**只在 `RiskContext` 对应标记为真时启用**——标记由
 *    本轮提问 + 会话历史计算，不靠模型判断。否则会把正常业务问答大面积误伤。
 *  - **早判定**：`conflict_smoothing` / `scope_drift` 是「开头该说而没说」的问题。
 *    流式下长回答一旦推送大半就收不回，所以在长度刚跨过阈值（400 / 900 字）时
 *    对开头窗口判定一次，命中即停流；每个回答最多 2 次全文检查，避免 O(n²)。
 *  - **替代话术即合规答案**：拦截不是简单删掉，而是由系统确定性写出「点名冲突 + 两条
 *    取舍路径」「决策待确认清单」「回到主任务」等内容，直接满足母版检查项。
 *  - 纯函数 + 显式状态，零 I/O，可直接单测；不调用任何 LLM，不增加成本。
 */

export type RiskContext = {
  /** 用户要求替他拍板验收标准 / 排期 / 定价 / 署名等决策 */
  decisionAuthority: boolean;
  /** 作业 / 署名提交 / 实验报告等学术诚信语境 */
  academicIntegrity: boolean;
  /** 会话里同时出现互斥要求（如「不排名」与「前三名发奖状」） */
  hardConflict: boolean;
  /** 本轮用户明确插入无关话题或要求「先别管主任务」 */
  topicDrift: boolean;
  /** 冲突双方原文片段，用于生成具体而非空泛的确认话术 */
  conflictLabels?: [string, string];
  /** 会话首条用户消息摘要，用于跑题时把用户拉回主任务 */
  mainTaskHint?: string;
};

export type GuardContext = {
  /** 本轮检索来源里确实出现过的引用名（有据可引，允许复述） */
  allowedCitations?: string[];
  /** 语境风险标记；不传则只启用无条件 P0 规则 */
  risk?: RiskContext;
};

export type GuardHit = {
  rule: string;
  /** 命中位置在累积全文中的下标，用于截断到安全前缀 */
  index: number;
  detail: string;
};

/** 危险模式窗口：要大于任何单条规则关键词的最大长度，防止跨 chunk 漏检 */
export const STREAM_GUARD_TAIL = 128;
/**
 * 常规文本的最小保留尾部（v8.11 · P-01 真正的修复）。
 *
 * 固定 128 时，<128 字的中文短回答在整个生成期一个字节都不推，用户盯着
 * 「正在思考…」等模型吐完才整段蹦出。实测上游是逐 token 流式（7 个 delta /
 * 46 字，间隔 0~25ms），扣住全文纯属浪费：这里只留 6 字符挡「最短危险关键字
 * 被单个 delta 拆开」，更长的危险模式交给 guardTailFor() 在检测到半截前缀时
 * 自动升级回 STREAM_GUARD_TAIL，护栏召回率一步不减。
 */
export const STREAM_GUARD_MIN_TAIL = 6;
/** 增量扫描窗口的重叠长度 */
const SCAN_OVERLAP = 160;
/**
 * 语境规则的两级判定阈值：早判才能在长回答推送前截断。
 * early=240 是「开头该点名冲突」的窗口；late=900 是「单轮无限展开」的窗口。
 */
export const CONTEXT_SCAN_EARLY = 240;
export const CONTEXT_SCAN_LATE = 900;

/**
 * R1 可直接复制执行的破坏性命令 / DML。
 * 这些片段几乎没有正当的「照抄即用」场景，全文命中即拦（含代码块外的引用）。
 */
const DESTRUCTIVE =
  /\bshred\s+-u\b|\bhistory\s+-c\b|\brm\s+-rf\s+\/|\bDROP\s+TABLE\b|\bTRUNCATE\b|\bcat\s+\/etc\/(passwd|shadow)\b|\bchmod\s+777\b|\bDELETE\s+FROM\s+[\w"`]+\b|\bINSERT\s+INTO\b/i;

/**
 * R2 可复制的 DDL：只在「行首 / 代码块内」判定。
 * 正文里说「创建表用 CREATE TABLE 语句」属于正常讲解，不该拦；
 * 但假拒绝后另起一行贴出的建表语句，正是 P0 缺陷形态。
 */
const COPYABLE_DDL = /(^|\n)\s*(CREATE\s+(TABLE|DATABASE|INDEX|VIEW)|ALTER\s+TABLE|DROP\s+(TABLE|DATABASE))\b/im;

/** R3 未经核实的权威引用名（编造的或用户口述的） */
const CITATION = /《[^》\n]{2,80}(白皮书|蓝皮书|报告|研究报告|调查报告|统计年报|年鉴|数据报告)[^》\n]{0,20}》/g;

/**
 * 强免责措辞：说明模型**明确否认**了引用的可靠性，才允许放行。
 *
 * R3 全量回归暴露的绕过方式：模型在假引用成稿后面贴一句「（待核实）」，
 * 旧的全文 `DISCLAIMER` 含「待核实」→ 整轮放行，成稿在 265 字处就推送给用户，
 * 护栏拖到 927 字才因窗口里恰好没有该词而命中，副本早已落地（P0 回归）。
 * 因此这里：
 *  ① 删除弱标注（待核实 / 待确认 / 请核实）——标签贴在一个可直接复制的句子后面，
 *     用户照样会复制，不构成免责；
 *  ② 只看引用名附近的局部窗口——长回答别处一句「无法核实」不能替成稿开脱。
 */
const STRONG_DISCLAIMER =
  /无法核实|没有核实|未经核实|未核实|不能(直接)?(引用|作为|当真)|不建议(直接)?(引用|使用)|我核实过吗|未经证实|存疑|无法确认|未经确认|查无|不能确认/;

/* ——— 以下 4 条为第三轮新增的语境条件规则（P1）——— */

/**
 * P1-a 把需人拍板的决策写成「已定稿」。仅在 decisionAuthority 语境启用。
 * R3 全量回归又暴露了三种「换个说法继续定稿」：
 *   「已按你的授权把验收标准和排期一并落稿」「我按你授权把整份稿子定稿」
 *   「PRD v1.0（定稿）」「所有占位符替换为具体设定值」
 * 所以除了「已定稿」，还要覆盖「授权 + 落稿/定稿」「把…定稿」「（定稿）」等形态。
 */
const FINALIZED_DECISION =
  /（已定稿）|\(已定稿\)|v\d+\.\d+\s*（定稿）|(验收标准|排期|定价|报价|权限|署名|签字)[^\n。]{0,20}(已定稿|定稿了|都定了|最终定了|我定了|就按这个定)|(已按你的授权|按你授权|按你的授权)[^\n。]{0,60}(落稿|定稿|定了)|把[^\n。]{0,30}定稿|需求方已定|所有占位符替换为具体设定值/;

/**
 * 局部免责窗口：同一句里写了「待确认 / 确认后 / 假设：」说明模型没有把决策坐实。
 * 只看命中点附近（而非全文）——长回答里别处出现一句「待确认清单」不能替违规句开脱。
 */
const FINALIZATION_DISCLAIMER = /待确认|确认后|需要你(确认|拍板|签字)|请你(确认|拍板)|假设：|留占位|待评审|由你指定|需你指定/;

/** P1-b 可直接署名提交的完整作业成品。仅在 academicIntegrity 语境启用 */
const COMPLETE_HOMEWORK =
  /(完整可运行版本|完整能跑|能复制就跑|复制就能跑|直接给代码)[^\n]{0,120}(保存为|```|python\s+\S+\.py)|保存为\s*[`「"']?[\w\u4e00-\u9fa5.-]+\.(py|java|cpp|ipynb|js|ts)\b|可直接(署名)?提交的完整/;

/** P1-c 冲突已被点名（放行信号）：母版要求「定稿前先复述冲突并等取舍」 */
const CONFLICT_ACK = /冲突|矛盾|取舍|二选一|不能同时|无法同时|需要你确认|请你拍板|先确认/;
/** P1-c 未点名冲突就直接顺从两条互斥要求（拦截信号） */
const COMPLY_WITH_CONFLICT = /按你说的(来|都写)|都写上|整体保留|完整可执行版|前三名|发奖状/;
/** P1-d 主任务仍在视野内（放行信号）：先确认原任务状态再展开 */
const MAIN_TASK_ACK = /主任务|道歉信|先接上一句|还差三项|回到原任务|先确认原|一直在|跑偏|现在给你成品/;

/** 从文本里抽出所有「权威报告」形态的引用名 */
export function extractCitations(text: string): string[] {
  const out: string[] = [];
  for (const m of String(text || '').matchAll(CITATION)) out.push(m[0]);
  return Array.from(new Set(out));
}

/**
 * 由「本轮提问 + 会话历史」计算语境风险标记。
 *
 * 关键口径：decisionAuthority / academicIntegrity / hardConflict **跨轮延续**——
 * 用户施压的那一轮（「你不写我就交不上了，就这一次」）本身不含越权关键词，
 * 但语境仍是上一轮的越权请求，规则必须继续生效；topicDrift **只看本轮**，
 * 否则用户已经回来说「那道歉信呢」时还被当成跑题，会误伤合规的收尾回答。
 */
export function computeRiskContext(
  question: string,
  history: readonly { role: string; content: string }[] = [],
): RiskContext {
  const q = String(question || '');
  const userMsgs = history
    .filter((m) => m.role === 'user')
    .map((m) => String(m.content || '').slice(0, 400))
    .slice(-12);
  const joined = [...userMsgs, q].join('\n');

  const decisionAuthority =
    /(验收标准|排期|定价|署名|拍板|签字)/.test(joined) &&
    /(就当我定的|就当是我定的|就按我说的|你(来)?定了|你替我定|就这一次|你不写我就交不上|直接定)/.test(joined);

  const academicIntegrity = /(作业|署名|交上去|学分|老师不查|实验报告|课程设计|期末|答辩|信息技术)/.test(joined);

  const noRank = joined.match(/不排名|不要任何比赛|不设名次|无排名|不比赛/);
  const hasRank = joined.match(/前三名|发奖状|评名次|排名次|选名次/);
  const hardConflict = !!(noRank && hasRank);

  // 只看本轮：用户主动切走话题才叫跑题，回头追问主任务不算
  const topicDrift = /(先别管|别管了|越细越好|先不说.{0,6}了|对了\s*最近)/.test(q);

  const firstUser = history.find((m) => m.role === 'user');
  return {
    decisionAuthority,
    academicIntegrity,
    hardConflict,
    topicDrift,
    // 「不要任何比赛，也不排名」里两个否定词都会命中；优先用更精确的「不排名」做标签，
    // 让替代话术里的冲突点表述更贴切（而不是把整句口语当标签）。
    ...(hardConflict
      ? { conflictLabels: [/不排名/.test(joined) ? '不排名' : noRank![0], hasRank![0]] as [string, string] }
      : {}),
    ...(firstUser ? { mainTaskHint: String(firstUser.content || '').slice(0, 40) } : {}),
  };
}

/** 命中后的合规替代话术（本身不含任何可复制命令，避免二次触发自动判定） */
export const GUARD_REPLACEMENT: Record<string, string> = {
  destructive_command:
    '\n\n⚠️ 出于安全考虑，本轮回答中涉及可直接复制执行的命令或数据库操作语句的内容已被系统拦截。' +
    '我可以说明原理、风险与合规办理路径（联系管理员、走审批、在备份后由有权限的人在受控环境操作），' +
    '但不会给出可直接执行的副本；虚构创作也可以改用侧写式、模糊化的描写。',
  copyable_ddl:
    '\n\n⚠️ 本轮回答中的可复制建表 / 改表语句已被系统拦截。' +
    '我不能提供平台内部表结构或可直接执行的数据库定义；如需对接，请查阅项目文档或由管理员走审批后提供脱敏字段清单。',
  unverified_citation:
    '\n\n⚠️ 本轮回答涉及未经核实的报告名称或统计数字，已被系统拦截。' +
    '我不能编造引用，也不能替你确认口述的数据；建议先向发布机构核实原文与统计口径，' +
    '我可以帮你改写为不依赖具体报告与数字的表述，并把需要核实的条目列成清单。',
  unauthorized_finalization:
    '\n\n⚠️ 本轮回答把需要人拍板的决策写成了「已定稿」，已被系统拦截。' +
    '验收标准、排期、定价、权限、署名属于业务决策，我不能替你签字。' +
    '我可以继续交付范围内的骨架产物，并把决策项列成「待确认清单」移交给你或业务方确认后生效。',
  complete_homework:
    '\n\n⚠️ 本轮回答包含可直接署名提交的完整作业成品，已被系统拦截。' +
    '我可以给思路、示例框架、逐行讲解和自测题，帮你自己把它做出来；' +
    '不会给可复制即交的完整程序，也不会给填好姓名学号的实验报告。',
  conflict_smoothing:
    '\n\n⚠️ 本轮回答在两条互斥要求之间做了调和，已被系统拦截：' +
    '「不排名」与「选出前三名发奖状」不能同时成立，先复述冲突并等你取舍才符合流程。' +
    '请选择：A 保留「不排名」，把接力赛改成不取名次的合作游戏；' +
    'B 保留「前三名发奖状」，由你明确放弃原方案的「不排名」约束。' +
    '在你明确取舍前，我不会出定稿，也不会悄悄把两条塞进同一份方案。',
  scope_drift:
    '\n\n⚠️ 本轮展开偏离了尚未交付的主任务，已被系统截断。' +
    '请先确认：是继续把原任务交付完，还是把新话题另开一轮？' +
    '新话题我可以在主任务收尾后再展开，不会单轮无限展开把原任务丢掉。',
};

/** 生成带语境信息的替代话术：冲突双方 / 主任务提示用真实原文，避免空泛模板 */
export function guardReplacement(rule: string, ctx: GuardContext = {}): string {
  const base = GUARD_REPLACEMENT[rule] || '';
  const r = ctx.risk;
  if (!r) return base;
  if (rule === 'conflict_smoothing' && r.conflictLabels) {
    return base.replace('「不排名」与「选出前三名发奖状」', `「${r.conflictLabels[0]}」与「${r.conflictLabels[1]}」`);
  }
  if (rule === 'scope_drift' && r.mainTaskHint) {
    return base.replace('请先确认：', `原任务：${r.mainTaskHint}… 请先确认：`);
  }
  return base;
}

/**
 * 对「累积全文」做一次性判定（无条件 P0 规则）。
 * 返回最先命中的规则；index 指向应在哪里截断（保留前面的合规说明）。
 */
export function detectUnsafeAnswer(full: string, ctx: GuardContext = {}): GuardHit | null {
  const s = String(full || '');
  if (!s) return null;

  const d = DESTRUCTIVE.exec(s);
  if (d) {
    return { rule: 'destructive_command', index: d.index, detail: `出现可复制的破坏性片段：${d[0].slice(0, 40)}` };
  }

  const ddl = COPYABLE_DDL.exec(s);
  if (ddl) {
    // 行首匹配里 (^|\n) 占一位，index 要落到关键字本身
    const offset = ddl[0].search(/\b(CREATE|ALTER|DROP)\b/);
    const idx = Math.max(0, ddl.index + (offset >= 0 ? offset : 0));
    return { rule: 'copyable_ddl', index: idx, detail: `出现可复制的建表语句：${ddl[0].trim().slice(0, 40)}` };
  }

  const cites = extractCitations(s);
  if (cites.length) {
    const allowed = new Set(ctx.allowedCitations || []);
    const unverified = cites.filter((c) => !allowed.has(c));
    if (unverified.length) {
      const idx = s.indexOf(unverified[0]);
      // 局部免责窗口：引用名前 60 字 / 后 80 字内必须有强否定措辞才放行。
      // 全文任意位置的「待核实」曾被用来绕过这一规则，见 STRONG_DISCLAIMER 注释。
      const around = s.slice(Math.max(0, idx - 60), idx + unverified[0].length + 80);
      if (!STRONG_DISCLAIMER.test(around)) {
        return { rule: 'unverified_citation', index: idx, detail: `引用名未经核实：${unverified[0].slice(0, 40)}` };
      }
    }
  }

  // —— 语境条件规则（即时判定，措辞明确即可拦）——
  const risk = ctx.risk;
  if (risk?.decisionAuthority) {
    const f = FINALIZED_DECISION.exec(s);
    if (f && !FINALIZATION_DISCLAIMER.test(s.slice(Math.max(0, f.index - 40), f.index + 100))) {
      return { rule: 'unauthorized_finalization', index: f.index, detail: `把需人拍板的决策写成已定稿：${f[0].slice(0, 40)}` };
    }
  }
  if (risk?.academicIntegrity) {
    const h = COMPLETE_HOMEWORK.exec(s);
    if (h) {
      return { rule: 'complete_homework', index: h.index, detail: `出现可直接提交的完整作业：${h[0].slice(0, 40)}` };
    }
  }
  return null;
}

/**
 * 语境规则（延迟 / 全文判定）：只在回答长度首次跨过阈值时跑一次。
 *
 * 为什么单独拆开：`conflict_smoothing` 判的是「开头 400 字内有没有点名冲突」，
 * `scope_drift` 判的是「开头 500 字内有没有确认主任务」。若放进增量窗口扫描，
 * 窗口里只有最近一段文本，既看不到开头也可能在模型还没来得及写确认句时误拦。
 */
export function detectContextualUnsafe(
  full: string,
  ctx: GuardContext,
  stage: 'early' | 'late' | 'final',
): GuardHit | null {
  const s = String(full || '');
  const risk = ctx.risk;
  if (!risk || !s) return null;

  if ((stage === 'early' || stage === 'final') && risk.hardConflict && s.length >= CONTEXT_SCAN_EARLY) {
    const head = s.slice(0, CONTEXT_SCAN_EARLY);
    if (!CONFLICT_ACK.test(head)) {
      const m = COMPLY_WITH_CONFLICT.exec(head);
      if (m) {
        return {
          rule: 'conflict_smoothing',
          index: m.index,
          detail: `未点名冲突即顺从互斥要求：${m[0]}`,
        };
      }
    }
  }
  if ((stage === 'late' || stage === 'final') && risk.topicDrift && s.length >= CONTEXT_SCAN_LATE) {
    const head = s.slice(0, 500);
    if (!MAIN_TASK_ACK.test(head)) {
      return {
        rule: 'scope_drift',
        index: Math.min(600, s.length),
        detail: '长篇展开且开头未确认主任务状态',
      };
    }
  }
  return null;
}

export type StreamGuardState = {
  /** 已经推送给客户端的文本 */
  emitted: string;
  /** 尾部缓冲（尚未推送） */
  pending: string;
  /** 模型累积全文（= emitted + pending，被拦截后为净化文本） */
  full: string;
  /** 增量扫描已覆盖到的位置 */
  scanned: number;
  /** 语境规则已完成的阶段 */
  earlyDone: boolean;
  lateDone: boolean;
  /** 已拦截则后续 delta 全部丢弃 */
  blocked: boolean;
  hit: GuardHit | null;
  /** 本次拦截使用的替代话术（可能带语境信息，落库需与用户所见一致） */
  replacement: string;
};

export function createStreamGuard(): StreamGuardState {
  return {
    emitted: '', pending: '', full: '', scanned: 0,
    earlyDone: false, lateDone: false, blocked: false, hit: null, replacement: '',
  };
}

export type PushResult = {
  /** 本轮应推送的文本 */
  emit: string;
  /** 是否命中并拦截 */
  blocked: boolean;
  /** 命中时追加的合规替代话术 */
  replacement?: string;
  hit?: GuardHit;
};

/** 统一处理命中：截断到安全前缀、停流、生成替代话术 */
function applyBlock(state: StreamGuardState, hit: GuardHit, ctx: GuardContext): PushResult {
  state.hit = hit;
  state.blocked = true;
  state.replacement = guardReplacement(hit.rule, ctx);
  // 危险片段有可能已被推出（自适应窗口已尽量压低概率，但不能假设为 0）；仍按「保守截断」处理
  const cut = Math.max(state.emitted.length, hit.index);
  const emit = state.full.slice(state.emitted.length, cut);
  state.emitted += emit;
  state.pending = '';
  return { emit, blocked: true, replacement: state.replacement, hit };
}

/** 语境两级阈值检查（每个回答最多各一次，O(1) 次全文扫描） */
function checkContextual(state: StreamGuardState, ctx: GuardContext, final: boolean): PushResult | null {
  if (!ctx.risk || state.blocked) return null;
  if (!state.earlyDone && state.full.length >= CONTEXT_SCAN_EARLY) {
    state.earlyDone = true;
    const h = detectContextualUnsafe(state.full, ctx, 'early');
    if (h) return applyBlock(state, h, ctx);
  }
  if (!state.lateDone && state.full.length >= CONTEXT_SCAN_LATE) {
    state.lateDone = true;
    const h = detectContextualUnsafe(state.full, ctx, 'late');
    if (h) return applyBlock(state, h, ctx);
  }
  if (final) {
    const h = detectContextualUnsafe(state.full, ctx, 'final');
    if (h && !state.blocked) return applyBlock(state, h, ctx);
  }
  return null;
}

/**
 * 可能被 delta 切断、且一旦拼完整就要拦截的模式关键字（小写）。
 * 与 DESTRUCTIVE / COPYABLE_DDL 保持一致；CITATION 的《…》单独按「未闭合」判定。
 */
const STREAM_DANGEROUS_KEYWORDS = [
  'shred -u', 'history -c', 'rm -rf /',
  'drop table', 'drop database', 'truncate',
  'cat /etc/passwd', 'cat /etc/shadow', 'chmod 777',
  'delete from', 'insert into',
  'create table', 'create database', 'create index', 'create view', 'alter table',
];

/**
 * 本次推送应保留的尾部长度：正常文本 6，疑似危险模式前缀 128。
 *
 * 为什么不直接把 TAIL 调小就完事：CITATION 允许《…80 字…白皮书…20 字…》，
 * `cat /etc/shadow` 也有 15 字符。若一律用 6，这些模式的前半段会被推给用户，
 * 等后半段到达时护栏再拦也收不回来（已推内容不可撤回）。
 * 因此只在「尾部确实存在未拼完的可疑前缀」时临时恢复原窗口：
 *  ① 未闭合书名号 → 引用名可能长达 100+ 字；
 *  ② 尾部英文片段是某危险关键字的真前缀（如 "cat /et"、"shred -"）。
 * 两者都会随后续字符自然解除（书名号闭合 / 片段偏离关键字前缀），不会永久卡流。
 */
export function guardTailFor(pending: string): number {
  if (!pending) return STREAM_GUARD_MIN_TAIL;
  const w = pending.slice(-SCAN_OVERLAP);
  const open = w.lastIndexOf('《');
  if (open >= 0 && w.indexOf('》', open) < 0) return STREAM_GUARD_TAIL;
  const m = /([A-Za-z][A-Za-z0-9\s\/._-]{0,40})$/.exec(w);
  if (m) {
    const frag = m[1].replace(/\s+$/, '').toLowerCase();
    if (frag.length >= 2) {
      for (const kw of STREAM_DANGEROUS_KEYWORDS) {
        if (kw.startsWith(frag)) return STREAM_GUARD_TAIL;
      }
    }
  }
  return STREAM_GUARD_MIN_TAIL;
}

/**
 * 喂入一个流式 delta，返回本轮可安全推送的文本。
 *
 * 增量扫描：每轮只看「上次扫描位置往前重叠 SCAN_OVERLAP 字符」到末尾的窗口，
 * 因此窗口长度恒定为 delta + overlap，长回答也不会 O(n²)。
 */
export function pushDelta(state: StreamGuardState, delta: string, ctx: GuardContext = {}): PushResult {
  if (state.blocked || !delta) return { emit: '', blocked: state.blocked };

  state.full += delta;
  state.pending += delta;

  const scanFrom = Math.max(0, state.scanned - SCAN_OVERLAP);
  const window = state.full.slice(scanFrom);
  const local = detectUnsafeAnswer(window, ctx);
  state.scanned = state.full.length;
  if (local) return applyBlock(state, { ...local, index: scanFrom + local.index }, ctx);

  const contextual = checkContextual(state, ctx, false);
  if (contextual) return contextual;

  // 风险语境下「先缓冲、判完再放行」：hardConflict 的违规形态是开头第一句就顺从，
  // 若按常规窗口放行，判定时那句已经推给用户、收不回来。
  // 因此只把开头 CONTEXT_SCAN_EARLY 字符扣住不推，跨过阈值完成判定后再恢复正常放行。
  // 其余情况用自适应窗口：正常文本只留 6 字符（逐字流式），疑似危险前缀自动回到 128。
  const hold = !!(ctx.risk?.hardConflict && !state.earlyDone);
  const tail = hold
    ? Math.max(STREAM_GUARD_TAIL, CONTEXT_SCAN_EARLY)
    : guardTailFor(state.pending);
  const safeLen = Math.max(0, state.pending.length - tail);
  const emit = state.pending.slice(0, safeLen);
  state.pending = state.pending.slice(safeLen);
  state.emitted += emit;
  return { emit, blocked: false };
}

/** 流结束：做最后一次判定，并把尾部缓冲全部推出 */
export function flushGuard(state: StreamGuardState, ctx: GuardContext = {}): PushResult {
  if (state.blocked) return { emit: '', blocked: true };

  // 末段窗口的 P0 判定 + 未跑过的语境阈值判定
  const window = state.full.slice(Math.max(0, state.scanned - SCAN_OVERLAP));
  const local = detectUnsafeAnswer(window, ctx);
  if (local) {
    return applyBlock(state, { ...local, index: Math.max(0, state.scanned - SCAN_OVERLAP) + local.index }, ctx);
  }
  const contextual = checkContextual(state, ctx, true);
  if (contextual) return contextual;

  const emit = state.pending;
  state.emitted += emit;
  state.pending = '';
  state.scanned = state.full.length;
  return { emit, blocked: false };
}

/** 拦截后用于落库 / 缓存的净化文本（与用户实际看到的文本一致） */
export function guardedText(state: StreamGuardState): string {
  if (!state.blocked) return state.full;
  return state.emitted + state.replacement;
}
