FROM node:22-alpine

# 系统依赖（python3 供部分 CLI 使用，git 供 codex/opencode 操作仓库）
RUN apk add --no-cache python3 py3-pip git curl bash

WORKDIR /app

# 安装后端依赖
COPY package.json ./
RUN npm install

# 预装 AI CLI 工具
RUN npm install -g \
    @anthropic-ai/claude-code \
    @google/gemini-cli \
    @openai/codex \
    opencode-ai

COPY src ./src

EXPOSE 8700 8701
CMD ["node", "src/index.js"]
