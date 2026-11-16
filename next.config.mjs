import bundleAnalyzer from '@next/bundle-analyzer';

/** @type {import('next').NextConfig} */
const nextConfig = {
  /**
   * 容器化部署：产出 `.next/standalone`（自带裁剪后的 node_modules 与 server.js）。
   * 镜像里只需要拷 standalone + static，不必装全量依赖，体积从 ~1GB 降到 200MB 级。
   * 不影响 `next start`（仍走常规 .next 产物）与 `next dev`。
   */
  output: 'standalone',

  /**
   * 产物目录，默认 `.next`（行为完全不变）。
   *
   * 存在的理由：`next dev` 与 `next build` 共用 `.next`，本机开着 dev server 时跑 build，
   * 二者会抢同一批文件，表现为 `EPERM: open '.next/trace'` 或构建产物残缺——
   * 看起来像代码坏了，其实是两个进程在同一个目录里写。
   * CI / Docker 里只有一个进程，用不到这个开关；
   * 本地想在 dev 开着的情况下验证构建时：`NEXT_DIST_DIR=.next-build npx next build`。
   */
  distDir: process.env.NEXT_DIST_DIR || '.next',
  eslint: { ignoreDuringBuilds: true },

  /**
   * 安全：关闭 Next 内置图片优化。
   *
   * 本项目全程未使用 `next/image`（只用原生 <img>），但 `/_next/image` 优化端点仍会被注册。
   * next 14.x 该端点存在未授权 RCE 类漏洞（已在 15.5.28 修复，本项目现运行于 15.5.28+）；
   * 保留 unoptimized 的理由变为「本项目用不到图片优化，不必承担 sharp 处理链的额外攻击面与内存开销」。
   * unoptimized 会让优化端点直接返回原图，不再走 sharp 处理链。
   *
   * 若将来启用 next/image，请改为配置 remotePatterns 白名单。
   */
  images: { unoptimized: true },
  // node-cron 内部使用绝对路径动态加载子进程守护脚本，需作为外部包交给 Node 运行时解析，
  // 否则 Turbopack 会报 “server relative imports are not implemented yet”。
  // mammoth（.docx 解析）同样含动态 require（fs / unzipper 等），作为外部包直连 Node 最稳；
  // 失败时 lib/ai/extract.ts 还有基于 jszip 的纯 JS 兜底。
  // Next 15 起该项从 experimental 提升为顶层 serverExternalPackages。
  // bullmq 5.x 内部按需 require 可选的 @valkey/valkey-glide（未安装时会告警但可运行），
  // 交给 Node 运行时解析可避免 webpack 在构建期尝试静态解析它。
  serverExternalPackages: ['node-cron', 'mammoth', 'bullmq'],
  experimental: {
    /**
     * 请求体上限（Next 15 新增，默认 10MB，键名在 experimental 下）。
     *
     * 默认值会静默截断超过 10MB 的请求体：`req.formData()` 拿到的是残包，
     * 解析失败后抛 TypeError → 表现为 500 而不是预期的 413。
     * 本项目 /api/files 允许单文件 100MB，必须放宽，否则大文件上传会直接 500。
     * 取值略高于业务上限，把"超限"判断留给业务层，保证返回结构化 413。
     */
    middlewareClientMaxBodySize: '110mb',
    // 客户端路由缓存：重复导航复用 RSC（页面数据是客户端取数，不会因此过期）
    // 注：15.5.x 中 staleTimes 仍位于 experimental 下（放到顶层会报 Unrecognized key）
    staleTimes: { dynamic: 30, static: 180 },
    // 按需导入：把 antd / 图标的 barrel 引入转成精确路径，显著减小每页 JS 包、加快开发编译
    optimizePackageImports: ['antd', '@ant-design/icons'],
  },

  /**
   * 安全响应头（全站生效）：
   * - frame-ancestors/X-Frame-Options：禁止被第三方页面内嵌（防点击劫持）；
   * - nosniff：阻止浏览器把 JSON/文本按可执行类型嗅探；
   * - Referrer-Policy：跨站只带 origin，避免路径里的分享 token 泄漏；
   * - CSP：限制脚本/样式/图片/接口的来源，收敛外部注入面。
   *
   * CSP 说明：Next 的内联启动脚本与 antd 运行时内联样式分别需要 script/style 的 'unsafe-inline'，
   * 因此这里不具备 nonce 级严格性；价值在于仍能阻止「加载外部脚本」「object 嵌入」「base 标签劫持」
   * 「表单外发」这几类高危路径。若将来接入 nonce 方案，可去掉 script-src 的 'unsafe-inline'。
   * Permissions-Policy 刻意不限制 microphone：对话页用了 Web Speech API 语音输入。
   */
  async headers() {
    // 开发态需要允许 HMR 的 WebSocket，生产态只放行同源
    const isDev = process.env.NODE_ENV !== 'production';
    const csp = [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob:",
      "font-src 'self' data:",
      "media-src 'self' blob:",
      isDev ? "connect-src 'self' ws: wss:" : "connect-src 'self'",
      "frame-src 'self'",
      "object-src 'none'",
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "form-action 'self'",
    ].join('; ');

    return [
      {
        source: '/:path*',
        headers: [
          { key: 'Content-Security-Policy', value: csp },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'Permissions-Policy', value: 'camera=(), geolocation=(), payment=(), usb=()' },
          { key: 'X-DNS-Prefetch-Control', value: 'off' },
        ],
      },
    ];
  },
};

/**
 * 包体积分析：`pnpm analyze` 会以 ANALYZE=true 触发，构建完成后输出可视化报告。
 * enabled=false 时是恒等包装，不影响正常构建。
 */
const withBundleAnalyzer = bundleAnalyzer({ enabled: process.env.ANALYZE === 'true' });

export default withBundleAnalyzer(nextConfig);
