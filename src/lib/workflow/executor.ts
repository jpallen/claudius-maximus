/**
 * Workflow step executor
 */

import type { Task } from "../task/types";
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
} from "../task/manager";
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
}

/** Result of executing a workflow */
export interface WorkflowResult {
  /** Final task status */
  status: "completed" | "failed" | "paused" | "cancelled";
  /** Error message if failed */
  error?: string;
  /** Number of steps completed */
  stepsCompleted: number;
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

  // If step has an agent but no prompt, use the task description
  if (step.agent) {
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
  config: CmConfig,
  isResuming: boolean = false
): Promise<StepResult> {
  // Build the prompt
  const prompt = buildStepPrompt(step, task, isResuming);

  // If no prompt can be built, pause for user input
  if (!prompt) {
    return {
      success: true,
      shouldPause: true,
    };
  }

  // Mark step as running
  await updateStepStatus(task.id, stepIndex, {
    status: "running",
    startedAt: new Date().toISOString(),
  });

  // Get allowed tools from config defaults
  const allowedTools = config.defaults?.allowedTools;
  const timeout = step.timeout || config.defaults?.timeout;

  try {
    // Run Claude CLI
    const result: ClaudeResult = await runClaude({
      prompt,
      agent: step.agent,
      allowedTools,
      cwd: task.worktreePath,
      timeout,
      stepName: step.name,
    });

    // Parse output
    const parsed = parseClaudeOutput(result.stdout);

    // Save step log
    await saveStepLog(task.id, stepIndex, step.name, {
      prompt,
      agent: step.agent,
      result,
      parsed,
      timestamp: new Date().toISOString(),
    });

    if (result.success) {
      // Mark step as completed
      await updateStepStatus(task.id, stepIndex, {
        status: "completed",
        completedAt: new Date().toISOString(),
        output: parsed.result,
      });

      return {
        success: true,
        shouldPause: false,
        output: parsed.result,
      };
    } else {
      // Mark step as failed
      const errorMsg = result.stderr || `Exit code ${result.exitCode}`;
      await updateStepStatus(task.id, stepIndex, {
        status: "failed",
        completedAt: new Date().toISOString(),
        error: errorMsg,
      });

      return {
        success: false,
        shouldPause: false,
        error: errorMsg,
      };
    }
  } catch (error) {
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
      agent: step.agent,
      error: errorMsg,
      timestamp: new Date().toISOString(),
    });

    return {
      success: false,
      shouldPause: false,
      error: errorMsg,
    };
  }
}

/**
 * Execute a single step of the workflow (for step-by-step mode)
 */
export async function executeNextStep(
  task: Task,
  workflow: Workflow,
  config: CmConfig
): Promise<StepResult> {
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
  const result = await executeStep(task, step, stepIndex, config, isResuming);

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
  config: CmConfig
): Promise<WorkflowResult> {
  let stepsCompleted = 0;

  while (task.currentStep < workflow.steps.length) {
    const result = await executeNextStep(task, workflow, config);

    if (result.shouldPause) {
      // Pause the task
      await pauseTask(task.id);
      return {
        status: "paused",
        stepsCompleted,
      };
    }

    if (!result.success) {
      // Step failed - fail the task
      await failTask(task.id, result.error || "Step failed");
      return {
        status: "failed",
        error: result.error,
        stepsCompleted,
      };
    }

    stepsCompleted++;

    // Reload task to get updated state
    const { loadTask } = await import("../task/manager");
    task = await loadTask(task.id);
  }

  // All steps completed
  await completeTask(task.id);
  return {
    status: "completed",
    stepsCompleted,
  };
}
