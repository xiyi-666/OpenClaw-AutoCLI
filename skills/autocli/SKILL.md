---
name: autocli
description: Force task execution through backend HTTP APIs (/tasks) instead of direct acpx runtime.
---

# autocli-backend skill package

This package provides backend task operations with command prefix `autocli-`.

## Critical Routing Rule

- Always start and continue tasks via backend APIs (`http://127.0.0.1:8700` by default).
- Do **not** start work with direct `acpx codex ...` commands in this skill.
- One backend task should map to one session key (`metadata.sessionKey`) for multi-turn continuity.

## Commands

- `autocli-create` - create and submit a task
- `autocli-list` - list tasks (supports status and limit filters)
- `autocli-status` - query task status (single task or list)
- `autocli-stop` - terminate a running task
- `autocli-dismiss` - remove a completed/failed/terminated task from memory
- `autocli-stats` - show task statistics
- `curl POST /tasks/:id/input` - continue a running task with follow-up turns

## Environment

- `AUTOCLI_BASE_URL` (optional, default `http://127.0.0.1:8700`)
- `AUTOCLI_TIMEOUT` (optional, default `15`/`30` seconds depending on command)

## Usage

```bash
# 创建任务
autocli-create --id task-001 --prompt "reply READY" --session-type codex

# 查询状态
autocli-status --id task-001

# 继续对话
curl -sS -X POST http://127.0.0.1:8700/tasks/task-001/input \
  -H 'content-type: application/json' \
  -d '{"message":"continue and summarize progress"}'

# 终止任务
autocli-stop --id task-001

# 主动从内存删除（仅限 completed/failed/terminated）
curl -sS -X DELETE http://127.0.0.1:8700/tasks/task-001
```

## Task lifecycle

```
running → completed  ──── 15min ──→ terminated (大字段清理) ──── 5h ──→ 内存删除
running → failed     ──── 15min ──→ terminated               ──── 5h ──→ 内存删除
running → waiting_input ── 8h ──→ terminated                 ──── 5h ──→ 内存删除
任意已结束状态  ──── DELETE /tasks/:id ──→ 立即删除
```

## Session resume

后端自动持久化各 CLI 的 session 映射到 `.workspaces/` 目录，服务重启后用同一 `sessionKey` 发消息会自动 resume：

| CLI | resume 命令 |
|-----|------------|
| claude | `--resume <sessionId>` |
| gemini | `--resume <sessionId>` |
| opencode | `--session <sessionId>` |
| codex | `thread/resume` RPC |

## OpenClaw Control UI startup flow (recommended)

1. Ensure backend is alive (`GET /health` is `ok: true`).
2. Submit task via backend `/tasks` and set `metadata.sessionKey` to the OpenClaw chat session key.
3. Continue turns with `/tasks/:id/input` (field name must be `message`).
4. Check completion in:
   - `GET /tasks/:id`
   - `GET /sessions/<sessionId>/history`

## Backend endpoints used

- `POST /tasks`
- `GET /tasks`
- `GET /tasks/:id`
- `POST /tasks/:id/input`
- `POST /tasks/:id/terminate`
- `DELETE /tasks/:id`
- `GET /tasks/stats`

## Docker deployment

```bash
cp .env.example .env
# 编辑 .env 填入 OPENCLAW_GATEWAY_TOKEN
docker compose up -d
```

访问 `http://localhost:5120` 打开前端界面。
