from __future__ import annotations

import argparse
import json

from .models import Task
from .orchestrator import build_default_orchestrator


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="openclaw", description="Autonomous CLI orchestrator")
    parser.add_argument("--demo", action="store_true", help="Run a small demo cycle")
    return parser


def main() -> None:
    parser = build_parser()
    args = parser.parse_args()

    orchestrator = build_default_orchestrator()
    orchestrator.add_task(Task(id="task-001", title="Build initial app scaffold", phase="code"))
    orchestrator.add_task(Task(id="task-002", title="Run tests", phase="test", depends_on=["task-001"]))
    orchestrator.add_task(Task(id="task-003", title="QA review", phase="qa", depends_on=["task-002"]))

    if args.demo:
        results = orchestrator.run_cycle([
            "Generate core modules DONE",
            "Run test suite DONE",
            "Review results DONE",
        ])
        print(json.dumps([result.__dict__ for result in results], indent=2))
    else:
        print("OpenClaw orchestrator scaffold ready.")


if __name__ == "__main__":
    main()
