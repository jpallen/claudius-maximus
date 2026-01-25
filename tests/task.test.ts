import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { createTestContext, createSimpleMockClaude, type TestContext } from "./helpers";
import { join } from "path";
import { mkdtemp, rm, chmod, mkdir } from "fs/promises";
import { tmpdir } from "os";

// CLI entry point path for running cm commands from mock
const CLI_ENTRY = join(import.meta.dir, "..", "src", "index.ts");

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
    /** For orchestrator mode: sequence of steps to run before completing */
    orchestratorSteps?: string[];
  } = {}
): Promise<{ scriptPath: string; logPath: string }> {
  const scriptPath = join(baseDir, "mock-claude");
  const logPath = join(baseDir, "claude-calls.log");
  const stepCountPath = join(baseDir, "step-count");

  const {
    output = "Task completed successfully",
    exitCode = 0,
    logArgs = true,
    failOnStep,
    orchestratorSteps = [],
  } = options;

  // Use bun run with the CLI entry point instead of 'cm'
  const cmCommand = `bun run "${CLI_ENTRY}"`;

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
    *)
      shift
      ;;
  esac
done

# Log parsed values
${logArgs ? `echo "PROMPT: $PROMPT" >> "${logPath}"` : ""}
${logArgs ? `echo "MODEL: $MODEL" >> "${logPath}"` : ""}
${logArgs ? `echo "CM_TASK_ID: $CM_TASK_ID" >> "${logPath}"` : ""}
${logArgs ? `echo "CM_STEP_NAME: $CM_STEP_NAME" >> "${logPath}"` : ""}
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

# Check if this is an orchestrator call or a step call
if [[ -n "$CM_TASK_ID" && -z "$CM_STEP_NAME" ]]; then
  # Orchestrator call - need to make a decision
  # Track which iteration we're on
  if [[ -f "${stepCountPath}" ]]; then
    COUNT=$(cat "${stepCountPath}")
  else
    COUNT=0
  fi

  # Increment counter
  NEW_COUNT=$((COUNT + 1))
  echo "$NEW_COUNT" > "${stepCountPath}"

  STEPS=(${orchestratorSteps.map(s => `"${s}"`).join(" ")})
  TOTAL_STEPS=${orchestratorSteps.length}

  if [[ $COUNT -lt $TOTAL_STEPS ]]; then
    # Run the next step
    NEXT_STEP="\${STEPS[$COUNT]}"
    ${cmCommand} system orchestrator-decision --step "$NEXT_STEP" --reason "Mock orchestrator running step $((COUNT + 1))"
  else
    # All steps done, complete the workflow
    ${cmCommand} system orchestrator-decision --complete --summary "Mock workflow completed after $TOTAL_STEPS steps"
  fi

  echo '{"result": "Orchestrator decision made"}'
  exit 0

elif [[ -n "$CM_STEP_NAME" ]]; then
  # Step call - mark as complete
  ${cmCommand} task complete --message "Mock step $CM_STEP_NAME completed: ${output}"
  echo '{"result": "${output}"}'
  exit ${exitCode}

else
  # Regular call without task context
  echo '{"result": "${output}"}'
  exit ${exitCode}
fi
`;

  await Bun.write(scriptPath, script);
  await chmod(scriptPath, 0o755);

  // Initialize empty log file and step counter
  await Bun.write(logPath, "");
  await Bun.write(stepCountPath, "0");

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

  // Create a simple cm.yml with orchestrator prompts
  const cmYml = `version: "1"

workflows:
  default:
    prompt: |
      Plan the task first, then implement it.
      Ask for user input if anything is unclear.
    steps:
      - name: plan
        model: sonnet
        prompt: "Analyze the task and create an implementation plan."
      - name: implement
        model: sonnet
        prompt: "Implement the changes."

  quick:
    prompt: Execute the task quickly in one step.
    steps:
      - name: execute
        model: haiku
        prompt: "Execute the task quickly."

  needs-input:
    prompt: |
      Gather information from the user before proceeding.
      Ask clarifying questions as needed.
    steps:
      - name: gather
        prompt: "Gather requirements from user."
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


describe("task command", () => {
  let ctx: TestContext;
  let testRepoDir: string;
  let mockDir: string;
  let mockClaudePath: string;

  beforeEach(async () => {
    ctx = await createTestContext();
    testRepoDir = await createTestRepo();
    // Create a simple mock Claude for task creation (branch name generation)
    mockDir = await mkdtemp(join(tmpdir(), "cm-mock-simple-"));
    const { scriptPath } = await createSimpleMockClaude(mockDir, {
      output: "task-from-mock",
    });
    mockClaudePath = scriptPath;
  });

  afterEach(async () => {
    await ctx.cleanup();
    await rm(testRepoDir, { recursive: true, force: true });
    await rm(mockDir, { recursive: true, force: true });
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
      ], { CM_CLAUDE_COMMAND: mockClaudePath });

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
      ], { CM_CLAUDE_COMMAND: mockClaudePath });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain(".cm-worktrees/");
    });

    it("uses custom workflow when specified", async () => {
      const result = await runCli(ctx, testRepoDir, [
        "task", "create", "Quick test", "--workflow", "quick", "--no-start"
      ], { CM_CLAUDE_COMMAND: mockClaudePath });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("Workflow: quick");
      expect(result.stdout).toContain("1 steps");
    });

    it("fails with invalid workflow name", async () => {
      const result = await runCli(ctx, testRepoDir, [
        "task", "create", "Test task", "--workflow", "nonexistent", "--no-start"
      ], { CM_CLAUDE_COMMAND: mockClaudePath });

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
      ], { CM_CLAUDE_COMMAND: mockClaudePath });

      expect(createResult.exitCode).toBe(0);

      // Extract task ID from output - support both old and new ID formats
      const match = createResult.stdout.match(/Task created: ([a-z][a-z0-9-]+)/);
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
      ], { CM_CLAUDE_COMMAND: mockClaudePath });

      const match = createResult.stdout.match(/Task created: ([a-z][a-z0-9-]+)/);
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
      ], { CM_CLAUDE_COMMAND: mockClaudePath });

      const match = createResult.stdout.match(/Task created: ([a-z][a-z0-9-]+)/);
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

      const result = await runCli(ctx, emptyRepoDir, ["task", "create", "Test", "--no-start"], { CM_CLAUDE_COMMAND: mockClaudePath });

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("No cm.yml found");

      await rm(emptyRepoDir, { recursive: true, force: true });
    });

    it("fails when not in a git repository", async () => {
      const nonGitDir = await mkdtemp(join(tmpdir(), "cm-non-git-"));

      const result = await runCli(ctx, nonGitDir, ["task", "create", "Test", "--no-start"], { CM_CLAUDE_COMMAND: mockClaudePath });

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
    const mockDir = await mkdtemp(join(tmpdir(), "cm-mock-id-"));
    const { scriptPath: mockClaudePath } = await createSimpleMockClaude(mockDir, {
      output: "task-from-mock",
    });
    const ids: string[] = [];

    try {
      // Create multiple tasks
      for (let i = 0; i < 5; i++) {
        const result = await runCli(ctx, testRepoDir, [
          "task", "create", `Task ${i}`, "--no-start"
        ], { CM_CLAUDE_COMMAND: mockClaudePath });

        expect(result.exitCode).toBe(0);

        // Match both old adjective-noun and new semantic formats
        const match = result.stdout.match(/Task created: ([a-z][a-z0-9-]+)/);
        expect(match).toBeTruthy();
        ids.push(match![1]);
      }

      // All IDs should be unique
      const uniqueIds = new Set(ids);
      expect(uniqueIds.size).toBe(ids.length);
    } finally {
      await ctx.cleanup();
      await rm(testRepoDir, { recursive: true, force: true });
      await rm(mockDir, { recursive: true, force: true });
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
  });

  it("executes all workflow steps with mock Claude", async () => {
    // Mock orchestrator will run plan then implement steps
    const { scriptPath, logPath } = await createMockClaude(mockDir, {
      orchestratorSteps: ["plan", "implement"],
    });

    // Create and run a task with mock Claude
    const result = await runCli(
      ctx,
      testRepoDir,
      ["task", "create", "Test full workflow"],
      { CM_CLAUDE_COMMAND: scriptPath }
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Workflow completed");
    expect(result.stdout).toContain("Executing step: plan");
    expect(result.stdout).toContain("Executing step: implement");

    // Verify Claude was called
    const log = await readMockLog(logPath);
    expect(log).toContain("CM_TASK_ID:");
  });

  it("executes single-step workflow", async () => {
    const { scriptPath, logPath } = await createMockClaude(mockDir, {
      orchestratorSteps: ["execute"],
    });

    const result = await runCli(
      ctx,
      testRepoDir,
      ["task", "create", "Quick task", "--workflow", "quick"],
      { CM_CLAUDE_COMMAND: scriptPath }
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Workflow completed");
    expect(result.stdout).toContain("Executing step: execute");

    const log = await readMockLog(logPath);
    expect(log).toContain("CM_TASK_ID:");
  });

  it("runs remaining steps with task run command", async () => {
    const { scriptPath, logPath } = await createMockClaude(mockDir, {
      orchestratorSteps: ["plan", "implement"],
    });

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

    // Check both steps were executed (output goes to stdout)
    expect(runResult.stdout).toContain("Executing step: plan");
    expect(runResult.stdout).toContain("Executing step: implement");
  });

  it("handles orchestrator requesting user input", async () => {
    // Create a mock that requests input on first iteration
    const scriptPath = join(mockDir, "mock-claude-input");
    const logPath = join(mockDir, "claude-calls.log");
    const stepCountPath = join(mockDir, "step-count");
    const cmCommand = `bun run "${CLI_ENTRY}"`;

    const script = `#!/bin/bash
# Mock Claude that requests user input

echo "CALL: $@" >> "${logPath}"
echo "CM_TASK_ID: $CM_TASK_ID" >> "${logPath}"
echo "CM_STEP_NAME: $CM_STEP_NAME" >> "${logPath}"
echo "---" >> "${logPath}"

if [[ -n "$CM_TASK_ID" && -z "$CM_STEP_NAME" ]]; then
  # Orchestrator call - request user input
  ${cmCommand} system orchestrator-decision --need-input --question "What should I do next?"
  echo '{"result": "Requesting input"}'
  exit 0
elif [[ -n "$CM_STEP_NAME" ]]; then
  ${cmCommand} task complete --message "Step completed"
  echo '{"result": "Step done"}'
  exit 0
fi
`;

    await Bun.write(scriptPath, script);
    await chmod(scriptPath, 0o755);
    await Bun.write(logPath, "");
    await Bun.write(stepCountPath, "0");

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
    // Create a mock that requests input first time, then completes
    const scriptPath = join(mockDir, "mock-claude-resume");
    const logPath = join(mockDir, "claude-calls.log");
    const iterationPath = join(mockDir, "iteration");
    const cmCommand = `bun run "${CLI_ENTRY}"`;

    const script = `#!/bin/bash
echo "CALL: $@" >> "${logPath}"

# Track iteration
if [[ -f "${iterationPath}" ]]; then
  ITER=$(cat "${iterationPath}")
else
  ITER=0
fi
echo $((ITER + 1)) > "${iterationPath}"

if [[ -n "$CM_TASK_ID" && -z "$CM_STEP_NAME" ]]; then
  if [[ $ITER -eq 0 ]]; then
    # First call - request input
    ${cmCommand} system orchestrator-decision --need-input --question "What should I do?"
  else
    # After resume - complete
    ${cmCommand} system orchestrator-decision --complete --summary "Done after user input"
  fi
  exit 0
elif [[ -n "$CM_STEP_NAME" ]]; then
  ${cmCommand} task complete --message "Step done"
  exit 0
fi
`;

    await Bun.write(scriptPath, script);
    await chmod(scriptPath, 0o755);
    await Bun.write(logPath, "");
    await Bun.write(iterationPath, "0");

    // Create task with workflow that needs input
    const createResult = await runCli(
      ctx,
      testRepoDir,
      ["task", "create", "Needs input", "--workflow", "needs-input"],
      { CM_CLAUDE_COMMAND: scriptPath }
    );

    const match = createResult.stdout.match(/Task created: ([a-z]+-[a-z]+)/);
    const taskId = match![1];

    expect(createResult.stdout).toContain("Task is paused");

    // Resume with a prompt
    const resumeResult = await runCli(
      ctx,
      testRepoDir,
      ["task", "resume", taskId, "--prompt", "User provided this input"],
      { CM_CLAUDE_COMMAND: scriptPath }
    );

    expect(resumeResult.exitCode).toBe(0);
    expect(resumeResult.stdout).toContain("Workflow completed");
  });

  it("updates task status throughout execution", async () => {
    const { scriptPath } = await createMockClaude(mockDir, {
      orchestratorSteps: ["plan", "implement"],
    });

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
  });

  it("task list shows created tasks", async () => {
    const { scriptPath } = await createMockClaude(mockDir, {
      orchestratorSteps: ["execute"],
    });

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
      const tasksDir = join(ctx.configDir, "tasks");
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
      const tasksDir = join(ctx.configDir, "tasks");
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
      const tasksDir = join(ctx.configDir, "tasks");
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
      const tasksDir = join(ctx.configDir, "tasks");
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
      const tasksDir = join(ctx.configDir, "tasks");
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
      const tasksDir = join(ctx.configDir, "tasks");
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
      const tasksDir = join(ctx.configDir, "tasks");
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
      const tasksDir = join(ctx.configDir, "tasks");
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
      const tasksDir = join(ctx.configDir, "tasks");
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
  });

  /**
   * Create a mock Claude that handles orchestrator and step calls
   * - As orchestrator: runs the step
   * - As step: calls cm task complete/fail
   */
  async function createCompletingMockClaude(
    baseDir: string,
    options: {
      completionMessage?: string;
      failWithReason?: string;
      stepToRun?: string;  // Step name to run (default: "execute")
    } = {}
  ): Promise<{ scriptPath: string; logPath: string }> {
    const scriptPath = join(baseDir, "mock-claude-completing");
    const logPath = join(baseDir, "claude-calls.log");
    const iterationPath = join(baseDir, "iteration");
    const cliEntry = join(import.meta.dir, "..", "src", "index.ts");

    const { completionMessage, failWithReason, stepToRun = "execute" } = options;

    // Create a shell script that handles orchestrator and step calls
    const script = `#!/bin/bash
# Mock Claude CLI that handles orchestrator mode

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

# Check if this is an orchestrator call or a step call
if [[ -n "$CM_TASK_ID" && -z "$CM_STEP_NAME" ]]; then
  # Orchestrator call - track iteration
  if [[ -f "${iterationPath}" ]]; then
    ITER=$(cat "${iterationPath}")
  else
    ITER=0
  fi
  echo $((ITER + 1)) > "${iterationPath}"

  if [[ $ITER -eq 0 ]]; then
    # First iteration - run the step
    bun run "${cliEntry}" system orchestrator-decision --step "${stepToRun}" --reason "Running step"
  else
    # Step completed/failed - complete or fail the workflow
    ${
      failWithReason
        ? `bun run "${cliEntry}" system orchestrator-decision --fail --reason "Step failed: ${failWithReason}"`
        : `bun run "${cliEntry}" system orchestrator-decision --complete --summary "Workflow done"`
    }
  fi
  echo '{"result": "Orchestrator decision made"}'
  exit 0

elif [[ -n "$CM_STEP_NAME" ]]; then
  # Step call - call cm task complete or fail
  ${
    failWithReason
      ? `bun run "${cliEntry}" task fail --reason "${failWithReason}"`
      : `bun run "${cliEntry}" task complete ${completionMessage ? `--message "${completionMessage}"` : ""}`
  }
  echo '{"result": "Step handled"}'
  exit 0
fi

echo '{"result": "Unknown context"}'
exit 0
`;

    await Bun.write(scriptPath, script);
    await chmod(scriptPath, 0o755);
    await Bun.write(logPath, "");
    await Bun.write(iterationPath, "0");

    return { scriptPath, logPath };
  }

  it("creates attempt files during step execution", async () => {
    const { scriptPath } = await createMockClaude(mockDir, {
      orchestratorSteps: ["execute"],
    });

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
    const tasksDir = join(ctx.configDir, "tasks");
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
    const tasksDir = join(ctx.configDir, "tasks");
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
    const tasksDir = join(ctx.configDir, "tasks");
    const attemptData = JSON.parse(
      await Bun.file(
        join(tasksDir, taskId, "steps", "execute", "attempt-1.json")
      ).text()
    );
    expect(attemptData.explicitlyFailed).toBe(true);
    expect(attemptData.error).toBe("Could not complete the task");
  });

  it("sets up stop hook in worktree", async () => {
    const { scriptPath } = await createMockClaude(mockDir, {
      orchestratorSteps: ["execute"],
    });

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

    // Check hook has the right command (orchestrator or step hook)
    const stopHook = settings.hooks.Stop[0];
    expect(stopHook.matcher).toBe("*");
    // Could be either orchestrator or step hook depending on last execution
    const hookCommand = stopHook.hooks[0].command;
    expect(
      hookCommand === "cm system orchestrator-stop-hook" ||
      hookCommand === "cm system stop-hook"
    ).toBe(true);
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
    // Create a mock that pauses on first orchestrator call, then completes on resume
    const scriptPath = join(mockDir, "mock-claude-pause");
    const logPath = join(mockDir, "claude-calls.log");
    const iterationPath = join(mockDir, "iteration");
    const cmCommand = `bun run "${CLI_ENTRY}"`;

    const script = `#!/bin/bash
# Track iteration
if [[ -f "${iterationPath}" ]]; then
  ITER=$(cat "${iterationPath}")
else
  ITER=0
fi
echo $((ITER + 1)) > "${iterationPath}"

if [[ -n "$CM_TASK_ID" && -z "$CM_STEP_NAME" ]]; then
  if [[ $ITER -eq 0 ]]; then
    ${cmCommand} system orchestrator-decision --need-input --question "Continue?"
  else
    ${cmCommand} system orchestrator-decision --complete --summary "Done"
  fi
  exit 0
elif [[ -n "$CM_STEP_NAME" ]]; then
  ${cmCommand} task complete --message "Step done"
  exit 0
fi
`;

    await Bun.write(scriptPath, script);
    await chmod(scriptPath, 0o755);
    await Bun.write(logPath, "");
    await Bun.write(iterationPath, "0");

    // Create task - will pause on first orchestrator call
    const createResult = await runCli(
      ctx,
      testRepoDir,
      ["task", "create", "Test no duplicate", "--workflow", "quick"],
      { CM_CLAUDE_COMMAND: scriptPath }
    );

    const match = createResult.stdout.match(/Task created: ([a-z]+-[a-z]+)/);
    const taskId = match![1];
    const worktreePath = join(testRepoDir, ".cm-worktrees", taskId);

    // Get initial hook count after first run (paused)
    let settings = JSON.parse(
      await Bun.file(join(worktreePath, ".claude", "settings.json")).text()
    );
    const initialHookCount = settings.hooks.Stop.length;

    // Resume the task - triggers another hook setup
    await runCli(
      ctx,
      testRepoDir,
      ["task", "resume", taskId, "--prompt", "yes"],
      { CM_CLAUDE_COMMAND: scriptPath }
    );

    // Hook count should be the same (no duplicates)
    settings = JSON.parse(
      await Bun.file(join(worktreePath, ".claude", "settings.json")).text()
    );
    expect(settings.hooks.Stop.length).toBe(initialHookCount);
  });

  it("tracks step attempts through orchestrator", async () => {
    // Use the completing mock which runs execute step
    const { scriptPath } = await createCompletingMockClaude(mockDir, {
      completionMessage: "Step completed successfully",
    });

    // Create and run task - orchestrator will run execute step
    const createResult = await runCli(
      ctx,
      testRepoDir,
      ["task", "create", "Test attempt tracking", "--workflow", "quick"],
      { CM_CLAUDE_COMMAND: scriptPath }
    );

    expect(createResult.exitCode).toBe(0);

    const match = createResult.stdout.match(/Task created: ([a-z]+-[a-z]+)/);
    const taskId = match![1];

    // Check attempt-1 was created for the execute step
    const tasksDir = join(ctx.configDir, "tasks");
    const attempt1File = Bun.file(
      join(tasksDir, taskId, "steps", "execute", "attempt-1.json")
    );
    expect(await attempt1File.exists()).toBe(true);

    const attemptData = JSON.parse(await attempt1File.text());
    expect(attemptData.attemptNumber).toBe(1);
    expect(attemptData.explicitlyCompleted).toBe(true);
  });
});

describe("branch management", () => {
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

  describe("--branch option", () => {
    it("creates task from specified branch", async () => {
      // Create a new branch
      await Bun.spawn(["git", "checkout", "-b", "feature-branch"], {
        cwd: testRepoDir,
        stdout: "pipe",
        stderr: "pipe",
      }).exited;

      // Make a commit on the feature branch
      await Bun.write(join(testRepoDir, "feature.txt"), "feature content");
      await Bun.spawn(["git", "add", "feature.txt"], {
        cwd: testRepoDir,
        stdout: "pipe",
        stderr: "pipe",
      }).exited;
      await Bun.spawn(["git", "commit", "-m", "Add feature"], {
        cwd: testRepoDir,
        stdout: "pipe",
        stderr: "pipe",
      }).exited;

      // Go back to main/master
      await Bun.spawn(["git", "checkout", "-"], {
        cwd: testRepoDir,
        stdout: "pipe",
        stderr: "pipe",
      }).exited;

      // Create task from feature-branch
      const result = await runCli(ctx, testRepoDir, [
        "task", "create", "Test from branch", "--branch", "feature-branch", "--no-start"
      ]);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("Task created:");
      expect(result.stdout).toContain("Base branch: feature-branch");
    });

    it("fails with invalid branch name", async () => {
      const result = await runCli(ctx, testRepoDir, [
        "task", "create", "Test task", "--branch", "nonexistent-branch", "--no-start"
      ]);

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("Branch \"nonexistent-branch\" does not exist");
    });

    it("uses current branch when --branch not specified", async () => {
      const result = await runCli(ctx, testRepoDir, [
        "task", "create", "Test task", "--no-start"
      ]);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("Base branch:");
      // Should contain either main or master
      expect(
        result.stdout.includes("Base branch: main") ||
        result.stdout.includes("Base branch: master")
      ).toBe(true);
    });

    it("shows base branch in task status", async () => {
      const createResult = await runCli(ctx, testRepoDir, [
        "task", "create", "Test task", "--no-start"
      ]);

      const match = createResult.stdout.match(/Task created: ([a-z]+-[a-z]+)/);
      const taskId = match![1];

      const statusResult = await runCli(ctx, testRepoDir, ["task", "status", taskId]);

      expect(statusResult.exitCode).toBe(0);
      expect(statusResult.stdout).toContain("Base branch:");
    });
  });

  describe("task merge", () => {
    it("fails on non-completed task", async () => {
      const createResult = await runCli(ctx, testRepoDir, [
        "task", "create", "Test task", "--no-start"
      ]);

      const match = createResult.stdout.match(/Task created: ([a-z]+-[a-z]+)/);
      const taskId = match![1];

      const mergeResult = await runCli(ctx, testRepoDir, ["task", "merge", taskId]);

      expect(mergeResult.exitCode).toBe(0);
      expect(mergeResult.stdout).toContain("not completed");
      expect(mergeResult.stdout).toContain("pending");
    });

    it("handles no commits to merge", async () => {
      const { scriptPath } = await createMockClaude(mockDir);

      // Create and complete a task (quick workflow - single step)
      const createResult = await runCli(
        ctx,
        testRepoDir,
        ["task", "create", "Test merge", "--workflow", "quick"],
        { CM_CLAUDE_COMMAND: scriptPath }
      );

      expect(createResult.exitCode).toBe(0);

      const match = createResult.stdout.match(/Task created: ([a-z]+-[a-z]+)/);
      const taskId = match![1];

      // Task is completed but has no commits (mock Claude doesn't make any)
      const mergeResult = await runCli(ctx, testRepoDir, ["task", "merge", taskId]);

      expect(mergeResult.exitCode).toBe(0);
      expect(mergeResult.stdout).toContain("No commits to merge");
    });

    it("merges commits successfully", async () => {
      const { scriptPath } = await createMockClaude(mockDir);

      // Create and complete a task
      const createResult = await runCli(
        ctx,
        testRepoDir,
        ["task", "create", "Test merge with commits", "--workflow", "quick"],
        { CM_CLAUDE_COMMAND: scriptPath }
      );

      const match = createResult.stdout.match(/Task created: ([a-z]+-[a-z]+)/);
      const taskId = match![1];

      // Make a commit in the task worktree
      const worktreePath = join(testRepoDir, ".cm-worktrees", taskId);
      await Bun.write(join(worktreePath, "new-file.txt"), "new content");
      await Bun.spawn(["git", "add", "new-file.txt"], {
        cwd: worktreePath,
        stdout: "pipe",
        stderr: "pipe",
      }).exited;
      await Bun.spawn(["git", "commit", "-m", "Add new file from task"], {
        cwd: worktreePath,
        stdout: "pipe",
        stderr: "pipe",
      }).exited;

      // Merge the task
      const mergeResult = await runCli(ctx, testRepoDir, ["task", "merge", taskId]);

      expect(mergeResult.exitCode).toBe(0);
      expect(mergeResult.stdout).toContain("1 commit(s)");
      expect(mergeResult.stdout).toContain("Add new file from task");
      expect(mergeResult.stdout).toContain("Merged to");
      expect(mergeResult.stdout).toContain("successfully");
    });

    it("deletes task with --delete option", async () => {
      const { scriptPath } = await createMockClaude(mockDir);

      // Create and complete a task
      const createResult = await runCli(
        ctx,
        testRepoDir,
        ["task", "create", "Test merge delete", "--workflow", "quick"],
        { CM_CLAUDE_COMMAND: scriptPath }
      );

      const match = createResult.stdout.match(/Task created: ([a-z]+-[a-z]+)/);
      const taskId = match![1];

      // Make a commit in the task worktree
      const worktreePath = join(testRepoDir, ".cm-worktrees", taskId);
      await Bun.write(join(worktreePath, "another-file.txt"), "content");
      await Bun.spawn(["git", "add", "another-file.txt"], {
        cwd: worktreePath,
        stdout: "pipe",
        stderr: "pipe",
      }).exited;
      await Bun.spawn(["git", "commit", "-m", "Add another file"], {
        cwd: worktreePath,
        stdout: "pipe",
        stderr: "pipe",
      }).exited;

      // Merge with --delete
      const mergeResult = await runCli(ctx, testRepoDir, ["task", "merge", taskId, "--delete"]);

      expect(mergeResult.exitCode).toBe(0);
      expect(mergeResult.stdout).toContain("Merged to");
      expect(mergeResult.stdout).toContain("deleted");

      // Verify task is gone
      const statusResult = await runCli(ctx, testRepoDir, ["task", "status", taskId]);
      expect(statusResult.exitCode).toBe(1);
      expect(statusResult.stderr).toContain("not found");
    });
  });
});

describe("task thread", () => {
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

  it("creates thread file during task execution", async () => {
    const { scriptPath } = await createMockClaude(mockDir, {
      orchestratorSteps: ["execute"],
    });

    const result = await runCli(
      ctx,
      testRepoDir,
      ["task", "create", "Test thread creation", "--workflow", "quick"],
      { CM_CLAUDE_COMMAND: scriptPath }
    );

    expect(result.exitCode).toBe(0);

    // Extract task ID
    const match = result.stdout.match(/Task created: ([a-z]+-[a-z]+)/);
    const taskId = match![1];

    // Check thread file exists
    const tasksDir = join(ctx.configDir, "tasks");
    const threadFile = Bun.file(join(tasksDir, taskId, "thread.json"));
    expect(await threadFile.exists()).toBe(true);

    // Verify thread structure
    const thread = JSON.parse(await threadFile.text());
    expect(thread.entries).toBeDefined();
    expect(Array.isArray(thread.entries)).toBe(true);
    expect(thread.entries.length).toBeGreaterThan(0);
    expect(thread.metadata).toBeDefined();
    expect(thread.metadata.totalCharacters).toBeGreaterThan(0);
  });

  it("captures step prompts in thread", async () => {
    const { scriptPath } = await createMockClaude(mockDir, {
      orchestratorSteps: ["plan", "implement"],
    });

    const result = await runCli(
      ctx,
      testRepoDir,
      ["task", "create", "Test prompt capture"],
      { CM_CLAUDE_COMMAND: scriptPath }
    );

    expect(result.exitCode).toBe(0);

    const match = result.stdout.match(/Task created: ([a-z]+-[a-z]+)/);
    const taskId = match![1];

    const tasksDir = join(ctx.configDir, "tasks");
    const thread = JSON.parse(
      await Bun.file(join(tasksDir, taskId, "thread.json")).text()
    );

    // Find step_prompt entries
    const prompts = thread.entries.filter(
      (e: { type: string }) => e.type === "step_prompt"
    );
    expect(prompts.length).toBeGreaterThan(0);

    // First step_prompt should be from plan step
    expect(prompts[0].stepName).toBe("plan");
  });

  it("captures step results in thread", async () => {
    const { scriptPath } = await createMockClaude(mockDir, {
      orchestratorSteps: ["execute"],
    });

    const result = await runCli(
      ctx,
      testRepoDir,
      ["task", "create", "Test result capture", "--workflow", "quick"],
      { CM_CLAUDE_COMMAND: scriptPath }
    );

    expect(result.exitCode).toBe(0);

    const match = result.stdout.match(/Task created: ([a-z]+-[a-z]+)/);
    const taskId = match![1];

    const tasksDir = join(ctx.configDir, "tasks");
    const thread = JSON.parse(
      await Bun.file(join(tasksDir, taskId, "thread.json")).text()
    );

    // Find step_result entries (orchestrator mode captures results this way)
    const results = thread.entries.filter(
      (e: { type: string }) => e.type === "step_result"
    );
    expect(results.length).toBeGreaterThan(0);
  });

  it("shows thread with cm task thread command", async () => {
    const { scriptPath } = await createMockClaude(mockDir, {
      orchestratorSteps: ["execute"],
    });

    const createResult = await runCli(
      ctx,
      testRepoDir,
      ["task", "create", "Test thread view", "--workflow", "quick"],
      { CM_CLAUDE_COMMAND: scriptPath }
    );

    expect(createResult.exitCode).toBe(0);

    const match = createResult.stdout.match(/Task created: ([a-z]+-[a-z]+)/);
    const taskId = match![1];

    // View the thread
    const threadResult = await runCli(ctx, testRepoDir, ["task", "thread", taskId]);
    expect(threadResult.exitCode).toBe(0);
    // Thread shows __init__ for task description and execute for the step
    expect(threadResult.stdout).toContain("Step:");
    expect(threadResult.stdout).toContain("Total entries:");
  });

  it("supports --json flag for thread output", async () => {
    const { scriptPath } = await createMockClaude(mockDir);

    const createResult = await runCli(
      ctx,
      testRepoDir,
      ["task", "create", "Test JSON thread", "--workflow", "quick"],
      { CM_CLAUDE_COMMAND: scriptPath }
    );

    const match = createResult.stdout.match(/Task created: ([a-z]+-[a-z]+)/);
    const taskId = match![1];

    // View thread as JSON
    const threadResult = await runCli(ctx, testRepoDir, [
      "task",
      "thread",
      taskId,
      "--json",
    ]);
    expect(threadResult.exitCode).toBe(0);

    // Should be valid JSON
    const parsed = JSON.parse(threadResult.stdout);
    expect(parsed.entries).toBeDefined();
    expect(parsed.metadata).toBeDefined();
  });

  it("injects thread context into follow-on steps", async () => {
    // Run plan then implement - the implement step should receive context from plan
    const { scriptPath, logPath } = await createMockClaude(mockDir, {
      orchestratorSteps: ["plan", "implement"],
    });

    await runCli(ctx, testRepoDir, ["task", "create", "Test context injection"], {
      CM_CLAUDE_COMMAND: scriptPath,
    });

    // Check the Claude call log
    const log = await readMockLog(logPath);

    // The second step (implement) should receive context from the first step (plan)
    expect(log).toContain("<previous-steps>");
    expect(log).toContain("</previous-steps>");
    expect(log).toContain('<step name="plan"');
  });
});

describe("uncommitted changes check", () => {
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

  it("stop-hook blocks when uncommitted changes exist", async () => {
    const { scriptPath } = await createMockClaude(mockDir);

    // Create task with worktree
    const createResult = await runCli(
      ctx,
      testRepoDir,
      ["task", "create", "Test uncommitted", "--no-start"],
      { CM_CLAUDE_COMMAND: scriptPath }
    );

    const match = createResult.stdout.match(/Task created: ([a-z][a-z0-9-]+)/);
    const taskId = match![1];
    const worktreePath = join(testRepoDir, ".cm-worktrees", taskId);

    // Setup attempt file manually (simulating running step)
    const tasksDir = join(ctx.configDir, "tasks");
    const stepName = "execute";
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

    // Create uncommitted changes in worktree
    await Bun.write(join(worktreePath, "uncommitted.txt"), "uncommitted content");

    // Run stop-hook with CM_WORKTREE_PATH set
    const result = await runCli(ctx, testRepoDir, ["system", "stop-hook"], {
      CM_TASK_ID: taskId,
      CM_STEP_NAME: stepName,
      CM_STEP_ATTEMPT: "1",
      CM_WORKTREE_PATH: worktreePath,
    });

    expect(result.exitCode).toBe(2);
    expect(result.stdout).toContain("uncommitted");
    expect(result.stdout).toContain("uncommitted.txt");
    expect(result.stdout).toContain("Untracked:");
  });

  it("stop-hook allows exit when changes are committed", async () => {
    const { scriptPath } = await createMockClaude(mockDir);

    // Create task with worktree
    const createResult = await runCli(
      ctx,
      testRepoDir,
      ["task", "create", "Test committed", "--no-start"],
      { CM_CLAUDE_COMMAND: scriptPath }
    );

    const match = createResult.stdout.match(/Task created: ([a-z][a-z0-9-]+)/);
    const taskId = match![1];
    const worktreePath = join(testRepoDir, ".cm-worktrees", taskId);

    // Setup attempt file with explicit completion
    const tasksDir = join(ctx.configDir, "tasks");
    const stepName = "execute";
    const attemptDir = join(tasksDir, taskId, "steps", stepName);
    await mkdir(attemptDir, { recursive: true });

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

    // Make and commit a change in the worktree
    await Bun.write(join(worktreePath, "committed.txt"), "committed content");
    await Bun.spawn(["git", "add", "committed.txt"], {
      cwd: worktreePath,
      stdout: "pipe",
      stderr: "pipe",
    }).exited;
    await Bun.spawn(["git", "commit", "-m", "Add committed file"], {
      cwd: worktreePath,
      stdout: "pipe",
      stderr: "pipe",
    }).exited;

    // Run stop-hook
    const result = await runCli(ctx, testRepoDir, ["system", "stop-hook"], {
      CM_TASK_ID: taskId,
      CM_STEP_NAME: stepName,
      CM_STEP_ATTEMPT: "1",
      CM_WORKTREE_PATH: worktreePath,
    });

    expect(result.exitCode).toBe(0);
  });

  it("stop-hook shows all types of uncommitted changes", async () => {
    const { scriptPath } = await createMockClaude(mockDir);

    const createResult = await runCli(
      ctx,
      testRepoDir,
      ["task", "create", "Test all changes", "--no-start"],
      { CM_CLAUDE_COMMAND: scriptPath }
    );

    const match = createResult.stdout.match(/Task created: ([a-z][a-z0-9-]+)/);
    const taskId = match![1];
    const worktreePath = join(testRepoDir, ".cm-worktrees", taskId);

    // Setup attempt file
    const tasksDir = join(ctx.configDir, "tasks");
    const stepName = "execute";
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

    // Create staged file
    await Bun.write(join(worktreePath, "staged.txt"), "staged content");
    await Bun.spawn(["git", "add", "staged.txt"], {
      cwd: worktreePath,
      stdout: "pipe",
      stderr: "pipe",
    }).exited;

    // Create modified (unstaged) file - modify existing README.md
    await Bun.write(join(worktreePath, "README.md"), "# Modified\n");

    // Create untracked file
    await Bun.write(join(worktreePath, "untracked.txt"), "untracked content");

    // Run stop-hook
    const result = await runCli(ctx, testRepoDir, ["system", "stop-hook"], {
      CM_TASK_ID: taskId,
      CM_STEP_NAME: stepName,
      CM_STEP_ATTEMPT: "1",
      CM_WORKTREE_PATH: worktreePath,
    });

    expect(result.exitCode).toBe(2);

    const output = JSON.parse(result.stdout);
    expect(output.reason).toContain("staged.txt");
    expect(output.reason).toContain("README.md");
    expect(output.reason).toContain("untracked.txt");
    expect(output.reason).toContain("Staged:");
    expect(output.reason).toContain("Modified:");
    expect(output.reason).toContain("Untracked:");
  });

  it("passes CM_WORKTREE_PATH to Claude subprocess", async () => {
    // Create custom mock that logs CM_WORKTREE_PATH
    const scriptPath = join(mockDir, "mock-claude-worktree");
    const logPath = join(mockDir, "claude-calls.log");
    const stepCountPath = join(mockDir, "step-count");
    const cmCommand = `bun run "${CLI_ENTRY}"`;

    const script = `#!/bin/bash
echo "CALL: $@" >> "${logPath}"
echo "CM_WORKTREE_PATH: $CM_WORKTREE_PATH" >> "${logPath}"
echo "---" >> "${logPath}"

# Track iteration
if [[ -f "${stepCountPath}" ]]; then
  COUNT=$(cat "${stepCountPath}")
else
  COUNT=0
fi
echo $((COUNT + 1)) > "${stepCountPath}"

if [[ -n "$CM_TASK_ID" && -z "$CM_STEP_NAME" ]]; then
  if [[ $COUNT -eq 0 ]]; then
    ${cmCommand} system orchestrator-decision --step "execute" --reason "Running step"
  else
    ${cmCommand} system orchestrator-decision --complete --summary "Done"
  fi
  exit 0
elif [[ -n "$CM_STEP_NAME" ]]; then
  ${cmCommand} task complete --message "Step done"
  exit 0
fi
`;

    await Bun.write(scriptPath, script);
    await chmod(scriptPath, 0o755);
    await Bun.write(logPath, "");
    await Bun.write(stepCountPath, "0");

    await runCli(
      ctx,
      testRepoDir,
      ["task", "create", "Test env var", "--workflow", "quick"],
      { CM_CLAUDE_COMMAND: scriptPath }
    );

    const log = await readMockLog(logPath);
    expect(log).toContain("CM_WORKTREE_PATH:");
    expect(log).toContain(".cm-worktrees/");
  });

  it("stop-hook skips uncommitted check when CM_WORKTREE_PATH is not set", async () => {
    // Setup attempt file with running status (no explicit completion)
    const tasksDir = join(ctx.configDir, "tasks");
    const taskId = "test-no-worktree-path";
    const stepName = "execute";
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

    // Run stop-hook WITHOUT CM_WORKTREE_PATH
    const result = await runCli(ctx, testRepoDir, ["system", "stop-hook"], {
      CM_TASK_ID: taskId,
      CM_STEP_NAME: stepName,
      CM_STEP_ATTEMPT: "1",
      // Note: CM_WORKTREE_PATH intentionally NOT set
    });

    // Should still block for explicit completion, but NOT for uncommitted changes
    expect(result.exitCode).toBe(2);
    expect(result.stdout).toContain("not marked complete");
    expect(result.stdout).not.toContain("uncommitted");
  });
});

describe("task create with editor input", () => {
  let ctx: TestContext;
  let testRepoDir: string;
  let mockDir: string;

  beforeEach(async () => {
    ctx = await createTestContext();
    testRepoDir = await createTestRepo();
    mockDir = await mkdtemp(join(tmpdir(), "cm-mock-editor-"));
  });

  afterEach(async () => {
    await ctx.cleanup();
    await rm(testRepoDir, { recursive: true, force: true });
    await rm(mockDir, { recursive: true, force: true });
  });

  /**
   * Create a mock editor script that writes content to the file
   */
  async function createMockEditor(
    baseDir: string,
    content: string
  ): Promise<string> {
    const scriptPath = join(baseDir, "mock-editor.sh");

    const script = `#!/bin/bash
# Mock editor that writes specific content to the file
cat > "$1" << 'EDITOR_EOF'
${content}
EDITOR_EOF
`;

    await Bun.write(scriptPath, script);
    await chmod(scriptPath, 0o755);

    return scriptPath;
  }

  it("creates task with description from editor (interactive with mock)", async () => {
    // Create mock editor that writes a description
    const mockEditorPath = await createMockEditor(
      mockDir,
      "This is a task description from the editor.\n\nIt has multiple lines."
    );

    // Create task without description argument, using mock editor
    const result = await runCli(
      ctx,
      testRepoDir,
      ["task", "create", "--no-start"],
      {
        EDITOR: mockEditorPath,
        CM_FORCE_INTERACTIVE: "true",
      }
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Creating task:");
    expect(result.stdout).toContain("This is a task description from the editor.");
    expect(result.stdout).toContain("Task created:");
  });

  it("aborts when editor leaves empty description", async () => {
    // Create mock editor that leaves only comments
    const mockEditorPath = await createMockEditor(
      mockDir,
      "# This is just a comment\n# And another comment"
    );

    const result = await runCli(
      ctx,
      testRepoDir,
      ["task", "create", "--no-start"],
      {
        EDITOR: mockEditorPath,
        CM_FORCE_INTERACTIVE: "true",
      }
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Aborted: empty description");
    // Should NOT create a task
    expect(result.stdout).not.toContain("Task created:");
  });

  it("fails in non-interactive mode without description", async () => {
    // Run without CM_FORCE_INTERACTIVE and without stdin TTY (default for subprocess)
    const result = await runCli(ctx, testRepoDir, ["task", "create", "--no-start"]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Description required");
    expect(result.stderr).toContain("Usage: cm task create");
  });

  it("still works with description argument (backward compatible)", async () => {
    const result = await runCli(ctx, testRepoDir, [
      "task",
      "create",
      "Direct description argument",
      "--no-start",
    ]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Creating task:");
    expect(result.stdout).toContain("Direct description argument");
    expect(result.stdout).toContain("Task created:");
  });

  it("strips comment lines from editor content", async () => {
    // Create mock editor with mixed content and comments
    const mockEditorPath = await createMockEditor(
      mockDir,
      `Actual task description
# This is a comment that should be stripped
More description text
# Another comment
Final line of description`
    );

    const result = await runCli(
      ctx,
      testRepoDir,
      ["task", "create", "--no-start"],
      {
        EDITOR: mockEditorPath,
        CM_FORCE_INTERACTIVE: "true",
      }
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Actual task description");
    // Comments should be stripped (not visible in output)
    expect(result.stdout).not.toContain("This is a comment");
  });

  it("handles editor that fails with non-zero exit code", async () => {
    // Create mock editor that fails
    const failingEditorPath = join(mockDir, "failing-editor.sh");
    await Bun.write(
      failingEditorPath,
      `#!/bin/bash
exit 1
`
    );
    await chmod(failingEditorPath, 0o755);

    const result = await runCli(
      ctx,
      testRepoDir,
      ["task", "create", "--no-start"],
      {
        EDITOR: failingEditorPath,
        CM_FORCE_INTERACTIVE: "true",
      }
    );

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Editor error");
    expect(result.stderr).toContain("exited with code 1");
  });

  it("uses $VISUAL over $EDITOR when both are set", async () => {
    // Create two different mock editors
    const visualEditorPath = await createMockEditor(
      mockDir,
      "Description from VISUAL editor"
    );

    const editorPath = join(mockDir, "wrong-editor.sh");
    await Bun.write(
      editorPath,
      `#!/bin/bash
echo "Wrong editor should not be used" > "$1"
`
    );
    await chmod(editorPath, 0o755);

    const result = await runCli(
      ctx,
      testRepoDir,
      ["task", "create", "--no-start"],
      {
        VISUAL: visualEditorPath,
        EDITOR: editorPath,
        CM_FORCE_INTERACTIVE: "true",
      }
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Description from VISUAL editor");
  });

  it("works with workflow and other options combined", async () => {
    const mockEditorPath = await createMockEditor(
      mockDir,
      "Editor description with workflow option"
    );

    const result = await runCli(
      ctx,
      testRepoDir,
      ["task", "create", "--workflow", "quick", "--no-start"],
      {
        EDITOR: mockEditorPath,
        CM_FORCE_INTERACTIVE: "true",
      }
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Editor description with workflow option");
    expect(result.stdout).toContain("Workflow: quick");
    expect(result.stdout).toContain("Task created:");
  });
});
