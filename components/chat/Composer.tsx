'use client';

import { useMemo, useRef, useState, useEffect } from 'react';
import { Input, Button, Space, Tag, Tooltip, Upload, Dropdown, Select } from 'antd';
import {
  SendOutlined,
  StopOutlined,
  PaperClipOutlined,
  AudioOutlined,
  ThunderboltOutlined,
  FileTextOutlined,
  ApartmentOutlined,
} from '@ant-design/icons';
import type { Attached, CapMention, ModelOption, Skill } from './types';

/** 「/」联想里的可选项：技能（运行模式）或能力（关联模式，写入 @cap 标记） */
type SlashItem =
  | { kind: 'skill'; id: string; name: string; description: string | null; scope?: string }
  | { kind: 'cap'; id: string; name: string; description: string | null; method?: string; path?: string; connectorName?: string };
type SlashGroup = { label: string; items: SlashItem[] };
type Mentions = { builtinSkills: any[]; selfSkills: any[]; thirdParty: { connector: any; caps: any[] }[] };

/** 上下文长度口语化：128000 → 128K、200000 → 200K、1048576 → 1.0M；0/未知返回空串（不占位） */
function fmtCtx(n?: number): string {
  const v = Number(n || 0);
  if (!v) return '';
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1000) return `${Math.round(v / 1000)}K`;
  return String(v);
}

/** 厂商 id → 展示名（未知厂商原样显示，如自定义 openai-compatible 代理） */
const PROVIDER_LABEL: Record<string, string> = {
  openai: 'OpenAI',
  anthropic: 'Anthropic',
  google: 'Google',
  deepseek: 'DeepSeek',
  moonshot: '月之暗面',
  minimax: 'MiniMax',
  zhipu: '智谱 GLM',
  qwen: '通义千问',
  hunyuan: '腾讯混元',
  sensenova: '商汤日日新',
  siliconflow: '硅基流动',
  ollama: '本地 Ollama',
};

/**
 * 输入区（Composer）：从 Chat.tsx 原地抽出。
 * 包含：附件/技能 chips、多行输入（Enter 发送）、@ 引用、/ 技能、语音、模型选择、发送/停止。
 * 也可被工作台的快速输入框复用（后续演进）。
 */
export type ComposerProps = {
  value: string;
  onChange: (v: string) => void;
  onSend: () => void;
  onPaste: (e: React.ClipboardEvent) => void;
  onDrop: (e: React.DragEvent) => void;
  readOnly: boolean;
  busy: boolean;
  onStop: () => void;
  attached: Attached[];
  skillPick: Skill | null;
  onDetachSkill: () => void;
  onToggleAttach: (f: Attached) => void;
  myFiles: Attached[];
  skills: Skill[];
  onPickSkill: (s: Skill) => void;
  onUpload: (f: File) => Promise<boolean>;
  listening: boolean;
  onVoice: () => void;
  models: ModelOption[];
  modelId: string;
  onModelChange: (v: string) => void;
  // 「/」关联能力：选中后在输入写入 @cap 标记并生成 chip
  caps: CapMention[];
  onAddCap: (c: CapMention) => void;
  onDetachCap: (id: string) => void;
};

export default function Composer(props: ComposerProps) {
  const { attached, skillPick, myFiles, skills, caps } = props;

  // —— 输入 @ 即联想文件（可继续输入关键字过滤，↑↓ 选择，Enter/Tab 插入，Esc 关闭）——
  const [mention, setMention] = useState<{ start: number; end: number; query: string } | null>(null);
  const [mentionIdx, setMentionIdx] = useState(0);
  // —— 输入 / 即联想「技能 / 能力」，按 内置技能 / 自建技能 / 三方系统 分组面包屑 ——
  const [slash, setSlash] = useState<{ start: number; end: number; query: string } | null>(null);
  const [slashIdx, setSlashIdx] = useState(0);
  // 「/」联想数据源（懒加载，首次触发时拉取一次）
  const [mentions, setMentions] = useState<Mentions | null>(null);
  const [mentionsLoading, setMentionsLoading] = useState(false);
  const taRef = useRef<any>(null);

  const candidates = useMemo(() => {
    if (!mention) return [];
    const q = mention.query.trim().toLowerCase();
    const pool = myFiles.filter((f) => (q ? f.filename.toLowerCase().includes(q) : true));
    return pool.slice(0, 8);
  }, [mention, myFiles]);

  // 「/」分组：内置能力 / 自建技能 / 三方系统（按连接器分组）
  const slashGroups = useMemo<SlashGroup[]>(() => {
    if (!slash || !mentions) return [];
    const q = slash.query.trim().toLowerCase();
    const match = (name: string, desc: string | null) => !q || `${name} ${desc || ''}`.toLowerCase().includes(q);
    const groups: SlashGroup[] = [];

    const builtin = mentions.builtinSkills
      .filter((s: any) => match(s.name, s.description))
      .map((s: any) => ({ kind: 'skill' as const, id: s.id, name: s.name, description: s.description, scope: s.scope }));
    if (builtin.length) groups.push({ label: '内置技能', items: builtin });

    const self = mentions.selfSkills
      .filter((s: any) => match(s.name, s.description))
      .map((s: any) => ({ kind: 'skill' as const, id: s.id, name: s.name, description: s.description, scope: s.scope }));
    if (self.length) groups.push({ label: '自建技能', items: self });

    for (const tp of mentions.thirdParty) {
      const items = tp.caps
        .filter((c: any) => match(c.name, c.description))
        .map((c: any) => ({ kind: 'cap' as const, id: c.id, name: c.name, description: c.description, method: c.method, path: c.path, connectorName: tp.connector?.name }));
      if (items.length) groups.push({ label: `三方系统 · ${tp.connector?.name || '未知'}`, items });
    }
    return groups;
  }, [slash, mentions]);

  const slashFlat = useMemo<SlashItem[]>(() => slashGroups.flatMap((g) => g.items), [slashGroups]);

  // 模型下拉：按厂商分组 + 展示上下文与能力标签，支持按名称 / 厂商搜索
  const modelGroups = useMemo(() => {
    const map = new Map<string, any[]>();
    for (const m of props.models) {
      const caps = m.caps || [];
      const ctx = fmtCtx(m.contextLength);
      const option = {
        value: m.id,
        label: m.name,
        // 只用于搜索匹配，不渲染（optionFilterProp="search"）
        search: `${m.name} ${m.provider} ${PROVIDER_LABEL[m.provider] || ''} ${m.id}`,
        title: `${m.name} · ${PROVIDER_LABEL[m.provider] || m.provider}${ctx ? ` · 上下文 ${ctx}` : ''}${
          caps.includes('tools') ? ' · 支持工具调用' : ''
        }${m.isDefault ? ' · 默认模型' : ''}`,
        caps,
        ctx,
        isDefault: m.isDefault,
      };
      const key = m.provider || '其他';
      const arr = map.get(key) || [];
      arr.push(option);
      map.set(key, arr);
    }
    // 组内：默认模型在前；组间：含默认模型的厂商排最前，其余按厂商名
    for (const arr of map.values()) {
      arr.sort((a: any, b: any) => Number(b.isDefault) - Number(a.isDefault) || a.label.localeCompare(b.label));
    }
    return [...map.entries()]
      .sort((a, b) => {
        const aDef = a[1].some((o: any) => o.isDefault) ? 0 : 1;
        const bDef = b[1].some((o: any) => o.isDefault) ? 0 : 1;
        return aDef - bDef || a[0].localeCompare(b[0]);
      })
      .map(([label, options]) => ({ label: PROVIDER_LABEL[label] || label, options }));
  }, [props.models]);

  // 首次触发「/」时拉取分类数据源（内置能力 / 自建技能 / 三方系统）
  useEffect(() => {
    if (slash && !mentions && !mentionsLoading) {
      setMentionsLoading(true);
      fetch('/api/chat/mentions')
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => {
          if (d && d.builtinSkills) setMentions(d);
        })
        .catch(() => {})
        .finally(() => setMentionsLoading(false));
    }
  }, [slash, mentions, mentionsLoading]);

  /** 在光标前寻找 "@关键字" 片段：@ 需位于行首或空白之后，且其后不含空格 */
  function detectMention(value: string, caret: number) {
    if (props.readOnly) {
      setMention(null);
      return;
    }
    const before = value.slice(0, caret);
    const at = before.lastIndexOf('@');
    if (at < 0) {
      setMention(null);
      return;
    }
    const seg = before.slice(at + 1);
    if (!/^[\w一-鿿.\-]*$/.test(seg)) {
      setMention(null);
      return;
    }
    if (seg.startsWith('cap:')) {
      setMention(null); // @cap: 是能力关联标记，不触发文件联想
      return;
    }
    if (at > 0 && !/\s/.test(before[at - 1])) {
      setMention(null); // 邮箱、代码里的 @ 不触发
      return;
    }
    setMention({ start: at, end: caret, query: seg });
    setMentionIdx(0);
  }

  /** 在光标前寻找 "/关键字" 片段：/ 需位于行首或空白之后 */
  function detectSlash(value: string, caret: number) {
    if (props.readOnly) {
      setSlash(null);
      return;
    }
    const before = value.slice(0, caret);
    const at = before.lastIndexOf('/');
    if (at < 0) {
      setSlash(null);
      return;
    }
    const seg = before.slice(at + 1);
    if (!/^[\w一-鿿.\-]*$/.test(seg)) {
      setSlash(null);
      return;
    }
    if (at > 0 && !/\s/.test(before[at - 1])) {
      setSlash(null); // 路径、网址里的 / 不触发
      return;
    }
    setSlash({ start: at, end: caret, query: seg });
    setSlashIdx(0);
  }

  /** 插入选中的文件：文本里补 @文件名，并把它加入附件（内容进上下文） */
  function pickFile(f: Attached) {
    if (!mention) return;
    const v = props.value;
    const next = v.slice(0, mention.start) + '@' + f.filename + ' ' + v.slice(mention.end);
    props.onChange(next);
    setMention(null);
    if (!attached.some((a) => a.id === f.id)) props.onToggleAttach(f);
    const pos = mention.start + f.filename.length + 2;
    requestAnimationFrame(() => {
      const ta =
        taRef.current?.resizableTextArea?.textArea ||
        taRef.current?.textArea ||
        document.querySelector('.composer textarea') ||
        document.querySelector('textarea.composer-input');
      if (ta) {
        ta.focus();
        try {
          ta.setSelectionRange(pos, pos);
        } catch {
          /* 某些浏览器对 textarea 光标设置有限制 */
        }
      }
    });
  }

  /**
   * 选中「/」项：
   *  - 技能（skill）：移除 /关键字，设为本次运行技能（沿用原运行模式）；
   *  - 能力（cap，来自三方系统）：只留下关联状态（chip），发送时由前端把 capIds
   *    一并带给对话路由。不再往正文里写 @cap:xxx 标记 —— 那个标记会露在输入框和消息气泡里，
   *    既难看又会被模型误当成正文（上一版正是这样）。
   */
  function pickSlashItem(item: SlashItem) {
    if (!slash) return;
    const v = props.value;
    const rest = (v.slice(0, slash.start) + v.slice(slash.end)).replace(/\s{2,}/g, ' ').trimStart();
    if (item.kind === 'skill') {
      props.onChange(rest);
      props.onPickSkill({ id: item.id, name: item.name, description: item.description, scope: item.scope || 'personal', steps: [] });
      setSlash(null);
      requestAnimationFrame(() => {
        const ta =
          taRef.current?.resizableTextArea?.textArea ||
          taRef.current?.textArea ||
          document.querySelector('.composer textarea');
        if (ta) {
          ta.focus();
          try {
            ta.setSelectionRange(0, 0);
          } catch {
            /* ignore */
          }
        }
      });
      return;
    }
    // 能力：只写关联状态（chip），正文保持干净
    const next = rest.replace(/\s{2,}/g, ' ').trimStart();
    props.onChange(next);
    props.onAddCap({ id: item.id, name: item.name });
    setSlash(null);
    requestAnimationFrame(() => {
      const ta =
        taRef.current?.resizableTextArea?.textArea ||
        taRef.current?.textArea ||
        document.querySelector('.composer textarea');
      if (ta) {
        ta.focus();
        const pos = next.length;
        try {
          ta.setSelectionRange(pos, pos);
        } catch {
          /* ignore */
        }
      }
    });
  }

  return (
    <div className="composer" onDragOver={(e) => e.preventDefault()} onDrop={props.onDrop}>
      {slash && (
        <div className="mention-popup mention-popup-wide">
          {!mentions ? (
            <div className="mention-hint">正在加载可关联项（内置技能 / 自建技能 / 三方系统）…</div>
          ) : slashFlat.length ? (
            (() => {
              let gi = 0;
              return (
                <>
                  <div className="mention-hint">
                    ↑↓ 切换分组 · Enter 关联 · Esc 关闭（技能=运行，能力=关联本轮对话；输入关键字可过滤）
                  </div>
                  {slashGroups.map((g) => (
                    <div key={g.label}>
                      <div className="mention-group">{g.label}</div>
                      {g.items.map((it) => {
                        const idx = gi++;
                        return (
                          <div
                            key={(it.kind === 'skill' ? 's:' : 'c:') + it.id}
                            className={`mention-item${idx === slashIdx ? ' active' : ''}`}
                            onMouseEnter={() => setSlashIdx(idx)}
                            onMouseDown={(e) => {
                              e.preventDefault();
                              pickSlashItem(it);
                            }}
                          >
                            {it.kind === 'skill' ? (
                              <ThunderboltOutlined style={{ marginRight: 6 }} />
                            ) : (
                              <ApartmentOutlined style={{ marginRight: 6 }} />
                            )}
                            <span style={{ fontWeight: 500 }}>{it.name}</span>
                            {it.kind === 'cap' && it.connectorName ? (
                              <Tag style={{ fontSize: 10, lineHeight: '15px', marginLeft: 6 }}>{it.connectorName}</Tag>
                            ) : null}
                            {it.description ? (
                              <span style={{ color: 'var(--muted)', marginLeft: 8, fontSize: 11, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                                {it.description.slice(0, 40)}
                              </span>
                            ) : null}
                          </div>
                        );
                      })}
                    </div>
                  ))}
                </>
              );
            })()
          ) : (
            <div className="mention-hint">没有匹配的项（可到「技能」页创建，或在「连接器」页接入三方系统）</div>
          )}
        </div>
      )}
      {mention && (
        <div className="mention-popup">
          {candidates.length ? (
            <>
              <div className="mention-hint">↑↓ 选择 · Enter 插入 · Esc 关闭</div>
              {candidates.map((f, i) => (
                <div
                  key={f.id}
                  className={`mention-item${i === mentionIdx ? ' active' : ''}`}
                  onMouseEnter={() => setMentionIdx(i)}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    pickFile(f);
                  }}
                >
                  <FileTextOutlined style={{ marginRight: 6 }} />
                  {f.filename}
                </div>
              ))}
            </>
          ) : (
            <div className="mention-hint">没有匹配的文件（可直接发送，或点「@ 引用」浏览全部）</div>
          )}
        </div>
      )}
      {(attached.length > 0 || skillPick || caps.length > 0) && (
        <div className="composer-chips">
          {skillPick && (
            <Tag color="cyan" closable onClose={props.onDetachSkill} style={{ margin: 0 }}>
              <ThunderboltOutlined /> 技能：{skillPick.name}
            </Tag>
          )}
          {caps.map((c) => (
            <Tag color="blue" closable onClose={() => props.onDetachCap(c.id)} style={{ margin: 0 }}>
              <ApartmentOutlined /> 能力：{c.name}
            </Tag>
          ))}
          {attached.map((a) => (
            <Tag key={a.id} closable onClose={() => props.onToggleAttach(a)} style={{ margin: 0 }}>
              <PaperClipOutlined /> {a.filename}
            </Tag>
          ))}
        </div>
      )}
      <Input.TextArea
        ref={taRef}
        value={props.value}
        onChange={(e) => {
          props.onChange(e.target.value);
          const caret = e.target.selectionStart ?? e.target.value.length;
          detectMention(e.target.value, caret);
          detectSlash(e.target.value, caret);
        }}
        disabled={props.readOnly}
        placeholder={props.readOnly ? '只读模式：你可以浏览历史，但不能发送消息' : '输入消息，Enter 发送，Shift+Enter 换行；/ 关联技能，@ 引用文件'}
        autoSize={{ minRows: 3, maxRows: 12 }}
        onPaste={props.onPaste}
        onKeyDown={(e) => {
          // 技能/能力联想面板（分组面包屑）：上下键切换、Enter/Tab 选中、Esc 关闭
          if (slash) {
            if (slashFlat.length) {
              if (e.key === 'ArrowDown') {
                e.preventDefault();
                setSlashIdx((i) => (i + 1) % slashFlat.length);
                return;
              }
              if (e.key === 'ArrowUp') {
                e.preventDefault();
                setSlashIdx((i) => (i - 1 + slashFlat.length) % slashFlat.length);
                return;
              }
              if (e.key === 'Enter' || e.key === 'Tab') {
                e.preventDefault();
                pickSlashItem(slashFlat[slashIdx]);
                return;
              }
            }
            if (e.key === 'Escape') {
              e.preventDefault();
              setSlash(null);
              return;
            }
          }
          // 文件联想面板打开时：上下键切换、Enter/Tab 选中、Esc 关闭
          if (mention) {
            if (candidates.length) {
              if (e.key === 'ArrowDown') {
                e.preventDefault();
                setMentionIdx((i) => (i + 1) % candidates.length);
                return;
              }
              if (e.key === 'ArrowUp') {
                e.preventDefault();
                setMentionIdx((i) => (i - 1 + candidates.length) % candidates.length);
                return;
              }
              if (e.key === 'Enter' || e.key === 'Tab') {
                e.preventDefault();
                pickFile(candidates[mentionIdx]);
                return;
              }
            }
            if (e.key === 'Escape') {
              e.preventDefault();
              setMention(null);
              return;
            }
          }
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            props.onSend();
          }
        }}
        className="composer-input"
        variant="borderless"
      />
      <div className="composer-bar">
        <Space size={6}>
          {!props.readOnly && (
            <>
              <Upload showUploadList={false} beforeUpload={(file) => props.onUpload(file as any)}>
                <Tooltip title="上传附件">
                  <Button type="text" size="small" icon={<PaperClipOutlined />} aria-label="上传附件" />
                </Tooltip>
              </Upload>
              <Dropdown
                trigger={['click']}
                menu={{
                  items: myFiles.length
                    ? myFiles.slice(0, 30).map((f) => ({ key: f.id, label: f.filename }))
                    : [{ key: 'none', label: '暂无文件', disabled: true }],
                  onClick: ({ key }) => {
                    const f = myFiles.find((x) => x.id === key);
                    if (f) {
                      // 已附加的文件不再重复切换（避免误取消）
                      if (!attached.some((a) => a.id === f.id)) props.onToggleAttach(f);
                      props.onChange(props.value ? props.value : `@${f.filename} `);
                    }
                  },
                }}
              >
                <Tooltip title="引用文件">
                  <Button type="text" size="small">@ 引用</Button>
                </Tooltip>
              </Dropdown>
              <Dropdown
                trigger={['click']}
                menu={{
                  items: skills.length
                    ? skills.map((s) => ({ key: s.id, label: s.name }))
                    : [{ key: 'none', label: '暂无技能', disabled: true }],
                  onClick: ({ key }) => {
                    const s = skills.find((x) => x.id === key);
                    if (s) props.onPickSkill(s);
                  },
                }}
              >
                <Tooltip title="使用技能（/）">
                  <Button type="text" size="small">/ 技能</Button>
                </Tooltip>
              </Dropdown>
            </>
          )}
          <Tooltip title={props.listening ? '聆听中…' : '语音输入'}>
            <Button type="text" size="small" danger={props.listening} icon={<AudioOutlined />} aria-label="语音输入" onClick={props.onVoice} />
          </Tooltip>
          <Select
            value={props.modelId || undefined}
            onChange={props.onModelChange}
            style={{ width: 190, fontSize: 12 }}
            size="small"
            // 只显示模型名，厂商与「默认」标记放到下拉项与悬浮提示里，避免底部工具条被截断
            showSearch
            optionFilterProp="search"
            options={modelGroups as any}
            optionRender={(o: any) => {
              const d = o?.data || {};
              const caps: string[] = d.caps || [];
              return (
                <div className="model-opt">
                  <span className="model-opt-name">{d.label}</span>
                  <span className="model-opt-meta">
                    {d.isDefault && <span className="model-badge model-badge-default">默认</span>}
                    {caps.includes('tools') && <span className="model-badge">工具</span>}
                    {caps.includes('vision') && <span className="model-badge">视觉</span>}
                    {d.ctx && <span className="model-ctx">{d.ctx}</span>}
                  </span>
                </div>
              );
            }}
            popupMatchSelectWidth={340}
            listHeight={288}
            placeholder={props.models.length ? '选择模型' : '暂无可用模型'}
            notFoundContent={
              <div className="model-empty">
                {props.models.length
                  ? '没有匹配的模型'
                  : '没有可用的对话模型，请管理员在「管理后台 → 模型配置」添加（向量 / 重排模型不会出现在这里）'}
              </div>
            }
          />
        </Space>
        <Tooltip title={props.busy ? '停止生成' : '发送'}>
          <Button
            type="primary"
            shape="circle"
            icon={props.busy ? <StopOutlined /> : <SendOutlined />}
            // 纯图标按钮：Tooltip 只在 hover 时可见，读屏与自动化需要 aria-label
            aria-label={props.busy ? '停止生成' : '发送'}
            onClick={props.busy ? props.onStop : props.onSend}
            disabled={props.readOnly || (!props.busy && !props.modelId && !skillPick)}
            className="composer-send"
          />
        </Tooltip>
      </div>
    </div>
  );
}
