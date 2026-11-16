import Chat from '@/components/Chat';
import { Suspense } from 'react';
import { Skeleton } from 'antd';

export default function ChatPage() {
  return (
    <Suspense
      fallback={
        <div style={{ padding: 24, maxWidth: 820, margin: '0 auto' }}>
          <Skeleton active paragraph={{ rows: 6 }} />
        </div>
      }
    >
      <Chat />
    </Suspense>
  );
}
