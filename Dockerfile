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
