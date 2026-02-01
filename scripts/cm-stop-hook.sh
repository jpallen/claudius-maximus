#!/bin/bash
#
# cm-stop-hook.sh - Claude Code stop hook wrapper for Claudius Maximus
#
# This script is designed to be configured as a Claude Code stop hook.
# It checks if cm is available and delegates to `cm hooks stop`.
#
# Exit codes:
#   0 - Allow Claude to stop (cm not found, not in task, or git is clean)
#   2 - Block Claude from stopping (uncommitted changes in task worktree)
#
# Usage in Claude Code settings.json:
#   {
#     "hooks": {
#       "Stop": [
#         {
#           "hooks": [
#             {
#               "type": "command",
#               "command": "/path/to/cm-stop-hook.sh"
#             }
#           ]
#         }
#       ]
#     }
#   }
#

# Check if cm is available in PATH
if ! command -v cm &> /dev/null; then
  # cm is not installed or not in PATH - exit silently
  exit 0
fi

# Run the stop hook command
# Pass stdin through in case future versions need hook input
exec cm hooks stop
