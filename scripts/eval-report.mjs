/**
 * 只出报告、不跑门禁断言的评测入口（探索性调参时用）。
 *
 * 为什么需要单独一个脚本：`evals/eval.test.ts` 里的门禁断言读 `EVAL_NO_ASSERT`，
 * 而 npm script 在 Windows 用 cmd、在 CI 用 sh，写 `EVAL_NO_ASSERT=1 vitest ...`
 * 只能在其中一边生效。用 node 统一注入环境变量，跨平台不需要额外依赖（cross-env）。
 */
import { spawnSync } from 'node:child_process';

const r = spawnSync('npx', ['vitest', 'run', '--config', 'vitest.eval.config.mts'], {
  stdio: 'inherit',
  env: { ...process.env, EVAL_NO_ASSERT: '1' },
  // Windows 下 npx 是 npx.cmd，需要经 shell 解析；shell 同时兼容 sh
  shell: true,
});

process.exit(r.status ?? 1);
