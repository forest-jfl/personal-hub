# ---------- 构建阶段 ----------
FROM node:20-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ---------- 运行阶段 ----------
FROM node:20-alpine
ENV NODE_ENV=production
WORKDIR /app
# tzdata 不是给 Node 用的 —— Node 自带 ICU 时区库，认 TZ 环境变量、不需要它
# （实测：无 tzdata 时容器内 new Date().getHours() 仍取到北京时间）。
# 装它是为了 busybox 的 date 以及任何走 /usr/share/zoneinfo 的工具：
# 缺了它容器里 `date` 输出 UTC，而应用日志是北京时间 —— 排查问题时两个时间
# 基准并存，极易把正常的 8 小时差误判成故障。
RUN apk add --no-cache tzdata
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY schema.sql ./
COPY public ./public
# 上传目录归属 node 用户：named volume 首次初始化会拷贝镜像内目录（含属主），
# 否则卷以 root 属主创建，容器内 USER node 写入报 EACCES
RUN mkdir -p /app/uploads && chown -R node:node /app/uploads
ENV UPLOAD_DIR=/app/uploads
EXPOSE 3000
USER node
CMD ["node", "dist/server.js"]
