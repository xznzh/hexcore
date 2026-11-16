'use client';

import { memo, useEffect, useRef, useState } from 'react';
import { Button, Collapse, Dropdown, Tooltip, Tag } from 'antd';
import {
  CopyOutlined,
  ReloadOutlined,
  LikeOutlined,
  DislikeOutlined,
  EditOutlined,
  FileWordOutlined,
  FilePptOutlined,
  ThunderboltOutlined,
  CheckCircleOutlined,
  SoundOutlined,
  BulbOutlined,
  ToolOutlined,
  FileTextOutlined,
  ApartmentOutlined,
} from '@ant-design/icons';
import { Markdown, fmtTime } from './Markdown';
import type { TraceItem, Msg } from './types';

/** 一条消息的动作句柄。由 Chat.tsx 以稳定引用传入（内部转发到 ref 里的最新实现），
 * 保证 MessageItem 的 memo 不被打穿：只有变化的那条消息重渲染。 */
export type MsgActions = {
  copy: (text: string) => void;
  retry: (m: Msg) => void;
  feedback: (m: Msg, rating: 'up' | 'down') => void;
  toDoc: (kind: 'doc' | 'ppt', content: string, format?: 'docx' | 'md' | 'txt') => void;
  saveSkill: (content: string) => void;
  todo: (m: Msg) => void;
  speak: (text: string) => void;
  edit: (m: Msg) => void;
};

/** 老消息懒渲染：先出纯文本（同步极便宜），进入视口（含预载区）再切换为 Markdown。 */
function LazyMarkdown({ content, lazy }: { content: string; lazy: boolean }) {
  const [rich, setRich] = useState(!lazy);
  const holderRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (rich) return;
    const node = holderRef.current;
    if (!node || typeof IntersectionObserver === 'undefined') {
      setRich(true);
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setRich(true);
          io.disconnect();
        }
      },
      { rootMargin: '900px 0px' },
    );
    io.observe(node);
    return () => io.disconnect();
  }, [rich]);
  if (rich) return <Markdown content={content} />;
  return (
    <div ref={holderRef} className="md" style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
      {content}
    </div>
  );
}

/** 单条消息气泡（从 Chat.tsx 原地抽出，纯搬家不改逻辑）。memo 化：渲染性能的关键。 */
export const MessageItem = memo(function MessageItem({
  m,
  busy,
  isGuest,
  readOnly,
  lazy,
  actions,
  setRef,
}: {
  m: Msg;
  busy: boolean;
  isGuest: boolean;
  readOnly: boolean;
  lazy: boolean;
  actions: MsgActions;
  setRef: (id: string, el: HTMLDivElement | null) => void;
}) {
  const trace: TraceItem[] = m.trace || [];
  const sources = m.sources || [];
  // 用户消息里可能残留旧版 @cap:<id>:<name> 标记（历史数据 / 手工输入），显示前统一剥掉
  const userText = (m.content || '').replace(/@cap:[\w-]+(?::[^ @]*)?/g, '').replace(/\s{2,}/g, ' ').trim();
  const caps = m.role === 'user' ? m.meta?.caps || [] : [];
  // 失败回答用「警告气泡」渲染：此前错误与正常回答长得一模一样，用户分不清
  // 「模型答得差」和「模型根本没连上」。判定口径与服务端一致——正文以 ⚠️ 起头。
  const isError = m.role === 'assistant' && /^\s*⚠️/.test(m.content || '');
  return (
    <div
      ref={(el) => setRef(m.id, el)}
      className={`msg ${m.role}`}
    >
      <div className={`msg-avatar ${m.role}`}>
        {m.role === 'user' ? <UserGlyph /> : <ThunderboltOutlined />}
      </div>
      <div className="msg-body">
        <div className="msg-head">
          <span className="msg-name">{m.role === 'user' ? '我' : 'AI 助手'}</span>
          <span className="msg-time">{fmtTime(m.createdAt)}</span>
        </div>
        <div className={`chat-bubble ${m.role}${isError ? ' err' : ''}`}>
          {caps.length > 0 && (
            <div className="msg-caps">
              {caps.map((c) => (
                <Tag key={c.id} color="blue" style={{ margin: 0, fontSize: 11, lineHeight: '18px' }}>
                  <ApartmentOutlined style={{ marginRight: 4 }} />
                  能力：{c.name}
                </Tag>
              ))}
            </div>
          )}
          {m.role === 'assistant' ? (
            m.content ? (
              <LazyMarkdown content={m.content} lazy={lazy} />
            ) : busy ? (
              <span className="thinking">
                <span className="typing" /> 正在思考…
              </span>
            ) : null
          ) : (
            <span style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
              {userText || (caps.length ? '（已关联能力）' : m.content)}
            </span>
          )}
        </div>

        <div className="msg-actions">
          <Tooltip title="复制">
            <Button type="text" size="small" icon={<CopyOutlined />} aria-label="复制内容" onClick={() => actions.copy(m.content)} />
          </Tooltip>
          <Tooltip title="重新生成">
            <Button type="text" size="small" icon={<ReloadOutlined />} aria-label="重新生成" onClick={() => actions.retry(m)} />
          </Tooltip>
          {m.role === 'user' && !readOnly && !isGuest && !m.id.startsWith('tmp') && (
            <Tooltip title="编辑并重发（其后消息将被替换）">
              <Button type="text" size="small" icon={<EditOutlined />} aria-label="编辑消息" onClick={() => actions.edit(m)} />
            </Tooltip>
          )}
          {m.role === 'assistant' && (
            <>
              {!isError && (
                <>
                  <Tooltip title="有用">
                    <Button
                      type="text"
                      size="small"
                      icon={<LikeOutlined />} aria-label="点赞"
                      style={{ color: m.feedback === 'up' ? 'var(--accent)' : undefined }}
                      onClick={() => actions.feedback(m, 'up')}
                    />
                  </Tooltip>
                  <Tooltip title="没帮助">
                    <Button
                      type="text"
                      size="small"
                      icon={<DislikeOutlined />} aria-label="点踩"
                      style={{ color: m.feedback === 'down' ? 'var(--danger)' : undefined }}
                      onClick={() => actions.feedback(m, 'down')}
                    />
                  </Tooltip>
                </>
              )}
              {!isGuest && !isError && (
                <>
                  <Dropdown
                    trigger={['click']}
                    menu={{
                      items: [
                        { key: 'docx', label: 'Word 文档（.docx）' },
                        { key: 'md', label: 'Markdown（.md）' },
                        { key: 'txt', label: '纯文本（.txt）' },
                      ],
                      onClick: ({ key }) => actions.toDoc('doc', m.content, key as 'docx' | 'md' | 'txt'),
                    }}
                  >
                    <Tooltip title="转文档（可选导出格式）">
                      <Button type="text" size="small" icon={<FileWordOutlined />} aria-label="转文档" />
                    </Tooltip>
                  </Dropdown>
                  <Tooltip title="转 PPT（AI 自动配色）">
                    <Button type="text" size="small" icon={<FilePptOutlined />} aria-label="转 PPT" onClick={() => actions.toDoc('ppt', m.content)} />
                  </Tooltip>
                  <Tooltip title="存为技能">
                    <Button type="text" size="small" icon={<ThunderboltOutlined />} aria-label="保存为技能" onClick={() => actions.saveSkill(m.content)} />
                  </Tooltip>
                  <Tooltip title="加入待办（去工作台处理）">
                    <Button type="text" size="small" icon={<CheckCircleOutlined />} aria-label="加入待办" onClick={() => actions.todo(m)} />
                  </Tooltip>
                </>
              )}
              {!isError && (
                <Tooltip title="语音播报">
                  <Button type="text" size="small" icon={<SoundOutlined />} aria-label="朗读" onClick={() => actions.speak(m.content)} />
                </Tooltip>
              )}
            </>
          )}
        </div>

        {m.role === 'assistant' && m.reasoning && (
          <div style={{ marginTop: 6 }}>
            <Collapse
              size="small"
              ghost
              items={[
                {
                  key: 'reasoning',
                  label: (
                    <span style={{ fontSize: 12, color: 'var(--muted)' }}>
                      <BulbOutlined style={{ marginRight: 6 }} />
                      思考过程
                    </span>
                  ),
                  children: <div className="trace-result">{m.reasoning}</div>,
                },
              ]}
            />
          </div>
        )}

        {m.role === 'assistant' && trace.length > 0 && (
          <div style={{ marginTop: 6 }}>
            <Collapse
              size="small"
              ghost
              items={[
                {
                  key: 'trace',
                  label: (
                    <span style={{ fontSize: 12, color: 'var(--muted)' }}>
                      <ToolOutlined style={{ marginRight: 6 }} />
                      工具调用轨迹（{trace.filter((t) => t.type === 'tool_call').length}）
                    </span>
                  ),
                  children: (
                    <div className="trace-list">
                      {trace.map((t, i) => (
                        <div key={i} className="trace-item">
                          {t.type === 'cache' && <Tag color="gold">语义缓存命中</Tag>}
                          {t.type === 'tool_call' && (
                            <>
                              <Tag color="blue">{t.name}</Tag>
                              <span className="trace-args">{JSON.stringify(t.args)}</span>
                            </>
                          )}
                          {t.type === 'tool_result' && (
                            <>
                              <Tag>结果</Tag>
                              <pre className="trace-result">{t.result}</pre>
                            </>
                          )}
                        </div>
                      ))}
                    </div>
                  ),
                },
              ]}
            />
          </div>
        )}

        {m.role === 'assistant' && m.content && sources.length > 0 && !isError && (
          <div className="refs">
            <FileTextOutlined style={{ color: 'var(--muted)', fontSize: 12 }} />
            {sources.map((s, i) => (
              <span key={i} className="ref-chip" title={s}>
                {i + 1}. {s}
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
});

function UserGlyph() {
  return <span style={{ fontSize: 13, fontWeight: 700 }}>我</span>;
}
