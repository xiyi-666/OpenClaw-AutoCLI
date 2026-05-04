#!/bin/bash
set -euo pipefail

# Codex CLI
npm install -g @openai/codex

# Claude Code
npm install -g @anthropic-ai/claude-code

# Gemini CLI
npm install -g @google/gemini-cli

echo "All CLI tools installed."
