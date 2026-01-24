# CLAUDE.md

This file provides guidance for Claude when working on the Claudius Maximus codebase.

## Project Overview

Claudius Maximus (`cm`) is a CLI tool for orchestrating multi-step Claude agent workflows. It allows users to define workflows in `cm.yml` files and execute them as isolated tasks using git worktrees.

## Tech Stack

- **Runtime**: Bun
- **Language**: TypeScript
- **CLI Framework**: Commander.js
- **Testing**: Bun's built-in test runner
- **Config Format**: YAML

## Project Structure

```
src/
  index.ts              # CLI entry point
  commands/
    dev.ts              # Dev mode command (version switching)
    task.ts             # Task command (workflow orchestration)
  lib/
    constants.ts        # App name, version, config paths
    config.ts           # User config (~/.cm/config.json)
    errors.ts           # Typed error classes
    task/
      types.ts          # Task state interfaces
      id-generator.ts   # Human-readable ID generation
      manager.ts        # Task CRUD and persistence
      worktree.ts       # Git worktree operations
    workflow/
      types.ts          # Workflow/step interfaces
      loader.ts         # cm.yml parsing and validation
      executor.ts       # Workflow step execution
      claude-runner.ts  # Claude CLI subprocess runner

tests/
  helpers.ts            # Test utilities
  cli.test.ts           # Basic CLI tests
  dev.test.ts           # Dev mode tests
  task.test.ts          # Task command tests (includes mock Claude)
```

## Key Patterns

### Error Handling
All domain errors extend `CmError` from `src/lib/errors.ts`. Commands catch errors and display user-friendly messages.

### Testing
- E2E tests run the actual CLI via `Bun.spawn`
- Tests use isolated config directories via `CM_CONFIG_DIR` env var
- Claude CLI is mocked via `CM_CLAUDE_COMMAND` env var pointing to a shell script
- Test repos are created in temp directories with git init

### Task Storage
```
~/.cm/tasks/
  index.json              # Task summaries for quick listing
  <task-id>/
    task.json             # Full task state
    steps/
      01-<step-name>.json # Step execution logs
```

### Git Worktrees
Tasks run in `.cm-worktrees/<task-id>/` within the project directory. This directory is auto-added to `.gitignore`.

## Commands

```bash
bun test              # Run all tests
bun run dev           # Run CLI in development
bun run build         # Build binary for current platform
```

## Adding New Features

1. **New Command**: Create in `src/commands/`, register in `src/index.ts`
2. **New Workflow Feature**: Update types in `src/lib/workflow/types.ts`, loader in `loader.ts`
3. **New Task Feature**: Update types in `src/lib/task/types.ts`, manager in `manager.ts`

## Testing Conventions

- Use `createTestContext()` for isolated config
- Use `createTestRepo()` for git repos with `cm.yml`
- Use `createMockClaude()` for mocking Claude CLI
- Clean up temp directories and `~/.cm/tasks/` in `afterEach`
