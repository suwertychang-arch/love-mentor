FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN npm install --production

COPY . .

# 默认使用 DeepSeek，API Key 通过环境变量注入
ENV AI_BASE_URL=https://api.deepseek.com/v1
ENV AI_MODEL=deepseek-chat

EXPOSE 3000

CMD ["node", "server.js"]
