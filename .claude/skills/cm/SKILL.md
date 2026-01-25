---
name: cm
description: Guide for using the Claudius Maximus (cm) CLI tool. Use when running cm commands, creating/managing tasks, or editing cm.yml workflow configuration.
---

# Claudius Maximus (cm) CLI

`cm` orchestrates multi-step Claude agent workflows using git worktrees for isolation.

## Quick Start

```bash
cm init                              # Initialize cm.yml and agents in a git repo
cm task create "your task"           # Create and run a task
cm task list                         # See all tasks
cm task status <id>                  # Check task progress
```

## CLI Commands

### Initialize

```bash
cm init              # Create cm.yml and .claude/agents/ with default agents
cm init --force      # Overwrite existing configuration
```

### Task Management

```bash
# Create tasks
cm task create "description"                    # Create and run with default workflow
cm task create "description" -w quick           # Use specific workflow
cm task create "description" -b feature-branch  # Start from specific branch
cm task create "description" --no-start         # Create without running
cm task create "description" -q                 # Quiet mode (no streaming output)

# List and inspect
cm task list                    # List all tasks (alias: cm task ls)
cm task status                  # Summary of all tasks by status
cm task status <id>             # Detailed status for one task
cm task thread <id>             # View task conversation history
cm task thread <id> --json      # Output as JSON
cm task thread <id> -s plan     # Filter to specific step
cm task thread <id> -l 5        # Show last 5 entries

# Run and resume
cm task run <id>                # Run remaining steps
cm task run <id> -q             # Run quietly
cm task resume <id> -p "input"  # Resume paused task with user input

# Lifecycle
cm task cancel <id>             # Cancel running/pending task
cm task merge <id>              # Merge completed task to base branch
cm task merge <id> -d           # Merge and delete task
cm task delete <id>             # Delete task and worktree
cm task delete <id> -f          # Force delete (even if running)

# Within task context (called by agents)
cm task complete -m "summary"   # Mark current step complete
cm task fail -r "reason"        # Mark current step failed
```

### Dev Mode (version switching)

```bash
cm dev list                  # Show configured dev version
cm dev set /path/to/cm-cli   # Use a different cm version (directory, .ts, or binary)
cm dev clear                 # Reset to installed version
cm dev status                # Test the dev version
```

## cm.yml Configuration

The `cm.yml` file defines workflows. It must be at the git repo root.

### Structure

```yaml
version: "1"                    # Required, must be "1"

defaults:                       # Optional global defaults
  timeout: 300000               # Default step timeout in ms (5 min)

workflows:                      # Required, at least one workflow
  workflow-name:                # Workflow identifier
    prompt: |                   # Required: orchestrator instructions
      Instructions for Claude on how to coordinate the steps.
      Claude decides which steps to run and in what order.
    model: opus                 # Optional: opus, sonnet, or haiku
    steps:                      # Required, at least one step
      - name: step-name         # Required: unique within workflow
        model: sonnet           # Optional: override orchestrator model
        agent: planning-agent   # Optional: path in .claude/agents/
        prompt: Step prompt     # Optional: instructions for this step
        timeout: 600000         # Optional: step timeout in ms
```

### Example Workflows

**Full cycle (plan -> review -> execute):**

```yaml
workflows:
  default:
    prompt: |
      Plan first, then have the review agent review the plan.
      Iterate until review approves, then execute.
      After execution, review again until satisfied.
    steps:
      - name: plan
        agent: planning-agent
        prompt: Create or refine the implementation plan.
      - name: execute
        agent: execution-agent
        prompt: Implement based on the approved plan.
      - name: review
        agent: review-agent
        prompt: Review and provide actionable feedback.
```

**Quick tasks (single step):**

```yaml
workflows:
  quick:
    prompt: Execute this simple task directly in one step.
    steps:
      - name: execute
        prompt: Complete the task directly.
```

**Research only:**

```yaml
workflows:
  research:
    model: haiku              # Use cheaper model for research
    prompt: Research and analyze, do not implement anything.
    steps:
      - name: analyze
        prompt: Analyze the codebase and provide findings.
```

### Valid Models

- `opus` - Most capable, best for complex orchestration
- `sonnet` - Balanced capability and speed
- `haiku` - Fast and economical

## Agents

Agents are markdown files in `.claude/agents/` that provide specialized instructions.

**Location:** `.claude/agents/<agent-name>.md`

**Reference in cm.yml:**

```yaml
steps:
  - name: plan
    agent: planning-agent    # References .claude/agents/planning-agent.md
```

`cm init` creates three default agents:
- `planning-agent` - Breaks down tasks into actionable steps
- `execution-agent` - Implements plans with quality code
- `review-agent` - Reviews work and provides feedback

## Task Workflow

1. **Create**: `cm task create "description"` creates a git worktree at `.cm-worktrees/<task-id>/`
2. **Run**: Claude orchestrates the workflow, invoking steps as needed
3. **Pause**: If Claude needs user input, task pauses
4. **Resume**: `cm task resume <id> -p "input"` continues with your answer
5. **Complete**: When done, you're prompted to merge changes
6. **Merge**: Changes merge to the base branch via `cm task merge <id>`
7. **Delete**: Clean up with `cm task delete <id>`

## Task Statuses

| Status | Meaning |
|--------|---------|
| `pending` | Created but not started |
| `running` | Currently executing |
| `paused` | Waiting for user input |
| `completed` | All steps finished successfully |
| `failed` | Execution encountered an error |
| `cancelled` | Manually cancelled |

## Environment Variables

| Variable | Purpose |
|----------|---------|
| `CM_CONFIG_DIR` | Override `~/.cm` config location |
| `CM_CLAUDE_COMMAND` | Override `claude` command (for testing) |
| `CM_TASK_ID` | Current task ID (set during execution) |
| `CM_STEP_NAME` | Current step name (set during execution) |
| `CM_STEP_ATTEMPT` | Current attempt number (set during execution) |

## Common Patterns

**Add a new workflow:**

Edit `cm.yml` and add under `workflows:`:

```yaml
workflows:
  existing-workflow:
    # ...

  new-workflow:           # Add your new workflow
    prompt: |
      Orchestrator instructions here.
    steps:
      - name: step1
        prompt: What this step does.
```

**Create a specialized agent:**

1. Create `.claude/agents/my-agent.md` with instructions
2. Reference in cm.yml: `agent: my-agent`

**Run a specific workflow:**

```bash
cm task create "my task" -w new-workflow
```
