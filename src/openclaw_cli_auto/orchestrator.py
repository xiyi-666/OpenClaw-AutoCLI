from __future__ import annotations

from collections import deque
from dataclasses import dataclass, field
from typing import Iterable

from .models import AgentKind, ProbeResult, Session, StageGate, Task, TaskStatus


@dataclass(slots=True)
class OrchestratorConfig:
    max_retry_per_task: int = 5
    max_total_iterations: int = 50
    escalation_threshold: int = 3
    token_compact_threshold: int = 85_000


@dataclass(slots=True)
class TaskOrchestrator:
    config: OrchestratorConfig = field(default_factory=OrchestratorConfig)
    sessions: dict[str, Session] = field(default_factory=dict)
    tasks: dict[str, Task] = field(default_factory=dict)
    history: list[str] = field(default_factory=list)
    iterations: int = 0

    def register_session(self, session: Session) -> None:
        self.sessions[session.session_id] = session
        self.history.append(f"registered session {session.session_id} ({session.kind})")

    def add_task(self, task: Task) -> None:
        self.tasks[task.id] = task
        self.history.append(f"queued task {task.id}: {task.title}")

    def ready_tasks(self) -> list[Task]:
        return [
            task
            for task in self.tasks.values()
            if task.status == TaskStatus.PENDING
            and all(self.tasks[dep].status == TaskStatus.COMPLETED for dep in task.depends_on)
        ]

    def assign_next(self) -> tuple[Task | None, Session | None]:
        ready = self.ready_tasks()
        if not ready or not self.sessions:
            return None, None
        task = ready[0]
        session = self._least_loaded_session()
        task.status = TaskStatus.RUNNING
        session.running = True
        session.last_message = f"assigned {task.id}"
        self.history.append(f"assigned {task.id} to {session.session_id}")
        return task, session

    def _least_loaded_session(self) -> Session:
        return sorted(self.sessions.values(), key=lambda s: (s.running, s.token_used))[0]

    def inject_instruction(self, session_id: str, instruction: str) -> None:
        session = self.sessions[session_id]
        session.buffer.append(instruction)
        session.last_message = instruction
        session.token_used += max(1, len(instruction) // 4)
        if session.token_used >= self.config.token_compact_threshold:
            self.compact_session(session_id)

    def probe(self, session_id: str) -> ProbeResult:
        session = self.sessions[session_id]
        complete = any("DONE" in message or "complete" in message.lower() for message in session.buffer)
        signal = "complete" if complete else "running"
        return ProbeResult(complete=complete, signal=signal, details={"checkpoint": session.checkpoint})

    def compact_session(self, session_id: str) -> None:
        session = self.sessions[session_id]
        summary = f"summary: {len(session.buffer)} messages, checkpoint={session.checkpoint}"
        session.buffer = [summary]
        session.token_used = 1_000
        self.history.append(f"compacted {session_id}")

    def stage_gate(self, name: str, passed: bool, reason: str = "") -> StageGate:
        gate = StageGate(name=name, passed=passed, reason=reason)
        self.history.append(f"gate {name}: {'passed' if passed else 'failed'}")
        return gate

    def run_cycle(self, instructions: Iterable[str]) -> list[ProbeResult]:
        queue = deque(instructions)
        results: list[ProbeResult] = []
        while queue and self.iterations < self.config.max_total_iterations:
            self.iterations += 1
            task, session = self.assign_next()
            if task is None or session is None:
                break
            instruction = queue.popleft()
            self.inject_instruction(session.session_id, instruction)
            result = self.probe(session.session_id)
            results.append(result)
            if result.complete:
                task.status = TaskStatus.COMPLETED
                session.running = False
            else:
                task.attempts += 1
                if task.attempts >= self.config.max_retry_per_task:
                    task.status = TaskStatus.FAILED
                    session.running = False
                else:
                    task.status = TaskStatus.PENDING
                    queue.append(instruction)
        return results


def build_default_orchestrator() -> TaskOrchestrator:
    orchestrator = TaskOrchestrator()
    orchestrator.register_session(Session(session_id="session-001", kind=AgentKind.CLAUDE))
    orchestrator.register_session(Session(session_id="session-002", kind=AgentKind.CODEX))
    orchestrator.register_session(Session(session_id="session-003", kind=AgentKind.GEMINI))
    orchestrator.register_session(Session(session_id="session-004", kind=AgentKind.TEST))
    return orchestrator
