# ---- 依赖层：单独抽出来，源码改动时可复用缓存 ----
FROM node:22-alpine AS base
# 不用 corepack：package.json 里没有 packageManager 字段，corepack 无法确定版本会直接报错
RUN npm i -g pnpm@10
WORKDIR /app

FROM base AS deps
COPY package.json pnpm-lock.yaml ./
# package.json 的 prepare 钩子会执行 scripts/setup-git-hooks.mjs。只拷两个清单文件时
# 这个文件还不存在，install 会以 MODULE_NOT_FOUND 失败、整个构建中止。
# 镜像内既无 .git 也无 git 命令，脚本自身会捕获后跳过，不会真的装钩子。
COPY scripts/setup-git-hooks.mjs ./scripts/
# --frozen-lockfile：锁文件与 package.json 不一致时直接失败，避免镜像里装出「和本地不一样」的依赖
RUN pnpm install --frozen-lockfile

# ---- 构建层 ----
FROM base AS builder
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
# next.config 里开了 output:'standalone'，构建产物自带最小运行时
RUN pnpm build

# ---- 运行层：只装运行时需要的东西，非 root ----
FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0

# 非 root 运行：即使应用被拿下，攻击者也拿不到容器内的 root
RUN addgroup -g 1001 -S nodejs && adduser -S nextjs -u 1001

COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
# public/ 不会被 standalone 自动带上：favicon、分享图、静态资源都在这里，
# 漏了这一行表现为「本地有图标、容器里 404」，且构建不会报错。
COPY --from=builder --chown=nextjs:nodejs /app/public ./public

# 运行时文件目录（上传件、生成的 docx/pptx）。必须挂持久卷，否则重建容器就丢。
RUN mkdir -p /app/data && chown -R nextjs:nodejs /app/data
VOLUME ["/app/data"]

USER nextjs
EXPOSE 3000

# 探针复用 V8.2 新增的匿名存活接口：不碰数据库，几毫秒返回，不依赖登录态
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
