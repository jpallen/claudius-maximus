# Claudius Maximus

A CLI tool for orchestrating multi-step Claude agent workflows.

## Installation

```bash
# Clone the repository
git clone git@github.com:jpallen/claudius-maximus.git
cd claudius-maximus

# Install dependencies
bun install

# Run directly
bun run src/index.ts

# Or build a binary
bun run build
./dist/cm
```

## Usage

### Workflow Configuration

Create a `cm.yml` file in your project root:

```yaml
version: "1"

workflows:
  default:
    steps:
      - name: plan
        agent: opus
        prompt: "Analyze the task and create an implementation plan."
      - name: implement
        agent: sonnet
        prompt: "Implement the changes based on the plan."
      - name: review
        agent: opus
        prompt: "Review the changes for quality and completeness."

  quick:
    steps:
      - name: execute
        agent: haiku
        prompt: "Execute the task quickly."
```

### Task Commands

```bash
# Create and run a task (executes all workflow steps)
cm task create "Fix the login bug"

# Create a task without starting execution
cm task create "Add new feature" --no-start

# Use a specific workflow
cm task create "Quick fix" --workflow quick

# List all tasks
cm task list

# Show task status
cm task status <task-id>

# Run all remaining steps
cm task run <task-id>

# Run just the next step
cm task step <task-id>

# Resume a paused task with user input
cm task resume <task-id> --prompt "Use JWT for authentication"

# Cancel a task
cm task cancel <task-id>

# Delete a task and its worktree
cm task delete <task-id>
```

### How It Works

1. **Task Creation**: Each task gets a human-readable ID (e.g., "swift-falcon") and runs in an isolated git worktree under `.cm-worktrees/`

2. **Workflow Execution**: Steps execute sequentially, each invoking Claude CLI with the configured agent and prompt

3. **Pause/Resume**: Steps without an agent or prompt pause for user input, resumable with `cm task resume`

4. **State Persistence**: Task state is stored in `~/.cm/tasks/` with full execution logs

### Dev Mode

Use a development version of the CLI for testing:

```bash
# Point to a local development directory
cm dev set /path/to/dev/version

# Check status
cm dev status

# Clear and use the installed version
cm dev clear
```

## Development

```bash
# Run tests
bun test

# Run tests in watch mode
bun test --watch

# Build for all platforms
bun run build:all
```

## License

MIT
