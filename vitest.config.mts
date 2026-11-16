import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    // 文件后缀是 .mts：Vite 会把它当 ESM 加载（configLoader: 'native'），
    // ESM 里没有 __dirname，用 import.meta.dirname（Node ≥ 20.11）。
    alias: { '@': import.meta.dirname },
  },
  test: {
    // `evals/judge.test.ts` 与 `evals/adversarial.test.ts` 也进这里：两者都是纯函数，
    // 不碰网络和数据库，但它们决定「评测算不算数」——改坏了不该等到下一次 `npm run eval` 才发现。
    // （评测本体 evals/eval.test.ts、evals/adversarial-run.test.ts 仍然只在 eval 配置里跑。）
    include: ['tests/**/*.test.ts', 'evals/judge.test.ts', 'evals/adversarial.test.ts'],
    environment: 'node',
    // 并发上限压到 3：本机 6 核，跑 check 时往往还挂着 dev server 或其他任务，
    // 默认并发会偶发「Timeout waiting for worker to respond」——整个文件不执行、
    // 统计里只是少了几条，而 `npm run check | tail` 的退出码还是 0（管道吃掉），
    // 等于「校验绿的但没跑全」。宁可多花十几秒，也要结果确定。
    maxWorkers: 3,
    // worker 启动慢时给足余量，避免把「机器忙」判成「测试挂」。
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
});
