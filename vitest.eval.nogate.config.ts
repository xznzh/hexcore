import { defineConfig } from 'vitest/config';
import path from 'path';

/**
 * 对照实验配置（`npm run eval:nogate`）：关掉相关度闸门，其它完全一样。
 *
 * 为什么要跑这一组：闸门（`filterRelevantHits`）的价值只有对比才看得出来——
 * 打开时 10 条「知识库里没有」的问题应该老实说不知道，关掉后会变成「总能召回到点什么」，
 * 于是模型开始基于无关片段编答案。**一次回归对比比读十遍注释更有说服力。**
 */
export default defineConfig({
  resolve: {
    alias: { '@': path.resolve(__dirname, '.') },
  },
  test: {
    include: ['evals/**/*.test.ts'],
    environment: 'node',
    setupFiles: ['evals/setup-env.ts'],
    env: { EVAL_RUN: '1', EVAL_NO_GATE: '1' },
    testTimeout: 900_000,
    hookTimeout: 60_000,
    fileParallelism: false,
  },
});
