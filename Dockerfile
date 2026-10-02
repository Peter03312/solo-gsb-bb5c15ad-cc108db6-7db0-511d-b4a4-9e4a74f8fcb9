FROM node:20-bookworm-slim

# better-sqlite3 使用预编译二进制；保留构建工具以应对无预编译包的平台
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --omit=dev

COPY src ./src
COPY public ./public

ENV NODE_ENV=production
ENV PORT=3000
ENV DB_PATH=/data/app.db

# 数据卷存放 SQLite 文件，首次启动自动建表并写入种子数据
RUN mkdir -p /data
VOLUME ["/data"]

EXPOSE 3000

# 也可先单独运行 init-db；server 启动时本身也会自动初始化
CMD ["node", "src/server.js"]
