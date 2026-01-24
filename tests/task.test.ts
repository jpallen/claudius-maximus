import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { createTestContext, type TestContext } from "./helpers";
import { join } from "path";
import { mkdtemp, rm, chmod, mkdir } from "fs/promises";
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
    expect(result.stdout).toContain("Workflow completed successfully");
    expect(result.stdout).toContain("Step 1/2: plan");
    expect(result.stdout).toContain("Step 2/2: implement");

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
    expect(result.stdout).toContain("Workflow completed successfully");
    expect(result.stdout).toContain("Step 1/1: execute");

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
    expect(step1Result.stdout).toContain("Step completed");
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
    expect(runResult.stdout).toContain("Workflow completed successfully");

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
    expect(result.stdout).toContain("Step failed");

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
    expect(result.stdout).toContain("Task is paused");
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

describe("task completion tracking", () => {
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

  describe("cm task complete", () => {
    it("fails when not in task context", async () => {
      const result = await runCli(ctx, testRepoDir, ["task", "complete"]);

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("Not running in a task context");
    });

    it("fails when CM_TASK_ID is missing", async () => {
      const result = await runCli(ctx, testRepoDir, ["task", "complete"], {
        CM_STEP_NAME: "test-step",
        CM_STEP_ATTEMPT: "1",
      });

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("Not running in a task context");
    });

    it("fails when CM_STEP_NAME is missing", async () => {
      const result = await runCli(ctx, testRepoDir, ["task", "complete"], {
        CM_TASK_ID: "test-task",
        CM_STEP_ATTEMPT: "1",
      });

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("Not running in a task context");
    });

    it("fails when CM_STEP_ATTEMPT is missing", async () => {
      const result = await runCli(ctx, testRepoDir, ["task", "complete"], {
        CM_TASK_ID: "test-task",
        CM_STEP_NAME: "test-step",
      });

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("Not running in a task context");
    });

    it("fails with invalid attempt number", async () => {
      const result = await runCli(ctx, testRepoDir, ["task", "complete"], {
        CM_TASK_ID: "test-task",
        CM_STEP_NAME: "test-step",
        CM_STEP_ATTEMPT: "invalid",
      });

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("Invalid attempt number");
    });

    it("fails with zero attempt number", async () => {
      const result = await runCli(ctx, testRepoDir, ["task", "complete"], {
        CM_TASK_ID: "test-task",
        CM_STEP_NAME: "test-step",
        CM_STEP_ATTEMPT: "0",
      });

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("Invalid attempt number");
    });

    it("marks step complete when env vars are set", async () => {
      // First create a task with attempt file
      const tasksDir = join(homedir(), ".cm", "tasks");
      const taskId = "test-task";
      const stepName = "test-step";
      const attemptDir = join(tasksDir, taskId, "steps", stepName);
      await mkdir(attemptDir, { recursive: true });

      // Create task.json
      const taskJson = {
        id: taskId,
        description: "Test task",
        workflow: "default",
        status: "running",
        worktreePath: testRepoDir,
        repoPath: testRepoDir,
        currentStep: 0,
        steps: [{ name: stepName, status: "running", currentAttempt: 1 }],
        createdAt: new Date().toISOString(),
      };
      await Bun.write(
        join(tasksDir, taskId, "task.json"),
        JSON.stringify(taskJson)
      );

      // Create attempt file
      const attemptData = {
        attemptNumber: 1,
        status: "running",
        startedAt: new Date().toISOString(),
      };
      await Bun.write(
        join(attemptDir, "attempt-1.json"),
        JSON.stringify(attemptData)
      );

      // Run complete with env vars
      const result = await runCli(
        ctx,
        testRepoDir,
        ["task", "complete", "--message", "All done"],
        {
          CM_TASK_ID: taskId,
          CM_STEP_NAME: stepName,
          CM_STEP_ATTEMPT: "1",
        }
      );

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("marked complete");

      // Verify attempt file was updated
      const updatedAttempt = JSON.parse(
        await Bun.file(join(attemptDir, "attempt-1.json")).text()
      );
      expect(updatedAttempt.explicitlyCompleted).toBe(true);
      expect(updatedAttempt.completionMessage).toBe("All done");
      expect(updatedAttempt.status).toBe("completed");
      expect(updatedAttempt.completedAt).toBeDefined();
    });

    it("marks step complete without message", async () => {
      const tasksDir = join(homedir(), ".cm", "tasks");
      const taskId = "test-task-no-msg";
      const stepName = "test-step";
      const attemptDir = join(tasksDir, taskId, "steps", stepName);
      await mkdir(attemptDir, { recursive: true });

      // Create task.json
      const taskJson = {
        id: taskId,
        description: "Test task",
        workflow: "default",
        status: "running",
        worktreePath: testRepoDir,
        repoPath: testRepoDir,
        currentStep: 0,
        steps: [{ name: stepName, status: "running", currentAttempt: 1 }],
        createdAt: new Date().toISOString(),
      };
      await Bun.write(
        join(tasksDir, taskId, "task.json"),
        JSON.stringify(taskJson)
      );

      // Create attempt file
      const attemptData = {
        attemptNumber: 1,
        status: "running",
        startedAt: new Date().toISOString(),
      };
      await Bun.write(
        join(attemptDir, "attempt-1.json"),
        JSON.stringify(attemptData)
      );

      // Run complete without message
      const result = await runCli(ctx, testRepoDir, ["task", "complete"], {
        CM_TASK_ID: taskId,
        CM_STEP_NAME: stepName,
        CM_STEP_ATTEMPT: "1",
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("marked complete");

      // Verify attempt file was updated
      const updatedAttempt = JSON.parse(
        await Bun.file(join(attemptDir, "attempt-1.json")).text()
      );
      expect(updatedAttempt.explicitlyCompleted).toBe(true);
      expect(updatedAttempt.completionMessage).toBeUndefined();
    });

    it("updates task.json step status when marking complete", async () => {
      const tasksDir = join(homedir(), ".cm", "tasks");
      const taskId = "test-task-status";
      const stepName = "test-step";
      const attemptDir = join(tasksDir, taskId, "steps", stepName);
      await mkdir(attemptDir, { recursive: true });

      // Create task.json
      const taskJson = {
        id: taskId,
        description: "Test task",
        workflow: "default",
        status: "running",
        worktreePath: testRepoDir,
        repoPath: testRepoDir,
        currentStep: 0,
        steps: [{ name: stepName, status: "running", currentAttempt: 1 }],
        createdAt: new Date().toISOString(),
      };
      await Bun.write(
        join(tasksDir, taskId, "task.json"),
        JSON.stringify(taskJson)
      );

      // Create attempt file
      const attemptData = {
        attemptNumber: 1,
        status: "running",
        startedAt: new Date().toISOString(),
      };
      await Bun.write(
        join(attemptDir, "attempt-1.json"),
        JSON.stringify(attemptData)
      );

      // Run complete
      await runCli(ctx, testRepoDir, ["task", "complete", "-m", "Done"], {
        CM_TASK_ID: taskId,
        CM_STEP_NAME: stepName,
        CM_STEP_ATTEMPT: "1",
      });

      // Verify task.json was updated
      const updatedTask = JSON.parse(
        await Bun.file(join(tasksDir, taskId, "task.json")).text()
      );
      expect(updatedTask.steps[0].status).toBe("completed");
    });
  });

  describe("cm task fail", () => {
    it("fails when not in task context", async () => {
      const result = await runCli(ctx, testRepoDir, [
        "task",
        "fail",
        "--reason",
        "Something broke",
      ]);

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("Not running in a task context");
    });

    it("requires --reason flag", async () => {
      const result = await runCli(ctx, testRepoDir, ["task", "fail"], {
        CM_TASK_ID: "test-task",
        CM_STEP_NAME: "test-step",
        CM_STEP_ATTEMPT: "1",
      });

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("required");
    });

    it("marks step failed when env vars are set", async () => {
      // First create a task with attempt file
      const tasksDir = join(homedir(), ".cm", "tasks");
      const taskId = "test-task-fail";
      const stepName = "test-step";
      const attemptDir = join(tasksDir, taskId, "steps", stepName);
      await mkdir(attemptDir, { recursive: true });

      // Create task.json
      const taskJson = {
        id: taskId,
        description: "Test task",
        workflow: "default",
        status: "running",
        worktreePath: testRepoDir,
        repoPath: testRepoDir,
        currentStep: 0,
        steps: [{ name: stepName, status: "running", currentAttempt: 1 }],
        createdAt: new Date().toISOString(),
      };
      await Bun.write(
        join(tasksDir, taskId, "task.json"),
        JSON.stringify(taskJson)
      );

      // Create attempt file
      const attemptData = {
        attemptNumber: 1,
        status: "running",
        startedAt: new Date().toISOString(),
      };
      await Bun.write(
        join(attemptDir, "attempt-1.json"),
        JSON.stringify(attemptData)
      );

      // Run fail with env vars
      const result = await runCli(
        ctx,
        testRepoDir,
        ["task", "fail", "--reason", "Something broke"],
        {
          CM_TASK_ID: taskId,
          CM_STEP_NAME: stepName,
          CM_STEP_ATTEMPT: "1",
        }
      );

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("marked failed");

      // Verify attempt file was updated
      const updatedAttempt = JSON.parse(
        await Bun.file(join(attemptDir, "attempt-1.json")).text()
      );
      expect(updatedAttempt.explicitlyFailed).toBe(true);
      expect(updatedAttempt.error).toBe("Something broke");
      expect(updatedAttempt.status).toBe("failed");
      expect(updatedAttempt.completedAt).toBeDefined();
    });

    it("updates task.json step status when marking failed", async () => {
      const tasksDir = join(homedir(), ".cm", "tasks");
      const taskId = "test-task-fail-status";
      const stepName = "test-step";
      const attemptDir = join(tasksDir, taskId, "steps", stepName);
      await mkdir(attemptDir, { recursive: true });

      // Create task.json
      const taskJson = {
        id: taskId,
        description: "Test task",
        workflow: "default",
        status: "running",
        worktreePath: testRepoDir,
        repoPath: testRepoDir,
        currentStep: 0,
        steps: [{ name: stepName, status: "running", currentAttempt: 1 }],
        createdAt: new Date().toISOString(),
      };
      await Bun.write(
        join(tasksDir, taskId, "task.json"),
        JSON.stringify(taskJson)
      );

      // Create attempt file
      const attemptData = {
        attemptNumber: 1,
        status: "running",
        startedAt: new Date().toISOString(),
      };
      await Bun.write(
        join(attemptDir, "attempt-1.json"),
        JSON.stringify(attemptData)
      );

      // Run fail
      await runCli(
        ctx,
        testRepoDir,
        ["task", "fail", "-r", "Test failure"],
        {
          CM_TASK_ID: taskId,
          CM_STEP_NAME: stepName,
          CM_STEP_ATTEMPT: "1",
        }
      );

      // Verify task.json was updated
      const updatedTask = JSON.parse(
        await Bun.file(join(tasksDir, taskId, "task.json")).text()
      );
      expect(updatedTask.steps[0].status).toBe("failed");
    });
  });

  describe("cm system stop-hook", () => {
    it("allows exit when not in task context", async () => {
      const result = await runCli(ctx, testRepoDir, ["system", "stop-hook"]);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("");
    });

    it("allows exit when only CM_TASK_ID is set", async () => {
      const result = await runCli(ctx, testRepoDir, ["system", "stop-hook"], {
        CM_TASK_ID: "test-task",
      });

      expect(result.exitCode).toBe(0);
    });

    it("allows exit when CM_STEP_ATTEMPT is invalid", async () => {
      const result = await runCli(ctx, testRepoDir, ["system", "stop-hook"], {
        CM_TASK_ID: "test-task",
        CM_STEP_NAME: "test-step",
        CM_STEP_ATTEMPT: "invalid",
      });

      expect(result.exitCode).toBe(0);
    });

    it("allows exit when step is marked complete", async () => {
      // Create task with completed attempt
      const tasksDir = join(homedir(), ".cm", "tasks");
      const taskId = "test-hook-complete";
      const stepName = "test-step";
      const attemptDir = join(tasksDir, taskId, "steps", stepName);
      await mkdir(attemptDir, { recursive: true });

      // Create completed attempt file
      const attemptData = {
        attemptNumber: 1,
        status: "completed",
        startedAt: new Date().toISOString(),
        explicitlyCompleted: true,
      };
      await Bun.write(
        join(attemptDir, "attempt-1.json"),
        JSON.stringify(attemptData)
      );

      const result = await runCli(ctx, testRepoDir, ["system", "stop-hook"], {
        CM_TASK_ID: taskId,
        CM_STEP_NAME: stepName,
        CM_STEP_ATTEMPT: "1",
      });

      expect(result.exitCode).toBe(0);
    });

    it("allows exit when step is marked failed", async () => {
      const tasksDir = join(homedir(), ".cm", "tasks");
      const taskId = "test-hook-failed";
      const stepName = "test-step";
      const attemptDir = join(tasksDir, taskId, "steps", stepName);
      await mkdir(attemptDir, { recursive: true });

      // Create failed attempt file
      const attemptData = {
        attemptNumber: 1,
        status: "failed",
        startedAt: new Date().toISOString(),
        explicitlyFailed: true,
        error: "Test failure",
      };
      await Bun.write(
        join(attemptDir, "attempt-1.json"),
        JSON.stringify(attemptData)
      );

      const result = await runCli(ctx, testRepoDir, ["system", "stop-hook"], {
        CM_TASK_ID: taskId,
        CM_STEP_NAME: stepName,
        CM_STEP_ATTEMPT: "1",
      });

      expect(result.exitCode).toBe(0);
    });

    it("blocks exit when step is not marked", async () => {
      // Create task with running (not completed) attempt
      const tasksDir = join(homedir(), ".cm", "tasks");
      const taskId = "test-hook-block";
      const stepName = "test-step";
      const attemptDir = join(tasksDir, taskId, "steps", stepName);
      await mkdir(attemptDir, { recursive: true });

      // Create running attempt file (not marked complete)
      const attemptData = {
        attemptNumber: 1,
        status: "running",
        startedAt: new Date().toISOString(),
      };
      await Bun.write(
        join(attemptDir, "attempt-1.json"),
        JSON.stringify(attemptData)
      );

      const result = await runCli(ctx, testRepoDir, ["system", "stop-hook"], {
        CM_TASK_ID: taskId,
        CM_STEP_NAME: stepName,
        CM_STEP_ATTEMPT: "1",
      });

      expect(result.exitCode).toBe(2);
      expect(result.stdout).toContain("block");
      expect(result.stdout).toContain("not marked complete");
      expect(result.stdout).toContain("cm task complete");
      expect(result.stdout).toContain("cm task fail");
    });

    it("blocks exit when attempt file does not exist", async () => {
      const result = await runCli(ctx, testRepoDir, ["system", "stop-hook"], {
        CM_TASK_ID: "nonexistent-task",
        CM_STEP_NAME: "test-step",
        CM_STEP_ATTEMPT: "1",
      });

      expect(result.exitCode).toBe(2);
      expect(result.stdout).toContain("block");
      expect(result.stdout).toContain("Cannot verify step completion");
    });

    it("outputs valid JSON when blocking", async () => {
      const tasksDir = join(homedir(), ".cm", "tasks");
      const taskId = "test-hook-json";
      const stepName = "test-step";
      const attemptDir = join(tasksDir, taskId, "steps", stepName);
      await mkdir(attemptDir, { recursive: true });

      const attemptData = {
        attemptNumber: 1,
        status: "running",
        startedAt: new Date().toISOString(),
      };
      await Bun.write(
        join(attemptDir, "attempt-1.json"),
        JSON.stringify(attemptData)
      );

      const result = await runCli(ctx, testRepoDir, ["system", "stop-hook"], {
        CM_TASK_ID: taskId,
        CM_STEP_NAME: stepName,
        CM_STEP_ATTEMPT: "1",
      });

      // Should be valid JSON
      const parsed = JSON.parse(result.stdout);
      expect(parsed.decision).toBe("block");
      expect(parsed.reason).toContain("not marked complete");
    });
  });
});

describe("completion tracking integration", () => {
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

  /**
   * Create a mock Claude that calls cm task complete
   */
  async function createCompletingMockClaude(
    baseDir: string,
    options: {
      completionMessage?: string;
      failWithReason?: string;
    } = {}
  ): Promise<{ scriptPath: string; logPath: string }> {
    const scriptPath = join(baseDir, "mock-claude-completing");
    const logPath = join(baseDir, "claude-calls.log");
    const cliEntry = join(import.meta.dir, "..", "src", "index.ts");

    const { completionMessage, failWithReason } = options;

    // Create a shell script that calls cm task complete/fail
    const script = `#!/bin/bash
# Mock Claude CLI that marks steps complete

echo "CALL: $@" >> "${logPath}"

# Parse arguments
PROMPT=""
APPEND_SYSTEM=""
while [[ $# -gt 0 ]]; do
  case $1 in
    -p)
      PROMPT="$2"
      shift 2
      ;;
    --append-system-prompt)
      APPEND_SYSTEM="$2"
      shift 2
      ;;
    *)
      shift
      ;;
  esac
done

echo "PROMPT: $PROMPT" >> "${logPath}"
echo "APPEND_SYSTEM: $APPEND_SYSTEM" >> "${logPath}"
echo "ENV CM_TASK_ID: $CM_TASK_ID" >> "${logPath}"
echo "ENV CM_STEP_NAME: $CM_STEP_NAME" >> "${logPath}"
echo "ENV CM_STEP_ATTEMPT: $CM_STEP_ATTEMPT" >> "${logPath}"
echo "---" >> "${logPath}"

# Call cm task complete or fail
${
  failWithReason
    ? `bun run "${cliEntry}" task fail --reason "${failWithReason}"`
    : `bun run "${cliEntry}" task complete ${completionMessage ? `--message "${completionMessage}"` : ""}`
}

# Output JSON result
echo '{"result": "Task handled"}'
exit 0
`;

    await Bun.write(scriptPath, script);
    await chmod(scriptPath, 0o755);
    await Bun.write(logPath, "");

    return { scriptPath, logPath };
  }

  it("creates attempt files during step execution", async () => {
    const { scriptPath } = await createMockClaude(mockDir);

    // Create and run a task
    const createResult = await runCli(
      ctx,
      testRepoDir,
      ["task", "create", "Test attempt files", "--workflow", "quick"],
      { CM_CLAUDE_COMMAND: scriptPath }
    );

    expect(createResult.exitCode).toBe(0);

    // Extract task ID
    const match = createResult.stdout.match(/Task created: ([a-z]+-[a-z]+)/);
    const taskId = match![1];

    // Check that attempt file was created
    const tasksDir = join(homedir(), ".cm", "tasks");
    const attemptFile = Bun.file(
      join(tasksDir, taskId, "steps", "execute", "attempt-1.json")
    );
    expect(await attemptFile.exists()).toBe(true);

    const attemptData = JSON.parse(await attemptFile.text());
    expect(attemptData.attemptNumber).toBe(1);
    expect(attemptData.startedAt).toBeDefined();
  });

  it("passes environment variables to Claude subprocess", async () => {
    const { scriptPath, logPath } = await createCompletingMockClaude(mockDir, {
      completionMessage: "Done via env",
    });

    const createResult = await runCli(
      ctx,
      testRepoDir,
      ["task", "create", "Test env vars", "--workflow", "quick"],
      { CM_CLAUDE_COMMAND: scriptPath }
    );

    expect(createResult.exitCode).toBe(0);

    // Check the log to verify env vars were passed
    const log = await readMockLog(logPath);
    expect(log).toContain("ENV CM_TASK_ID:");
    expect(log).toContain("ENV CM_STEP_NAME: execute");
    expect(log).toContain("ENV CM_STEP_ATTEMPT: 1");
  });

  it("passes append-system-prompt to Claude", async () => {
    const { scriptPath, logPath } = await createCompletingMockClaude(mockDir);

    await runCli(
      ctx,
      testRepoDir,
      ["task", "create", "Test system prompt", "--workflow", "quick"],
      { CM_CLAUDE_COMMAND: scriptPath }
    );

    const log = await readMockLog(logPath);
    expect(log).toContain("APPEND_SYSTEM:");
    expect(log).toContain("Task Completion");
    expect(log).toContain("cm task complete");
    expect(log).toContain("cm task fail");
  });

  it("workflow succeeds when Claude calls cm task complete", async () => {
    const { scriptPath } = await createCompletingMockClaude(mockDir, {
      completionMessage: "Successfully completed the task",
    });

    const result = await runCli(
      ctx,
      testRepoDir,
      ["task", "create", "Test complete flow", "--workflow", "quick"],
      { CM_CLAUDE_COMMAND: scriptPath }
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Workflow completed");

    // Check attempt file shows explicit completion
    const match = result.stdout.match(/Task created: ([a-z]+-[a-z]+)/);
    const taskId = match![1];
    const tasksDir = join(homedir(), ".cm", "tasks");
    const attemptData = JSON.parse(
      await Bun.file(
        join(tasksDir, taskId, "steps", "execute", "attempt-1.json")
      ).text()
    );
    expect(attemptData.explicitlyCompleted).toBe(true);
    expect(attemptData.completionMessage).toBe("Successfully completed the task");
  });

  it("workflow fails when Claude calls cm task fail", async () => {
    const { scriptPath } = await createCompletingMockClaude(mockDir, {
      failWithReason: "Could not complete the task",
    });

    const result = await runCli(
      ctx,
      testRepoDir,
      ["task", "create", "Test fail flow", "--workflow", "quick"],
      { CM_CLAUDE_COMMAND: scriptPath }
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Workflow failed");

    // Check attempt file shows explicit failure
    const match = result.stdout.match(/Task created: ([a-z]+-[a-z]+)/);
    const taskId = match![1];
    const tasksDir = join(homedir(), ".cm", "tasks");
    const attemptData = JSON.parse(
      await Bun.file(
        join(tasksDir, taskId, "steps", "execute", "attempt-1.json")
      ).text()
    );
    expect(attemptData.explicitlyFailed).toBe(true);
    expect(attemptData.error).toBe("Could not complete the task");
  });

  it("sets up stop hook in worktree", async () => {
    const { scriptPath } = await createMockClaude(mockDir);

    // Create task to trigger hook setup
    const createResult = await runCli(
      ctx,
      testRepoDir,
      ["task", "create", "Test hook setup", "--workflow", "quick"],
      { CM_CLAUDE_COMMAND: scriptPath }
    );

    expect(createResult.exitCode).toBe(0);

    // Extract task ID and find worktree
    const match = createResult.stdout.match(/Task created: ([a-z]+-[a-z]+)/);
    const taskId = match![1];
    const worktreePath = join(testRepoDir, ".cm-worktrees", taskId);

    // Check that .claude/settings.json was created with stop hook
    const settingsFile = Bun.file(join(worktreePath, ".claude", "settings.json"));
    expect(await settingsFile.exists()).toBe(true);

    const settings = JSON.parse(await settingsFile.text());
    expect(settings.hooks).toBeDefined();
    expect(settings.hooks.Stop).toBeDefined();
    expect(settings.hooks.Stop.length).toBeGreaterThan(0);

    // Check hook has the right command
    const stopHook = settings.hooks.Stop[0];
    expect(stopHook.matcher).toBe("*");
    expect(stopHook.hooks[0].command).toBe("cm system stop-hook");
  });

  it("preserves existing settings when setting up stop hook", async () => {
    const { scriptPath } = await createMockClaude(mockDir);

    // Create task without starting to get worktree
    const createResult = await runCli(
      ctx,
      testRepoDir,
      ["task", "create", "Test preserve settings", "--no-start"],
      { CM_CLAUDE_COMMAND: scriptPath }
    );

    const match = createResult.stdout.match(/Task created: ([a-z]+-[a-z]+)/);
    const taskId = match![1];
    const worktreePath = join(testRepoDir, ".cm-worktrees", taskId);

    // Create existing settings
    const claudeDir = join(worktreePath, ".claude");
    await mkdir(claudeDir, { recursive: true });
    const existingSettings = {
      someExistingSetting: true,
      hooks: {
        PreToolUse: [{ matcher: "*", hooks: [{ type: "command", command: "echo test" }] }],
      },
    };
    await Bun.write(
      join(claudeDir, "settings.json"),
      JSON.stringify(existingSettings)
    );

    // Run the task to trigger hook setup
    await runCli(
      ctx,
      testRepoDir,
      ["task", "run", taskId],
      { CM_CLAUDE_COMMAND: scriptPath }
    );

    // Check that existing settings are preserved
    const settings = JSON.parse(
      await Bun.file(join(claudeDir, "settings.json")).text()
    );
    expect(settings.someExistingSetting).toBe(true);
    expect(settings.hooks.PreToolUse).toBeDefined();
    expect(settings.hooks.Stop).toBeDefined();
  });

  it("does not duplicate stop hook on multiple runs", async () => {
    const { scriptPath } = await createMockClaude(mockDir);

    // Create task
    const createResult = await runCli(
      ctx,
      testRepoDir,
      ["task", "create", "Test no duplicate", "--no-start"],
      { CM_CLAUDE_COMMAND: scriptPath }
    );

    const match = createResult.stdout.match(/Task created: ([a-z]+-[a-z]+)/);
    const taskId = match![1];
    const worktreePath = join(testRepoDir, ".cm-worktrees", taskId);

    // Run step to trigger first hook setup
    await runCli(
      ctx,
      testRepoDir,
      ["task", "step", taskId],
      { CM_CLAUDE_COMMAND: scriptPath }
    );

    // Get initial hook count
    let settings = JSON.parse(
      await Bun.file(join(worktreePath, ".claude", "settings.json")).text()
    );
    const initialHookCount = settings.hooks.Stop.length;

    // Run another step
    await runCli(
      ctx,
      testRepoDir,
      ["task", "step", taskId],
      { CM_CLAUDE_COMMAND: scriptPath }
    );

    // Hook count should be the same
    settings = JSON.parse(
      await Bun.file(join(worktreePath, ".claude", "settings.json")).text()
    );
    expect(settings.hooks.Stop.length).toBe(initialHookCount);
  });

  it("tracks multiple attempts on the same step", async () => {
    const { scriptPath } = await createMockClaude(mockDir, {
      failOnStep: "plan",
    });

    // Create task - first attempt will fail on plan step
    const createResult = await runCli(
      ctx,
      testRepoDir,
      ["task", "create", "Test multiple attempts", "--no-start"],
      { CM_CLAUDE_COMMAND: scriptPath }
    );

    const match = createResult.stdout.match(/Task created: ([a-z]+-[a-z]+)/);
    const taskId = match![1];

    // Run first step - will fail
    await runCli(
      ctx,
      testRepoDir,
      ["task", "step", taskId],
      { CM_CLAUDE_COMMAND: scriptPath }
    );

    // Check attempt-1 was created
    const tasksDir = join(homedir(), ".cm", "tasks");
    const attempt1File = Bun.file(
      join(tasksDir, taskId, "steps", "plan", "attempt-1.json")
    );
    expect(await attempt1File.exists()).toBe(true);
  });
});
