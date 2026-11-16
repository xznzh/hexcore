'use client';

import { createContext, useContext } from 'react';
import type { Me } from './Nav';

const Ctx = createContext<Me | null>(null);

export function SessionProvider({ me, children }: { me: Me | null; children: React.ReactNode }) {
  return <Ctx.Provider value={me}>{children}</Ctx.Provider>;
}

/** 读取当前登录用户（由根 layout 通过 AppShell 注入，全程零请求） */
export function useMe(): Me | null {
  return useContext(Ctx);
}

/** 是否访客（只读角色）：用于隐藏/禁用写操作入口，与后端 403 双保险 */
export function useGuest(): boolean {
  const me = useMe();
  return me?.role === 'guest';
}
