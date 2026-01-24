---
name: testing
description: Guide for writing and running tests in this project. Use when writing tests, debugging test failures, or understanding the test setup.
user-invocable: false
---

# Testing Guide

This project uses Bun's built-in test runner with E2E-style tests that run the actual CLI via `Bun.spawn`.

## Running Tests

```bash
bun test              # Run all tests
bun test --watch      # Watch mode
bun test task         # Run specific test file
```

## Test Isolation

Each test runs in complete isolation:

1. **Isolated config directory** - `CM_CONFIG_DIR` env var points to a temp directory
2. **Isolated git repo** - Fresh repo with `cm.yml` created in temp directory
3. **Mock Claude CLI** - `CM_CLAUDE_COMMAND` env var points to a mock script

## Test Helpers (`tests/helpers.ts`)

### `createTestContext()`

Creates an isolated test environment:

```typescript
const ctx = await createTestContext();
// ctx.configDir - temp directory for ~/.cm equivalent
// ctx.run(...args) - run CLI with isolated config
// ctx.cleanup() - remove temp directory
```

**Always call `ctx.cleanup()` in `afterEach`.**

### `runCli(ctx, cwd, args, extraEnv)`

Run the CLI in a specific directory with extra environment variables:

```typescript
const result = await runCli(ctx, testRepoDir, ["task", "create", "Test"], {
  CM_CLAUDE_COMMAND: mockScriptPath,
});
// result.stdout, result.stderr, result.exitCode
```

## Creating Test Repos (`tests/task.test.ts`)

### `createTestRepo()`

Creates a git repo with a `cm.yml` file:

```typescript
const testRepoDir = await createTestRepo();
// Clean up in afterEach:
await rm(testRepoDir, { recursive: true, force: true });
```

## Mocking Claude CLI

### `createMockClaude(baseDir, options)`

Creates a shell script that mimics the Claude CLI:

```typescript
const { scriptPath, logPath } = await createMockClaude(mockDir, {
  output: "Task completed",  // JSON result to return
  exitCode: 0,               // Exit code
  logArgs: true,             // Log calls to logPath
  failOnStep: "implement",   // Fail if prompt contains this string
});

// Use it:
const result = await runCli(ctx, testRepoDir, ["task", "create", "Test"], {
  CM_CLAUDE_COMMAND: scriptPath,
});

// Check what Claude received:
const log = await readMockLog(logPath);
expect(log).toContain("PROMPT: ...");
expect(log).toContain("MODEL: sonnet");
```

### `createCompletingMockClaude(baseDir, options)`

Creates a mock that calls `cm task complete` or `cm task fail`:

```typescript
const { scriptPath } = await createCompletingMockClaude(mockDir, {
  completionMessage: "Done!",  // For cm task complete --message
  // OR
  failWithReason: "Error",     // For cm task fail --reason
});
```

## Standard Test Pattern

```typescript
describe("feature", () => {
  let ctx: TestContext;
  let testRepoDir: string;
  let mockDir: string;

  beforeEach(async () => {
    ctx = await createTestContext();
    testRepoDir = await createTestRepo();
    mockDir = await mkdtemp(join(tmpdir(), "cm-mock-"));
  });

  afterEach(async () => {
    await ctx.cleanup();
    await rm(testRepoDir, { recursive: true, force: true });
    await rm(mockDir, { recursive: true, force: true });
  });

  it("does something", async () => {
    const { scriptPath } = await createMockClaude(mockDir);

    const result = await runCli(
      ctx,
      testRepoDir,
      ["task", "create", "Test task"],
      { CM_CLAUDE_COMMAND: scriptPath }
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("expected output");
  });
});
```

## Creating Task Data Directly

For tests that need pre-existing task state, create files in `ctx.configDir`:

```typescript
const tasksDir = join(ctx.configDir, "tasks");
const taskId = "test-task";
const attemptDir = join(tasksDir, taskId, "steps", "step-name");
await mkdir(attemptDir, { recursive: true });

// Create task.json
await Bun.write(
  join(tasksDir, taskId, "task.json"),
  JSON.stringify({ id: taskId, ... })
);

// Create attempt file
await Bun.write(
  join(attemptDir, "attempt-1.json"),
  JSON.stringify({ attemptNumber: 1, status: "running", ... })
);
```

## Environment Variables

| Variable | Purpose |
|----------|---------|
| `CM_CONFIG_DIR` | Override `~/.cm` location (for test isolation) |
| `CM_CLAUDE_COMMAND` | Override `claude` command (for mocking) |
| `CM_TASK_ID` | Task context for `cm task complete/fail` |
| `CM_STEP_NAME` | Step context for completion tracking |
| `CM_STEP_ATTEMPT` | Attempt number for completion tracking |
