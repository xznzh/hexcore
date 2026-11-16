// 对话模块共享类型：从 Chat.tsx 原地抽出，供 Composer / Markdown 等子组件复用
// caps / contextLength 由 /api/models 返回（可选，兼容旧缓存），用于下拉里展示「工具/视觉/上下文」
export type ModelOption = {
  id: string;
  name: string;
  provider: string;
  isDefault: boolean;
  caps?: string[];
  contextLength?: number;
};
export type Conv = { id: string; title: string; pinned: boolean; createdAt: number; projectId: string | null; isOwner?: boolean; ownerName?: string | null };
export type Project = { id: string; name: string };
export type Skill = { id: string; name: string; description: string | null; scope: string; steps: any[] };
export type Attached = { id: string; filename: string };
export type CapMention = { id: string; name: string };
export type TraceItem = { type: string; name?: string; args?: any; result?: string };
export type Msg = {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  sources?: string[];
  trace?: TraceItem[];
  meta?: { caps?: { id: string; name: string }[] } | null;
  reasoning?: string;
  feedback?: 'up' | 'down' | null;
  createdAt?: number;
};
