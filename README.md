<div align="center">

<h1>openclaw-cli-auto</h1>

**将 AI CLI 工具封装为通用任务调度服务**

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node](https://img.shields.io/badge/Node.js-18%2B-green)](https://nodejs.org)
[![Docker](https://img.shields.io/badge/Docker-ready-blue)](docker-compose.yml)

**[中文](#chinese) | [English](#english)**

</div>

---
<a name="chinese"></a>
## 中文

### 项目简介

`openclaw-cli-auto` 是一个后端服务，将外部客户端（如 OpenClaw）与本地 AI CLI 工具（Claude、Gemini、Codex、OpenCode）通过 task/session 编排连接起来。

- 接收外部客户端的 task/session 创建请求
- 管理本地 AI CLI 进程的生命周期
- 自动回收中断超时任务，分阶段清理内存
- 持久化 session ID，服务重启后可恢复对话
- 提供 React 前端面板用于监控和操作

### 系统架构

```
外部客户端（OpenClaw 等）
        │  REST / WebSocket
        ▼
┌─────────────────────────────┐
│      后端  :8700/:8701      │
│  TaskOrchestrator           │
│  ├─ ClaudeJsonClient        │
│  ├─ GeminiPromptClient      │
│  ├─ CodexStructuredClient   │
│  └─ OpenCodeRunClient       │
└─────────────────────────────┘
        │
        ▼
   前端面板  :5120 (nginx)
```

### Task 生命周期

```
running ──► completed ──── 15分钟 ──► terminated（清理大字段）──── 5小时 ──► 内存删除
running ──► failed    ──── 15分钟 ──► terminated              ──── 5小时 ──► 内存删除
running ──► waiting_input ── 8小时 ──► terminated             ──── 5小时 ──► 内存删除
任意已结束状态 ──── DELETE /tasks/:id ──► 立即删除
```

### Session 恢复

session 映射持久化到 `.workspaces/` 目录，重启后用同一 `sessionKey` 自动恢复对话：

| CLI | 恢复参数 |
|-----|---------|
| claude | `--resume <sessionId>` |
| gemini | `--resume <sessionId>` |
| opencode | `--session <sessionId>` |
| codex | `thread/resume` RPC |

### 快速开始

#### 方案 A — 宿主机版本（复用已安装的 CLI）

```bash
cp .env.example .env
# 填入 OPENCLAW_GATEWAY_TOKEN
docker compose -f docker-compose.host.yml up -d
```

#### 方案 B — 新环境版本（容器内安装 CLI + 自动更新）

```bash
cp .env.example .env
# 填入 OPENCLAW_GATEWAY_TOKEN
docker compose -f docker-compose.full.yml up -d
# 首次启动后进入容器完成 CLI 登录认证
docker compose -f docker-compose.full.yml exec backend sh
# claude auth login / gemini auth login ...
```

#### 本地开发（不用 Docker）

```bash
cp .env.example .env
npm install
npm run dev:backend   # 后端 :8700/:8701
npm run dev:frontend  # 前端 :5120
```

### API 接口

| 方法 | 路径 | 说明 |
|------|------|------|
| `POST` | `/tasks` | 创建并提交任务 |
| `GET` | `/tasks` | 列出所有任务 |
| `GET` | `/tasks/:id` | 查询任务详情 |
| `POST` | `/tasks/:id/input` | 发送后续消息 |
| `POST` | `/tasks/:id/terminate` | 终止任务 |
| `DELETE` | `/tasks/:id` | 从内存删除已结束任务 |
| `GET` | `/tasks/stats` | 任务统计 |
| `POST` | `/sessions` | 创建 session |
| `GET` | `/sessions/:id/history` | 查询对话历史 |

### 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `OPENCLAW_CLIENT_MODE` | `acpx` | 客户端模式：`openclaw` 或 `acpx` |
| `OPENCLAW_BASE_URL` | `http://127.0.0.1:18789` | Gateway 地址 |
| `OPENCLAW_GATEWAY_TOKEN` | — | Gateway 认证 token |
| `AUTOCLI_BASE_URL` | `http://127.0.0.1:8700` | autocli 技能调用的后端地址 |
| `OPENCLAW_TASK_RETENTION_MS` | `900000` | completed/failed 保留时长（15分钟） |
| `OPENCLAW_TERMINATED_RETENTION_MS` | `18000000` | terminated 保留时长（5小时） |
| `OPENCLAW_INTERRUPT_TTL_MS` | `28800000` | waiting_input 超时时长（8小时） |

### autocli 技能

`skills/autocli/` 技能包让 OpenClaw AI 可以直接操作后端：

```bash
# 创建任务
autocli-create --prompt "你的提示词" --session-type claude

# 查询状态
autocli-status --id <task-id>

# 继续对话
curl -X POST http://127.0.0.1:8700/tasks/<id>/input \
  -H 'content-type: application/json' \
  -d '{"message":"继续"}'

# 删除已完成任务
curl -X DELETE http://127.0.0.1:8700/tasks/<id>
```

### 开发计划

- [ ] **前端页面优化** — 任务详情优化、日志流式展示、主题切换
- [ ] **CLI Token 统计** — 解析各 CLI JSON 输出中的 input/output token 用量
- [ ] **CLI 模型切换** — 支持按任务指定模型（如 `claude-opus-4`、`gemini-2.5-pro`）
- [ ] **任务列表配置** — 自定义列、排序、持久化筛选偏好
- [ ] **任务队列优先级** — 支持高/普通/低优先级调度

---

---

<a name="english"></a>
## English

### Overview

`openclaw-cli-auto` provides a backend HTTP + WebSocket service that:

- Accepts task/session creation requests from external clients (e.g. OpenClaw)
- Spawns and manages local AI CLI processes (Claude, Gemini, Codex, OpenCode)
- Tracks task lifecycle, handles interrupts, and auto-recycles stale tasks
- Persists session IDs so conversations can be **resumed** after restart
- **Async task execution** — returns 202 immediately, callbacks to origin session on completion
- **Task registry persistence** — tasks survive restarts, queued/submitted tasks auto-recovered
- **Auto-retry on failure** — failed tasks retry up to `maxRetry` times (default 3) automatically
- **Git Worktree isolation** — each code task runs in an isolated branch/worktree (opt-in)
- **Periodic monitor** — detects timed-out tasks every 10 min and triggers retry
- Serves a React frontend dashboard for monitoring and control

### Architecture

```
External Client (OpenClaw, etc.)
        │  REST / WebSocket
        ▼
┌─────────────────────────────────────┐
│      Backend  :8700/:8701           │
│  TaskOrchestrator                   │
│  ├─ ClaudeJsonClient                │
│  ├─ GeminiPromptClient              │
│  ├─ CodexStructuredClient           │
│  ├─ OpenCodeRunClient               │
│  ├─ TaskStore (~/.autocli/.tasks/)  │
│  └─ SessionStore (~/.autocli/)      │
└─────────────────────────────────────┘
        │
        ▼
   Frontend  :5120 (nginx)
```

### Task Lifecycle

```
running ──► completed ──── 15 min ──► terminated (fields trimmed) ──── 5 h ──► removed
running ──► failed    ──── 15 min ──► terminated                  ──── 5 h ──► removed
running ──► waiting_input ── 8 h ──► terminated                   ──── 5 h ──► removed
any finished state ──── DELETE /tasks/:id ──► removed immediately
```

### Session Resume

Session mappings are persisted to `~/.autocli/` so conversations survive restarts:

| CLI | Resume flag | Store file |
|-----|-------------|------------|
| claude | `--resume <sessionId>` | `~/.autocli/.claude-sessions.json` |
| gemini | `--resume <sessionId>` | `~/.autocli/.gemini-sessions.json` |
| opencode | `--session <sessionId>` | `~/.autocli/.opencode-sessions.json` |
| codex | `thread/resume` RPC | `~/.autocli/.codex-sessions.json` |

Conversation history (role/content) is also persisted per session at `~/.autocli/.sessions/<sessionId>.json`.

### Quick Start

#### Option A — Host machine (reuse installed CLIs)

```bash
cp .env.example .env
# Fill in OPENCLAW_GATEWAY_TOKEN
docker compose -f docker-compose.host.yml up -d
```

#### Option B — Fresh environment (install CLIs inside container + auto-update)

```bash
cp .env.example .env
# Fill in OPENCLAW_GATEWAY_TOKEN
docker compose -f docker-compose.full.yml up -d
# First run: authenticate CLIs inside the container
docker compose -f docker-compose.full.yml exec backend sh
# claude auth login / gemini auth login ...
```

#### Local dev (no Docker)

```bash
cp .env.example .env
npm install
npm run dev:backend   # backend on :8700/:8701
npm run dev:frontend  # frontend on :5120
```

### API Reference

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/tasks` | Create & submit a task |
| `GET` | `/tasks` | List all tasks |
| `GET` | `/tasks/:id` | Get task detail |
| `POST` | `/tasks/:id/input` | Send follow-up message |
| `POST` | `/tasks/:id/terminate` | Terminate a task |
| `DELETE` | `/tasks/:id` | Remove finished task from memory |
| `GET` | `/tasks/stats` | Task statistics |
| `POST` | `/sessions` | Create a session |
| `GET` | `/sessions/:id/history` | Session conversation history |

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `OPENCLAW_CLIENT_MODE` | `acpx` | `openclaw` or `acpx` |
| `OPENCLAW_BASE_URL` | `http://127.0.0.1:18789` | Gateway URL |
| `OPENCLAW_GATEWAY_TOKEN` | — | Gateway auth token |
| `AUTOCLI_BASE_URL` | `http://127.0.0.1:8700` | Backend URL for autocli skill |
| `AUTOCLI_WORKSPACE_ROOT` | `~/.autocli` | Root directory for all persistent data |
| `AUTOCLI_PROJECT_NAME` | current dir name | Project name, workspace path: `$ROOT/$PROJECT_NAME` |
| `AUTOCLI_GIT_ROOT` | `process.cwd()` | Git repo root for worktree isolation |
| `AUTOCLI_USE_WORKTREE` | `0` | Set to `1` to enable git worktree isolation by default |
| `AUTOCLI_MONITOR_INTERVAL_MS` | `600000` | Task monitor interval (10 min) |
| `AUTOCLI_TASK_TIMEOUT_MS` | `1800000` | Task timeout before auto-fail (30 min) |
| `OPENCLAW_TASK_RETENTION_MS` | `900000` | completed/failed retention (15 min) |
| `OPENCLAW_TERMINATED_RETENTION_MS` | `18000000` | terminated retention (5 h) |
| `OPENCLAW_INTERRUPT_TTL_MS` | `28800000` | waiting_input timeout (8 h) |

### autocli Skill

The `skills/autocli/` package lets OpenClaw AI operate the backend directly:

```bash
# Create a task
autocli-create --prompt "your prompt" --session-type claude

# Check status
autocli-status --id <task-id>

# Continue conversation
curl -X POST http://127.0.0.1:8700/tasks/<id>/input \
  -H 'content-type: application/json' \
  -d '{"message":"follow-up"}'

# Dismiss finished task
curl -X DELETE http://127.0.0.1:8700/tasks/<id>
```

### Roadmap

- [ ] **Frontend UI improvements** — better task detail view, log streaming, dark/light theme
- [ ] **CLI token usage tracking** — parse input/output tokens from each CLI's JSON output
- [ ] **CLI model switching** — per-task model selection (e.g. `claude-opus-4`, `gemini-2.5-pro`)
- [ ] **Task list configuration** — custom columns, sorting, persistent filter preferences
- [ ] **Task queue priority** — priority levels for task scheduling (high / normal / low)


<div align="center">
<sub>MIT License</sub>
</div>
