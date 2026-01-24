import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { createTestContext, type TestContext } from "./helpers";
import { join } from "path";
import { mkdtemp, rm, chmod } from "fs/promises";
import { tmpdir, homedir } from "os";

/**
 * Create a mock Claude CLI script for testing
 * Returns the path to the mock script
 */
async function createMockClaude(
  baseDir: string,
  options: {
    /** Output to return as JSON result */
    output?: string;
    /** Exit code to return */
    exitCode?: number;
    /** Whether to log received arguments to a file */
    logArgs?: boolean;
    /** Simulate failure on specific step names (partial match in prompt) */
    failOnStep?: string;
  } = {}
): Promise<{ scriptPath: string; logPath: string }> {
  const scriptPath = join(baseDir, "mock-claude");
  const logPath = join(baseDir, "claude-calls.log");

  const {
    output = "Task completed successfully",
    exitCode = 0,
    logArgs = true,
    failOnStep,
  } = options;

  // Create a shell script that mimics claude CLI behavior
  const script = `#!/bin/bash
# Mock Claude CLI for testing

# Log the call if requested
${logArgs ? `echo "CALL: $@" >> "${logPath}"` : ""}

# Parse arguments to find the prompt
PROMPT=""
MODEL=""
while [[ $# -gt 0 ]]; do
  case $1 in
    -p)
      PROMPT="$2"
      shift 2
      ;;
    --model)
      MODEL="$2"
      shift 2
      ;;
    --output-format)
      shift 2
      ;;
    --allowedTools)
      shift 2
      ;;
    *)
      shift
      ;;
  esac
done

# Log parsed values
${logArgs ? `echo "PROMPT: $PROMPT" >> "${logPath}"` : ""}
${logArgs ? `echo "MODEL: $MODEL" >> "${logPath}"` : ""}
${logArgs ? `echo "---" >> "${logPath}"` : ""}

${
  failOnStep
    ? `
# Check if this is the step that should fail
if [[ "$PROMPT" == *"${failOnStep}"* ]]; then
  echo "Simulated failure for step" >&2
  exit 1
fi
`
    : ""
}

# Output JSON result
echo '{"result": "${output}"}'
exit ${exitCode}
`;

  await Bun.write(scriptPath, script);
  await chmod(scriptPath, 0o755);

  // Initialize empty log file
  await Bun.write(logPath, "");

  return { scriptPath, logPath };
}

/**
 * Read the mock Claude log file
 */
async function readMockLog(logPath: string): Promise<string> {
  const file = Bun.file(logPath);
  if (await file.exists()) {
    return file.text();
  }
  return "";
}

/**
 * Create a test git repository with a cm.yml file
 */
async function createTestRepo(): Promise<string> {
  const repoDir = await mkdtemp(join(tmpdir(), "cm-test-repo-"));

  // Initialize git repo
  await Bun.spawn(["git", "init"], { cwd: repoDir, stdout: "pipe", stderr: "pipe" }).exited;
  await Bun.spawn(["git", "config", "user.email", "test@test.com"], { cwd: repoDir, stdout: "pipe", stderr: "pipe" }).exited;
  await Bun.spawn(["git", "config", "user.name", "Test"], { cwd: repoDir, stdout: "pipe", stderr: "pipe" }).exited;

  // Create a simple cm.yml
  const cmYml = `version: "1"

defaults:
  allowedTools: [Read, Write, Bash]

workflows:
  default:
    steps:
      - name: plan
        agent: sonnet
        prompt: "Analyze the task and create an implementation plan."
      - name: implement
        agent: sonnet
        prompt: "Implement the changes."

  quick:
    steps:
      - name: execute
        agent: haiku
        prompt: "Execute the task quickly."

  needs-input:
    steps:
      - name: gather
        # No agent or prompt - will pause for user input
`;

  await Bun.write(join(repoDir, "cm.yml"), cmYml);
  await Bun.write(join(repoDir, "README.md"), "# Test Repo\n");

  // Make initial commit
  await Bun.spawn(["git", "add", "."], { cwd: repoDir, stdout: "pipe", stderr: "pipe" }).exited;
  await Bun.spawn(["git", "commit", "-m", "Initial commit"], { cwd: repoDir, stdout: "pipe", stderr: "pipe" }).exited;

  return repoDir;
}

/**
 * Run CLI in a specific directory with optional extra environment variables
 */
async function runCli(
  ctx: TestContext,
  cwd: string,
  args: string[],
  extraEnv: Record<string, string> = {}
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const CLI_ENTRY = join(import.meta.dir, "..", "src", "index.ts");

  const proc = Bun.spawn(["bun", "run", CLI_ENTRY, ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      CM_CONFIG_DIR: ctx.configDir,
      ...extraEnv,
    },
  });

  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);

  const exitCode = await proc.exited;

  return { stdout, stderr, exitCode };
}

/**
 * Clean up task data from home directory
 */
async function cleanupTaskData(): Promise<void> {
  const tasksDir = join(homedir(), ".cm", "tasks");
  try {
    await rm(tasksDir, { recursive: true, force: true });
  } catch {
    // Ignore if doesn't exist
  }
}

describe("task command", () => {
  let ctx: TestContext;
  let testRepoDir: string;

  beforeEach(async () => {
    ctx = await createTestContext();
    testRepoDir = await createTestRepo();
  });

  afterEach(async () => {
    await ctx.cleanup();
    await rm(testRepoDir, { recursive: true, force: true });
    await cleanupTaskData();
  });

  describe("task list", () => {
    it("shows no tasks when none exist", async () => {
      const result = await runCli(ctx, testRepoDir, ["task", "list"]);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("No tasks found");
    });

    it("supports ls alias", async () => {
      const result = await runCli(ctx, testRepoDir, ["task", "ls"]);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("No tasks found");
    });
  });

  describe("task create with --no-start", () => {
    it("creates a task without starting execution", async () => {
      const result = await runCli(ctx, testRepoDir, [
        "task", "create", "Test task description", "--no-start"
      ]);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("Creating task:");
      expect(result.stdout).toContain("Test task description");
      expect(result.stdout).toContain("Task created:");
      expect(result.stdout).toContain("Worktree:");
      expect(result.stdout).toContain("Task created but not started");
    });

    it("creates worktree in .cm-worktrees directory", async () => {
      const result = await runCli(ctx, testRepoDir, [
        "task", "create", "Test task", "--no-start"
      ]);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain(".cm-worktrees/");
    });

    it("uses custom workflow when specified", async () => {
      const result = await runCli(ctx, testRepoDir, [
        "task", "create", "Quick test", "--workflow", "quick", "--no-start"
      ]);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("Workflow: quick");
      expect(result.stdout).toContain("1 steps");
    });

    it("fails with invalid workflow name", async () => {
      const result = await runCli(ctx, testRepoDir, [
        "task", "create", "Test task", "--workflow", "nonexistent", "--no-start"
      ]);

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("Workflow \"nonexistent\" not found");
    });
  });

  describe("task status", () => {
    it("shows summary when no ID provided", async () => {
      const result = await runCli(ctx, testRepoDir, ["task", "status"]);

      expect(result.exitCode).toBe(0);
      expect(
        result.stdout.includes("No tasks found") ||
          result.stdout.includes("Task Status Summary")
      ).toBe(true);
    });

    it("shows detailed status for a specific task", async () => {
      // First create a task
      const createResult = await runCli(ctx, testRepoDir, [
        "task", "create", "Test task for status", "--no-start"
      ]);

      expect(createResult.exitCode).toBe(0);

      // Extract task ID from output
      const match = createResult.stdout.match(/Task created: ([a-z]+-[a-z]+)/);
      expect(match).toBeTruthy();
      const taskId = match![1];

      // Check status
      const statusResult = await runCli(ctx, testRepoDir, ["task", "status", taskId]);

      expect(statusResult.exitCode).toBe(0);
      expect(statusResult.stdout).toContain(`Task: ${taskId}`);
      expect(statusResult.stdout).toContain("Status: pending");
      expect(statusResult.stdout).toContain("Test task for status");
      expect(statusResult.stdout).toContain("Steps");
    });

    it("fails with invalid task ID", async () => {
      const result = await runCli(ctx, testRepoDir, ["task", "status", "nonexistent-task"]);

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("Task \"nonexistent-task\" not found");
    });
  });

  describe("task cancel", () => {
    it("cancels a pending task", async () => {
      // Create a task
      const createResult = await runCli(ctx, testRepoDir, [
        "task", "create", "Task to cancel", "--no-start"
      ]);

      const match = createResult.stdout.match(/Task created: ([a-z]+-[a-z]+)/);
      const taskId = match![1];

      // Cancel it
      const cancelResult = await runCli(ctx, testRepoDir, ["task", "cancel", taskId]);

      expect(cancelResult.exitCode).toBe(0);
      expect(cancelResult.stdout).toContain(`Task ${taskId} cancelled`);
    });

    it("fails to cancel a non-existent task", async () => {
      const result = await runCli(ctx, testRepoDir, ["task", "cancel", "nonexistent"]);

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("not found");
    });
  });

  describe("task delete", () => {
    it("deletes a task and its worktree", async () => {
      // Create a task
      const createResult = await runCli(ctx, testRepoDir, [
        "task", "create", "Task to delete", "--no-start"
      ]);

      const match = createResult.stdout.match(/Task created: ([a-z]+-[a-z]+)/);
      const taskId = match![1];

      // Delete it
      const deleteResult = await runCli(ctx, testRepoDir, ["task", "delete", taskId]);

      expect(deleteResult.exitCode).toBe(0);
      expect(deleteResult.stdout).toContain(`Task ${taskId} deleted`);

      // Verify it's gone
      const statusResult = await runCli(ctx, testRepoDir, ["task", "status", taskId]);
      expect(statusResult.exitCode).toBe(1);
    });
  });

  describe("cm.yml validation", () => {
    it("fails when cm.yml is missing", async () => {
      // Create a git repo without cm.yml
      const emptyRepoDir = await mkdtemp(join(tmpdir(), "cm-empty-repo-"));
      await Bun.spawn(["git", "init"], { cwd: emptyRepoDir, stdout: "pipe", stderr: "pipe" }).exited;
      await Bun.spawn(["git", "config", "user.email", "test@test.com"], { cwd: emptyRepoDir, stdout: "pipe", stderr: "pipe" }).exited;
      await Bun.spawn(["git", "config", "user.name", "Test"], { cwd: emptyRepoDir, stdout: "pipe", stderr: "pipe" }).exited;
      await Bun.write(join(emptyRepoDir, "README.md"), "# Empty\n");
      await Bun.spawn(["git", "add", "."], { cwd: emptyRepoDir, stdout: "pipe", stderr: "pipe" }).exited;
      await Bun.spawn(["git", "commit", "-m", "Initial"], { cwd: emptyRepoDir, stdout: "pipe", stderr: "pipe" }).exited;

      const result = await runCli(ctx, emptyRepoDir, ["task", "create", "Test", "--no-start"]);

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("No cm.yml found");

      await rm(emptyRepoDir, { recursive: true, force: true });
    });

    it("fails when not in a git repository", async () => {
      const nonGitDir = await mkdtemp(join(tmpdir(), "cm-non-git-"));

      const result = await runCli(ctx, nonGitDir, ["task", "create", "Test", "--no-start"]);

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("Not in a git repository");

      await rm(nonGitDir, { recursive: true, force: true });
    });
  });
});

describe("task id generation", () => {
  it("generates unique IDs for multiple tasks", async () => {
    const ctx = await createTestContext();
    const testRepoDir = await createTestRepo();
    const ids: string[] = [];

    try {
      // Create multiple tasks
      for (let i = 0; i < 5; i++) {
        const result = await runCli(ctx, testRepoDir, [
          "task", "create", `Task ${i}`, "--no-start"
        ]);

        expect(result.exitCode).toBe(0);

        const match = result.stdout.match(/Task created: ([a-z]+-[a-z]+(-\d+)?)/);
        expect(match).toBeTruthy();
        ids.push(match![1]);
      }

      // All IDs should be unique
      const uniqueIds = new Set(ids);
      expect(uniqueIds.size).toBe(ids.length);
    } finally {
      await ctx.cleanup();
      await rm(testRepoDir, { recursive: true, force: true });
      await cleanupTaskData();
    }
  });
});

describe("workflow execution with mock Claude", () => {
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
    await cleanupTaskData();
  });

  it("executes all workflow steps with mock Claude", async () => {
    const { scriptPath, logPath } = await createMockClaude(mockDir);

    // Create and run a task with mock Claude
    const result = await runCli(
      ctx,
      testRepoDir,
      ["task", "create", "Test full workflow"],
      { CM_CLAUDE_COMMAND: scriptPath }
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Workflow completed");
    expect(result.stdout).toContain("Steps completed: 2");

    // Verify Claude was called for each step
    const log = await readMockLog(logPath);
    expect(log).toContain("PROMPT: Analyze the task");
    expect(log).toContain("PROMPT: Implement the changes");
    expect(log).toContain("MODEL: sonnet");
  });

  it("executes single-step workflow", async () => {
    const { scriptPath, logPath } = await createMockClaude(mockDir);

    const result = await runCli(
      ctx,
      testRepoDir,
      ["task", "create", "Quick task", "--workflow", "quick"],
      { CM_CLAUDE_COMMAND: scriptPath }
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Workflow completed");
    expect(result.stdout).toContain("Steps completed: 1");

    const log = await readMockLog(logPath);
    expect(log).toContain("PROMPT: Execute the task quickly");
    expect(log).toContain("MODEL: haiku");
  });

  it("runs steps manually with task step command", async () => {
    const { scriptPath, logPath } = await createMockClaude(mockDir);

    // Create task without starting
    const createResult = await runCli(
      ctx,
      testRepoDir,
      ["task", "create", "Manual step test", "--no-start"],
      { CM_CLAUDE_COMMAND: scriptPath }
    );

    const match = createResult.stdout.match(/Task created: ([a-z]+-[a-z]+)/);
    const taskId = match![1];

    // Run first step
    const step1Result = await runCli(
      ctx,
      testRepoDir,
      ["task", "step", taskId],
      { CM_CLAUDE_COMMAND: scriptPath }
    );

    expect(step1Result.exitCode).toBe(0);
    expect(step1Result.stdout).toContain("Step completed successfully");
    expect(step1Result.stdout).toContain("Next step: implement");

    // Check log has first step
    let log = await readMockLog(logPath);
    expect(log).toContain("PROMPT: Analyze the task");

    // Run second step
    const step2Result = await runCli(
      ctx,
      testRepoDir,
      ["task", "step", taskId],
      { CM_CLAUDE_COMMAND: scriptPath }
    );

    expect(step2Result.exitCode).toBe(0);
    expect(step2Result.stdout).toContain("Task completed");

    // Check log has second step
    log = await readMockLog(logPath);
    expect(log).toContain("PROMPT: Implement the changes");
  });

  it("runs remaining steps with task run command", async () => {
    const { scriptPath, logPath } = await createMockClaude(mockDir);

    // Create task without starting
    const createResult = await runCli(
      ctx,
      testRepoDir,
      ["task", "create", "Run test", "--no-start"],
      { CM_CLAUDE_COMMAND: scriptPath }
    );

    const match = createResult.stdout.match(/Task created: ([a-z]+-[a-z]+)/);
    const taskId = match![1];

    // Run all steps
    const runResult = await runCli(
      ctx,
      testRepoDir,
      ["task", "run", taskId],
      { CM_CLAUDE_COMMAND: scriptPath }
    );

    expect(runResult.exitCode).toBe(0);
    expect(runResult.stdout).toContain("Workflow completed");
    expect(runResult.stdout).toContain("Steps completed: 2");

    // Check both steps were executed
    const log = await readMockLog(logPath);
    expect(log).toContain("PROMPT: Analyze the task");
    expect(log).toContain("PROMPT: Implement the changes");
  });

  it("handles step failure correctly", async () => {
    const { scriptPath } = await createMockClaude(mockDir, {
      failOnStep: "Implement",
    });

    const result = await runCli(
      ctx,
      testRepoDir,
      ["task", "create", "Failing task"],
      { CM_CLAUDE_COMMAND: scriptPath }
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Workflow failed");
    expect(result.stdout).toContain("Steps completed: 1");

    // Check task status shows failure
    const match = result.stdout.match(/Task created: ([a-z]+-[a-z]+)/);
    const taskId = match![1];

    const statusResult = await runCli(ctx, testRepoDir, ["task", "status", taskId]);
    expect(statusResult.stdout).toContain("Status: failed");
  });

  it("pauses when step has no agent or prompt", async () => {
    const { scriptPath } = await createMockClaude(mockDir);

    const result = await runCli(
      ctx,
      testRepoDir,
      ["task", "create", "Needs input", "--workflow", "needs-input"],
      { CM_CLAUDE_COMMAND: scriptPath }
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Workflow paused");
    expect(result.stdout).toContain("cm task resume");

    // Check status shows paused
    const match = result.stdout.match(/Task created: ([a-z]+-[a-z]+)/);
    const taskId = match![1];

    const statusResult = await runCli(ctx, testRepoDir, ["task", "status", taskId]);
    expect(statusResult.stdout).toContain("Status: paused");
  });

  it("resumes paused task with user prompt", async () => {
    const { scriptPath, logPath } = await createMockClaude(mockDir);

    // Create task with workflow that needs input
    const createResult = await runCli(
      ctx,
      testRepoDir,
      ["task", "create", "Needs input", "--workflow", "needs-input"],
      { CM_CLAUDE_COMMAND: scriptPath }
    );

    const match = createResult.stdout.match(/Task created: ([a-z]+-[a-z]+)/);
    const taskId = match![1];

    // Resume with a prompt
    const resumeResult = await runCli(
      ctx,
      testRepoDir,
      ["task", "resume", taskId, "--prompt", "User provided this input"],
      { CM_CLAUDE_COMMAND: scriptPath }
    );

    expect(resumeResult.exitCode).toBe(0);
    expect(resumeResult.stdout).toContain("Workflow completed");

    // Check that Claude was called with user's prompt
    const log = await readMockLog(logPath);
    expect(log).toContain("PROMPT: User provided this input");
  });

  it("updates task status throughout execution", async () => {
    const { scriptPath } = await createMockClaude(mockDir);

    // Create task without starting
    const createResult = await runCli(
      ctx,
      testRepoDir,
      ["task", "create", "Status tracking", "--no-start"],
      { CM_CLAUDE_COMMAND: scriptPath }
    );

    const match = createResult.stdout.match(/Task created: ([a-z]+-[a-z]+)/);
    const taskId = match![1];

    // Check initial status
    let statusResult = await runCli(ctx, testRepoDir, ["task", "status", taskId]);
    expect(statusResult.stdout).toContain("Status: pending");
    expect(statusResult.stdout).toContain("0/2");

    // Run all steps
    await runCli(
      ctx,
      testRepoDir,
      ["task", "run", taskId],
      { CM_CLAUDE_COMMAND: scriptPath }
    );

    // Check final status
    statusResult = await runCli(ctx, testRepoDir, ["task", "status", taskId]);
    expect(statusResult.stdout).toContain("Status: completed");
    expect(statusResult.stdout).toContain("2/2");
  });

  it("task list shows created tasks", async () => {
    const { scriptPath } = await createMockClaude(mockDir);

    // Create a few tasks
    await runCli(
      ctx,
      testRepoDir,
      ["task", "create", "Task A", "--no-start"],
      { CM_CLAUDE_COMMAND: scriptPath }
    );
    await runCli(
      ctx,
      testRepoDir,
      ["task", "create", "Task B", "--workflow", "quick"],
      { CM_CLAUDE_COMMAND: scriptPath }
    );

    // List tasks
    const listResult = await runCli(ctx, testRepoDir, ["task", "list"]);

    expect(listResult.exitCode).toBe(0);
    expect(listResult.stdout).toContain("Task A");
    expect(listResult.stdout).toContain("Task B");
    expect(listResult.stdout).toContain("pending");
    expect(listResult.stdout).toContain("completed");
  });
});
