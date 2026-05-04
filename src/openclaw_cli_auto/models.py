from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from typing import Any


class AgentKind(str, Enum):
    CLAUDE = "claude-code"
    CODEX = "codex-cli"
    GEMINI = "gemini-cli"
    TEST = "test-agent"
    QA = "qa-agent"


class TaskStatus(str, Enum):
    PENDING = "pending"
    RUNNING = "running"
    BLOCKED = "blocked"
    FAILED = "failed"
    COMPLETED = "completed"


@dataclass(slots=True)
class Task:
    id: str
    title: str
    phase: str
    depends_on: list[str] = field(default_factory=list)
    status: TaskStatus = TaskStatus.PENDING
    attempts: int = 0
    metadata: dict[str, Any] = field(default_factory=dict)


@dataclass(slots=True)
class Session:
    session_id: str
    kind: AgentKind
    checkpoint: str = "step_0"
    token_used: int = 0
    token_limit: int = 100_000
    running: bool = False
    last_message: str = ""
    buffer: list[str] = field(default_factory=list)


@dataclass(slots=True)
class ProbeResult:
    complete: bool
    signal: str
    details: dict[str, Any] = field(default_factory=dict)


@dataclass(slots=True)
class StageGate:
    name: str
    passed: bool
    reason: str = ""
