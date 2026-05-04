#!/bin/bash
set -euo pipefail

npm update -g @openai/codex @anthropic-ai/claude-code @google/gemini-cli
echo "All CLI tools updated."
