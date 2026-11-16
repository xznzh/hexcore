'use client';

// React 19 移除了 ReactDOM.render / unmountComponentAtNode 等 legacy API，
// antd 5.x 内部的 message/notification/Modal 静态方法仍依赖它们。
// 官方补丁包把 antd 的静态方法桥接到 React 19 的 createRoot，必须在任何 antd 使用前引入。
import '@ant-design/v5-patch-for-react-19';
import { AntdRegistry } from '@ant-design/nextjs-registry';
import ThemeProvider from './ThemeProvider';

export default function Providers({ children }: { children: React.ReactNode }) {
  return (
    <AntdRegistry>
      <ThemeProvider>{children}</ThemeProvider>
    </AntdRegistry>
  );
}
