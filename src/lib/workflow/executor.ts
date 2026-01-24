/**
 * Workflow step executor
 */

import type { Task, StepAttempt } from "../task/types";
import type { CmConfig, Workflow, WorkflowStep } from "./types";
import { runClaude, parseClaudeOutput, type ClaudeResult } from "./claude-runner";
import {
  updateTask,
  updateStepStatus,
  advanceStep,
  completeTask,
  failTask,
  pauseTask,
  saveStepLog,
  loadTask,
  saveAttempt,
  loadAttempt,
  loadThread,
  appendThreadEntry,
} from "../task/manager";
import { formatThreadForContext } from "../task/thread-formatter";
import { setupStopHook } from "../task/hooks";
import { StepTimeoutError, ClaudeExecutionError } from "../errors";

/** Result of executing a single step */
export interface StepResult {
  /** Whether the step succeeded */
  success: boolean;
  /** Whether the task should pause (waiting for user input) */
  shouldPause: boolean;
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
  /** Number of steps completed */
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
 * Build completion instructions for the system prompt
 */
function buildCompletionInstructions(stepName: string): string {
  return `
## Task Completion (REQUIRED)

You are running step "${stepName}". Before finishing, you MUST run one of:

- **Success**: \`cm task complete --message "summary of what was done"\`
- **Failure**: \`cm task fail --reason "what went wrong"\`

You will be blocked from exiting until you run one of these commands.
`.trim();
}

/**
 * Build the prompt for a step
 */
function buildStepPrompt(
  step: WorkflowStep,
  task: Task,
  isResuming: boolean
): string | null {
  // If we're resuming and there's a resume prompt, use it
  if (isResuming && task.resumePrompt) {
    return task.resumePrompt;
  }

  // Use step prompt if defined
  if (step.prompt) {
    // Substitute task description into prompt
    return step.prompt.replace(/\{description\}/g, task.description);
  }

  // If step has a model or agent but no prompt, use the task description
  if (step.model || step.agent) {
    return task.description;
  }

  // No agent and no prompt - need user input
  return null;
}

/**
 * Execute a single workflow step
 */
async function executeStep(
  task: Task,
  step: WorkflowStep,
  stepIndex: number,
  totalSteps: number,
  config: CmConfig,
  options: ExecutionOptions,
  isResuming: boolean = false
): Promise<StepResult> {
  const { stream, verbose, log, streamOutput } = options;
  const startTime = Date.now();

  // Determine attempt number early so we can use it for thread entries
  const currentStep = task.steps[stepIndex];
  const attempt = (currentStep.currentAttempt || 0) + 1;

  // Capture resume prompt entry if resuming with a user prompt
  if (isResuming && task.resumePrompt) {
    await appendThreadEntry(task.id, {
      type: "resume_prompt",
      stepName: step.name,
      attemptNumber: attempt,
      content: task.resumePrompt,
    });
  }

  // Build the base prompt
  const basePrompt = buildStepPrompt(step, task, isResuming);

  // If no prompt can be built, pause for user input
  if (!basePrompt) {
    return {
      success: true,
      shouldPause: true,
    };
  }

  // Load thread and build prompt with context
  const thread = await loadThread(task.id);
  const threadContext = formatThreadForContext(thread);
  const prompt = threadContext ? `${threadContext}\n\n${basePrompt}` : basePrompt;

  // Capture the step prompt entry (using basePrompt to avoid duplicating context)
  await appendThreadEntry(task.id, {
    type: "step_prompt",
    stepName: step.name,
    attemptNumber: attempt,
    content: basePrompt,
    metadata: { model: step.model },
  });

  // Log step start
  if (verbose && log) {
    const modelInfo = step.model ? ` [${step.model}]` : "";
    const agentInfo = step.agent ? ` (agent: ${step.agent})` : "";
    const attemptInfo = attempt > 1 ? ` (attempt ${attempt})` : "";
    log(`\n${"─".repeat(60)}`);
    log(`Step ${stepIndex + 1}/${totalSteps}: ${step.name}${modelInfo}${agentInfo}${attemptInfo}`);
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

  // Setup Stop hook in the worktree
  await setupStopHook(task.worktreePath);

  const timeout = step.timeout || config.defaults?.timeout;

  // Create callback for Q&A capture
  const onQuestionAnswer = async (question: string, answer: string, stepName: string) => {
    await appendThreadEntry(task.id, {
      type: "user_question",
      stepName,
      attemptNumber: attempt,
      content: question,
    });
    await appendThreadEntry(task.id, {
      type: "user_answer",
      stepName,
      attemptNumber: attempt,
      content: answer,
    });
  };

  try {
    // Run Claude CLI with task context for completion tracking
    const result: ClaudeResult = await runClaude({
      prompt,
      model: step.model,
      agent: step.agent,
      cwd: task.worktreePath,
      timeout,
      stepName: step.name,
      appendSystemPrompt: buildCompletionInstructions(step.name),
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
      // If attempt file not found, create a basic one
      updatedAttempt = attemptData;
    }

    // Log step completion
    if (verbose && log) {
      log(`\n${"─".repeat(60)}`);
    }

    // Check if step was explicitly marked
    if (updatedAttempt.explicitlyFailed) {
      // Capture failed response in thread
      await appendThreadEntry(task.id, {
        type: "claude_response",
        stepName: step.name,
        attemptNumber: attempt,
        content: updatedAttempt.error || "Step failed",
        metadata: { success: false, explicitlyFailed: true },
      });

      await updateStepStatus(task.id, stepIndex, {
        status: "failed",
        completedAt: new Date().toISOString(),
        error: updatedAttempt.error,
      });

      if (verbose && log) {
        log(`Step failed: ${updatedAttempt.error} (${formatDuration(durationMs)})`);
      }

      return {
        success: false,
        shouldPause: false,
        error: updatedAttempt.error,
        durationMs,
      };
    }

    if (updatedAttempt.explicitlyCompleted) {
      const responseContent = updatedAttempt.completionMessage || parsed.result || "";

      // Capture successful response in thread
      await appendThreadEntry(task.id, {
        type: "claude_response",
        stepName: step.name,
        attemptNumber: attempt,
        content: responseContent,
        metadata: { success: true, explicitlyCompleted: true },
      });

      await updateStepStatus(task.id, stepIndex, {
        status: "completed",
        completedAt: new Date().toISOString(),
        output: responseContent,
      });

      if (verbose && log) {
        log(`Step completed (${formatDuration(durationMs)})`);
      }

      return {
        success: true,
        shouldPause: false,
        output: responseContent,
        durationMs,
      };
    }

    // Fallback to exit code based success/failure (for backwards compatibility)
    if (result.success) {
      const responseContent = parsed.result || "";

      // Capture successful response in thread
      await appendThreadEntry(task.id, {
        type: "claude_response",
        stepName: step.name,
        attemptNumber: attempt,
        content: responseContent,
        metadata: { success: true },
      });

      // Mark step as completed
      await updateStepStatus(task.id, stepIndex, {
        status: "completed",
        completedAt: new Date().toISOString(),
        output: responseContent,
      });

      if (verbose && log) {
        log(`Step completed (${formatDuration(durationMs)})`);
      }

      return {
        success: true,
        shouldPause: false,
        output: responseContent,
        durationMs,
      };
    } else {
      // Mark step as failed
      const errorMsg = result.stderr || `Exit code ${result.exitCode}`;

      // Capture failed response in thread
      await appendThreadEntry(task.id, {
        type: "claude_response",
        stepName: step.name,
        attemptNumber: attempt,
        content: errorMsg,
        metadata: { success: false, exitCode: result.exitCode },
      });

      await updateStepStatus(task.id, stepIndex, {
        status: "failed",
        completedAt: new Date().toISOString(),
        error: errorMsg,
      });

      if (verbose && log) {
        log(`Step failed: ${errorMsg} (${formatDuration(durationMs)})`);
      }

      return {
        success: false,
        shouldPause: false,
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

    // Mark step as failed
    await updateStepStatus(task.id, stepIndex, {
      status: "failed",
      completedAt: new Date().toISOString(),
      error: errorMsg,
    });

    // Save step log
    await saveStepLog(task.id, stepIndex, step.name, {
      prompt,
      model: step.model,
      agent: step.agent,
      error: errorMsg,
      durationMs,
      timestamp: new Date().toISOString(),
    });

    if (verbose && log) {
      log(`\n${"─".repeat(60)}`);
      log(`Step failed: ${errorMsg} (${formatDuration(durationMs)})`);
    }

    return {
      success: false,
      shouldPause: false,
      error: errorMsg,
      durationMs,
    };
  }
}

/**
 * Execute a single step of the workflow (for step-by-step mode)
 */
export async function executeNextStep(
  task: Task,
  workflow: Workflow,
  config: CmConfig,
  options: ExecutionOptions = {}
): Promise<StepResult> {
  const opts = { ...defaultExecutionOptions, ...options };
  const stepIndex = task.currentStep;

  if (stepIndex >= workflow.steps.length) {
    // All steps completed
    return {
      success: true,
      shouldPause: false,
    };
  }

  const step = workflow.steps[stepIndex];
  // Check if we're resuming - indicated by having a resumePrompt
  const isResuming = !!task.resumePrompt;

  // Execute the step (will use resumePrompt if available)
  const result = await executeStep(
    task,
    step,
    stepIndex,
    workflow.steps.length,
    config,
    opts,
    isResuming
  );

  // Clear resume prompt after using it
  if (task.resumePrompt) {
    task.resumePrompt = undefined;
    await updateTask(task);
  }

  if (result.success && !result.shouldPause) {
    // Advance to next step
    await advanceStep(task.id);
  }

  return result;
}

/**
 * Execute all remaining steps in the workflow
 */
export async function executeWorkflow(
  task: Task,
  workflow: Workflow,
  config: CmConfig,
  options: ExecutionOptions = {}
): Promise<WorkflowResult> {
  const opts = { ...defaultExecutionOptions, ...options };
  const startTime = Date.now();
  let stepsCompleted = 0;
  let totalDuration = 0;

  if (opts.verbose && opts.log) {
    opts.log(`\nExecuting workflow: ${task.workflow}`);
    opts.log(`Task: ${task.id}`);
    opts.log(`Description: ${task.description}`);
    opts.log(`Steps: ${workflow.steps.length}`);
  }

  while (task.currentStep < workflow.steps.length) {
    const result = await executeNextStep(task, workflow, config, opts);

    if (result.durationMs) {
      totalDuration += result.durationMs;
    }

    if (result.shouldPause) {
      // Pause the task
      await pauseTask(task.id);
      return {
        status: "paused",
        stepsCompleted,
        durationMs: Date.now() - startTime,
      };
    }

    if (!result.success) {
      // Step failed - fail the task
      await failTask(task.id, result.error || "Step failed");
      return {
        status: "failed",
        error: result.error,
        stepsCompleted,
        durationMs: Date.now() - startTime,
      };
    }

    stepsCompleted++;

    // Reload task to get updated state
    task = await loadTask(task.id);
  }

  const durationMs = Date.now() - startTime;

  // All steps completed
  await completeTask(task.id);

  if (opts.verbose && opts.log) {
    opts.log(`\n${"═".repeat(60)}`);
    opts.log(`Workflow completed successfully`);
    opts.log(`Total time: ${formatDuration(durationMs)}`);
    opts.log(`${"═".repeat(60)}`);
  }

  return {
    status: "completed",
    stepsCompleted,
    durationMs,
  };
}
