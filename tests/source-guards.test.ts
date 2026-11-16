import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * 源码级防回归。
 *
 * 这里不放业务断言，只放「写法错了但不报错」的检查——这类问题最难查，
 * 因为类型系统、lint、单元测试全都放行，只有真跑起来才知道没生效。
 */

function walk(dir: string, out: string[] = []): string[] {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      walk(p, out);
    } else if (/\.(ts|tsx)$/.test(entry.name)) {
      out.push(p);
    }
  }
  return out;
}

/** 跳过纯注释行，避免「注释里提到错误写法」被判成错误本身 */
function isCommentLine(line: string): boolean {
  const t = line.trim();
  return t.startsWith('//') || t.startsWith('*') || t.startsWith('/*');
}

describe('源码级防回归', () => {
  it('不得写 await sql`...`：drizzle 的 SQL 片段不会因此执行', () => {
    // 踩过的坑（2026-10-30）：`await sql\`SELECT ...\`` 拿回的是 SQL 片段对象本身，
    // 查询压根没跑。于是 `stat[0]` 恒为 undefined，`Number(st.total) > 0` 恒为 false，
    // pgvector 快路径成了死代码——而 `as unknown as` 把这个错误从类型系统里挡掉了。
    // 它又只在 isVectorSupported() 为真时才执行，本机从未跑到，所以两年都不会有人发现。
    // 正确写法：`await db.execute(sql\`...\`)`。
    const bad: string[] = [];
    for (const f of [...walk('lib'), ...walk('app')]) {
      const lines = fs.readFileSync(f, 'utf8').split('\n');
      lines.forEach((line, i) => {
        if (isCommentLine(line)) return;
        if (/await\s+sql`/.test(line)) bad.push(`${f}:${i + 1}`);
      });
    }
    expect(bad).toEqual([]);
  });

  it('本检查自身是有效的（防止正则写错导致永远通过）', () => {
    // 若这条断言失败，说明上面的检测逻辑本身失效了——那它就成了装饰
    expect(/await\s+sql`/.test('const r = await sql`select 1`')).toBe(true);
    expect(/await\s+sql`/.test('const r = await db.execute(sql`select 1`)')).toBe(false);
    expect(isCommentLine('      // 别写 await sql`...`')).toBe(true);
  });

  it('对外通道必须走 finalizeChannel，禁止直接调用 finalizeAnswer', () => {
    // 踩过的坑（V8.3 → V8.4）：`finalizeAnswer(text)` 的第三个参数是 GuardContext，
    // 不传就等于「允许的引用清单为空」+「语境规则全关」。表面上是「护栏少管一点」，
    // 实际上是**主动误伤**：任何《某报告》都会被判成编造引用，产出从引用处被截断，
    // 于是「技能检索到文档、模型照着引用」这条最正当的路径反而被自己人掐掉。
    // 修法不是逐个调用点补参数（那只是把复发推给下一个入口），而是把带上下文的
    // `finalizeChannel` 定成唯一出口——本检查负责让它一直是唯一出口。
    const exempt = new Set(['lib/agent/answer-guard.ts']);
    const bad: string[] = [];
    for (const f of [...walk('lib'), ...walk('app')]) {
      const rel = f.split(path.sep).join('/');
      if (exempt.has(rel)) continue;
      const lines = fs.readFileSync(f, 'utf8').split('\n');
      lines.forEach((line, i) => {
        if (isCommentLine(line)) return;
        if (/\bfinalizeAnswer\s*\(/.test(line)) bad.push(`${rel}:${i + 1}`);
      });
    }
    expect(bad).toEqual([]);
    // 自检：正则要能抓到直接调用、且不能误抓 import
    expect(/\bfinalizeAnswer\s*\(/.test("const r = finalizeAnswer(text);")).toBe(true);
    expect(/\bfinalizeAnswer\s*\(/.test("import { finalizeChannel } from '@/lib/agent/answer-guard';")).toBe(false);
  });

  it('技能执行必须走治理门面：裸 runSkill 的直接调用需在白名单内', () => {
    // 踩过的坑（V8.22）：治理原来是「调用方约定」——`skills/run` 与 `scheduler`
    // 各自把「护栏 + V 层 + judge」装了一遍。两条通道都记得装，所以测试全绿，
    // 但这靠的是记忆。第三条通道（webhook 触发、workflow 运行）漏装时**不会报错**：
    // 只是静默地没有审计、没有护栏，而评测只跑已有通道，抓不到这种退化。
    //
    // 现在默认入口是 `runSkillGoverned`（运行即治理）；裸 `runSkill` 只留给
    // 「需要自己组织通道出口」的调用方，且必须在这里登记。新增一行白名单意味着
    // 「我知道这条通道要自己接治理」——而不是默默忘掉。
    const exempt = new Set([
      'lib/agent/index.ts', // 定义处
      'lib/scheduler.ts', // 产出可能来自直接 prompt，必须统一在出口治理一次
    ]);
    const bad: string[] = [];
    for (const f of [...walk('lib'), ...walk('app')]) {
      const rel = f.split(path.sep).join('/');
      if (exempt.has(rel)) continue;
      const lines = fs.readFileSync(f, 'utf8').split('\n');
      lines.forEach((line, i) => {
        if (isCommentLine(line)) return;
        if (/\brunSkill\s*\(/.test(line)) bad.push(`${rel}:${i + 1}`);
      });
    }
    expect(bad).toEqual([]);
    // 自检：不能误抓门面本身，也不能漏掉裸调用
    expect(/\brunSkill\s*\(/.test('const r = await runSkill(steps, input);')).toBe(true);
    expect(/\brunSkill\s*\(/.test('const r = await runSkillGoverned(steps, input, opts);')).toBe(false);
  });

  it('治理三段只能出现在统一出口里（禁止在通道里各装一遍）', () => {
    // 这三个函数必须成组出现，且顺序固定（护栏 → V 层 → judge）。
    // 散落在各通道里时，「顺序写反」不会报错，只会让日志把护栏的功劳记成模型的过错。
    // 允许名单只有两处：定义处 + 唯一出口。
    const allow = new Map<string, string[]>([
      ['lib/agent/channel-governance.ts', ['finalizeChannel(', 'auditChannelAnswer(', 'judgeChannelAnswer(']],
      ['lib/agent/answer-guard.ts', ['finalizeChannel(']],
      ['lib/agent/channel-verify.ts', ['auditChannelAnswer(']],
      ['lib/agent/runtime-judge.ts', ['judgeChannelAnswer(']],
    ]);
    const bad: string[] = [];
    for (const f of [...walk('lib'), ...walk('app')]) {
      const rel = f.split(path.sep).join('/');
      const lines = fs.readFileSync(f, 'utf8').split('\n');
      lines.forEach((line, i) => {
        if (isCommentLine(line)) return;
        for (const call of ['finalizeChannel(', 'auditChannelAnswer(', 'judgeChannelAnswer(']) {
          if (!line.includes(call)) continue;
          // import 语句与类型引用不算调用
          if (/^\s*import\b/.test(line)) continue;
          if (!(allow.get(rel) || []).includes(call)) bad.push(`${rel}:${i + 1} ${call}`);
        }
      });
    }
    expect(bad).toEqual([]);
  });

  it('运行时 V 层必须走 verifyChannelAnswer，禁止直接调用 verifyAnswer', () => {
    // 踩过的坑（V8.6）：`verifyAnswer` 的入参是 `{ answer, sources, trace }`。
    // 只传 `{ answer }` 不会报错，但两条依赖上下文的规则会立刻失真：
    //  - `ungrounded_capability` 查 `type === 'tool_call' && name`，技能轨迹是
    //    `type: 'tool' / tool: 'xxx'` → 每次都误报；
    //  - `fabricated_source` 查 `sources.length === 0`，技能通道没有 hits 可传 →
    //    照知识库引用也会被判成编造来源。
    // 这和 finalizeAnswer 是同一个教训：校验器「接受什么形状」必须由每个通道翻译，
    // 而翻译只留一份（lib/agent/channel-verify.ts）。本检查让它一直只有一份。
    const exempt = new Set(['lib/agent/runtime-verify.ts', 'lib/agent/channel-verify.ts']);
    const bad: string[] = [];
    for (const f of [...walk('lib'), ...walk('app')]) {
      const rel = f.split(path.sep).join('/');
      if (exempt.has(rel)) continue;
      const lines = fs.readFileSync(f, 'utf8').split('\n');
      lines.forEach((line, i) => {
        if (isCommentLine(line)) return;
        if (/\bverifyAnswer\s*\(/.test(line)) bad.push(`${rel}:${i + 1}`);
      });
    }
    expect(bad).toEqual([]);
    expect(/\bverifyAnswer\s*\(/.test('const r = verifyAnswer({ answer });')).toBe(true);
    expect(/\bverifyAnswer\s*\(/.test("import { verifyChannelAnswer } from '@/lib/agent/channel-verify';")).toBe(false);
  });
});

describe('纯图标按钮必须有可访问名（P-02 防回归）', () => {
  /**
   * 取 `<Button` 的标签头。不能简单用 /<Button[^>]*>/：
   * `icon={<SendOutlined />}` 里的 `/>` 会让正则提前结束。这里按 `{}` 深度扫，
   * 只有在 depth=0 遇到的 `>` 才是标签头真正的结束。
   */
  function buttonTagHead(src: string, start: number): { end: number; selfClose: boolean } | null {
    let depth = 0;
    for (let i = start + '<Button'.length; i < src.length; i++) {
      const c = src[i];
      if (c === '{') depth++;
      else if (c === '}') depth--;
      else if (c === '>' && depth === 0) {
        let j = i - 1;
        while (j >= start && /\s/.test(src[j])) j--;
        return { end: i, selfClose: src[j] === '/' };
      }
    }
    return null;
  }

  /** 返回「纯图标且没有可访问名」的 Button 位置（文件内行号） */
  function unnamedIconButtons(src: string): number[] {
    const bad: number[] = [];
    for (const m of src.matchAll(/<Button\b/g)) {
      const h = buttonTagHead(src, m.index);
      if (!h) continue;
      const head = src.slice(m.index, h.end + 1);
      if (!/icon=\{/.test(head)) continue;
      // 自闭合图标按钮没有文字子节点；带 children 的要把可见文字算作可访问名
      let children = '';
      if (!h.selfClose) {
        const close = src.indexOf('</Button>', h.end);
        children = close < 0 ? '' : src.slice(h.end + 1, close);
      }
      const visible = children.replace(/<[^>]*>/g, '').replace(/[{}]/g, '').trim();
      // Tooltip 的 title 不算：那是浮层文案，读屏与键盘用户拿不到按钮自身的名字
      if (/\baria-label\s*=/.test(head) || /\btitle\s*=/.test(head) || visible) continue;
      bad.push(src.slice(0, m.index).split('\n').length);
    }
    return bad;
  }

  it('app/ 与 components/ 下不得新增无名称的纯图标按钮', () => {
    // 踩过的坑（v8.10.0 P-02）：D-04 当年只修了 /files，之后各页陆续新增的
    // `<Button icon={<Xxx />} />` 全都没有名字——类型检查、lint、单测一律放行，
    // 只有在浏览器里检查 accessible name（或读屏 / Tab 聚焦）才暴露。
    // 而且不少按钮被 <Tooltip title="…"> 包着，看起来「有说明」，实际按钮仍是匿名的。
    // 边界：只管产品自写的 <Button>。antd 内部渲染的按钮（Input.Search 的搜索按钮、
    // Pagination 翻页、Input clear-icon、Tabs nav-more）在源码里没有对应标签，
    // 归浏览器运行时巡检覆盖，不在这里误报。
    const bad: string[] = [];
    for (const f of [...walk('app'), ...walk('components')]) {
      const rel = f.split(path.sep).join('/');
      for (const line of unnamedIconButtons(fs.readFileSync(f, 'utf8'))) {
        bad.push(`${rel}:${line}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it('本守卫自身有效（防止扫描逻辑写错导致永远通过）', () => {
    // 缺名字：必须抓到
    expect(unnamedIconButtons('<Button size="small" icon={<MoreOutlined />} />')).toEqual([1]);
    // 嵌套 icon={<Xxx />} 不能让扫描提前截断：带 onClick 也要抓到
    expect(unnamedIconButtons('<Button icon={<DeleteOutlined />} onClick={() => del(id)} />')).toEqual([1]);
    // 有 aria-label / title / 可见文字：都不能误报
    expect(unnamedIconButtons('<Button icon={<MoreOutlined />} aria-label="更多操作" />')).toEqual([]);
    expect(unnamedIconButtons('<Button icon={<MoreOutlined />} title="更多操作" />')).toEqual([]);
    expect(unnamedIconButtons('<Button icon={<PlusOutlined />}>新建</Button>')).toEqual([]);
  });
});
