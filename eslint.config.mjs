import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FlatCompat } from '@eslint/eslintrc';

/**
 * ESLint 9 平铺配置（flat config）。
 *
 * 为什么需要 FlatCompat：`eslint-config-next` 15.x 仍只提供传统（eslintrc 形态）
 * 的共享配置，没有 flat 入口。用官方兼容层桥接，等 Next 提供 flat 配置后可整段删掉。
 *
 * 规则取舍：只把「会真出错」的规则设为 error（React Hook 调用顺序、列表 key、
 * Next 页面约定等），样式类规则全部关闭。理由是仓库已有 220 个源文件，
 * 一次性引入全量规则只会得到上千条与业务无关的告警，最后没人看，
 * 等于没有 lint。目标是「新增代码不能引入确定性 bug」，不是统一代码风格。
 */
const compat = new FlatCompat({
  baseDirectory: dirname(fileURLToPath(import.meta.url)),
});

const config = [
  {
    ignores: [
      'node_modules/**',
      // 用通配而不是逐个列举：本项目支持 `NEXT_DIST_DIR` 指定构建目录
      // （本地想在 dev 开着的情况下验证构建时就会这么做），
      // 硬编码 '.next' / '.next-build' 会让 `.next-anything` 这类目录漏网，
      // 结果 lint 去扫 webpack 产物、报一堆与源码无关的 `no-assign-module-variable`。
      '.next*/**',
      'data/**',
      'public/**',
      'app/fonts/**',
      'evals/reports/**',
      'playwright-report/**',
      'test-results/**',
    ],
  },
  ...compat.extends('next/core-web-vitals'),
  {
    rules: {
      // 与严格模式无关的风格类规则，关闭避免噪音
      'no-unused-vars': 'off',
      'prefer-const': 'off',
      'react/no-unescaped-entities': 'off',
      // 本项目统一用原生 <img>（见 next.config.mjs 的 images.unoptimized 说明）
      '@next/next/no-img-element': 'off',
      '@next/next/no-html-link-for-pages': 'off',
      // 依赖数组缺失只提示不阻断：这些位置多是「有意只跑一次」的初始化逻辑
      'react-hooks/exhaustive-deps': 'warn',
    },
  },
];

export default config;
