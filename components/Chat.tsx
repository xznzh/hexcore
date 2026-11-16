'use client';

import { useEffect, useRef, useState, useCallback, useLayoutEffect } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import {
  Select,
  Input,
  Button,
  Space,
  Tag,
  App,
  Tooltip,
  Empty,
  Dropdown,
  Modal,
  Upload,
  Form,
  Skeleton,
  InputNumber,
} from 'antd';
import {
  PlusOutlined,
  DeleteOutlined,
  EditOutlined,
  PushpinOutlined,
  SearchOutlined,
  FileTextOutlined,
  FolderOpenOutlined,
  DownloadOutlined,
  ProjectOutlined,
  MoreOutlined,
  ThunderboltOutlined,
  CloseOutlined,
  ShareAltOutlined,
  DownOutlined,
  TeamOutlined,
  LockOutlined,
  CloudDownloadOutlined,
} from '@ant-design/icons';
import { MessageItem, type MsgActions } from './chat/MessageItem';
import Composer from './chat/Composer';
import { useGuest } from './SessionContext';
import { useMe } from './SessionContext';
import type { ModelOption, Conv, Project, Skill, Attached, CapMention, TraceItem, Msg } from './chat/types';
import { safeValidate } from '@/lib/form';

const SUGGESTIONS = [
  '帮我总结这份知识库的核心要点',
  '生成本周工作周报',
  '用通俗语言解释 RAG 的工作原理',
  '把我上传的文档整理成结构化的要点',
];

const PAGE_SIZE = 60; // 消息首屏分页大小（同时是老消息懒渲染的富渲染窗口）

export default function Chat() {
  const { message, modal } = App.useApp();
  const searchParams = useSearchParams();
  const router = useRouter();
  const [models, setModels] = useState<ModelOption[]>([]);
  const [modelId, setModelId] = useState('');

  const [convs, setConvs] = useState<Conv[]>([]);
  const [activeId, setActiveId] = useState<string>('');
  const [activeProject, setActiveProject] = useState<string | null>(null);
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [search, setSearch] = useState('');
  const [readOnly, setReadOnly] = useState(false);
  const [convOwner, setConvOwner] = useState('');
  const [projModal, setProjModal] = useState<{ open: boolean; conv: Conv | null }>({ open: false, conv: null });
  const [projPick, setProjPick] = useState<string>('none');

  const [projects, setProjects] = useState<Project[]>([]);
  const [skills, setSkills] = useState<Skill[]>([]);
  const [myFiles, setMyFiles] = useState<Attached[]>([]);
  const [proposals, setProposals] = useState<any[]>([]);
  const isGuest = useGuest();
  const meRole = useMe()?.role || 'member';
  const lockComposer = readOnly || isGuest;
  const [attached, setAttached] = useState<Attached[]>([]);
  const [skillPick, setSkillPick] = useState<Skill | null>(null);
  const [capChips, setCapChips] = useState<CapMention[]>([]);
  const addCap = useCallback((c: CapMention) => setCapChips((prev) => (prev.some((x) => x.id === c.id) ? prev : [...prev, c])), []);
  const detachCap = useCallback((id: string) => setCapChips((prev) => prev.filter((x) => x.id !== id)), []);
  const [saveSkill, setSaveSkill] = useState<{ open: boolean; content: string }>({ open: false, content: '' });
  const [editTarget, setEditTarget] = useState<Msg | null>(null); // 编辑重发：被编辑的 user 消息
  const [saveSkillForm] = Form.useForm();
  const [shareForm] = Form.useForm();
  const [shareOpen, setShareOpen] = useState(false);
  const [shareUrl, setShareUrl] = useState('');
  const [wsFiles, setWsFiles] = useState<{ id: string; filename: string; size: number }[]>([]);
  const [wsOpen, setWsOpen] = useState(true);
  const shareVisibility = Form.useWatch('visibility', shareForm);
  const [listening, setListening] = useState(false);

  const bottomRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const prevConvRef = useRef<string>('');
  const msgRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const [atBottom, setAtBottom] = useState(true);
  const [activeAnchor, setActiveAnchor] = useState('');

  // —— 消息加载/渲染性能包（迭代计划 D5：对标豆包类「秒开」体验）——
  // 首屏只拉最近 PAGE_SIZE 条；更早历史在滚动到顶部时按需补齐（游标分页）。
  const [msgsLoading, setMsgsLoading] = useState(false);
  const [hasMoreOlder, setHasMoreOlder] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const activeIdRef = useRef(''); // 同步镜像 activeId，供异步回调防串会话竞态
  const loadAbortRef = useRef<AbortController | null>(null);
  const anchorRef = useRef<number | null>(null); // 向上补历史前记录「距底部距离」，合并后恢复滚动锚点
  const bootConvRef = useRef(''); // 本次挂载通过 URL/上次会话恢复的 id，防止列表返回后重复选择
  const skipRestoreRef = useRef(false); // 带 new=1 进来时不恢复「上次会话」（工作台的提问属于新任务）

  // 稳定的动作句柄：ref 内每次渲染刷新为最新实现，转发函数引用永不变 → MessageItem 的 memo 不被打穿
  const actionsRef = useRef<MsgActions | null>(null);
  actionsRef.current = {
    copy: (t) => copyText(t),
    retry: (m) => retry(m),
    feedback: (m, r) => sendFeedback(m, r),
    toDoc: (kind, content, format) => toDocPpt(kind, content, format),
    saveSkill: (content) => setSaveSkill({ open: true, content }),
    todo: (m) => addTodo(m),
    speak: (text) => speak(text),
    edit: (m) => startEdit(m),
  };
  const [msgActions] = useState<MsgActions>(() => ({
    copy: (t) => actionsRef.current!.copy(t),
    retry: (m) => actionsRef.current!.retry(m),
    feedback: (m, r) => actionsRef.current!.feedback(m, r),
    toDoc: (k, c, f) => actionsRef.current!.toDoc(k, c, f),
    saveSkill: (c) => actionsRef.current!.saveSkill(c),
    todo: (m) => actionsRef.current!.todo(m),
    speak: (t) => actionsRef.current!.speak(t),
    edit: (m) => actionsRef.current!.edit(m),
  }));

  const loadModels = useCallback(() => {
    fetch('/api/models')
      .then((r) => r.json())
      .then((d: ModelOption[]) => {
        if (!Array.isArray(d)) return;
        setModels(d);
        // 优先沿用上次选的模型（本地记住），失效/不存在则回落默认模型
        let saved = '';
        try {
          saved = localStorage.getItem('chat.modelId') || '';
        } catch {
          /* 隐私模式下 localStorage 可能被禁用 */
        }
        const pick = d.find((m) => m.id === saved) || d.find((m) => m.isDefault) || d[0];
        if (pick) setModelId(pick.id);
      })
      .catch(() => {});
  }, []);

  const loadProjects = useCallback(() => {
    fetch('/api/projects')
      .then((r) => r.json())
      .then((d: Project[]) => setProjects(d))
      .catch(() => {});
  }, []);

  const loadSkills = useCallback(() => {
    fetch('/api/skills')
      .then((r) => r.json())
      .then((d: Skill[]) => setSkills(d))
      .catch(() => {});
  }, []);

  const loadFiles = useCallback(() => {
    fetch('/api/files')
      .then((r) => r.json())
      .then((d: any[]) => setMyFiles(d.map((f) => ({ id: f.id, filename: f.filename }))))
      .catch(() => {});
  }, []);

  const loadWorkspace = useCallback(() => {
    if (!activeId) {
      setWsFiles([]);
      return;
    }
    fetch(`/api/files?conversationId=${activeId}`)
      .then((r) => r.json())
      .then((d: any[]) => setWsFiles(d.map((f) => ({ id: f.id, filename: f.filename, size: f.size }))))
      .catch(() => {});
  }, [activeId]);

  const loadConvs = useCallback(() => {
    fetch('/api/conversations')
      .then((r) => r.json())
      .then((d: Conv[]) => {
        setConvs(d);
        if (!activeIdRef.current) {
          // 从工作台带 new=1 进来的：要的是空白新对话，不能回头接管列表第一条。
          // 这里不能用「消费一次就失效」的写法——StrictMode 下本次挂载会调用两次，第二次就会把旧会话选回来。
          // 判据换成「当前有没有选中的会话」：只要还没选，就一直是新对话意图。
          if (!skipRestoreRef.current && d.length) selectConv(d[0].id);
        } else {
          skipRestoreRef.current = false; // 已经有明确会话，跳过逻辑功成身退
          if (
            bootConvRef.current === 'restore' &&
            d.length &&
            !d.some((c) => c.id === activeIdRef.current)
          ) {
            // 通过 localStorage 恢复的会话已不在可见列表（被删/失权限）：回落到第一条
            selectConv(d[0].id);
          }
        }
      })
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const loadMessages = useCallback(async (id: string, mode: 'replace' | 'older' = 'replace') => {
    if (loadAbortRef.current) loadAbortRef.current.abort();
    const ac = new AbortController();
    loadAbortRef.current = ac;
    if (mode === 'older' && msgs[0]?.createdAt) setLoadingOlder(true);
    else if (mode === 'older') return; // 游标不可用（无首条时间戳）：不发起补页，防止循环
    else setMsgsLoading(true);
    // 游标取 msgs[0].createdAt - 1：即便边界存在同毫秒消息也不会被跳过（多回几条由前端按 id 去重）
    const url =
      mode === 'older'
        ? `/api/conversations/${id}?limit=${PAGE_SIZE}&before=${(msgs[0]?.createdAt || 0) - 1}`
        : `/api/conversations/${id}?limit=${PAGE_SIZE}`;
    try {
      const res = await fetch(url, { signal: ac.signal });
      if (res.status === 404) {
        // 会话已不存在（被删/失权限）：静默清空，列表返回后由回落逻辑接管
        if (activeIdRef.current === id) {
          setMsgs([]);
          setHasMoreOlder(false);
        }
        return;
      }
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j?.error || `消息加载失败（${res.status}）`);
      }
      const j = await res.json();
      if (activeIdRef.current !== id) return; // 响应晚到（用户已切走）：丢弃，防止串会话
      const list = (Array.isArray(j) ? j : j.messages || []) as any[];
      const mapped: Msg[] = list.map((m) => ({
        id: m.id,
        role: m.role,
        content: m.content,
        sources: m.sources || [],
        trace: m.trace || [],
        meta: m.meta || null,
        feedback: m.feedback || null,
        createdAt: m.createdAt ?? Date.now(),
      }));
      if (mode === 'older') {
        // 向上补历史：按 id 去重合并；记录滚动锚点（补页前的距底部距离），useLayoutEffect 恢复
        const el = scrollRef.current;
        anchorRef.current = el ? el.scrollHeight - el.scrollTop : null;
        setMsgs((prev) => {
          const seen = new Set(prev.map((x) => x.id));
          const fresh = mapped.filter((x) => !seen.has(x.id));
          return [...fresh, ...prev];
        });
      } else {
        setMsgs(mapped);
        setReadOnly(!Array.isArray(j) && j.isOwner === false);
        setConvOwner((!Array.isArray(j) && j.ownerName) || '');
      }
      setHasMoreOlder(!Array.isArray(j) ? !!j.hasMore : false);
    } catch (e: any) {
      if (e?.name === 'AbortError') return;
      if (activeIdRef.current === id) setMsgs([]);
      message.error(e?.message || '消息加载失败');
    } finally {
      if (loadAbortRef.current === ac) loadAbortRef.current = null;
      setLoadingOlder(false);
      setMsgsLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [msgs]);

  function selectConv(id: string) {
    if (loadAbortRef.current) loadAbortRef.current.abort();
    const c = convs.find((x) => x.id === id);
    setActiveId(id);
    activeIdRef.current = id;
    try {
      localStorage.setItem('chat.lastConv', id);
    } catch {
      /* 隐私模式等场景忽略 */
    }
    setActiveProject(c?.projectId || null);
    setMsgs([]); // 立即清空：切换期间不再显示上一个会话的内容（消除旧内容串场）
    setMsgsLoading(true); // 骨架占位
    if (c) {
      setReadOnly(c.isOwner === false);
      setConvOwner(c.ownerName || '');
    }
    loadMessages(id);
  }

  async function newConv(projectId?: string | null) {
    const r = await fetch('/api/conversations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId: projectId || null }),
    }).then((x) => x.json());
    if (r.id) {
      const fresh: Conv = {
        id: r.id,
        title: '新对话',
        pinned: false,
        createdAt: Date.now(),
        projectId: r.projectId || null,
      };
      setConvs((c) => [fresh, ...c]);
      setActiveId(r.id);
      activeIdRef.current = r.id;
      try {
        localStorage.setItem('chat.lastConv', r.id);
      } catch {
        /* 忽略 */
      }
      setActiveProject(r.projectId || null);
      setMsgs([]);
      // 新会话发起者是自己，必须清掉上一个会话可能留下的只读态
      setReadOnly(false);
      setConvOwner('');
      return r.id;
    }
  }

  useEffect(() => {
    const p = searchParams.get('project');
    const c = searchParams.get('conv');
    const isNew = searchParams.get('new') === '1';
    // 从工作台「快速发起」带过来的：属于新任务，不继承上次会话
    if (isNew) skipRestoreRef.current = true;
    if (c) selectConv(c);
    else if (p) newConv(p);
    // 工作台「快速发起」带来的草稿：预填到输入框，等待用户确认发送
    const draft = searchParams.get('draft');
    if (draft) {
      setInput(draft);
      // 保留 new=1：草稿消费掉之后 URL 还要能表达「这是一次新任务」，
      // 否则组件一旦重新挂载（StrictMode/刷新）就会按老参数把旧会话恢复回来。
      router.replace(isNew ? '/chat?new=1' : '/chat', { scroll: false });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    /**
     * 首屏只让「会话列表 + 当前会话消息」两个请求先跑。
     *
     * models / projects / skills / files 只喂「/」能力面板与模型选择器，
     * 晚 200~800ms 对用户无感；但它们和 messages 抢同一批并发连接，
     * 在 HTTP/1.1（dev server、部分反代）下会把真正决定首屏的那个请求挤到后面。
     * 这里用 requestIdleCallback（不支持时退回 setTimeout）把它们挪到浏览器的空闲时段。
     */
    const defer = (fn: () => void) => {
      const ric = (window as unknown as { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => void })
        .requestIdleCallback;
      if (typeof ric === 'function') ric(() => fn(), { timeout: 800 });
      else setTimeout(fn, 200);
    };
    defer(() => {
      loadModels();
      loadProjects();
      loadSkills();
      loadFiles();
    });
    // 恢复上次会话：消息请求立即发出，不等上面那批（首帧秒开的关键）
    // 例外：带 new=1 从工作台进来的，用户期待的是一个干净的新对话
    if (!activeIdRef.current && !skipRestoreRef.current) {
      const last = (() => {
        try {
          return localStorage.getItem('chat.lastConv') || '';
        } catch {
          return '';
        }
      })();
      if (last) {
        bootConvRef.current = 'restore';
        selectConv(last);
      }
    }
    loadConvs();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    // 工作区文件列表同样不参与首屏：它只喂右侧面板，与 messages 抢连接不划算
    const t = setTimeout(() => loadWorkspace(), 150);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId]);

  // —— 技能安装提议（对话内发起 → 管理员确认后生效）——
  useEffect(() => {
    loadProposals();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function loadProposals() {
    try {
      const r = await fetch('/api/skills/proposals');
      if (!r.ok) return;
      const list = await r.json();
      setProposals(Array.isArray(list) ? list.filter((p: any) => p.status === 'pending') : []);
    } catch {
      /* 忽略 */
    }
  }

  async function resolveProposal(id: string, action: 'confirm' | 'dismiss') {
    try {
      const r = await fetch(`/api/skills/proposals/${id}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        message.error(j.error || '操作失败');
        return;
      }
      if (action === 'confirm') message.success(`已安装技能：${j.name}（可在技能页使用）`);
      else message.info('已忽略该安装提议');
      loadProposals();
      loadSkills();
    } catch (e: any) {
      message.error(e?.message || '操作失败');
    }
  }

  // 自动滚动策略：切换会话 → 直接跳到底部（无动画）；否则仅在用户已贴底时跟随
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (activeId !== prevConvRef.current) {
      prevConvRef.current = activeId;
      requestAnimationFrame(() => {
        el.scrollTop = el.scrollHeight;
      });
      setAtBottom(true);
      return;
    }
    if (atBottom) el.scrollTop = el.scrollHeight;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [msgs, activeId]);

  // 向上补历史：新页消息 prepend 后恢复滚动位置（锚点 = 补页前「距底部」的距离，防止列表跳动）
  useLayoutEffect(() => {
    if (anchorRef.current === null) return;
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight - anchorRef.current;
    anchorRef.current = null;
  });

  async function doSend(text: string) {
    // 关联的能力用结构化字段随请求发送（capIds），正文里不再有 @cap 标记
    const capIdsToSend = capChips.map((c) => c.id);
    const raw = text.trim();
    // 只关联了能力却没写正文时，补一句默认指令，避免「点了发送没反应」
    const t = raw || (capIdsToSend.length ? `请使用「${capChips[0].name}」处理` : '');
    if (readOnly) {
      message.warning('这是项目共享的只读会话，无法发送消息');
      return;
    }
    if ((!t && attached.length === 0) || busy) return;
    if (!skillPick && !modelId) return;
    let cid = activeId;
    let pid = activeProject;
    if (!cid) cid = (await newConv(pid)) as string;
    if (!cid) return;
    // 新任务已经落成具体会话，URL 上的 new=1 就该退场：
    // 否则用户在这一条对话里刷新，会被当成又一次「新任务」而丢掉上下文。
    if (searchParams.get('new') === '1') window.history.replaceState(null, '', '/chat');

    // 编辑重发：先让服务端截断被编辑消息及其后的全部消息，本地同步移除，再走正常发送（D5-O8）
    if (editTarget) {
      const r = await fetch(`/api/conversations/${cid}?from=${encodeURIComponent(editTarget.id)}`, {
        method: 'DELETE',
      });
      if (!r.ok) {
        message.error((await r.json().catch(() => ({}))).error || '编辑失败：截断旧消息未成功');
        return;
      }
      const idx = msgs.findIndex((x) => x.id === editTarget.id);
      if (idx >= 0) setMsgs(msgs.slice(0, idx));
      setEditTarget(null);
    }

    const shownText = t || '（附件）';
    const next: Msg[] = [
      ...msgs,
      // meta 先本地填上，气泡里立刻能看到「能力」标签；刷新后由服务端 meta 回填同一内容
      {
        id: 'tmp-u',
        role: 'user',
        content: shownText,
        meta: capChips.length ? { caps: capChips } : null,
        createdAt: Date.now(),
      },
      { id: 'tmp-a', role: 'assistant', content: '', createdAt: Date.now() },
    ];
    setMsgs(next);
    setInput('');
    setBusy(true);

    // 只写「仍属于当前会话」的临时消息：切换会话后迟到的流分片不再污染新会话的视图
    const patchLast = (fn: (last: Msg) => Msg) => {
      if (activeIdRef.current !== cid) return;
      setMsgs((m) => {
        if (!m.length) return m;
        const copy = [...m];
        copy[copy.length - 1] = fn(copy[copy.length - 1]);
        return copy;
      });
    };

    // 技能模式：运行技能编排（非流式）
    if (skillPick) {
      try {
        const r = await fetch('/api/skills/run', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: skillPick.id, input: t || '请处理我提供的附件' }),
        });
        const j = await r.json().catch(() => ({}));
        const out = r.ok ? j.result : `⚠️ ${j.error || '技能运行失败'}`;
        patchLast(() => ({ id: 'tmp-a', role: 'assistant', content: out }));
      } catch (e: any) {
        patchLast(() => ({ id: 'tmp-a', role: 'assistant', content: `⚠️ ${e?.message || '网络错误'}` }));
      } finally {
        setBusy(false);
        setSkillPick(null);
        setCapChips([]);
        setAttached([]);
      }
      return;
    }

    const fileIds = attached.map((a) => a.id);
    setAttached([]);
    setCapChips([]);

    const ac = new AbortController();
    abortRef.current = ac;
    // 看门狗：按「多久没收到任何事件」判定，而不是总耗时。
    // 工具调用和长思考可以合法地慢（导出一份 Excel 就 5 秒，思考型模型首包也可能 20 秒），
    // 用「总耗时」会把这些正常情况杀掉；用空闲时长才只抓真正的挂死。
    let flushTimer: ReturnType<typeof setTimeout> | null = null;
    let idleTimer: ReturnType<typeof setTimeout> | null = null;
    const seen = { text: false };
    const armWatchdog = (ms: number) => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        ac.abort();
        // 已经吐过正文的，只追加提示，绝不覆盖已生成内容（旧实现会把整段回答替换成报错）
        patchLast((prev) => {
          const body = prev.content || '';
          const tail = seen.text
            ? '\n\n（输出中断：长时间没有新内容，已中止。上面的内容已保留。）'
            : '⚠️ 30 秒内没有收到服务端的任何响应，已中止。可能是网络中断或模型端点暂时无响应——可以直接重发一次；若每次都这样，再到「管理后台 → 模型配置」核对 Base URL / API Key / 模型名。';
          return { ...prev, content: body + tail };
        });
        message.error(seen.text ? '输出中断，已保留已有内容' : '响应超时，请检查网络或模型端点');
      }, ms);
    };
    armWatchdog(30000);
    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: t, modelId, conversationId: cid, fileIds, capIds: capIdsToSend }),
        signal: ac.signal,
      });
      if (!res.ok || !res.body) {
        const j = await res.json().catch(() => ({}));
        patchLast(() => ({ id: 'tmp-a', role: 'assistant', content: `⚠️ ${j.error || '请求失败'}` }));
        return;
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      let acc = '';
      let reasoning = '';
      let lastFlush = 0;
      let realU = '';
      let realA = '';
      let idsSeen = false;
      const trace: TraceItem[] = [];
      // 流式刷新节流（~50ms 合并）：以前的实现每个网络分片都 setMsgs，长列表整列重渲染导致打字掉帧；
      // 末尾强制 flush 保证完整性。flushTimer 的清理放在 finally。
      const apply = (force = false) => {
        const now = Date.now();
        const write = () =>
          patchLast(() => ({ id: realA || 'tmp-a', role: 'assistant', content: acc, trace: [...trace], reasoning }));
        if (force || now - lastFlush >= 50) {
          if (flushTimer) {
            clearTimeout(flushTimer);
            flushTimer = null;
          }
          write();
          lastFlush = now;
          return;
        }
        if (!flushTimer) {
          flushTimer = setTimeout(() => {
            flushTimer = null;
            apply(true);
          }, 50 - (now - lastFlush));
        }
      };
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        // 有任何字节进来就把空闲计时往后推：开流之后允许 90 秒的静默（工具执行/长思考）
        armWatchdog(90000);
        buf += decoder.decode(value, { stream: true });
        let nl = buf.indexOf('\n');
        while (nl >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          nl = buf.indexOf('\n');
          if (!line) continue;
          let ev: any;
          try {
            ev = JSON.parse(line);
          } catch {
            continue;
          }
          if (ev.t === 'd') {
            acc += ev.v;
            seen.text = true;
          }
          else if (ev.t === 'think') reasoning += ev.v;
          else if (ev.t === 'ids') {
            // 服务端预生成的正式消息 id：本地替换 tmp id，结束后不再整段重拉（D5-O7）
            realU = ev.u || '';
            realA = ev.a || '';
            idsSeen = true;
            if (activeIdRef.current === cid) {
              setMsgs((m) =>
                m.map((x) => {
                  const id = x.id === 'tmp-u' ? realU : x.id === 'tmp-a' ? realA : x.id;
                  return id && id !== x.id ? { ...x, id } : x;
                }),
              );
            }
          }
          else if (ev.t === 'tool_call') trace.push({ type: 'tool_call', name: ev.name, args: ev.args });
          else if (ev.t === 'tool_result') trace.push({ type: 'tool_result', name: ev.name, result: ev.result });
          else if (ev.t === 'cache') trace.push({ type: 'cache' });
        }
        apply();
      }
      if (flushTimer) {
        clearTimeout(flushTimer);
        flushTimer = null;
      }
      apply(true);
      if (idsSeen) {
        // 已从流里拿到正式 id 与完整内容：本地补正即可，不再整段重拉历史（D5-O7）
        if (activeIdRef.current === cid) {
          setMsgs((m) =>
            m.map((x) => {
              const id = x.id === 'tmp-u' ? realU : x.id === 'tmp-a' ? realA : x.id;
              return id && id !== x.id ? { ...x, id } : x;
            }),
          );
        }
      } else {
        await loadMessages(cid);
      }
    } catch (e: any) {
      // 网络中断时不能只弹一个 3 秒就消失的 toast：助手气泡会停在空框上，
      // 用户以为「AI 不回话」。把失败原因写进气泡本身，并保留已生成内容。
      if (e?.name !== 'AbortError') {
        const raw = String(e?.message || '');
        const reason = /Failed to fetch|NetworkError|Load failed|fetch failed/i.test(raw)
          ? '⚠️ 网络连接中断，消息没有发出去。请检查网络后点「重试」。'
          : `⚠️ ${raw || '网络错误，请稍后重试。'}`;
        patchLast((prev) => ({ ...prev, content: prev.content || reason }));
        message.error('发送失败，请检查网络后重试');
      }
    } finally {
      if (idleTimer) clearTimeout(idleTimer);
      if (flushTimer) clearTimeout(flushTimer);
      abortRef.current = null;
      setBusy(false);
    }
  }

  const send = () => doSend(input);
  const stop = () => {
    abortRef.current?.abort();
    setBusy(false);
  };

  const retry = (m: Msg) => {
    const idx = msgs.findIndex((x) => x.id === m.id);
    const prev = [...msgs].slice(0, idx).reverse().find((x) => x.role === 'user');
    if (prev) doSend(prev.content);
  };

  // 编辑重发：回填内容，发送时截断该消息及其后全部消息并重新生成（D5-O8）
  function startEdit(m: Msg) {
    if (lockComposer || busy) return;
    if (!m.id || m.id.startsWith('tmp')) return;
    setEditTarget(m);
    setInput(m.content);
    message.info('正在编辑该条消息，发送后将替换原消息并重新生成其后内容');
  }

  async function sendFeedback(m: Msg, rating: 'up' | 'down') {
    if (!m.id.startsWith('tmp')) {
      await fetch('/api/chat/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messageId: m.id, rating }),
      });
      message.success(rating === 'up' ? '已点赞' : '已反馈');
    }
    setMsgs((list) => list.map((x) => (x.id === m.id ? { ...x, feedback: rating } : x)));
  }

  async function copyText(t: string) {
    try {
      await navigator.clipboard.writeText(t);
      message.success('已复制');
    } catch {
      message.warning('复制失败');
    }
  }

  async function uploadAttachment(file: File) {
    const fd = new FormData();
    fd.append('file', file);
    if (activeId) fd.append('conversationId', activeId);
    const r = await fetch('/api/files', { method: 'POST', body: fd });
    const j = await r.json().catch(() => ({}));
    if (r.ok && j.id) {
      setAttached((a) => (a.find((x) => x.id === j.id) ? a : [...a, { id: j.id, filename: j.filename }]));
      loadFiles();
      loadWorkspace();
      message.success(`已附加：${j.filename}`);
    } else {
      message.error(j.error || '上传失败');
    }
    return false;
  }

  function startVoice() {
    const SR = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SR) {
      message.warning('当前浏览器不支持语音输入');
      return;
    }
    const rec = new SR();
    rec.lang = 'zh-CN';
    rec.interimResults = true;
    rec.continuous = false;
    const base = input;
    setListening(true);
    rec.onresult = (e: any) => {
      let t = '';
      for (let i = e.resultIndex; i < e.results.length; i++) t += e.results[i][0].transcript;
      setInput((base ? base + ' ' : '') + t);
    };
    rec.onerror = () => setListening(false);
    rec.onend = () => setListening(false);
    rec.start();
  }

  function speak(text: string) {
    if (!('speechSynthesis' in window)) {
      message.warning('当前浏览器不支持语音播报');
      return;
    }
    window.speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text.slice(0, 800));
    u.lang = 'zh-CN';
    window.speechSynthesis.speak(u);
  }

  function toggleAttach(f: Attached) {
    setAttached((a) => (a.find((x) => x.id === f.id) ? a.filter((x) => x.id !== f.id) : [...a, f]));
  }

  // 支持从剪贴板粘贴图片/文件
  async function handlePaste(e: React.ClipboardEvent) {
    const items = e.clipboardData?.items;
    if (!items) return;
    const files: File[] = [];
    for (let i = 0; i < items.length; i++) {
      if (items[i].kind === 'file') {
        const f = items[i].getAsFile();
        if (f) files.push(f);
      }
    }
    if (files.length) {
      e.preventDefault();
      for (const f of files) await uploadAttachment(f);
    }
  }

  // 支持把文件拖进输入区
  async function handleDrop(e: React.DragEvent) {
    const files = Array.from(e.dataTransfer?.files || []);
    if (files.length) {
      e.preventDefault();
      for (const f of files) await uploadAttachment(f as File);
    }
  }

  // 把 AI 回答的行动点加入待办收件箱（WorkBuddy 闭环）
  async function addTodo(m: Msg) {
    const title =
      (m.content || '')
        .replace(/[#*`>|]/g, '')
        .replace(/[ 🔥/]/g, ' ')
        .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{2744}\u{2705}\u{2728}]/gu, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 60) || '来自对话的行动项';
    const r = await fetch('/api/todos', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title,
        detail: m.content.slice(0, 800),
        source: 'chat',
        sourceRef: { conversationId: activeId, messageId: m.id.startsWith('tmp') ? undefined : m.id },
      }),
    });
    if (r.ok) message.success('已加入待办，可在工作台查看');
    else message.error((await r.json().catch(() => ({}))).error || '加入失败');
  }

  async function toDocPpt(
    kind: 'doc' | 'ppt',
    content: string,
    format: 'docx' | 'md' | 'txt' = 'docx',
  ) {
    if (!content.trim()) return;
    try {
      // 注意：文档接口是 /api/docs/generate（复数），历史上写成 /api/doc/generate 导致 404
      const url = kind === 'doc' ? '/api/docs/generate' : '/api/ppt/generate';
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          brief: content,
          modelId,
          projectId: activeProject,
          conversationId: activeId,
          ...(kind === 'doc' ? { format } : {}),
        }),
      });
      if (!r.ok) {
        message.error((await r.json().catch(() => ({}))).error || '生成失败');
        return;
      }
      const blob = await r.blob();
      const url2 = URL.createObjectURL(blob);
      const ext = kind === 'doc' ? format : 'pptx';
      const a = document.createElement('a');
      a.href = url2;
      a.download = `${kind === 'doc' ? '文档' : '演示'}_${Date.now()}.${ext}`;
      a.click();
      URL.revokeObjectURL(url2);
      message.success(
        kind === 'doc'
          ? `已生成 .${ext}`
          : '已生成 .pptx',
      );
    } catch (e: any) {
      message.error(e?.message || '生成失败');
    }
  }

  async function doShare() {
    if (!activeId) return;
    const v = await safeValidate(shareForm);
    if (!v) return;
    const r = await fetch(`/api/conversations/${activeId}/share`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(v),
    });
    const j = await r.json().catch(() => ({}));
    if (r.ok) {
      setShareUrl(`${window.location.origin}${j.url}`);
      message.success('分享链接已生成');
    } else {
      message.error(j.error || '分享失败');
    }
  }

  function copyShare() {
    navigator.clipboard.writeText(shareUrl).then(
      () => message.success('已复制'),
      () => message.warning('复制失败'),
    );
  }

  async function submitSaveSkill() {
    const v = await safeValidate(saveSkillForm);
    if (!v) return;
    const r = await fetch('/api/skills', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: v.name,
        description: '由对话回答保存',
        scope: v.scope,
        steps: [{ role: 'worker', prompt: saveSkill.content }],
      }),
    });
    if (r.ok) {
      message.success('已保存为技能');
      setSaveSkill({ open: false, content: '' });
      saveSkillForm.resetFields();
      loadSkills();
    } else {
      message.error((await r.json().catch(() => ({}))).error || '保存失败');
    }
  }

  function renameConv(c: Conv) {
    let val = c.title;
    modal.confirm({
      title: '重命名会话',
      content: <Input defaultValue={c.title} onChange={(e) => (val = e.target.value)} style={{ marginTop: 8 }} />,
      okText: '保存',
      cancelText: '取消',
      onOk: async () => {
        await fetch('/api/conversations', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: c.id, title: val || c.title }),
        });
        setConvs((list) => list.map((x) => (x.id === c.id ? { ...x, title: val || c.title } : x)));
      },
    });
  }

  async function setProject(c: Conv, pid: string | null) {
    await fetch('/api/conversations', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: c.id, projectId: pid }),
    });
    setConvs((list) => list.map((x) => (x.id === c.id ? { ...x, projectId: pid } : x)));
    if (c.id === activeId) setActiveProject(pid);
    message.success(pid ? '已绑定到项目' : '已解除项目绑定');
  }

  async function togglePin(c: Conv) {
    await fetch('/api/conversations', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: c.id, pinned: !c.pinned }),
    });
    setConvs((list) => list.map((x) => (x.id === c.id ? { ...x, pinned: !x.pinned } : x)));
  }

  async function delConv(c: Conv) {
    await fetch(`/api/conversations?id=${c.id}`, { method: 'DELETE' });
    setConvs((list) => list.filter((x) => x.id !== c.id));
    if (activeId === c.id) {
      setActiveId('');
      activeIdRef.current = '';
      try {
        if (localStorage.getItem('chat.lastConv') === c.id) localStorage.removeItem('chat.lastConv');
      } catch {
        /* 忽略 */
      }
      setActiveProject(null);
      setMsgs([]);
      setHasMoreOlder(false);
    }
  }

  const userMsgs = msgs.filter((m) => m.role === 'user');

  function scrollToBottom() {
    const el = scrollRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'auto' });
  }

  function scrollToMsg(id: string) {
    const el = scrollRef.current;
    const node = msgRefs.current[id];
    if (!el || !node) return;
    const delta = node.getBoundingClientRect().top - el.getBoundingClientRect().top;
    el.scrollTo({ top: el.scrollTop + delta - 8, behavior: 'smooth' });
  }

  const setMsgRef = useCallback((id: string, el: HTMLDivElement | null) => {
    msgRefs.current[id] = el;
  }, []);

  function onScroll() {
    const el = scrollRef.current;
    if (!el) return;
    // 顶部按需补更早的历史（游标分页）
    if (el.scrollTop <= 8 && hasMoreOlder && !loadingOlder && !msgsLoading && activeIdRef.current) {
      loadMessages(activeIdRef.current, 'older');
    }
    setAtBottom(el.scrollHeight - el.scrollTop - el.clientHeight < 40);
    const cTop = el.getBoundingClientRect().top;
    let active = '';
    for (let i = userMsgs.length - 1; i >= 0; i--) {
      const node = msgRefs.current[userMsgs[i].id];
      if (node && node.getBoundingClientRect().top - cTop <= 64) {
        active = userMsgs[i].id;
        break;
      }
    }
    setActiveAnchor(active);
  }

  const filtered = convs.filter((c) => c.title.toLowerCase().includes(search.toLowerCase()));

  const convMenu = (c: Conv) => ({
    items: [
      { key: 'pin', label: c.pinned ? '取消置顶' : '置顶', icon: <PushpinOutlined /> },
      { key: 'rename', label: '重命名', icon: <EditOutlined /> },
      { key: 'project', label: '绑定项目', icon: <ProjectOutlined /> },
      { type: 'divider' as const },
      { key: 'delete', label: '删除', icon: <DeleteOutlined />, danger: true },
    ],
    onClick: ({ key }: { key: string }) => {
      if (key === 'pin') togglePin(c);
      else if (key === 'rename') renameConv(c);
      else if (key === 'project') {
        setProjPick(c.projectId || 'none');
        setProjModal({ open: true, conv: c });
      } else if (key === 'delete') delConv(c);
    },
  });

  return (
    <div className="chat-shell">
      {/* 左：会话列表 */}
      <div className="chat-list">
        <div className="chat-list-head">
          <Tooltip title={isGuest ? '访客为只读角色，无法新建对话' : ''}>
            {/* 主色实心大块会把视线从小输入框抢走，这里用带主色描边的次按钮 */}
            <Button className="new-conv-btn" icon={<PlusOutlined />} block onClick={() => newConv(activeProject)} disabled={isGuest}>
              新建对话
            </Button>
          </Tooltip>
          <Input
            prefix={<SearchOutlined />}
            placeholder="搜索会话"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            style={{ marginTop: 10 }}
          />
        </div>
        <div className="chat-list-body">
          {filtered.length === 0 && (
            <div style={{ color: 'var(--muted)', textAlign: 'center', marginTop: 30 }}>暂无会话</div>
          )}
          {filtered.map((c) => (
            <div key={c.id} className={`conv-item ${c.id === activeId ? 'active' : ''}`} onClick={() => selectConv(c.id)}>
              <span className="conv-title" title={c.title}>
                {c.pinned && <PushpinOutlined style={{ color: 'var(--accent)', marginRight: 4 }} />}
                {c.isOwner === false && <TeamOutlined style={{ color: 'var(--muted)', marginRight: 4, fontSize: 12 }} />}
                {c.title}
              </span>
              {c.isOwner === false ? (
                <span style={{ fontSize: 11, color: 'var(--muted)', flexShrink: 0 }}>共享·{c.ownerName || '成员'}</span>
              ) : !isGuest ? (
                <span className="conv-actions" onClick={(e) => e.stopPropagation()}>
                  <Dropdown menu={convMenu(c)} trigger={['click']} placement="bottomRight">
                    <Button type="text" size="small" icon={<MoreOutlined />} aria-label="会话更多操作" />
                  </Dropdown>
                </span>
              ) : null}
            </div>
          ))}
        </div>
      </div>

      {/* 右：对话区 */}
      <div className="chat-main">
        <div className="chat-topbar">
          <Space size={8} wrap>
            <strong style={{ fontSize: 16 }}>对话</strong>
            <Tag color="cyan" style={{ fontSize: 11, lineHeight: '18px' }}>
              知识库 + 长期记忆
            </Tag>
            {editTarget && (
              <Tag color="orange" style={{ fontSize: 11, lineHeight: '18px' }}>
                正在编辑历史消息（发送后替换其后内容）
                <a
                  style={{ marginLeft: 6 }}
                  onClick={() => {
                    setEditTarget(null);
                    setInput('');
                  }}
                >
                  取消
                </a>
              </Tag>
            )}
            {activeProject && (
              <Tag color="blue" icon={<ProjectOutlined />}>
                {projects.find((p) => p.id === activeProject)?.name || '项目'}
              </Tag>
            )}
          </Space>
          <Space>
            {models.length === 0 && (
              <span style={{ color: 'var(--muted)', fontSize: 12 }}>（未配置可用模型，请到管理后台添加）</span>
            )}
            {activeId && (
              <>
                <Tooltip title={wsOpen ? '收起文件栏' : '展开文件栏'}>
                  <Button size="small" icon={<FolderOpenOutlined />} aria-label="切换工作空间文件面板" onClick={() => setWsOpen((v) => !v)} />
                </Tooltip>
                <Button size="small" icon={<ShareAltOutlined />} onClick={() => { setShareUrl(''); shareForm.resetFields(); setShareOpen(true); }}>
                  分享
                </Button>
              </>
            )}
          </Space>
        </div>

        <div className="chat-scroll-wrap">
          <div className="chat-scroll" ref={scrollRef} onScroll={onScroll}>
          <div className="chat-center">
            {msgs.length === 0 && !activeId && (
              <div className="welcome">
                <div style={{ color: 'var(--accent)' }}>
                  <ThunderboltOutlined style={{ fontSize: 40 }} />
                </div>
                <h2>有什么可以帮你的？</h2>
                <div className="sub">已接入团队知识库与长期记忆，点击下方建议开始，或直接在下方输入</div>
                <div className="chips">
                  {SUGGESTIONS.map((s) => (
                    <div key={s} className="prompt-chip" onClick={() => doSend(s)}>
                      {s}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {msgs.length === 0 && activeId && (
              msgsLoading ? (
                <div style={{ padding: '12px 36px', marginTop: 40, maxWidth: 820, margin: '40px auto 0' }}>
                  <Skeleton active title paragraph={{ rows: 2 }} />
                  <Skeleton active title={false} paragraph={{ rows: 4 }} />
                  <Skeleton active title paragraph={{ rows: 1 }} />
                </div>
              ) : (
                <Empty description="这个会话还没有消息" style={{ marginTop: 80 }} />
              )
            )}

            {loadingOlder && (
              <div style={{ textAlign: 'center', padding: 10, color: 'var(--muted)', fontSize: 12 }}>加载更早的消息…</div>
            )}

            {msgs.map((m, i) => (
              <MessageItem
                key={m.id}
                m={m}
                busy={busy}
                isGuest={isGuest}
                readOnly={readOnly}
                lazy={i < msgs.length - PAGE_SIZE}
                actions={msgActions}
                setRef={setMsgRef}
              />
            ))}

            <div ref={bottomRef} />
          </div>
          </div>

          {userMsgs.length > 1 && (
            <div className="chat-anchor">
              {userMsgs.map((m) => (
                <Tooltip key={m.id} title={(m.content || '附件').slice(0, 60)} placement="left">
                  <div
                    className={`chat-anchor-dot ${activeAnchor === m.id ? 'active' : ''}`}
                    onClick={() => scrollToMsg(m.id)}
                  />
                </Tooltip>
              ))}
            </div>
          )}

          {!atBottom && (
            <button className="scroll-bottom-btn" onClick={scrollToBottom} title="回到底部">
              <DownOutlined />
            </button>
          )}
        </div>

        {(readOnly || isGuest) && (
          <div className="readonly-banner">
            <LockOutlined />{' '}
            {readOnly
              ? `项目共享的只读会话（属于 ${convOwner || '其他成员'}）。你可以查看历史，但不能发送消息。`
              : '访客为只读角色。你可以浏览会话与文件，但不能发送消息或创建内容。'}
          </div>
        )}
        {proposals.length > 0 && (
          <div className="skill-proposal-bar">
            {proposals.map((p) => (
              <div key={p.id} className="skill-proposal-card">
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13, fontWeight: 600 }}>
                    <CloudDownloadOutlined style={{ marginRight: 6 }} />
                    安装提议：{p.name}
                    {p.version && p.version !== '—' ? ` v${p.version}` : ''}
                  </div>
                  <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 2 }}>
                    来源 {p.sourceLabel || p.ref}
                    {p.author ? ` · 作者 ${p.author}` : ''}
                    {Array.isArray(p.security) && p.security.length
                      ? ` · 安全扫描：${p.security.map((x: any) => `${x.vendor} ${x.statusText || x.status}`).join('；')}`
                      : ' · 无安全扫描报告'}
                    {Array.isArray(p.scriptFiles) && p.scriptFiles.length
                      ? ` · 附带 ${p.scriptFiles.length} 个脚本（本平台不执行）`
                      : ''}
                  </div>
                  {p.description && (
                    <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 4 }}>
                      {String(p.description).slice(0, 160)}
                    </div>
                  )}
                </div>
                <Space size={6}>
                  {meRole === 'admin' ? (
                    <Button size="small" type="primary" onClick={() => resolveProposal(p.id, 'confirm')}>
                      确认安装
                    </Button>
                  ) : (
                    <Tooltip title="仅管理员可确认安装">
                      <Button size="small" disabled>
                        待管理员确认
                      </Button>
                    </Tooltip>
                  )}
                  <Button size="small" onClick={() => resolveProposal(p.id, 'dismiss')}>
                    忽略
                  </Button>
                </Space>
              </div>
            ))}
          </div>
        )}
        <Composer
          value={input}
          onChange={setInput}
          onSend={send}
          onPaste={handlePaste}
          onDrop={handleDrop}
          readOnly={lockComposer}
          busy={busy}
          onStop={stop}
          attached={attached}
          skillPick={skillPick}
          onDetachSkill={() => setSkillPick(null)}
          onToggleAttach={toggleAttach}
          myFiles={myFiles}
          skills={skills}
          onPickSkill={setSkillPick}
          onUpload={uploadAttachment}
          listening={listening}
          onVoice={startVoice}
          models={models}
          modelId={modelId}
          onModelChange={(v: string) => {
            setModelId(v);
            try {
              localStorage.setItem('chat.modelId', v);
            } catch {
              /* ignore */
            }
          }}
          caps={capChips}
          onAddCap={addCap}
          onDetachCap={detachCap}
        />
      </div>

      {wsOpen && activeId && (
        <aside className="chat-ws">
          <div className="chat-ws-head">
            <span>工作空间文件</span>
            {!isGuest && (
              <Upload showUploadList={false} beforeUpload={(f) => uploadAttachment(f as any)}>
                <Tooltip title="上传到本会话">
                  <Button type="text" size="small" icon={<PlusOutlined />} aria-label="上传文件到本会话" />
                </Tooltip>
              </Upload>
            )}
          </div>
          <div className="chat-ws-body">
            {wsFiles.length === 0 && (
              <div style={{ color: 'var(--muted)', fontSize: 12, textAlign: 'center', marginTop: 20 }}>暂无文件</div>
            )}
            {wsFiles.map((f) => (
              <div key={f.id} className="ws-file">
                <FileTextOutlined style={{ color: 'var(--muted)', flexShrink: 0 }} />
                <span className="ws-file-name" title={f.filename}>
                  {f.filename}
                </span>
                <a href={`/api/files/${f.id}`} title="下载" onClick={(e) => e.stopPropagation()}>
                  <DownloadOutlined />
                </a>
              </div>
            ))}
          </div>
        </aside>
      )}

      <Modal
        open={projModal.open}
        title="绑定项目"
        okText="保存"
        cancelText="取消"
        onCancel={() => setProjModal({ open: false, conv: null })}
        onOk={() => {
          if (projModal.conv) setProject(projModal.conv, projPick === 'none' ? null : projPick);
          setProjModal({ open: false, conv: null });
        }}
      >
        <Select
          style={{ width: '100%', marginTop: 8 }}
          value={projPick}
          onChange={setProjPick}
          options={[{ value: 'none', label: '不绑定项目' }, ...projects.map((p) => ({ value: p.id, label: p.name }))]}
        />
      </Modal>

      <Modal
        open={saveSkill.open}
        title="存为技能"
        okText="保存"
        cancelText="取消"
        onCancel={() => setSaveSkill({ open: false, content: '' })}
        onOk={submitSaveSkill}
        destroyOnHidden
      >
        <Form form={saveSkillForm} layout="vertical">
          <Form.Item name="name" label="技能名" rules={[{ required: true, message: '请输入名称' }]} initialValue="对话洞察">
            <Input placeholder="如：周报生成器" />
          </Form.Item>
          <Form.Item name="scope" label="作用域" initialValue="personal">
            <Select options={[{ value: 'personal', label: '个人' }, { value: 'team', label: '团队' }]} />
          </Form.Item>
        </Form>
        <div style={{ color: 'var(--muted)', fontSize: 12 }}>将把该回答作为 worker 步骤的 prompt 保存为技能。</div>
      </Modal>

      <Modal title="分享 / 交付会话" open={shareOpen} onCancel={() => setShareOpen(false)} footer={null} destroyOnHidden>
        <Form form={shareForm} layout="vertical" initialValues={{ visibility: 'link', expiresInDays: 0 }}>
          <Form.Item name="visibility" label="分享范围">
            <Select
              options={[
                { value: 'link', label: '链接分享（持链接者只读查看）' },
                { value: 'user', label: '指定用户（需登录且邮箱匹配）' },
              ]}
            />
          </Form.Item>
          {shareVisibility === 'user' && (
            <Form.Item name="sharedWith" label="接收者邮箱" rules={[{ required: true, type: 'email', message: '请输入有效邮箱' }]}>
              <Input placeholder="receiver@example.com" />
            </Form.Item>
          )}
          <Form.Item name="expiresInDays" label="有效期（天，0 = 永久）">
            <InputNumber min={0} max={365} style={{ width: '100%' }} />
          </Form.Item>
          <Button type="primary" onClick={doShare}>
            生成分享链接
          </Button>
        </Form>
        {shareUrl && (
          <div style={{ marginTop: 12 }}>
            {/* antd 6 起 Input 的 addonAfter 弃用，统一用 Space.Compact 组合输入框与按钮 */}
            <Space.Compact style={{ width: '100%' }}>
              <Input readOnly value={shareUrl} aria-label="分享链接" />
              <Button onClick={copyShare}>复制</Button>
            </Space.Compact>
            <div style={{ color: 'var(--muted)', fontSize: 12, marginTop: 6 }}>任何人打开该链接可只读查看此会话历史。</div>
          </div>
        )}
      </Modal>
    </div>
  );
}
