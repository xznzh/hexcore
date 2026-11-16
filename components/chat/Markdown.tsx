'use client';

import { memo, useEffect, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { highlightCode } from '@/lib/highlight';

function CodeBlock({ className, children }: { className?: string; children?: React.ReactNode }) {
  const text = String(children ?? '').replace(/\n$/, '');
  const lang = /language-([\w-]+)/.exec(className || '')?.[1];
  const [html, setHtml] = useState('');
  useEffect(() => {
    let alive = true;
    if (!lang) {
      setHtml('');
      return;
    }
    highlightCode(text, lang).then((h) => {
      if (alive) setHtml(h);
    });
    return () => {
      alive = false;
    };
  }, [text, lang]);
  if (html) return <code className={className} dangerouslySetInnerHTML={{ __html: html }} />;
  return <code className={className}>{children}</code>;
}

/** 助手消息 Markdown 渲染（GFM 表格 + 代码高亮），从 Chat.tsx 原地抽出。
 * memo 化：content 不变则整个 ReactMarkdown 解析不重跑——这是流式期间其余消息不掉帧的关键。 */
export const Markdown = memo(function Markdown({ content }: { content: string }) {
  return (
    <div className="md">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ node, ...props }) => <a {...props} target="_blank" rel="noreferrer" />,
          code: ({ node, ...props }: any) => <CodeBlock {...props} />,
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
});

export function fmtTime(ts?: number) {
  if (!ts) return '';
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
}
