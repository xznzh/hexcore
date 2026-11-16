import { defineConfig } from 'vitest/config';

/**
 * 评测专用配置（`npm run eval`）。
 * 与 vitest.config.mts 分开的原因：评测要真调模型、耗时几分钟、结果有波动，
 * 绝不能混进 `npm run check` 的质量门禁里。EVAL_RUN 由 test.env 注入，
 * 测试文件用 describe.skipIf 兜底——即使有人误用默认配置跑它也会跳过。
 *
 * 唯一的交集是 `evals/judge.test.ts`（纯函数、确定性）：它既在这里跑（评测前的自检），
 * 也在默认配置里跑（`npm run check` 拦回归）。判定器坏了，评测结果就没有意义，
 * 所以它必须进两道门。
 */
export default defineConfig({
  resolve: {
    alias: { '@': import.meta.dirname },
  },
  test: {
    include: ['evals/**/*.test.ts'],
    environment: 'node',
    setupFiles: ['evals/setup-env.ts'],
    env: { EVAL_RUN: '1' },
    testTimeout: 900_000,
    hookTimeout: 60_000,
    fileParallelism: false,
  },
});
