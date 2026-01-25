/**
 * Orchestrator-based workflow executor
 *
 * Claude acts as an orchestrator, deciding which step to run next based on
 * the workflow prompt, available steps, and thread history.
 */

import type { Task, StepAttempt, OrchestratorDecision } from "../task/types";
import type { CmConfig, Workflow, WorkflowStep } from "./types";
import { runClaude, parseClaudeOutput, type ClaudeResult } from "./claude-runner";
import {
  updateTask,
  updateStepStatus,
  completeTask,
  failTask,
  pauseTask,
  saveStepLog,
  loadTask,
  saveAttempt,
  loadAttempt,
  loadThread,
  appendThreadEntry,
  saveOrchestratorDecision,
  loadOrchestratorDecision,
  clearOrchestratorDecision,
} from "../task/manager";
import { formatThreadForContext } from "../task/thread-formatter";
import { setupStopHook } from "../task/hooks";
import { StepTimeoutError, ClaudeExecutionError } from "../errors";

/** Result of executing a single step */
export interface StepResult {
  /** Whether the step succeeded */
  success: boolean;
  /** Output from Claude CLI */
  output?: string;
  /** Error message if failed */
  error?: string;
  /** Duration in milliseconds */
  durationMs?: number;
}

/** Result of executing a workflow */
export interface WorkflowResult {
  /** Final task status */
  status: "completed" | "failed" | "paused" | "cancelled";
  /** Error message if failed */
  error?: string;
  /** Number of steps executed */
  stepsCompleted: number;
  /** Total duration in milliseconds */
  durationMs?: number;
}

/** Options for controlling execution output */
export interface ExecutionOptions {
  /** Enable streaming output from Claude */
  stream?: boolean;
  /** Show verbose progress information */
  verbose?: boolean;
  /** Custom output function (defaults to console.log) */
  log?: (message: string) => void;
  /** Custom stream output function (defaults to process.stdout.write) */
  streamOutput?: (chunk: string) => void;
}

/** Default execution options (exported for use in commands) */
export const defaultExecutionOptions: ExecutionOptions = {
  stream: true,
  verbose: true,
  log: console.log,
  streamOutput: (chunk: string) => process.stdout.write(chunk),
};

/**
 * Format duration in human-readable format
 */
function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  const mins = Math.floor(ms / 60000);
  const secs = Math.floor((ms % 60000) / 1000);
  return `${mins}m ${secs}s`;
}

/**
 * Build the orchestrator system prompt
 */
function buildOrchestratorSystemPrompt(workflow: Workflow): string {
  const stepsDescription = workflow.steps
    .map((s) => {
      const parts = [`- **${s.name}**`];
      if (s.prompt) parts.push(`: ${s.prompt}`);
      if (s.agent) parts.push(` (agent: ${s.agent})`);
      return parts.join("");
    })
    .join("\n");

  return `
## Orchestrator Role

You are the orchestrator for this workflow. Your ONLY job is to decide what happens next.

**IMPORTANT: You do NOT execute steps yourself.** You only make decisions by calling \`cm system orchestrator-decision\`. After making your decision, STOP. The system will execute the step and call you again for the next decision.

## What You Do

1. Review the thread history to understand what has been done
2. Decide what should happen next based on the workflow goal
3. Call \`cm system orchestrator-decision\` with your decision
4. STOP - do not attempt to execute steps, run agents, or do any work yourself

## What You Do NOT Do

- Do NOT execute workflow steps yourself
- Do NOT run agents or call Claude
- Do NOT write code or make changes
- Do NOT perform any actions beyond making a decision

## Available Steps

${stepsDescription}

## Decision Commands (REQUIRED)

You MUST call exactly ONE of these commands, then STOP:

**Run a step:**
\`\`\`bash
cm system orchestrator-decision --step "<step-name>" --reason "why this step"
\`\`\`

**Request human input:**
\`\`\`bash
cm system orchestrator-decision --need-input --question "your question"
\`\`\`

**Complete the workflow:**
\`\`\`bash
cm system orchestrator-decision --complete --summary "what was accomplished"
\`\`\`

**Fail the workflow:**
\`\`\`bash
cm system orchestrator-decision --fail --reason "why it cannot proceed"
\`\`\`

## Guidelines

- Review the thread history to understand what has been done
- Choose steps based on the current state and goal
- You can run steps in any order, skip steps, or run them multiple times
- Request input when you need clarification or approval
- Complete the workflow when the goal is achieved
`.trim();
}

/**
 * Build the orchestrator prompt including thread history
 */
async function buildOrchestratorPrompt(
  task: Task,
  workflow: Workflow
): Promise<string> {
  const thread = await loadThread(task.id);
  const threadContext = formatThreadForContext(thread);

  const parts: string[] = [];

  // Thread history (includes task description)
  if (threadContext) {
    parts.push("## Thread History\n");
    parts.push(threadContext);
    parts.push("\n");
  }

  // Orchestrator instructions from workflow
  parts.push("## Orchestrator Instructions\n");
  parts.push(workflow.prompt);
  parts.push("\n");

  // If resuming with user input, include it
  if (task.resumePrompt) {
    parts.push("## User Response\n");
    parts.push(task.resumePrompt);
    parts.push("\n");
  }

  parts.push("---\n");
  parts.push("Based on the above, decide what to do next.");

  return parts.join("\n");
}

/**
 * Build completion instructions for step execution
 */
function buildStepCompletionInstructions(stepName: string): string {
  return `
## Working Directory

Your current working directory is a git worktree created for this task. Treat this directory as your project root. All file operations, searches, and code changes should be relative to this directory. Do NOT navigate to or reference parent directories or other paths outside this worktree.

## Task Completion (REQUIRED)

You are running step "${stepName}". Before finishing, you MUST run one of:

- **Success**: \`cm task complete --message "summary of what was done"\`
- **Failure**: \`cm task fail --reason "what went wrong"\`

You will be blocked from exiting until you run one of these commands.
`.trim();
}

/**
 * Execute a single step (called by orchestrator)
 */
async function executeStep(
  task: Task,
  workflow: Workflow,
  stepName: string,
  config: CmConfig,
  options: ExecutionOptions
): Promise<StepResult> {
  const { stream, verbose, log, streamOutput } = options;
  const startTime = Date.now();

  // Find the step
  const step = workflow.steps.find((s) => s.name === stepName);
  if (!step) {
    return {
      success: false,
      error: `Step "${stepName}" not found in workflow`,
    };
  }

  // Find step index for status updates
  const stepIndex = workflow.steps.findIndex((s) => s.name === stepName);

  // Determine attempt number
  const currentStep = task.steps[stepIndex];
  const attempt = (currentStep?.currentAttempt || 0) + 1;

  // Build the step prompt
  const stepPrompt = step.prompt || task.description;

  // Load thread for context
  const thread = await loadThread(task.id);
  const threadContext = formatThreadForContext(thread);
  const prompt = threadContext
    ? `${threadContext}\n\n${stepPrompt}`
    : stepPrompt;

  // Capture the step prompt entry
  await appendThreadEntry(task.id, {
    type: "step_prompt",
    stepName: step.name,
    attemptNumber: attempt,
    content: stepPrompt,
    metadata: { model: step.model },
  });

  // Log step start
  if (verbose && log) {
    const modelInfo = step.model ? ` [${step.model}]` : "";
    const agentInfo = step.agent ? ` (agent: ${step.agent})` : "";
    log(`\n${"─".repeat(60)}`);
    log(`Executing step: ${step.name}${modelInfo}${agentInfo}`);
    log(`${"─".repeat(60)}\n`);
  }

  // Update task with new attempt number
  await updateStepStatus(task.id, stepIndex, {
    status: "running",
    startedAt: new Date().toISOString(),
    currentAttempt: attempt,
  });

  // Create initial attempt record
  const attemptData: StepAttempt = {
    attemptNumber: attempt,
    status: "running",
    startedAt: new Date().toISOString(),
  };
  await saveAttempt(task.id, step.name, attemptData);

  // Setup Stop hook for step completion
  await setupStopHook(task.worktreePath);

  const timeout = step.timeout || config.defaults?.timeout;

  // Create callback for Q&A capture
  const onQuestionAnswer = async (
    question: string,
    answer: string,
    qStepName: string
  ) => {
    await appendThreadEntry(task.id, {
      type: "user_question",
      stepName: qStepName,
      attemptNumber: attempt,
      content: question,
    });
    await appendThreadEntry(task.id, {
      type: "user_answer",
      stepName: qStepName,
      attemptNumber: attempt,
      content: answer,
    });
  };

  try {
    // Run Claude CLI for the step
    const result: ClaudeResult = await runClaude({
      prompt,
      model: step.model,
      agent: step.agent,
      cwd: task.worktreePath,
      timeout,
      stepName: step.name,
      appendSystemPrompt: buildStepCompletionInstructions(step.name),
      taskId: task.id,
      taskStepName: step.name,
      taskStepAttempt: attempt,
      stream: stream,
      onStream: streamOutput,
      onQuestionAnswer,
    });

    const durationMs = Date.now() - startTime;

    // Parse output
    const parsed = parseClaudeOutput(result.stdout);

    // Save step log
    await saveStepLog(task.id, stepIndex, step.name, {
      prompt,
      model: step.model,
      agent: step.agent,
      result,
      parsed,
      durationMs,
      timestamp: new Date().toISOString(),
    });

    // Reload attempt to check explicit completion status
    let updatedAttempt: StepAttempt;
    try {
      updatedAttempt = await loadAttempt(task.id, step.name, attempt);
    } catch {
      updatedAttempt = attemptData;
    }

    // Check if step was explicitly marked
    if (updatedAttempt.explicitlyFailed) {
      await updateStepStatus(task.id, stepIndex, {
        status: "failed",
        completedAt: new Date().toISOString(),
        error: updatedAttempt.error,
      });

      if (verbose && log) {
        log(`\n${"─".repeat(60)}`);
        log(`Step failed: ${updatedAttempt.error} (${formatDuration(durationMs)})`);
      }

      return {
        success: false,
        error: updatedAttempt.error,
        durationMs,
      };
    }

    if (updatedAttempt.explicitlyCompleted) {
      const responseContent =
        updatedAttempt.completionMessage || parsed.result || "";

      await updateStepStatus(task.id, stepIndex, {
        status: "completed",
        completedAt: new Date().toISOString(),
        output: responseContent,
      });

      if (verbose && log) {
        log(`\n${"─".repeat(60)}`);
        log(`Step completed (${formatDuration(durationMs)})`);
      }

      return {
        success: true,
        output: responseContent,
        durationMs,
      };
    }

    // Fallback to exit code
    if (result.success) {
      const responseContent = parsed.result || "";

      await updateStepStatus(task.id, stepIndex, {
        status: "completed",
        completedAt: new Date().toISOString(),
        output: responseContent,
      });

      if (verbose && log) {
        log(`\n${"─".repeat(60)}`);
        log(`Step completed (${formatDuration(durationMs)})`);
      }

      return {
        success: true,
        output: responseContent,
        durationMs,
      };
    } else {
      const errorMsg = result.stderr || `Exit code ${result.exitCode}`;

      await updateStepStatus(task.id, stepIndex, {
        status: "failed",
        completedAt: new Date().toISOString(),
        error: errorMsg,
      });

      if (verbose && log) {
        log(`\n${"─".repeat(60)}`);
        log(`Step failed: ${errorMsg} (${formatDuration(durationMs)})`);
      }

      return {
        success: false,
        error: errorMsg,
        durationMs,
      };
    }
  } catch (error) {
    const durationMs = Date.now() - startTime;
    const errorMsg =
      error instanceof StepTimeoutError
        ? `Timeout after ${error.timeoutMs}ms`
        : error instanceof ClaudeExecutionError
          ? error.stderr
          : (error as Error).message;

    await updateStepStatus(task.id, stepIndex, {
      status: "failed",
      completedAt: new Date().toISOString(),
      error: errorMsg,
    });

    if (verbose && log) {
      log(`\n${"─".repeat(60)}`);
      log(`Step failed: ${errorMsg} (${formatDuration(durationMs)})`);
    }

    return {
      success: false,
      error: errorMsg,
      durationMs,
    };
  }
}

/**
 * Execute the workflow using Claude as an orchestrator
 */
export async function executeWorkflow(
  task: Task,
  workflow: Workflow,
  config: CmConfig,
  options: ExecutionOptions = {}
): Promise<WorkflowResult> {
  const opts = { ...defaultExecutionOptions, ...options };
  const startTime = Date.now();
  let stepsExecuted = 0;
  let iteration = 0;

  if (opts.verbose && opts.log) {
    opts.log(`\nExecuting workflow: ${task.workflow}`);
    opts.log(`Task: ${task.id}`);
    opts.log(`Description: ${task.description}`);
    opts.log(`Available steps: ${workflow.steps.map((s) => s.name).join(", ")}`);
  }

  // Main orchestrator loop
  while (true) {
    iteration++;

    if (opts.verbose && opts.log) {
      opts.log(`\n${"═".repeat(60)}`);
      opts.log(`Orchestrator iteration ${iteration}`);
      opts.log(`${"═".repeat(60)}\n`);
    }

    // 1. Build orchestrator prompt
    const prompt = await buildOrchestratorPrompt(task, workflow);

    // 2. Setup stop hook and clear previous decision
    await setupStopHook(task.worktreePath);
    await clearOrchestratorDecision(task.id);

    // 3. Run Claude as orchestrator (restricted to only cm commands)
    try {
      await runClaude({
        prompt,
        model: workflow.model || "opus",
        cwd: task.worktreePath,
        timeout: config.defaults?.timeout,
        appendSystemPrompt: buildOrchestratorSystemPrompt(workflow),
        taskId: task.id,
        stream: opts.stream,
        onStream: opts.streamOutput,
        allowedTools: ["Bash(cm *)"],
        isOrchestrator: true,
      });
    } catch (error) {
      const errorMsg =
        error instanceof StepTimeoutError
          ? `Orchestrator timeout after ${error.timeoutMs}ms`
          : error instanceof ClaudeExecutionError
            ? error.stderr
            : (error as Error).message;

      await failTask(task.id, errorMsg);
      return {
        status: "failed",
        error: errorMsg,
        stepsCompleted: stepsExecuted,
        durationMs: Date.now() - startTime,
      };
    }

    // 4. Load the decision
    const decision = await loadOrchestratorDecision(task.id);
    if (!decision) {
      await failTask(task.id, "Orchestrator exited without making a decision");
      return {
        status: "failed",
        error: "Orchestrator exited without making a decision",
        stepsCompleted: stepsExecuted,
        durationMs: Date.now() - startTime,
      };
    }

    // 5. Record decision in thread
    await appendThreadEntry(task.id, {
      type: "orchestrator_decision",
      stepName: "__orchestrator__",
      attemptNumber: iteration,
      content: JSON.stringify(decision),
      metadata: decision,
    });

    // 6. Handle the decision
    switch (decision.type) {
      case "run_step": {
        if (opts.verbose && opts.log) {
          opts.log(`\nOrchestrator decision: run step "${decision.stepName}"`);
          if (decision.reason) {
            opts.log(`Reason: ${decision.reason}`);
          }
        }

        // Execute the step
        const stepResult = await executeStep(
          task,
          workflow,
          decision.stepName,
          config,
          opts
        );

        // Record step result in thread
        await appendThreadEntry(task.id, {
          type: "step_result",
          stepName: decision.stepName,
          attemptNumber: 1,
          content: stepResult.output || stepResult.error || "No output",
          metadata: { success: stepResult.success },
        });

        stepsExecuted++;

        // Clear resume prompt after use
        if (task.resumePrompt) {
          task.resumePrompt = undefined;
          await updateTask(task);
        }

        // Reload task and continue loop
        task = await loadTask(task.id);
        continue;
      }

      case "need_input": {
        if (opts.verbose && opts.log) {
          opts.log(`\nOrchestrator requests input: ${decision.question}`);
        }

        await pauseTask(task.id, decision.question);
        return {
          status: "paused",
          stepsCompleted: stepsExecuted,
          durationMs: Date.now() - startTime,
        };
      }

      case "complete": {
        if (opts.verbose && opts.log) {
          opts.log(`\n${"═".repeat(60)}`);
          opts.log(`Workflow completed: ${decision.summary}`);
          opts.log(`Total time: ${formatDuration(Date.now() - startTime)}`);
          opts.log(`${"═".repeat(60)}`);
        }

        await completeTask(task.id);
        return {
          status: "completed",
          stepsCompleted: stepsExecuted,
          durationMs: Date.now() - startTime,
        };
      }

      case "fail": {
        if (opts.verbose && opts.log) {
          opts.log(`\nWorkflow failed: ${decision.reason}`);
        }

        await failTask(task.id, decision.reason);
        return {
          status: "failed",
          error: decision.reason,
          stepsCompleted: stepsExecuted,
          durationMs: Date.now() - startTime,
        };
      }

      default: {
        const errorMsg = `Unknown decision type: ${(decision as OrchestratorDecision).type}`;
        await failTask(task.id, errorMsg);
        return {
          status: "failed",
          error: errorMsg,
          stepsCompleted: stepsExecuted,
          durationMs: Date.now() - startTime,
        };
      }
    }
  }
}
