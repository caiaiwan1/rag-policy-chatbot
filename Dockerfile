# RAG Agent Studio —— 生产镜像（多阶段，尽量精简）
FROM node:18-alpine AS build

WORKDIR /app

# 仅先拷贝依赖清单，利用层缓存
COPY package.json package-lock.json ./
RUN npm install --omit=dev

# 拷贝源码
COPY . .

# 运行阶段
FROM node:18-alpine
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=5178

# 复制已安装依赖与源码
COPY --from=build /app /app

# 数据目录（配置 / 上传文档 / 向量索引）通过卷持久化
RUN mkdir -p /app/data/uploads
VOLUME ["/app/data"]

EXPOSE 5178
CMD ["node", "server.js"]
