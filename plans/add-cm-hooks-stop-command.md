# Feature: Add `cm hooks stop` Command for Claude Code Integration

## Overview

Add a new `cm hooks stop` CLI command that integrates with Claude Code's hooks system. This command will be invoked as a "Stop" hook by Claude Code, ensuring that any work done by Claude within a task worktree has been properly committed before allowing Claude to stop. If there are uncommitted changes, the command will fail with an instructive error message that Claude will receive as feedback.

## Current State Analysis

### Relevant Existing Code

1. **CLI Entry Point** (`src/index.ts`)
   - Uses Commander.js for CLI parsing
   - Currently handles `dev` and `task` subcommands with `program.addCommand()`
   - Main function routes based on first argument
   - Pattern: subcommands are created via `create*Command()` factory functions

2. **Task Command Pattern** (`src/commands/task.ts`)
   - Factory function returns a `Command` with subcommands: `create`, `merge`, `list`
   - Uses `detectTaskFromCwd()` to detect if running in a task worktree
   - Already has uncommitted changes checking logic in the `merge` subcommand
   - Error pattern: `console.error()` + `process.exit(1)`

3. **Worktree Detection** (`src/lib/task/worktree.ts` lines 406-427)
   - `detectTaskFromCwd(cwd)` - Detects if current directory is in a task worktree
   - Returns `{ taskId: string, repoPath: string } | null`
   - Uses path matching for `.cm-worktrees/<taskId>/` pattern
   - Verifies by checking branch name matches `cm-task/<taskId>`

4. **Git Status Checking** (`src/lib/task/worktree.ts` lines 250-313)
   - `getUncommittedChanges(cwd)` - Returns detailed uncommitted changes
   - Returns `{ hasChanges: boolean, staged: string[], unstaged: string[], untracked: string[] }`
   - Uses `git status --porcelain` format
   - Already used by `task merge` command for validation

5. **Error Classes** (`src/lib/errors.ts`)
   - All domain errors extend `CmError`
   - Pattern: `throw new SpecificError()` then catch in command handler
   - Existing errors: `TaskNotFoundError`, `WorktreeError`, `NotInGitRepoError`

6. **Claude Code Hooks System** (from hooks-guide documentation)
   - `Stop` hook fires when Claude finishes responding
   - Hook input is JSON on stdin with `session_id`, `cwd`, `hook_event_name`, etc.
   - Exit code 0 = allow Claude to stop
   - Exit code 2 = block Claude from stopping (stderr is fed back as feedback)
   - Can use `stop_hook_active` field to avoid infinite loops

### Key Integration Points

- **New command file**: `src/commands/hooks.ts` - follows existing pattern
- **CLI registration**: Add to `src/index.ts` routing logic
- **Reuse worktree functions**: `detectTaskFromCwd`, `getUncommittedChanges`
- **New error class**: `UncommittedChangesError` for clean error handling
- **Hook script**: Create wrapper script for Claude Code configuration

## Requirements

### Functional Requirements

1. **`cm hooks stop` command**:
   - Check if running in a CM task worktree context
   - If not in a worktree, exit 0 silently (not an error - just not relevant)
   - Check git status for uncommitted changes (staged, unstaged, untracked)
   - If clean, exit 0 (allow Claude to stop)
   - If dirty, exit 2 with clear error message to stderr

2. **Error Message Format**:
   - Must be clear and actionable for Claude
   - List specific files that need attention
   - Suggest actions: commit, delete, or add to .gitignore

3. **Hook Script**:
   - Wrapper script that can be configured in Claude Code settings
   - Must handle `cm` not being installed (exit 0 silently)
   - Must handle `cm` not being in PATH (exit 0 silently)
   - Should pass through the hook's stdin to `cm hooks stop`

### Non-Functional Requirements

- **Performance**: Command should complete in <1 second
- **Reliability**: Must not crash Claude Code - fail gracefully
- **Idempotency**: Multiple runs should produce same result
- **Portability**: Hook script should work on Linux and macOS

## Proposed Implementation

### Architecture

```
src/
  commands/
    hooks.ts           # New: cm hooks command group
  lib/
    errors.ts          # Add: UncommittedChangesError
scripts/
  cm-stop-hook.sh      # New: Wrapper script for Claude Code
```

### Detailed Steps

#### Step 1: Add New Error Class

Update `src/lib/errors.ts` to add a specific error for uncommitted changes:

```typescript
/** Error when there are uncommitted changes that block an operation */
export class UncommittedChangesError extends CmError {
  staged: string[];
  unstaged: string[];
  untracked: string[];

  constructor(
    staged: string[],
    unstaged: string[],
    untracked: string[]
  ) {
    const message = formatUncommittedChangesMessage(staged, unstaged, untracked);
    super(message);
    this.name = "UncommittedChangesError";
    this.staged = staged;
    this.unstaged = unstaged;
    this.untracked = untracked;
  }
}

/**
 * Format a clear, actionable message for Claude about uncommitted changes
 */
function formatUncommittedChangesMessage(
  staged: string[],
  unstaged: string[],
  untracked: string[]
): string {
  const lines: string[] = [
    "Cannot stop: there are uncommitted changes in this task worktree.",
    "",
    "You must handle these files before stopping:",
  ];

  if (staged.length > 0) {
    lines.push("");
    lines.push("Staged files (commit these):");
    staged.forEach(f => lines.push(`  - ${f}`));
  }

  if (unstaged.length > 0) {
    lines.push("");
    lines.push("Modified files (commit or discard changes):");
    unstaged.forEach(f => lines.push(`  - ${f}`));
  }

  if (untracked.length > 0) {
    lines.push("");
    lines.push("Untracked files (commit, delete, or add to .gitignore):");
    untracked.forEach(f => lines.push(`  - ${f}`));
  }

  lines.push("");
  lines.push("Actions to take:");
  lines.push("  1. Commit all intended changes: git add <files> && git commit -m 'message'");
  lines.push("  2. Delete any temporary/generated files you don't need");
  lines.push("  3. Add any files that should be ignored to .gitignore");

  return lines.join("\n");
}
```

#### Step 2: Create `src/commands/hooks.ts`

Create the new hooks command file:

```typescript
/**
 * Hooks commands for Claude Code integration
 */

import { Command } from "commander";
import {
  getUncommittedChanges,
  detectTaskFromCwd,
} from "../lib/task/worktree";
import { UncommittedChangesError } from "../lib/errors";

export function createHooksCommand(): Command {
  const hooks = new Command("hooks")
    .description("Claude Code hook commands");

  // cm hooks stop
  hooks
    .command("stop")
    .description("Stop hook - verify clean git state before Claude stops")
    .action(async () => {
      await handleStopHook();
    });

  return hooks;
}

/**
 * Handle the stop hook logic
 *
 * This is called by Claude Code's stop hook mechanism.
 * - If not in a task worktree: exit 0 (not relevant)
 * - If git state is clean: exit 0 (allow stop)
 * - If git state is dirty: exit 2 with error message to stderr
 */
async function handleStopHook(): Promise<void> {
  const cwd = process.cwd();

  // Check if we're in a task worktree
  const taskInfo = await detectTaskFromCwd(cwd);

  if (!taskInfo) {
    // Not in a CM task worktree - this hook doesn't apply
    // Exit silently with success
    process.exit(0);
  }

  // Check for uncommitted changes
  try {
    const changes = await getUncommittedChanges(cwd);

    if (!changes.hasChanges) {
      // Clean state - allow Claude to stop
      process.exit(0);
    }

    // Dirty state - block Claude from stopping
    const error = new UncommittedChangesError(
      changes.staged,
      changes.unstaged,
      changes.untracked
    );

    // Write error message to stderr (Claude receives this as feedback)
    console.error(error.message);
    process.exit(2);
  } catch (error) {
    // If git status fails, log to stderr but allow stop
    // (don't block Claude due to internal errors)
    console.error(`Warning: Could not check git status: ${error}`);
    process.exit(0);
  }
}
```

#### Step 3: Register Command in `src/index.ts`

Update the main entry point to handle the `hooks` command:

```typescript
// Add import at top
import { createHooksCommand } from "./commands/hooks";

// In main() function, update the routing logic:
async function main() {
  const args = process.argv.slice(2);

  // Check if we should proxy to a dev version
  const proxied = await maybeProxyToDevVersion(args);
  if (proxied) {
    return;
  }

  // Handle 'dev', 'task', and 'hooks' subcommands with Commander.js
  if (args.length >= 1 && (args[0] === "dev" || args[0] === "task" || args[0] === "hooks")) {
    const program = new Command();
    program
      .name(CLI_NAME)
      .description(`${APP_NAME} - Your CLI companion`)
      .version(VERSION, "-v, --version", "Display version number");

    program.addCommand(createDevCommand());
    program.addCommand(createTaskCommand());
    program.addCommand(createHooksCommand());

    await program.parseAsync(process.argv);
    return;
  }

  // ... rest of main() unchanged
}
```

Also update the help text to include the new command:

```typescript
  if (args.includes("--help") || args.includes("-h")) {
    console.log(`${APP_NAME} v${VERSION}`);
    console.log(`\nUsage: ${CLI_NAME} [command]`);
    console.log(`\nCommands:`);
    console.log(`  task          Manage tasks (create, merge, list)`);
    console.log(`  hooks         Claude Code hook commands`);
    console.log(`  dev           Manage dev mode - use a different version for testing`);
    console.log(`  (default)     Open the task manager TUI`);
    console.log(`\nThe TUI will launch inside tmux. If tmux is not running, it will be started automatically.`);
    return;
  }
```

#### Step 4: Create Hook Wrapper Script

Create `scripts/cm-stop-hook.sh`:

```bash
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
```

#### Step 5: Alternative - Inline Hook Command

For users who don't want to use a separate script, provide documentation for an inline hook configuration that handles cm not being installed:

```json
{
  "hooks": {
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "command -v cm >/dev/null 2>&1 && cm hooks stop || exit 0"
          }
        ]
      }
    ]
  }
}
```

### API/Interface Design

#### CLI Interface

```
cm hooks stop

  Check git status in current task worktree and exit with appropriate code.

  Exit codes:
    0 - Git state is clean (or not in a task worktree)
    2 - Git state is dirty (uncommitted changes exist)

  When exit code is 2, an error message is written to stderr describing
  the uncommitted changes and required actions.
```

#### Error Message Format

Example stderr output when there are uncommitted changes:

```
Cannot stop: there are uncommitted changes in this task worktree.

You must handle these files before stopping:

Staged files (commit these):
  - src/lib/newfeature.ts

Modified files (commit or discard changes):
  - src/index.ts
  - README.md

Untracked files (commit, delete, or add to .gitignore):
  - temp.log
  - .DS_Store

Actions to take:
  1. Commit all intended changes: git add <files> && git commit -m 'message'
  2. Delete any temporary/generated files you don't need
  3. Add any files that should be ignored to .gitignore
```

## Testing Strategy

### Unit Tests (`tests/hooks.test.ts`)

1. **`formatUncommittedChangesMessage()` tests**:
   - Test with only staged files
   - Test with only unstaged files
   - Test with only untracked files
   - Test with all three types
   - Test with empty arrays (should not happen but handle gracefully)

2. **`UncommittedChangesError` tests**:
   - Verify error message is formatted correctly
   - Verify staged/unstaged/untracked properties are set

### E2E/Integration Tests (`tests/hooks.test.ts`)

Use existing testing patterns from `tests/skip-permissions.test.ts`:

1. **Exit 0 when not in task worktree**:
   ```typescript
   // Run cm hooks stop in a regular git repo (not a worktree)
   // Verify exit code is 0
   // Verify no output to stdout or stderr
   ```

2. **Exit 0 when in clean task worktree**:
   ```typescript
   // Create a task with worktree
   // Run cm hooks stop in the worktree
   // Verify exit code is 0
   // Verify no output to stdout or stderr
   ```

3. **Exit 2 with staged files**:
   ```typescript
   // Create a task with worktree
   // Create and stage a file (git add)
   // Run cm hooks stop in the worktree
   // Verify exit code is 2
   // Verify stderr contains "Staged files"
   // Verify stderr contains the file name
   ```

4. **Exit 2 with modified files**:
   ```typescript
   // Create a task with worktree
   // Commit a file, then modify it
   // Run cm hooks stop in the worktree
   // Verify exit code is 2
   // Verify stderr contains "Modified files"
   ```

5. **Exit 2 with untracked files**:
   ```typescript
   // Create a task with worktree
   // Create a new untracked file
   // Run cm hooks stop in the worktree
   // Verify exit code is 2
   // Verify stderr contains "Untracked files"
   ```

6. **Exit 2 with mixed changes**:
   ```typescript
   // Create a task with all three types of changes
   // Verify all are listed in the error message
   ```

7. **Graceful handling of git errors**:
   ```typescript
   // Run in a directory that is not a git repo at all
   // Verify exit code is 0 (fail open)
   ```

### Hook Script Tests (`tests/hooks-script.test.ts`)

1. **Script exits 0 when cm not in PATH**:
   ```typescript
   // Run the script with PATH that doesn't include cm
   // Verify exit code is 0
   ```

2. **Script delegates to cm hooks stop when cm exists**:
   ```typescript
   // Create a mock cm that records arguments
   // Add mock to PATH
   // Run the script
   // Verify mock was called with "hooks" "stop"
   ```

### Edge Cases to Cover

- Very long file paths in error message
- File names with special characters (spaces, quotes)
- Large number of changed files (should still be readable)
- Symlinks in changed files
- Submodule changes
- Binary files listed as changed
- Running in a detached HEAD state
- Running in a bare repository

## Migration/Rollout

### Backward Compatibility

- **Fully backward compatible**: New command, no changes to existing behavior
- Users must opt-in by configuring the Claude Code hook
- No breaking changes to existing `cm` functionality

### Installation Steps for Users

1. **Verify cm is installed and in PATH**:
   ```bash
   which cm  # Should show path to cm binary
   ```

2. **Option A: Use inline hook (simpler)**
   Add to `~/.claude/settings.json`:
   ```json
   {
     "hooks": {
       "Stop": [
         {
           "hooks": [
             {
               "type": "command",
               "command": "command -v cm >/dev/null 2>&1 && cm hooks stop || exit 0"
             }
           ]
         }
       ]
     }
   }
   ```

3. **Option B: Use wrapper script (more robust)**
   - Copy `cm-stop-hook.sh` to a location in PATH (e.g., `/usr/local/bin/`)
   - Make executable: `chmod +x /usr/local/bin/cm-stop-hook.sh`
   - Add to settings.json with path to script

### Documentation

Add to README.md:
- Section on Claude Code integration
- Hook configuration examples
- Troubleshooting guide

## Open Questions

1. **Should we support a `--json` flag for structured output?**
   - Decision: Not initially. Plain text is clearer for Claude to understand.
   - Can add later if needed for tooling integration.

2. **Should we check for other git issues (merge conflicts, rebase in progress)?**
   - Decision: Start with uncommitted changes only.
   - These edge cases are rare and add complexity.

3. **Should the hook script be included in the cm binary distribution?**
   - Decision: Document inline command as primary method.
   - Script is provided for users who prefer it.

4. **Should we add a `cm hooks install` command to auto-configure?**
   - Decision: Not initially. Manual configuration is clear.
   - Could add later as a convenience feature.

## Appendix

### Claude Code Stop Hook Behavior

From the hooks documentation, the Stop hook:
- Fires when Claude finishes responding
- Does NOT fire on user interrupts
- Exit code 0 allows Claude to stop
- Exit code 2 blocks Claude with stderr as feedback
- Can check `stop_hook_active` to avoid infinite loops (not needed for our use case)

### Files to Create/Modify

| File | Action | Description |
|------|--------|-------------|
| `src/commands/hooks.ts` | Create | New hooks command group |
| `src/lib/errors.ts` | Modify | Add `UncommittedChangesError` class |
| `src/index.ts` | Modify | Register hooks command |
| `scripts/cm-stop-hook.sh` | Create | Wrapper script for Claude Code |
| `tests/hooks.test.ts` | Create | Tests for hooks command |
| `README.md` | Modify | Add Claude Code integration docs |

### Example Error Scenarios

**Scenario 1: Developer forgot to commit new file**
```
$ cm hooks stop
Cannot stop: there are uncommitted changes in this task worktree.

You must handle these files before stopping:

Untracked files (commit, delete, or add to .gitignore):
  - src/lib/new-feature.ts

Actions to take:
  1. Commit all intended changes: git add <files> && git commit -m 'message'
  2. Delete any temporary/generated files you don't need
  3. Add any files that should be ignored to .gitignore

$ echo $?
2
```

**Scenario 2: Partial commit (some staged, some not)**
```
$ cm hooks stop
Cannot stop: there are uncommitted changes in this task worktree.

You must handle these files before stopping:

Staged files (commit these):
  - src/lib/feature-a.ts

Modified files (commit or discard changes):
  - src/lib/feature-b.ts

Actions to take:
  1. Commit all intended changes: git add <files> && git commit -m 'message'
  2. Delete any temporary/generated files you don't need
  3. Add any files that should be ignored to .gitignore

$ echo $?
2
```

**Scenario 3: Clean state**
```
$ cm hooks stop
$ echo $?
0
```
